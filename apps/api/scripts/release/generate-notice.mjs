import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const [modulesArg, outputPath, pnpmStoreArg] = process.argv.slice(2)
if (!modulesArg || !outputPath) throw new Error('Usage: node generate-notice.mjs NODE_MODULES_DIRECTORY OUTPUT_FILE [PNPM_STORE_DIRECTORY]')
const modulesRoot = resolve(modulesArg)
const pnpmStoreRoot = pnpmStoreArg ? resolve(pnpmStoreArg) : undefined
const packages = new Map()
const visitedRoots = new Set()
let pnpmPackageIndex

function packageLicense(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type
  if (Array.isArray(value)) return value.map(packageLicense).filter(Boolean).join(' OR ')
  return 'NOASSERTION'
}

async function collect(root) {
  let realRoot
  try { realRoot = await realpath(root) } catch { return }
  if (visitedRoots.has(realRoot)) return
  visitedRoots.add(realRoot)
  for (const entry of await readdir(realRoot, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(realRoot, entry.name)
    if (entry.name.startsWith('@')) {
      try {
        for (const scoped of await readdir(path)) await collectPackage(join(path, scoped))
      } catch { /* package may disappear only in a concurrent build */ }
    } else if (entry.name !== 'node_modules') {
      await collectPackage(path)
    }
  }
}

async function collectPackage(path) {
  try {
    const realPath = await realpath(path)
    const packageFile = join(realPath, 'package.json')
    const metadata = JSON.parse(await readFile(packageFile, 'utf8'))
    if (typeof metadata.name === 'string' && typeof metadata.version === 'string') {
      const key = `${metadata.name}@${metadata.version}`
      let files = []
      await findLicenseFiles(realPath, files, 2)
      let sourceFiles = files.map(file => ({ path: file, label: file.slice(modulesRoot.length + 1) }))
      if (sourceFiles.length === 0 && pnpmStoreRoot) {
        pnpmPackageIndex ??= await buildPnpmPackageIndex(pnpmStoreRoot)
        const sourceRoot = pnpmPackageIndex.get(key)
        if (sourceRoot) {
          files = []
          await findLicenseFiles(sourceRoot, files, 2)
          sourceFiles = files.map(file => ({ path: file,
            label: `license-source/${metadata.name}@${metadata.version}/${file.slice(sourceRoot.length + 1)}` }))
        }
      }
      if (!packages.has(key)) packages.set(key, {
        name: metadata.name, version: metadata.version, license: packageLicense(metadata.license ?? metadata.licenses),
        files: sourceFiles.sort((a, b) => a.label.localeCompare(b.label)),
      })
    }
    const nested = join(realPath, 'node_modules')
    if ((await stat(nested).catch(() => undefined))?.isDirectory()) await collect(nested)
  } catch { /* scope directories and native binary directories are not packages */ }
}

async function buildPnpmPackageIndex(root) {
  const index = new Map()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageModules = join(root, entry.name, 'node_modules')
    for (const packageEntry of await readdir(packageModules, { withFileTypes: true }).catch(() => [])) {
      const packageEntryPath = join(packageModules, packageEntry.name)
      const packagePaths = packageEntry.name.startsWith('@') && packageEntry.isDirectory()
        ? (await readdir(packageEntryPath, { withFileTypes: true })).filter(child => child.isDirectory())
          .map(child => join(packageEntryPath, child.name))
        : packageEntry.isDirectory() ? [packageEntryPath] : []
      for (const packagePath of packagePaths) {
        try {
          const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'))
          if (typeof metadata.name === 'string' && typeof metadata.version === 'string') {
            index.set(`${metadata.name}@${metadata.version}`, packagePath)
          }
        } catch { /* pnpm stores only package roots below node_modules */ }
      }
    }
  }
  return index
}

async function findLicenseFiles(directory, found, depth) {
  if (depth < 0) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && /^(license|licence|copying|notice|third.party.notices)([._-].*)?$/i.test(entry.name)) found.push(path)
    if (entry.isDirectory() && /^(licenses?|legal)$/i.test(entry.name)) await findLicenseFiles(path, found, depth - 1)
  }
}

await collect(modulesRoot)
const records = [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
const firstParty = records.filter(record => record.name.startsWith('@aikayun/'))
const thirdParty = records.filter(record => !record.name.startsWith('@aikayun/'))
if (thirdParty.length === 0) throw new Error(`No third-party production packages found below ${modulesRoot}`)
const unresolved = thirdParty.filter(record => record.license === 'NOASSERTION' || record.files.length === 0)
const lines = [
  'AiKayun third-party production software notices',
  'Generated from the exact runtime dependency tree. See the signed release manifest and SBOM for image digests and package inventory.',
  '',
  ...firstParty.flatMap(record => [`${record.name}@${record.version}`, 'First-party proprietary AiKayun component; not a third-party dependency.', '']),
  ...thirdParty.flatMap(record => [
    `${record.name}@${record.version}`,
    `Declared license: ${record.license}`,
    ...(record.files.length ? record.files.map(file => `License/NOTICE file: ${file.label}`) : ['License/NOTICE file: NOT FOUND — release review required']),
    ...record.files.flatMap(file => ['', `----- BEGIN ${file.label} -----`, '',
      // Package license texts are reproduced verbatim as attribution materials.
      requireText(file.path), `----- END ${file.label} -----`]),
    '',
  ]),
]

function requireText(path) {
  // Filled from the file list below before output; this placeholder is replaced asynchronously.
  return `__LICENSE_TEXT__${path}__`
}

let notice = lines.join('\n')
for (const record of thirdParty) {
  for (const file of record.files) {
    const text = (await readFile(file.path, 'utf8')).replace(/\s+$/u, '')
    notice = notice.replaceAll(`__LICENSE_TEXT__${file.path}__`, text)
  }
}
await writeFile(outputPath, notice, { flag: 'wx', mode: 0o644 })
process.stdout.write(JSON.stringify({ third_party_packages: thirdParty.length, first_party_packages: firstParty.length,
  unresolved: unresolved.map(({ name, version, license, files }) => ({ name, version, license, files: files.length })) }) + '\n')
if (unresolved.length) process.exitCode = 2
