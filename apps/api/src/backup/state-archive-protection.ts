import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Parser, type ReadEntry } from 'tar'
import { isValidStateVolumeMarker } from './state-volume-marker.js'

export interface StateArchiveTrustStoreFiles {
  state: Buffer | null
  checkpoint: Buffer | null
}

/** Stream archive headers; do not extract or disclose their contents. The
 * protected paths must have the same owner and modes as the application UID's
 * identity and Pending Key readers. Hardlinks anywhere into these files fail. */
export async function verifyStateArchiveProtection(directory: string, applicationUid: number, requireVolumeLayout = false,
  applicationGid = applicationUid, collectTrustStore = false): Promise<StateArchiveTrustStoreFiles | void> {
  if (!Number.isSafeInteger(applicationUid) || applicationUid < 1 || !Number.isSafeInteger(applicationGid) || applicationGid < 0) throw new Error('BACKUP_STATE_OWNER_INVALID')
  const file = await open(join(directory, 'state.tar'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size < 1024) throw new Error('BACKUP_STATE_ARCHIVE_INVALID')
    const required = new Map<string, 'Directory' | 'File'>([
      ['identity', 'Directory'], ['identity/current', 'Directory'],
      ['identity/current/identity.json', 'File'], ['identity/current/identity-intent.json', 'File'],
      ['identity/current/instance-private-key.pk8.pem', 'File'], ['license-pending', 'Directory'],
      ['license-pending/license-pending-aes-256-gcm.json', 'File'],
    ])
    if (requireVolumeLayout) {
      required.set('.aikayun-volume-v1', 'File')
      for (const name of ['media', 'private-files', 'license-trust']) required.set(name, 'Directory')
    }
    const seen = new Set<string>()
    const trustFiles = new Map<string, Buffer>()
    const trustStoreNames = new Set(['license-trust/trust-bundle-state.json', 'license-trust/trust-bundle-store.marker.json'])
    let invalid = false
    let count = 0
    function canonical(name: string): string | null {
      if (name.startsWith('/') || name.includes('\0') || name.split('/').includes('..')) return null
      const path = posix.normalize(name).replace(/\/$/, '')
      return path === '.' ? '' : path
    }
    const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024, onReadEntry(entry: ReadEntry) {
      if (++count > 2_000_000) invalid = true
      const name = canonical(entry.path)
      const link = entry.type === 'Link' ? canonical(entry.linkpath ?? '') : ''
      if (name === null || link === null || (link && (required.has(link) || trustStoreNames.has(link)))) invalid = true
      if (name !== null && required.has(name)) {
        const kind = required.get(name)!
        const marker = name === '.aikayun-volume-v1'
        if (seen.has(name) || entry.type !== kind || entry.uid !== (marker ? 0 : applicationUid) ||
            (requireVolumeLayout && entry.gid !== (marker ? 0 : applicationGid)) ||
            entry.mode === undefined || (entry.mode & 0o7777) !== (marker ? 0o400 : kind === 'Directory' ? 0o700 : 0o600)) invalid = true
        if (marker) {
          const markerChunks: Buffer[] = []
          let markerSize = 0
          entry.on('data', (chunk: Buffer) => {
            markerSize += chunk.length
            if (markerSize > 64) invalid = true
            else markerChunks.push(Buffer.from(chunk))
          })
          entry.on('end', () => {
            if (!isValidStateVolumeMarker(Buffer.concat(markerChunks, markerSize))) invalid = true
          })
        }
        seen.add(name)
      } else if (collectTrustStore && name?.startsWith('license-trust/') && name !== 'license-trust') {
        if (name === 'license-trust/.trust-bundle.kernel-lock') {
          if (seen.has(name) || entry.type !== 'File' || entry.uid !== applicationUid ||
              (requireVolumeLayout && entry.gid !== applicationGid) || entry.mode === undefined ||
              (entry.mode & 0o7777) !== 0o600 || entry.size > 1024) invalid = true
          seen.add(name)
          entry.resume()
        } else if (trustStoreNames.has(name)) {
          const maxSize = name.endsWith('trust-bundle-state.json') ? 32 * 1024 : 64 * 1024
          if (seen.has(name) || entry.type !== 'File' || entry.uid !== applicationUid ||
              (requireVolumeLayout && entry.gid !== applicationGid) || entry.mode === undefined ||
              ![0o400, 0o600].includes(entry.mode & 0o7777) || !Number.isSafeInteger(entry.size) ||
              entry.size < 1 || entry.size > maxSize) invalid = true
          seen.add(name)
          const chunks: Buffer[] = []
          let size = 0
          entry.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > maxSize) invalid = true
            else chunks.push(Buffer.from(chunk))
          })
          entry.on('end', () => {
            if (size !== entry.size) invalid = true
            else trustFiles.set(name, Buffer.concat(chunks))
          })
          entry.resume()
        } else {
          invalid = true
          entry.resume()
        }
      } else if (name?.startsWith('identity/')) {
        // The application verifier permits only the current identity files;
        // unresolved identity staging must be inspected separately.
        invalid = true
      } else if (name?.startsWith('license-pending/.pending-key-') && name.endsWith('.tmp')) invalid = true
      entry.resume()
    } })
    let parseError: unknown
    parser.on('error', error => { parseError = error })
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      parser.write(chunk)
      if (parseError || invalid) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
    }
    parser.end()
    if (parseError || invalid || [...required.keys()].some(name => !seen.has(name))) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
    const state = trustFiles.get('license-trust/trust-bundle-state.json') ?? null
    const checkpoint = trustFiles.get('license-trust/trust-bundle-store.marker.json') ?? null
    if (collectTrustStore && (state === null) !== (checkpoint === null)) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('BACKUP_STATE_ARCHIVE_CHANGED')
    if (collectTrustStore) return { state, checkpoint }
  } catch { throw new Error('BACKUP_STATE_PROTECTION_INVALID') }
  finally { await file.close() }
}
