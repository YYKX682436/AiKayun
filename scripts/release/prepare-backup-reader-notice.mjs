import { createHash, randomBytes } from 'node:crypto'
import { execFile as execFileCallback, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { writeOfflineGoCache } from './restic-build/offline-notice-cache.mjs'

const execFile = promisify(execFileCallback)
const goImage = 'golang@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385'
const trivyImage = 'aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006'
const expectedBinarySha256 = {
  amd64: '42c087e671a774f637b522aa89f8fe60f2fa5ea17187c185255f0a862d36060f',
  arm64: '2afe80670531f7cc4eb7f445fe6edfe70faa691a679be4a0d78df088a72d24b6',
}
const expectedCaCopyrightSha256 = 'e85e1bcad3a915dc7e6f41412bc5bdeba275cadd817896ea0451f2140a93967c'
const sha256 = data => createHash('sha256').update(data).digest('hex')

async function regular(path, max, owner) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('BACKUP_NOTICE_INPUT_INVALID')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > max ||
      (owner !== undefined && info.uid !== owner)) throw new Error('BACKUP_NOTICE_INPUT_INVALID')
  return info
}

async function directory(path, owner) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('BACKUP_NOTICE_INPUT_INVALID')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (owner !== undefined && info.uid !== owner)) throw new Error('BACKUP_NOTICE_INPUT_INVALID')
  return info
}

function scanNotice(input, report, arch) {
  const token = randomBytes(24).toString('hex')
  const name = `aikayun-backup-notice-${token}`
  const label = `io.aikayun.backup-notice-scan=${token}`
  const scan = spawnSync('docker', [
    'run', '--rm', '--name', name, '--label', label, '--pull=never', '--network=none', '--read-only',
    '--memory=1g', '--cpus=2', '--pids-limit=64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
    '--tmpfs', '/root/.cache/trivy:rw,noexec,nosuid,size=32m', '--mount', `type=bind,source=${input},target=/input,readonly`,
    '--mount', `type=bind,source=${dirname(report)},target=/out`, trivyImage, 'fs', '--scanners', 'secret',
    '--format', 'json', '--output', '/out/scan.json', '--exit-code', '0', '/input',
  ], { timeout: 180_000, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'ignore', 'ignore'] })
  const remaining = spawnSync('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${label}`], {
    timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (remaining.error || remaining.status !== 0) throw new Error('BACKUP_NOTICE_SCANNER_CLEANUP_UNVERIFIED')
  const ids = remaining.stdout.trim() ? remaining.stdout.trim().split(/\s+/) : []
  if (ids.length > 1 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('BACKUP_NOTICE_SCANNER_CLEANUP_UNVERIFIED')
  if (ids.length === 1) {
    const cleanup = spawnSync('docker', ['rm', '--force', ids[0]], { timeout: 15_000, stdio: 'ignore' })
    if (cleanup.error || cleanup.status !== 0) throw new Error('BACKUP_NOTICE_SCANNER_CLEANUP_UNVERIFIED')
    const check = spawnSync('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${label}`], {
      timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (check.error || check.status !== 0 || check.stdout.trim()) throw new Error('BACKUP_NOTICE_SCANNER_CLEANUP_UNVERIFIED')
  }
  if (scan.error || scan.status !== 0) throw new Error('BACKUP_NOTICE_SECRET_SCAN_FAILED')
  let value
  try { value = JSON.parse(readFileSync(report, 'utf8')) } catch { throw new Error('BACKUP_NOTICE_SECRET_SCAN_FAILED') }
  const allowed = new Set(['ArtifactName', 'ArtifactType', 'CreatedAt', 'ReportID', 'SchemaVersion', 'Trivy', 'Results'])
  const results = value?.Results === undefined ? [] : value.Results
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !allowed.has(key)) || value.SchemaVersion !== 2 ||
      value.ArtifactName !== '/input' || value.ArtifactType !== 'filesystem' || value.Trivy?.Version !== '0.69.0' ||
      Object.keys(value.Trivy).some(key => key !== 'Version') || !Array.isArray(results) || results.some(result =>
        !result || typeof result !== 'object' || Object.keys(result).some(key => !['Target', 'Class', 'Type', 'Secrets'].includes(key)) ||
        !Array.isArray(result.Secrets) || result.Secrets.length !== 0)) throw new Error('BACKUP_NOTICE_SECRET_SCAN_FAILED')
  return { schema: 'aikayun.backup-reader-notice-scan.v1', scanner: trivyImage, scope: 'notice-files-only', arch,
    notice_sha256: sha256(readFileSync(join(input, 'NOTICE.txt'))), findings: 0 }
}

