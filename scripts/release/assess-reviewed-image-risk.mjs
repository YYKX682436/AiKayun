import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const [path, expectedImage] = process.argv.slice(2)
if (!path || !['api', 'web', 'postgres', 'caddy', 'backup'].includes(expectedImage)) {
  throw new Error('Usage: assess-reviewed-image-risk.mjs SANITIZED_TRIVY_REPORT IMAGE_NAME')
}

// Reviewed for the exact patched PostgreSQL and official Caddy image children and Trivy output.
// A changed image, scanner result, severity, fix version or new CVE blocks release.
const reviews = new Map([
  ['postgres|linux/amd64', ['ghcr.io/yykx682436/aikayun-staging-api@sha256:6f78b06a8c51f2e79b9aa9828d59e6f1a6be53caea3283a2dee4e931c501cc0c', '30111f5c91a39cd9a1de262793ca061328e81c8ced73a242d9e3e2ed29efd6fe', 42]],
  ['postgres|linux/arm64', ['ghcr.io/yykx682436/aikayun-staging-api@sha256:c1e3946fb3a72dcac6e568b52c68d4dcb32df0b4b07671999d608c6a99932064', '606e5b06c50570b7404566ceaed20e95d0587ede5ada684dfa5818ad3c4d0a94', 42]],
  ['caddy|linux/amd64', ['docker.io/library/caddy@sha256:fc9cbc100585871d18d4e451cca7021785c90a7006087427ae5ceb3e4efe6424', '6e60bae104f3702357b5fddec181b0f59ec954447c2f56ad532e9b1ef7ee985f', 2]],
  ['caddy|linux/arm64', ['docker.io/library/caddy@sha256:9ee998103a2bc0d4392bbe9738b4069da1562d6920b3cd8088cfd098a8270120', '591a38cc4f0e3ab95345b7aadd6731bcf42f5ba6b8c12b0353bd0c98ca3a8a42', 2]],
])

const bytes = await readFile(path)
const report = JSON.parse(bytes.toString('utf8'))
const deploymentInputs = [
  [new URL('../../compose.release.yaml', import.meta.url), '385929e8dc5755dfad975d82eee0b84c6103124ed39162d22ba7cf0e44f3e29e'],
  [new URL('../../deploy/Caddyfile', import.meta.url), '17b4493176db9caba4ec90f1fbde2b3a9ee8155da39c624e98fea564e685a8f9'],
  [new URL('../../deploy/postgres-patched.Dockerfile', import.meta.url), '33914ed876cbadaf777c9c70fa79ea1e71d2b855cba213c4b6fa39df4970b492'],
]
for (const [source, expected] of deploymentInputs) {
  if (createHash('sha256').update(await readFile(source)).digest('hex') !== expected) {
    throw new Error('Deployment exposure changed since the image risk review')
  }
}
const image = report.image?.startsWith('ghcr.io/yykx682436/aikayun-staging-api@sha256:') ? 'postgres' : report.image?.includes('/caddy@') ? 'caddy' : ''
const review = reviews.get(`${image}|${report.platform}`)
const digest = createHash('sha256').update(bytes).digest('hex')
if (image !== expectedImage || !review || report.schema_version !== 1 || report.scanner !== 'trivy' || report.gate !== 'blocked' ||
  report.image !== review[0] || digest !== review[1] || report.high_critical_count !== review[2] ||
  report.secret_finding_count !== 0 || report.scanner_errors?.length !== 0) {
  throw new Error('Trivy finding set is not the exact reviewed official-image risk snapshot')
}
process.stdout.write(`${JSON.stringify({ image, platform: report.platform, reviewed_report_sha256: digest, high_critical_count: report.high_critical_count })}\n`)
