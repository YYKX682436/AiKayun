import { createHash } from 'node:crypto'
import { decodeProtectedHeader } from 'jose'
import type { Kysely, Selectable } from 'kysely'
import type { Database, InstanceLicenseStateTable } from '../db/types.js'
import { withVerifiedInstallationSigningContext } from './installation-identity.js'
import { sha256Base64url } from './license-intent.js'
import { parseStrictJson } from './strict-json.js'
import {
  decryptLicensePendingBytes,
  encryptLicensePendingBytes,
} from './pending-encryption-key.js'
import type { LicenseOperationRecoveryClientOptions, PersistedLicenseProjectionHistory } from './license-operation-recovery-client.js'
import {
  LicenseOperationRecoveryError,
  readPersistedLicenseProjectionHistory,
  readVerifiedPersistedRecoveryQueryResult,
} from './license-operation-recovery-client.js'
import { fetchTrustedTimeAnchor } from './trust/time-anchor-client.js'
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
}

export interface LicenseStateProjectionResult {
  readonly outcome: 'applied' | 'idempotent' | 'historical_only' | 'no_evidence'
  readonly licenseId: string | null
  readonly activationGeneration: string | null
  readonly entitlementRevision: string | null
  readonly credentialId: string | null
  readonly credentialExpiresAt: string | null
  readonly refusalStatus: 'revoked' | 'superseded' | null
  readonly refusalGeneration: string | null
  readonly refusalRevision: string | null
  readonly evidenceDigest: string | null
  readonly commitRecovered?: true
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
    status: 'revoked' | 'superseded'
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
  if (history.operationKind === 'recovery') {
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
        if (!bindingAttempt || !['recovery', 'continue'].includes(bindingAttempt.purpose)) continue
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
      if (history.operationKind === 'recovery' &&
        (history.recoveryPayload === null || lease.activationGeneration !== history.recoveryPayload.expectedGeneration ||
          BigInt(lease.entitlementRevision) < BigInt(history.recoveryPayload.knownRevision))) return null
      return Object.freeze({ kind: 'lease', source, digest, issuedAt: lease.issuedAt,
        expiresAt: lease.expiresAt, lease })
    } catch { return null }
  }
  if (header.typ !== 'aikayun-license-status+jwt' || history.operationKind !== 'recovery' ||
    !['recovery', 'continue'].includes(source.purpose) || history.recoveryPayload === null) return null
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
    if (claims.status !== 'revoked' && claims.status !== 'superseded') return null
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
    row.refusal_encryption_key_id, row.encrypted_refusal_jws?.toString('base64url'),
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
  if (row.refusal_status === 'revoked' && BigInt(lease.entitlementRevision) <= BigInt(row.refusal_revision!)) return 'stale'
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
  if (options.onProjectionTestCheckpoint && process.env.NODE_ENV !== 'test') {
    throw new Error('License projection fault injection is restricted to isolated tests')
  }
  const checkpoint = async (stage: LicenseProjectionCheckpoint) => options.onProjectionTestCheckpoint?.(stage)
  return Object.freeze({
    /** The only write entrypoint: all candidate bytes are loaded from and rebound to persisted operation history. */
    async projectPersistedOperation(operationId: string): Promise<LicenseStateProjectionResult> {
      if (!UUID.test(operationId)) fail('license_projection_operation_id_invalid')
      return withVerifiedInstallationSigningContext(options.pool, options.identityRoot, async identity => {
        const target = await options.db.selectFrom('local_license_operations').selectAll()
          .where('operation_id', '=', operationId).executeTakeFirst()
        if (!target || !['activation', 'recovery'].includes(target.kind) ||
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
        const accepted = await options.trustStore.getAccepted(sample.assertFresh)
        if (accepted.centerIssuer !== options.releaseConfig.expected_center_issuer) fail('license_projection_trust_mismatch')

        const transactionCommit: { fingerprint?: string; result?: LicenseStateProjectionResult } = {}
        let transactionOutcome: { result: LicenseStateProjectionResult; fingerprint: string }
        try {
          transactionOutcome = await options.db.transaction().execute(async tx => {
          const binding = await tx.selectFrom('installation_binding').selectAll()
            .where('singleton', '=', true).forUpdate().executeTakeFirst()
          if (!binding || binding.binding_state !== 'ready' || binding.database_id !== identity.databaseId ||
            binding.instance_id !== identity.instanceId || binding.identity_jkt !== identity.identityJkt) {
            fail('license_projection_identity_changed')
          }
          await checkpoint('after_projection_binding_locked')
          const row = await tx.selectFrom('instance_license_state').selectAll()
            .where('singleton', '=', true).forUpdate().executeTakeFirst()
          if (!row) fail('license_projection_singleton_missing')
          await checkpoint('after_projection_row_locked')
          const trustedTime = sample.assertFresh()
          if (row.license_id !== null && row.credential_jti !== null) {
            await readAndVerifyStoredEvidence({
              options, tx, row,
              identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
              kind: 'lease', accepted, trustedTime,
            })
          }
          if (row.license_id !== null && row.refusal_status !== null) {
            await readAndVerifyStoredEvidence({
              options, tx, row,
              identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
              kind: 'refusal', accepted, trustedTime,
            })
          }
          const rows = await tx.selectFrom('local_license_operations').select(['operation_id', 'kind'])
            .where('license_id', '=', target.license_id).where('database_id', '=', identity.databaseId)
            .where('instance_id', '=', identity.instanceId).where('identity_jkt', '=', identity.identityJkt)
            .where('state', '=', 'response_saved').where('kind', 'in', ['activation', 'recovery'])
            .orderBy('created_at', 'asc').execute()
          const candidates: CandidateSource[] = []
          for (const item of rows) {
            const history = await readPersistedLicenseProjectionHistory({
              options: { ...options, db: tx }, operationId: item.operation_id,
              identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
            })
            candidates.push(...await candidateSources({
              options: { ...options, db: tx }, history, accepted, trustedTime,
              identity: { databaseId: identity.databaseId, instanceId: identity.instanceId, identityJkt: identity.identityJkt },
            }))
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
              if (a.status !== b.status) return a.status === 'superseded' ? -1 : 1
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
          const outcome = changed ? 'applied' : historical ? 'historical_only' : verified.length ? 'idempotent' : 'no_evidence'
          const result = resultFromRow(current, outcome, evidenceDigest)
          const fingerprint = rowFingerprint(current)
          await checkpoint('after_projection_row_update')
          const trustBeforeCommit = await options.trustStore.getAccepted(sample.assertFresh)
          if (trustBeforeCommit.artifactSha256 !== accepted.artifactSha256) fail('license_projection_trust_changed')
          transactionCommit.fingerprint = fingerprint
          transactionCommit.result = result
          return { result, fingerprint }
          })
          await checkpoint('after_projection_commit')
        } catch (error) {
          const after = await options.db.selectFrom('instance_license_state').selectAll()
            .where('singleton', '=', true).executeTakeFirst()
          if (!after || !transactionCommit.fingerprint || !transactionCommit.result ||
            rowFingerprint(after) !== transactionCommit.fingerprint) throw error
          const latest = await options.trustStore.getAccepted(sample.assertFresh)
          if (latest.artifactSha256 !== accepted.artifactSha256) fail('license_projection_trust_changed')
          const recovered = transactionCommit.result
          if (!recovered) throw error
          return Object.freeze({ ...recovered, commitRecovered: true })
        }
        const latest = await options.trustStore.getAccepted(sample.assertFresh)
        if (latest.artifactSha256 !== accepted.artifactSha256) fail('license_projection_trust_changed')
        return transactionOutcome.result
      })
    },
  })
}
