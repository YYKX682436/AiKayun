import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const path = process.argv[2]
if (!path) throw new Error('Usage: assess-reviewed-image-risk.mjs SANITIZED_TRIVY_REPORT')

// Reviewed on 2026-11-11 for the exact official image children and Trivy output.
// A changed image, scanner result, severity, fix version or new CVE blocks release.
const reviews = new Map([
  ['postgres|linux/amd64', ['docker.io/library/postgres@sha256:300ebd02c6d4de9ee27ad7f6855d5d21b4d3a4a5117767c1197d284c635d9736', '3fbed140d636036906a685dc3a62532f7947e231b3c095b59cadc4a009077ed2', 44]],
  ['postgres|linux/arm64', ['docker.io/library/postgres@sha256:c935aff069a7bbe5c286411a08e9678850d79be7848b190a0e4637b266478626', 'c5fdc521ad4b927f2af860bf96f78de95f1a06f2c0df4baa963b5ea8189e88ce', 44]],
  ['caddy|linux/amd64', ['docker.io/library/caddy@sha256:fc9cbc100585871d18d4e451cca7021785c90a7006087427ae5ceb3e4efe6424', '6e60bae104f3702357b5fddec181b0f59ec954447c2f56ad532e9b1ef7ee985f', 2]],
  ['caddy|linux/arm64', ['docker.io/library/caddy@sha256:9ee998103a2bc0d4392bbe9738b4069da1562d6920b3cd8088cfd098a8270120', '591a38cc4f0e3ab95345b7aadd6731bcf42f5ba6b8c12b0353bd0c98ca3a8a42', 2]],
])

const bytes = await readFile(path)
const report = JSON.parse(bytes.toString('utf8'))
const deploymentInputs = [
  [new URL('../../compose.release.yaml', import.meta.url), '385929e8dc5755dfad975d82eee0b84c6103124ed39162d22ba7cf0e44f3e29e'],
  [new URL('../../deploy/Caddyfile', import.meta.url), '17b4493176db9caba4ec90f1fbde2b3a9ee8155da39c624e98fea564e685a8f9'],
]
for (const [source, expected] of deploymentInputs) {
  if (createHash('sha256').update(await readFile(source)).digest('hex') !== expected) {
    throw new Error('Deployment exposure changed since the image risk review')
  }
}
const image = report.image?.includes('/postgres@') ? 'postgres' : report.image?.includes('/caddy@') ? 'caddy' : ''
const review = reviews.get(`${image}|${report.platform}`)
const digest = createHash('sha256').update(bytes).digest('hex')
if (!review || report.schema_version !== 1 || report.scanner !== 'trivy' || report.gate !== 'blocked' ||
  report.image !== review[0] || digest !== review[1] || report.high_critical_count !== review[2] ||
  report.secret_finding_count !== 0 || report.scanner_errors?.length !== 0) {
  throw new Error('Trivy finding set is not the exact reviewed official-image risk snapshot')
}
process.stdout.write(`${JSON.stringify({ image, platform: report.platform, reviewed_report_sha256: digest, high_critical_count: report.high_critical_count })}\n`)
