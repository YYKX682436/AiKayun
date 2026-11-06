import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('forwards SIGTERM to the internal operation and emits only a sanitized error', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-helper-signal-')))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const entry = join(root, 'helper.mjs')
    await build({ entryPoints: [join(process.cwd(), 'src/backup/helper-cli.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'isolated-operation', setup(builder) {
        builder.onResolve({ filter: /\.\/fixed-(runtime|inspection|recovery|initialization)\.js$/ }, args => ({ path: args.path, namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path.includes('runtime')
          ? `export async function runFixedProductionBackup(signal, onStarted) { await onStarted('12345678-1234-4234-8234-123456789abc'); process.stdout.write('READY\\n'); return new Promise((_, reject) => { const timer = setInterval(() => {}, 1000); signal.addEventListener('abort', () => { clearInterval(timer); reject(new Error('private-fixture-secret')) }, { once: true }) }) }`
          : args.path.includes('inspection') ? `export async function runFixedProductionInspection() { throw new Error('unexpected') }` : args.path.includes('recovery') ? `export async function runFixedMaintenanceRecovery() { throw new Error('unexpected') }` : `export async function runFixedRepositoryInitialization() { throw new Error('unexpected') }` }))
      } }] })
    child = spawn(process.execPath, [entry, 'create'], { env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout!.on('data', chunk => { stdout += String(chunk) })
    child.stderr!.on('data', chunk => { stderr += String(chunk) })
    const exit = once(child, 'exit')
    await Promise.race([new Promise<void>(resolve => {
      const ready = () => { if (stdout.includes('READY\n')) { child!.stdout!.off('data', ready); resolve() } }
      child!.stdout!.on('data', ready); ready()
    }), once(child, 'exit').then(() => { throw new Error('helper exited early') }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('helper readiness timeout')), 10000).unref())])
    child.kill('SIGTERM')
    const [code, signal] = await exit
    expect(code).toBe(130); expect(signal).toBeNull()
    expect(stdout).toBe('{"operation":"create","backupSetId":"12345678-1234-4234-8234-123456789abc","status":"started"}\nREADY\n')
    expect(stderr).toBe('BACKUP_OPERATION_INTERRUPTED\n')
    expect(stderr).not.toContain('private-fixture-secret')
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('does not begin capture when the caller closes the set-ID output pipe', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-helper-pipe-')))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const entry = join(root, 'helper.mjs'), marker = join(root, 'capture-started')
    await build({ entryPoints: [join(process.cwd(), 'src/backup/helper-cli.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'isolated-operation', setup(builder) {
        builder.onResolve({ filter: /\.\/fixed-(runtime|inspection|recovery|initialization)\.js$/ }, args => ({ path: args.path, namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path.includes('runtime')
          ? `import { writeFile } from 'node:fs/promises'; export async function runFixedProductionBackup(_signal, onStarted) { await new Promise(r => setTimeout(r, 200)); await onStarted('12345678-1234-4234-8234-123456789abc'); await writeFile(${JSON.stringify(marker)}, 'unsafe'); throw new Error('unexpected') }`
          : args.path.includes('inspection') ? `export async function runFixedProductionInspection() { throw new Error('unexpected') }` : args.path.includes('recovery') ? `export async function runFixedMaintenanceRecovery() { throw new Error('unexpected') }` : `export async function runFixedRepositoryInitialization() { throw new Error('unexpected') }` }))
      } }] })
    child = spawn(process.execPath, [entry, 'create'], { env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.destroy()
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr += String(chunk) })
    const [code] = await Promise.race([once(child, 'exit'), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('helper timeout')), 10000).unref())])
    expect([1, 130]).toContain(code)
    expect(stderr).toMatch(/^BACKUP_OPERATION_(?:FAILED|INTERRUPTED)\n$/)
    await expect(import('node:fs/promises').then(fs => fs.stat(marker))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('closes a failed host RPC helper even while the Docker stdin pipe remains open', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-helper-rpc-close-')))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const entry = join(root, 'helper.mjs')
    const hostOperations = join(process.cwd(), 'src/backup/host-operations.ts')
    await build({ entryPoints: [join(process.cwd(), 'src/backup/helper-cli.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'isolated-operation', setup(builder) {
        builder.onResolve({ filter: /\.\/fixed-(runtime|inspection|recovery|initialization)\.js$/ }, args => ({ path: args.path, namespace: 'fixture' }))
        builder.onResolve({ filter: /^host-operations-fixture$/ }, () => ({ path: hostOperations, namespace: 'file' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path.includes('initialization')
          ? `import { hostOperation } from 'host-operations-fixture'; export async function runFixedRepositoryInitialization() { await hostOperation('assert-lock'); throw new Error('BACKUP_REPOSITORY_INIT_UNCERTAIN') }`
          : args.path.includes('runtime') ? `export async function runFixedProductionBackup() { throw new Error('unexpected') }`
            : args.path.includes('inspection') ? `export async function runFixedProductionInspection() { throw new Error('unexpected') }`
              : `export async function runFixedMaintenanceRecovery() { throw new Error('unexpected')}` }))
      } }] })
    child = spawn(process.execPath, [entry, 'initialize-repository'], {
      env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production', AIKAYUN_BACKUP_HOST_BROKER: 'stdio-v1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', replied = false
    child.stdout!.on('data', chunk => {
      stdout += String(chunk)
      if (!replied && stdout.includes('REQ\t1\tassert-lock\n')) {
        replied = true
        child!.stdin!.write('RES\t1\tOK\t\n')
      }
    })
    child.stderr!.on('data', chunk => { stderr += String(chunk) })
    const [code, signal] = await Promise.race([once(child, 'exit'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('helper retained its host RPC stdin')), 5000).unref())])
    expect(replied).toBe(true)
    expect(code).toBe(1); expect(signal).toBeNull()
    expect(stdout).toBe('REQ\t1\tassert-lock\n')
    expect(stderr).toBe('BACKUP_REPOSITORY_INIT_UNCERTAIN\n')
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
