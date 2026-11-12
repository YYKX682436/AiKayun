#!/usr/bin/env node
// Independent candidate; output is unsigned until checked against a signed release manifest.
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkEvidence } from './make-restic-sbom.mjs'
import { hasOnlyLicenseEvidenceFields } from './license-evidence-fields.mjs'
import { writeOfflineGoCache } from './offline-notice-cache.mjs'
import { renderResticLicenses } from './restic-license-format.mjs'

class Reject extends Error {}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceGeneratorHash = 'df92640564e96418a53e9b3bd2495943476cc7006a8d31b9dd8ed798b3b104b6'
const licenseManifestHash = '92f0c44844b7e9e16956e00f7c5c9a5805ac7ab55d2febe048b5d6c5ecba6be2'
const trivyImage = 'aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006'
const syftImage = 'anchore/syft@sha256:825cad3a952c87676a6d07e9a3bb05ac9c401d598360070e970aa46d54c1727e'
const binaryHashes = { arm64: '2afe80670531f7cc4eb7f445fe6edfe70faa691a679be4a0d78df088a72d24b6', amd64: '42c087e671a774f637b522aa89f8fe60f2fa5ea17187c185255f0a862d36060f' }
function cleanupScanner(name, token) {
  const run = args => spawnSync('docker', args, { timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  const list = () => run(['container','ls','--all','--filter',`name=^/${name}$`,'--format','{{.ID}}'])
  try {
    const first = list()
    if (first.error || first.status !== 0) return false
    const ids = first.stdout.trim() ? first.stdout.trim().split(/\r?\n/) : []
    if (!ids.length) return true
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0])) return false
    const inspected = run(['container','inspect',ids[0]])
    if (inspected.error || inspected.status !== 0) return false
    const data = JSON.parse(inspected.stdout)
    if (!Array.isArray(data) || data.length !== 1 || !/^[a-f0-9]{64}$/.test(data[0]?.Id ?? '') ||
        !data[0].Id.startsWith(ids[0]) || data[0].Name !== `/${name}` ||
        data[0]?.Config?.Labels?.['io.aikayun.restic-evidence-token'] !== token) return false
    const removed = run(['rm','--force','--volumes',ids[0]])
    if (removed.error || removed.status !== 0) return false
    const last = list()
    return !last.error && last.status === 0 && !last.stdout.trim()
  } catch { return false }
}
async function readRegular(path, limit, expected) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > limit) throw new Reject('Invalid bounded input')
  const data = await readFile(path)
  if (expected && (!/^[a-f0-9]{64}$/.test(expected) || digest(data) !== expected)) throw new Reject('Trusted input digest mismatch')
  return data
}
async function checkSystem(root, systemProof, stageHash, rootfsHash, arch) {
  if (systemProof.schema !== 'aikayun.restic-system-notices.v1' || systemProof.arch !== arch ||
      systemProof.staging_proof_sha256 !== stageHash || systemProof.rootfs_tar_sha256 !== rootfsHash || !Array.isArray(systemProof.files)) throw new Reject('System notice provenance mismatch')
  const expected = new Map()
  for (const item of systemProof.files) {
    if (!item || typeof item.path !== 'string' || typeof item.source !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isInteger(item.size) || item.size <= 0 || item.size > 1024 * 1024 || isAbsolute(item.path) ||
        item.path.split('/').some(p => !p || p === '.' || p === '..') || expected.has(item.path)) throw new Reject('Invalid system notice record')
    expected.set(item.path, item)
  }
  const seen = new Set()
  async function walk(dir) {
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Reject('Unsafe system notice directory')
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name); const rel = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) { await walk(full); continue }
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Reject('Unsafe system notice file')
      const fileInfo = await lstat(full)
      if (fileInfo.uid !== process.getuid() || (fileInfo.mode & 0o077) !== 0 || fileInfo.nlink !== 1) throw new Reject('Unsafe system notice file')
      if (rel === 'system-notices-proof.json') continue
      const item = expected.get(rel); if (!item || seen.has(rel)) throw new Reject('Unexpected system notice file')
      const bytes = await readRegular(full, 1024 * 1024, item.sha256)
      if (bytes.length !== item.size) throw new Reject('System notice size mismatch')
      seen.add(rel)
    }
  }
  await walk(root)
  if (seen.size !== expected.size || !seen.has('nodejs/LICENSE')) throw new Reject('Missing system notice file')
}
async function run() {
  const [stagePath, stageSha, indexPath, sbomProofPath, sbomProofSha, evidencePath, evidenceSha, systemRoot, systemSha, output] = process.argv.slice(2)
  if (!output || !isAbsolute(output) || !isAbsolute(systemRoot)) throw new Reject('Invalid arguments')
  const parent = await lstat(dirname(output))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw new Reject('Output parent must be private')
  const stage = JSON.parse((await readRegular(stagePath, 1024 * 1024, stageSha)).toString('utf8'))
  if (stage.schema !== 'aikayun.restic-staging-extraction.v1' || !binaryHashes[stage.arch] ||
      !/^sha256:[a-f0-9]{64}$/.test(stage.index_digest) || !/^sha256:[a-f0-9]{64}$/.test(stage.platform_manifest_digest) ||
      !/^sha256:[a-f0-9]{64}$/.test(stage.local_image_id) || stage.image_ref !== `ghcr.io/yykx682436/aikayun-staging-api@${stage.platform_manifest_digest}` ||
      !/^[a-f0-9]{64}$/.test(stage.rootfs_tar_sha256) || stage.binary_sha256 !== binaryHashes[stage.arch] || !isAbsolute(stage.binary_path)) throw new Reject('Invalid staging identity')
  const indexBytes = await readRegular(indexPath, 1024 * 1024, stage.index_digest.slice('sha256:'.length))
  const indexCheck = spawnSync('python3', [fileURLToPath(new URL('./staging-image/validate-index.py', import.meta.url)), indexPath,
    stage.index_digest, stage.arch, stage.image_ref], { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (indexCheck.error || indexCheck.status !== 0) throw new Reject('OCI staging index rejected')
  const binary = await readRegular(stage.binary_path, 128 * 1024 * 1024, stage.binary_sha256)
  const sbomProof = JSON.parse((await readRegular(sbomProofPath, 1024 * 1024, sbomProofSha)).toString('utf8'))
  if (sbomProof.schema !== 'aikayun.restic-staging-sbom.v1' || sbomProof.staging_proof_sha256 !== stageSha ||
      sbomProof.arch !== stage.arch || sbomProof.image_ref !== stage.image_ref || sbomProof.index_digest !== stage.index_digest ||
      sbomProof.platform_manifest_digest !== stage.platform_manifest_digest || sbomProof.local_image_id !== stage.local_image_id ||
      sbomProof.syft_image !== syftImage || !/^[a-f0-9]{64}$/.test(sbomProof.sbom_sha256) ||
      !/^[a-f0-9]{64}$/.test(sbomProof.image_archive_sha256) || !isAbsolute(sbomProof.sbom_path)) throw new Reject('SBOM provenance mismatch')
  const sbomPath = sbomProof.sbom_path, sbomSha = sbomProof.sbom_sha256
  const sbomBytes = await readRegular(sbomPath, 16 * 1024 * 1024, sbomSha); const sbom = JSON.parse(sbomBytes.toString('utf8'))
  const evidenceBytes = await readRegular(evidencePath, 16 * 1024 * 1024, evidenceSha); const evidence = JSON.parse(evidenceBytes.toString('utf8'))
  if (!hasOnlyLicenseEvidenceFields(evidence)) throw new Reject('Unexpected license evidence fields')
  try { checkEvidence(evidence, stage.arch) } catch { throw new Reject('Invalid verified license evidence') }
  const systemProofPath = join(systemRoot, 'system-notices-proof.json')
  const systemProof = JSON.parse((await readRegular(systemProofPath, 1024 * 1024, systemSha)).toString('utf8'))
  await checkSystem(systemRoot, systemProof, stageSha, stage.rootfs_tar_sha256, stage.arch)
  // Independently derive the entire system notice set from the same bounded
  // rootfs archive; caller-provided files and proof cannot authenticate each other.
  const systemCheck = await mkdtemp(join(dirname(output), '.aikayun-system-check-'))
  try {
    const extractor = fileURLToPath(new URL('./extract-system-notices.py', import.meta.url))
    const extracted = spawnSync('python3', [extractor, stagePath, stageSha, join(systemCheck, 'system')], {
      timeout: 120000, encoding: 'utf8', maxBuffer: 1024 * 1024,
    })
    if (extracted.error || extracted.status !== 0) throw new Reject('Cannot derive system notices from staging rootfs')
    const derived = await readRegular(join(systemCheck, 'system', 'system-notices-proof.json'), 1024 * 1024)
    if (digest(derived) !== systemSha) throw new Reject('System notice source differs from staging rootfs')
  } finally { await rm(systemCheck, { recursive: true, force: true }) }
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) throw new Reject('Invalid full SBOM')
  const go = sbom.components.filter(c => typeof c.purl === 'string' && c.purl.startsWith('pkg:golang/'))
  const files = sbom.components.filter(c => c.type === 'file' && c.name === '/usr/bin/restic')
  if (go.length !== 81 || files.length !== 1) throw new Reject('Missing Go components or binary')
  const actualHashes = files[0].hashes
  if (!Array.isArray(actualHashes) || actualHashes.filter(x => x.alg === 'SHA-256').length !== 1 || actualHashes.find(x => x.alg === 'SHA-256').content !== stage.binary_sha256 ||
      actualHashes.filter(x => x.alg === 'SHA-1').length !== 1 || actualHashes.find(x => x.alg === 'SHA-1').content !== createHash('sha1').update(binary).digest('hex') ||
      actualHashes.some(x => !['SHA-1','SHA-256'].includes(x.alg))) throw new Reject('SBOM binary identity mismatch')
  const generator = fileURLToPath(new URL('../generate-sbom-notice.mjs', import.meta.url))
  await readRegular(generator, 2 * 1024 * 1024, sourceGeneratorHash)
  await mkdir(output, { mode: 0o700 })
  let success = false
  let scanDir
  let cleanupUncertain = false
  try {
    const cache = join(output, 'cache'), noexec = join(output, 'noexec')
    await mkdir(cache, { mode: 0o700 }); await mkdir(noexec, { mode: 0o700 })
    try { await writeOfflineGoCache(cache, sbom, evidence, stage.arch, stage.binary_sha256) } catch { throw new Reject('Invalid Go component identity') }
    const genericName = `NOTICE-image-api-linux-${stage.arch}.txt`
    const generatorResult = spawnSync(process.execPath, [generator, sbomPath, join(output, genericName), stage.image_ref, systemRoot], {
      env: { PATH: noexec, AIKAYUN_GO_LICENSE_CACHE_DIR: cache }, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
    })
    if (generatorResult.error || generatorResult.status !== 0) throw new Reject('Original NOTICE check failed')
    await chmod(join(output, genericName), 0o600)
    const report = JSON.parse(generatorResult.stdout)
    if (!Array.isArray(report.unresolved) || report.unresolved.length || !Number.isInteger(report.third_party_components)) throw new Reject('Original NOTICE check incomplete')
    await checkSystem(systemRoot, systemProof, stageSha, stage.rootfs_tar_sha256, stage.arch)
    await readRegular(stagePath, 1024 * 1024, stageSha)
    await readRegular(sbomProofPath, 1024 * 1024, sbomProofSha)
    await readRegular(sbomPath, 16 * 1024 * 1024, sbomSha)
    await readRegular(evidencePath, 16 * 1024 * 1024, evidenceSha)
    const extraName = `NOTICE-restic-licenses-linux-${stage.arch}.txt`
    await writeFile(join(output, extraName), renderResticLicenses(evidence, stage.binary_sha256), { flag: 'wx', mode: 0o600 })
    const indexName = `NOTICE-restic-index-linux-${stage.arch}.txt`
    await writeFile(join(output, indexName), indexBytes, { flag: 'wx', mode: 0o600 })
    const evidenceName = `NOTICE-restic-evidence-linux-${stage.arch}.txt`
    const publishedEvidence = Buffer.from(`${JSON.stringify(evidence)}\n`)
    await writeFile(join(output, evidenceName), publishedEvidence, { flag: 'wx', mode: 0o600 })
    const systemName = `NOTICE-restic-system-linux-${stage.arch}.txt`, systemFiles = []
    for (const item of systemProof.files) {
      const data = await readRegular(join(systemRoot, ...item.path.split('/')), 1024 * 1024, item.sha256)
      const content = data.toString('utf8')
      if (!Buffer.from(content, 'utf8').equals(data) || content.includes('\0')) throw new Reject('System notice is not valid text')
      systemFiles.push({ ...item, content })
    }
    await writeFile(join(output, systemName), `${JSON.stringify({ schema:'aikayun.restic-system-bundle.v1', arch:stage.arch,
      staging_proof_sha256:stageSha, rootfs_tar_sha256:stage.rootfs_tar_sha256, files:systemFiles })}\n`, { flag:'wx', mode:0o600 })
    const stageName = `NOTICE-restic-stage-proof-linux-${stage.arch}.txt`, sbomProofName = `NOTICE-restic-sbom-proof-linux-${stage.arch}.txt`
    const stagePublic = { schema:stage.schema, source_proof_sha256:stageSha, arch:stage.arch, image_ref:stage.image_ref, index_digest:stage.index_digest,
      platform_manifest_digest:stage.platform_manifest_digest, local_image_id:stage.local_image_id,
      binary_sha256:stage.binary_sha256, rootfs_tar_sha256:stage.rootfs_tar_sha256 }
    const sbomPublic = { schema:sbomProof.schema, source_proof_sha256:sbomProofSha, staging_proof_sha256:sbomProof.staging_proof_sha256, arch:sbomProof.arch,
      image_ref:sbomProof.image_ref, index_digest:sbomProof.index_digest, platform_manifest_digest:sbomProof.platform_manifest_digest,
      local_image_id:sbomProof.local_image_id, image_archive_sha256:sbomProof.image_archive_sha256,
      sbom_sha256:sbomProof.sbom_sha256, syft_image:sbomProof.syft_image }
    await writeFile(join(output,stageName), `${JSON.stringify(stagePublic)}\n`, { flag:'wx', mode:0o600 })
    await writeFile(join(output,sbomProofName), `${JSON.stringify(sbomPublic)}\n`, { flag:'wx', mode:0o600 })
    const artifacts = []
    for (const name of [genericName, extraName, indexName, evidenceName, systemName, stageName, sbomProofName]) {
      const bytes = await readRegular(join(output, name), 16 * 1024 * 1024)
      artifacts.push({ name, size: bytes.length, sha256: digest(bytes) })
    }
    const bindingName = `NOTICE-restic-binding-linux-${stage.arch}.txt`
    const binding = { schema: 'aikayun.restic-release-evidence.v1', arch: stage.arch, staging_image_ref: stage.image_ref,
      platform_manifest_digest: stage.platform_manifest_digest, index_digest: stage.index_digest, binary_sha256: stage.binary_sha256,
      sbom_sha256: sbomSha, sbom_proof_sha256: sbomProofSha, syft_image: syftImage, image_archive_sha256: sbomProof.image_archive_sha256, rootfs_tar_sha256: stage.rootfs_tar_sha256, staging_proof_sha256: stageSha, system_proof_sha256: systemSha, local_image_id: stage.local_image_id,
      system_files: systemProof.files,
      license_evidence_sha256: digest(publishedEvidence), source_license_evidence_sha256: evidenceSha,
      license_manifest_sha256: licenseManifestHash, generator_sha256: sourceGeneratorHash, artifacts }
    await writeFile(join(output, bindingName), `${JSON.stringify(binding)}\n`, { flag: 'wx', mode: 0o600 })
    await rm(cache, { recursive: true }); await rm(noexec, { recursive: true })
    // Scan only the completed, bounded NOTICE files. No network and no raw scan output is published.
    const scannedBefore = []
    for (const name of [genericName, extraName, indexName, evidenceName, systemName, stageName, sbomProofName, bindingName]) { const data = await readRegular(join(output,name),16*1024*1024); scannedBefore.push({ name, sha256:digest(data) }) }
    scanDir = await mkdtemp(join(dirname(output), '.aikayun-notice-scan-'))
    const token = randomBytes(24).toString('hex'), trivyName = `aikayun-restic-notice-${token}`
    const scan = spawnSync('docker', ['run','--rm','--name',trivyName,'--label',`io.aikayun.restic-evidence-token=${token}`,'--pull=never','--network','none','--read-only','--memory','1g','--cpus','2','--pids-limit','64',
      '--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--tmpfs','/root/.cache/trivy:rw,noexec,nosuid,size=32m',
      '--mount',`type=bind,source=${output},target=/input,readonly`, '--mount',`type=bind,source=${scanDir},target=/out`,
      trivyImage,'fs','--scanners','secret','--format','json','--output','/out/scan.json','--exit-code','0','/input'],
      { timeout: 180000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    const cleanupProven = cleanupScanner(trivyName, token)
    if (!cleanupProven || scan.error) cleanupUncertain = true
    if (!cleanupProven) throw new Reject('NOTICE scanner cleanup could not be verified')
    if (scan.error?.code === 'ETIMEDOUT') throw new Reject('NOTICE scanner creation or cleanup could not be verified')
    if (scan.error || scan.status !== 0) throw new Reject('NOTICE secrets scanner failed')
    const scanReport = JSON.parse((await readRegular(join(scanDir,'scan.json'), 16 * 1024 * 1024)).toString('utf8'))
    const allowed = new Set(['ArtifactName','ArtifactType','CreatedAt','ReportID','SchemaVersion','Trivy','Results'])
    if (Object.keys(scanReport).some(k => !allowed.has(k)) || scanReport.SchemaVersion !== 2 || scanReport.ArtifactName !== '/input' ||
        scanReport.ArtifactType !== 'filesystem' || scanReport.Trivy?.Version !== '0.69.0' || Object.keys(scanReport.Trivy).some(k => k !== 'Version') ||
        (scanReport.Results !== undefined && (!Array.isArray(scanReport.Results) || scanReport.Results.some(r => !r ||
          Object.keys(r).some(k => !['Target','Class','Type','Secrets'].includes(k)) || !Array.isArray(r.Secrets) || r.Secrets.length)))) throw new Reject('NOTICE secrets scan failed or was incomplete')
    await rm(scanDir, { recursive: true }); scanDir = undefined
    const scanName = `NOTICE-restic-scan-linux-${stage.arch}.txt`
    const scanned = []
    for (const name of [genericName, extraName, indexName, evidenceName, systemName, stageName, sbomProofName, bindingName]) { const data = await readRegular(join(output,name),16*1024*1024); scanned.push({ name, sha256:digest(data) }) }
    if (JSON.stringify(scanned) !== JSON.stringify(scannedBefore)) throw new Reject('NOTICE changed during secret scan')
    await writeFile(join(output,scanName), `${JSON.stringify({schema:'aikayun.restic-notice-secrets.v1',scanner:trivyImage,scope:'notice-files-only',findings:0,files:scanned})}\n`, { flag:'wx', mode:0o600 })
    success = true
    process.stdout.write(JSON.stringify({ arch:stage.arch, third_party_components:report.third_party_components, verified_go_modules:80, license_files:evidence.licenses.length, notice_secret_findings:0 })+'\n')
  } finally {
    // Unknown container creation/termination may leave a writer using either
    // mount. Keep both private directories for controlled operator cleanup.
    if (!cleanupUncertain) {
      if (scanDir) await rm(scanDir,{recursive:true,force:true})
      if (!success) await rm(output,{recursive:true,force:true})
    }
  }
}
run().catch(error => { process.stderr.write(`Restic NOTICE preparation rejected: ${error instanceof Reject ? error.message : 'invalid input or processing failure'}\n`); process.exitCode=1 })
