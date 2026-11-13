/** Only database images supported by the authenticated release format. */
export function isBackupPostgresImage(reference: string): boolean {
  return /^(?:docker\.io\/library\/postgres|ghcr\.io\/yykx682436\/aikayun-postgres)@sha256:[a-f0-9]{64}$/.test(reference)
}

export function matchesBackupPostgresImage(reference: string, expectedDigest: string): boolean {
  return typeof expectedDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(expectedDigest) &&
    isBackupPostgresImage(reference) && reference.endsWith(`@${expectedDigest}`)
}
