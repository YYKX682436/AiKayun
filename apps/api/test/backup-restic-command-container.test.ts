import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:net'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResticCommandContainer } from '../src/backup/restic-command-container.js'

const hostOperations = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), spawnFile: vi.fn() }))
vi.mock('../src/backup/host-operations.js', () => ({
  hostDockerExec: hostOperations.exec,
  hostDockerSpawn: hostOperations.spawn,
  hostDockerSpawnFile: hostOperations.spawnFile,
}))

const image = `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'a'.repeat(64)}`
const containerId = 'b'.repeat(64)
const imageId = `sha256:${'c'.repeat(64)}`
const temporary: string[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  hostOperations.exec.mockReset()
  hostOperations.spawn.mockReset()
  hostOperations.spawnFile.mockReset()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aikayun-restic-command-'))
  temporary.push(root)
  const repositoryDirectory = join(root, 'repository'), sourceDirectory = join(root, 'manifest')
  await mkdir(repositoryDirectory, { mode: 0o700 }); await chmod(repositoryDirectory, 0o700)
  await mkdir(sourceDirectory, { mode: 0o700 }); await chmod(sourceDirectory, 0o700)
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
const root=dirname(new URL(import.meta.url).pathname), statePath=join(root,'state.json')
const state=JSON.parse(readFileSync(statePath,'utf8'))
const all=process.argv.slice(2),offset=all[0]==='--host'?2:0,args=all.slice(offset),op=args[0]
const ok=value=>process.stdout.write(JSON.stringify(value))
function inspect() {
  const imageRef=state.createArgs.find(x=>x===${JSON.stringify(image)}), imageIndex=state.createArgs.indexOf(imageRef)
  const command=state.createArgs.slice(imageIndex+1),mounts=[]
  let status=state.started?'exited':'created'
  if(state.started&&state.simulateDelayedExit){const attempt=state.postStartInspects??0;state.postStartInspects=attempt+1;writeFileSync(statePath,JSON.stringify(state));status=attempt===0?'running':'exited'}
  for(let i=0;i<state.createArgs.length;i++) if(state.createArgs[i]==='--mount') {
    const fields=Object.fromEntries(state.createArgs[++i].split(',').map(x=>{const at=x.indexOf('=');return at<0?[x,'true']:[x.slice(0,at),x.slice(at+1)]}))
    mounts.push({Type:'bind',Name:'',Source:fields.source,Destination:fields.target,RW:!Object.hasOwn(fields,'readonly')})
  }
  return {Id:${JSON.stringify(containerId)},Image:${JSON.stringify(imageId)},Path:'/usr/bin/restic',Args:command,
    Config:{Image:imageRef,User:'0:0',Labels:{'com.aikayun.backup.restic-command':'yes','com.aikayun.backup.restic-operation':state.operation}},
    State:{Status:status,ExitCode:0,OOMKilled:false},
    HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:['CAP_DAC_READ_SEARCH'],SecurityOpt:['no-new-privileges:true'],
      Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=64m'},RestartPolicy:{Name:'no'},AutoRemove:false,Privileged:false,
      PidMode:'',IpcMode:'private',Devices:[],Binds:[],VolumesFrom:[]},Mounts:mounts}
}
if(op==='image'&&args[1]==='inspect'){ok([{Id:${JSON.stringify(imageId)}}]);process.exit(0)}
if(op==='ps'){if(state.created&&!state.removed)process.stdout.write(${JSON.stringify(containerId)}+'\\n');process.exit(0)}
if(op==='create'){
  state.created=true;state.started=false;state.removed=false;state.createArgs=args
  state.operation=args.find(x=>x.startsWith('com.aikayun.backup.restic-operation='))?.split('=')[1]
  writeFileSync(statePath,JSON.stringify(state));process.stdout.write(${JSON.stringify(containerId)}+'\\n');process.exit(0)
}
if(op==='inspect'&&args.includes('--type')){ok([inspect()]);process.exit(0)}
if(op==='start'&&args[1]==='--attach'){
  state.started=true;writeFileSync(statePath,JSON.stringify(state));process.stdout.write('restic output\\n');process.exit(state.attachExitCode??0)
}
if(op==='rm'){state.removed=true;writeFileSync(statePath,JSON.stringify(state));process.stdout.write(args.at(-1)+'\\n');process.exit(0)}
process.exit(2)
`
  await writeFile(dockerBinary, script, { mode: 0o700 }); await chmod(dockerBinary, 0o700)
  await writeFile(stateFile, JSON.stringify({ created: false, started: false, removed: false, simulateDelayedExit: false }))
  const target = { dockerBinary, dockerSocket, image, repositoryDirectory, passwordFile, assertLock: async () => {} }
  return { root, repositoryDirectory, sourceDirectory, passwordFile, stateFile, target }
}

describe('Restic repository command container', () => {
  it('verifies the signed image and exact isolated mounts before attaching output', async () => {
    const paths = await fixture()
    const executor = new ResticCommandContainer(paths.target)
    await executor.initialize()
    let streamed = ''
    const result = await executor.execute(['snapshots', '--json'], paths.sourceDirectory, {
      limit: 1024, async write(chunk) { streamed += chunk.toString('utf8') },
    })
    expect(result).toBe('')
    expect(streamed).toBe('restic output\n')
    const state = JSON.parse(await readFile(paths.stateFile, 'utf8')) as { createArgs: string[]; removed: boolean }
    expect(state.removed).toBe(true)
    expect(state.createArgs.join(' ')).toContain(`source=${paths.repositoryDirectory},target=/repo`)
    expect(state.createArgs.join(' ')).toContain(`source=${paths.passwordFile},target=/run/password,readonly`)
    expect(state.createArgs.join(' ')).toContain(`source=${paths.sourceDirectory},target=${paths.sourceDirectory},readonly`)
    expect(state.createArgs.join(' ')).toContain('--network none')
    expect(state.createArgs.join(' ')).toContain('--read-only')
    expect(state.createArgs.join(' ')).toContain('--cap-drop ALL')
    expect(state.createArgs.join(' ')).toContain('--security-opt no-new-privileges:true')
    expect(state.createArgs.join(' ')).not.toContain('/run/docker.sock')
  })

  it('waits briefly for Docker to report the exited Restic state after attach completes', async () => {
    const paths = await fixture()
    const state = JSON.parse(await readFile(paths.stateFile, 'utf8')) as Record<string, unknown>
    state.simulateDelayedExit = true
    await writeFile(paths.stateFile, JSON.stringify(state))
    const executor = new ResticCommandContainer(paths.target)
    await executor.initialize()
    await expect(executor.execute(['check', '--read-data'])).resolves.toBe('restic output\n')
    const finalState = JSON.parse(await readFile(paths.stateFile, 'utf8')) as { removed: boolean; postStartInspects: number }
    expect(finalState.postStartInspects).toBeGreaterThanOrEqual(2)
    expect(finalState.removed).toBe(true)
  })

  it('reports a failed attach separately from an uncertain container state', async () => {
    const paths = await fixture()
    const state = JSON.parse(await readFile(paths.stateFile, 'utf8')) as Record<string, unknown>
    state.attachExitCode = 125
    await writeFile(paths.stateFile, JSON.stringify(state))
    const executor = new ResticCommandContainer(paths.target)
    await executor.initialize()
    await expect(executor.execute(['dump', 'a'.repeat(64), '/sources/state/identity/current/identity.json']))
      .rejects.toThrow('RESTIC_CONTAINER_ATTACH_FAILED')
    const finalState = JSON.parse(await readFile(paths.stateFile, 'utf8')) as { removed: boolean }
    expect(finalState.removed).toBe(true)
  })

  it('preserves the safe sink failure code when the container exited before stream validation', async () => {
    const paths = await fixture()
    const executor = new ResticCommandContainer(paths.target)
    await executor.initialize()
    await expect(executor.execute(['dump', 'a'.repeat(64), '/sources/state/identity/current/identity.json'], undefined, {
      limit: 1024, async write() { throw new Error('fixture stream sink failed') },
    })).rejects.toThrow('RESTIC_CONTAINER_SINK_FAILED')
    const finalState = JSON.parse(await readFile(paths.stateFile, 'utf8')) as { removed: boolean }
    expect(finalState.removed).toBe(true)
  })

  it('uses the bounded database sink size for host broker streaming', async () => {
    const paths = await fixture()
    const outputLimit = 2 * 1024 * 1024
    const output = Buffer.alloc(1_201_707, 0x61)
    const state: { createArgs?: string[]; operation?: string; started: boolean; removed: boolean } = { started: false, removed: false }
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AIKAYUN_BACKUP_HOST_BROKER', 'stdio-v1')
    hostOperations.exec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Id: imageId }])
      if (args[0] === 'ps') return state.removed ? '' : state.createArgs ? `${containerId}\n` : ''
      if (args[0] === 'create') {
        state.createArgs = args
        state.operation = args.find(value => value.startsWith('com.aikayun.backup.restic-operation='))?.split('=')[1]
        return `${containerId}\n`
      }
      if (args[0] === 'inspect' && args.includes('--type') && state.createArgs) {
        const imageIndex = state.createArgs.indexOf(image)
        const mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }> = []
        for (let index = 0; index < state.createArgs.length; index += 1) {
          if (state.createArgs[index] !== '--mount') continue
          const fields = Object.fromEntries(state.createArgs[++index]!.split(',').map(value => {
            const split = value.indexOf('=')
            return split < 0 ? [value, 'true'] : [value.slice(0, split), value.slice(split + 1)]
          }))
          mounts.push({ Type: fields.type!, Source: fields.source!, Destination: fields.target!, RW: !Object.hasOwn(fields, 'readonly') })
        }
        const operation = state.operation!
        return JSON.stringify([{
          Id: containerId, Image: imageId, Path: '/usr/bin/restic', Args: state.createArgs.slice(imageIndex + 1),
          Config: { Image: image, User: '0:0', Labels: { 'com.aikayun.backup.restic-command': 'yes', 'com.aikayun.backup.restic-operation': operation } },
          State: { Status: state.started ? 'exited' : 'created', ExitCode: 0, OOMKilled: false },
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: ['CAP_DAC_READ_SEARCH'],
            SecurityOpt: ['no-new-privileges:true'], Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
            RestartPolicy: { Name: 'no' }, AutoRemove: false, Privileged: false, PidMode: '', IpcMode: 'private',
            Devices: [], Binds: [], VolumesFrom: [] }, Mounts: mounts,
        }])
      }
      if (args[0] === 'rm') { state.removed = true; return '' }
      throw new Error('unexpected host docker call')
    })
    hostOperations.spawn.mockImplementation((_args: string[], options: { maxBytes: number }) => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.kill = () => true
      setImmediate(() => {
        state.started = true
        if (options.maxBytes < output.length) {
          child.emit('error', new Error('BACKUP_HOST_OUTPUT_LIMIT'))
          child.emit('close', null, null)
          return
        }
        child.stdout.end(output)
        child.stderr.end()
        child.emit('close', 0, null)
      })
      return child
    })
    const executor = new ResticCommandContainer(paths.target)
    await executor.initialize()
    let written = 0
    await executor.execute(['dump', 'a'.repeat(64), '/sources/staging/payload/database.dump'], undefined, {
      limit: outputLimit, async write(chunk) { written += chunk.length },
    })
    expect(written).toBe(output.length)
    expect(hostOperations.spawn.mock.calls[0]?.[1]).toMatchObject({ maxBytes: outputLimit })
    expect(state.removed).toBe(true)
  })
})
