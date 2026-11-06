import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { capturePostgresDump, verifyPostgresDump, type PostgresDumpTarget } from '../src/backup/pg-dump.js'

const containerId = process.env.AIKAYUN_TEST_PG_DUMP_CONTAINER
describe.skipIf(!containerId)('PostgreSQL 18 custom dump in an isolated container', () => {
  let root: string
  let input: PostgresDumpTarget
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-pgdump-')))
    const dockerBinary = await realpath(execFileSync('which', ['docker'], { encoding: 'utf8' }).trim())
    const endpoint = execFileSync(dockerBinary, ['context', 'inspect', execFileSync(dockerBinary, ['context', 'show'], { encoding: 'utf8' }).trim(), '--format', '{{ (index .Endpoints "docker").Host }}'], { encoding: 'utf8' }).trim()
    if (!endpoint.startsWith('unix:///')) throw new Error('Test requires local Docker socket')
    input = { dockerBinary, dockerSocket: await realpath(endpoint.slice(7)), containerId: containerId!,
      database: 'fixture_test', user: 'fixture', stagingDirectory: root, assertSecureStaging: async () => {}, timeoutMs: 10000 }
  })
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it('captures and decodes the custom archive without mutating the source', async () => {
    const result = await capturePostgresDump(input)
    const data = await readFile(join(root, 'database.dump'))
    expect(result).toEqual({ size: data.length, sha256: createHash('sha256').update(data).digest('hex'), pgDumpVersion: expect.stringMatching(/^18\./) })
    expect(data.subarray(0, 5).toString()).toBe('PGDMP')
    await expect(verifyPostgresDump(input)).resolves.toBeUndefined()
    expect(execFileSync(input.dockerBinary, ['--host', `unix://${input.dockerSocket}`, 'exec', '-i', input.containerId,
      'pg_restore', '--file=-'], { input: data, encoding: 'utf8' })).toContain('test-only')
    await expect(capturePostgresDump(input)).rejects.toThrow()
    expect(await readFile(join(root, 'database.dump'))).toEqual(data)
    await writeFile(join(root, 'database.dump'), data.subarray(0, Math.floor(data.length / 2)))
    await expect(verifyPostgresDump(input)).rejects.toThrow()
    await rm(join(root, 'database.dump'))
  }, 30000)

  it('removes incomplete output on failed database connection and interruption', async () => {
    await expect(capturePostgresDump({ ...input, database: 'missing_test' })).rejects.toThrow('DUMP_CLEANUP_UNVERIFIED')
    // Explicit test-only inspection/cleanup after the failing client exited.
    await expect(readFile(join(root, 'database.dump'))).resolves.toBeInstanceOf(Buffer)
    await rm(join(root, 'database.dump'))
    const holder = spawn(input.dockerBinary, ['--host', `unix://${input.dockerSocket}`, 'exec', input.containerId,
      'psql', '-U', input.user, '-d', input.database, '-c', 'BEGIN; LOCK TABLE fixture IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(10);'])
    try {
      await new Promise(resolve => setTimeout(resolve, 500))
      const controller = new AbortController()
      const pending = capturePostgresDump({ ...input, signal: controller.signal })
      let waiting = false
      for (let i = 0; i < 30 && !waiting; i++) {
        const state = execFileSync(input.dockerBinary, ['--host', `unix://${input.dockerSocket}`, 'exec', input.containerId,
          'psql', '-U', input.user, '-d', input.database, '-Atc', "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%' AND wait_event_type = 'Lock'"], { encoding: 'utf8' })
        waiting = Number(state.trim()) > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(waiting).toBe(true)
      controller.abort()
      await expect(pending).rejects.toThrow('DUMP_INTERRUPTED')
      const remaining = execFileSync(input.dockerBinary, ['--host', `unix://${input.dockerSocket}`, 'exec', input.containerId,
        'psql', '-U', input.user, '-d', input.database, '-Atc', "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'aikayun_backup_%'"], { encoding: 'utf8' })
      expect(Number(remaining.trim())).toBe(0)
      await expect(readFile(join(root, 'database.dump'))).rejects.toThrow()
    } finally { holder.kill('SIGKILL') }
  }, 30000)
})
