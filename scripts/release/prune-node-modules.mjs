import { lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const roots = process.argv.slice(2)
if (roots.length === 0) throw new Error('Provide one or more runtime package or node_modules directories')
const visited = new Set()
const packageRootDirectories = new Set([
  'test', 'tests', '__tests__', 'fixtures', 'docs', 'examples', 'coverage', 'bench', 'benchmark', 'benchmarks',
  'performance', 'perf', 'demo', 'demos', '.git', '.github',
])

async function walk(input) {
  let directory
  try { directory = await realpath(input) } catch { return }
  if (visited.has(directory)) return
  visited.add(directory)
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  let packageMetadata
  try { packageMetadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) } catch { /* not a package root */ }
  const isPackageRoot = packageMetadata !== undefined
  const unusedDirectories = new Set(packageRootDirectories)
  if (isPackageRoot) {
    const entryPoints = JSON.stringify({ main: packageMetadata.main, module: packageMetadata.module,
      browser: packageMetadata.browser, exports: packageMetadata.exports, bin: packageMetadata.bin })
    if (!/(^|[./"'])src([/"']|$)/.test(entryPoints)) {
      unusedDirectories.add('src')
      unusedDirectories.add('source')
    }
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (isPackageRoot && unusedDirectories.has(entry.name)) {
      const info = await lstat(path).catch(() => undefined)
      if (info?.isDirectory()) await rm(path, { recursive: true, force: true })
      continue
    }
    if (entry.isFile() && (/\.map$|\.d\.ts$|\.ts$/i.test(entry.name) ||
      /^(readme|changelog|contributing)(\..*)?$/i.test(entry.name) || /^[^.].*\.(test|spec)\.[cm]?js$/i.test(entry.name))) {
      await rm(path, { force: true })
      continue
    }
    const info = await stat(path).catch(() => undefined)
    if (info?.isDirectory()) await walk(path)
  }
}

for (const root of roots) await walk(root)
