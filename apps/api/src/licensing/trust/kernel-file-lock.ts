import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * An OS file-description lock is shared by all API processes that use this
 * directory, including containers sharing a local volume. The helper only
 * obtains the lock; the API retains the inherited file description until it
 * closes the handle. Kernel cleanup releases it on SIGKILL.
 */
export async function acquireKernelFileLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, '.trust-bundle.kernel-lock')
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const metadata = await handle.stat()
    const pathMetadata = await lstat(path)
    if (!metadata.isFile() || !pathMetadata.isFile() || pathMetadata.isSymbolicLink() ||
      metadata.ino !== pathMetadata.ino || metadata.dev !== pathMetadata.dev || metadata.nlink !== 1 ||
      (metadata.mode & 0o7777) !== 0o600 || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
      throw new Error('Trust bundle kernel lock is damaged')
    }
    const command = process.platform === 'darwin' ? 'python3' : 'flock'
    const args = process.platform === 'darwin'
      ? ['-c', 'import fcntl; fcntl.flock(3, fcntl.LOCK_EX)']
      : ['-x', '3']
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore', handle.fd] })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0 && signal === null) resolve()
        else reject(new Error('Trust bundle kernel lock acquisition failed'))
      })
    })
    const lockedPath = await lstat(path)
    const lockedFile = await handle.stat()
    if (!lockedPath.isFile() || lockedPath.isSymbolicLink() || lockedPath.ino !== lockedFile.ino ||
      lockedPath.dev !== lockedFile.dev || lockedFile.nlink !== 1) {
      throw new Error('Trust bundle kernel lock changed while waiting')
    }
    return async () => { await handle.close() }
  } catch (error) {
    await handle.close()
    throw error
  }
}
