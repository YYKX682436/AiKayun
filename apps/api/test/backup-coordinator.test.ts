import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMaintenanceJournal, advanceMaintenanceJournal, readMaintenanceJournal } from '../src/backup/journal.js'
import { quiesceAndCapture as captureAndPublish, recoverMaintenance, type QuiesceAdapter } from '../src/backup/coordinator.js'
import { UnsafeMaintenanceRecoveryError } from '../src/backup/maintenance-errors.js'

function quiesceAndCapture<T>(directory: string, snapshot: Parameters<typeof captureAndPublish>[1], adapter: QuiesceAdapter, capture: () => Promise<T>): Promise<T> {
  return captureAndPublish(directory, snapshot, adapter, capture, async value => value)
}

let directory: string
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-backup-coordinator-'))) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

function fixture() {
  const events: string[] = []
  const deployment = 'a'.repeat(64)
  const containers = new Map([['b'.repeat(64), 'running'], ['c'.repeat(64), 'stopped']])
  const roles = new Map([['aikayun_app', true], ['aikayun_migrator', false]])
  let lock = true
  let writersSafe = true
  const input = { deployment, backupSetId: randomUUID(), services: [
    { name: 'api', containerId: 'b'.repeat(64), running: true },
    { name: 'caddy', containerId: 'c'.repeat(64), running: false },
  ], roles: [
    { name: 'aikayun_app' as const, canLogin: true },
    { name: 'aikayun_migrator' as const, canLogin: false },
  ] }
  const adapter: QuiesceAdapter = {
    assertLock: async () => { if (!lock) throw new Error('lock lost') },
    assertDeployment: async expected => { if (expected !== deployment) throw new Error('wrong deployment') },
    assertNoWriters: async () => { events.push('check-writers'); if (!writersSafe) throw new Error('writers present') },
    assertRestorationSafe: async () => {},
    containerState: async id => containers.get(id) as 'running' | 'stopped' | 'unknown' ?? 'unknown',
    stopContainer: async id => { expect((await readMaintenanceJournal(directory))?.phase).toBe('stopping'); events.push('stop'); containers.set(id, 'stopped') },
    startContainer: async id => { expect((await readMaintenanceJournal(directory))?.phase).toBe('restoring'); events.push('start'); containers.set(id, 'running') },
    roleLogin: async name => roles.get(name) ?? null,
    setRoleLogin: async (name, allowed) => { events.push(`${name}:${allowed}`); roles.set(name, allowed) },
  }
  return { adapter, input, events, containers, roles, setLock: (value: boolean) => { lock = value }, setWritersSafe: (value: boolean) => { writersSafe = value } }
}

