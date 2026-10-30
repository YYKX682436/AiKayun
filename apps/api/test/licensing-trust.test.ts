import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompactSign, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose'
import type { CryptoKey } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { verifyTimeAnchorWithTrustBundleCandidate } from '../src/licensing/crypto/time-anchor.js'
import {
  verifyCurrentLicenseLease,
  verifyExpiredHistoricalLease,
  verifyLicenseChallenge,
  verifyLicenseOperationReceipt,
  verifyLicenseStatusReceipt,
} from '../src/licensing/trust/evidence.js'
import { fetchTrustedTimeAnchor } from '../src/licensing/trust/time-anchor-client.js'
import { TrustBundleStore } from '../src/licensing/trust/trust-bundle-store.js'
import type { TrustStoreWriteStage } from '../src/licensing/trust/trust-bundle-store.js'
import { verifyTrustBundleSignature } from '../src/licensing/trust/trust-bundle.js'
import type { Ed25519PublicJwk, TrustBundleKeyRecord, TrustedOfflineRootPin } from '../src/licensing/trust/trust-bundle.js'
import { getEmbeddedLicenseTrustCapabilityStatus } from '../src/licensing/trust/service.js'
import { validateTrustedReleaseLicenseConfig } from '../src/licensing/trusted-release-config.js'
import type { TrustedReleaseLicenseConfig } from '../src/licensing/trusted-release-config.js'
import type { InstallationIdentitySnapshot } from '../src/licensing/installation-identity.js'

const CENTER_ISSUER = 'https://license.example.test'
const BASE = 2_000_000_000
const DAY = 24 * 60 * 60
const interopFixturePromise = readFile(new URL('./fixtures/license-center-2c-4-interoperability.json', import.meta.url), 'utf8')
const temporaryDirectories: string[] = []

interface TestEd25519Pair {
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicJwk: Ed25519PublicJwk
  kid: string
}

interface InteropFixture {
  source_commit: string
  issuer: string
  serverTime: number
  clientNonce: string
  rootPublicJwk: Ed25519PublicJwk
  rootKid: string
  centerPublicJwk: Ed25519PublicJwk
  centerKid: string
  bundle: string
  timeAnchor: string
  lease: string
  status: string
  operation: string
  challenge: string
  identity: { databaseId: string; instanceId: string; identityJkt: string }
}

async function interopFixture(): Promise<InteropFixture> {
  return JSON.parse(await interopFixturePromise) as InteropFixture
}

async function makePair(): Promise<TestEd25519Pair> {
  const pair = await generateKeyPair('Ed25519', { extractable: true })
  const publicPart = await exportJWK(pair.publicKey)
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: publicPart.x! }
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
    kid: await calculateJwkThumbprint(publicJwk, 'sha256'),
  }
}

async function makeConfig(
  root: TestEd25519Pair,
  issuer = CENTER_ISSUER,
  minimumBundleVersion = '1',
): Promise<TrustedReleaseLicenseConfig> {
  return validateTrustedReleaseLicenseConfig({
    schema_version: 1,
    trust_configuration_id: randomUUID(),
    release_id: `test-${randomUUID()}`,
    release_manifest_sha256: randomBytes(32).toString('base64url'),
    expected_center_issuer: issuer,
    expected_center_origin: issuer,
    offline_root: { kid: root.kid, publicJwk: root.publicJwk },
    minimum_bundle_version: minimumBundleVersion,
  })
}

async function publicEntry(
  pair: TestEd25519Pair,
  overrides: Partial<Pick<TrustBundleKeyRecord, 'not_before' | 'retire_after' | 'verify_until' | 'revoked_at'>> = {},
): Promise<TrustBundleKeyRecord> {
  return {
    kid: pair.kid,
    alg: 'Ed25519',
    ...pair.publicJwk,
    not_before: overrides.not_before ?? BASE - 10_000,
    retire_after: overrides.retire_after ?? null,
    verify_until: overrides.verify_until ?? null,
    revoked_at: overrides.revoked_at ?? null,
  }
}

async function signJws(privateKey: CryptoKey, header: Record<string, unknown>, payload: string | Record<string, unknown>): Promise<string> {
  const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  return new CompactSign(bytes).setProtectedHeader(header).sign(privateKey)
}

async function bundle(
  root: TestEd25519Pair,
  issuer: string,
  input: {
    version: string
    keys: unknown[]
    at?: number
    iat?: number
    nbf?: number
    exp?: number
    propagationBudget?: number
    extra?: Record<string, unknown>
  },
): Promise<string> {
  const at = input.at ?? BASE
  const payload = {
    iss: 'urn:aikayun:license:offline-release-root:v1',
    aud: 'aikayun-license-signing-keys',
    sub: issuer,
    bundle_schema: 1,
    bundle_version: input.version,
    iat: input.iat ?? at - 60,
    nbf: input.nbf ?? at - 30,
    exp: input.exp ?? at + 30 * DAY,
    propagation_budget_seconds: input.propagationBudget ?? DAY,
    keys: input.keys,
    ...input.extra,
  }
  return signJws(root.privateKey, {
    alg: 'Ed25519', kid: root.kid, typ: 'aikayun-license-trust-bundle+jwt',
  }, payload)
}

