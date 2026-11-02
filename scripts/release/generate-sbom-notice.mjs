import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const [sbomPath, outputPath, imageReference, systemRootArg] = process.argv.slice(2)
if (!sbomPath || !outputPath || !imageReference || !systemRootArg) {
  throw new Error('Usage: node generate-sbom-notice.mjs SBOM OUTPUT IMAGE_REFERENCE EXTRACTED_LICENSE_ROOT')
}
const sbom = JSON.parse(await readFile(sbomPath, 'utf8'))
if (!Array.isArray(sbom.components) || sbom.components.length === 0) throw new Error('SBOM has no runtime components')
const systemRoot = resolve(systemRootArg)
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const postgresqlNoticePath = join(scriptDirectory, 'upstream-notices', 'postgresql-18.6-COPYRIGHT')
const postgresqlNoticeCommit = '724edf9bde9d356724ad384a2e196edc3c9f80f7'
const postgresqlNoticeSha256 = '3d6af92ff8a4c2cdf69afb1cf44edea727922f5cd0cf8b5f72b11cdecac8fdfd'
const gosuNoticePath = join(scriptDirectory, 'upstream-notices', 'gosu-1.19-LICENSE')
const gosuNoticeCommit = '6456aaa0f3c854d199d0f037f068eb97515b7513'
const gosuNoticeSha256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
const pinnedGoLicenseAssets = new Map([
  ['caddy@v0.0.0-20261003050618-72dd0fb067f6', {
    path: join(scriptDirectory, 'upstream-notices', 'caddy-v2.11.7-LICENSE'),
    source: 'https://github.com/caddyserver/caddy', commit: '72dd0fb067f6d7826c7f79907670ba4a713bfe37',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    description: 'MIT; exact Caddy v2.11.7 LICENSE is embedded below.',
  }],
  ['github.com/caddyserver/caddy/v2@v2.11.7', {
    path: join(scriptDirectory, 'upstream-notices', 'caddy-v2.11.7-LICENSE'),
    source: 'https://github.com/caddyserver/caddy', commit: '72dd0fb067f6d7826c7f79907670ba4a713bfe37',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    description: 'MIT; exact Caddy v2.11.7 LICENSE is embedded below.',
  }],
  ['github.com/cloudflare/circl@v1.6.5', {
    path: join(scriptDirectory, 'upstream-notices', 'cloudflare-circl-v1.6.5-LICENSE'),
    source: 'https://github.com/cloudflare/circl', commit: 'cfa7c70defd831ffb0792ab2af560bfef43d60ca',
    sha256: 'b0da1764fe4d13d610b695536fc3f2ebc362482d053a1cd258e36975bc6b97a7',
    description: 'BSD-3-Clause; exact upstream LICENSE is embedded below.',
  }],
  ['github.com/klauspost/compress@v1.20.1', {
    path: join(scriptDirectory, 'upstream-notices', 'klauspost-compress-v1.20.1-LICENSE'),
    source: 'https://github.com/klauspost/compress', commit: '5d880f230c38a0fc806b9ca1613103a44feff0ac',
    sha256: '0d9e582ee4bff57bf1189c9e514e6da7ce277f9cd3bc2d488b22fbb39a6d87cf',
    description: 'BSD-3-Clause; exact upstream LICENSE is embedded below.',
  }],
  ['google.golang.org/api@v0.298.0', {
    path: join(scriptDirectory, 'upstream-notices', 'google-api-v0.298.0-LICENSE'),
    source: 'https://github.com/googleapis/google-api-go-client', commit: '6dcd60047ebda7f68b4cc0ab9bffa8c73b887096',
    sha256: '110244b02140866ee37d17fa7449436a377ec3b85a481fbb208f4c87964382de',
    description: 'Full upstream LICENSE, including component-specific terms, is embedded below.',
  }],
])
const spdxLicenseListCommit = '31ba1a50e5397e00a304dbadc76531740e89ee48'
const spdxLicenseTextsPath = join(scriptDirectory, 'upstream-notices', 'spdx-3.29.0-license-texts.json')
const spdxLicenseTextsSha256 = '9cacde865cc0ecdf4f0e40b0523ce5339d1cc9adf450dab099f2c5d722a84b73'
const persistentLicenseCacheDirectory = process.env.AIKAYUN_GO_LICENSE_CACHE_DIR
  ? resolve(process.env.AIKAYUN_GO_LICENSE_CACHE_DIR) : undefined
