import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const [directoryArg, version] = process.argv.slice(2)
const origin = process.env.AIKAYUN_RELEASE_ORIGIN
const token = process.env.GH_TOKEN
const repository = process.env.GITHUB_REPOSITORY
if (!directoryArg || !version || !origin || !token || repository !== 'YYKX682436/AiKayun') {
  throw new Error('A release directory, version, HTTPS origin and repository-scoped GitHub token are required')
}
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  throw new Error('Release version must be OCI-compatible SemVer')
}
if (origin !== 'https://releases.aiove.top') throw new Error('Unexpected release origin')

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
files.sort((left, right) => left.localeCompare(right))
for (const required of ['release-index.json', 'release-manifest.json', 'release-manifest.jws']) {
  if (!files.some(path => relative(root, path) === required)) throw new Error(`Release package lacks ${required}`)
}

const apiBase = `https://api.github.com/repos/${repository}`
async function api(path, method = 'GET', body, accepted = [200]) {
  const response = await fetch(`${apiBase}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!accepted.includes(response.status)) throw new Error(`GitHub Pages publication ${method} ${path} failed: HTTP ${response.status}`)
  return response.status === 404 ? null : response.json()
}

const branch = await api('/git/ref/heads/gh-pages')
const head = branch.object?.sha
if (!/^[0-9a-f]{40}$/.test(head ?? '')) throw new Error('Publishing branch has no valid commit')
const existing = await api(`/contents/releases/${encodeURIComponent(version)}?ref=gh-pages`, 'GET', undefined, [200, 404])
if (existing !== null) throw new Error(`Release version ${version} already has files in the publishing branch`)
const parent = await api(`/git/commits/${head}`)
const baseTree = parent.tree?.sha
if (!/^[0-9a-f]{40}$/.test(baseTree ?? '')) throw new Error('Publishing branch has no valid tree')

const entries = []
const expected = []
for (const path of files) {
  const key = relative(root, path)
  if (key === '..' || key.startsWith(`..${sep}`) || key.split(sep).some(part => part === '..')) {
    throw new Error('Release path escaped its package directory')
  }
  const bytes = await readFile(path)
  const blob = await api('/git/blobs', 'POST', { content: bytes.toString('base64'), encoding: 'base64' }, [201])
  if (!/^[0-9a-f]{40}$/.test(blob.sha ?? '')) throw new Error(`GitHub did not return a blob ID for ${key}`)
  entries.push({ path: `releases/${version}/${key.split(sep).join('/')}`, mode: '100644', type: 'blob', sha: blob.sha })
  expected.push({ key, digest: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
}
const tree = await api('/git/trees', 'POST', { base_tree: baseTree, tree: entries }, [201])
const commit = await api('/git/commits', 'POST', {
  message: `Publish signed AiKayun ${version}`,
  tree: tree.sha,
  parents: [head],
}, [201])
const published = await api('/git/refs/heads/gh-pages', 'PATCH', { sha: commit.sha, force: false })
if (published.object?.sha !== commit.sha) throw new Error('Publishing branch did not move to the new release commit')

await api('/pages/builds', 'POST', {}, [201])
let built = false
for (let attempt = 0; attempt < 120; attempt++) {
  const build = await api('/pages/builds/latest')
  if (build.commit === commit.sha && build.status === 'built') { built = true; break }
  if (build.commit === commit.sha && build.status === 'errored') throw new Error('GitHub Pages build failed')
  await new Promise(resolve => setTimeout(resolve, 5000))
}
if (!built) throw new Error('Timed out waiting for the GitHub Pages release build')

for (const { key, digest, size } of expected) {
  const relativeKey = key.split(sep).map(encodeURIComponent).join('/')
  const response = await fetch(`${origin}/releases/${version}/${relativeKey}`, {
    redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { accept: '*/*' },
  })
  if (!response.ok) throw new Error(`Anonymous HTTPS read-back failed for ${key}: HTTP ${response.status}`)
  const received = Buffer.from(await response.arrayBuffer())
  if (received.length !== size || createHash('sha256').update(received).digest('hex') !== digest) {
    throw new Error(`Anonymous HTTPS read-back digest mismatch for ${key}`)
  }
}
process.stdout.write(`${JSON.stringify({ version, published_files: files.length, pages_commit: commit.sha, anonymous_readback: 'verified' })}\n`)