function storeFor(directory: string, root: TestEd25519Pair, issuer = CENTER_ISSUER, minimum = '1', faultAt?: (stage: TrustStoreWriteStage) => void | Promise<void>): TrustBundleStore {
  return new TrustBundleStore({
    directory,
    trustedRoot: { kid: root.kid, publicJwk: root.publicJwk },
    expectedCenterIssuer: issuer,
    minimumBundleVersion: minimum,
    ...(faultAt ? { faultAt } : {}),
  })
}

async function temporaryStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aikayun-trust-'))
  temporaryDirectories.push(directory)
  return directory
}

function identitySnapshot(identity: InteropFixture['identity']): InstallationIdentitySnapshot {
  return {
    status: 'ready',
    code: 'identity_ready',
    databaseId: identity.databaseId,
    instanceId: identity.instanceId,
    identityJkt: identity.identityJkt,
    bindingRevision: '1',
    bindingState: 'ready',
    initializationMode: 'fresh',
    businessDataProvenance: 'empty_at_initialization',
  }
}

function nonce(): string { return randomBytes(32).toString('base64url') }

async function signTimeAnchor(
  center: TestEd25519Pair,
  issuer: string,
  clientNonce: string,
  serverTime: number,
  overrides: { kid?: string; nonce?: string; typ?: string; aud?: string; iss?: string; exp?: number } = {},
): Promise<string> {
  const claims = {
    v: 1,
    iss: overrides.iss ?? issuer,
    aud: overrides.aud ?? 'aikayun-time-bootstrap',
    sub: 'license-center-time',
    jti: randomUUID(),
    iat: serverTime,
    nbf: serverTime,
    exp: overrides.exp ?? serverTime + 30,
    server_time: serverTime,
    client_nonce: overrides.nonce ?? clientNonce,
  }
  return signJws(center.privateKey, {
    alg: 'Ed25519', kid: overrides.kid ?? center.kid, typ: overrides.typ ?? 'aikayun-time-anchor+jwt',
  }, claims)
}

function startChildCrash(directory: string, token: string, root: TrustedOfflineRootPin, stage: string): Promise<NodeJS.Signals | null> {
  const childFile = new URL('./fixtures/trust-store-crash-child.ts', import.meta.url)
  const child = spawn(process.execPath, [
    '--import', 'tsx', childFile.pathname, directory, token, JSON.stringify(root), CENTER_ISSUER, '1', String(BASE), stage,
  ], { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'test' } })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (_code, signal) => resolve(signal))
  })
}

let tlsDirectory = ''
let tlsKey = Buffer.alloc(0)
let tlsCertificate = Buffer.alloc(0)
let tlsServer: ReturnType<typeof createHttpsServer> | undefined
let tlsIssuer = ''
let tlsMode: 'valid' | 'wrong_nonce' | 'wrong_kid' | 'duplicate_json' | 'oversized' | 'redirect' | 'slow' | 'replay' = 'valid'
let tlsCenter: TestEd25519Pair
let tlsReplayToken: string | undefined
let tlsRequests: Array<{ method: string; path: string; nonce: string }> = []