const temporaryLicenseCacheDirectory = persistentLicenseCacheDirectory
  ? undefined : await mkdtemp(join(tmpdir(), 'aikayun-go-license-cache-'))
const licenseCacheDirectory = persistentLicenseCacheDirectory ?? temporaryLicenseCacheDirectory
await mkdir(licenseCacheDirectory, { recursive: true, mode: 0o700 })

function licenseExpression(component) {
  const expressions = (component.licenses ?? []).map(entry => {
    if (typeof entry?.expression === 'string' && entry.expression.trim()) return entry.expression.trim()
    const license = entry?.license
    if (typeof license?.id === 'string' && license.id.trim()) return license.id.trim()
    if (typeof license?.name === 'string' && license.name.trim()) return `LicenseRef:${license.name.trim()}`
    return undefined
  }).filter(Boolean)
  return [...new Set(expressions)].sort().join('; ') || 'NOASSERTION'
}

function parseApkDatabase(contents) {
  return contents.trim().split(/\n\s*\n/).map(record => {
    const fields = Object.fromEntries(record.split(/\r?\n/).filter(line => /^[A-Z]:/.test(line))
      .map(line => [line[0], line.slice(2)]))
    return { name: fields.P, version: fields.V, license: fields.L }
  }).filter(record => record.name)
}

function normalizedApkVersion(version) {
  return version.replace(/-r\d+$/, '')
}

