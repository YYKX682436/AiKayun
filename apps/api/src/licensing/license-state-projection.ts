import { createHash } from 'node:crypto'
import { decodeProtectedHeader } from 'jose'
import { sql } from 'kysely'
import type { Kysely, Selectable, Transaction } from 'kysely'
import type { Database, InstanceLicenseStateTable } from '../db/types.js'
import { InstallationIdentityError, verifyInstallationIdentityInTransaction, withVerifiedInstallationSigningContext } from './installation-identity.js'
import { sha256Base64url } from './license-intent.js'
import { parseStrictJson } from './strict-json.js'
import {
  decryptLicensePendingBytes,
  encryptLicensePendingBytes,
  loadLicensePendingKey,
} from './pending-encryption-key.js'
import type { LicenseOperationRecoveryClientOptions, PersistedLicenseProjectionHistory } from './license-operation-recovery-client.js'
import {
  LicenseOperationRecoveryError,
  readPersistedLicenseProjectionHistory,
  readVerifiedPersistedRecoveryQueryResult,
} from './license-operation-recovery-client.js'
import { fetchTrustedTimeAnchor, getTrustedCenterContactState } from './trust/time-anchor-client.js'
import { advanceLicenseTrustedTime, LicenseClockSuspectError } from './license-trusted-time.js'
import { readTrustedTimeWatermark } from './trusted-time-watermark.js'
import {
  verifyCurrentLicenseLease,
  verifyExpiredHistoricalLease,
  verifyExpiredHistoricalLicenseChallenge,
  verifyExpiredHistoricalStatusReceipt,
  verifyLicenseChallenge,
  verifyLicenseStatusReceipt,
} from './trust/evidence.js'
import type { AcceptedTrustBundle } from './trust/trust-bundle-store.js'

const JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DECIMAL = /^[1-9][0-9]{0,18}$/u

export type LicenseProjectionCheckpoint =
  | 'after_projection_row_locked'
  | 'after_projection_binding_locked'
  | 'after_projection_row_update'
  | 'after_projection_commit'

export interface LicenseStateProjectionOptions extends LicenseOperationRecoveryClientOptions {
  /** Fault injection for isolated transaction and process-crash tests only. */
  readonly onProjectionTestCheckpoint?: (stage: LicenseProjectionCheckpoint) => void | Promise<void>
  /** Deterministic wall-clock projection for isolated trusted-time boundary tests only. */
  readonly onTrustedTimeTestOverride?: () => {
    databaseTimeMs: number
    signedTimeMs?: number | null
    ignoreProcessAnchor?: boolean
  } | undefined
}

export interface LicenseStateProjectionResult {
  readonly outcome: 'applied' | 'idempotent' | 'historical_only' | 'no_evidence'
  readonly licenseId: string | null
  readonly activationGeneration: string | null
  readonly entitlementRevision: string | null
  readonly credentialId: string | null
  readonly credentialExpiresAt: string | null
  readonly refusalStatus: 'expired' | 'revoked' | 'superseded' | null
  readonly refusalGeneration: string | null
  readonly refusalRevision: string | null
  readonly evidenceDigest: string | null
  readonly commitRecovered?: true
}

export type LicenseSnapshotStatus = 'unactivated' | 'active' | 'offline_valid' | 'expired' | 'offline_expired'
  | 'revoked' | 'superseded' | 'invalid_credential' | 'identity_mismatch' | 'clock_suspect'

export interface LicenseSnapshotResult {
  readonly status: LicenseSnapshotStatus
  readonly reason: string
  readonly allowedUntil: string | null
  readonly nextRenewalAt: string | null
  readonly activationGeneration: string | null
  readonly entitlementRevision: string | null
  readonly canCreateOrder: boolean
  readonly canCreateTopUp: boolean
}

interface CandidateSource {
  history: PersistedLicenseProjectionHistory
  /** Attempt that durably contains the source bytes (the query attempt for receipt results). */
  attemptNo: number
  /** Mutation attempt whose challenge and digest bind the inner result. */
  bindingAttemptNo: number
  purpose: PersistedLicenseProjectionHistory['attempts'][number]['purpose']
  raw: Buffer
  queryReceiptJws: Buffer | null
}

type VerifiedCandidate =
  | Readonly<{
    kind: 'lease'
    source: CandidateSource
    digest: string
    issuedAt: number
    expiresAt: number
    lease: ProjectionLease
  }>
  | Readonly<{
    kind: 'refusal'
    source: CandidateSource
    digest: string
    issuedAt: number
    status: 'expired' | 'revoked' | 'superseded'
    generation: string
    revision: string
    currentGeneration: string
    licenseId: string
    instanceId: string
    databaseId: string
    identityJkt: string
    requestNonce: string
    requestDigest: string
  }>

type InstanceLicenseStateRow = Selectable<InstanceLicenseStateTable>

interface ProjectionLease {
  readonly tokenId: string
  readonly licenseId: string
  readonly instanceId: string
  readonly databaseId: string
  readonly identityJkt: string
  readonly activationGeneration: string
  readonly entitlementRevision: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly requestNonce: string
  readonly requestDigest: string
}

function fail(code: string): never {
  throw new Error(code)
}

function positiveDecimal(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    fail(`license_projection_${field}_invalid`)
  }
  return value
}

function exactJws(raw: Buffer): string | null {
  if (raw.length > 16 * 1024) return null
  const token = raw.toString('ascii')
  return JWS.test(token) && Buffer.from(token, 'ascii').equals(raw) ? token : null
}

async function candidateSources(input: {
  options: LicenseStateProjectionOptions
  history: PersistedLicenseProjectionHistory
  accepted: AcceptedTrustBundle
  trustedTime: number
  identity: { databaseId: string; instanceId: string; identityJkt: string }
}): Promise<CandidateSource[]> {
  const { history } = input
  const output: CandidateSource[] = []
  for (const attempt of history.attempts) {
    if (attempt.purpose === 'query' || attempt.sendState !== 'response_saved') continue
    for (const raw of [attempt.response, attempt.archivedResult]) {
      if (!raw || !exactJws(raw)) continue
      output.push({ history, attemptNo: attempt.attemptNo, bindingAttemptNo: attempt.attemptNo,
        purpose: attempt.purpose, raw, queryReceiptJws: null })
    }
  }
  if (history.operationKind === 'recovery' || history.operationKind === 'renewal') {
    for (const attempt of history.attempts) {
      if (!['query', 'continue'].includes(attempt.purpose) || attempt.sendState !== 'response_saved') continue
      try {
        const verified = await readVerifiedPersistedRecoveryQueryResult({
          options: input.options,
          operationId: history.operationId,
          receiptAttemptNo: attempt.attemptNo,
          identity: input.identity,
          accepted: input.accepted,
          trustedTime: input.trustedTime,
        })
        if (!verified || !exactJws(verified.resultJws)) continue
        const bindingAttempt = history.attempts.find(item => item.attemptNo === verified.committedAttemptNo)
        if (!bindingAttempt || !['recovery', 'renewal', 'continue'].includes(bindingAttempt.purpose)) continue
        output.push({ history, attemptNo: attempt.attemptNo, bindingAttemptNo: bindingAttempt.attemptNo,
          purpose: bindingAttempt.purpose, raw: verified.resultJws, queryReceiptJws: verified.receiptJws })
      } catch (error) {
        if (error instanceof LicenseOperationRecoveryError && error.code === 'operation_recovery_history_result_conflict') {
          throw error
        }
        // Unsigned, malformed, unbound and otherwise untrusted receipts have no projection rights.
      }
    }
  }
  return output
}

function matchingAttempt(history: PersistedLicenseProjectionHistory, attemptNo: number, fromQueryReceipt: boolean) {
  const attempt = history.attempts.find(item => item.attemptNo === attemptNo)
  const allowedState = attempt?.sendState === 'response_saved' ||
    fromQueryReceipt && ['sent', 'transport_unknown'].includes(String(attempt?.sendState))
  if (!attempt || !allowedState || attempt.purpose === 'query') {
    fail('license_projection_source_attempt_invalid')
  }
  return attempt
}

