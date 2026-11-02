import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const [directoryArg, version] = process.argv.slice(2)
const origin = process.env.AIKAYUN_RELEASE_ORIGIN
const publishUrl = process.env.AIKAYUN_RELEASE_PUBLISH_URL
const token = process.env.AIKAYUN_RELEASE_PUBLISH_TOKEN
if (!directoryArg || !version || !origin || !publishUrl || !token) {
  throw new Error('Usage: AIKAYUN_RELEASE_ORIGIN, AIKAYUN_RELEASE_PUBLISH_URL and AIKAYUN_RELEASE_PUBLISH_TOKEN are required')
}
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  throw new Error('Release version must be OCI-compatible SemVer')
}
const publicOrigin = new URL(origin)
const uploadOrigin = new URL(publishUrl)
if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== origin || uploadOrigin.protocol !== 'https:' ||
    uploadOrigin.username || uploadOrigin.password || uploadOrigin.search || uploadOrigin.hash) {
  throw new Error('Release and upload endpoints must use HTTPS without credentials or query strings')
}
const root = await realpath(resolve(directoryArg))
const files = []

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`Release publication refuses symbolic links: ${relative(root, path)}`)
    if (entry.isDirectory()) await walk(path)
    else if (info.isFile()) files.push(path)
    else throw new Error(`Release publication accepts only ordinary files: ${relative(root, path)}`)
  }
}
await walk(root)
files.sort((left, right) => {
  const leftIndex = left.endsWith('/release-index.json')
  const rightIndex = right.endsWith('/release-index.json')
  return leftIndex === rightIndex ? left.localeCompare(right) : leftIndex ? 1 : -1
})
if (!files.some(path => path.endsWith('/release-index.json')) || !files.some(path => path.endsWith('/release-manifest.json')) ||
    !files.some(path => path.endsWith('/release-manifest.jws'))) {
  throw new Error('The release package must include its index, manifest and detached JWS before publication')
}

const apiBase = new URL(`releases/${version}/`, publishUrl.endsWith('/') ? publishUrl : `${publishUrl}/`)
const downloadBase = `${origin}/releases/${version}/`
for (const path of files) {
  const key = relative(root, path)
  if (key.startsWith(`..${sep}`) || key === '..') throw new Error('Release path escaped its package directory')
  const relativeKey = key.split(sep).map(encodeURIComponent).join('/')
  const target = new URL(relativeKey, apiBase)
  if (target.origin !== uploadOrigin.origin || !target.pathname.startsWith(uploadOrigin.pathname.endsWith('/') ? uploadOrigin.pathname : `${uploadOrigin.pathname}/`)) {
    throw new Error('Release upload path escaped its configured HTTPS endpoint')
  }
  const bytes = await readFile(path)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const upload = await fetch(target, {
    method: 'PUT',
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'if-none-match': '*',
      'x-content-sha256': digest,
    },
    body: bytes,
  })
  if (!upload.ok) throw new Error(`Create-only upload failed for ${key}: HTTP ${upload.status}`)

  const downloaded = await fetch(new URL(relativeKey, downloadBase), {
    redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { accept: '*/*' },
  })
  if (!downloaded.ok) throw new Error(`Anonymous HTTPS read-back failed for ${key}: HTTP ${downloaded.status}`)
  const received = Buffer.from(await downloaded.arrayBuffer())
  if (received.length !== bytes.length || createHash('sha256').update(received).digest('hex') !== digest) {
    throw new Error(`Anonymous HTTPS read-back digest mismatch for ${key}`)
  }
}
process.stdout.write(`${JSON.stringify({ version, uploaded_files: files.length, anonymous_readback: 'verified' })}\n`)