async function readApkDatabase() {
  try {
    return parseApkDatabase(await readFile(join(systemRoot, 'lib', 'apk', 'db', 'installed'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function readSpdxLicenseTexts() {
  const contents = await readFile(spdxLicenseTextsPath)
  if (createHash('sha256').update(contents).digest('hex') !== spdxLicenseTextsSha256) {
    throw new Error('The vendored SPDX license texts failed SHA-256 verification')
  }
  const parsed = JSON.parse(contents.toString('utf8'))
  if (parsed.license_list_version !== '3.29.0' || parsed.source_commit !== spdxLicenseListCommit ||
    !parsed.licenses || typeof parsed.licenses !== 'object' || Array.isArray(parsed.licenses)) {
    throw new Error('The vendored SPDX license texts do not match their recorded upstream source')
  }
  for (const [identifier, license] of Object.entries(parsed.licenses)) {
    if (typeof license.text !== 'string' ||
      createHash('sha256').update(license.text).digest('hex') !== license.sha256) {
      throw new Error(`The vendored SPDX ${identifier} license text failed SHA-256 verification`)
    }
  }
  return new Map(Object.entries(parsed.licenses).map(([identifier, license]) => [identifier, license.text]))
}

function alpineLicenseIdentifiers(apkPackages) {
  const identifiers = new Set()
  for (const expression of apkPackages.map(record => record.license).filter(Boolean)) {
    for (const identifier of expression.split(/\s+(?:AND|OR)\s+/).map(part => part.trim().replace(/^[\s(]+|[\s)]+$/g, ''))) {
      if (identifier) identifiers.add(identifier)
    }
  }
  return [...identifiers].sort()
}

function apkLicense(component, apkPackages) {
  if (component.type === 'operating-system' && component.name.toLowerCase() === 'alpine') {
    return 'Alpine Linux distribution metadata; component licenses are attributed to installed APK packages below.'
  }
  if (component.type === 'operating-system' && component.name.toLowerCase() === 'debian') {
    return 'Debian distribution metadata; per-package copyright and license files from the image are embedded below.'
  }
  if (component.name === '.postgresql-rundeps') {
    return 'Alpine virtual dependency metapackage with no independent payload; see installed APK package licenses.'
  }
  const names = component.name === 'postgresql'
    ? apkPackages.filter(record => /^postgresql\d+$/.test(record.name)).map(record => record.name)
    : [component.name]
  const matches = apkPackages.filter(record => names.includes(record.name) && record.license &&
    normalizedApkVersion(component.version) === normalizedApkVersion(record.version))
  if (matches.length === 1) {
    const match = matches[0]
    return `Declared in the image APK database for ${match.name}@${match.version}: ${match.license}`
  }
  return undefined
}

function goProxyPathFromPurl(purl) {
  if (!purl.startsWith('pkg:golang/')) return undefined
  const locator = purl.slice('pkg:golang/'.length).split(/[?#]/, 1)[0]
  const separator = locator.lastIndexOf('@')
  if (separator < 1) return undefined
  const modulePath = decodeURIComponent(locator.slice(0, separator)).replace(/!([a-z])/g, (_, letter) => letter.toUpperCase())
  const version = decodeURIComponent(locator.slice(separator + 1))
  if (!/^[A-Za-z0-9._!/+~-]+$/.test(modulePath) || !/^[A-Za-z0-9._+~-]+$/.test(version)) return undefined
  const escapeGoPath = value => encodeURIComponent(value.replace(/[A-Z]/g, letter => `!${letter.toLowerCase()}`))
  return `${modulePath.split('/').map(escapeGoPath).join('/')}/@v/${escapeGoPath(version)}.zip`
}

const moduleLicenseCache = new Map()
async function goModuleLicenseAtPurl(purl) {
  const proxyPath = goProxyPathFromPurl(purl)
  if (!proxyPath) return undefined
  if (moduleLicenseCache.has(proxyPath)) return moduleLicenseCache.get(proxyPath)
  const result = (async () => {
    const cacheKey = createHash('sha256').update(proxyPath).digest('hex')
    const cachedNoticePath = join(licenseCacheDirectory, `${cacheKey}.txt`)
    try {
      return await readFile(cachedNoticePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'aikayun-module-license-'))
    const archive = join(temporaryRoot, 'module.zip')
    try {
      await execFile('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https',
        '--tlsv1.2', '--max-time', '30', '--max-filesize', '33554432', '--output', archive,
        `https://proxy.golang.org/${proxyPath}`], { timeout: 35_000, maxBuffer: 1024 * 1024 })
      const listing = await execFile('unzip', ['-Z1', archive], { timeout: 10_000, maxBuffer: 1024 * 1024 })
      const licensePaths = listing.stdout.split(/\r?\n/).filter(path => {
        if (!path || path.endsWith('/') || path.split('/').some(part => part === '..')) return false
        const name = path.split('/').at(-1)
        return /^(license|licence|copying|notice|copyright)([._-].*)?$/i.test(name)
      }).sort()
      if (!licensePaths.length) return undefined
      const records = []
      for (const path of licensePaths) {
        const text = (await execFile('unzip', ['-p', archive, path], {
          timeout: 10_000, maxBuffer: 1024 * 1024,
        })).stdout.trim()
        if (text) records.push(`----- BEGIN ${purl} ${path} -----\n\n${text}\n----- END ${path} -----`)
      }
      if (!records.length) return undefined
      const notice = records.join('\n\n')
      await writeFile(cachedNoticePath, notice, { flag: 'wx', mode: 0o600 }).catch(async error => {
        if (error.code !== 'EEXIST') throw error
      })
      return notice
    } catch {
      return undefined
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })()
  moduleLicenseCache.set(proxyPath, result)
  return result
}

async function goModuleLicense(purl, componentName, componentVersion) {
  const candidates = [purl]
  if (/^[A-Za-z0-9._!/+~-]+$/.test(componentName) && /^[A-Za-z0-9._+~-]+$/.test(componentVersion)) {
    candidates.push(`pkg:golang/${componentName}@${componentVersion}`)
  }
  for (const candidate of new Set(candidates)) {
    const notice = await goModuleLicenseAtPurl(candidate)
    if (notice) return notice
  }
  return undefined
}

function mapWithConcurrency(items, concurrency, callback) {
  const results = Array(items.length)
  let next = 0
  return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await callback(items[index])
    }
  })).then(() => results)
}

const components = sbom.components
  .filter(component => component.type !== 'file')
  .map(component => ({
    name: component.name,
    version: component.version ?? 'unknown',
    type: component.type,
    purl: component.purl ?? 'not provided',
    license: licenseExpression(component),
  }))
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
if (components.length === 0) throw new Error('SBOM has no software packages to attribute')
const firstParty = components.filter(component => component.name.startsWith('@aikayun/') ||
  component.name === 'aikayun-api' || component.name === 'aikayun-web')
const thirdParty = components.filter(component => !firstParty.includes(component))

async function collectNoticeFiles(input, found = []) {
  let entries
  try { entries = await readdir(input, { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    const path = join(input, entry.name)
    if (entry.isDirectory()) await collectNoticeFiles(path, found)
    else if (entry.isFile() && /^(copyright|license|licence|copying|notice)([._-].*)?$/i.test(entry.name)) found.push(path)
  }
  return found
}

const noticeFiles = (await Promise.all(['doc', 'licenses', 'common-licenses', 'nodejs'].map(path =>
  collectNoticeFiles(join(systemRoot, path))))).flat().sort((a, b) => a.localeCompare(b))
const noticeFileByPackage = new Map()
for (const path of noticeFiles) {
  const parts = relative(join(systemRoot, 'doc'), path).split(sep)
  if (parts.length >= 2 && parts[0] !== '..' && parts.at(-1)?.toLowerCase().startsWith('copyright')) {
    noticeFileByPackage.set(parts[0], path)
  }
}
const apkPackages = await readApkDatabase()
const apkIdentifiers = alpineLicenseIdentifiers(apkPackages)
const spdxLicenseTexts = apkPackages.length ? await readSpdxLicenseTexts() : new Map()
const unresolvedApkLicenseIds = apkIdentifiers.filter(identifier =>
  !spdxLicenseTexts.has(identifier) && !/^public[ -]domain$/i.test(identifier))
if (unresolvedApkLicenseIds.length) {
  throw new Error(`Alpine APK license identifiers are absent from the pinned SPDX list: ${unresolvedApkLicenseIds.join(', ')}`)
}
const evidenceByPurl = new Map()
const pinnedLicenseTextByComponent = new Map()
async function readPinnedGoLicense(component) {
  const identity = `${component.name}@${component.version}`
  const pin = pinnedGoLicenseAssets.get(identity)
  if (!pin) return undefined
  if (!pinnedLicenseTextByComponent.has(identity)) {
    const text = await readFile(pin.path, 'utf8')
    if (createHash('sha256').update(text).digest('hex') !== pin.sha256) {
      throw new Error(`The pinned Go module license failed SHA-256 verification: ${identity}`)
    }
    pinnedLicenseTextByComponent.set(identity, {
      license: pin.description,
      notice: `Upstream ${pin.source}, source commit ${pin.commit}, LICENSE SHA-256 ${pin.sha256}:\n\n${text.trimEnd()}`,
    })
  }
  return pinnedLicenseTextByComponent.get(identity)
}
const goComponents = thirdParty.filter(component => (component.license === 'NOASSERTION' || component.license.includes('LicenseRef:')) &&
  component.purl.startsWith('pkg:golang/') && !pinnedGoLicenseAssets.has(`${component.name}@${component.version}`))
const goResolutions = new Map((await mapWithConcurrency(goComponents, 8, async component => {
  return [component, await goModuleLicense(component.purl, component.name, component.version)]
})).map(([component, notice]) => [component.purl, { notice, modulePurl: component.purl }]))
const resolvedComponents = []
for (const component of thirdParty) {
  let license = component.license
  let supportingFile
  const pinnedGoLicense = await readPinnedGoLicense(component)
  if (license === 'NOASSERTION' || license.includes('LicenseRef:')) {
    supportingFile = noticeFileByPackage.get(component.name) ??
      (['libgcc-s1', 'libgomp1', 'libstdc++6'].includes(component.name)
        ? noticeFileByPackage.get('gcc-14-base') : undefined) ??
      (component.name === 'node' ? noticeFiles.find(path => relative(systemRoot, path) === join('nodejs', 'LICENSE')) : undefined)
    if (supportingFile) license = `See included ${relative(systemRoot, supportingFile)}`
  }
  const apkDeclaredLicense = apkLicense(component, apkPackages)
  if ((license === 'NOASSERTION' || license.includes('LicenseRef:')) && apkDeclaredLicense) license = apkDeclaredLicense
  if ((license === 'NOASSERTION' || license.includes('LicenseRef:')) && pinnedGoLicense) {
    license = pinnedGoLicense.license
    evidenceByPurl.set(component.purl, pinnedGoLicense.notice)
  }
  if ((license === 'NOASSERTION' || license.includes('LicenseRef:')) && goResolutions.has(component.purl)) {
    const { notice, modulePurl } = goResolutions.get(component.purl)
    if (notice) {
      license = component.name === 'caddy' && modulePurl !== component.purl
        ? `Caddy main binary uses the exact pinned Caddy module license below (${modulePurl}).`
        : 'See included exact-version Go module license file(s) below.'
      evidenceByPurl.set(modulePurl, notice)
    }
  }
  if ((license === 'NOASSERTION' || license.includes('LicenseRef:')) &&
    component.name === 'postgresql' && component.version === '18.6') {
    const notice = await readFile(postgresqlNoticePath, 'utf8')
    if (createHash('sha256').update(notice).digest('hex') !== postgresqlNoticeSha256) {
      throw new Error('The vendored PostgreSQL 18.6 COPYRIGHT file does not match its pinned source digest')
    }
    license = `PostgreSQL License; full COPYRIGHT from source commit ${postgresqlNoticeCommit} is embedded below.`
    evidenceByPurl.set(component.purl, notice.trimEnd())
  }
  if ((license === 'NOASSERTION' || license.includes('LicenseRef:')) &&
    component.name === 'github.com/tianon/gosu' && component.version === 'v1.19.0') {
    const notice = await readFile(gosuNoticePath, 'utf8')
    if (createHash('sha256').update(notice).digest('hex') !== gosuNoticeSha256) {
      throw new Error('The vendored gosu 1.19 license does not match its pinned source digest')
    }
    license = `Upstream gosu tag 1.19, source commit ${gosuNoticeCommit}; full license is embedded below.`
    evidenceByPurl.set(component.purl, notice.trimEnd())
  }
  resolvedComponents.push({ ...component, license })
}
const unresolved = resolvedComponents.filter(component => component.license === 'NOASSERTION' || component.license.includes('LicenseRef:'))
const embeddedLicenseText = await Promise.all(noticeFiles.map(async path => [
  `----- BEGIN ${relative(systemRoot, path)} -----`,
  '',
  (await readFile(path, 'utf8')).trimEnd(),
  `----- END ${relative(systemRoot, path)} -----`,
  '',
])).then(records => records.flat())
const moduleLicenseText = [...new Set(evidenceByPurl.values())].sort().flatMap(text => [text, ''])
const alpineLicenseText = apkPackages.length ? [
  `Canonical license text from SPDX License List v3.29.0, source commit ${spdxLicenseListCommit}, bundled evidence SHA-256 ${spdxLicenseTextsSha256}:`,
  ...apkIdentifiers.flatMap(identifier => {
    if (/^public[ -]domain$/i.test(identifier)) return [`Declared public-domain package content: ${identifier}`, '']
    return [`----- BEGIN SPDX ${identifier} -----`, '', spdxLicenseTexts.get(identifier).trimEnd(),
      `----- END SPDX ${identifier} -----`, '']
  }),
] : []
const lines = [
  'AiKayun third-party component and declared-license inventory',
  `OCI image: ${imageReference}`,
  'Generated from the exact platform-specific CycloneDX SBOM listed in the signed release manifest.',
  'This inventory supplements the SBOM; use each component license identifier and package URL to locate its complete upstream terms.',
  '',
  ...firstParty.flatMap(component => [`${component.name}@${component.version}`, 'First-party proprietary AiKayun component; not a third-party dependency.', '']),
  ...resolvedComponents.flatMap(component => [
    `${component.name}@${component.version}`,
    `Declared license metadata: ${component.license}`,
    `Package URL: ${component.purl}`,
    '',
  ]),
  ...moduleLicenseText,
  ...alpineLicenseText,
  ...(noticeFiles.length ? [
    'Embedded OS/runtime copyright and license files:',
    ...embeddedLicenseText,
    '',
  ] : []),
  ...(apkPackages.length ? [
    'Alpine APK declared-license evidence from /lib/apk/db/installed:',
    ...[...new Map(resolvedComponents.map(component => {
      const entry = apkLicense(component, apkPackages)
      return entry ? [entry, entry] : undefined
    }).filter(Boolean))].map(([entry]) => entry),
    '',
  ] : []),
]
await writeFile(outputPath, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify({ image: imageReference, third_party_components: thirdParty.length,
  first_party_components: firstParty.length,
  alpine_packages: apkPackages.length,
  embedded_go_module_notices: evidenceByPurl.size,
  unresolved: unresolved.map(({ name, version }) => `${name}@${version}`) })}\n`)
if (unresolved.length) process.exitCode = 2
if (temporaryLicenseCacheDirectory) await rm(temporaryLicenseCacheDirectory, { recursive: true, force: true })