beforeAll(async () => {
  tlsDirectory = await mkdtemp(join(tmpdir(), 'aikayun-anchor-tls-'))
  const keyPath = join(tlsDirectory, 'server-key.pem')
  const certificatePath = join(tlsDirectory, 'server-cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certificatePath,
    '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' })
  tlsKey = await readFile(keyPath)
  tlsCertificate = await readFile(certificatePath)
  tlsCenter = await makePair()
  tlsServer = createHttpsServer({ key: tlsKey, cert: tlsCertificate }, (request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on('end', async () => {
      let requestBody: Record<string, unknown>
      try { requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch {
        response.writeHead(400).end()
        return
      }
      const clientNonce = requestBody.client_nonce
      if (typeof clientNonce !== 'string') {
        response.writeHead(400).end()
        return
      }
      tlsRequests.push({ method: request.method ?? '', path: request.url ?? '', nonce: clientNonce })
      if (tlsMode === 'redirect') {
        response.writeHead(302, { location: 'https://other.example.test/v1/time-anchor' }).end()
        return
      }
      if (tlsMode === 'slow') {
        const timer = setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end('{}'), 5_500)
        timer.unref()
        response.on('error', () => undefined)
        return
      }
      if (tlsMode === 'oversized') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(`{"time_anchor":"${'x'.repeat(5_000)}"}`)
        return
      }
      if (tlsMode === 'duplicate_json') {
        const token = await signTimeAnchor(tlsCenter, tlsIssuer, clientNonce, BASE)
        response.writeHead(200, { 'content-type': 'application/json' }).end(`{"time_anchor":${JSON.stringify(token)},"time_anchor":${JSON.stringify(token)}}`)
        return
      }
      if (tlsMode === 'replay' && tlsReplayToken) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ time_anchor: tlsReplayToken }))
        return
      }
      const token = await signTimeAnchor(tlsCenter, tlsIssuer, clientNonce, BASE, {
        ...(tlsMode === 'wrong_nonce' ? { nonce: nonce() } : {}),
        ...(tlsMode === 'wrong_kid' ? { kid: randomBytes(32).toString('base64url') } : {}),
      })
      tlsReplayToken = token
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify({ time_anchor: token })) })
        .end(JSON.stringify({ time_anchor: token }))
    })
  })
  await new Promise<void>((resolve) => tlsServer!.listen(0, '127.0.0.1', resolve))
  const address = tlsServer.address() as AddressInfo
  tlsIssuer = `https://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  tlsMode = 'valid'
  tlsReplayToken = undefined
  tlsRequests = []
})

afterAll(async () => {
  await new Promise<void>((resolve) => tlsServer?.close(() => resolve()) ?? resolve())
  if (tlsDirectory) await rm(tlsDirectory, { recursive: true, force: true })
})

describe('trusted release configuration and frozen center interoperability', () => {
  it('reports trust_uninitialized until a signed release configuration supplies a root', async () => {
    expect(await getEmbeddedLicenseTrustCapabilityStatus('/unused/test/path')).toEqual({ status: 'trust_uninitialized' })
    const fixture = await interopFixture()
    expect(fixture.source_commit).toBe('6f554b51b867a15ad7747c6d002b548e016f65c6')
    await expect(validateTrustedReleaseLicenseConfig({
      schema_version: 1,
      trust_configuration_id: randomUUID(),
      release_id: 'release-test',
      release_manifest_sha256: randomBytes(32).toString('base64url'),
      expected_center_issuer: fixture.issuer,
      expected_center_origin: 'https://attacker.example',
      offline_root: { kid: fixture.rootKid, publicJwk: fixture.rootPublicJwk },
      minimum_bundle_version: '1',
    })).rejects.toThrow(/identical/u)
    await expect(validateTrustedReleaseLicenseConfig({
      schema_version: 1,
      trust_configuration_id: randomUUID(),
      release_id: 'release-test',
      release_manifest_sha256: randomBytes(32).toString('base64url'),
      expected_center_issuer: fixture.issuer,
      expected_center_origin: fixture.issuer,
      offline_root: { kid: 'A'.repeat(43), publicJwk: fixture.rootPublicJwk },
      minimum_bundle_version: '1',
    })).rejects.toThrow(/JKT/u)
  })

  it('verifies center-generated root bundle, time anchor, lease, challenge, status and operation JWSs', async () => {
    const fixture = await interopFixture()
    const root: TrustedOfflineRootPin = { kid: fixture.rootKid, publicJwk: fixture.rootPublicJwk }
    const candidate = await verifyTrustBundleSignature(fixture.bundle, { trustedRoot: root, expectedCenterIssuer: fixture.issuer })
    const anchor = await verifyTimeAnchorWithTrustBundleCandidate(fixture.timeAnchor, {
      candidate, clientNonce: fixture.clientNonce, roundTripMs: 17,
    })
    expect(anchor.serverTime).toBe(fixture.serverTime)
    expect(anchor.keyId).toBe(fixture.centerKid)
    const directory = await temporaryStoreDirectory()
    const accepted = await storeFor(directory, { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey, publicJwk: fixture.rootPublicJwk, kid: fixture.rootKid }, fixture.issuer)
      .accept(fixture.bundle, fixture.serverTime)
    const identity = identitySnapshot(fixture.identity)
    const lease = await verifyCurrentLicenseLease(fixture.lease, {
      resolver: accepted.resolver, issuer: fixture.issuer, trustedTime: fixture.serverTime, identity,
    })
    expect(lease).toMatchObject({ purpose: 'current_license_lease', signatureVerified: true, grants: ['create_order', 'create_top_up'] })
    expect(lease).not.toHaveProperty('canCreateOrder')
    expect(await verifyLicenseChallenge(fixture.challenge, {
      resolver: accepted.resolver, issuer: fixture.issuer, trustedTime: fixture.serverTime,
    })).toMatchObject({ purpose: 'license_challenge', signatureVerified: true })
    expect(await verifyLicenseStatusReceipt(fixture.status, {
      resolver: accepted.resolver, issuer: fixture.issuer, trustedTime: fixture.serverTime,
    })).toMatchObject({ purpose: 'license_status_receipt', signatureVerified: true })
    expect(await verifyLicenseOperationReceipt(fixture.operation, {
      resolver: accepted.resolver, issuer: fixture.issuer, trustedTime: fixture.serverTime,
    })).toMatchObject({ purpose: 'license_operation_receipt', signatureVerified: true })
    await expect(verifyLicenseChallenge(fixture.timeAnchor, {
      resolver: accepted.resolver, issuer: fixture.issuer, trustedTime: fixture.serverTime,
    })).rejects.toThrow()
    await expect(verifyCurrentLicenseLease(fixture.lease, {
      resolver: accepted.resolver,
      issuer: fixture.issuer,
      trustedTime: fixture.serverTime,
      identity: { ...identity, databaseId: randomUUID() },
    })).rejects.toThrow(/binding/u)
  })

  it('rejects expired, future-dated, unknown-kid and revoked-key Challenge JWSs', async () => {
    const root = await makePair()
    const center = await makePair()
    const keyRecord = await publicEntry(center)
    const activeStore = await storeFor(await temporaryStoreDirectory(), root)
    const active = await activeStore.accept(
      await bundle(root, CENTER_ISSUER, { version: '1', keys: [keyRecord] }),
      BASE,
    )
    const instanceId = randomUUID()
    const claims = {
      v: 1,
      iss: CENTER_ISSUER,
      aud: 'aikayun-commerce',
      sub: instanceId,
      jti: randomUUID(),
      iat: BASE - 1,
      nbf: BASE - 1,
      exp: BASE + 299,
      operation: 'activation',
      operation_id: randomUUID(),
      intent_digest: randomBytes(32).toString('base64url'),
      instance_id: instanceId,
      identity_jkt: randomBytes(32).toString('base64url'),
      client_nonce: randomBytes(32).toString('base64url'),
      server_nonce: randomBytes(32).toString('base64url'),
    }
    const activeHeader = { alg: 'Ed25519', kid: center.kid, typ: 'aikayun-license-challenge+jwt' }
    const valid = await signJws(center.privateKey, activeHeader, claims)
    await expect(verifyLicenseChallenge(valid, {
      resolver: active.resolver, issuer: CENTER_ISSUER, trustedTime: BASE,
    })).resolves.toMatchObject({ signatureVerified: true, signingKeyId: center.kid })

    const expired = await signJws(center.privateKey, activeHeader, {
      ...claims,
      iat: BASE - 301,
      nbf: BASE - 301,
      exp: BASE - 1,
    })
    await expect(verifyLicenseChallenge(expired, {
      resolver: active.resolver, issuer: CENTER_ISSUER, trustedTime: BASE,
    })).rejects.toThrow()

    const futureDated = await signJws(center.privateKey, activeHeader, {
      ...claims,
      iat: BASE + 1,
      nbf: BASE + 1,
      exp: BASE + 301,
    })
    await expect(verifyLicenseChallenge(futureDated, {
      resolver: active.resolver, issuer: CENTER_ISSUER, trustedTime: BASE,
    })).rejects.toThrow()

    const wrongKid = await signJws(center.privateKey, {
      ...activeHeader,
      kid: randomBytes(32).toString('base64url'),
    }, claims)
    await expect(verifyLicenseChallenge(wrongKid, {
      resolver: active.resolver, issuer: CENTER_ISSUER, trustedTime: BASE,
    })).rejects.toThrow()

    const revokedStore = await storeFor(await temporaryStoreDirectory(), root)
    const revoked = await revokedStore.accept(
      await bundle(root, CENTER_ISSUER, {
        version: '1',
        keys: [{ ...keyRecord, revoked_at: BASE - 1 }],
        at: BASE,
        iat: BASE,
        nbf: BASE,
      }),
      BASE,
    )
    await expect(verifyLicenseChallenge(valid, {
      resolver: revoked.resolver, issuer: CENTER_ISSUER, trustedTime: BASE,
    })).rejects.toThrow(/revoked|signing key|trust bundle/iu)
  })

  it('rejects leases with non-canonical signed request nonce or digest claims', async () => {
    const root = await makePair()
    const center = await makePair()
    const validLease = await signedLease(center, BASE, BASE + 7 * DAY)
    const [headerSegment, payloadSegment] = validLease.split('.')
    const header = JSON.parse(Buffer.from(headerSegment!, 'base64url').toString('utf8')) as Record<string, unknown>
    const claims = JSON.parse(Buffer.from(payloadSegment!, 'base64url').toString('utf8')) as Record<string, unknown>
    const directory = await temporaryStoreDirectory()
    const accepted = await storeFor(directory, root).accept(
      await bundle(root, CENTER_ISSUER, { version: '1', keys: [await publicEntry(center)] }),
      BASE + 1,
    )
    for (const name of ['request_nonce', 'request_digest']) {
      const malformedLease = await signJws(center.privateKey, header, { ...claims, [name]: 'not-a-canonical-digest' })
      await expect(verifyCurrentLicenseLease(malformedLease, {
        resolver: accepted.resolver,
        issuer: CENTER_ISSUER,
        trustedTime: BASE + 1,
        identity: leaseIdentity(validLease),
      })).rejects.toThrow(/nonce|digest/u)
    }
  })

  it('keeps a root-authenticated candidate limited to time bootstrap until store acceptance', async () => {
    const fixture = await interopFixture()
    const directory = await temporaryStoreDirectory()
    const root = { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey, publicJwk: fixture.rootPublicJwk, kid: fixture.rootKid }
    const store = storeFor(directory, root, fixture.issuer)
    const candidate = await verifyTrustBundleSignature(fixture.bundle, {
      trustedRoot: { kid: fixture.rootKid, publicJwk: fixture.rootPublicJwk }, expectedCenterIssuer: fixture.issuer,
    })
    await expect(store.getAccepted(fixture.serverTime)).rejects.toThrow(/No accepted/u)
    await verifyTimeAnchorWithTrustBundleCandidate(fixture.timeAnchor, {
      candidate, clientNonce: fixture.clientNonce, roundTripMs: 1,
    })
    await expect(store.getAccepted(fixture.serverTime)).rejects.toThrow(/No accepted/u)
  })
})

describe('trust bundle signature, lifecycle and monotonic persistence', () => {
  it('rejects wrong root, issuer, schema, typ, audience, JWK/kid, duplicate fields and signatures', async () => {
    const root = await makePair()
    const center = await makePair()
    const key = await publicEntry(center)
    const valid = await bundle(root, CENTER_ISSUER, { version: '1', keys: [key] })
    const wrongRoot = await makePair()
    const wrongRootBundle = await bundle(wrongRoot, CENTER_ISSUER, { version: '1', keys: [key] })
    const wrongIssuer = await bundle(root, 'https://attacker.example', { version: '1', keys: [key] })
    const wrongAudience = await signJws(root.privateKey, {
      alg: 'Ed25519', kid: root.kid, typ: 'aikayun-license-trust-bundle+jwt',
    }, {
      iss: 'urn:aikayun:license:offline-release-root:v1', aud: 'aikayun-commerce', sub: CENTER_ISSUER,
      bundle_schema: 1, bundle_version: '1', iat: BASE - 60, nbf: BASE - 30, exp: BASE + DAY,
      propagation_budget_seconds: 1, keys: [key],
    })
    const wrongSchema = await signJws(root.privateKey, {
      alg: 'Ed25519', kid: root.kid, typ: 'aikayun-license-trust-bundle+jwt',
    }, {
      iss: 'urn:aikayun:license:offline-release-root:v1', aud: 'aikayun-license-signing-keys', sub: CENTER_ISSUER,
      bundle_schema: 2, bundle_version: '1', iat: BASE - 60, nbf: BASE - 30, exp: BASE + DAY,
      propagation_budget_seconds: 1, keys: [key],
    })
    const wrongKidKey = { ...key, kid: randomBytes(32).toString('base64url') }
    const wrongJwk = await bundle(root, CENTER_ISSUER, { version: '1', keys: [wrongKidKey] })
    const extraHeader = await signJws(root.privateKey, {
      alg: 'Ed25519', kid: root.kid, typ: 'aikayun-license-trust-bundle+jwt', jku: 'https://attacker.example/keys',
    }, { iss: 'urn:aikayun:license:offline-release-root:v1', aud: 'aikayun-license-signing-keys', sub: CENTER_ISSUER,
      bundle_schema: 1, bundle_version: '1', iat: BASE - 60, nbf: BASE - 30, exp: BASE + DAY,
      propagation_budget_seconds: 1, keys: [key] })
    const duplicatePayload = await signJws(root.privateKey, {
      alg: 'Ed25519', kid: root.kid, typ: 'aikayun-license-trust-bundle+jwt',
    }, '{"iss":"urn:aikayun:license:offline-release-root:v1","iss":"urn:aikayun:license:offline-release-root:v1"}')
    const corrupted = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`
    const input = { trustedRoot: { kid: root.kid, publicJwk: root.publicJwk }, expectedCenterIssuer: CENTER_ISSUER }
    for (const token of [wrongRootBundle, wrongIssuer, wrongAudience, wrongSchema, wrongJwk, extraHeader, duplicatePayload, corrupted]) {
      await expect(verifyTrustBundleSignature(token, input)).rejects.toThrow()
    }
  })

  it('enforces pinned minimum version and rejects rollback and same-version replacement', async () => {
    const root = await makePair()
    const center = await makePair()
    const key = await publicEntry(center)
    const directory = await temporaryStoreDirectory()
    const store = storeFor(directory, root, CENTER_ISSUER, '2')
    const v1 = await bundle(root, CENTER_ISSUER, { version: '1', keys: [key] })
    const v2 = await bundle(root, CENTER_ISSUER, { version: '2', keys: [key], propagationBudget: 3600 })
    const otherV2 = await bundle(root, CENTER_ISSUER, { version: '2', keys: [key], propagationBudget: 7200 })
    await expect(store.accept(v1, BASE)).rejects.toThrow(/minimum version/u)
    expect((await store.accept(v2, BASE)).bundleVersion).toBe('2')
    await expect(store.accept(otherV2, BASE)).rejects.toThrow(/same trust bundle version/iu)
    await expect(store.accept(v1, BASE)).rejects.toThrow(/minimum version|rollback/iu)
  })

  it('accepts v1(A) to v2(A+B), preserves normal retirement, removes A only after verify_until, then tombstones it', async () => {
    const root = await makePair()
    const keyA = await makePair()
    const keyB = await makePair()
    const directory = await temporaryStoreDirectory()
    const store = storeFor(directory, root)
    const v1 = await bundle(root, CENTER_ISSUER, { version: '1', keys: [await publicEntry(keyA)] })
    const v2 = await bundle(root, CENTER_ISSUER, {
      version: '2', keys: [await publicEntry(keyA), await publicEntry(keyB)], at: BASE + 10,
    })
    await store.accept(v1, BASE)
    const resolverA = (await store.getAccepted(BASE)).resolver
    await store.accept(v2, BASE + 10)
    const leaseA = await signedLease(keyA, BASE + 15, BASE + 15 + 7 * DAY)
    await expect(verifyCurrentLicenseLease(leaseA, {
      resolver: (await store.getAccepted(BASE + 20)).resolver,
      issuer: CENTER_ISSUER,
      trustedTime: BASE + 20,
      identity: leaseIdentity(leaseA),
    })).resolves.toMatchObject({ purpose: 'current_license_lease' })
    await expect(resolverA.resolveKey({
      kid: keyA.kid, targetIssuer: CENTER_ISSUER, jwtTyp: 'aikayun-license+jwt', audience: 'aikayun-commerce',
      trustedTime: BASE, issuedAt: BASE - 1, expiresAt: BASE + 100,
    })).rejects.toThrow(/stale/u)

    const retireAt = BASE + 100
    const verifyUntil = retireAt + 8 * DAY
    const retiringA = await publicEntry(keyA, { retire_after: retireAt, verify_until: verifyUntil })
    const v3 = await bundle(root, CENTER_ISSUER, {
      version: '3', at: retireAt, iat: retireAt - 20, nbf: retireAt - 10,
      exp: retireAt + 25 * DAY, keys: [retiringA, await publicEntry(keyB)],
    })
    const acceptedRetirement = await store.accept(v3, retireAt)
    const preRetirementLease = await signedLease(keyA, retireAt - 1, verifyUntil - 1)
    await expect(verifyCurrentLicenseLease(preRetirementLease, {
      resolver: acceptedRetirement.resolver, issuer: CENTER_ISSUER, trustedTime: retireAt,
      identity: leaseIdentity(preRetirementLease),
    })).resolves.toMatchObject({ purpose: 'current_license_lease' })
    const boundaryLease = await signedLease(keyA, retireAt, verifyUntil)
    await expect(verifyCurrentLicenseLease(boundaryLease, {
      resolver: acceptedRetirement.resolver, issuer: CENTER_ISSUER, trustedTime: retireAt,
      identity: leaseIdentity(boundaryLease),
    })).rejects.toThrow(/issuance window/u)
    const removedEarly = await bundle(root, CENTER_ISSUER, {
      version: '4', at: verifyUntil - 1, iat: verifyUntil - 20, nbf: verifyUntil - 10,
      exp: verifyUntil + DAY, keys: [await publicEntry(keyB)],
    })
    await expect(store.accept(removedEarly, verifyUntil - 1)).rejects.toThrow(/cannot be removed/u)
    const removedAfter = await bundle(root, CENTER_ISSUER, {
      version: '4', at: verifyUntil, iat: verifyUntil - 20, nbf: verifyUntil - 10,
      exp: verifyUntil + DAY, keys: [await publicEntry(keyB)],
    })
    const acceptedRemoved = await store.accept(removedAfter, verifyUntil)
    expect(acceptedRemoved.retiredKids).toContain(keyA.kid)
    await expect(verifyCurrentLicenseLease(preRetirementLease, {
      resolver: acceptedRemoved.resolver, issuer: CENTER_ISSUER, trustedTime: verifyUntil,
      identity: leaseIdentity(preRetirementLease),
    })).rejects.toThrow(/key|kid|retention/u)
    const resurrected = await bundle(root, CENTER_ISSUER, {
      version: '5', at: verifyUntil + 1, iat: verifyUntil - 19, nbf: verifyUntil - 9,
      exp: verifyUntil + DAY, keys: [await publicEntry(keyA), await publicEntry(keyB)],
    })
    await expect(store.accept(resurrected, verifyUntil + 1)).rejects.toThrow(/permanently retired/u)
  })

  it('rejects active-key deletion, emergency-revokes immediately, and keeps the revocation tombstone', async () => {
    const root = await makePair()
    const keyA = await makePair()
    const keyB = await makePair()
    const directory = await temporaryStoreDirectory()
    const store = storeFor(directory, root)
    await store.accept(await bundle(root, CENTER_ISSUER, { version: '1', keys: [await publicEntry(keyA)] }), BASE)
    const silentDelete = await bundle(root, CENTER_ISSUER, { version: '2', keys: [await publicEntry(keyB)] })
    await expect(store.accept(silentDelete, BASE)).rejects.toThrow(/lifecycle|retir|remove/u)
    const revokedA = await publicEntry(keyA, { revoked_at: BASE + 1 })
    const v2 = await bundle(root, CENTER_ISSUER, {
      version: '2', at: BASE + 1, iat: BASE + 1, nbf: BASE + 1, keys: [revokedA],
    })
    const accepted = await store.accept(v2, BASE + 1)
    const lease = await signedLease(keyA, BASE, BASE + 7 * DAY)
    await expect(verifyCurrentLicenseLease(lease, {
      resolver: accepted.resolver, issuer: CENTER_ISSUER, trustedTime: BASE + 1, identity: leaseIdentity(lease),
    })).rejects.toThrow(/revok/u)
    const resurrection = await bundle(root, CENTER_ISSUER, {
      version: '3', at: BASE + 2, keys: [await publicEntry(keyA)],
    })
    await expect(store.accept(resurrection, BASE + 2)).rejects.toThrow(/revok|resurrect|reactivat/u)
    expect((await store.getAccepted(BASE + 2)).revokedKids).toContain(keyA.kid)
  })

  it('fails closed for state/checkpoint rollback, loss, corruption, wrong root and stale time samples', async () => {
    const root = await makePair()
    const center = await makePair()
    const key = await publicEntry(center)
    const directory = await temporaryStoreDirectory()
    const store = storeFor(directory, root)
    const v1 = await bundle(root, CENTER_ISSUER, { version: '1', keys: [key] })
    const v2 = await bundle(root, CENTER_ISSUER, { version: '2', keys: [key] })
    await store.accept(v1, BASE)
    const statePath = join(directory, 'trust-bundle-state.json')
    const checkpointPath = join(directory, 'trust-bundle-store.marker.json')
    const savedV1State = await readFile(statePath)
    const savedV1Checkpoint = await readFile(checkpointPath)
    await store.accept(v2, BASE)
    const stateV2 = await readFile(statePath)
    const checkpointV2 = await readFile(checkpointPath)
    await writeFile(statePath, savedV1State)
    await expect(store.getAccepted(BASE)).rejects.toThrow(/checkpoint|mismatch|rollback/u)
    await writeFile(statePath, stateV2)
    await writeFile(checkpointPath, savedV1Checkpoint)
    await expect(store.getAccepted(BASE)).rejects.toThrow(/checkpoint|mismatch|rollback/u)
    await writeFile(checkpointPath, checkpointV2)
    await unlink(statePath)
    await expect(store.getAccepted(BASE)).rejects.toThrow(/state|checkpoint|mismatch/u)
    await writeFile(statePath, Buffer.from('{"broken":', 'utf8'))
    await expect(store.getAccepted(BASE)).rejects.toThrow()
    const wrongRoot = await makePair()
    await expect(storeFor(directory, wrongRoot).getAccepted(BASE)).rejects.toThrow()

    const empty = await temporaryStoreDirectory()
    const uninitialized = storeFor(empty, root)
    let calls = 0
    await expect(uninitialized.accept(v1, () => {
      calls += 1
      if (calls > 1) throw new Error('stale trusted sample after store-lock acquisition')
      return BASE
    })).rejects.toThrow(/stale trusted sample/u)
    await expect(uninitialized.getAccepted(BASE)).rejects.toThrow(/No accepted/u)
  })

  it('recovers actual SIGKILL at each durable trust-store write boundary', async () => {
    const root = await makePair()
    const center = await makePair()
    const key = await publicEntry(center)
    const v1 = await bundle(root, CENTER_ISSUER, { version: '1', keys: [key] })
    const v2 = await bundle(root, CENTER_ISSUER, { version: '2', keys: [key] })
    const stages = [
      ...['before_write', 'after_partial_write', 'after_write', 'after_file_fsync', 'after_rename', 'after_directory_fsync']
        .map((stage) => `checkpoint_prepare_${stage}`),
      ...['before_write', 'after_partial_write', 'after_write', 'after_file_fsync', 'after_rename', 'after_directory_fsync']
        .map((stage) => `state_${stage}`),
      ...['before_write', 'after_partial_write', 'after_write', 'after_file_fsync', 'after_rename', 'after_directory_fsync']
        .map((stage) => `checkpoint_commit_${stage}`),
    ]
    for (const stage of stages) {
      const directory = await temporaryStoreDirectory()
      await storeFor(directory, root).accept(v1, BASE)
      await expect(startChildCrash(directory, v2, { kid: root.kid, publicJwk: root.publicJwk }, stage)).resolves.toBe('SIGKILL')
      const recovered = await storeFor(directory, root).getAccepted(BASE)
      const expectedVersion = stage.startsWith('checkpoint_commit_') ||
        (stage.startsWith('state_') && /after_(?:rename|directory_fsync)$/u.test(stage))
        ? '2' : '1'
      expect(recovered.bundleVersion, stage).toBe(expectedVersion)
      if (expectedVersion === '1') expect((await storeFor(directory, root).accept(v2, BASE)).bundleVersion).toBe('2')
      expect((await storeFor(directory, root).getAccepted(BASE)).bundleVersion).toBe('2')
    }
  }, 60_000)
})