async function verifyCandidate(input: {
  source: CandidateSource
  accepted: AcceptedTrustBundle
  trustedTime: number
  identity: { databaseId: string; instanceId: string; identityJkt: string }
}): Promise<VerifiedCandidate | null> {
  const { source, accepted, trustedTime, identity } = input
  const history = source.history
  const attempt = matchingAttempt(history, source.bindingAttemptNo, source.queryReceiptJws !== null)
  if (history.databaseId !== identity.databaseId || history.instanceId !== identity.instanceId ||
    history.identityJkt !== identity.identityJkt || attempt.requestDigest.length !== 43) return null
  const token = exactJws(source.raw)
  if (!token) return null
  let header: Record<string, unknown>
  try { header = decodeProtectedHeader(token) as Record<string, unknown> } catch { return null }
  const challengeToken = attempt.challengeToken
  let challenge
  try {
    const decodedChallenge = decodeProtectedHeader(challengeToken)
    const claims = JSON.parse(Buffer.from(challengeToken.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    const challengeExpires = claims.exp
    if (decodedChallenge.typ !== 'aikayun-license-challenge+jwt' || !Number.isSafeInteger(challengeExpires)) return null
    challenge = Number(challengeExpires) <= trustedTime
      ? await verifyExpiredHistoricalLicenseChallenge(challengeToken, {
        resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime,
      })
      : await verifyLicenseChallenge(challengeToken, {
        resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime,
      })
  } catch { return null }
  const challengeClaims = challenge.claims
  const created = attempt.signatureCreatedAt.getTime() / 1000
  if (challengeClaims.operation_id !== history.operationId || challengeClaims.intent_digest !== history.intentDigest ||
    challengeClaims.instance_id !== identity.instanceId || challengeClaims.identity_jkt !== identity.identityJkt ||
    challengeClaims.operation !== source.purpose ||
    challengeClaims.sub !== identity.instanceId ||
    typeof challengeClaims.server_nonce !== 'string' || typeof challengeClaims.client_nonce !== 'string' ||
    sha256Base64url(challengeClaims.server_nonce) !== attempt.requestNonceHash ||
    sha256Base64url(challengeClaims.client_nonce) !== attempt.clientNonceHash ||
    !Number.isSafeInteger(created) || created < Number(challengeClaims.iat) || created >= Number(challengeClaims.exp)) {
    return null
  }
  const digest = createHash('sha256').update(source.raw).digest('base64url')
  if (header.typ === 'aikayun-license+jwt') {
    if (history.operationKind === 'activation' && !['activation', 'continue'].includes(source.purpose)) return null
    if (history.operationKind === 'recovery' && !['recovery', 'continue'].includes(source.purpose)) return null
    if (history.operationKind === 'renewal' && !['renewal', 'continue'].includes(source.purpose)) return null
    try {
      const identitySnapshot = {
        status: 'ready' as const, code: 'ready', bindingState: 'ready' as const,
        databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt,
      }
      const decoded = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
      const expired = typeof decoded.exp === 'number' && decoded.exp <= trustedTime
      const checked = expired
        ? await verifyExpiredHistoricalLease(token, {
          resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime, identity: identitySnapshot,
        })
        : await verifyCurrentLicenseLease(token, {
          resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime, identity: identitySnapshot,
        })
      const lease: ProjectionLease = {
        tokenId: checked.tokenId,
        licenseId: checked.licenseId,
        instanceId: checked.instanceId,
        databaseId: checked.databaseId,
        identityJkt: checked.identityJkt,
        activationGeneration: checked.activationGeneration,
        entitlementRevision: checked.entitlementRevision,
        issuedAt: checked.issuedAt,
        expiresAt: expired ? (checked as Awaited<ReturnType<typeof verifyExpiredHistoricalLease>>).expiredAt
          : (checked as Awaited<ReturnType<typeof verifyCurrentLicenseLease>>).expiresAt,
        requestNonce: String(decoded.request_nonce),
        requestDigest: String(decoded.request_digest),
      }
      if (lease.licenseId !== history.licenseId || lease.databaseId !== identity.databaseId ||
        lease.instanceId !== identity.instanceId || lease.identityJkt !== identity.identityJkt ||
        lease.requestNonce !== challengeClaims.server_nonce || lease.requestDigest !== attempt.requestDigest) return null
      if (history.operationKind === 'activation' &&
        (!['activation', 'continue'].includes(source.purpose) || lease.activationGeneration !== '1')) return null
      if ((history.operationKind === 'recovery' || history.operationKind === 'renewal') &&
        (history.recoveryPayload === null || lease.activationGeneration !== history.recoveryPayload.expectedGeneration ||
          BigInt(lease.entitlementRevision) < BigInt(history.recoveryPayload.knownRevision))) return null
      return Object.freeze({ kind: 'lease', source, digest, issuedAt: lease.issuedAt,
        expiresAt: lease.expiresAt, lease })
    } catch { return null }
  }
  if (header.typ !== 'aikayun-license-status+jwt' || !['recovery', 'renewal'].includes(history.operationKind) ||
    !['recovery', 'renewal', 'continue'].includes(source.purpose) || history.recoveryPayload === null) return null
  try {
    const decoded = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    const expired = typeof decoded.exp === 'number' && decoded.exp <= trustedTime
    const status = expired
      ? await verifyExpiredHistoricalStatusReceipt(token, {
        resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime,
      })
      : await verifyLicenseStatusReceipt(token, {
        resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime,
      })
    const claims = status.claims
    if (claims.status !== 'expired' && claims.status !== 'revoked' && claims.status !== 'superseded') return null
    const generation = positiveDecimal(claims.activation_generation, 'status_generation')
    const revision = positiveDecimal(claims.entitlement_revision, 'status_revision')
    const currentGeneration = positiveDecimal(claims.current_generation, 'status_current_generation')
    if (claims.sub !== history.licenseId || claims.instance_id !== identity.instanceId ||
      claims.identity_jkt !== identity.identityJkt || generation !== history.recoveryPayload.expectedGeneration ||
      BigInt(revision) < BigInt(history.recoveryPayload.knownRevision) ||
      claims.request_nonce !== challengeClaims.server_nonce || claims.request_digest !== attempt.requestDigest ||
      BigInt(currentGeneration) < BigInt(generation) ||
      (claims.status === 'superseded' && BigInt(currentGeneration) <= BigInt(generation))) return null
    return Object.freeze({ kind: 'refusal', source, digest,
      issuedAt: Number(claims.iat), status: claims.status, generation, revision, currentGeneration,
      licenseId: history.licenseId, instanceId: identity.instanceId, databaseId: identity.databaseId,
      identityJkt: identity.identityJkt, requestNonce: String(challengeClaims.server_nonce), requestDigest: attempt.requestDigest })
  } catch { return null }
}

function credentialContext(candidate: VerifiedCandidate, field: 'projection_lease_jws' | 'projection_rejection_jws') {
  return { operationId: candidate.source.history.operationId, attemptNo: candidate.source.attemptNo, record: 'attempt' as const, field }
}

function resultFromRow(row: InstanceLicenseStateRow, outcome: LicenseStateProjectionResult['outcome'], evidenceDigest: string | null): LicenseStateProjectionResult {
  return Object.freeze({
    outcome,
    licenseId: row.license_id,
    activationGeneration: row.activation_generation,
    entitlementRevision: row.entitlement_revision,
    credentialId: row.credential_jti,
    credentialExpiresAt: row.credential_expires_at === null ? null : new Date(Number(row.credential_expires_at) * 1000).toISOString(),
    refusalStatus: row.refusal_status,
    refusalGeneration: row.refusal_generation,
    refusalRevision: row.refusal_revision,
    evidenceDigest,
  })
}

function rowFingerprint(row: InstanceLicenseStateRow): string {
  return [row.license_id, row.database_id, row.instance_id, row.identity_jkt, row.activation_generation,
    row.entitlement_revision, row.credential_jti, row.credential_issued_at, row.credential_expires_at,
    row.credential_operation_id, row.credential_attempt_no, row.credential_jws_digest,
    row.credential_encryption_key_id, row.encrypted_credential_jws?.toString('base64url'),
    row.refusal_status, row.refusal_generation, row.refusal_revision, row.refusal_current_generation,
    row.refusal_operation_id, row.refusal_attempt_no, row.refusal_jws_digest,
    row.refusal_encryption_key_id, row.encrypted_refusal_jws?.toString('base64url'), row.trusted_time_high_water_ms,
    row.updated_at.toISOString()].join('|')
}

async function sourceRawMatches(input: {
  options: LicenseStateProjectionOptions
  tx: Kysely<Database>
  candidate: VerifiedCandidate
  accepted: AcceptedTrustBundle
  trustedTime: number
  identity: { databaseId: string; instanceId: string; identityJkt: string }
}): Promise<boolean> {
  const history = await readPersistedLicenseProjectionHistory({
    options: { ...input.options, db: input.tx },
    operationId: input.candidate.source.history.operationId,
    identity: input.identity,
  })
  if (history.licenseId !== input.candidate.source.history.licenseId ||
    history.intentDigest !== input.candidate.source.history.intentDigest ||
    history.operationKind !== input.candidate.source.history.operationKind) return false
  const attempt = history.attempts.find(item => item.attemptNo === input.candidate.source.attemptNo)
  if (!attempt || attempt.sendState !== 'response_saved') return false
  if (input.candidate.source.queryReceiptJws !== null) {
    const recovered = await readVerifiedPersistedRecoveryQueryResult({
      options: { ...input.options, db: input.tx },
      operationId: history.operationId,
      receiptAttemptNo: input.candidate.source.attemptNo,
      identity: input.identity,
      accepted: input.accepted,
      trustedTime: input.trustedTime,
    })
    return recovered !== null && recovered.committedAttemptNo === input.candidate.source.bindingAttemptNo &&
      recovered.receiptJws.equals(input.candidate.source.queryReceiptJws) &&
      recovered.resultJws.equals(input.candidate.source.raw)
  }
  return [attempt.response, attempt.archivedResult].some(raw => raw?.equals(input.candidate.source.raw))
}

async function readAndVerifyStoredEvidence(input: {
  options: LicenseStateProjectionOptions
  tx: Kysely<Database>
  row: InstanceLicenseStateRow
  identity: { databaseId: string; instanceId: string; identityJkt: string }
  kind: 'lease' | 'refusal'
  accepted: AcceptedTrustBundle
  trustedTime: number
}): Promise<void> {
  const lease = input.kind === 'lease'
  const operationId = lease ? input.row.credential_operation_id! : input.row.refusal_operation_id!
  const attemptNo = lease ? input.row.credential_attempt_no! : input.row.refusal_attempt_no!
  const encrypted = lease ? input.row.encrypted_credential_jws! : input.row.encrypted_refusal_jws!
  const keyId = lease ? input.row.credential_encryption_key_id! : input.row.refusal_encryption_key_id!
  const context = {
    operationId, attemptNo, record: 'attempt' as const,
    field: lease ? 'projection_lease_jws' as const : 'projection_rejection_jws' as const,
  }
  const raw = await decryptLicensePendingBytes(input.options.pendingKeyRoot, context, { keyId, ciphertext: encrypted })
  const digest = createHash('sha256').update(raw).digest('base64url')
  if (digest !== (lease ? input.row.credential_jws_digest : input.row.refusal_jws_digest)) {
    fail('license_projection_saved_digest_mismatch')
  }
  const history = await readPersistedLicenseProjectionHistory({
    options: { ...input.options, db: input.tx }, operationId, identity: input.identity,
  })
  const attempt = history.attempts.find(item => item.attemptNo === attemptNo)
  if (!attempt) fail('license_projection_saved_source_mismatch')
  let bindingAttempt = attempt
  const matchesDirectSource = [attempt.response, attempt.archivedResult].some(value => value?.equals(raw))
  if (!matchesDirectSource) {
    const recovered = await readVerifiedPersistedRecoveryQueryResult({
      options: { ...input.options, db: input.tx }, operationId, receiptAttemptNo: attemptNo,
      identity: input.identity, accepted: input.accepted, trustedTime: input.trustedTime,
    })
    if (!recovered || !recovered.resultJws.equals(raw)) fail('license_projection_saved_source_mismatch')
    bindingAttempt = history.attempts.find(item => item.attemptNo === recovered.committedAttemptNo)!
  }
  if (!bindingAttempt) {
    fail('license_projection_saved_source_mismatch')
  }
  const token = exactJws(raw)
  if (!token) fail('license_projection_saved_evidence_invalid')
  const payloadBytes = Buffer.from(token.split('.')[1]!, 'base64url')
  let claimsValue: unknown
  try { claimsValue = parseStrictJson(payloadBytes) } catch { fail('license_projection_saved_evidence_invalid') }
  if (!claimsValue || typeof claimsValue !== 'object' || Array.isArray(claimsValue)) {
    fail('license_projection_saved_evidence_invalid')
  }
  const claims = claimsValue as Record<string, unknown>
  const header = decodeProtectedHeader(token)
  const challengeValue = parseStrictJson(Buffer.from(bindingAttempt.challengeToken.split('.')[1]!, 'base64url'))
  if (!challengeValue || typeof challengeValue !== 'object' || Array.isArray(challengeValue)) {
    fail('license_projection_saved_challenge_invalid')
  }
  const challenge = challengeValue as Record<string, unknown>
  const requestNonce = challenge.server_nonce
  if (typeof requestNonce !== 'string' || sha256Base64url(requestNonce) !== bindingAttempt.requestNonceHash ||
    sha256Base64url(String(claims.request_nonce)) !== bindingAttempt.requestNonceHash ||
    claims.request_digest !== bindingAttempt.requestDigest || claims.iss !== input.options.releaseConfig.expected_center_issuer ||
    claims.aud !== 'aikayun-commerce') {
    fail('license_projection_saved_evidence_mismatch')
  }
  if (lease) {
    if (header.typ !== 'aikayun-license+jwt' || claims.sub !== input.row.license_id ||
      claims.database_id !== input.row.database_id || claims.instance_id !== input.row.instance_id ||
      claims.identity_jkt !== input.row.identity_jkt || claims.activation_generation !== input.row.activation_generation ||
      claims.entitlement_revision !== input.row.entitlement_revision || claims.jti !== input.row.credential_jti ||
      claims.iat !== Number(input.row.credential_issued_at) || claims.exp !== Number(input.row.credential_expires_at)) {
      fail('license_projection_saved_evidence_mismatch')
    }
  } else if (header.typ !== 'aikayun-license-status+jwt' || claims.sub !== input.row.license_id ||
    claims.instance_id !== input.row.instance_id || claims.identity_jkt !== input.row.identity_jkt ||
    claims.activation_generation !== input.row.refusal_generation ||
    claims.entitlement_revision !== input.row.refusal_revision || claims.current_generation !== input.row.refusal_current_generation ||
    claims.status !== input.row.refusal_status) {
    fail('license_projection_saved_evidence_mismatch')
  }
}

/** Identify stored evidence explicitly invalidated by the current root-authenticated bundle. */
async function storedEvidenceSignerIsRevoked(input: {
  options: LicenseStateProjectionOptions
  row: InstanceLicenseStateRow
  accepted: AcceptedTrustBundle
  kind: 'lease' | 'refusal'
}): Promise<boolean> {
  const row = input.row
  const lease = input.kind === 'lease'
  const operationId = lease ? row.credential_operation_id : row.refusal_operation_id
  const attemptNo = lease ? row.credential_attempt_no : row.refusal_attempt_no
  const keyId = lease ? row.credential_encryption_key_id : row.refusal_encryption_key_id
  const ciphertext = lease ? row.encrypted_credential_jws : row.encrypted_refusal_jws
  const digest = lease ? row.credential_jws_digest : row.refusal_jws_digest
  if (!operationId || !attemptNo || !keyId || !ciphertext) return false
  try {
    const raw = await decryptLicensePendingBytes(input.options.pendingKeyRoot, {
      operationId, attemptNo, record: 'attempt', field: lease ? 'projection_lease_jws' : 'projection_rejection_jws',
    }, { keyId, ciphertext })
    if (createHash('sha256').update(raw).digest('base64url') !== digest) return false
    const token = exactJws(raw)
    if (!token) return false
    const header = decodeProtectedHeader(token)
    return header.typ === (lease ? 'aikayun-license+jwt' : 'aikayun-license-status+jwt') && typeof header.kid === 'string' &&
      input.accepted.revokedKids.includes(header.kid)
  } catch { return false }
}

function canReplaceCredential(row: InstanceLicenseStateRow, candidate: Extract<VerifiedCandidate, { kind: 'lease' }>):
  'accept' | 'same' | 'stale' {
  const lease = candidate.lease
  if (row.license_id === null) {
    const initialActivation = candidate.source.history.operationKind === 'activation'
    const boundRecovery = candidate.source.history.operationKind === 'recovery' && candidate.source.history.recoveryPayload !== null
    return lease.activationGeneration === '1' && (initialActivation || boundRecovery) ? 'accept' : 'stale'
  }
  if (lease.licenseId !== row.license_id || lease.databaseId !== row.database_id || lease.instanceId !== row.instance_id ||
    lease.identityJkt !== row.identity_jkt || lease.activationGeneration !== row.activation_generation) return 'stale'
  const revision = BigInt(lease.entitlementRevision)
  const currentRevision = BigInt(row.entitlement_revision!)
  if (lease.tokenId === row.credential_jti) {
    return revision === currentRevision && candidate.digest === row.credential_jws_digest ? 'same' : 'stale'
  }
  if (row.refusal_status === 'superseded') return 'stale'
  if ((row.refusal_status === 'revoked' || row.refusal_status === 'expired') &&
    BigInt(lease.entitlementRevision) <= BigInt(row.refusal_revision!)) return 'stale'
  if (revision < currentRevision) return 'stale'
  if (revision > currentRevision) return 'accept'
  const issuedAt = Number(row.credential_issued_at)
  if (lease.issuedAt > issuedAt) return 'accept'
  return 'stale'
}

async function applyCandidate(input: {
  options: LicenseStateProjectionOptions
  tx: Kysely<Database>
  row: InstanceLicenseStateRow
  candidate: VerifiedCandidate
  accepted: AcceptedTrustBundle
  trustedTime: number
  identity: { databaseId: string; instanceId: string; identityJkt: string }
}): Promise<{ row: InstanceLicenseStateRow; changed: boolean; evidenceDigest: string | null }> {
  const { candidate } = input
  if (!(await sourceRawMatches({
    options: input.options, tx: input.tx, candidate, accepted: input.accepted, trustedTime: input.trustedTime,
    identity: input.identity,
  }))) {
    fail('license_projection_source_changed')
  }
  if (candidate.kind === 'lease') {
    // An expired lease remains historical evidence. It can never replace the durable current credential.
    if (candidate.expiresAt <= input.trustedTime) return { row: input.row, changed: false, evidenceDigest: null }
    const decision = canReplaceCredential(input.row, candidate)
    if (decision !== 'accept') return { row: input.row, changed: false, evidenceDigest: decision === 'same' ? candidate.digest : null }
    const encrypted = await encryptLicensePendingBytes(input.options.pendingKeyRoot,
      credentialContext(candidate, 'projection_lease_jws'), candidate.source.raw)
    const values = {
      license_id: candidate.lease.licenseId,
      database_id: candidate.lease.databaseId,
      instance_id: candidate.lease.instanceId,
      identity_jkt: candidate.lease.identityJkt,
      activation_generation: candidate.lease.activationGeneration,
      entitlement_revision: candidate.lease.entitlementRevision,
      credential_jti: candidate.lease.tokenId,
      credential_issued_at: String(candidate.issuedAt),
      credential_expires_at: String(candidate.expiresAt),
      credential_operation_id: candidate.source.history.operationId,
      credential_attempt_no: candidate.source.attemptNo,
      credential_jws_digest: candidate.digest,
      credential_encryption_key_id: encrypted.keyId,
      encrypted_credential_jws: encrypted.ciphertext,
    }
    await input.tx.updateTable('instance_license_state').set(values).where('singleton', '=', true).executeTakeFirstOrThrow()
    const row = await input.tx.selectFrom('instance_license_state').selectAll().where('singleton', '=', true).executeTakeFirstOrThrow()
    return { row, changed: true, evidenceDigest: candidate.digest }
  }
  const initializesRefusalOnlyState = input.row.license_id === null &&
    candidate.source.history.operationKind === 'recovery' && candidate.source.history.recoveryPayload !== null &&
    candidate.generation === candidate.source.history.recoveryPayload.expectedGeneration
  if ((!initializesRefusalOnlyState && input.row.license_id === null) ||
    input.row.license_id !== null && (candidate.licenseId !== input.row.license_id ||
      candidate.databaseId !== input.row.database_id || candidate.instanceId !== input.row.instance_id ||
      candidate.identityJkt !== input.row.identity_jkt || candidate.generation !== input.row.activation_generation)) {
    return { row: input.row, changed: false, evidenceDigest: null }
  }
  if (input.row.refusal_status === 'superseded') return { row: input.row, changed: false, evidenceDigest: null }
  if (input.row.refusal_status !== null && BigInt(candidate.revision) < BigInt(input.row.refusal_revision!)) {
    return { row: input.row, changed: false, evidenceDigest: null }
  }
  if (candidate.status === 'superseded' && BigInt(candidate.currentGeneration) <= BigInt(candidate.generation)) {
    return { row: input.row, changed: false, evidenceDigest: null }
  }
  // At one revision a signed revocation must never be downgraded to expiry by an older response.
  if (input.row.refusal_status === 'revoked' && candidate.status === 'expired' &&
    candidate.revision === input.row.refusal_revision) return { row: input.row, changed: false, evidenceDigest: null }
  if (input.row.refusal_status === candidate.status && input.row.refusal_revision === candidate.revision) {
    return { row: input.row, changed: false, evidenceDigest: input.row.refusal_jws_digest }
  }
  const encrypted = await encryptLicensePendingBytes(input.options.pendingKeyRoot,
    credentialContext(candidate, 'projection_rejection_jws'), candidate.source.raw)
  await input.tx.updateTable('instance_license_state').set({
    ...(initializesRefusalOnlyState ? {
      license_id: candidate.licenseId,
      database_id: candidate.databaseId,
      instance_id: candidate.instanceId,
      identity_jkt: candidate.identityJkt,
      activation_generation: candidate.generation,
      entitlement_revision: candidate.revision,
    } : {}),
    refusal_status: candidate.status,
    refusal_generation: candidate.generation,
    refusal_revision: candidate.revision,
    refusal_current_generation: candidate.currentGeneration,
    refusal_operation_id: candidate.source.history.operationId,
    refusal_attempt_no: candidate.source.attemptNo,
    refusal_jws_digest: candidate.digest,
    refusal_encryption_key_id: encrypted.keyId,
    encrypted_refusal_jws: encrypted.ciphertext,
  }).where('singleton', '=', true).executeTakeFirstOrThrow()
  const row = await input.tx.selectFrom('instance_license_state').selectAll().where('singleton', '=', true).executeTakeFirstOrThrow()
  return { row, changed: true, evidenceDigest: candidate.digest }
}

export function createLicenseStateProjectionClient(options: LicenseStateProjectionOptions) {
  if ((options.onProjectionTestCheckpoint || options.onTrustedTimeTestOverride) && process.env.NODE_ENV !== 'test') {
    throw new Error('License projection fault injection is restricted to isolated tests')
  }
  const checkpoint = async (stage: LicenseProjectionCheckpoint) => options.onProjectionTestCheckpoint?.(stage)
  const denied = (status: LicenseSnapshotStatus, reason: string, values: {
    allowedUntil?: string | null
    nextRenewalAt?: string | null
    activationGeneration?: string | null
    entitlementRevision?: string | null
  } = {}): LicenseSnapshotResult => Object.freeze({
    status, reason,
    allowedUntil: values.allowedUntil ?? null,
    nextRenewalAt: values.nextRenewalAt ?? null,
    activationGeneration: values.activationGeneration ?? null,
    entitlementRevision: values.entitlementRevision ?? null,
    canCreateOrder: false,
    canCreateTopUp: false,
  })
  // The same verifier serves diagnostic snapshots and transaction-bound admission.
  // The caller supplies its existing transaction, so no independent commit can
  // separate this decision from the business insert.
  const snapshotInTransaction = async (tx: Transaction<Database>, identity: { databaseId: string; instanceId: string; identityJkt: string }, admission = false): Promise<LicenseSnapshotResult> => {
    const binding = await tx.selectFrom('installation_binding').selectAll()
      .where('singleton', '=', true).forUpdate().executeTakeFirst()
    if (!binding || binding.binding_state !== 'ready' || binding.database_id !== identity.databaseId ||
      binding.instance_id !== identity.instanceId || binding.identity_jkt !== identity.identityJkt) {
      return denied('identity_mismatch', 'installation_binding_mismatch')
    }
    const row = await tx.selectFrom('instance_license_state').selectAll()
      .where('singleton', '=', true).forUpdate().executeTakeFirst()
    if (!row) return denied('invalid_credential', 'license_state_unavailable')
    // Hold trust state until the surrounding business transaction finishes.
    if (admission) await options.trustStore.holdForTransaction()
    if (row.license_id === null && row.credential_jti === null && row.refusal_status === null &&
      row.trusted_time_high_water_ms === null) {
      await loadLicensePendingKey(options.pendingKeyRoot)
      const watermark = await readTrustedTimeWatermark(options.pendingKeyRoot, {
        databaseId: identity.databaseId,
        instanceId: identity.instanceId,
        identityJkt: identity.identityJkt,
      })
      if (watermark.status === 'missing') return denied('unactivated', 'no_accepted_license_lease')
      return denied('clock_suspect', watermark.status === 'valid'
        ? 'watermark_database_missing'
        : 'watermark_identity_mismatch')
    }
    let time: { readonly trustedTimeMs: number; readonly trustedTimeSeconds: number }
    try {
      const testTime = options.onTrustedTimeTestOverride?.()
      time = await advanceLicenseTrustedTime({
        tx,
        row,
        pendingRoot: options.pendingKeyRoot,
        identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
        ...(testTime === undefined ? {} : {
          databaseTimeMs: testTime.databaseTimeMs,
          signedTimeMs: testTime.signedTimeMs,
          ...(testTime.ignoreProcessAnchor ? { useProcessAnchor: false } : {}),
        }),
      })
    } catch (error) {
      if (error instanceof LicenseClockSuspectError) return denied('clock_suspect', error.reason)
      throw error
    }
    const currentRow = await tx.selectFrom('instance_license_state').selectAll()
      .where('singleton', '=', true).executeTakeFirstOrThrow()
    if (currentRow.license_id === null && currentRow.credential_jti === null && currentRow.refusal_status === null) {
      return denied('unactivated', 'no_accepted_license_lease')
    }
    if (currentRow.database_id !== null && currentRow.database_id !== identity.databaseId ||
      currentRow.instance_id !== null && currentRow.instance_id !== identity.instanceId ||
      currentRow.identity_jkt !== null && currentRow.identity_jkt !== identity.identityJkt) {
      return denied('identity_mismatch', 'license_projection_identity_mismatch')
    }
    const acceptedBundle = await options.trustStore.getAccepted(() => time.trustedTimeSeconds)
    // Track every key selected by the existing verifiers, including keys used
    // for recovery receipts and historical source evidence.
    let earliestKeyVerificationEnd = Number.POSITIVE_INFINITY
    const accepted: AcceptedTrustBundle = { ...acceptedBundle, resolver: {
      async resolveKey(input) {
        const key = await acceptedBundle.resolver.resolveKey(input)
        if (key.verifyUntil !== null) earliestKeyVerificationEnd = Math.min(earliestKeyVerificationEnd, key.verifyUntil)
        return key
      },
    } }
    if (accepted.centerIssuer !== options.releaseConfig.expected_center_issuer) {
      return denied('invalid_credential', 'trust_store_unavailable')
    }
    const localIdentity = {
      databaseId: identity.databaseId,
      instanceId: identity.instanceId,
      identityJkt: identity.identityJkt,
    }
    const snapshotIdentity = {
      status: 'ready' as const,
      code: 'ready',
      bindingState: 'ready' as const,
      ...localIdentity,
    }
    let leaseValues: {
      token: Buffer
      issuedAt: number
      expiresAt: number
      subscriptionEnd: number
      renewAfter: number
      generation: string
      revision: string
    } | null = null
    if (currentRow.credential_jti !== null) {
      await readAndVerifyStoredEvidence({
        options, tx, row: currentRow, identity: localIdentity, kind: 'lease', accepted,
        trustedTime: time.trustedTimeSeconds,
      })
      const token = await decryptLicensePendingBytes(options.pendingKeyRoot, {
        operationId: currentRow.credential_operation_id!, attemptNo: currentRow.credential_attempt_no!,
        record: 'attempt', field: 'projection_lease_jws',
      }, { keyId: currentRow.credential_encryption_key_id!, ciphertext: currentRow.encrypted_credential_jws! })
      const encoded = exactJws(token)
      if (!encoded) return denied('invalid_credential', 'saved_lease_invalid')
      const claimsValue = parseStrictJson(Buffer.from(encoded.split('.')[1]!, 'base64url'))
      if (!claimsValue || typeof claimsValue !== 'object' || Array.isArray(claimsValue)) {
        return denied('invalid_credential', 'saved_lease_invalid')
      }
      const claims = claimsValue as Record<string, unknown>
      const issuedAt = claims.iat
      const expiresAt = claims.exp
      const subscriptionEnd = claims.subscription_end
      const renewAfter = claims.renew_after
      if (![issuedAt, expiresAt, subscriptionEnd, renewAfter].every(Number.isSafeInteger) ||
        typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || typeof subscriptionEnd !== 'number' ||
        typeof renewAfter !== 'number' || claims.jti !== currentRow.credential_jti ||
        claims.activation_generation !== currentRow.activation_generation ||
        claims.entitlement_revision !== currentRow.entitlement_revision) {
        return denied('invalid_credential', 'saved_lease_invalid')
      }
      if (expiresAt <= time.trustedTimeSeconds) {
        await verifyExpiredHistoricalLease(encoded, {
          resolver: accepted.resolver,
          issuer: accepted.centerIssuer,
          trustedTime: time.trustedTimeSeconds,
          identity: snapshotIdentity,
        })
      } else {
        await verifyCurrentLicenseLease(encoded, {
          resolver: accepted.resolver,
          issuer: accepted.centerIssuer,
          trustedTime: time.trustedTimeSeconds,
          identity: snapshotIdentity,
        })
      }
      leaseValues = {
        token, issuedAt, expiresAt, subscriptionEnd, renewAfter,
        generation: currentRow.activation_generation!,
        revision: currentRow.entitlement_revision!,
      }
    }
    let refusalSubscriptionEnd: number | null = null
    if (currentRow.refusal_status !== null) {
      const supersededRevokedRefusal = currentRow.refusal_status !== 'superseded' && leaseValues !== null &&
        BigInt(leaseValues.revision) > BigInt(currentRow.refusal_revision!) &&
        await storedEvidenceSignerIsRevoked({ options, row: currentRow, accepted, kind: 'refusal' })
      try {
        await readAndVerifyStoredEvidence({
          options, tx, row: currentRow, identity: localIdentity, kind: 'refusal', accepted,
          trustedTime: time.trustedTimeSeconds,
        })
      } catch (error) {
        if (!supersededRevokedRefusal) throw error
      }
      const token = await decryptLicensePendingBytes(options.pendingKeyRoot, {
        operationId: currentRow.refusal_operation_id!, attemptNo: currentRow.refusal_attempt_no!,
        record: 'attempt', field: 'projection_rejection_jws',
      }, { keyId: currentRow.refusal_encryption_key_id!, ciphertext: currentRow.encrypted_refusal_jws! })
      const encoded = exactJws(token)
      if (!encoded) return denied('invalid_credential', 'saved_refusal_invalid')
      const claimsValue = parseStrictJson(Buffer.from(encoded.split('.')[1]!, 'base64url'))
      if (!claimsValue || typeof claimsValue !== 'object' || Array.isArray(claimsValue)) {
        return denied('invalid_credential', 'saved_refusal_invalid')
      }
      const claims = claimsValue as Record<string, unknown>
      const expiry = claims.exp
      if (typeof expiry !== 'number' || !Number.isSafeInteger(expiry)) {
        return denied('invalid_credential', 'saved_refusal_invalid')
      }
      const status = supersededRevokedRefusal ? { claims } : expiry <= time.trustedTimeSeconds
        ? await verifyExpiredHistoricalStatusReceipt(encoded, {
          resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime: time.trustedTimeSeconds,
        })
        : await verifyLicenseStatusReceipt(encoded, {
          resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime: time.trustedTimeSeconds,
        })
      if (status.claims.status !== currentRow.refusal_status || status.claims.sub !== currentRow.license_id ||
        status.claims.activation_generation !== currentRow.refusal_generation ||
        status.claims.entitlement_revision !== currentRow.refusal_revision ||
        status.claims.current_generation !== currentRow.refusal_current_generation) {
        return denied('invalid_credential', 'saved_refusal_mismatch')
      }
      refusalSubscriptionEnd = Number(status.claims.subscription_end)
    }
    // Evidence and history verification may take time. Resample the database clock
    // while both locks are still held immediately before the decision.
    try {
      const testTime = options.onTrustedTimeTestOverride?.()
      time = await advanceLicenseTrustedTime({
        tx, row: currentRow, pendingRoot: options.pendingKeyRoot,
        identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
        ...(testTime === undefined ? {} : {
          databaseTimeMs: testTime.databaseTimeMs, signedTimeMs: testTime.signedTimeMs,
          ...(testTime.ignoreProcessAnchor ? { useProcessAnchor: false } : {}),
        }),
      })
    } catch (error) {
      if (error instanceof LicenseClockSuspectError) return denied('clock_suspect', error.reason)
      throw error
    }
    const latest = await options.trustStore.getAccepted(() => time.trustedTimeSeconds)
    if (latest.artifactSha256 !== accepted.artifactSha256 || latest.bundleVersion !== accepted.bundleVersion ||
      latest.revokedKids.join(',') !== accepted.revokedKids.join(',') ||
      latest.retiredKids.join(',') !== accepted.retiredKids.join(',')) {
      return denied('invalid_credential', 'trust_store_changed')
    }
    // getAccepted can wait on its file lock. Persist the resulting time floor
    // in the file first and in this transaction second, before the final cutoff
    // check. A failed business transaction can leave only the file ahead.
    try {
      const testTime = options.onTrustedTimeTestOverride?.()
      time = await advanceLicenseTrustedTime({
        tx, row: currentRow, pendingRoot: options.pendingKeyRoot,
        identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
        ...(testTime === undefined ? {} : {
          databaseTimeMs: testTime.databaseTimeMs, signedTimeMs: testTime.signedTimeMs,
          ...(testTime.ignoreProcessAnchor ? { useProcessAnchor: false } : {}),
        }),
      })
    } catch (error) {
      if (error instanceof LicenseClockSuspectError) return denied('clock_suspect', error.reason)
      throw error
    }
    // Sample once more after the file fsync. This is a conservative cutoff
    // check, not a persisted anchor; it cannot extend the signed deadline.
    const clock = await sql<{ now_ms: string }>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms`.execute(tx)
    const wallMs = options.onTrustedTimeTestOverride?.()?.databaseTimeMs ?? Number(clock.rows[0]?.now_ms)
    if (!Number.isSafeInteger(wallMs) || wallMs <= 0) throw new Error('license_trusted_database_clock_unavailable')
    if (wallMs + 60_000 < time.trustedTimeMs) return denied('clock_suspect', 'clock_rollback')
    const decisionTimeMs = Math.max(time.trustedTimeMs, wallMs)
    const decisionTimeSeconds = Math.floor(decisionTimeMs / 1000)
    if (decisionTimeSeconds < latest.claims.nbf || decisionTimeSeconds < latest.claims.iat || decisionTimeSeconds >= latest.claims.exp ||
      decisionTimeSeconds >= earliestKeyVerificationEnd) {
      return denied('invalid_credential', 'trust_store_unavailable')
    }
    const refusalBlocks = currentRow.refusal_status === 'superseded' ||
      (currentRow.refusal_status === 'revoked' || currentRow.refusal_status === 'expired') &&
        (!leaseValues || BigInt(leaseValues.revision) <= BigInt(currentRow.refusal_revision!))
    const allowedUntil = leaseValues === null ? null : Math.min(leaseValues.expiresAt, leaseValues.subscriptionEnd,
      refusalBlocks && currentRow.refusal_status === 'expired' && refusalSubscriptionEnd !== null
        ? refusalSubscriptionEnd : Number.POSITIVE_INFINITY)
    const dates = {
      allowedUntil: allowedUntil === null ? null : new Date(allowedUntil * 1000).toISOString(),
      nextRenewalAt: leaseValues === null ? null : new Date(leaseValues.renewAfter * 1000).toISOString(),
      activationGeneration: currentRow.activation_generation,
      entitlementRevision: currentRow.entitlement_revision,
    }
    if (currentRow.refusal_status === 'superseded') return denied('superseded', 'accepted_superseded_evidence', dates)
    if (refusalBlocks && currentRow.refusal_status === 'revoked') return denied('revoked', 'accepted_revocation_not_superseded', dates)
    if (refusalBlocks && currentRow.refusal_status === 'expired') return denied('expired', 'accepted_subscription_expiry_not_superseded', dates)
    if (!leaseValues || allowedUntil === null) return denied('invalid_credential', 'no_current_lease', dates)
    if (decisionTimeMs >= allowedUntil * 1000) {
      if (decisionTimeMs >= leaseValues.subscriptionEnd * 1000) {
        return denied('expired', 'subscription_end_reached', dates)
      }
      return denied(getTrustedCenterContactState() === 'unavailable' ? 'offline_expired' : 'expired',
        getTrustedCenterContactState() === 'unavailable' ? 'center_unavailable_after_lease_expiry' : 'lease_expired', dates)
    }
    const offline = getTrustedCenterContactState() === 'unavailable'
    return Object.freeze({
      status: offline ? 'offline_valid' : 'active',
      reason: offline ? 'trusted_center_connection_failed' : 'lease_within_signed_window',
      ...dates,
      canCreateOrder: true,
      canCreateTopUp: true,
    })
  }
  const getLicenseSnapshotInTransaction = async (tx: Transaction<Database>): Promise<LicenseSnapshotResult> => {
    return options.trustStore.withDatabaseTransaction(tx, async () => {
      // Serialize identity file/journal validation with binding updates before taking the state lock.
      await tx.selectFrom('installation_binding').select('singleton').where('singleton', '=', true).forUpdate().executeTakeFirst()
      const identity = await verifyInstallationIdentityInTransaction(tx, options.identityRoot)
      return snapshotInTransaction(tx, identity, true)
    })
  }
  const getLicenseSnapshot = async (): Promise<LicenseSnapshotResult> => {
    try {
      return await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, identity =>
        options.db.transaction().execute(tx => options.trustStore.withDatabaseTransaction(tx,
          () => snapshotInTransaction(tx, identity))))
    } catch (error) {
      if (error instanceof LicenseClockSuspectError) return denied('clock_suspect', error.reason)
      if (error instanceof InstallationIdentityError) return denied('identity_mismatch', 'installation_identity_unavailable')
      return denied('invalid_credential', 'license_evidence_unavailable')
    }
  }

  return Object.freeze({
    getLicenseSnapshot,
    getLicenseSnapshotInTransaction,
    /** Narrow, fail-closed eligibility to seek fresh evidence; never grants a license. */
    async canRenewAfterSignerRevocation(): Promise<boolean> {
      try {
        return await withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async identity =>
          options.db.transaction().execute(async tx => options.trustStore.withDatabaseTransaction(tx, async () => {
            const binding = await tx.selectFrom('installation_binding').selectAll()
              .where('singleton', '=', true).forUpdate().executeTakeFirst()
            if (!binding || binding.binding_state !== 'ready' || binding.database_id !== identity.databaseId ||
              binding.instance_id !== identity.instanceId || binding.identity_jkt !== identity.identityJkt) return false
            const row = await tx.selectFrom('instance_license_state').selectAll()
              .where('singleton', '=', true).forUpdate().executeTakeFirst()
            if (!row?.license_id || (!row.credential_jti && !row.refusal_status) || row.refusal_status === 'superseded' ||
              row.database_id !== identity.databaseId || row.instance_id !== identity.instanceId ||
              row.identity_jkt !== identity.identityJkt) return false
            const localIdentity = { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt }
            const time = await advanceLicenseTrustedTime({ tx, row, pendingRoot: options.pendingKeyRoot, identity: localIdentity })
            const accepted = await options.trustStore.getAccepted(() => time.trustedTimeSeconds)
            if (accepted.centerIssuer !== options.releaseConfig.expected_center_issuer) return false
            let sawRevokedSigner = false
            const evidenceKinds: Array<'lease' | 'refusal'> = []
            if (row.credential_jti) evidenceKinds.push('lease')
            if (row.refusal_status !== null) evidenceKinds.push('refusal')
            for (const kind of evidenceKinds) {
              // A revoked query receipt cannot currently establish this source; leave it fail closed.
              await readAndVerifyStoredEvidence({ options, tx, row, identity: localIdentity, kind, accepted,
                trustedTime: time.trustedTimeSeconds })
              const revoked = await storedEvidenceSignerIsRevoked({ options, row, accepted, kind })
              if (revoked) { sawRevokedSigner = true; continue }
              const lease = kind === 'lease'
              const raw = await decryptLicensePendingBytes(options.pendingKeyRoot, {
                operationId: (lease ? row.credential_operation_id : row.refusal_operation_id)!,
                attemptNo: (lease ? row.credential_attempt_no : row.refusal_attempt_no)!, record: 'attempt',
                field: lease ? 'projection_lease_jws' : 'projection_rejection_jws',
              }, { keyId: (lease ? row.credential_encryption_key_id : row.refusal_encryption_key_id)!,
                ciphertext: (lease ? row.encrypted_credential_jws : row.encrypted_refusal_jws)! })
              const token = exactJws(raw)
              if (!token) return false
              const claims = parseStrictJson(Buffer.from(token.split('.')[1]!, 'base64url')) as Record<string, unknown>
              if (!claims || !Number.isSafeInteger(claims.exp)) return false
              const expired = Number(claims.exp) <= time.trustedTimeSeconds
              if (lease) {
                const identitySnapshot = { status: 'ready' as const, code: 'ready', bindingState: 'ready' as const, ...localIdentity }
                if (expired) await verifyExpiredHistoricalLease(token, { resolver: accepted.resolver, issuer: accepted.centerIssuer,
                  trustedTime: time.trustedTimeSeconds, identity: identitySnapshot })
                else await verifyCurrentLicenseLease(token, { resolver: accepted.resolver, issuer: accepted.centerIssuer,
                  trustedTime: time.trustedTimeSeconds, identity: identitySnapshot })
              } else if (expired) await verifyExpiredHistoricalStatusReceipt(token, {
                resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime: time.trustedTimeSeconds,
              })
              else await verifyLicenseStatusReceipt(token, {
                resolver: accepted.resolver, issuer: accepted.centerIssuer, trustedTime: time.trustedTimeSeconds,
              })
            }
            const latest = await options.trustStore.getAccepted(() => time.trustedTimeSeconds)
            return sawRevokedSigner && latest.artifactSha256 === accepted.artifactSha256
          })))
      } catch { return false }
    },
    /** The only write entrypoint: all candidate bytes are loaded from and rebound to persisted operation history. */
    async projectPersistedOperation(operationId: string): Promise<LicenseStateProjectionResult> {
      if (!UUID.test(operationId)) fail('license_projection_operation_id_invalid')
      return withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async identity => {
        const target = await options.db.selectFrom('local_license_operations').selectAll()
          .where('operation_id', '=', operationId).executeTakeFirst()
        if (!target || !['activation', 'recovery', 'renewal'].includes(target.kind) ||
          target.database_id !== identity.databaseId || target.instance_id !== identity.instanceId ||
          target.identity_jkt !== identity.identityJkt) fail('license_projection_operation_unavailable')
        const candidateBundle = await options.trustStore.getCandidateForTimeBootstrap()
        if (!candidateBundle || candidateBundle.claims.sub !== options.releaseConfig.expected_center_issuer) {
          fail('license_projection_trust_unavailable')
        }
        const sample = await fetchTrustedTimeAnchor(options.releaseConfig, candidateBundle,
          options.testTls === undefined ? {} : {
            ...(options.testTls.ca === undefined ? {} : { testCa: options.testTls.ca }),
            ...(options.testTls.lookup === undefined ? {} : { testLookup: options.testTls.lookup }),
          })

        const transactionCommit: { fingerprint?: string; result?: LicenseStateProjectionResult; acceptedArtifactSha256?: string; renewalFinalized?: boolean } = {}
        let transactionOutcome: { result: LicenseStateProjectionResult; fingerprint: string }
        try {
          transactionOutcome = await options.db.transaction().execute(async tx => options.trustStore.withDatabaseTransaction(tx, async () => {
          const binding = await tx.selectFrom('installation_binding').selectAll()
            .where('singleton', '=', true).forUpdate().executeTakeFirst()
          if (!binding || binding.binding_state !== 'ready' || binding.database_id !== identity.databaseId ||
            binding.instance_id !== identity.instanceId || binding.identity_jkt !== identity.identityJkt) {
            fail('license_projection_identity_changed')
          }
          await checkpoint('after_projection_binding_locked')
          let row = await tx.selectFrom('instance_license_state').selectAll()
            .where('singleton', '=', true).forUpdate().executeTakeFirst()
          if (!row) fail('license_projection_singleton_missing')
          await checkpoint('after_projection_row_locked')
          const testTime = options.onTrustedTimeTestOverride?.()
          const time = await advanceLicenseTrustedTime({
            tx,
            row,
            pendingRoot: options.pendingKeyRoot,
            identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
            signedTimeMs: testTime?.signedTimeMs ?? sample.readCurrentTrustedTimeMs(),
            ...(testTime === undefined ? {} : { databaseTimeMs: testTime.databaseTimeMs }),
            ...(testTime?.ignoreProcessAnchor ? { useProcessAnchor: false } : {}),
          })
          const trustedTime = time.trustedTimeSeconds
          sample.assertFresh()
          const accepted = await options.trustStore.getAccepted(() => trustedTime)
          if (accepted.centerIssuer !== options.releaseConfig.expected_center_issuer) fail('license_projection_trust_mismatch')
          transactionCommit.acceptedArtifactSha256 = accepted.artifactSha256
          row = await tx.selectFrom('instance_license_state').selectAll().where('singleton', '=', true).executeTakeFirstOrThrow()
          let revokedLeaseSourceError: unknown
          const oldCredentialDigest = row.credential_jws_digest
          if (row.license_id !== null && row.credential_jti !== null) {
            try {
              await readAndVerifyStoredEvidence({
                options, tx, row,
                identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
                kind: 'lease', accepted, trustedTime,
              })
            } catch (error) {
              if (target.kind !== 'renewal' || !(await storedEvidenceSignerIsRevoked({ options, row, accepted, kind: 'lease' }))) throw error
              revokedLeaseSourceError = error
            }
          }
          let revokedRefusalSourceError: unknown
          if (row.license_id !== null && row.refusal_status !== null) {
            try {
              await readAndVerifyStoredEvidence({
                options, tx, row,
                identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
                kind: 'refusal', accepted, trustedTime,
              })
            } catch (error) {
              if (target.kind !== 'renewal' || row.refusal_status === 'superseded' ||
                !(await storedEvidenceSignerIsRevoked({ options, row, accepted, kind: 'refusal' }))) throw error
              revokedRefusalSourceError = error
            }
          }
          const rows = await tx.selectFrom('local_license_operations').select(['operation_id', 'kind'])
            .where('license_id', '=', target.license_id).where('database_id', '=', identity.databaseId)
            .where('instance_id', '=', identity.instanceId).where('identity_jkt', '=', identity.identityJkt)
            .where(eb => eb.or([
              eb('state', '=', 'response_saved'),
              eb.and([eb('state', '=', 'projected'), eb('operation_id', '=', operationId)]),
            ])).where('kind', 'in', ['activation', 'recovery', 'renewal'])
            .orderBy('created_at', 'asc').execute()
          const candidates: CandidateSource[] = []
          for (const item of rows) {
            const history = await readPersistedLicenseProjectionHistory({
              options: { ...options, db: tx }, operationId: item.operation_id,
              identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
            })
            try {
              candidates.push(...await candidateSources({
                options: { ...options, db: tx }, history, accepted, trustedTime,
                identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
              }))
            } catch (error) {
              // An immutable conflicting archive on a different operation cannot invalidate a
              // newly verified result. The requested operation itself must still fail closed.
              if (item.operation_id === operationId || !(error instanceof LicenseOperationRecoveryError) ||
                error.code !== 'operation_recovery_history_result_conflict') throw error
            }
          }
          const verified: VerifiedCandidate[] = []
          for (const source of candidates) {
            const item = await verifyCandidate({
              source, accepted, trustedTime,
              identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
            })
            if (item) verified.push(item)
          }
          if (target.kind === 'recovery') {
            const targetHistory = await readPersistedLicenseProjectionHistory({
              options: { ...options, db: tx }, operationId, identity: {
                databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt,
              },
            })
            const recoveryOf = targetHistory.recoveryPayload?.recoveryOfOperationId
            const activationSource = rows.find(item => item.operation_id === recoveryOf && item.kind === 'activation')
            if (!activationSource || !verified.some(item => item.source.history.operationId === operationId)) {
              fail('license_projection_recovery_source_unverified')
            }
          }
          let current = row
          let changed = false
          let historical = false
          let evidenceDigest: string | null = null
          const leaseCandidates = verified.filter((item): item is Extract<VerifiedCandidate, { kind: 'lease' }> => item.kind === 'lease')
              .sort((a, b) => BigInt(a.lease.activationGeneration) < BigInt(b.lease.activationGeneration) ? -1 :
                BigInt(a.lease.activationGeneration) > BigInt(b.lease.activationGeneration) ? 1 :
                  BigInt(a.lease.entitlementRevision) < BigInt(b.lease.entitlementRevision) ? -1 :
                    BigInt(a.lease.entitlementRevision) > BigInt(b.lease.entitlementRevision) ? 1 : a.issuedAt - b.issuedAt)
          const refusalCandidates = verified.filter((item): item is Extract<VerifiedCandidate, { kind: 'refusal' }> => item.kind === 'refusal')
            .sort((a, b) => {
              if (a.status !== b.status) {
                const rank = { superseded: 0, expired: 1, revoked: 2 }
                return rank[a.status] - rank[b.status]
              }
              if (BigInt(a.revision) < BigInt(b.revision)) return -1
              if (BigInt(a.revision) > BigInt(b.revision)) return 1
              return a.issuedAt - b.issuedAt
            })
          const ordered: VerifiedCandidate[] = [...leaseCandidates, ...refusalCandidates]
          for (const candidate of ordered) {
            if (candidate.kind === 'lease' && candidate.expiresAt <= trustedTime) {
              historical = true
              continue
            }
            const applied = await applyCandidate({
              options, tx, row: current, candidate, accepted, trustedTime,
              identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
            })
            current = applied.row
            if (applied.changed) { changed = true; evidenceDigest = applied.evidenceDigest }
            else if (applied.evidenceDigest) evidenceDigest = applied.evidenceDigest
          }
          // The revoked lease can never grant permission. Only a newly verified, newer target
          // renewal may replace its unavailable source; all refusal watermarks still apply.
          if (revokedLeaseSourceError && (current.credential_jws_digest === oldCredentialDigest ||
            current.credential_operation_id !== operationId)) throw revokedLeaseSourceError
          if (revokedRefusalSourceError && (current.credential_operation_id !== operationId ||
            current.credential_jws_digest === oldCredentialDigest ||
            BigInt(current.entitlement_revision!) <= BigInt(row.refusal_revision!))) throw revokedRefusalSourceError
          // Release the active renewal only after its own signed result has been verified and
          // incorporated or superseded by a newer accepted watermark in this transaction.
          if (target.kind === 'renewal' && target.state === 'response_saved') {
            const settled = verified.some(candidate => {
              if (candidate.source.history.operationId !== operationId || current.license_id === null ||
                current.license_id !== candidate.source.history.licenseId ||
                current.activation_generation !== (candidate.kind === 'lease' ? candidate.lease.activationGeneration : candidate.generation)) return false
              if (candidate.kind === 'lease') {
                // An expired verified lease is historical evidence only, but its committed
                // operation is complete and must not prevent a new renewal from being created.
                return candidate.expiresAt <= trustedTime ||
                  BigInt(current.entitlement_revision!) >= BigInt(candidate.lease.entitlementRevision)
              }
              if (candidate.status === 'superseded') return current.refusal_status === 'superseded'
              return (current.refusal_revision !== null && BigInt(current.refusal_revision) >= BigInt(candidate.revision)) ||
                BigInt(current.entitlement_revision!) > BigInt(candidate.revision)
            })
            if (settled) {
              await tx.updateTable('local_license_operations').set({ state: 'projected', finalized_at: new Date() })
                .where('operation_id', '=', operationId).where('state', '=', 'response_saved').executeTakeFirst()
              transactionCommit.renewalFinalized = true
            }
          }
          const outcome = changed ? 'applied' : historical ? 'historical_only' : verified.length ? 'idempotent' : 'no_evidence'
          const result = resultFromRow(current, outcome, evidenceDigest)
          const fingerprint = rowFingerprint(current)
          await checkpoint('after_projection_row_update')
          const trustBeforeCommit = await options.trustStore.getAccepted(() => trustedTime)
          if (trustBeforeCommit.artifactSha256 !== accepted.artifactSha256) fail('license_projection_trust_changed')
          transactionCommit.fingerprint = fingerprint
          transactionCommit.result = result
          return { result, fingerprint }
          }))
          await checkpoint('after_projection_commit')
        } catch (error) {
          const after = await options.db.selectFrom('instance_license_state').selectAll()
            .where('singleton', '=', true).executeTakeFirst()
          if (!after || !transactionCommit.fingerprint || !transactionCommit.result || !transactionCommit.acceptedArtifactSha256 ||
            rowFingerprint(after) !== transactionCommit.fingerprint) throw error
          if (transactionCommit.renewalFinalized) {
            const committed = await options.db.selectFrom('local_license_operations').select('state')
              .where('operation_id', '=', operationId).executeTakeFirst()
            if (committed?.state !== 'projected') throw error
          }
          const latest = await options.trustStore.getAccepted(sample.assertFresh)
          if (latest.artifactSha256 !== transactionCommit.acceptedArtifactSha256) fail('license_projection_trust_changed')
          const recovered = transactionCommit.result
          if (!recovered) throw error
          return Object.freeze({ ...recovered, commitRecovered: true })
        }
        const latest = await options.trustStore.getAccepted(sample.assertFresh)
        if (!transactionCommit.acceptedArtifactSha256 || latest.artifactSha256 !== transactionCommit.acceptedArtifactSha256) {
          fail('license_projection_trust_changed')
        }
        return transactionOutcome.result
      })
    },
  })
}
