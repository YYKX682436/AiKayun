import { constants as fsConstants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const allowedModes = new Set([0o700, 0o755])

export async function initializeVolumeDirectory(
  directory: string,
  mode: number,
  ownerUid = 1000,
  ownerGid = 1000,
): Promise<void> {
  if (!isAbsolute(directory) || !allowedModes.has(mode) ||
    !Number.isSafeInteger(ownerUid) || ownerUid < 0 || !Number.isSafeInteger(ownerGid) || ownerGid < 0) {
    throw new Error('VOLUME_INITIALIZATION_ARGUMENT_INVALID')
  }

  await mkdir(directory, { recursive: true, mode })
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isDirectory()) throw new Error('VOLUME_INITIALIZATION_TARGET_INVALID')
    await handle.chown(ownerUid, ownerGid)
    await handle.chmod(mode)
  } finally {
    await handle.close()
  }
}
