import assert from 'node:assert/strict'
import { CompactSign, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose'
import { TrustBundleStore } from 'file:///app/dist/licensing/trust/trust-bundle-store.js'

const issuer = 'https://license-test.invalid'
const trustedTime = 2_000_000_000
const minimumBundleVersion = '1'
const directory = process.env.LICENSE_TRUST_STORE_ROOT
assert.ok(directory)

function publicJwk(jwk) {
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x }
}

function storeFor(rootPin) {
  return new TrustBundleStore({
    directory,
    trustedRoot: rootPin,
    expectedCenterIssuer: issuer,
    minimumBundleVersion,
  })
}

if (process.argv[2] === 'import') {
  const root = await generateKeyPair('Ed25519', { extractable: true })
  const rootJwk = publicJwk(await exportJWK(root.publicKey))
  const rootKid = await calculateJwkThumbprint(rootJwk, 'sha256')
  const center = await generateKeyPair('Ed25519', { extractable: true })
  const centerJwk = publicJwk(await exportJWK(center.publicKey))
  const centerKid = await calculateJwkThumbprint(centerJwk, 'sha256')
  const claims = {
    iss: 'urn:aikayun:license:offline-release-root:v1',
    aud: 'aikayun-license-signing-keys',
    sub: issuer,
    bundle_schema: 1,
    bundle_version: '1',
    iat: trustedTime - 10,
    nbf: trustedTime - 5,
    exp: trustedTime + 30 * 24 * 60 * 60,
    propagation_budget_seconds: 86_400,
    keys: [{
      kid: centerKid,
      alg: 'Ed25519',
      ...centerJwk,
      not_before: trustedTime - 60,
      retire_after: null,
      verify_until: null,
      revoked_at: null,
    }],
  }
  const token = await new CompactSign(Buffer.from(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'Ed25519', kid: rootKid, typ: 'aikayun-license-trust-bundle+jwt' })
    .sign(root.privateKey)
  const accepted = await storeFor({ kid: rootKid, publicJwk: rootJwk }).accept(token, trustedTime)
  const fixture = { rootPin: { kid: rootKid, publicJwk: rootJwk }, bundleVersion: accepted.bundleVersion, artifactSha256: accepted.artifactSha256 }
  process.stdout.write(`TRUST_STORE_FIXTURE=${JSON.stringify(fixture)}\n`)
} else if (process.argv[2] === 'verify') {
  const fixture = JSON.parse(process.env.TRUST_STORE_TEST_FIXTURE ?? 'null')
  assert.ok(fixture?.rootPin)
  const accepted = await storeFor(fixture.rootPin).getAccepted(trustedTime)
  assert.equal(accepted.bundleVersion, fixture.bundleVersion)
  assert.equal(accepted.artifactSha256, fixture.artifactSha256)
  process.stdout.write(`TRUST_STORE_RESTORED=${JSON.stringify({ bundleVersion: accepted.bundleVersion, artifactSha256: accepted.artifactSha256 })}\n`)
} else {
  throw new Error('Expected import or verify mode')
}
