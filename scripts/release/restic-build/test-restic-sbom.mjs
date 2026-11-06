#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const [baselinePath, finalPath, evidencePath, binaryPath, scanPath, arch] = process.argv.slice(2)
if (!arch) throw new Error('Usage: test-restic-sbom.mjs BASELINE FINAL EVIDENCE BINARY SCAN_JSON ARCH')
const root = dirname(fileURLToPath(import.meta.url))
const work = await mkdtemp(join(tmpdir(), 'aikayun-restic-sbom-test-'))
const file = name => join(work, name)
const read = async path => JSON.parse(await readFile(path, 'utf8'))
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const write = async (name, obj) => { await writeFile(file(name), JSON.stringify(obj), { flag: 'wx', mode: 0o600 }); return file(name) }
const invoke = (script, args, ok, label, message) => {
  const r = spawnSync(process.execPath, [join(root, script), ...args], { timeout: 30000, encoding: 'utf8' })
  if (r.error || (r.status === 0) !== ok || (message && !r.stderr.includes(message))) throw new Error(`Unexpected ${label} result`)
}
try {
  const baseline = await read(baselinePath), final = await read(finalPath), evidence = await read(evidencePath), scan = await read(scanPath)
  const trusted = [await sha(baselinePath), await sha(finalPath), await sha(evidencePath)]
  const make = async (b, f, e, bin, a, label, message, expected) => {
    const hashes = expected ?? [await sha(b), await sha(f), await sha(e)]
    invoke('make-restic-sbom.mjs', [b, f, e, bin, a, ...hashes, file(`${label}.cdx.json`), file(`${label}.proof.json`)], !message, label, message)
  }
  await make(baselinePath, finalPath, evidencePath, binaryPath, arch, 'good')
  const sub = await read(file('good.cdx.json')), proofHash = await sha(file('good.proof.json'))
  if (sub.components.length !== 82 || sub.components.filter(c => (c.purl ?? '').startsWith('pkg:golang/')).length !== 81 ||
      !sub.metadata.properties.some(x => x.name === 'aikayun:scan-scope' && x.value === 'additional-restic-go-only')) throw new Error('Incomplete or unlabelled Go subset')
  const originals = new Set(final.components.map(c => JSON.stringify(c)))
  if (sub.components.some(c => !originals.has(JSON.stringify(c)))) throw new Error('Modified original SBOM component')
  invoke('verify-restic-sbom-scan.mjs', [file('good.cdx.json'), file('good.proof.json'), proofHash, scanPath], true, 'good scan')
  const changedBase = structuredClone(final); changedBase.components.find(c => JSON.stringify(c) === JSON.stringify(baseline.components[0])).name += '-changed'
  await make(baselinePath, await write('changed-baseline.json', changedBase), evidencePath, binaryPath, arch, 'changed-baseline', 'Final SBOM removed or changed')
  const unknown = structuredClone(final); unknown.components.push({ name: 'unknown-extra', type: 'library', 'bom-ref': 'unexpected' })
  await make(baselinePath, await write('extra.json', unknown), evidencePath, binaryPath, arch, 'extra', 'Final SBOM has unexpected additions')
  const missing = structuredClone(final); missing.components = missing.components.filter(c => c.name !== 'github.com/restic/chunker')
  await make(baselinePath, await write('missing.json', missing), evidencePath, binaryPath, arch, 'missing', 'Final SBOM has unexpected additions')
  const wrongPurl = structuredClone(final); wrongPurl.components.find(c => c.name === 'github.com/restic/chunker').purl = 'pkg:golang/github.com/other/module@v0.4.0'
  await make(baselinePath, await write('purl.json', wrongPurl), evidencePath, binaryPath, arch, 'purl', 'Go PURL does not match component')
  const wrongLocation = structuredClone(final); wrongLocation.components.find(c => c.name === 'github.com/restic/chunker').properties.find(p => /^syft:location:\d+:path$/.test(p.name)).value = '/other/binary'
  await make(baselinePath, await write('location.json', wrongLocation), evidencePath, binaryPath, arch, 'location', 'Go component is not bound')
  const badEvidence = structuredClone(evidence); badEvidence.licenses[0].content += 'tampered'
  await make(baselinePath, finalPath, await write('evidence.json', badEvidence), binaryPath, arch, 'evidence', 'Invalid license evidence')
  await make(baselinePath, finalPath, evidencePath, binaryPath, arch === 'arm64' ? 'amd64' : 'arm64', 'wrong-arch', 'Binary does not match')
  const badBaseline = structuredClone(baseline); badBaseline.components.push(final.components.find(c => c.name === 'github.com/restic/chunker'))
  await make(await write('bad-baseline.json', badBaseline), finalPath, evidencePath, binaryPath, arch, 'baseline-go', 'Baseline has Go components')
  const bothOld = structuredClone(baseline), bothNew = structuredClone(final), removed = JSON.stringify(baseline.components[0])
  bothOld.components = bothOld.components.filter(c => JSON.stringify(c) !== removed); bothNew.components = bothNew.components.filter(c => JSON.stringify(c) !== removed)
  await make(await write('both-old.json', bothOld), await write('both-new.json', bothNew), evidencePath, binaryPath, arch, 'both-tampered', 'Trusted input digest mismatch', trusted)
  const badFileHash = structuredClone(final); badFileHash.components.find(c => c.type === 'file' && c.name === '/usr/bin/restic').hashes.find(h => h.alg === 'SHA-256').content = '0'.repeat(64)
  await make(baselinePath, await write('filehash.json', badFileHash), evidencePath, binaryPath, arch, 'filehash', 'SBOM file hashes differ')
  const badBinary = await readFile(binaryPath); badBinary[badBinary.length - 1] ^= 1; await writeFile(file('bad-binary'), badBinary, { flag: 'wx', mode: 0o600 })
  await make(baselinePath, finalPath, evidencePath, file('bad-binary'), arch, 'binary', 'Binary does not match')
  const verify = async (name, obj, message) => invoke('verify-restic-sbom-scan.mjs', [file('good.cdx.json'), file('good.proof.json'), proofHash, await write(`${name}.json`, obj)], false, name, message)
  const absent = structuredClone(scan); delete absent.Results; await verify('absent-result', absent, 'Incomplete scanner result')
  const missed = structuredClone(scan); missed.Results[0].Packages.pop(); await verify('missing-package', missed, 'Scanner failed or found vulnerabilities')
  const injected = structuredClone(scan); injected.Results[0].Vulnerabilities = [{ VulnerabilityID: 'CVE-test', Severity: 'HIGH' }]; await verify('vulnerability', injected, 'Scanner failed or found vulnerabilities')
  const wrong = structuredClone(scan); wrong.Results[0].Packages[0].Name = 'different'; await verify('wrong-package', wrong, 'Scanner package mismatch')
  const scannerError = structuredClone(scan); scannerError.Errors = ['scan-incomplete']; await verify('scanner-error', scannerError, 'Unexpected scanner report schema')
  const resultError = structuredClone(scan); resultError.Results[0].Error = 'scan-incomplete'; await verify('result-error', resultError, 'Scanner failed or found vulnerabilities')
  const packageError = structuredClone(scan); packageError.Results[0].Packages[0].Error = 'scan-incomplete'; await verify('package-error', packageError, 'Invalid scanner package')
  const changedSubset = structuredClone(sub); changedSubset.components.pop()
  const changedPath = await write('changed-subset.json', changedSubset)
  invoke('verify-restic-sbom-scan.mjs', [changedPath, file('good.proof.json'), proofHash, scanPath], false, 'changed subset', 'Subset proof mismatch')
  const forged = await read(file('good.proof.json')); forged.subset_sha256 = await sha(changedPath)
  invoke('verify-restic-sbom-scan.mjs', [changedPath, await write('forged-proof.json', forged), proofHash, scanPath], false, 'forged proof', 'Trusted proof digest mismatch')
  process.stdout.write('Passed: original components preserved; 11 subset and nine scanner rejection cases.\n')
} finally { await rm(work, { recursive: true, force: true }) }
