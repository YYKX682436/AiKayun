import { constants as fsConstants } from 'node:fs'
import type { LookupFunction } from 'node:net'
import { lstat, open } from 'node:fs/promises'
import type { AppConfig } from '../../config.js'
import type { TrustedReleaseLicenseConfig } from '../trusted-release-config.js'
import { createLicenseTrustService } from './service.js'
import type { TrustBundleStore } from './trust-bundle-store.js'

function fail(code: string): never {
  throw new Error(code)
}

async function readReleaseBundle(path: string): Promise<string> {
  let before
  try { before = await lstat(path) } catch { fail('release_trust_bundle_missing') }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (before!.isSymbolicLink() || !before!.isFile() || before!.nlink !== 1 ||
    ![0o400, 0o600].includes(before!.mode & 0o777) || (uid !== undefined && before!.uid !== uid)) {
    fail('release_trust_bundle_permissions_invalid')
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  let bytes: Buffer
  try {
    const after = await handle.stat()
    if (!after.isFile() || after.nlink !== 1 || before!.dev !== after.dev || before!.ino !== after.ino || after.size > 16 * 1024) {
      fail('release_trust_bundle_file_changed_or_invalid')
    }
    bytes = await handle.readFile()
  } finally { await handle.close() }
  const text = bytes!.toString('ascii')
  const token = text.endsWith('\n') ? text.slice(0, -1) : text
  if (token.length < 100 || token.length > 16 * 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token) ||
    !bytes!.equals(Buffer.from(`${token}${text.endsWith('\n') ? '\n' : ''}`, 'ascii'))) {
    fail('release_trust_bundle_format_invalid')
  }
  return token
}

/** First-install trust bootstrap from the release-manifest-authenticated, offline-root-signed artifact. */
export async function initializeReleaseTrustBundleIfNeeded(input: {
  config: AppConfig
  releaseConfig: TrustedReleaseLicenseConfig
  store: TrustBundleStore
  testTls?: { ca?: string | Buffer; lookup?: LookupFunction }
}): Promise<{ status: 'ready'; bundleVersion: string }> {
  const service = createLicenseTrustService({
    config: input.releaseConfig,
    store: input.store,
    ...(input.testTls?.ca === undefined ? {} : { testCa: input.testTls.ca }),
    ...(input.testTls?.lookup === undefined ? {} : { testLookup: input.testTls.lookup }),
  })
  const status = await service.status()
  if (status.status === 'ready') return { status: 'ready', bundleVersion: status.bundleVersion }
  if (status.status !== 'bundle_not_initialized') fail('release_trust_store_unavailable')
  if (!input.config.licenseTrustBundleFile) fail('release_trust_bundle_missing')
  await service.importProvidedBundle(await readReleaseBundle(input.config.licenseTrustBundleFile))
  const initialized = await service.status()
  if (initialized.status !== 'ready') fail('release_trust_store_initialization_incomplete')
  return { status: 'ready', bundleVersion: initialized.bundleVersion }
}