function leaseIdentity(token: string): InstallationIdentitySnapshot {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, string>
  return {
    status: 'ready', code: 'identity_ready', databaseId: payload.database_id, instanceId: payload.instance_id,
    identityJkt: payload.identity_jkt, bindingRevision: '1', bindingState: 'ready',
  }
}

async function signedLease(center: TestEd25519Pair, issuedAt: number, subscriptionEnd: number): Promise<string> {
  const identity = { databaseId: randomUUID(), instanceId: randomUUID(), identityJkt: nonce() }
  const iat = issuedAt
  const exp = Math.min(iat + 7 * DAY, subscriptionEnd)
  const claims = {
    v: 1, iss: CENTER_ISSUER, aud: 'aikayun-commerce', sub: randomUUID(), jti: randomUUID(), iat, nbf: iat, exp,
    instance_id: identity.instanceId, database_id: identity.databaseId, identity_jkt: identity.identityJkt,
    activation_generation: '1', entitlement_revision: '1', plan: 'monthly', subscription_end: subscriptionEnd,
    renew_after: Math.min(iat + 6 * 60 * 60, exp), grants: ['create_order', 'create_top_up'],
    request_nonce: nonce(), request_digest: nonce(),
  }
  return signJws(center.privateKey, { alg: 'Ed25519', kid: center.kid, typ: 'aikayun-license+jwt' }, claims)
}

