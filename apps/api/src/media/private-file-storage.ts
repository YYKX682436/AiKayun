import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { createReadStream } from 'node:fs'
import { chmod, link, lstat, mkdir, open, realpath, readdir, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import sharp from 'sharp'

export const PRIVATE_FILE_MAX_UPLOAD_BYTES = 100 * 1024 * 1024
export const PRIVATE_FILE_MAX_REQUEST_BYTES = PRIVATE_FILE_MAX_UPLOAD_BYTES + 128 * 1024
export const PRIVATE_FILE_STAGE_TTL_MS = 24 * 60 * 60 * 1000

export type PrivateFileFormat = 'zip' | 'pdf' | 'txt' | 'md' | 'csv' | 'json' | 'png' | 'jpeg' | 'webp' | 'gif' | 'mp3' | 'mp4'

const formats: Record<PrivateFileFormat, { mediaType: string; extensions: string[] }> = {
  zip: { mediaType: 'application/zip', extensions: ['zip'] },
  pdf: { mediaType: 'application/pdf', extensions: ['pdf'] },
  txt: { mediaType: 'text/plain; charset=utf-8', extensions: ['txt'] },
  md: { mediaType: 'text/markdown; charset=utf-8', extensions: ['md', 'markdown'] },
  csv: { mediaType: 'text/csv; charset=utf-8', extensions: ['csv'] },
  json: { mediaType: 'application/json; charset=utf-8', extensions: ['json'] },
  png: { mediaType: 'image/png', extensions: ['png'] },
  jpeg: { mediaType: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  webp: { mediaType: 'image/webp', extensions: ['webp'] },
  gif: { mediaType: 'image/gif', extensions: ['gif'] },
  mp3: { mediaType: 'audio/mpeg', extensions: ['mp3'] },
  mp4: { mediaType: 'video/mp4', extensions: ['mp4'] },
}

const formatByExtension = new Map(Object.entries(formats).flatMap(([format, value]) =>
  value.extensions.map(extension => [extension, format as PrivateFileFormat] as const)))
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export class PrivateFileError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = 'PrivateFileError'
  }
}

export interface PrivateFileObjectMetadata {
  id: string
  mediaType: string
  format: PrivateFileFormat
  sizeBytes: number
  sha256: string
}

export interface PrivateFileUploadResult extends PrivateFileObjectMetadata {
  uploadFilename: string
}

export function sanitizeUploadFilename(value: string): string {
  const basename = value.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const normalized = [...basename.normalize('NFC')]
    .filter(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f)
    .join('').trim()
  if (!normalized || [...normalized].length > 255 || normalized === '.' || normalized === '..') {
    throw new PrivateFileError('PRIVATE_FILE_NAME_INVALID', '文件名不能为空且不能超过 255 个字符。')
  }
  return normalized
}

export function normalizeDisplayFilename(value: string, mediaType: string): string {
  const filename = sanitizeUploadFilename(value)
  const extension = filename.includes('.') ? filename.split('.').at(-1)?.toLowerCase() : undefined
  const format = extension ? formatByExtension.get(extension) : undefined
  const canonical = Object.entries(formats).find(([, item]) => item.mediaType === mediaType)?.[0] as PrivateFileFormat | undefined
  if (!canonical) throw new PrivateFileError('PRIVATE_FILE_FORMAT_UNSUPPORTED', '文件格式不受支持。')
  if (format && format !== canonical) {
    throw new PrivateFileError('PRIVATE_FILE_NAME_FORMAT_MISMATCH', '展示文件名的扩展名必须与文件实际格式一致。')
  }
  if (format) return filename
  const extensionToAppend = formats[canonical].extensions[0]
  return `${filename}.${extensionToAppend}`
}

function insideRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath !== '' && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0))
  try { await handle.sync() } finally { await handle.close() }
}

function isTextFormat(format: PrivateFileFormat): boolean {
  return format === 'txt' || format === 'md' || format === 'csv' || format === 'json'
}

function validateZipHeader(sizeBytes: number, tail: Buffer): boolean {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const position = tail.lastIndexOf(signature)
  if (position < 0 || position + 22 > tail.length) return false
  const disk = tail.readUInt16LE(position + 4)
  const centralDisk = tail.readUInt16LE(position + 6)
  const entriesOnDisk = tail.readUInt16LE(position + 8)
  const totalEntries = tail.readUInt16LE(position + 10)
  const centralSize = tail.readUInt32LE(position + 12)
  const centralOffset = tail.readUInt32LE(position + 16)
  const commentLength = tail.readUInt16LE(position + 20)
  const absoluteEnd = sizeBytes - tail.length + position + 22 + commentLength
  return disk === 0 && centralDisk === 0 && entriesOnDisk === totalEntries
    && centralSize !== 0xffff_ffff && centralOffset !== 0xffff_ffff
    && centralOffset + centralSize <= sizeBytes - tail.length + position
    && absoluteEnd === sizeBytes
}

