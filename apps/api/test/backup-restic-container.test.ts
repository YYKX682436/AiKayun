import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectResticVolumeReader } from '../src/backup/restic-container.js'

const image = `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'a'.repeat(64)}`
const containerId = 'b'.repeat(64)
const imageId = `sha256:${'c'.repeat(64)}`
const temporary: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aikayun-restic-container-'))
  temporary.push(root)
  const repositoryDirectory = join(root, 'repository'), deploymentRoot = join(root, 'deployment'), stagingDirectory = join(root, 'stage')
  await mkdir(repositoryDirectory, { mode: 0o700 }); await chmod(repositoryDirectory, 0o700)
  await mkdir(deploymentRoot, { mode: 0o700 }); await chmod(deploymentRoot, 0o700)
  await mkdir(join(stagingDirectory, 'payload'), { recursive: true, mode: 0o700 })
  await chmod(stagingDirectory, 0o700); await chmod(join(stagingDirectory, 'payload'), 0o700)
  const passwordFile = join(root, 'password')
  await writeFile(passwordFile, 'synthetic password\n', { mode: 0o600 })
  const dockerSocket = join(root, 'docker.sock')
  const server = createServer()
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(dockerSocket, resolve))
  servers.push(server)
  const stateFile = join(root, 'state.json')
  const dockerBinary = join(root, 'docker.mjs')
  const script = `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const root = dirname(new URL(import.meta.url).pathname)
const statePath = join(root, 'state.json')
const state = readFileSync(statePath, 'utf8') ? JSON.parse(readFileSync(statePath, 'utf8')) : { created: false, started: false, removed: false }
const all = process.argv.slice(2)
const offset = all[0] === '--host' ? 2 : 0
const args = all.slice(offset), op = args[0]
const ok = value => process.stdout.write(JSON.stringify(value))
  const volume = name => name === 'aikayun_state'
  ? {Name:name,Driver:'local',Scope:'local',Labels:{'com.aikayun.managed-by':'aikayun-7-3'},Options:null}
  : name === 'aikayun_caddy_data'
    ? {Name:name,Driver:'local',Scope:'local',Labels:{'com.docker.compose.volume':'caddy_data','com.docker.compose.project':'aikayun'},Options:null}
      : {Name:name,Driver:'local',Scope:'local',Labels:{'com.docker.compose.volume':'caddy_config','com.docker.compose.project':'aikayun'},Options:null}
if (op === 'image' && args[1] === 'inspect') { ok([{Id:${JSON.stringify(imageId)}}]); process.exit(0) }
if (op === 'volume' && args[1] === 'inspect') { ok([volume(args[2])]); process.exit(0) }
if (op === 'create') {
  state.created = true; state.createArgs = args; state.set = args.find(x => x.startsWith('com.aikayun.backup.restic-set='))?.split('=')[1]
  writeFileSync(statePath, JSON.stringify(state)); process.stdout.write(${JSON.stringify(containerId)}+'\\n'); process.exit(0)
}
if (op === 'inspect' && args.includes('--format')) {
  const imageRef = state.createArgs.find(x => x.startsWith('ghcr.io/'))
  const imageIndex = state.createArgs.indexOf(imageRef)
  const command = state.createArgs.slice(imageIndex + 1)
  const mounts = []
  for (let i=0;i<state.createArgs.length;i++) if(state.createArgs[i]==='--mount') {
    const fields=Object.fromEntries(state.createArgs[++i].split(',').map(x=>{const at=x.indexOf('=');return at<0?[x,'true']:[x.slice(0,at),x.slice(at+1)]}))
    mounts.push({Type:fields.type,Name:fields.source,Source:fields.source,Destination:fields.target,RW:!Object.hasOwn(fields,'readonly')})
  }
  const columns=[${JSON.stringify(containerId)},${JSON.stringify(imageId)},imageRef,'0:0',{'com.aikayun.backup.restic-set':state.set},'/usr/bin/restic',command,'created','none',true,['ALL'],['CAP_DAC_READ_SEARCH'],['no-new-privileges:true'],{'/tmp':'rw,noexec,nosuid,nodev,size=64m'},'no',false,false,'','',[],[],[],mounts]
  process.stdout.write(columns.map(x=>JSON.stringify(x)).join('\\t')+'\\n'); process.exit(0)
}
if (op === 'start' && args[1] === '--attach') {
  state.started=true; writeFileSync(statePath,JSON.stringify(state))
  process.stdout.write(JSON.stringify({message_type:'summary',snapshot_id:'d'.repeat(64)})+'\\n'); process.exit(0)
}
if (op === 'inspect') { ok([{Id:${JSON.stringify(containerId)},Image:${JSON.stringify(imageId)},Config:{Labels:{'com.aikayun.backup.restic-set':state.set}},State:{Status:'exited',ExitCode:0,OOMKilled:false}}]); process.exit(0) }
if (op === 'rm') { state.removed=true; writeFileSync(statePath,JSON.stringify(state)); process.stdout.write(args[args.length-1]+'\\n'); process.exit(0) }
if (op === 'ps') { if(state.created&&!state.removed) process.stdout.write(${JSON.stringify(containerId)}+'\\n'); process.exit(0) }
process.exit(2)
`
  await writeFile(dockerBinary, script, { mode: 0o700 }); await chmod(dockerBinary, 0o700)
  await writeFile(stateFile, JSON.stringify({ created:false, started:false, removed:false, set:'123e4567-e89b-42d3-a456-426614174000' }))
  return { root, dockerBinary, dockerSocket, repositoryDirectory, deploymentRoot, stagingDirectory, passwordFile, stateFile }
}

describe('direct Restic volume reader container profile', () => {
  it('runs the fixed source capture with no socket mount and verifies the container before start', async () => {
    const paths = await fixture()
    const reader = await DirectResticVolumeReader.create({
      ...paths,
      image,
      backupSetId: '123e4567-e89b-42d3-a456-426614174000',
      assertLock: async () => {},
    })
    await expect(reader.backup()).resolves.toEqual({ snapshotId: 'd'.repeat(64) })
    const state = JSON.parse(await readFile(paths.stateFile, 'utf8')) as { createArgs: string[]; started: boolean; removed: boolean }
    expect(state.started).toBe(true)
    expect(state.removed).toBe(true)
    expect(state.createArgs.join(' ')).not.toContain('/run/docker.sock')
    expect(state.createArgs.join(' ')).toContain('target=/sources/state,readonly')
    expect(state.createArgs.join(' ')).toContain('target=/sources/caddy-data,readonly')
    expect(state.createArgs.join(' ')).toContain('target=/sources/caddy-config,readonly')
    expect(state.createArgs.join(' ')).toContain('target=/sources/staging,readonly')
    expect(state.createArgs.join(' ')).toContain(`source=${paths.stagingDirectory},target=/sources/staging,readonly`)
    expect(state.createArgs.join(' ')).toContain('target=/sources/deployment,readonly')
    expect(state.createArgs).toContain('aikayun-role-source')
    expect(state.createArgs.join(' ')).toContain('--network none')
    expect(state.createArgs.join(' ')).toContain('--read-only')
    expect(state.createArgs.join(' ')).toContain('--cap-drop ALL')
    expect(state.createArgs.join(' ')).toContain('--cap-add DAC_READ_SEARCH')
  })
})
