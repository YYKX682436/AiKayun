import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import type { ProductMediaVariantName } from '../db/types.js'
import { CatalogError } from '../catalog/errors.js'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_BYTES + 32 * 1024
export const MAX_INPUT_PIXELS = 24_000_000
export const MEDIA_PROCESSING_VERSION = 'webp-v1'

const variants: Array<{
  name: ProductMediaVariantName
  width: number
  height: number
  quality: number
}> = [
  { name: 'thumbnail', width: 320, height: 320, quality: 78 },
  { name: 'card', width: 960, height: 960, quality: 82 },
  { name: 'detail', width: 1920, height: 1920, quality: 86 },
]

const inputFormats: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export interface StoredMediaVariant {
  mediaId: string
  variant: ProductMediaVariantName
  storageKey: string
  width: number
  height: number
  sizeBytes: number
  sha256: string
  processingVersion: string
}

export interface PublishedMedia {
  id: string
  variants: StoredMediaVariant[]
}

export interface UploadImageInput {
  bytes: Buffer
  mimeType: string
}

export function storageKeyFor(mediaId: string, variant: ProductMediaVariantName): string {
  return `objects/${mediaId.slice(0, 2)}/${mediaId}-${variant}.webp`
}

function insideRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

function imageError(code: string, message: string, status = 400): CatalogError {
  return new CatalogError(status, code, message)
}