const [sbomPath, evidenceRoot, systemRoot, imageRef, arch, outputPath] = process.argv.slice(2)
if (!sbomPath || !evidenceRoot || !systemRoot || !imageRef || !arch || !outputPath ||
    !expectedBinarySha256[arch] || !/^ghcr\.io\/yykx682436\/aikayun-backup-restic@sha256:[a-f0-9]{64}$/.test(imageRef) ||
    [sbomPath, evidenceRoot, systemRoot, outputPath].some(path => /[,\r\n\0]/.test(path)) ||
    !isAbsolute(outputPath) || resolve(outputPath) !== outputPath) {
  throw new Error('Usage: prepare-backup-reader-notice.mjs SBOM EVIDENCE_ROOT SYSTEM_ROOT IMAGE@DIGEST linux-ARCH OUTPUT')
}
if (await realpath(sbomPath) !== sbomPath || await realpath(evidenceRoot) !== evidenceRoot || await realpath(systemRoot) !== systemRoot) {
  throw new Error('BACKUP_NOTICE_INPUT_INVALID')
}
const root = process.getuid?.()
if (root === undefined || root < 0) throw new Error('BACKUP_NOTICE_INPUT_INVALID')
const sbomStat = await regular(sbomPath, 16 * 1024 * 1024, root)
await directory(evidenceRoot, root)
await directory(systemRoot, root)
const caCopyrightPath = join(systemRoot, 'doc', 'ca-certificates', 'copyright')
await regular(caCopyrightPath, 1024 * 1024, root)
if (sha256(await readFile(caCopyrightPath)) !== expectedCaCopyrightSha256) throw new Error('BACKUP_NOTICE_SYSTEM_LICENSE_MISMATCH')
const binaryPath = join(evidenceRoot, 'restic')
const collectorPath = join(evidenceRoot, 'collector')
const cachePath = join(evidenceRoot, 'module-cache')
const binaryInfo = await regular(binaryPath, 128 * 1024 * 1024, root)
await regular(collectorPath, 128 * 1024 * 1024, root)
await directory(cachePath, root)
if (binaryInfo.uid !== root || binaryInfo.mode & 0o022 || !(binaryInfo.mode & 0o111)) throw new Error('BACKUP_NOTICE_INPUT_INVALID')
const binarySha = sha256(await readFile(binaryPath))
if (binarySha !== expectedBinarySha256[arch]) throw new Error('BACKUP_NOTICE_BINARY_MISMATCH')

const parent = await directory(join(outputPath, '..'), root)
if ((parent.mode & 0o777) !== 0o700 || parent.uid !== root) throw new Error('BACKUP_NOTICE_OUTPUT_INVALID')
const temporary = await mkdtemp(join(join(outputPath, '..'), '.restic-notice-'))
const parentInfo = await lstat(temporary)
if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== root ||
    (parentInfo.mode & 0o777) !== 0o700 || await realpath(temporary) !== temporary) throw new Error('BACKUP_NOTICE_OUTPUT_INVALID')

