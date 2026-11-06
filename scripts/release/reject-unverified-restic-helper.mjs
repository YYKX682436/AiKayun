#!/usr/bin/env node
// Fail closed until the helper's final-image, license and signed-evidence gates
// are integrated into the normal release workflow. This is not an allowlist.
import { readFile } from 'node:fs/promises'

try {
  if (process.argv.length !== 3) throw new Error('Expected one API SBOM')
  const bytes = await readFile(process.argv[2])
  if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) throw new Error('Invalid API SBOM size')
  const sbom = JSON.parse(bytes)
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components) || sbom.components.length === 0) throw new Error('Invalid API SBOM')
  for (const component of sbom.components) {
    if (!component || typeof component !== 'object') throw new Error('Invalid API SBOM component')
    const name = typeof component.name === 'string' ? component.name : ''
    const purl = typeof component.purl === 'string' ? component.purl : ''
    if (name === '/usr/local/bin/restic' || name === '/usr/bin/restic' || name === 'restic' || name.startsWith('github.com/restic/') || purl.startsWith('pkg:golang/github.com/restic/')) throw new Error('Restic helper release evidence gate is not integrated')
  }
} catch {
  process.stderr.write('API SBOM invalid or contains an unverified restic helper; release blocked.\n')
  process.exitCode = 1
}
