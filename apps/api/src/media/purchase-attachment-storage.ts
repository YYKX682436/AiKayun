import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { PURCHASE_FORM_LIMITS } from '@aikayun/contracts'

export const PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES = PURCHASE_FORM_LIMITS.attachmentBytes
export const PURCHASE_ATTACHMENT_REQUEST_LIMIT_BYTES = PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES + 32 * 1024
export const PURCHASE_ATTACHMENT_PIXELS_LIMIT = PURCHASE_FORM_LIMITS.attachmentPixels
const maximumDimension = 8_192
const acceptedInputTypes = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export class PurchaseAttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PurchaseAttachmentError'
  }
}

export interface PreparedPurchaseAttachment {
  bytes: Buffer
  width: number
  height: number
  byteSize: number
  sha256: string
}

export interface PurchaseAttachmentFileInfo {
  path: string
  storageKey: string
  id: string
  sizeBytes: number
  modifiedAt: Date
  location: 'staging' | 'object'
}

let activeDecodes = 0
const decodeWaiters: Array<() => void> = []

async function withDecodeSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeDecodes >= 2) await new Promise<void>(resolveWaiter => decodeWaiters.push(resolveWaiter))
  else activeDecodes += 1
  try { return await operation() } finally {
    const next = decodeWaiters.shift()
    if (next) next()
    else activeDecodes -= 1
  }
}

export async function collectPurchaseImage(input: AsyncIterable<Buffer | Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.length
      if (total > PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES) {
        throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_TOO_LARGE', '图片文件超过单文件容量限制。')
      }
      chunks.push(bytes)
    }
  } catch (error) {
    if (error instanceof PurchaseAttachmentError) throw error
    throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_UPLOAD_INTERRUPTED', '图片上传未完成，请重试。')
  }
  if (!total) throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_EMPTY', '图片文件不能为空。')
  return Buffer.concat(chunks, total)
}

async function preparePurchaseAttachmentBytes(bytes: Buffer, claimedMimeType: string): Promise<PreparedPurchaseAttachment> {
  if (bytes.length < 1 || bytes.length > PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES) {
    throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_TOO_LARGE', '图片文件超过单文件容量限制。')
  }
  const expectedFormat = acceptedInputTypes.get(claimedMimeType.toLowerCase())
  if (!expectedFormat) throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_FORMAT_INVALID', '仅支持 JPEG、PNG 或 WebP 图片。')

  try {
      const decoder = sharp(bytes, {
        failOn: 'error',
        animated: true,
      })
      const metadata = await decoder.metadata()
      if (metadata.format !== expectedFormat) {
        throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_MIME_MISMATCH', '图片实际格式与声明格式不一致。')
      }
      if ((metadata.pages ?? 1) !== 1) {
        throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_MULTIFRAME', '不支持动画或多帧图片。')
      }
      if (!metadata.width || !metadata.height || metadata.width > maximumDimension || metadata.height > maximumDimension
        || metadata.width * metadata.height > PURCHASE_ATTACHMENT_PIXELS_LIMIT) {
        throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_PIXELS_EXCEEDED', '图片像素或边长超过限制。')
      }
      const result = await sharp(bytes, {
        failOn: 'error',
        limitInputPixels: PURCHASE_ATTACHMENT_PIXELS_LIMIT,
        animated: true,
      }).rotate().webp({ quality: 88, effort: 3 }).toBuffer({ resolveWithObject: true })
      if (result.info.format !== 'webp' || (result.info.pages ?? 1) !== 1
        || !result.info.width || !result.info.height
        || result.info.width > maximumDimension || result.info.height > maximumDimension
        || result.info.width * result.info.height > PURCHASE_ATTACHMENT_PIXELS_LIMIT) {
        throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_DECODE_INVALID', '图片无法安全解码。')
      }
      if (result.data.length > PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES) {
        throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_TOO_LARGE', '处理后的图片超过单文件容量限制。')
      }
      return {
        bytes: result.data,
        width: result.info.width,
        height: result.info.height,
        byteSize: result.data.length,
        sha256: createHash('sha256').update(result.data).digest('hex'),
      }
  } catch (error) {
    if (error instanceof PurchaseAttachmentError) throw error
    throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_DECODE_INVALID', '图片已损坏或无法安全解码。')
  }
}

export async function preparePurchaseAttachment(bytes: Buffer, claimedMimeType: string): Promise<PreparedPurchaseAttachment> {
  return withDecodeSlot(() => preparePurchaseAttachmentBytes(bytes, claimedMimeType))
}

export async function processPurchaseImageUpload(
  input: AsyncIterable<Buffer | Uint8Array | string>,
  claimedMimeType: string,
): Promise<PreparedPurchaseAttachment> {
  return withDecodeSlot(async () => {
    const bytes = await collectPurchaseImage(input)
    return preparePurchaseAttachmentBytes(bytes, claimedMimeType)
  })
}

export class PurchaseAttachmentStorage {
  private readonly root: string
  private readonly stagingRoot: string
  private readonly objectsRoot: string