describe('backup writer coordinator with simulated adapter', () => {
  it('persists intent, disables writers, captures, and restores only original state', async () => {
    const f = fixture()
    const result = await quiesceAndCapture(directory, f.input, f.adapter, async () => {
      expect((await readMaintenanceJournal(directory))?.phase).toBe('stopped')
      expect(f.containers.get('b'.repeat(64))).toBe('stopped')
      expect(f.roles.get('aikayun_app')).toBe(false)
      return 'fixture result'
    })
    expect(result).toBe('fixture result')
    expect(f.events).toEqual(['stop', 'aikayun_app:false', 'check-writers', 'check-writers', 'aikayun_app:true', 'start'])
    expect(await readMaintenanceJournal(directory)).toBeNull()
    expect(JSON.parse(await readFile(join(directory, `backup-maintenance-${f.input.backupSetId}.complete.json`), 'utf8'))).toMatchObject({ phase: 'complete' })
    expect(f.containers.get('c'.repeat(64))).toBe('stopped')
    expect(f.roles.get('aikayun_migrator')).toBe(false)
  })
  it('refuses to capture unsafe writers and restores the original state', async () => {
    const f = fixture()
    f.setWritersSafe(false)
    let captured = false
    await expect(quiesceAndCapture(directory, f.input, f.adapter, async () => { captured = true })).rejects.toThrow()
    expect(captured).toBe(false)
    expect(f.containers.get('b'.repeat(64))).toBe('running')
    expect(f.roles.get('aikayun_app')).toBe(true)
  })
  it('recovers a crash after a stop and role change from the persisted snapshot', async () => {
    const f = fixture()
    const journal = await createMaintenanceJournal(directory, f.input)
    await advanceMaintenanceJournal(directory, journal, 'stopping')
    f.containers.set('b'.repeat(64), 'stopped')
    f.roles.set('aikayun_app', false)
    await recoverMaintenance(directory, f.adapter)
    expect(f.containers.get('b'.repeat(64))).toBe('running')
    expect(f.roles.get('aikayun_app')).toBe(true)
    expect((await readMaintenanceJournal(directory))?.phase).toBe('complete')
  })
  it('refuses unknown identity, unexpected role or missing lock without starting anything', async () => {
    const f = fixture()
    const journal = await createMaintenanceJournal(directory, f.input)
    await advanceMaintenanceJournal(directory, journal, 'stopping')
    f.containers.delete('b'.repeat(64))
    await expect(recoverMaintenance(directory, f.adapter)).rejects.toThrow()
    expect(f.events).not.toContain('start')
    expect((await readMaintenanceJournal(directory))?.phase).not.toBe('complete')
    f.setLock(false)
    await expect(recoverMaintenance(directory, f.adapter)).rejects.toThrow('lock lost')
  })
  it('leaves an incomplete journal when lock is lost during capture, then supports explicit recovery', async () => {
    const f = fixture()
    await expect(quiesceAndCapture(directory, f.input, f.adapter, async () => { f.setLock(false) })).rejects.toThrow('recovery did not complete')
    expect((await readMaintenanceJournal(directory))?.phase).toBe('stopped')
    expect(f.containers.get('b'.repeat(64))).toBe('stopped')
    f.setLock(true)
    await recoverMaintenance(directory, f.adapter)
    expect(f.containers.get('b'.repeat(64))).toBe('running')
    expect((await readMaintenanceJournal(directory))?.phase).toBe('complete')
  })
  it('does not change containers when their initial state disagrees with the snapshot', async () => {
    const f = fixture()
    f.containers.set('b'.repeat(64), 'stopped')
    await expect(quiesceAndCapture(directory, f.input, f.adapter, async () => {})).rejects.toThrow('Original container state changed')
    expect(f.events).not.toContain('start')
    expect((await readMaintenanceJournal(directory))?.phase).toBe('prepared')
  })
  it('inspects actual role after an uncertain commit before restoring it', async () => {
    const f = fixture()
    const original = f.adapter.setRoleLogin
    f.adapter.setRoleLogin = async (name, allowed) => {
      await original(name, allowed)
      if (!allowed) throw new Error('commit result unknown')
    }
    await expect(quiesceAndCapture(directory, f.input, f.adapter, async () => {})).rejects.toThrow('commit result unknown')
    expect(f.roles.get('aikayun_app')).toBe(true)
    expect(f.containers.get('b'.repeat(64))).toBe('running')
    expect((await readMaintenanceJournal(directory))?.phase).toBe('complete')
  })
  it('leaves restoration incomplete when the adapter cannot prove it safe', async () => {
    const f = fixture()
    f.adapter.assertRestorationSafe = async () => { throw new Error('recovery safety unknown') }
    await expect(quiesceAndCapture(directory, f.input, f.adapter, async () => { throw new Error('capture failed') }))
      .rejects.toThrow('recovery did not complete')
    expect((await readMaintenanceJournal(directory))?.phase).toBe('stopped')
    expect(f.containers.get('b'.repeat(64))).toBe('stopped')
    expect(f.roles.get('aikayun_app')).toBe(false)
  })
  it('keeps the fence and never publishes when dump cleanup cannot be verified', async () => {
    const f = fixture()
    let published = false
    await expect(captureAndPublish(directory, f.input, f.adapter,
      async () => { throw new UnsafeMaintenanceRecoveryError('DUMP_CLEANUP_UNVERIFIED') },
      async () => { published = true })).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    expect(published).toBe(false)
    expect((await readMaintenanceJournal(directory))?.phase).toBe('stopped')
    expect(f.containers.get('b'.repeat(64))).toBe('stopped')
    expect(f.roles.get('aikayun_app')).toBe(false)
    expect(f.events).not.toContain('start')
    expect(f.events).not.toContain('aikayun_app:true')
  })
  it('uses a fresh snapshot after a successful backup and same-version container rebuild', async () => {
    const f = fixture()
    await quiesceAndCapture(directory, f.input, f.adapter, async () => 'first')
    f.containers.delete(f.input.services[0]!.containerId)
    const rebuilt = 'd'.repeat(64)
    f.containers.set(rebuilt, 'running')
    const second = { ...f.input, backupSetId: randomUUID(), services: [{ name: 'api', containerId: rebuilt, running: true }] }
    expect(await quiesceAndCapture(directory, second, f.adapter, async () => 'second')).toBe('second')
    expect(f.containers.get(rebuilt)).toBe('running')
    expect(await readMaintenanceJournal(directory)).toBeNull()
  })
  it('leaves publication failures failed and retires their completed maintenance after a deployment change', async () => {
    const f = fixture()
    await expect(captureAndPublish(directory, f.input, f.adapter, async () => 'staged', async () => {
      throw new Error('publication failed')
    })).rejects.toThrow('publication failed')
    const completed = await readMaintenanceJournal(directory)
    expect(completed?.phase).toBe('complete')
    const next = fixture()
    const deployment = 'e'.repeat(64)
    next.adapter.assertDeployment = async expected => { expect(expected).toBe(deployment) }
    expect(await quiesceAndCapture(directory, { ...next.input, deployment }, next.adapter, async () => 'new release')).toBe('new release')
    expect(JSON.parse(await readFile(join(directory, `backup-maintenance-${f.input.backupSetId}.complete.json`), 'utf8'))).toEqual(completed)
    expect(await readMaintenanceJournal(directory)).toBeNull()
  })
  it('publishes only after the writer fence, restoration and complete journal verification', async () => {
    const f = fixture()
    const result = await captureAndPublish(directory, f.input, f.adapter, async () => {
      expect((await readMaintenanceJournal(directory))?.phase).toBe('stopped')
      expect(f.containers.get('b'.repeat(64))).toBe('stopped')
      return 'staged set'
    }, async (staged, journal) => {
      expect(staged).toBe('staged set')
      expect(journal.phase).toBe('complete')
      expect(f.containers.get('b'.repeat(64))).toBe('running')
      expect(f.roles.get('aikayun_app')).toBe(true)
      f.events.push('publish')
      return 'published set'
    })
    expect(result).toBe('published set')
    expect(f.events.at(-1)).toBe('publish')
  })
  it('does not publish when restoration cannot be proven or the lock is lost', async () => {
    const f = fixture()
    let published = false
    f.adapter.assertRestorationSafe = async () => { throw new Error('recovery safety unknown') }
    await expect(captureAndPublish(directory, f.input, f.adapter, async () => 'staged', async () => { published = true }))
      .rejects.toThrow('recovery did not complete')
    expect(published).toBe(false)
    expect((await readMaintenanceJournal(directory))?.phase).toBe('captured')
  })
})
