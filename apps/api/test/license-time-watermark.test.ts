import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  advanceTrustedTimeWatermarkFile,
  readTrustedTimeWatermark,
  trustedTimeWatermarkFileName,
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
})
