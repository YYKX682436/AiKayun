// Construct only verified offline Go license cache entries for the existing NOTICE generator.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { checkEvidence, purlIdentity } from './make-restic-sbom.mjs'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function proxyPath(purl) {
  const locator = purl.slice('pkg:golang/'.length).split(/[?#]/, 1)[0]
  const at = locator.lastIndexOf('@'); if (at < 1) throw new Error('Invalid module PURL')
  const name = decodeURIComponent(locator.slice(0, at)).replace(/!([a-z])/g, (_, c) => c.toUpperCase())
  const version = decodeURIComponent(locator.slice(at + 1))
  if (!/^[A-Za-z0-9._!/+~-]+$/.test(name) || !/^[A-Za-z0-9._+~-]+$/.test(version)) throw new Error('Invalid module PURL')
  const escape = v => encodeURIComponent(v.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`))
  return `${name.split('/').map(escape).join('/')}/@v/${escape(version)}.zip`
}
export async function writeOfflineGoCache(cache, sbom, evidence, arch, binarySha) {
  const modules = checkEvidence(evidence, arch)
  if (evidence.binary_sha256 !== binarySha || sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) throw new Error('Invalid verified Go evidence')
  const go = sbom.components.filter(c => typeof c.purl === 'string' && c.purl.startsWith('pkg:golang/'))
  const files = sbom.components.filter(c => c.type === 'file' && c.name === '/usr/bin/restic')
  if (go.length !== 81 || files.length !== 1 || !Array.isArray(files[0].hashes) ||
      files[0].hashes.filter(x => x.alg === 'SHA-256' && x.content === binarySha).length !== 1) throw new Error('Missing verified Go components')
  const seen = new Set(), groups = new Map()
  for (const component of go) {
    const identity = purlIdentity(component)
    const locations = (component.properties ?? []).filter(p => /^syft:location:\d+:path$/.test(p.name)).map(p => p.value)
    if (!modules.has(identity) || seen.has(identity) || locations.length === 0 || locations.some(x => x !== '/usr/bin/restic')) throw new Error('Go component mismatch')
    seen.add(identity)
    const key = digest(proxyPath(component.purl)); if (!groups.has(key)) groups.set(key, new Map())
    for (const item of evidence.licenses.filter(x => `${x.module}@${x.version}` === identity)) {
      const recordKey = `${item.module}@${item.version}:${item.path}`
      groups.get(key).set(recordKey, `----- BEGIN ${recordKey} SHA256 ${item.sha256} -----\n\n${item.content}\n----- END ${recordKey} -----`)
    }
  }
  if (seen.size !== modules.size) throw new Error('Missing verified Go module')
  for (const [key, items] of groups) {
    if (!items.size) throw new Error('Missing verified Go notice')
    await writeFile(join(cache, `${key}.txt`), [...items.values()].sort().join('\n\n'), { flag:'wx', mode:0o600 })
  }
}
