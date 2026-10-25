import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES, PurchaseAttachmentError } from './purchase-attachment-storage.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export interface PurchaseOrderAttachmentFileInfo {
  id: string
  path: string
  storageKey: string
  modifiedAt: Date
  location: 'staging' | 'object'
}

function inside(root: string, path: string): boolean {
  const remainder = relative(root, path)
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

export class PurchaseOrderAttachmentStorage {
  private readonly root: string
  private readonly stagingRoot: string
  private readonly objectsRoot: string

  constructor(privateFileRoot: string) {
    this.root = join(resolve(privateFileRoot), 'purchase-order-attachments')
    this.stagingRoot = join(this.root, 'staging')
    this.objectsRoot = join(this.root, 'order-objects')
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
    await mkdir(this.objectsRoot, { recursive: true, mode: 0o700 })
    for (const path of [this.root, this.stagingRoot, this.objectsRoot]) {
      const handle = await open(path, constants.O_RDONLY)
      try { await handle.chmod(0o700) } finally { await handle.close() }
    }
    // Persist each new namespace directory entry before recording a prepared
    // object in PostgreSQL. A later file fsync alone cannot persist its parent.
    await syncDirectory(resolve(this.root, '..'))
    await syncDirectory(this.root)
    await syncDirectory(this.stagingRoot)
    await syncDirectory(this.objectsRoot)
  }

  storageKey(id: string): string {
    this.assertId(id)
    return `order-objects/${id.slice(0, 2)}/${id}.webp`
  }

  async store(id: string, bytes: Buffer, expectedSha256: string): Promise<string> {
    this.assertId(id)
    if (!/^[0-9a-f]{64}$/u.test(expectedSha256) || bytes.length < 1 || bytes.length > PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES
      || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
      throw new PurchaseAttachmentError('PURCHASE_ORDER_ATTACHMENT_INVALID', '成交图片校验失败。')
    }
    await this.ensureReady()
    const storageKey = this.storageKey(id)
    const destination = this.resolveObject(id, storageKey)
    const shard = join(this.objectsRoot, id.slice(0, 2))
    const staging = join(this.stagingRoot, `${id}.part`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      await mkdir(shard, { recursive: true, mode: 0o700 })
      await syncDirectory(this.objectsRoot)
      handle = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.chmod(0o400)
      await handle.close()
      handle = undefined
      await link(staging, destination)
      await unlink(staging)
      await syncDirectory(shard)
      await this.readVerified(id, storageKey, bytes.length, expectedSha256)
      return storageKey
    } catch {
      if (handle) await handle.close().catch(() => undefined)
      await rm(staging, { force: true }).catch(() => undefined)
      throw new PurchaseAttachmentError('PURCHASE_ORDER_ATTACHMENT_STORAGE_FAILED', '成交图片暂时无法安全归档。')
    }
  }

  async readVerified(id: string, storageKey: string, byteSize: number, sha256: string): Promise<Buffer> {
    const path = this.resolveObject(id, storageKey)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== byteSize || byteSize < 1 || byteSize > PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES) {
        throw new Error('size mismatch')
      }
      const bytes = await handle.readFile()
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('digest mismatch')
      return bytes
    } catch {
      throw new PurchaseAttachmentError('PURCHASE_ORDER_ATTACHMENT_UNAVAILABLE', '成交图片暂时无法读取。')
    } finally {
      if (handle) await handle.close().catch(() => undefined)
    }
  }

  async remove(id: string, storageKey: string): Promise<void> {
    const paths = [join(this.stagingRoot, `${id}.part`), this.resolveObject(id, storageKey)]
    for (const path of paths) {
      try { await unlink(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  async scanFiles(): Promise<PurchaseOrderAttachmentFileInfo[]> {
    await this.ensureReady()
    const files: PurchaseOrderAttachmentFileInfo[] = []
    for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) {
      const id = entry.name.endsWith('.part') ? entry.name.slice(0, -5) : ''
      if (!uuidPattern.test(id)) continue
      const path = join(this.stagingRoot, entry.name)
      const stat = await lstat(path)
      files.push({ id, path, storageKey: '', modifiedAt: stat.mtime, location: 'staging' })
    }
    for (const shard of await readdir(this.objectsRoot, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/u.test(shard.name)) continue
      for (const entry of await readdir(join(this.objectsRoot, shard.name), { withFileTypes: true })) {
        const id = entry.name.endsWith('.webp') ? entry.name.slice(0, -5) : ''
        if (!uuidPattern.test(id) || id.slice(0, 2) !== shard.name) continue
        const path = join(this.objectsRoot, shard.name, entry.name)
        const stat = await lstat(path)
        files.push({ id, path, storageKey: this.storageKey(id), modifiedAt: stat.mtime, location: 'object' })
      }
    }
    return files
  }

  async removeScannedFile(path: string): Promise<void> {
    const absolute = resolve(path)
    if (!inside(this.root, absolute)) throw new PurchaseAttachmentError('PURCHASE_ORDER_ATTACHMENT_STORAGE_FAILED', '成交图片清理路径无效。')
    try { await unlink(absolute) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private assertId(id: string): void {
    if (!uuidPattern.test(id)) throw new PurchaseAttachmentError('PURCHASE_ORDER_ATTACHMENT_ID_INVALID', '成交图片身份无效。')
  }

  private resolveObject(id: string, storageKey: string): string {
    if (storageKey !== this.storageKey(id)) {
      throw new PurchaseAttachmentError('PURCHASE_ORDER_ATTACHMENT_STORAGE_FAILED', '成交图片路径无效。')
    }
    const path = resolve(this.root, storageKey)
    if (!inside(this.root, path)) throw new PurchaseAttachmentError('PURCHASE_ORDER_ATTACHMENT_STORAGE_FAILED', '成交图片路径无效。')
    return path
  }
}
