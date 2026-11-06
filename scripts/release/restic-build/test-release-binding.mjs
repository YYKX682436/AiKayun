#!/usr/bin/env node
// Uses only locally generated test keys and synthetic image digests.
import { createHash, generateKeyPairSync } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { signReleaseManifest } from '../../../apps/api/scripts/release/manifest.mjs'
const [armDir, amdDir, armSbom, amdSbom] = process.argv.slice(2)
if (!amdSbom) throw new Error('Usage: test-release-binding.mjs ARM_NOTICE AMD_NOTICE ARM_SBOM AMD_SBOM')
const root=dirname(fileURLToPath(import.meta.url)), repo=join(root,'../../..'), work=await mkdtemp(join(tmpdir(),'aikayun-release-binding-test-'))
const sha=b=>createHash('sha256').update(b).digest('hex')
const json=async p=>JSON.parse(await readFile(p,'utf8'))
const writeJson=async(p,x)=>writeFile(p,JSON.stringify(x),{flag:'wx',mode:0o600})
const command=(script,args,expected,label,reason)=>{const r=spawnSync(process.execPath,[script,...args],{timeout:30000,encoding:'utf8'});if(r.error||(r.status===0)!==expected||(reason&&!r.stderr.includes(reason)))throw new Error(`Unexpected ${label} result`)}
try {
 const base=join(work,'base');await mkdir(join(base,'notices'),{recursive:true,mode:0o700});await mkdir(join(base,'sbom'),{mode:0o700})
 for(const [arch,dir,sbom] of [['arm64',armDir,armSbom],['amd64',amdDir,amdSbom]]) {
  for(const n of [`NOTICE-image-api-linux-${arch}.txt`,`NOTICE-restic-licenses-linux-${arch}.txt`,`NOTICE-restic-index-linux-${arch}.txt`,`NOTICE-restic-evidence-linux-${arch}.txt`,`NOTICE-restic-system-linux-${arch}.txt`,`NOTICE-restic-stage-proof-linux-${arch}.txt`,`NOTICE-restic-sbom-proof-linux-${arch}.txt`,`NOTICE-restic-binding-linux-${arch}.txt`,`NOTICE-restic-scan-linux-${arch}.txt`]) await cp(join(dir,n),join(base,'notices',n))
  await cp(sbom,join(base,'sbom',`api-linux-${arch}.cdx.json`))
 }
 const arm=await json(join(base,'notices/NOTICE-restic-binding-linux-arm64.txt')), amd=await json(join(base,'notices/NOTICE-restic-binding-linux-amd64.txt'))
 if(arm.index_digest!==amd.index_digest)throw new Error('Fixture index mismatch')
 const fake='a'.repeat(64), fakeImage=repo=>({reference:`${repo}@sha256:${fake}`,platform_digests:{'linux/amd64':fake,'linux/arm64':fake},sbom_sha256:{'linux/amd64':fake,'linux/arm64':fake}})
 const metadata={version:'1.2.3',built_at:'2026-11-05T00:00:00.000Z',source_commit:'c'.repeat(40),distribution_origin:'https://release.vendor.com',license_center_signer_kids:['B'.repeat(43)],images:{
  api:{reference:`ghcr.io/yykx682436/aikayun-api@${arm.index_digest}`,platform_digests:{'linux/amd64':amd.platform_manifest_digest.slice(7),'linux/arm64':arm.platform_manifest_digest.slice(7)},sbom_sha256:{'linux/amd64':amd.sbom_sha256,'linux/arm64':arm.sbom_sha256}},
  web:fakeImage('ghcr.io/yykx682436/aikayun-web'),postgres:fakeImage('docker.io/library/postgres'),caddy:fakeImage('docker.io/library/caddy')}}
 const migrations=join(work,'migrations.json'), config=join(work,'config.json')
 await writeJson(migrations,{migration_head:'202611040002_file_check_results'})
 await writeJson(config,{trust_configuration_id:'11111111-1111-4111-8111-111111111111',expected_center_issuer:'https://license.vendor.com',offline_root:{kid:'A'.repeat(43)},minimum_bundle_version:'1'})
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}), key=join(work,'test-private.pem'), pub=join(work,'test-public.json')
 await writeFile(key,privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});await writeJson(pub,publicKey.export({format:'jwk'}));const trusted=sha(await readFile(pub))
 async function build(name,mutate) {
  const dir=join(work,name);await cp(base,dir,{recursive:true});const meta=structuredClone(metadata);if(mutate)await mutate(dir,meta)
  const mp=join(work,`${name}-metadata.json`), manifest=join(work,`${name}-manifest.json`), sig=join(work,`${name}-manifest.jws`)
  await writeJson(mp,meta)
  command(join(repo,'apps/api/scripts/release/create-manifest.mjs'),[mp,dir,migrations,config,manifest],true,`${name} manifest`)
  await signReleaseManifest(manifest,sig,key)
  return {dir,manifest,sig}
 }
 const verify=(fixture,a,ok,label,reason,keyHash=trusted)=>command(join(root,'verify-release-binding.mjs'),[fixture.dir,fixture.manifest,fixture.sig,pub,keyHash,a],ok,label,reason)
 const good=await build('good');verify(good,'arm64',true,'arm success');verify(good,'amd64',true,'amd success')
 verify(good,'arm64',false,'wrong pin','Release key pin mismatch','0'.repeat(64))
 const changed=await build('changed');await writeFile(join(changed.dir,'notices/NOTICE-image-api-linux-arm64.txt'),'tampered');verify(changed,'arm64',false,'artifact tamper','invalid signed release evidence')
 const signature=await build('signature');await writeFile(signature.sig,'invalid');verify(signature,'arm64',false,'signature tamper','invalid signed release evidence')
 const binary=await build('binary',async dir=>{const p=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt');const x=await json(p);x.binary_sha256='0'.repeat(64);await writeFile(p,`${JSON.stringify(x)}\n`)});verify(binary,'arm64',false,'binary mismatch','Release image evidence mismatch')
 const child=await build('child',async(_dir,m)=>{m.images.api.platform_digests['linux/arm64']='f'.repeat(64)});verify(child,'arm64',false,'child mismatch','Release image evidence mismatch')
 const missing=await build('missing',async dir=>unlink(join(dir,'notices/NOTICE-restic-licenses-linux-arm64.txt')));verify(missing,'arm64',false,'missing artifact','invalid signed release evidence')
 const scan=await build('scan',async dir=>{const p=join(dir,'notices/NOTICE-restic-scan-linux-arm64.txt');const x=await json(p);x.findings=1;await writeFile(p,`${JSON.stringify(x)}\n`)});verify(scan,'arm64',false,'scan findings','NOTICE secrets evidence mismatch')
 const badSbom=await build('sbom',async dir=>writeFile(join(dir,'sbom/api-linux-arm64.cdx.json'),'{}'));verify(badSbom,'arm64',false,'SBOM mismatch','Release image evidence mismatch')
 const missingFlock=await build('missing-flock',async dir=>{const p=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt');const x=await json(p);x.system_files=x.system_files.filter(f=>f.path!=='doc/util-linux/copyright');await writeFile(p,`${JSON.stringify(x)}\n`)});verify(missingFlock,'arm64',false,'flock evidence','Required runtime license evidence missing')
 const changedNode=await build('changed-node',async dir=>{const p=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt');const x=await json(p);x.system_files.find(f=>f.path==='nodejs/LICENSE').sha256='0'.repeat(64);await writeFile(p,`${JSON.stringify(x)}\n`)});verify(changedNode,'arm64',false,'node evidence','Required runtime license evidence missing')
 const wrongIndex=await build('wrong-index',async(dir,m)=>{const p=join(dir,'notices/NOTICE-restic-index-linux-arm64.txt');const x=await json(p);x.manifests.find(v=>v.platform.architecture==='arm64').platform.architecture='amd64';const bytes=Buffer.from(JSON.stringify(x));await writeFile(p,bytes);const b=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt');const y=await json(b);y.index_digest=`sha256:${sha(bytes)}`;await writeFile(b,`${JSON.stringify(y)}\n`);m.images.api.reference=`ghcr.io/yykx682436/aikayun-api@${y.index_digest}`});verify(wrongIndex,'arm64',false,'index platform mismatch','Release OCI index rejected')
 const wrongSyft=await build('wrong-syft',async dir=>{const p=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt');const x=await json(p);x.syft_image='untrusted';await writeFile(p,`${JSON.stringify(x)}\n`)});verify(wrongSyft,'arm64',false,'Syft identity','Release image evidence mismatch')
 const badProof=await build('bad-proof',async dir=>{const p=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt');const x=await json(p);x.sbom_proof_sha256='invalid';await writeFile(p,`${JSON.stringify(x)}\n`)});verify(badProof,'arm64',false,'SBOM proof','Release image evidence mismatch')
 const alteredGo=await build('altered-go',async dir=>{const p=join(dir,'notices/NOTICE-restic-evidence-linux-arm64.txt');const x=await json(p);x.licenses[0].content+='tampered';await writeFile(p,`${JSON.stringify(x)}\n`)});verify(alteredGo,'arm64',false,'Go evidence','Go license evidence digest mismatch')
 const alteredSystem=await build('altered-system',async dir=>{const p=join(dir,'notices/NOTICE-restic-system-linux-arm64.txt');const x=await json(p);x.files[0].content+='tampered';await writeFile(p,`${JSON.stringify(x)}\n`)});verify(alteredSystem,'arm64',false,'system evidence','Invalid system license text')
 const alteredHuman=await build('altered-human',async dir=>{const p=join(dir,'notices/NOTICE-restic-licenses-linux-arm64.txt');await writeFile(p,'tampered')});verify(alteredHuman,'arm64',false,'human NOTICE','Restic NOTICE does not match license evidence')
 const omittedSystem=await build('omitted-system',async dir=>{const p=join(dir,'notices/NOTICE-image-api-linux-arm64.txt');await writeFile(p,'tampered')});verify(omittedSystem,'arm64',false,'system NOTICE','Original NOTICE omitted system license text')
 const forgedGeneric=await build('forged-generic',async dir=>{const notice=join(dir,'notices/NOTICE-image-api-linux-arm64.txt'),b=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt'),s=join(dir,'notices/NOTICE-restic-scan-linux-arm64.txt');const bytes=Buffer.concat([await readFile(notice),Buffer.from('\nforged\n')]);await writeFile(notice,bytes);const binding=await json(b), rec=binding.artifacts.find(x=>x.name==='NOTICE-image-api-linux-arm64.txt');rec.sha256=sha(bytes);rec.size=bytes.length;await writeFile(b,`${JSON.stringify(binding)}\n`);const scan=await json(s);scan.files.find(x=>x.name==='NOTICE-image-api-linux-arm64.txt').sha256=sha(bytes);scan.files.find(x=>x.name==='NOTICE-restic-binding-linux-arm64.txt').sha256=sha(await readFile(b));await writeFile(s,`${JSON.stringify(scan)}\n`)});verify(forgedGeneric,'arm64',false,'forged generic NOTICE','Original NOTICE differs from verified offline regeneration')
 const forgedProof=await build('forged-proof',async dir=>{const b=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt'),s=join(dir,'notices/NOTICE-restic-scan-linux-arm64.txt');const binding=await json(b);binding.sbom_proof_sha256='e'.repeat(64);await writeFile(b,`${JSON.stringify(binding)}\n`);const scan=await json(s);scan.files.find(x=>x.name==='NOTICE-restic-binding-linux-arm64.txt').sha256=sha(await readFile(b));await writeFile(s,`${JSON.stringify(scan)}\n`)});verify(forgedProof,'arm64',false,'forged SBOM proof','Sanitized build proof mismatch')
 const duplicate=await build('duplicate-binding-key',async dir=>{const p=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt');const raw=await readFile(p,'utf8');await writeFile(p,raw.replace('{','{"schema":"injected",'))});verify(duplicate,'arm64',false,'duplicate JSON field','Noncanonical evidence encoding')
 for (const nested of [false,true]) {
  const forged=await build(`private-evidence-${nested}`,async dir=>{
   const e=join(dir,'notices/NOTICE-restic-evidence-linux-arm64.txt'),b=join(dir,'notices/NOTICE-restic-binding-linux-arm64.txt'),s=join(dir,'notices/NOTICE-restic-scan-linux-arm64.txt')
   const evidence=await json(e);(nested?evidence.licenses[0]:evidence).private_path='/private/non-public-input';const bytes=Buffer.from(`${JSON.stringify(evidence)}\n`);await writeFile(e,bytes)
   const binding=await json(b);binding.license_evidence_sha256=sha(bytes);const record=binding.artifacts.find(x=>x.name==='NOTICE-restic-evidence-linux-arm64.txt');record.sha256=sha(bytes);record.size=bytes.length;await writeFile(b,`${JSON.stringify(binding)}\n`)
   const scan=await json(s);scan.files.find(x=>x.name==='NOTICE-restic-evidence-linux-arm64.txt').sha256=sha(bytes);scan.files.find(x=>x.name==='NOTICE-restic-binding-linux-arm64.txt').sha256=sha(await readFile(b));await writeFile(s,`${JSON.stringify(scan)}\n`)
  });verify(forged,'arm64',false,'extra private evidence field','Unexpected Go license evidence fields')
 }
 process.stdout.write('Passed: real canonical manifest/JWS binding for two arches; twenty-two signed-artifact, key, image, index, license and scan rejection cases.\n')
} finally { await rm(work,{recursive:true,force:true}) }