describe('time anchor HTTPS transport and expiry', () => {
  it('uses exact HTTPS origin, a 32-byte nonce, valid TLS, and signed center time with wall clock offset by five years either way', async () => {
    const root = await makePair()
    const directory = await temporaryStoreDirectory()
    const config = await makeConfig(root, tlsIssuer)
    const centerKey = await publicEntry(tlsCenter)
    const token = await bundle(root, tlsIssuer, { version: '1', keys: [centerKey] })
    const candidate = await verifyTrustBundleSignature(token, { trustedRoot: config.offline_root, expectedCenterIssuer: tlsIssuer })
    const originalDateNow = Date.now
    try {
      let acceptedSample: Awaited<ReturnType<typeof fetchTrustedTimeAnchor>> | undefined
      for (const wallOffsetYears of [-5, 5]) {
        Date.now = () => (BASE + wallOffsetYears * 365 * DAY) * 1000
        const sample = await fetchTrustedTimeAnchor(config, candidate, { testCa: tlsCertificate })
        acceptedSample = sample
        expect(sample.anchor.serverTime).toBe(BASE)
        expect(sample.roundTripMs).toBeLessThanOrEqual(5_000)
        expect(sample.readCurrentTrustedTime()).toBe(BASE)
      }
      expect(tlsRequests).toHaveLength(2)
      for (const request of tlsRequests) {
        expect(request).toMatchObject({ method: 'POST', path: '/v1/time-anchor' })
        expect(Buffer.from(request.nonce, 'base64url')).toHaveLength(32)
      }
      const store = storeFor(directory, root, tlsIssuer)
      const sample = acceptedSample!
      await store.accept(candidate.token, sample.readCurrentTrustedTime)
      expect((await store.getAccepted(sample.readCurrentTrustedTime)).bundleVersion).toBe('1')
    } finally {
      Date.now = originalDateNow
    }
  })

  it('rejects nonce mismatch, replay, wrong key, redirect, malformed/oversized JSON, untrusted TLS and hostname mismatch', async () => {
    const root = await makePair()
    const config = await makeConfig(root, tlsIssuer)
    const token = await bundle(root, tlsIssuer, { version: '1', keys: [await publicEntry(tlsCenter)] })
    const candidate = await verifyTrustBundleSignature(token, { trustedRoot: config.offline_root, expectedCenterIssuer: tlsIssuer })
    tlsMode = 'wrong_nonce'
    await expect(fetchTrustedTimeAnchor(config, candidate, { testCa: tlsCertificate })).rejects.toThrow(/nonce|claims/u)
    tlsMode = 'valid'
    tlsReplayToken = await signTimeAnchor(tlsCenter, tlsIssuer, nonce(), BASE)
    tlsMode = 'replay'
    await expect(fetchTrustedTimeAnchor(config, candidate, { testCa: tlsCertificate })).rejects.toThrow(/nonce|claims/u)
    tlsMode = 'wrong_kid'
    await expect(fetchTrustedTimeAnchor(config, candidate, { testCa: tlsCertificate })).rejects.toThrow()
    tlsMode = 'redirect'
    await expect(fetchTrustedTimeAnchor(config, candidate, { testCa: tlsCertificate })).rejects.toThrow(/status/u)
    tlsMode = 'duplicate_json'
    await expect(fetchTrustedTimeAnchor(config, candidate, { testCa: tlsCertificate })).rejects.toThrow(/duplicate|schema/iu)
    tlsMode = 'oversized'
    await expect(fetchTrustedTimeAnchor(config, candidate, { testCa: tlsCertificate })).rejects.toThrow(/size/u)
    tlsMode = 'valid'
    await expect(fetchTrustedTimeAnchor(config, candidate)).rejects.toThrow()

    const wrongHostIssuer = `https://localhost:${new URL(tlsIssuer).port}`
    const wrongHostConfig = await makeConfig(root, wrongHostIssuer)
    const wrongHostBundle = await bundle(root, wrongHostIssuer, { version: '1', keys: [await publicEntry(tlsCenter)] })
    const wrongHostCandidate = await verifyTrustBundleSignature(wrongHostBundle, {
      trustedRoot: wrongHostConfig.offline_root, expectedCenterIssuer: wrongHostIssuer,
    })
    await expect(fetchTrustedTimeAnchor(wrongHostConfig, wrongHostCandidate, { testCa: tlsCertificate })).rejects.toThrow(/certificate|hostname|altname|subject/u)
  })

  it('rejects requests after five seconds and rejects stale samples without TLS bypasses', async () => {
    const root = await makePair()
    const config = await makeConfig(root, tlsIssuer)
    const token = await bundle(root, tlsIssuer, { version: '1', keys: [await publicEntry(tlsCenter)] })
    const candidate = await verifyTrustBundleSignature(token, { trustedRoot: config.offline_root, expectedCenterIssuer: tlsIssuer })
    tlsMode = 'slow'
    await expect(fetchTrustedTimeAnchor(config, candidate, { testCa: tlsCertificate })).rejects.toThrow(/timed out|5000|round trip/u)
    expect(fetchTrustedTimeAnchor.toString()).not.toContain('rejectUnauthorized: false')
  }, 10_000)
})

