import { trustedAncestors } from './restic-local.js'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { readBackupDatabaseMetadata } from './database-metadata.js'
import { verifyStateIdentityFiles } from './state-identity-validation.js'

type Metadata = Awaited<ReturnType<typeof readBackupDatabaseMetadata>>

/** Reads only two bounded members from an already private state tar; it does
 * not extract files to disk and never returns pending key material. */
export async function verifyStateArchivePair(stagingDirectory: string, tarBinary: string, metadata: Metadata,
  identityFileSha256: string, signal?: AbortSignal): Promise<void> {
  await inspectStateArchivePair(stagingDirectory, tarBinary, metadata, identityFileSha256, signal)
}

/** The fixed, read-only state volume was captured while fenced. Derive the
 * identity file digest from that same archive, then validate its identity key
 * and Pending Key against the database; no application-UID files are opened. */
export async function inspectCapturedStateArchivePair(stagingDirectory: string, tarBinary: string, metadata: Metadata,
  signal?: AbortSignal): Promise<{ identityFileSha256: string }> {
  const identityFileSha256 = await inspectStateArchivePair(stagingDirectory, tarBinary, metadata, undefined, signal)
  return { identityFileSha256 }
}

async function inspectStateArchivePair(stagingDirectory: string, tarBinary: string, metadata: Metadata,
  expectedIdentitySha256?: string, signal?: AbortSignal): Promise<string> {
  for (const path of [stagingDirectory, tarBinary]) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('BACKUP_ARCHIVE_PAIR_PATH_INVALID')
  }
  const [directory, binary] = await Promise.all([lstat(stagingDirectory), lstat(tarBinary)])
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.() ||
      !binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1 || (binary.mode & 0o022) !== 0 || (binary.mode & 0o111) === 0 ||
      (binary.uid !== 0 && binary.uid !== process.getuid?.()) || (expectedIdentitySha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedIdentitySha256))) throw new Error('BACKUP_ARCHIVE_PAIR_PATH_INVALID')
  await trustedAncestors(tarBinary)
  const file = await open(join(stagingDirectory, 'state.tar'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size < 1024) throw new Error('BACKUP_STATE_ARCHIVE_INVALID')
    async function member(name: string, max: number): Promise<Buffer> {
      if (signal?.aborted) throw new Error('BACKUP_ARCHIVE_PAIR_INTERRUPTED')
      const memberFile = await open(join(stagingDirectory, 'state.tar'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const memberStat = await memberFile.stat()
      if (!memberStat.isFile() || memberStat.dev !== before.dev || memberStat.ino !== before.ino || memberStat.size !== before.size) {
        await memberFile.close()
        throw new Error('BACKUP_STATE_ARCHIVE_CHANGED')
      }
      const child = spawn(tarBinary, ['-xOf', '/dev/fd/3', name], { env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'pipe', memberFile.fd] })
      const chunks: Buffer[] = []
      let count = 0
      let invalid = false
      const stop = () => { invalid = true; child.kill('SIGKILL') }
      const timer = setTimeout(stop, 30000)
      signal?.addEventListener('abort', stop, { once: true })
      if (signal?.aborted) stop()
      child.stderr!.resume()
      try {
        return await new Promise<Buffer>((accept, reject) => {
          child.stdout!.on('data', (chunk: Buffer) => {
            count += chunk.length
            if (count > max) { stop(); return }
            chunks.push(chunk)
          })
          let errored = false
          child.once('error', () => { errored = true })
          child.once('close', code => code === 0 && !errored && !invalid && count > 0
            ? accept(Buffer.concat(chunks)) : reject(new Error('BACKUP_STATE_ARCHIVE_MEMBER_INVALID')))
        })
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); await memberFile.close() }
    }
    const identity = await member('./identity/current/identity.json', 16384)
    const intent = await member('./identity/current/identity-intent.json', 16384)
    const privateBytes = await member('./identity/current/instance-private-key.pk8.pem', 16384)
    const keyBytes = await member('./license-pending/license-pending-aes-256-gcm.json', 4096)
    let identityFileSha256: string
    try {
      identityFileSha256 = await verifyStateIdentityFiles({ identity, intent, privateKey: privateBytes, pendingKey: keyBytes, metadata,
        ...(expectedIdentitySha256 !== undefined ? { expectedIdentitySha256 } : {}) })
    } finally { identity.fill(0); intent.fill(0); privateBytes.fill(0); keyBytes.fill(0) }
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('BACKUP_STATE_ARCHIVE_CHANGED')
    return identityFileSha256
  } finally { await file.close() }
}
