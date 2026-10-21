import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PrivateFileError, PrivateFileStorage, newPrivateFileId } from '../src/media/private-file-storage.js'

let root: string
let storage: PrivateFileStorage

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aikayun-private-file-storage-'))
  storage = new PrivateFileStorage(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('private-file filesystem storage', () => {
  it('uses generated paths, persists read-only bytes, and records the streaming SHA-256', async () => {
    const bytes = Buffer.from('The filename never becomes a disk path.\n')
    const id = newPrivateFileId()
    const saved = await storage.storeUpload(id, Readable.from([bytes]), '../../顾客说明.txt')
    const files = await storage.scanGeneratedFiles()
    const file = files.find(candidate => candidate.id === id)

    expect(saved.uploadFilename).toBe('顾客说明.txt')
    expect(file).toBeDefined()
    expect(file!.path).not.toContain('顾客说明.txt')
    expect(file!.path).toContain(`${id}.bin`)
    expect((await lstat(file!.path)).mode & 0o777).toBe(0o400)
    expect(saved.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const opened = await storage.openVerified(id, { sizeBytes: bytes.length, sha256: saved.sha256 })
    try { expect(await readFile(opened.path)).toEqual(bytes) } finally { await opened.handle.close() }
  })

  it('removes partial uploads and rejects a streamed payload over the server size limit', async () => {
    const interruptedId = newPrivateFileId()
    async function* interruptedUpload() {
      yield Buffer.from('partial bytes')
      throw new Error('simulated client disconnect')
    }
    await expect(storage.storeUpload(interruptedId, Readable.from(interruptedUpload()), 'partial.txt'))
      .rejects.toThrow('Private file upload could not be safely persisted')
    expect((await storage.scanGeneratedFiles()).some(file => file.id === interruptedId)).toBe(false)

    const oversizedId = newPrivateFileId()
    const chunk = Buffer.alloc(1024 * 1024, 0x61)
    async function* oversizedUpload() {
      for (let index = 0; index <= 100; index += 1) yield chunk
    }
    await expect(storage.storeUpload(oversizedId, Readable.from(oversizedUpload()), 'large.txt'))
      .rejects.toMatchObject({ code: 'PRIVATE_FILE_TOO_LARGE' })
    expect((await storage.scanGeneratedFiles()).some(file => file.id === oversizedId)).toBe(false)
  }, 30_000)

  it('rejects a symlink substituted for a generated object path', async () => {
    await storage.ensureReady()
    const id = newPrivateFileId()
    const shard = join(root, 'objects', id.slice(0, 2))
    await mkdir(shard, { recursive: true })
    const outside = join(root, 'outside.txt')
    const bytes = Buffer.from('must stay outside the private object namespace')
    await writeFile(outside, bytes)
    const objectPath = join(shard, `${id}.bin`)
    await symlink(outside, objectPath)

    await expect(storage.openVerified(id, {
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })).rejects.toMatchObject({ code: 'PRIVATE_FILE_UNAVAILABLE' })
    expect((await storage.scanGeneratedFiles()).some(file => file.id === id)).toBe(false)
  })

  it('rejects extensions without a server-defined format before writing', async () => {
    const id = randomUUID()
    await expect(storage.storeUpload(id, Readable.from([Buffer.from('payload')]), 'payload.exe'))
      .rejects.toBeInstanceOf(PrivateFileError)
    expect(await storage.scanGeneratedFiles()).toEqual([])
  })
})
