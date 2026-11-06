#!/usr/bin/env node
// Experimental restic-only supplement, not a whole-image scan.
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
class Reject extends Error {}
async function load(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 16 * 1024 * 1024) throw new Reject('Invalid scan input')
  const bytes = await readFile(path)
  return { bytes, data: JSON.parse(bytes.toString('utf8')) }
}
async function main() {
  const [subsetPath, proofPath, expectedProof, scanPath] = process.argv.slice(2)
  if (!scanPath || !/^[a-f0-9]{64}$/.test(expectedProof)) throw new Reject('Usage: verify-restic-sbom-scan.mjs SUBSET PROOF EXPECTED_PROOF_SHA SCAN_JSON')
  const [subset, proof, scan] = await Promise.all([load(subsetPath), load(proofPath), load(scanPath)])
  if (createHash('sha256').update(proof.bytes).digest('hex') !== expectedProof) throw new Reject('Trusted proof digest mismatch')
  const allowedTop = new Set(['ArtifactName', 'ArtifactType', 'CreatedAt', 'ReportID', 'Results', 'SchemaVersion', 'Trivy'])
  if (!scan.data || Object.keys(scan.data).some(key => !allowedTop.has(key)) || scan.data.SchemaVersion !== 2 ||
      scan.data.ArtifactName !== '/input/subset.json' || scan.data.ArtifactType !== 'cyclonedx' ||
      scan.data.Trivy?.Version !== '0.69.0' || Object.keys(scan.data.Trivy).some(key => key !== 'Version')) throw new Reject('Unexpected scanner report schema')
  const hash = createHash('sha256').update(subset.bytes).digest('hex')
  if (proof.data?.scope !== 'additional-restic-go-only' || proof.data.subset_sha256 !== hash || proof.data.go_components !== 81 ||
      proof.data.added_file_components !== 1 || !Array.isArray(subset.data.components)) throw new Reject('Subset proof mismatch')
  const scope = (subset.data.metadata?.properties ?? []).filter(x => x?.name === 'aikayun:scan-scope')
  if (scope.length !== 1 || scope[0].value !== 'additional-restic-go-only') throw new Reject('Subset scope is missing or invalid')
  const expected = new Set()
  for (const c of subset.data.components) {
    if (typeof c.purl !== 'string' || !c.purl.startsWith('pkg:golang/')) continue
    const version = c.name === 'stdlib' ? c.version.replace(/^go/, '') : c.version
    const identity = `${c.name}@${version}`
    if (expected.has(identity)) throw new Reject('Duplicate subset package')
    expected.add(identity)
  }
  if (expected.size !== 81 || subset.data.components.length !== 82 || !Array.isArray(scan.data.Results) || scan.data.Results.length !== 1) throw new Reject('Incomplete scanner result')
  const result = scan.data.Results[0]
  const allowedResult = new Set(['Target', 'Class', 'Type', 'Packages', 'Vulnerabilities'])
  if (!result || Object.keys(result).some(key => !allowedResult.has(key)) || result.Target !== '' || result.Class !== 'lang-pkgs' || result.Type !== 'gobinary' || !Array.isArray(result.Packages) || result.Packages.length !== 81 ||
      (result.Vulnerabilities !== undefined && (!Array.isArray(result.Vulnerabilities) || result.Vulnerabilities.length !== 0))) throw new Reject('Scanner failed or found vulnerabilities')
  const actual = new Set()
  for (const p of result.Packages) {
    const allowedPackage = new Set(['DependsOn', 'ID', 'Identifier', 'Licenses', 'Name', 'Version'])
    if (!p || Object.keys(p).some(key => !allowedPackage.has(key)) || typeof p.Name !== 'string' || typeof p.Version !== 'string' ||
        !p.Identifier || Object.keys(p.Identifier).some(key => !['BOMRef', 'PURL', 'UID'].includes(key))) throw new Reject('Invalid scanner package')
    const identity = `${p.Name}@${p.Version}`
    if (actual.has(identity) || !expected.has(identity)) throw new Reject('Scanner package mismatch')
    actual.add(identity)
  }
  if (actual.size !== expected.size) throw new Reject('Scanner missed a package')
  process.stdout.write(JSON.stringify({ scope: 'additional-restic-go-only', scanned_go_packages: actual.size, high_critical: 0 }) + '\n')
}
main().catch(error => { process.stderr.write(`Restic-only scan rejected: ${error instanceof Reject ? error.message : 'invalid input'}\n`); process.exitCode = 1 })
