import { createServer, type Server } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureFixtureVolume, captureReleaseVolume, type VolumeArchiveTarget } from '../src/backup/volume-archive.js'

let root: string, server: Server, input: VolumeArchiveTarget
const fixture = `aikayun-75a-test-${'a'.repeat(24)}`
const id = 'b'.repeat(64)
async function fakeDocker(mode: 'cleanup' | 'create') {
  const nameFile = join(root, 'container-name')
  const source = `#!${process.execPath}
const fs=require('node:fs'), args=process.argv.slice(4), command=args[0];
const nameFile=${JSON.stringify(nameFile)}, fixture=${JSON.stringify(fixture)}, id=${JSON.stringify(id)}, mode=${JSON.stringify(mode)};
if(command==='volume') process.stdout.write(JSON.stringify([{Name:fixture+'_aikayun_state',Driver:'local',Scope:'local',Options:null,Labels:{'com.aikayun.fixture':fixture}}]));
else if(command==='image') process.stdout.write(JSON.stringify([{Config:{Volumes:{'/var/lib/postgresql':{}}}}]));
else if(command==='create') {if(mode==='create') process.exit(1);fs.writeFileSync(nameFile,args[args.indexOf('--name')+1]);process.stdout.write(id+'\\n')}
else if(command==='inspect') {const n=fs.readFileSync(nameFile,'utf8');process.stdout.write(JSON.stringify([{Id:id,Config:{Image:${JSON.stringify(input.postgresImage)},User:'0:0',Labels:{'com.aikayun.backup.archive':n}},HostConfig:{ReadonlyRootfs:true,NetworkMode:'none',Tmpfs:{'/var/lib/postgresql':'ro,noexec,nosuid'},CapAdd:['CAP_DAC_READ_SEARCH'],CapDrop:['ALL'],SecurityOpt:['no-new-privileges']},Mounts:[{Type:'volume',Name:fixture+'_aikayun_state',Destination:'/snapshot',RW:false}]}]));}
else if(command==='start') process.stdout.write(Buffer.alloc(1024));
else if(command==='ps') {if(mode==='cleanup') process.stdout.write(id.slice(0,12)+'\\n')}
else if(command==='rm') process.exit(1);
else process.exit(2);
`
  await writeFile(input.dockerBinary, source, { mode: 0o700 })
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-volume-uncertain-')))
  const stage = join(root, 'stage'), socket = join(root, 'socket')
  await mkdir(stage, { mode: 0o700 })
  server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  input = { dockerBinary: join(root, 'docker'), dockerSocket: socket, stagingDirectory: stage,
    postgresImage: `docker.io/library/postgres@sha256:${'c'.repeat(64)}`, assertSecureStaging: async () => {} }
})
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})
describe('uncertain volume helper cleanup', () => {
  it('rejects production collection before running Docker until the helper is authenticated', async () => {
    await expect(captureReleaseVolume(input, 'state')).rejects.toThrow('ARCHIVE_HELPER_AUTHENTICATION_UNAVAILABLE')
    await expect(readFile(join(input.stagingDirectory, 'state.tar'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('retains archive bytes if the owned helper cannot be removed', async () => {
    await fakeDocker('cleanup')
    await expect(captureFixtureVolume(input, fixture, 'state')).rejects.toMatchObject({ code: 'ARCHIVE_CONTAINER_CLEANUP_UNVERIFIED' })
    expect((await readFile(join(input.stagingDirectory, 'state.tar'))).length).toBe(1024)
  })
  it('retains the empty owned artifact if create outcome is unknown', async () => {
    await fakeDocker('create')
    await expect(captureFixtureVolume(input, fixture, 'state')).rejects.toMatchObject({ code: 'ARCHIVE_CREATE_UNCERTAIN' })
    expect((await readFile(join(input.stagingDirectory, 'state.tar'))).length).toBe(0)
  })
})
