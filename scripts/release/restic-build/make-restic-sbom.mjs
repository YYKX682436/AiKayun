#!/usr/bin/env node
// Experimental supplemental scan input; never a replacement for full-image gates.
import { createHash } from 'node:crypto'
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

class Reject extends Error {}
const hashes = {
  arm64: '26c5b4d898ef5ea434d638fcbab616c319761dbd71ffe0d3585b37a9af62a2e1',
  amd64: '2f516a8aebbc0510806a501a88efdca5f199e52f9c6b720f044157a25684d84e',
}
const manifestHash = '1798e78a9b8d8d24bd901c8c9bccdce77bf14d98215f2a708beeb6f320dae63b'
const digest = value => createHash('sha256').update(value).digest('hex')
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
async function jsonFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 16 * 1024 * 1024) throw new Reject('Invalid or oversized input file')
  const bytes = await readFile(path)
  return { bytes, value: JSON.parse(bytes.toString('utf8')) }
}
async function binaryFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 128 * 1024 * 1024) throw new Reject('Invalid binary input')
  return readFile(path)
}
export function purlIdentity(component) {
  const purl = component.purl
  if (typeof purl !== 'string' || !purl.startsWith('pkg:golang/') || purl.includes('?')) throw new Reject('Invalid Go PURL')
  const parts = purl.slice('pkg:golang/'.length).split('#')
  if (parts.length > 2 || (parts.length === 2 && !parts[1])) throw new Reject('Invalid Go PURL')
  const at = parts[0].lastIndexOf('@')
  if (at <= 0 || at === parts[0].length - 1) throw new Reject('Invalid Go PURL')
  const name = decodeURIComponent(parts[0].slice(0, at)) + (parts.length === 2 ? `/${decodeURIComponent(parts[1])}` : '')
  const version = decodeURIComponent(parts[0].slice(at + 1))
  const expected = component.name === 'stdlib' ? component.version.replace(/^go/, '') : component.version
  if (name !== component.name || version !== expected) throw new Reject('Go PURL does not match component')
  return `${component.name}@${component.version}`
}
export function checkEvidence(evidence, arch) {
  if (!hashes[arch] || evidence?.binary_sha256 !== hashes[arch] || evidence.arch !== arch ||
      evidence.go_version !== 'go1.27.3' || evidence.modules !== 80 || !Array.isArray(evidence.licenses) || evidence.licenses.length !== 119) throw new Reject('Invalid binary evidence')
  const entries = []; const modules = new Set()
  for (const x of evidence.licenses) {
    if (!x || !['module', 'version', 'module_h1', 'path', 'sha256', 'content'].every(k => typeof x[k] === 'string') ||
        !x.path || !x.content || digest(x.content) !== x.sha256) throw new Reject('Invalid license evidence')
    entries.push([x.module, x.version, x.module_h1, x.path, x.sha256]); modules.add(`${x.module}@${x.version}`)
  }
  entries.sort((a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1 } return 0 })
  if (digest(JSON.stringify(entries)) !== manifestHash || modules.size !== 81) throw new Reject('License evidence manifest mismatch')
  return modules
}
function componentCounts(components) {
  const out = new Map()
  for (const c of components) { const key = canonical(c); out.set(key, (out.get(key) ?? 0) + 1) }
  return out
}
async function main() {
  const [baselinePath, finalPath, evidencePath, binaryPath, arch, expectedBaseline, expectedFinal, expectedEvidence, outputPath, proofPath] = process.argv.slice(2)
  if (!proofPath) throw new Reject('Usage: make-restic-sbom.mjs BASELINE FINAL EVIDENCE BINARY ARCH EXPECTED_BASELINE_SHA EXPECTED_FINAL_SHA EXPECTED_EVIDENCE_SHA OUTPUT PROOF')
  const [baseline, final, evidence, binary] = await Promise.all([jsonFile(baselinePath), jsonFile(finalPath), jsonFile(evidencePath), binaryFile(binaryPath)])
  if (![expectedBaseline, expectedFinal, expectedEvidence].every(x => /^[a-f0-9]{64}$/.test(x)) ||
      digest(baseline.bytes) !== expectedBaseline || digest(final.bytes) !== expectedFinal || digest(evidence.bytes) !== expectedEvidence) throw new Reject('Trusted input digest mismatch')
  const binaryHash = digest(binary)
  if (!hashes[arch] || binaryHash !== hashes[arch]) throw new Reject('Binary does not match the verified build artifact')
  const modules = checkEvidence(evidence.value, arch)
  for (const sb of [baseline.value, final.value]) {
    if (sb?.bomFormat !== 'CycloneDX' || sb.specVersion !== '1.6' || !Array.isArray(sb.components) || sb.components.length > 100000 ||
        !Array.isArray(sb.dependencies) || typeof sb.metadata?.component?.['bom-ref'] !== 'string') throw new Reject('Invalid full-image SBOM')
  }
  if (baseline.value.components.some(c => typeof c.purl === 'string' && c.purl.startsWith('pkg:golang/'))) throw new Reject('Baseline has Go components outside the restic-only scope')
  const old = componentCounts(baseline.value.components); const next = componentCounts(final.value.components)
  for (const [key, count] of old) if ((next.get(key) ?? 0) < count) throw new Reject('Final SBOM removed or changed a baseline component')
  const additions = []
  const remaining = new Map(old)
  for (const component of final.value.components) {
    const key = canonical(component); const count = remaining.get(key) ?? 0
    if (count > 0) remaining.set(key, count - 1)
    else additions.push(component)
  }
  const go = additions.filter(c => typeof c.purl === 'string' && c.purl.startsWith('pkg:golang/'))
  const files = additions.filter(c => c.type === 'file' && c.name === '/usr/bin/restic')
  if (go.length !== 81 || files.length !== 1 || additions.length !== 82) throw new Reject('Final SBOM has unexpected additions')
  const fileHashes = files[0].hashes
  if (!Array.isArray(fileHashes) || fileHashes.filter(x => x.alg === 'SHA-256').length !== 1 ||
      fileHashes.find(x => x.alg === 'SHA-256').content !== binaryHash || fileHashes.filter(x => x.alg === 'SHA-1').length !== 1 ||
      fileHashes.find(x => x.alg === 'SHA-1').content !== createHash('sha1').update(binary).digest('hex') ||
      fileHashes.some(x => !['SHA-256', 'SHA-1'].includes(x.alg))) throw new Reject('SBOM file hashes differ from binary')
  const seen = new Set()
  for (const c of go) {
    const identity = purlIdentity(c)
    const locations = (c.properties ?? []).filter(p => /^syft:location:\d+:path$/.test(p.name)).map(p => p.value)
    if (seen.has(identity) || !modules.has(identity) || locations.length === 0 || locations.some(x => x !== '/usr/bin/restic')) throw new Reject('Go component is not bound to the verified restic binary')
    seen.add(identity)
  }
  if (seen.size !== modules.size) throw new Reject('Missing verified Go module')
  const selected = [...go, ...files]
  const refs = new Set(selected.map(c => c['bom-ref']))
  if (refs.has(undefined) || refs.size !== selected.length || [...refs].some(x => typeof x !== 'string')) throw new Reject('Invalid selected SBOM references')
  refs.add(final.value.metadata.component['bom-ref'])
  const dependencies = final.value.dependencies.filter(x => refs.has(x.ref)).map(x => {
    if (typeof x.ref !== 'string' || !Array.isArray(x.dependsOn)) throw new Reject('Invalid SBOM dependency')
    return { ...x, dependsOn: x.dependsOn.filter(ref => refs.has(ref)) }
  })
  const metadataProperties = final.value.metadata.properties ?? []
  if (!Array.isArray(metadataProperties) || metadataProperties.some(x => x?.name === 'aikayun:scan-scope')) throw new Reject('Invalid SBOM metadata')
  const sub = { ...final.value, metadata: { ...final.value.metadata, properties: [...metadataProperties,
    { name: 'aikayun:scan-scope', value: 'additional-restic-go-only' }] }, components: selected, dependencies }
  const subsetBytes = `${JSON.stringify(sub)}\n`
  const proof = { scope: 'additional-restic-go-only', arch, baseline_sha256: digest(baseline.bytes), final_sha256: digest(final.bytes),
    evidence_sha256: digest(evidence.bytes), subset_sha256: digest(subsetBytes), restic_binary_sha256: binaryHash, go_components: go.length, added_file_components: files.length }
  await writeFile(outputPath, subsetBytes, { flag: 'wx', mode: 0o600 })
  try { await writeFile(proofPath, `${JSON.stringify(proof)}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) { await unlink(outputPath); throw error }
  process.stdout.write(`${JSON.stringify(proof)}\n`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Restic-only SBOM rejected: ${error instanceof Reject ? error.message : 'invalid input or output'}\n`); process.exitCode = 1 })
}
