import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  advanceTrustedTimeWatermarkFile,
  readTrustedTimeWatermark,
  trustedTimeWatermarkFileName,
  trustedTimeWatermarkLockFileName,
} from '../src/licensing/trusted-time-watermark.js'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'aikayun-time-watermark-'))
  roots.add(path)
  await chmod(path, 0o700)
  return path
}

const identity = {
  databaseId: 'd2f8bdb5-546a-4eb0-a0b9-1cd96a30d529',
  instanceId: '602b07da-ec8a-446c-a9f1-83c3894ef7b5',
  identityJkt: Buffer.alloc(32, 9).toString('base64url'),
}

describe('license trusted-time watermark file', () => {
  it('creates atomically and never lowers a valid persisted watermark', async () => {
    const directory = await root()
    expect(await readTrustedTimeWatermark(directory, identity)).toEqual({ status: 'missing' })

    await advanceTrustedTimeWatermarkFile(directory, identity, 1_800_000_000_123)
    await advanceTrustedTimeWatermarkFile(directory, identity, 1_800_000_000_001)
    expect(await readTrustedTimeWatermark(directory, identity)).toMatchObject({
      status: 'valid', record: { ...identity, high_water_ms: 1_800_000_000_123 },
    })
  })

  it('rejects malformed, duplicated-key, and differently bound watermark files', async () => {
    const directory = await root()
    const path = join(directory, trustedTimeWatermarkFileName)
    await writeFile(path, '{"schema":1,"schema":1}\n', { mode: 0o600 })
    expect(await readTrustedTimeWatermark(directory, identity)).toEqual({ status: 'corrupt' })

    await writeFile(path, JSON.stringify({
      schema: 1,
      database_id: identity.databaseId,
      instance_id: identity.instanceId,
      identity_jkt: identity.identityJkt,
      high_water_ms: 1_800_000_000_123,
    }))
    expect(await readTrustedTimeWatermark(directory, {
      ...identity, instanceId: '62690ad2-086b-44cb-b2bd-2b2b235cd083',
    })).toEqual({ status: 'corrupt' })
  })

  it('recovers an orphaned pre-rename file without lowering the committed file', async () => {
    const directory = await root()
    await advanceTrustedTimeWatermarkFile(directory, identity, 1_800_000_000_123)
    const orphan = join(directory, '.license-time-watermark.tmp')
    await writeFile(orphan, 'partial', { mode: 0o600 })

    await advanceTrustedTimeWatermarkFile(directory, identity, 1_800_000_000_234)
    expect(await readFile(orphan).catch(() => null)).toBeNull()
    expect(await readTrustedTimeWatermark(directory, identity)).toMatchObject({
      status: 'valid', record: { high_water_ms: 1_800_000_000_234 },
    })
  })

  it('serializes concurrent in-process writes monotonically without lowering the watermark', async () => {
    const directory = await root()
    const timestamps = [100, 500, 200, 800, 300, 700, 950, 400, 600]
    await Promise.all(timestamps.map(ts => advanceTrustedTimeWatermarkFile(directory, identity, 1_800_000_000_000 + ts)))
    const result = await readTrustedTimeWatermark(directory, identity)
    expect(result).toMatchObject({
      status: 'valid',
      record: { high_water_ms: 1_800_000_000_950 },
    })
  })

  it('serializes concurrent cross-process writes with kernel file lock, avoiding temp file conflict or rollback', async () => {
    const directory = await root()
    const timestamps = [150, 450, 300, 900, 600, 750]
    const childScript = [
      "import { advanceTrustedTimeWatermarkFile } from './src/licensing/trusted-time-watermark.js'",
      "const { WATERMARK_DIR, WATERMARK_DB_ID, WATERMARK_INST_ID, WATERMARK_JKT, WATERMARK_TS } = process.env",
      "await advanceTrustedTimeWatermarkFile(WATERMARK_DIR, { databaseId: WATERMARK_DB_ID, instanceId: WATERMARK_INST_ID, identityJkt: WATERMARK_JKT }, Number(WATERMARK_TS))",
    ].join('\n')

    const children = timestamps.map(ts => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '-e', childScript],
          {
            cwd: join(import.meta.dirname, '..'),
            env: {
              ...process.env,
              WATERMARK_DIR: directory,
              WATERMARK_DB_ID: identity.databaseId,
              WATERMARK_INST_ID: identity.instanceId,
              WATERMARK_JKT: identity.identityJkt,
              WATERMARK_TS: String(1_800_000_000_000 + ts),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stderr = ''
        child.stderr?.on('data', d => { stderr += d.toString() })
        child.on('exit', (code, signal) => {
          if (code === 0 && signal === null) resolve()
          else reject(new Error(`Child process failed (code ${code}, signal ${signal}): ${stderr}`))
        })
        child.on('error', reject)
      })
    })

    await Promise.all(children)

    const final = await readTrustedTimeWatermark(directory, identity)
    expect(final).toMatchObject({
      status: 'valid',
      record: { high_water_ms: 1_800_000_000_900 },
    })
    expect(await readFile(join(directory, '.license-time-watermark.tmp')).catch(() => null)).toBeNull()
  })
})