let completed = false
let failure
try {
  const sbomBytes = await readFile(sbomPath)
  if (sbomBytes.length !== sbomStat.size) throw new Error('BACKUP_NOTICE_SBOM_CHANGED')
  const parsedSbom = JSON.parse(sbomBytes.toString('utf8'))
  const evidenceParent = join(temporary, 'collector-output')
  await mkdir(evidenceParent, { mode: 0o700 })
  const evidenceOutput = join(evidenceParent, 'license-evidence')
  const cacheDirectory = join(temporary, 'offline-go-cache')
  const isolatedPath = join(temporary, 'empty-path')
  const scanInput = join(temporary, 'scan-input')
  const scanOutput = join(temporary, 'scan-output')
  const noticePath = join(temporary, 'NOTICE.txt')
  await mkdir(cacheDirectory, { mode: 0o700 })
  await mkdir(isolatedPath, { mode: 0o700 })
  await mkdir(scanInput, { mode: 0o700 })
  await mkdir(scanOutput, { mode: 0o700 })
  const mounts = [
    `type=bind,source=${collectorPath},target=/collector,readonly`,
    `type=bind,source=${binaryPath},target=/binary,readonly`,
    `type=bind,source=${sbomPath},target=/sbom.json,readonly`,
    `type=bind,source=${cachePath},target=/cache,readonly`,
    `type=bind,source=${evidenceParent},target=/output`,
  ]
  if ([collectorPath, binaryPath, sbomPath, cachePath, evidenceParent].some(path => /[,\r\n\0]/.test(path))) {
    throw new Error('BACKUP_NOTICE_MOUNT_INVALID')
  }
  await execFile('docker', [
    'run', '--rm', '--pull=never', '--network=none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m',
    '--memory=1g', '--cpus=2', '--pids-limit=64', '--user', `${process.getuid?.()}:${process.getgid?.()}`,
    '--cap-drop=ALL', '--security-opt=no-new-privileges', ...mounts.flatMap(mount => ['--mount', mount]),
    '--entrypoint', '/collector', goImage, '/binary', '/sbom.json', '/cache', '/usr/local/go', arch, '/output/license-evidence',
  ], { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024, encoding: 'utf8' })
  const evidencePath = join(evidenceOutput, 'license-evidence.json')
  await regular(evidencePath, 32 * 1024 * 1024, root)
  const evidenceBytes = await readFile(evidencePath)
  const evidence = JSON.parse(evidenceBytes.toString('utf8'))
  await writeOfflineGoCache(cacheDirectory, parsedSbom, evidence, arch, binarySha)
  await execFile(process.execPath, [
    join(import.meta.dirname, 'generate-sbom-notice.mjs'), sbomPath, noticePath, imageRef, systemRoot,
  ], { timeout: 3 * 60 * 1000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    env: { PATH: isolatedPath, AIKAYUN_GO_LICENSE_CACHE_DIR: cacheDirectory } })
  const noticeInfo = await regular(noticePath, 32 * 1024 * 1024, root)
  if (noticeInfo.uid !== root || ![0o600, 0o644].includes(noticeInfo.mode & 0o777)) throw new Error('BACKUP_NOTICE_OUTPUT_INVALID')
  const noticeBytes = await readFile(noticePath)
  const scanNoticePath = join(scanInput, 'NOTICE.txt')
  await writeFile(scanNoticePath, noticeBytes, { flag: 'wx', mode: 0o600 })
  const scanReportPath = join(scanOutput, 'scan.json')
  const scanResult = scanNotice(scanInput, scanReportPath, arch)
  try { await lstat(outputPath); throw new Error('BACKUP_NOTICE_OUTPUT_EXISTS') }
  catch (error) { if ((error).code !== 'ENOENT') throw error }
  await rename(noticePath, outputPath)
  const scanEvidencePath = outputPath.replace(/\.txt$/, '').replace('NOTICE-image-backup-', 'NOTICE-backup-reader-scan-') + '.txt'
  const scanEvidenceBytes = Buffer.from(`${JSON.stringify(scanResult)}\n`)
  await writeFile(scanEvidencePath, scanEvidenceBytes, { flag: 'wx', mode: 0o644 })
  completed = true
} catch (error) {
  failure = error
}
const after = await lstat(temporary)
if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== parentInfo.dev || after.ino !== parentInfo.ino ||
    await realpath(temporary) !== temporary) throw new Error('BACKUP_NOTICE_CLEANUP_UNVERIFIED')
if (completed) await rm(temporary, { recursive: true, force: false })
if (failure) throw failure
process.stdout.write(JSON.stringify({ arch, binary_sha256: binarySha, notice_sha256: sha256(await readFile(outputPath)),
  secret_scan_sha256: sha256(await readFile(outputPath.replace(/\.txt$/, '').replace('NOTICE-image-backup-', 'NOTICE-backup-reader-scan-') + '.txt')) }) + '\n')
