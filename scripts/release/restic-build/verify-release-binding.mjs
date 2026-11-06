#!/usr/bin/env node
// Experimental post-assembly check; the public-key digest must be independently pinned.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReleaseArtifacts, verifyReleaseManifest } from '../../../apps/api/scripts/release/manifest.mjs'
import { checkEvidence } from './make-restic-sbom.mjs'
import { hasOnlyLicenseEvidenceFields } from './license-evidence-fields.mjs'
import { renderResticLicenses } from './restic-license-format.mjs'
import { writeOfflineGoCache } from './offline-notice-cache.mjs'
class Reject extends Error {}
const digest = b => createHash('sha256').update(b).digest('hex')
const expectedBinary = { arm64:'26c5b4d898ef5ea434d638fcbab616c319761dbd71ffe0d3585b37a9af62a2e1', amd64:'2f516a8aebbc0510806a501a88efdca5f199e52f9c6b720f044157a25684d84e' }
const trivy = 'aquasec/trivy@sha256:33f816d414b9d582d25bb737ffa4a632ae34e222f7ec1b50252cef0ce2266006'
async function read(path,limit=16*1024*1024) {
  const s=await lstat(path); if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<=0||s.size>limit) throw new Reject('Invalid artifact')
  return readFile(path)
}
async function main() {
  const [root, manifestPath, signaturePath, publicKeyPath, trustedKeyHash, arch] = process.argv.slice(2)
  if(!arch||!expectedBinary[arch]||!isAbsolute(root)||!/^[a-f0-9]{64}$/.test(trustedKeyHash)) throw new Reject('Invalid arguments')
  for(const dir of [root,join(root,'notices'),join(root,'sbom')]) { const s=await lstat(dir); if(!s.isDirectory()||s.isSymbolicLink()) throw new Reject('Unsafe release directory') }
  const publicKey=await read(publicKeyPath,1024*1024), manifestBytes=await read(manifestPath), signature=await read(signaturePath,1024*1024)
  if(digest(publicKey)!==trustedKeyHash) throw new Reject('Release key pin mismatch')
  const verified=await verifyReleaseManifest(manifestPath,signaturePath,publicKeyPath)
  if(verified.manifest_sha256!==digest(manifestBytes)||digest(await read(publicKeyPath,1024*1024))!==trustedKeyHash||digest(await read(signaturePath,1024*1024))!==digest(signature)) throw new Reject('Release signature inputs changed')
  await verifyReleaseArtifacts(manifestPath, root)
  if(digest(await read(manifestPath))!==verified.manifest_sha256) throw new Reject('Release manifest changed')
  const manifest=verified.manifest
  const artifacts=new Map()
  for(const a of manifest.artifacts) { if(artifacts.has(a.name)) throw new Reject('Duplicate manifest artifact'); artifacts.set(a.name,a) }
  async function artifact(name) {
    const p=join(root,name); const bytes=await read(p); const item=artifacts.get(name)
    if(!item||item.size!==bytes.length||item.sha256!==digest(bytes)) throw new Reject('Manifest artifact mismatch')
    return bytes
  }
  const genericName=`NOTICE-image-api-linux-${arch}.txt`, licenseName=`NOTICE-restic-licenses-linux-${arch}.txt`
  const bindingName=`NOTICE-restic-binding-linux-${arch}.txt`, scanName=`NOTICE-restic-scan-linux-${arch}.txt`, indexName=`NOTICE-restic-index-linux-${arch}.txt`
  const evidenceName=`NOTICE-restic-evidence-linux-${arch}.txt`, systemName=`NOTICE-restic-system-linux-${arch}.txt`
  const stageName=`NOTICE-restic-stage-proof-linux-${arch}.txt`, sbomProofName=`NOTICE-restic-sbom-proof-linux-${arch}.txt`
  const bindingBytes=await artifact(`notices/${bindingName}`), generic=await artifact(`notices/${genericName}`), license=await artifact(`notices/${licenseName}`)
  const indexBytes=await artifact(`notices/${indexName}`), evidenceBytes=await artifact(`notices/${evidenceName}`), systemBytes=await artifact(`notices/${systemName}`)
  const stageBytes=await artifact(`notices/${stageName}`), sbomProofBytes=await artifact(`notices/${sbomProofName}`)
  const scanBytes=await artifact(`notices/${scanName}`), sbom=await artifact(`sbom/api-linux-${arch}.cdx.json`)
  const binding=JSON.parse(bindingBytes), scan=JSON.parse(scanBytes)
  if(!Buffer.from(`${JSON.stringify(binding)}\n`).equals(bindingBytes)||!Buffer.from(`${JSON.stringify(scan)}\n`).equals(scanBytes)) throw new Reject('Noncanonical evidence encoding')
  const image=manifest.images.api
  if(binding.schema!=='aikayun.restic-release-evidence.v1'||binding.arch!==arch||binding.binary_sha256!==expectedBinary[arch]||
     binding.license_manifest_sha256!=='1798e78a9b8d8d24bd901c8c9bccdce77bf14d98215f2a708beeb6f320dae63b'||
     binding.generator_sha256!=='df92640564e96418a53e9b3bd2495943476cc7006a8d31b9dd8ed798b3b104b6'||
     binding.syft_image!=='anchore/syft@sha256:825cad3a952c87676a6d07e9a3bb05ac9c401d598360070e970aa46d54c1727e'||
     !/^sha256:[a-f0-9]{64}$/.test(binding.local_image_id)||
     !['sbom_sha256','sbom_proof_sha256','image_archive_sha256','rootfs_tar_sha256','staging_proof_sha256','system_proof_sha256','license_evidence_sha256','source_license_evidence_sha256'].every(k=>/^[a-f0-9]{64}$/.test(binding[k]))||
     !/^sha256:[a-f0-9]{64}$/.test(binding.index_digest)||!/^sha256:[a-f0-9]{64}$/.test(binding.platform_manifest_digest)||
     binding.staging_image_ref!==`ghcr.io/yykx682436/aikayun-staging-api@${binding.platform_manifest_digest}`||
     image.reference!==`ghcr.io/yykx682436/aikayun-api@${binding.index_digest}`||image.platform_digests[`linux/${arch}`]!==binding.platform_manifest_digest.slice('sha256:'.length)||
     image.sbom_sha256[`linux/${arch}`]!==binding.sbom_sha256||digest(sbom)!==binding.sbom_sha256) throw new Reject('Release image evidence mismatch')
  if(digest(indexBytes)!==binding.index_digest.slice('sha256:'.length)) throw new Reject('Release OCI index mismatch')
  const indexCheck=spawnSync('python3',[fileURLToPath(new URL('./staging-image/validate-index.py',import.meta.url)),join(root,'notices',indexName),
    binding.index_digest,arch,binding.staging_image_ref],{timeout:30000,encoding:'utf8',maxBuffer:1024*1024})
  if(indexCheck.error||indexCheck.status!==0) throw new Reject('Release OCI index rejected')
  if(!Array.isArray(binding.system_files)||!binding.system_files.length) throw new Reject('System notice evidence missing')
  const systemPaths=new Map()
  for(const f of binding.system_files) {
    if(!f||typeof f.source!=='string'||typeof f.path!=='string'||!Number.isSafeInteger(f.size)||f.size<=0||f.size>1024*1024||
       !/^[a-f0-9]{64}$/.test(f.sha256)||f.path.startsWith('/')||/[\\\r\n\0]/.test(f.path)||f.path.split('/').some(x=>!x||x==='.'||x==='..')||systemPaths.has(f.path)) throw new Reject('Invalid system notice evidence')
    systemPaths.set(f.path,f.sha256)
  }
  if(systemPaths.get('nodejs/LICENSE')!=='5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace'||
     systemPaths.get('doc/util-linux/copyright')!=='56b67e2eb8bac5a15d91e261d558d73f1f029113cced229753138194997366b6') throw new Reject('Required runtime license evidence missing')
  const expectedStage={schema:'aikayun.restic-staging-extraction.v1',source_proof_sha256:binding.staging_proof_sha256,arch,
    image_ref:binding.staging_image_ref,index_digest:binding.index_digest,platform_manifest_digest:binding.platform_manifest_digest,
    local_image_id:binding.local_image_id,binary_sha256:binding.binary_sha256,rootfs_tar_sha256:binding.rootfs_tar_sha256}
  const expectedSbomProof={schema:'aikayun.restic-staging-sbom.v1',source_proof_sha256:binding.sbom_proof_sha256,
    staging_proof_sha256:binding.staging_proof_sha256,arch,image_ref:binding.staging_image_ref,index_digest:binding.index_digest,
    platform_manifest_digest:binding.platform_manifest_digest,local_image_id:binding.local_image_id,image_archive_sha256:binding.image_archive_sha256,
    sbom_sha256:binding.sbom_sha256,syft_image:binding.syft_image}
  if(!Buffer.from(`${JSON.stringify(expectedStage)}\n`).equals(stageBytes)||!Buffer.from(`${JSON.stringify(expectedSbomProof)}\n`).equals(sbomProofBytes)) throw new Reject('Sanitized build proof mismatch')
  if(digest(evidenceBytes)!==binding.license_evidence_sha256) throw new Reject('Go license evidence digest mismatch')
  const evidence=JSON.parse(evidenceBytes)
  if(!Buffer.from(`${JSON.stringify(evidence)}\n`).equals(evidenceBytes)) throw new Reject('Noncanonical Go license evidence')
  if(!hasOnlyLicenseEvidenceFields(evidence)) throw new Reject('Unexpected Go license evidence fields')
  try{checkEvidence(evidence,arch)}catch{throw new Reject('Invalid Go license evidence')}
  if(!Buffer.from(renderResticLicenses(evidence,binding.binary_sha256)).equals(license)) throw new Reject('Restic NOTICE does not match license evidence')
  const system=JSON.parse(systemBytes)
  if(!Buffer.from(`${JSON.stringify(system)}\n`).equals(systemBytes)) throw new Reject('Noncanonical system license evidence')
  if(system.schema!=='aikayun.restic-system-bundle.v1'||system.arch!==arch||system.staging_proof_sha256!==binding.staging_proof_sha256||
     system.rootfs_tar_sha256!==binding.rootfs_tar_sha256||!Array.isArray(system.files)||system.files.length!==binding.system_files.length) throw new Reject('System license bundle mismatch')
  const systemRecords=[]
  for(const f of system.files){
    if(typeof f.content!=='string'||f.content.includes('\0')||Buffer.byteLength(f.content)!==f.size||digest(f.content)!==f.sha256) throw new Reject('Invalid system license text')
    systemRecords.push({source:f.source,path:f.path,size:f.size,sha256:f.sha256})
    if(f.path!=='lib/apk/db/installed'){
      const marker=`----- BEGIN ${f.path} -----\n\n${f.content.trimEnd()}\n----- END ${f.path} -----`
      if(!generic.toString('utf8').includes(marker)) throw new Reject('Original NOTICE omitted system license text')
    }
  }
  if(JSON.stringify(systemRecords)!==JSON.stringify(binding.system_files)) throw new Reject('System license records mismatch')
  const generator=fileURLToPath(new URL('../generate-sbom-notice.mjs',import.meta.url))
  if(digest(await read(generator,2*1024*1024))!==binding.generator_sha256) throw new Reject('Original NOTICE generator differs')
  const offline=await mkdtemp(join(tmpdir(),'aikayun-release-notice-verify-'))
  try {
    const cache=join(offline,'cache'), noexec=join(offline,'noexec'), systemRoot=join(offline,'system')
    await mkdir(cache,{mode:0o700});await mkdir(noexec,{mode:0o700});await mkdir(systemRoot,{mode:0o700})
    for(const f of system.files){
      const p=join(systemRoot,...f.path.split('/'));await mkdir(dirname(p),{recursive:true,mode:0o700})
      await writeFile(p,f.content,{flag:'wx',mode:0o600})
    }
    try{await writeOfflineGoCache(cache,JSON.parse(sbom),evidence,arch,binding.binary_sha256)}catch{throw new Reject('Cannot reconstruct verified offline notices')}
    const rebuilt=join(offline,'NOTICE.txt')
    const r=spawnSync(process.execPath,[generator,join(root,'sbom',`api-linux-${arch}.cdx.json`),rebuilt,binding.staging_image_ref,systemRoot],{
      env:{PATH:noexec,AIKAYUN_GO_LICENSE_CACHE_DIR:cache},encoding:'utf8',timeout:120000,maxBuffer:1024*1024})
    if(r.error||r.status!==0) throw new Reject('Original offline NOTICE regeneration failed')
    const generated=await read(rebuilt)
    if(!generated.equals(generic)) throw new Reject('Original NOTICE differs from verified offline regeneration')
  } finally { await rm(offline,{recursive:true,force:true}) }
  const want=[{name:genericName,size:generic.length,sha256:digest(generic)},{name:licenseName,size:license.length,sha256:digest(license)},
    {name:indexName,size:indexBytes.length,sha256:digest(indexBytes)},{name:evidenceName,size:evidenceBytes.length,sha256:digest(evidenceBytes)},
    {name:systemName,size:systemBytes.length,sha256:digest(systemBytes)},{name:stageName,size:stageBytes.length,sha256:digest(stageBytes)},
    {name:sbomProofName,size:sbomProofBytes.length,sha256:digest(sbomProofBytes)}]
  if(JSON.stringify(binding.artifacts)!==JSON.stringify(want)) throw new Reject('NOTICE binding mismatch')
  const scanned=[{name:genericName,sha256:digest(generic)},{name:licenseName,sha256:digest(license)},{name:indexName,sha256:digest(indexBytes)},
    {name:evidenceName,sha256:digest(evidenceBytes)},{name:systemName,sha256:digest(systemBytes)},
    {name:stageName,sha256:digest(stageBytes)},{name:sbomProofName,sha256:digest(sbomProofBytes)},{name:bindingName,sha256:digest(bindingBytes)}]
  if(scan.schema!=='aikayun.restic-notice-secrets.v1'||scan.scanner!==trivy||scan.scope!=='notice-files-only'||scan.findings!==0||JSON.stringify(scan.files)!==JSON.stringify(scanned)) throw new Reject('NOTICE secrets evidence mismatch')
  process.stdout.write(JSON.stringify({arch,manifest_sha256:verified.manifest_sha256,image_platform_digest:binding.platform_manifest_digest,verified_notice_artifacts:9})+'\n')
}
main().catch(error=>{process.stderr.write(`Release binding rejected: ${error instanceof Reject ? error.message : 'invalid signed release evidence'}\n`);process.exitCode=1})
