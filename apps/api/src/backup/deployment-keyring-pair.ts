import { trustedAncestors } from './restic-local.js'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { readBackupKeyReferences } from './key-references.js'

type References = Awaited<ReturnType<typeof readBackupKeyReferences>>

/** Compare raw deployment keyring bytes against the DB reference evidence. */
export function verifyDeploymentKeyRingBytes(paymentBytes: Buffer, deliveryBytes: Buffer, expected: References): void {
  try {
    validateDeploymentKeyRingBytes(paymentBytes, expected.paymentActiveKeyId, expected.paymentKeyIds, expected.paymentKeyDigests)
    validateDeploymentKeyRingBytes(deliveryBytes, expected.deliveryActiveKeyId, expected.deliveryKeyIds, expected.deliveryKeyDigests)
  } finally { paymentBytes.fill(0); deliveryBytes.fill(0) }
}

function validateDeploymentKeyRingBytes(bytes: Buffer, activeId: string, ids: string[], digests: Record<string, string>): void {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) as unknown } catch { throw new Error('BACKUP_DEPLOYMENT_KEYRING_MISMATCH') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('activeKeyId' in value) || value.activeKeyId !== activeId ||
      !('keys' in value) || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) throw new Error('BACKUP_DEPLOYMENT_KEYRING_MISMATCH')
  const actual = Object.entries(value.keys as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (actual.length !== ids.length || actual.some(([id], index) => id !== ids[index]) || Object.keys(digests).sort().join(',') !== ids.join(',')) {
    throw new Error('BACKUP_DEPLOYMENT_KEYRING_MISMATCH')
  }
  for (const [id, encoded] of actual) {
    if (typeof encoded !== 'string') throw new Error('BACKUP_DEPLOYMENT_KEYRING_MISMATCH')
    const key = Buffer.from(encoded, 'base64')
    try {
      if (key.length !== 32 || key.toString('base64') !== encoded || createHash('sha256').update(key).digest('hex') !== digests[id]) {
        throw new Error('BACKUP_DEPLOYMENT_KEYRING_MISMATCH')
      }
    } finally { key.fill(0) }
  }
}

/** Compare every key in deployment.tar against the ring used for the DB
 * reference check. Key bytes never enter the manifest; fingerprints are stored inside the encrypted set. */
export async function verifyDeploymentArchiveKeyRings(root: string, tarBinary: string, expected: References,
  signal?: AbortSignal): Promise<void> {
  for (const path of [root, tarBinary]) if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('BACKUP_DEPLOYMENT_PAIR_PATH_INVALID')
  const [directory, binary] = await Promise.all([lstat(root), lstat(tarBinary)])
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.() ||
      !binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1 || (binary.mode & 0o022) !== 0 || (binary.mode & 0o111) === 0 ||
      (binary.uid !== 0 && binary.uid !== process.getuid?.())) throw new Error('BACKUP_DEPLOYMENT_PAIR_PATH_INVALID')
  await trustedAncestors(tarBinary)
  const file = await open(join(root, 'deployment.tar'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size < 1024) throw new Error('BACKUP_DEPLOYMENT_ARCHIVE_INVALID')
    async function check(name: string, activeId: string, ids: string[], digests: Record<string, string>) {
      if (signal?.aborted) throw new Error('BACKUP_DEPLOYMENT_PAIR_INTERRUPTED')
      const memberFile = await open(join(root, 'deployment.tar'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await memberFile.stat()
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) {
        await memberFile.close(); throw new Error('BACKUP_DEPLOYMENT_ARCHIVE_CHANGED')
      }
      const child = spawn(tarBinary, ['-xOf', '/dev/fd/3', name], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe', memberFile.fd] })
      let count = 0, invalid = false
      const chunks: Buffer[] = []
      const stop = () => { invalid = true; child.kill('SIGKILL') }
      const timer = setTimeout(stop, 30000)
      signal?.addEventListener('abort', stop, { once: true })
      if (signal?.aborted) stop()
      child.stderr!.resume()
      let bytes: Buffer | undefined
      try {
        bytes = await new Promise<Buffer>((accept, reject) => {
          child.stdout!.on('data', (chunk: Buffer) => { count += chunk.length; if (count > 65536) { stop(); return }; chunks.push(chunk) })
          let errored = false
          child.once('error', () => { errored = true })
          child.once('close', code => code === 0 && !errored && !invalid && count > 0
            ? accept(Buffer.concat(chunks)) : reject(new Error('BACKUP_DEPLOYMENT_KEYRING_MISMATCH')))
        })
        validateDeploymentKeyRingBytes(bytes, activeId, ids, digests)
      } finally {
        bytes?.fill(0); for (const chunk of chunks) chunk.fill(0)
        clearTimeout(timer); signal?.removeEventListener('abort', stop); await memberFile.close()
      }
    }
    await check('secrets/payment_credential_key_ring', expected.paymentActiveKeyId, expected.paymentKeyIds, expected.paymentKeyDigests)
    await check('secrets/code_pool_encryption_key_ring', expected.deliveryActiveKeyId, expected.deliveryKeyIds, expected.deliveryKeyDigests)
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('BACKUP_DEPLOYMENT_ARCHIVE_CHANGED')
  } finally { await file.close() }
}
