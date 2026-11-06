/** Check bytes from the fixed deployment .env against the installer-generated
 * configuration. The caller must first authenticate both the release manifest
 * and install-state via the installer-owned verifier while holding its lock.
 * This function does not authenticate those inputs or read environment vars. */
export function assertFixedComposeConfiguration(bytes: Uint8Array, expected: {
  domain: string
  api: string
  web: string
  postgres: string
  caddy: string
}): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 8192 || !expected ||
      !/^[A-Za-z0-9.-]{1,253}$/.test(expected.domain) || expected.domain.startsWith('.') || expected.domain.endsWith('.') ||
      expected.domain.includes('..') ||
      !/^ghcr\.io\/yykx682436\/aikayun-api@sha256:[a-f0-9]{64}$/.test(expected.api) ||
      !/^ghcr\.io\/yykx682436\/aikayun-web@sha256:[a-f0-9]{64}$/.test(expected.web) ||
      !/^docker\.io\/library\/postgres@sha256:[a-f0-9]{64}$/.test(expected.postgres) ||
      !/^docker\.io\/library\/caddy@sha256:[a-f0-9]{64}$/.test(expected.caddy)) throw new Error('BACKUP_FIXED_CONFIGURATION_INVALID')
  const exact = [
    `AIKAYUN_PUBLIC_HOST=${expected.domain}`,
    `AIKAYUN_API_IMAGE=${expected.api}`,
    `AIKAYUN_WEB_IMAGE=${expected.web}`,
    `AIKAYUN_POSTGRES_IMAGE=${expected.postgres}`,
    `AIKAYUN_CADDY_IMAGE=${expected.caddy}`,
    'AIKAYUN_LICENSE_TRUST_BUNDLE_FILE=/opt/aikayun/release/license-trust-bundle.jws',
    'AIKAYUN_POSTGRES_ADMIN_PASSWORD_FILE=/opt/aikayun/secrets/postgres_admin_password',
    'AIKAYUN_API_DATABASE_PASSWORD_FILE=/opt/aikayun/secrets/api_database_password',
    'AIKAYUN_MIGRATOR_DATABASE_PASSWORD_FILE=/opt/aikayun/secrets/migrator_database_password',
    'AIKAYUN_PAYMENT_CREDENTIAL_KEY_RING_FILE=/opt/aikayun/secrets/payment_credential_key_ring',
    'AIKAYUN_CODE_POOL_ENCRYPTION_KEY_RING_FILE=/opt/aikayun/secrets/code_pool_encryption_key_ring',
    '',
  ].join('\n')
  if (!Buffer.from(bytes).equals(Buffer.from(exact, 'utf8'))) throw new Error('BACKUP_FIXED_CONFIGURATION_INVALID')
}