describe('historical lease evidence separation', () => {
  it('returns a distinct expired evidence type with no current-permission flag', async () => {
    const root = await makePair()
    const center = await makePair()
    const token = await bundle(root, CENTER_ISSUER, {
      version: '1', keys: [await publicEntry(center, { not_before: BASE - 20 * DAY })],
    })
    const directory = await temporaryStoreDirectory()
    const store = storeFor(directory, root)
    const accepted = await store.accept(token, BASE + DAY)
    const expiredLease = await signedLease(center, BASE - 8 * DAY, BASE + 1)
    const evidence = await verifyExpiredHistoricalLease(expiredLease, {
      resolver: accepted.resolver,
      issuer: CENTER_ISSUER,
      trustedTime: BASE + DAY,
      identity: leaseIdentity(expiredLease),
    })
    expect(evidence).toMatchObject({ purpose: 'expired_historical_lease', signatureVerified: true })
    expect(evidence).not.toHaveProperty('canCreateOrder')
    await expect(verifyCurrentLicenseLease(expiredLease, {
      resolver: accepted.resolver,
      issuer: CENTER_ISSUER,
      trustedTime: BASE + DAY,
      identity: leaseIdentity(expiredLease),
    })).rejects.toThrow(/expired|time claims/u)
  })
})
