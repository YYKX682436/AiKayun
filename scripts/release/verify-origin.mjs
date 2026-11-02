import { isIP } from 'node:net'

const origin = process.argv[2]
if (!origin) throw new Error('Usage: node verify-origin.mjs HTTPS_ORIGIN')
const parsed = new URL(origin)
if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password ||
    isIP(parsed.hostname) || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') ||
    /(^|\.)(test|example|invalid|local)$/i.test(parsed.hostname) || /(^|\.)example\.(com|net|org)$/i.test(parsed.hostname)) {
  throw new Error('Release origin must be a configured public HTTPS origin')
}

const response = await fetch(`${origin}/.well-known/aikayun-release.json`, {
  redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' },
})
if (!response.ok || response.redirected) throw new Error(`Release origin marker returned HTTP ${response.status}`)
const contentType = response.headers.get('content-type') ?? ''
if (!contentType.toLowerCase().includes('application/json')) throw new Error('Release origin marker must be served as JSON')
const marker = await response.json()
const fields = ['schema', 'product', 'release_base_url', 'registry', 'publish_protocol']
if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
    Object.keys(marker).sort().join(',') !== [...fields].sort().join(',') || marker.schema !== 1 ||
    marker.product !== 'aikayun' || marker.release_base_url !== `${origin}/releases/` ||
    marker.registry !== 'ghcr.io/yykx682436' || marker.publish_protocol !== 'http-put-if-none-match-v1') {
  throw new Error('Release origin marker does not match the immutable AiKayun release protocol')
}
process.stdout.write(`${JSON.stringify({ origin, marker: 'verified', protocol: marker.publish_protocol })}\n`)