  constructor(privateFileRoot: string) {
    this.root = join(resolve(privateFileRoot), 'purchase-attachments')
    this.stagingRoot = join(this.root, 'staging')
    this.objectsRoot = join(this.root, 'objects')
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
    await mkdir(this.objectsRoot, { recursive: true, mode: 0o700 })
    await chmodDirectory(this.root)
    await chmodDirectory(this.stagingRoot)
    await chmodDirectory(this.objectsRoot)
  }

  storageKey(id: string): string {
    this.assertId(id)
    return `objects/${id.slice(0, 2)}/${id}.webp`
  }

  async store(id: string, bytes: Buffer): Promise<string> {
    this.assertId(id)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    const stagingPath = join(this.stagingRoot, `${id}.part`)
    try {
      // Keep every filesystem preparation step inside the storage boundary.
      // A failure here happens before the database finalization transaction and
      // is therefore a determinate storage failure, not an unknown DB commit.
      await this.ensureReady()
      const storageKey = this.storageKey(id)
      const objectPath = this.resolveObject(storageKey, id)
      const shard = join(this.objectsRoot, id.slice(0, 2))
      await mkdir(shard, { recursive: true, mode: 0o700 })
      await chmodDirectory(shard)
      handle = await open(stagingPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.chmod(0o400)
      await handle.close()
      handle = undefined
      await link(stagingPath, objectPath)
      await unlink(stagingPath)
      const directory = await open(shard, constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
      return storageKey
    } catch {
      if (handle) await handle.close().catch(() => undefined)
      await rm(stagingPath, { force: true }).catch(() => undefined)
      throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_STORAGE_FAILED', '图片暂时无法安全保存，请重试。')
    }
  }

  async readVerified(id: string, storageKey: string, sizeBytes: number, sha256: string): Promise<Buffer> {
    const path = this.resolveObject(storageKey, id)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size !== sizeBytes || metadata.size > PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES) {
        throw new Error('metadata mismatch')
      }
      const bytes = await handle.readFile()
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('digest mismatch')
      return bytes
    } catch {
      throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_UNAVAILABLE', '图片暂时无法读取，请稍后重试。')
    } finally {
      if (handle) await handle.close().catch(() => undefined)
    }
  }

  async remove(id: string, storageKey?: string): Promise<void> {
    this.assertId(id)
    const paths = [join(this.stagingRoot, `${id}.part`)]
    if (storageKey) paths.push(this.resolveObject(storageKey, id))
    else paths.push(this.resolveObject(this.storageKey(id), id))
    for (const path of paths) {
      try { await unlink(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  async scanFiles(): Promise<PurchaseAttachmentFileInfo[]> {
    await this.ensureReady()
    const files: PurchaseAttachmentFileInfo[] = []
    for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) {
      const id = entry.name.endsWith('.part') ? entry.name.slice(0, -5) : ''
      if (!uuidPattern.test(id)) continue
      const path = join(this.stagingRoot, entry.name)
      const metadata = await safeLstat(path)
      if (!metadata) continue
      files.push({ path, storageKey: '', id, sizeBytes: metadata.size, modifiedAt: metadata.mtime, location: 'staging' })
    }
    for (const shardEntry of await readdir(this.objectsRoot, { withFileTypes: true })) {
      if (!shardEntry.isDirectory() || !/^[0-9a-f]{2}$/u.test(shardEntry.name)) continue
      const shardPath = join(this.objectsRoot, shardEntry.name)
      for (const entry of await readdir(shardPath, { withFileTypes: true })) {
        const id = entry.name.endsWith('.webp') ? entry.name.slice(0, -5) : ''
        if (!uuidPattern.test(id) || id.slice(0, 2) !== shardEntry.name) continue
        const path = join(shardPath, entry.name)
        const metadata = await safeLstat(path)
        if (!metadata) continue
        files.push({ path, storageKey: `objects/${shardEntry.name}/${entry.name}`, id, sizeBytes: metadata.size, modifiedAt: metadata.mtime, location: 'object' })
      }
    }
    return files
  }

  async removeScannedFile(path: string): Promise<void> {
    const absolute = resolve(path)
    if (!isWithin(this.root, absolute)) throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_STORAGE_FAILED', 'Attachment cleanup path is invalid')
    try { await unlink(absolute) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private assertId(id: string): void {
    if (!uuidPattern.test(id)) throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_ID_INVALID', 'Attachment identity is invalid')
  }

  private resolveObject(storageKey: string, id: string): string {
    const expected = this.storageKey(id)
    if (storageKey !== expected) throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_STORAGE_FAILED', 'Attachment storage key is invalid')
    const path = resolve(this.root, storageKey)
    if (!isWithin(this.root, path)) throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_STORAGE_FAILED', 'Attachment path is invalid')
    return path
  }
}

async function safeLstat(path: string) {
  try { return await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function chmodDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY)
    await handle.chmod(0o700)
  } catch {
    // mkdir's mode remains the fallback on filesystems that do not allow directory chmod.
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export const PURCHASE_ATTACHMENT_PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  'content-type': 'image/webp',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-site',
} as const