function knownInputMime(mimeType: string): string | undefined {
  const clean = mimeType.split(';', 1)[0]?.trim().toLowerCase()
  return clean ? inputFormats[clean] : undefined
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class MediaStorage {
  readonly root: string

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('Media storage root must be absolute')
    this.root = resolve(root)
  }

  private pathForStorageKey(storageKey: string): string {
    if (!/^objects\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(thumbnail|card|detail)\.webp$/.test(storageKey)) {
      throw new Error('Stored media key does not match the generated object layout')
    }
    const path = resolve(this.root, storageKey)
    if (!insideRoot(this.root, path)) throw new Error('Stored media key escaped the storage root')
    return path
  }

  private async ensureDirectories(mediaId: string): Promise<void> {
    const objectsDir = resolve(this.root, 'objects')
    const shardDir = resolve(objectsDir, mediaId.slice(0, 2))
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Media storage root is not a regular directory')
    const stagingDir = resolve(this.root, '.staging')
    await mkdir(stagingDir, { recursive: true, mode: 0o700 })
    const stagingInfo = await lstat(stagingDir)
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) throw new Error('Media staging path is not a regular directory')
    await mkdir(objectsDir, { recursive: true, mode: 0o700 })
    const objectsInfo = await lstat(objectsDir)
    if (!objectsInfo.isDirectory() || objectsInfo.isSymbolicLink()) throw new Error('Media objects path is not a regular directory')
    await mkdir(shardDir, { recursive: true, mode: 0o700 })
    const shardInfo = await lstat(shardDir)
    if (!shardInfo.isDirectory() || shardInfo.isSymbolicLink()) throw new Error('Media shard path is not a regular directory')
  }

  private async assertExistingObjectDirectories(mediaId: string): Promise<void> {
    for (const directory of [
      this.root,
      resolve(this.root, 'objects'),
      resolve(this.root, 'objects', mediaId.slice(0, 2)),
    ]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Media object path contains an invalid directory')
    }
  }

  async publishImage(input: UploadImageInput): Promise<PublishedMedia> {
    if (input.bytes.length === 0) throw imageError('INVALID_IMAGE', 'The uploaded image is empty')
    if (input.bytes.length > MAX_UPLOAD_BYTES) throw imageError('IMAGE_TOO_LARGE', 'Images must be 10 MB or smaller', 413)
    const expectedFormat = knownInputMime(input.mimeType)
    if (!expectedFormat) throw imageError('UNSUPPORTED_IMAGE_FORMAT', 'Upload a JPEG, PNG, or WebP image')

    const metadata = await sharp(input.bytes, {
        failOn: 'warning',
        limitInputPixels: MAX_INPUT_PIXELS,
        pages: 1,
        animated: false,
      }).metadata().catch(() => {
        throw imageError('INVALID_IMAGE', 'The uploaded file is not a valid supported image')
      })
    if (metadata.format !== expectedFormat) {
      throw imageError('IMAGE_MIME_MISMATCH', 'The uploaded image content does not match its declared media type')
    }
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) {
      throw imageError('UNSUPPORTED_IMAGE_FORMAT', 'Animated or unsupported image formats are not accepted')
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
      throw imageError('IMAGE_DIMENSIONS_EXCEEDED', 'The image may not exceed 24 megapixels')
    }

    const id = randomUUID()
    const staged: Array<{ path: string; variant: StoredMediaVariant }> = []
    const published: string[] = []
    try {
      await this.ensureDirectories(id)
      for (const output of variants) {
        const result = await sharp(input.bytes, {
            failOn: 'warning',
            limitInputPixels: MAX_INPUT_PIXELS,
            pages: 1,
            animated: false,
          })
            .rotate()
            .resize(output.width, output.height, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: output.quality, effort: 4, smartSubsample: true })
            .toBuffer({ resolveWithObject: true }).catch(() => {
              throw imageError('IMAGE_PROCESSING_FAILED', 'The image could not be safely decoded and processed')
            })
        if (result.info.format !== 'webp' || !result.info.width || !result.info.height
          || result.data.length === 0 || result.data.length > 20 * 1024 * 1024) {
          throw imageError('IMAGE_PROCESSING_FAILED', 'The processed image is outside supported output bounds')
        }
        const stageName = `.staging/upload-${id}-${output.name}-${randomUUID()}.tmp`
        const stagePath = resolve(this.root, stageName)
        if (!insideRoot(this.root, stagePath)) throw new Error('Temporary media path escaped the storage root')
        staged.push({
          path: stagePath,
          variant: {
            mediaId: id,
            variant: output.name,
            storageKey: storageKeyFor(id, output.name),
            width: result.info.width,
            height: result.info.height,
            sizeBytes: result.data.length,
            sha256: createHash('sha256').update(result.data).digest('hex'),
            processingVersion: MEDIA_PROCESSING_VERSION,
          },
        })
        await writeFile(stagePath, result.data, { flag: 'wx', mode: 0o600 })
        await syncPath(stagePath)
      }

      for (const file of staged) {
        const destination = this.pathForStorageKey(file.variant.storageKey)
        await link(file.path, destination)
        published.push(destination)
      }
      await syncPath(resolve(this.root, 'objects', id.slice(0, 2)))
      for (const file of staged) await unlink(file.path)
      await syncPath(resolve(this.root, '.staging'))
      return { id, variants: staged.map((file) => file.variant) }
    } catch (error) {
      await Promise.allSettled(staged.map((file) => unlink(file.path)))
      await Promise.allSettled(published.map((path) => unlink(path)))
      throw error
    }
  }

  async removePublished(mediaId: string, variant: ProductMediaVariantName, storageKey: string): Promise<void> {
    if (storageKey !== storageKeyFor(mediaId, variant)) throw new Error('Stored media key does not match its media identity')
    await this.assertExistingObjectDirectories(mediaId)
    const path = this.pathForStorageKey(storageKey)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Stored media object is not a regular file')
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async openForRead(mediaId: string, variant: ProductMediaVariantName, storageKey: string, expectedSize: number) {
    if (storageKey !== storageKeyFor(mediaId, variant)) throw new Error('Stored media key does not match its media identity')
    await this.assertExistingObjectDirectories(mediaId)
    const path = this.pathForStorageKey(storageKey)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedSize) {
      throw new Error('Stored media object is missing or does not match its metadata')
    }
    return { stream: createReadStream(path), info: await stat(path) }
  }

  async scanGeneratedFiles(): Promise<Array<{ storageKey: string; path: string; mtimeMs: number; staged: boolean }>> {
    const found: Array<{ storageKey: string; path: string; mtimeMs: number; staged: boolean }> = []
    const objectsRoot = resolve(this.root, 'objects')
    try {
      const objectsInfo = await lstat(objectsRoot)
      if (!objectsInfo.isDirectory() || objectsInfo.isSymbolicLink()) return found
      const shards = await readdir(objectsRoot, { withFileTypes: true })
      for (const shard of shards) {
        if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[0-9a-f]{2}$/.test(shard.name)) continue
        const shardPath = resolve(objectsRoot, shard.name)
        const children = await readdir(shardPath, { withFileTypes: true })
        for (const child of children) {
          const storageKey = `objects/${shard.name}/${child.name}`
          if (!child.isFile() || child.isSymbolicLink()) continue
          try {
            const path = this.pathForStorageKey(storageKey)
            const info = await lstat(path)
            if (info.isFile() && !info.isSymbolicLink()) found.push({ storageKey, path, mtimeMs: info.mtimeMs, staged: false })
          } catch {
            // Files outside the generated naming convention are never touched.
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const stagingRoot = resolve(this.root, '.staging')
    try {
      const stagingInfo = await lstat(stagingRoot)
      if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) return found
      const children = await readdir(stagingRoot, { withFileTypes: true })
      for (const child of children) {
        if (!child.isFile() || child.isSymbolicLink()
          || !/^upload-[0-9a-f-]{36}-(thumbnail|card|detail)-[0-9a-f-]{36}\.tmp$/.test(child.name)) continue
        const path = resolve(stagingRoot, child.name)
        const info = await lstat(path)
        if (info.isFile() && !info.isSymbolicLink()) found.push({ storageKey: `.staging/${child.name}`, path, mtimeMs: info.mtimeMs, staged: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return found
  }
}

export function imageMimeForStoredFormat(format: string): string {
  if (format !== 'webp') throw new Error('Unsupported persisted media format')
  return 'image/webp'
}
