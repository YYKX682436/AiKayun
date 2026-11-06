#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const [stagePath, indexPath, sbomPath, evidencePath, systemRoot] = process.argv.slice(2)
if (!systemRoot) throw new Error('Usage: test-prepare-notice.mjs STAGE_PROOF INDEX SBOM EVIDENCE SYSTEM_ROOT')
const root=dirname(fileURLToPath(import.meta.url)), work=await mkdtemp(join(tmpdir(),'aikayun-notice-gate-test-'))
const sha=async p=>createHash('sha256').update(await readFile(p)).digest('hex')
const write=async (name,data)=>{const p=join(work,name);await writeFile(p,JSON.stringify(data),{flag:'wx',mode:0o600});return p}
const read=async p=>JSON.parse(await readFile(p,'utf8'))
const run=async (name,stage,sbom,evidence,sys,expected,extraEnv={},index=indexPath,proofPatch={},preserve=false)=>{
 const out=join(work,`out-${name}`)
 const stageInfo=await read(stage), stageHash=await sha(stage)
 const sbomProof=await write(`sbom-proof-${name}.json`,{schema:'aikayun.restic-staging-sbom.v1',staging_proof_sha256:stageHash,
   arch:stageInfo.arch,image_ref:stageInfo.image_ref,index_digest:stageInfo.index_digest,platform_manifest_digest:stageInfo.platform_manifest_digest,
   local_image_id:stageInfo.local_image_id,sbom_sha256:await sha(sbom),sbom_path:sbom,
   image_archive_sha256:'4'.repeat(64),
   syft_image:'anchore/syft@sha256:825cad3a952c87676a6d07e9a3bb05ac9c401d598360070e970aa46d54c1727e',...proofPatch})
 const args=[stage,stageHash,index,sbomProof,await sha(sbomProof),evidence,await sha(evidence),sys,await sha(join(sys,'system-notices-proof.json')),out]
 const r=spawnSync(process.execPath,[join(root,'prepare-notice.mjs'),...args],{timeout:180000,encoding:'utf8',env:{...process.env,...extraEnv}})
 if(r.error||(r.status===0)!==!expected||(expected&&!r.stderr.includes(expected))) throw new Error(`Unexpected ${name} result`)
 if(expected&&!preserve){try{await lstatPath(out);throw new Error(`Rejected ${name} left output`)}catch(e){if(e.code!=='ENOENT')throw e}}
 if(preserve){if(!(await lstatPath(out)).isDirectory())throw new Error('Uncertain output was not preserved');const dirs=(await readdir(work)).filter(x=>x.startsWith('.aikayun-notice-scan-'));if(dirs.length!==1)throw new Error('Uncertain scanner output was not preserved');await readFile(join(work,dirs[0],'scan.json'))}
 return out
}
const { lstat:lstatPath }=await import('node:fs/promises')
try {
 const stage=await read(stagePath), sbom=await read(sbomPath), evidence=await read(evidencePath)
 const positive=await run('good',stagePath,sbomPath,evidencePath,systemRoot)
 const scan=await read(join(positive,`NOTICE-restic-scan-linux-${stage.arch}.txt`))
 if(scan.findings!==0||scan.files.length!==8)throw new Error('Invalid positive scan')
 const missing=structuredClone(sbom);missing.components=missing.components.filter(c=>c.name!=='github.com/restic/chunker')
 await run('missing-go',stagePath,await write('missing.json',missing),evidencePath,systemRoot,'Missing Go components')
 const purl=structuredClone(sbom);purl.components.find(c=>c.name==='github.com/restic/chunker').purl='pkg:golang/github.com/other/module@v0.4.0'
 await run('bad-purl',stagePath,await write('bad-purl.json',purl),evidencePath,systemRoot,'Invalid Go component identity')
 const corrupt=structuredClone(evidence);corrupt.licenses[0].content+='tampered'
 await run('bad-evidence',stagePath,sbomPath,await write('bad-evidence.json',corrupt),systemRoot,'Invalid verified license evidence')
 const privateField=structuredClone(evidence);privateField.private_path='/private/non-public-input'
 await run('private-field',stagePath,sbomPath,await write('private-field.json',privateField),systemRoot,'Unexpected license evidence fields')
 const nestedPrivate=structuredClone(evidence);nestedPrivate.licenses[0].private_path='/private/non-public-input'
 await run('nested-private-field',stagePath,sbomPath,await write('nested-private-field.json',nestedPrivate),systemRoot,'Unexpected license evidence fields')
 const nonGo=structuredClone(sbom);const target=nonGo.components.find(c=>c.type!=='file'&&!(c.purl??'').startsWith('pkg:golang/')&&c.name&&!c.name.startsWith('@aikayun/'))
 if(!target)throw new Error('No non-Go component for test');target.name='unknown-aikayun-license-fixture';target.version='0.0.0';target.licenses=[]
 await run('non-go',stagePath,await write('non-go.json',nonGo),evidencePath,systemRoot,'Original NOTICE check failed')
 const sysCorrupt=join(work,'sys-corrupt');await cp(systemRoot,sysCorrupt,{recursive:true});await chmod(sysCorrupt,0o700)
 await writeFile(join(sysCorrupt,'nodejs','LICENSE'),'tampered')
 await run('system-tamper',stagePath,sbomPath,evidencePath,sysCorrupt,'Trusted input digest mismatch')
 const sysForged=join(work,'sys-forged');await cp(systemRoot,sysForged,{recursive:true});await chmod(sysForged,0o700)
 const forgedBytes=Buffer.from('forged notice');await writeFile(join(sysForged,'nodejs','LICENSE'),forgedBytes)
 const forgedProofPath=join(sysForged,'system-notices-proof.json'), forgedProof=await read(forgedProofPath)
 const forgedRecord=forgedProof.files.find(x=>x.path==='nodejs/LICENSE');forgedRecord.size=forgedBytes.length;forgedRecord.sha256=createHash('sha256').update(forgedBytes).digest('hex')
 await writeFile(forgedProofPath,JSON.stringify(forgedProof))
 await run('system-forged',stagePath,sbomPath,evidencePath,sysForged,'System notice source differs from staging rootfs')
 const sysLink=join(work,'sys-link');await cp(systemRoot,sysLink,{recursive:true});await chmod(sysLink,0o700)
 await unlink(join(sysLink,'nodejs','LICENSE'));await symlink('/etc/passwd',join(sysLink,'nodejs','LICENSE'))
 await run('system-link',stagePath,sbomPath,evidencePath,sysLink,'Unsafe system notice file')
 const fake=join(work,'fakebin');await mkdir(fake,{mode:0o700});await writeFile(join(fake,'docker'),'#!/bin/sh\nif [ "$1" = container ] && [ "$2" = ls ]; then exit 0; fi\nexit 9\n',{mode:0o700})
 await run('scanner-fail',stagePath,sbomPath,evidencePath,systemRoot,'NOTICE secrets scanner failed',{PATH:`${fake}:${process.env.PATH}`})
 const fakeReport=join(work,'fake-report-bin');await mkdir(fakeReport,{mode:0o700})
 await writeFile(join(fakeReport,'docker'),`#!/bin/sh
if [ "$1" = container ] && [ "$2" = ls ]; then [ "$FAIL_CLEANUP" = 1 ] && exit 9; exit 0; fi
for arg in "$@"; do
  case "$arg" in type=bind,source=*,target=/out) out="\${arg#type=bind,source=}"; out="\${out%,target=/out}";; esac
done
printf '%s' "$FAKE_REPORT" > "$out/scan.json"
if [ "$SPAWN_WRITER" = 1 ]; then ( sleep 1; printf alive > "$out/writer.txt" ) >/dev/null 2>&1 & fi
exit 0
`,{mode:0o700})
 const reportBase={SchemaVersion:2,ArtifactName:'/input',ArtifactType:'filesystem',Trivy:{Version:'0.69.0'}}
 await run('scanner-error-field',stagePath,sbomPath,evidencePath,systemRoot,'NOTICE secrets scan failed or was incomplete',{
   PATH:`${fakeReport}:${process.env.PATH}`,FAKE_REPORT:JSON.stringify({...reportBase,Errors:['incomplete']})})
 await run('scanner-secret',stagePath,sbomPath,evidencePath,systemRoot,'NOTICE secrets scan failed or was incomplete',{
   PATH:`${fakeReport}:${process.env.PATH}`,FAKE_REPORT:JSON.stringify({...reportBase,Results:[{Target:'x',Class:'secret',Secrets:[{}]}]})})
 await run('scanner-cleanup',stagePath,sbomPath,evidencePath,systemRoot,'NOTICE scanner cleanup could not be verified',{
   PATH:`${fakeReport}:${process.env.PATH}`,FAKE_REPORT:JSON.stringify(reportBase),FAIL_CLEANUP:'1',SPAWN_WRITER:'1'},indexPath,{},true)
 await new Promise(resolve=>setTimeout(resolve,1300))
 const remainingScan=(await readdir(work)).find(x=>x.startsWith('.aikayun-notice-scan-'))
 if(!remainingScan||await readFile(join(work,remainingScan,'writer.txt'),'utf8')!=='alive')throw new Error('Live scanner output was deleted')
 const originalIndex=await read(indexPath), index=structuredClone(originalIndex);index.manifests.pop()
 await run('bad-index-bytes',stagePath,sbomPath,evidencePath,systemRoot,'Trusted input digest mismatch',{},await write('bad-index.json',index))
 const wrongPlatform=structuredClone(stage), other=originalIndex.manifests.find(x=>x.platform?.os==='linux'&&x.platform?.architecture!==stage.arch)
 if(!other)throw new Error('Index fixture needs another platform');wrongPlatform.platform_manifest_digest=other.digest
 wrongPlatform.image_ref=`ghcr.io/yykx682436/aikayun-staging-api@${wrongPlatform.platform_manifest_digest}`
 await run('wrong-index-platform',await write('wrong-platform.json',wrongPlatform),sbomPath,evidencePath,systemRoot,'OCI staging index rejected')
 await run('wrong-sbom-image',stagePath,sbomPath,evidencePath,systemRoot,'SBOM provenance mismatch',{},indexPath,{local_image_id:`sha256:${'9'.repeat(64)}`})
 const badStage=structuredClone(stage);badStage.binary_sha256='0'.repeat(64)
 await run('bad-stage',await write('bad-stage.json',badStage),sbomPath,evidencePath,systemRoot,'Invalid staging identity')
 process.stdout.write('Passed: offline NOTICE, thirteen evidence/identity/non-Go rejections, and four scanner-failure cases.\n')
} finally { await rm(work,{recursive:true,force:true}) }