async function validateUtf8Text(path: string): Promise<boolean> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for await (const chunk of createReadStream(path)) {
      const text = decoder.decode(chunk as Buffer, { stream: true })
      if (text.includes('\u0000')) return false
    }
    decoder.decode()
    return true
  } catch {
    return false
  }
}

async function validateRasterImage(path: string): Promise<boolean> {
  const options = { failOn: 'warning' as const, limitInputPixels: 16_000_000, pages: 1, animated: false }
  try {
    const metadata = await sharp(path, options).metadata()
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 16_000_000) return false
    await sharp(path, options).stats()
    return true
  } catch {
    return false
  }
}

export class PrivateFileStorage {
  readonly root: string
  private canonicalRoot: string | null = null

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('Private file storage root must be absolute')
    this.root = resolve(root)
  }

  private assertId(id: string): void {
    if (!uuidPattern.test(id)) throw new Error('Private file identity is invalid')
  }

  private objectPath(id: string): string {
    this.assertId(id)
    return resolve(this.canonicalRoot ?? this.root, 'objects', id.slice(0, 2), `${id}.bin`)
  }

  private stagingPath(id: string): string {
    this.assertId(id)
    return resolve(this.canonicalRoot ?? this.root, '.staging', `${id}.part`)
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('Private file storage root is not a regular directory')
    }
    await chmod(this.root, 0o700)
    const canonical = await realpath(this.root)
    const staging = resolve(canonical, '.staging')
    const objects = resolve(canonical, 'objects')
    await mkdir(staging, { recursive: true, mode: 0o700 })
    await mkdir(objects, { recursive: true, mode: 0o700 })
    for (const directory of [staging, objects]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private file storage contains an invalid directory')
      await chmod(directory, 0o700)
    }
    this.canonicalRoot = canonical
  }

  private async ensureObjectDirectory(id: string): Promise<string> {
    await this.ensureReady()
    this.assertId(id)
    const objects = resolve(this.canonicalRoot!, 'objects')
    const shard = resolve(objects, id.slice(0, 2))
    await mkdir(shard, { recursive: true, mode: 0o700 })
    for (const directory of [this.canonicalRoot!, objects, shard]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private file object path contains an invalid directory')
      await chmod(directory, 0o700)
      const canonicalDirectory = resolve(await realpath(directory))
      if (canonicalDirectory !== this.canonicalRoot && !insideRoot(this.canonicalRoot!, canonicalDirectory)) {
        throw new Error('Private file object path escaped its storage root')
      }
    }
    return shard
  }

  async assertObjectAvailable(id: string, expected: { sizeBytes: number }): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      await this.ensureObjectDirectory(id)
      const path = this.objectPath(id)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new PrivateFileError('PRIVATE_FILE_UNAVAILABLE', '文件暂不可用，请稍后重试。', 410)
      }
      if (info.size !== expected.sizeBytes) {
        throw new PrivateFileError('PRIVATE_FILE_INTEGRITY_FAILED', '文件完整性校验失败。', 410)
      }
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const openedInfo = await handle.stat()
      const resolvedPath = await realpath(path)
      if (!openedInfo.isFile() || !insideRoot(this.canonicalRoot!, resolvedPath)
        || resolve(resolvedPath) !== resolve(path) || openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) {
        throw new PrivateFileError('PRIVATE_FILE_UNAVAILABLE', '文件暂不可用，请稍后重试。', 410)
      }
      const finalInfo = await handle.stat()
      if (finalInfo.size !== expected.sizeBytes || finalInfo.dev !== openedInfo.dev || finalInfo.ino !== openedInfo.ino) {
        throw new PrivateFileError('PRIVATE_FILE_INTEGRITY_FAILED', '文件完整性校验失败。', 410)
      }
    } catch (error) {
      if (error instanceof PrivateFileError) throw error
      throw new PrivateFileError('PRIVATE_FILE_UNAVAILABLE', '文件暂不可用，请稍后重试。', 410)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async storeUpload(id: string, source: Readable, uploadFilename: string): Promise<PrivateFileUploadResult> {
    const cleanFilename = sanitizeUploadFilename(uploadFilename)
    const extension = cleanFilename.includes('.') ? cleanFilename.split('.').at(-1)?.toLowerCase() : undefined
    const expectedFormat = extension ? formatByExtension.get(extension) : undefined
    if (!expectedFormat) {
      throw new PrivateFileError('PRIVATE_FILE_FORMAT_UNSUPPORTED', '支持 ZIP、PDF、UTF-8 文本、常用图片、MP3 和 MP4 文件。')
    }
    await this.ensureObjectDirectory(id)
    const tempPath = this.stagingPath(id)
    const finalPath = this.objectPath(id)
    let tempHandle: Awaited<ReturnType<typeof open>> | undefined
    let linked = false
    const hash = createHash('sha256')
    let sizeBytes = 0
    let prefix = Buffer.alloc(0)
    let tail = Buffer.alloc(0)
    const transform = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        sizeBytes += chunk.length
        if (sizeBytes > PRIVATE_FILE_MAX_UPLOAD_BYTES) {
          callback(new PrivateFileError('PRIVATE_FILE_TOO_LARGE', '数字商品文件不能超过 100 MiB。', 413))
          return
        }
        hash.update(chunk)
        if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)])
        tail = Buffer.concat([tail, chunk]).subarray(-65_557)
        callback(null, chunk)
      },
    })
    try {
      tempHandle = await open(tempPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
      const destination = tempHandle.createWriteStream({ autoClose: false })
      await pipeline(source, transform, destination)
      if (sizeBytes < 1) {
        destination.destroy()
        throw new PrivateFileError('PRIVATE_FILE_EMPTY', '不能上传空文件。')
      }
      await tempHandle.sync()
      destination.destroy()
      await tempHandle.close()
      tempHandle = undefined

      let detectedFormat: PrivateFileFormat | undefined
      if (expectedFormat === 'zip') {
        if (prefix.subarray(0, 4).toString('hex') === '504b0304' || prefix.subarray(0, 4).toString('hex') === '504b0506') {
          if (validateZipHeader(sizeBytes, tail)) detectedFormat = 'zip'
        }
      } else if (expectedFormat === 'pdf') {
        const headerOk = prefix.subarray(0, 5).toString('ascii') === '%PDF-'
        const end = tail.toString('latin1').match(/startxref\s+\d+\s+%%EOF\s*$/u)
        if (headerOk && end) detectedFormat = 'pdf'
      } else if (isTextFormat(expectedFormat)) {
        if (await validateUtf8Text(tempPath)) detectedFormat = expectedFormat
      } else if (expectedFormat === 'jpeg') {
        if (prefix[0] === 0xff && prefix[1] === 0xd8 && tail.at(-2) === 0xff && tail.at(-1) === 0xd9
          && await validateRasterImage(tempPath)) detectedFormat = 'jpeg'
      } else if (expectedFormat === 'png') {
        const pngEnd = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
        if (prefix.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && tail.subarray(-12).equals(pngEnd)
          && await validateRasterImage(tempPath)) detectedFormat = 'png'
      } else if (expectedFormat === 'webp') {
        if (prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP'
          && prefix.readUInt32LE(4) + 8 === sizeBytes && await validateRasterImage(tempPath)) detectedFormat = 'webp'
      } else if (expectedFormat === 'gif') {
        const header = prefix.subarray(0, 6).toString('ascii')
        if ((header === 'GIF87a' || header === 'GIF89a') && tail.at(-1) === 0x3b
          && await validateRasterImage(tempPath)) detectedFormat = 'gif'
      } else if (expectedFormat === 'mp3') {
        const hasId3 = prefix.subarray(0, 3).toString('ascii') === 'ID3'
        const hasFrame = prefix.length > 1 && prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0
        if (hasId3 || hasFrame) detectedFormat = 'mp3'
      } else if (expectedFormat === 'mp4') {
        if (prefix.subarray(4, 8).toString('ascii') === 'ftyp' && sizeBytes >= 12) detectedFormat = 'mp4'
      }
      if (!detectedFormat || detectedFormat !== expectedFormat) {
        throw new PrivateFileError('PRIVATE_FILE_CONTENT_INVALID', '文件内容损坏，或与文件扩展名不一致。')
      }

      await chmod(tempPath, 0o400)
      const readonlyHandle = await open(tempPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try { await readonlyHandle.sync() } finally { await readonlyHandle.close() }
      await link(tempPath, finalPath)
      linked = true
      await syncDirectory(resolve(this.canonicalRoot!, 'objects', id.slice(0, 2)))
      await unlink(tempPath)
      await syncDirectory(resolve(this.canonicalRoot!, '.staging'))
      return {
        id,
        mediaType: formats[detectedFormat].mediaType,
        format: detectedFormat,
        sizeBytes,
        sha256: hash.digest('hex'),
        uploadFilename: cleanFilename,
      }
    } catch (error) {
      await tempHandle?.close().catch(() => undefined)
      await unlink(tempPath).catch(() => undefined)
      if (linked) await unlink(finalPath).catch(() => undefined)
      if (error instanceof PrivateFileError) throw error
      if (errnoCode(error) === 'EEXIST') throw new Error('Generated private file identity already exists', { cause: error })
      throw new Error('Private file upload could not be safely persisted', { cause: error })
    }
  }

  async openVerified(id: string, expected: { sizeBytes: number; sha256: string }) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const shard = await this.ensureObjectDirectory(id)
      const path = this.objectPath(id)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new PrivateFileError('PRIVATE_FILE_UNAVAILABLE', '文件暂不可用，请稍后重试。', 410)
      }
      if (info.size !== expected.sizeBytes) {
        throw new PrivateFileError('PRIVATE_FILE_INTEGRITY_FAILED', '文件完整性校验失败。', 410)
      }
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const openedInfo = await handle.stat()
      const resolvedPath = await realpath(path)
      if (!openedInfo.isFile() || openedInfo.size !== expected.sizeBytes
        || !insideRoot(this.canonicalRoot!, resolvedPath) || resolve(resolvedPath) !== resolve(path)
        || openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) {
        throw new PrivateFileError('PRIVATE_FILE_UNAVAILABLE', '文件暂不可用，请稍后重试。', 410)
      }
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let position = 0
      while (position < expected.sizeBytes) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.sizeBytes - position), position)
        if (!bytesRead) throw new PrivateFileError('PRIVATE_FILE_INTEGRITY_FAILED', '文件完整性校验失败。', 410)
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
      if (hash.digest('hex') !== expected.sha256) {
        throw new PrivateFileError('PRIVATE_FILE_INTEGRITY_FAILED', '文件完整性校验失败。', 410)
      }
      const finalInfo = await handle.stat()
      if (finalInfo.size !== expected.sizeBytes || finalInfo.dev !== openedInfo.dev || finalInfo.ino !== openedInfo.ino) {
        throw new PrivateFileError('PRIVATE_FILE_INTEGRITY_FAILED', '文件完整性校验失败。', 410)
      }
      return { handle, info: finalInfo, path, shard }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (error instanceof PrivateFileError) throw error
      throw new PrivateFileError('PRIVATE_FILE_UNAVAILABLE', '文件暂不可用，请稍后重试。', 410)
    }
  }

  async removeObject(id: string): Promise<void> {
    await this.ensureObjectDirectory(id)
    const path = this.objectPath(id)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Private file object is not a regular file')
      await unlink(path)
      await syncDirectory(resolve(this.canonicalRoot!, 'objects', id.slice(0, 2)))
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error
    }
  }

  async removeStaging(id: string): Promise<void> {
    await this.ensureReady()
    const path = this.stagingPath(id)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Private staging object is not a regular file')
      await unlink(path)
      await syncDirectory(resolve(this.canonicalRoot!, '.staging'))
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error
    }
  }

  async scanGeneratedFiles(): Promise<Array<{ id: string; path: string; mtimeMs: number; staged: boolean }>> {
    await this.ensureReady()
    const found: Array<{ id: string; path: string; mtimeMs: number; staged: boolean }> = []
    const objectsRoot = resolve(this.canonicalRoot!, 'objects')
    for (const shard of await readdir(objectsRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (errnoCode(error) === 'ENOENT') return []
      throw error
    })) {
      if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[0-9a-f]{2}$/u.test(shard.name)) continue
      const shardPath = resolve(objectsRoot, shard.name)
      for (const child of await readdir(shardPath, { withFileTypes: true })) {
        const match = child.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.bin$/u)
        if (!match || !child.isFile() || child.isSymbolicLink() || match[1]!.slice(0, 2) !== shard.name) continue
        const path = resolve(shardPath, child.name)
        const info = await lstat(path)
        if (info.isFile() && !info.isSymbolicLink()) found.push({ id: match[1]!, path, mtimeMs: info.mtimeMs, staged: false })
      }
    }
    const stagingRoot = resolve(this.canonicalRoot!, '.staging')
    for (const child of await readdir(stagingRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (errnoCode(error) === 'ENOENT') return []
      throw error
    })) {
      const match = child.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.part$/u)
      if (!match || !child.isFile() || child.isSymbolicLink()) continue
      const path = resolve(stagingRoot, child.name)
      const info = await lstat(path)
      if (info.isFile() && !info.isSymbolicLink()) found.push({ id: match[1]!, path, mtimeMs: info.mtimeMs, staged: true })
    }
    return found
  }
}

export function newPrivateFileId(): string {
  return randomUUID()
}
