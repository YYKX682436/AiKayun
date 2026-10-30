import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Transaction } from 'kysely'
import { Pool } from 'pg'
import type { Pool as PgPool } from 'pg'
import type { Database } from '../src/db/types.js'
import { localLicenseOperationsMigration } from '../src/db/migrations/202610300001_local_license_operations.js'
import { ed25519IdentityJkt } from '../src/licensing/license-intent.js'
import {
  allocateLicenseOperationAttempt,
  createOrLoadActivationOperation,
  markLicenseOperationAttemptSent,
  markLicenseOperationAttemptTransportResult,
  newLicenseOperationId,
  readActivationOperationPayload,
  readLicenseOperationAttemptEnvelope,
  readLicenseOperationAttemptResponse,
  readSavedLicenseOperationResponse,
  saveLicenseOperationResponse,
} from '../src/licensing/license-operation-store.js'
import { initializeTemporaryLicensePendingKey } from '../src/licensing/pending-encryption-key.js'
import vector from './fixtures/activation-intent-7-1b-3c-1.json' with { type: 'json' }

const testPublicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: Buffer.alloc(32, 9).toString('base64url') }
const testIdentityJkt = ed25519IdentityJkt(testPublicJwk)
const testDatabaseUrl = process.env.TEST_DATABASE_URL
describe.skipIf(!testDatabaseUrl)('⑦-1B-3C-1 local license operation PostgreSQL persistence', () => {
  let adminPool: PgPool
  const schemas = new Set<string>()
  const pendingRoots = new Set<string>()

  interface Sandbox {
    schema: string
    pool: PgPool
    db: Kysely<Database>
    pendingRoot: string
  }

  beforeAll(async () => {
    const url = new URL(testDatabaseUrl!)
    if (!url.pathname.slice(1).endsWith('_test')) {
      throw new Error('License operation integration tests require a dedicated PostgreSQL database ending in _test')
    }
    adminPool = new Pool({ connectionString: testDatabaseUrl, max: 3, application_name: 'aikayun-license-pending-test-admin' })
    await adminPool.query('SELECT 1')
  })

  afterAll(async () => {
    for (const schema of schemas) await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool?.end()
    for (const root of pendingRoots) await rm(root, { recursive: true, force: true })
  })

  async function createSandbox(): Promise<Sandbox> {
    const schema = `license_pending_test_${randomUUID().replaceAll('-', '')}`
    schemas.add(schema)
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    const pool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schema}`,
      max: 10,
      application_name: 'aikayun-license-pending-test',
    })
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    await sql.raw(`CREATE TABLE installation_binding (
      singleton boolean PRIMARY KEY DEFAULT true,
      database_id uuid NOT NULL UNIQUE,
      instance_id uuid NOT NULL UNIQUE,
      identity_jkt char(43) NOT NULL,
      binding_revision bigint NOT NULL DEFAULT 1,
      binding_state text NOT NULL DEFAULT 'ready',
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`).execute(db)
    await db.insertInto('installation_binding').values({
      singleton: true,
      database_id: vector.input.databaseId,
      instance_id: vector.input.instanceId,
      identity_jkt: testIdentityJkt,
      binding_revision: '1',
      binding_state: 'ready',
    }).execute()
    await localLicenseOperationsMigration.up(db)
    const pendingRoot = await mkdtemp(join(tmpdir(), 'aikayun-license-pending-pg-'))
    pendingRoots.add(pendingRoot)
    await initializeTemporaryLicensePendingKey(pendingRoot, 'test')
    return { schema, pool, db, pendingRoot }
  }

  async function closeSandbox(sandbox: Sandbox): Promise<void> {
    await sandbox.db.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${sandbox.schema}" CASCADE`)
    schemas.delete(sandbox.schema)
    await rm(sandbox.pendingRoot, { recursive: true, force: true })
    pendingRoots.delete(sandbox.pendingRoot)
  }

  async function withSandbox<T>(work: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    const sandbox = await createSandbox()
    try { return await work(sandbox) } finally { await closeSandbox(sandbox) }
  }

  function activationInput(operationId = newLicenseOperationId(), overrides: Partial<typeof vector.input> = {}) {
    return { operationId, ...vector.input, ...overrides, identityJkt: overrides.identityJkt ?? testIdentityJkt }
  }

  function attemptInput(
    operationId: string,
    intentDigest: string,
    identityJkt = testIdentityJkt,
    purpose: 'activation' | 'query' | 'continue' = 'activation',
    uniqueNonces = false,
  ) {
    const clientNonce = uniqueNonces ? randomBytes(32).toString('base64url') : Buffer.alloc(32, 0x70).toString('base64url')
    const requestNonce = uniqueNonces ? randomBytes(32).toString('base64url') : Buffer.alloc(32, 0x71).toString('base64url')
    return {
      operationId,
      purpose,
      intentDigest,
      clientNonce,
      requestNonce,
      identityJkt,
      buildRequest(attemptNo: number) {
        const requestBody = Buffer.from(JSON.stringify({
          operation_id: operationId,
          intent_digest: intentDigest,
          attempt_no: attemptNo,
          license_id: vector.input.licenseId,
          database_id: vector.input.databaseId,
          instance_id: vector.input.instanceId,
          identity_jkt: identityJkt,
          public_jwk: testPublicJwk,
          challenge: 'synthetic-test-challenge-token'.padEnd(128, 'x'),
          ...(purpose === 'query' ? {} : {
            activation_code: vector.input.activationCode,
            origin: vector.input.origin,
            ...(purpose === 'continue' ? { kind: 'activation' } : {}),
          }),
        }), 'utf8')
        const requestEnvelope = Buffer.from(JSON.stringify({
          schema: 1,
          method: 'POST',
          target: purpose === 'activation' ? '/v1/activations'
            : purpose === 'query' ? '/v1/operations/query' : '/v1/operations/continue',
          headers: {
            'x-test-client-nonce': clientNonce,
            'x-test-request-nonce': requestNonce,
            signature: 'synthetic-test-only',
          },
          body_base64url: requestBody.toString('base64url'),
        }), 'utf8')
        return {
          requestBody,
          signingKeyId: identityJkt,
          signatureCreatedAt: new Date('2026-10-30T00:00:00.000Z'),
          requestEnvelope,
        }
      },
    }
  }

  function runChild(
    sandbox: Pick<Sandbox, 'schema' | 'pendingRoot'>,
    mode: string,
    input: ReturnType<typeof activationInput>,
    extraArgs: string[] = [],
  ) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const databaseUrl = new URL(testDatabaseUrl!)
      databaseUrl.searchParams.set('options', `-c search_path=${sandbox.schema}`)
      const child = spawn(process.execPath, [
        '--import', resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs'),
        resolve(import.meta.dirname, 'fixtures/license-operation-process.ts'),
        mode, sandbox.schema, sandbox.pendingRoot, input.operationId, input.licenseId,
        input.databaseId, input.instanceId, input.identityJkt, input.activationCode,
        ...extraArgs,
      ], {
        cwd: resolve(import.meta.dirname, '../../..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TEST_DATABASE_URL: testDatabaseUrl,
          DATABASE_URL: databaseUrl.toString(),
          LICENSE_PENDING_KEY_ROOT: sandbox.pendingRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }))
    })
  }

  function loseCommitAcknowledgementAfterPostgresCommit(db: Kysely<Database>): Kysely<Database> {
    return {
      transaction() {
        const builder = db.transaction()
        return {
          execute<T>(callback: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
            return builder.execute(callback).then(() => {
              throw new Error('injected_unknown_commit_acknowledgement')
            })
          },
        }
      },
    } as unknown as Kysely<Database>
  }

  it('idempotently reuses the same operation and rejects conflicting intent or a second operation for the same install binding', async () => {
    await withSandbox(async sandbox => {
      const input = activationInput()
      const first = await createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, input)
      const replay = await createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, input)
      expect(first).toMatchObject({ created: true, state: 'pending' })
      expect(replay).toMatchObject({ created: false, operationId: input.operationId, intentDigest: first.intentDigest })
      await expect(createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, {
        ...input, activationCode: Buffer.alloc(32, 0x55).toString('base64url'),
      })).rejects.toMatchObject({ code: 'operation_id_intent_conflict' })
      const otherOperation = activationInput(newLicenseOperationId(), { licenseId: randomUUID() })
      await expect(createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, otherOperation))
        .rejects.toMatchObject({ code: 'operation_binding_already_pending' })
      await expect(createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot,
        activationInput(newLicenseOperationId(), { identityJkt: Buffer.alloc(32, 0x63).toString('base64url') })))
        .rejects.toMatchObject({ code: 'installation_binding_conflict' })

      const payload = await readActivationOperationPayload(sandbox.db, sandbox.pendingRoot, input.operationId)
      expect(payload).toEqual({ activationCode: input.activationCode, origin: input.origin })
      const rows = await sandbox.db.selectFrom('local_license_operations').selectAll().execute()
      expect(rows).toHaveLength(1)
      const rowBytes = Buffer.concat([rows[0]!.encrypted_intent_payload]).toString('utf8')
      expect(rowBytes).not.toContain(input.activationCode)
      expect(rows[0]!.intent_digest).toBe(first.intentDigest)
    })
  })

  it('serializes attempt numbers across independent Node processes and persists exact encrypted recovery envelopes', async () => {
    await withSandbox(async sandbox => {
      const input = activationInput()
      const operation = await createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, input)
      const children = await Promise.all(Array.from({ length: 8 }, () => runChild(sandbox, 'concurrent-attempt', input)))
      expect(children.every(child => child.code === 0 && child.signal === null)).toBe(true)
      expect(children.map(child => child.stdout.trim()).sort((a, b) => Number(a) - Number(b)))
        .toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
      const attempts = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).orderBy('attempt_no').execute()
      expect(attempts.map(attempt => attempt.attempt_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(attempts.every(attempt => attempt.intent_digest === operation.intentDigest && attempt.send_state === 'prepared')).toBe(true)
      const recovered = await readLicenseOperationAttemptEnvelope(sandbox.db, sandbox.pendingRoot, input.operationId, 1)
      expect(recovered).toMatchObject({ attemptNo: 1, purpose: 'activation', sendState: 'prepared' })
      const recoveredEnvelope = JSON.parse(recovered.requestEnvelope.toString('utf8')) as { body_base64url: string }
      expect(JSON.parse(Buffer.from(recoveredEnvelope.body_base64url, 'base64url').toString('utf8')))
        .toMatchObject({ activation_code: input.activationCode, operation_id: input.operationId })
      const allAttemptBytes = Buffer.concat(attempts.map(attempt => attempt.encrypted_request_envelope)).toString('utf8')
      expect(allAttemptBytes).not.toContain(input.activationCode)
    })
  })

  it('archives a late activation response without moving the newer query response pointer backwards', async () => {
    await withSandbox(async sandbox => {
      const input = activationInput()
      const operation = await createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, input)
      const activationAttempt = await allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest, testIdentityJkt, 'activation', true))
      await markLicenseOperationAttemptSent(sandbox.db, input.operationId, activationAttempt.attemptNo)
      await markLicenseOperationAttemptTransportResult(sandbox.db, input.operationId, activationAttempt.attemptNo, 'transport_unknown')

      const queryAttempt = await allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest, testIdentityJkt, 'query', true))
      expect(queryAttempt.attemptNo).toBe(activationAttempt.attemptNo + 1)
      await markLicenseOperationAttemptSent(sandbox.db, input.operationId, queryAttempt.attemptNo)
      const queryResponse = Buffer.from('synthetic-newer-query-response', 'utf8')
      await saveLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId, queryAttempt.attemptNo, queryResponse)
      const latestBeforeLateResponse = await sandbox.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).executeTakeFirstOrThrow()
      const queryAttemptBeforeLateResponse = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', queryAttempt.attemptNo).executeTakeFirstOrThrow()
      const activationAttemptBeforeLateResponse = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', activationAttempt.attemptNo).executeTakeFirstOrThrow()

      const lateActivationResponse = Buffer.from('synthetic-late-activation-response', 'utf8')
      await expect(saveLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId,
        activationAttempt.attemptNo, lateActivationResponse)).resolves.toMatchObject({
        responseDigest: expect.any(String),
      })

      const parentAfter = await sandbox.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).executeTakeFirstOrThrow()
      const activationAfter = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', activationAttempt.attemptNo).executeTakeFirstOrThrow()
      const queryAttemptAfter = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', queryAttempt.attemptNo).executeTakeFirstOrThrow()
      expect(parentAfter).toMatchObject({
        state: 'response_saved',
        response_attempt_no: queryAttempt.attemptNo,
        response_digest: latestBeforeLateResponse.response_digest,
        response_saved_at: latestBeforeLateResponse.response_saved_at,
      })
      expect(activationAfter.send_state).toBe('response_saved')
      expect(activationAfter.response_digest).not.toBe(parentAfter.response_digest)
      expect(activationAfter).toMatchObject({
        client_nonce_hash: activationAttemptBeforeLateResponse.client_nonce_hash,
        request_nonce_hash: activationAttemptBeforeLateResponse.request_nonce_hash,
        request_body_digest: activationAttemptBeforeLateResponse.request_body_digest,
        identity_jkt: activationAttemptBeforeLateResponse.identity_jkt,
        signing_key_id: activationAttemptBeforeLateResponse.signing_key_id,
        signature_created_at: activationAttemptBeforeLateResponse.signature_created_at,
        request_key_id: activationAttemptBeforeLateResponse.request_key_id,
        encrypted_request_envelope: activationAttemptBeforeLateResponse.encrypted_request_envelope,
      })
      expect(await readLicenseOperationAttemptResponse(sandbox.db, sandbox.pendingRoot, input.operationId,
        activationAttempt.attemptNo)).toEqual(lateActivationResponse)
      expect(await readLicenseOperationAttemptResponse(sandbox.db, sandbox.pendingRoot, input.operationId,
        queryAttempt.attemptNo)).toEqual(queryResponse)
      expect(queryAttemptAfter.encrypted_response).toEqual(queryAttemptBeforeLateResponse.encrypted_response)
      expect(queryAttemptAfter.encrypted_request_envelope).toEqual(queryAttemptBeforeLateResponse.encrypted_request_envelope)
      expect(queryAttemptAfter.response_saved_at).toEqual(queryAttemptBeforeLateResponse.response_saved_at)
      expect(await readSavedLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId)).toEqual(queryResponse)
      await expect(allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest, testIdentityJkt, 'activation', true)))
        .rejects.toMatchObject({ code: 'operation_not_pending' })
      expect(await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).execute()).toHaveLength(2)
      expect(await sandbox.db.selectFrom('local_license_operations').selectAll().execute()).toHaveLength(1)
    })
  })

  it('saves concurrent identical responses once, makes identical replay idempotent, and rejects different bytes', async () => {
    await withSandbox(async sandbox => {
      const input = activationInput()
      const operation = await createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, input)
      const attempt = await allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest))
      await markLicenseOperationAttemptSent(sandbox.db, input.operationId, attempt.attemptNo)
      const response = Buffer.from('synthetic-identical-response-bytes', 'utf8')
      const concurrent = await Promise.all([
        runChild(sandbox, 'save-response', input, [String(attempt.attemptNo), response.toString('base64url')]),
        runChild(sandbox, 'save-response', input, [String(attempt.attemptNo), response.toString('base64url')]),
      ])
      expect(concurrent.every(result => result.code === 0 && result.signal === null)).toBe(true)
      expect(concurrent[0]!.stdout.trim()).toBe(concurrent[1]!.stdout.trim())
      const storedBeforeReplay = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', attempt.attemptNo).executeTakeFirstOrThrow()
      const parentBeforeReplay = await sandbox.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).executeTakeFirstOrThrow()

      await expect(saveLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId, attempt.attemptNo, response))
        .resolves.toMatchObject({ responseDigest: storedBeforeReplay.response_digest })
      const storedAfterReplay = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', attempt.attemptNo).executeTakeFirstOrThrow()
      const parentAfterReplay = await sandbox.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).executeTakeFirstOrThrow()
      expect(storedAfterReplay.encrypted_response).toEqual(storedBeforeReplay.encrypted_response)
      expect(storedAfterReplay.response_saved_at).toEqual(storedBeforeReplay.response_saved_at)
      expect(parentAfterReplay.response_attempt_no).toBe(parentBeforeReplay.response_attempt_no)
      expect(parentAfterReplay.response_digest).toBe(parentBeforeReplay.response_digest)
      expect(parentAfterReplay.response_saved_at).toEqual(parentBeforeReplay.response_saved_at)
      await expect(saveLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId, attempt.attemptNo,
        Buffer.from('different-response-must-not-overwrite', 'utf8')))
        .rejects.toMatchObject({ code: 'attempt_response_conflict' })
      const retained = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', attempt.attemptNo).executeTakeFirstOrThrow()
      expect(retained.encrypted_response).toEqual(storedBeforeReplay.encrypted_response)
      expect(retained.response_saved_at).toEqual(storedBeforeReplay.response_saved_at)
      const parentAfterConflict = await sandbox.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).executeTakeFirstOrThrow()
      expect(parentAfterConflict.response_attempt_no).toBe(parentBeforeReplay.response_attempt_no)
      expect(parentAfterConflict.response_digest).toBe(parentBeforeReplay.response_digest)
      expect(parentAfterConflict.response_saved_at).toEqual(parentBeforeReplay.response_saved_at)
      expect(await readLicenseOperationAttemptResponse(sandbox.db, sandbox.pendingRoot, input.operationId, attempt.attemptNo))
        .toEqual(response)
    })
  })

  it('recovers a response after unknown PostgreSQL commit acknowledgement and process SIGKILL', async () => {
    await withSandbox(async sandbox => {
      const input = activationInput()
      const operation = await createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, input)
      const attempt = await allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest))
      await markLicenseOperationAttemptSent(sandbox.db, input.operationId, attempt.attemptNo)
      const response = Buffer.from('synthetic-response-after-unknown-commit', 'utf8')

      await expect(saveLicenseOperationResponse(loseCommitAcknowledgementAfterPostgresCommit(sandbox.db),
        sandbox.pendingRoot, input.operationId, attempt.attemptNo, response))
        .rejects.toThrow('injected_unknown_commit_acknowledgement')
      const committed = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', attempt.attemptNo).executeTakeFirstOrThrow()
      expect(committed.send_state).toBe('response_saved')
      expect(await readLicenseOperationAttemptResponse(sandbox.db, sandbox.pendingRoot, input.operationId, attempt.attemptNo))
        .toEqual(response)

      const killed = await runChild(sandbox, 'commit-response-kill', input,
        [String(attempt.attemptNo), response.toString('base64url')])
      expect(killed.signal).toBe('SIGKILL')
      expect(killed.code).toBeNull()
      await expect(saveLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId, attempt.attemptNo, response))
        .resolves.toMatchObject({ responseDigest: committed.response_digest })
      const retained = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', attempt.attemptNo).executeTakeFirstOrThrow()
      expect(retained.encrypted_response).toEqual(committed.encrypted_response)
      expect(retained.response_saved_at).toEqual(committed.response_saved_at)
      const parent = await sandbox.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).executeTakeFirstOrThrow()
      expect(parent.response_attempt_no).toBe(attempt.attemptNo)
      expect(await readSavedLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId)).toEqual(response)
    })
  })

  it('enforces immutable parent and attempt evidence, legal state movement, monotonic numbering, and no local terminal authority', async () => {
    await withSandbox(async sandbox => {
      const input = activationInput()
      const operation = await createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, input)
      const mismatchedRequest = attemptInput(input.operationId, operation.intentDigest, testIdentityJkt, 'activation', true)
      const buildMatchingRequest = mismatchedRequest.buildRequest
      mismatchedRequest.buildRequest = attemptNo => {
        const built = buildMatchingRequest(attemptNo)
        const body = JSON.parse(Buffer.from(built.requestBody).toString('utf8')) as Record<string, unknown>
        body.activation_code = Buffer.alloc(32, 0x44).toString('base64url')
        const requestBody = Buffer.from(JSON.stringify(body), 'utf8')
        const envelope = JSON.parse(Buffer.from(built.requestEnvelope).toString('utf8')) as Record<string, unknown>
        envelope.body_base64url = requestBody.toString('base64url')
        return { ...built, requestBody, requestEnvelope: Buffer.from(JSON.stringify(envelope), 'utf8') }
      }
      await expect(allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot, mismatchedRequest))
        .rejects.toMatchObject({ code: 'attempt_request_binding_conflict' })
      expect(await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).execute()).toHaveLength(0)
      const allocated = await allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest))
      expect(allocated.attemptNo).toBe(1)
      const duplicate = await allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest))
      expect(duplicate.attemptNo).toBe(1)
      expect((await sandbox.db.selectFrom('local_license_operation_attempts').selectAll().execute())).toHaveLength(1)

      await expect(sql`UPDATE local_license_operations SET intent_digest = ${'A'.repeat(43)} WHERE operation_id = ${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`UPDATE local_license_operations SET operation_id = ${randomUUID()}::uuid WHERE operation_id = ${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`UPDATE local_license_operation_attempts SET request_body_digest = ${'B'.repeat(43)} WHERE operation_id = ${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`INSERT INTO local_license_operation_attempts SELECT operation_id, 9, purpose, intent_digest,
        ${'C'.repeat(43)}, ${'D'.repeat(43)}, request_body_digest, identity_jkt, signing_key_id,
        signature_created_at, request_key_id, encrypted_request_envelope, 'prepared', NULL, NULL, NULL, NULL, NULL, created_at
        FROM local_license_operation_attempts WHERE operation_id = ${input.operationId}::uuid AND attempt_no = 1`.execute(sandbox.db)).rejects.toBeDefined()

      const centerResponse = Buffer.from('synthetic-center-signed-operation-response-for-storage-only', 'utf8')
      const saved = await saveLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId, 1, centerResponse)
      expect((await sandbox.db.selectFrom('local_license_operations').select('state').where('operation_id', '=', input.operationId).executeTakeFirst())?.state)
        .toBe('response_saved')
      expect(await readSavedLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId)).toEqual(centerResponse)
      const savedOperation = await sandbox.db.selectFrom('local_license_operations').select('response_digest')
        .where('operation_id', '=', input.operationId).executeTakeFirstOrThrow()
      expect(saved.responseDigest).toBe(savedOperation.response_digest)
      const savedRows = await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).execute()
      expect(Buffer.concat(savedRows.map(row => row.encrypted_response ?? Buffer.alloc(0))).toString('utf8')).not.toContain(centerResponse.toString('utf8'))

      const queryAttempt = await allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest, testIdentityJkt, 'query', true))
      expect(queryAttempt).toMatchObject({ attemptNo: 2, reused: false })
      await markLicenseOperationAttemptSent(sandbox.db, input.operationId, queryAttempt.attemptNo)
      const queryResponse = Buffer.from('synthetic-center-signed-query-response-for-storage-only', 'utf8')
      await saveLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId, queryAttempt.attemptNo, queryResponse)
      expect(await readSavedLicenseOperationResponse(sandbox.db, sandbox.pendingRoot, input.operationId)).toEqual(queryResponse)
      expect(await readLicenseOperationAttemptResponse(sandbox.db, sandbox.pendingRoot, input.operationId, 1)).toEqual(centerResponse)

      const continueAttempt = await allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest, testIdentityJkt, 'continue', true))
      expect(continueAttempt).toMatchObject({ attemptNo: 3, reused: false })
      await markLicenseOperationAttemptTransportResult(sandbox.db, input.operationId, continueAttempt.attemptNo, 'transport_unknown')
      const attemptStates = await sandbox.db.selectFrom('local_license_operation_attempts')
        .select(['attempt_no', 'purpose', 'send_state']).where('operation_id', '=', input.operationId)
        .orderBy('attempt_no').execute()
      expect(attemptStates).toEqual([
        { attempt_no: 1, purpose: 'activation', send_state: 'response_saved' },
        { attempt_no: 2, purpose: 'query', send_state: 'response_saved' },
        { attempt_no: 3, purpose: 'continue', send_state: 'transport_unknown' },
      ])
      await expect(allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest, testIdentityJkt, 'activation', true)))
        .rejects.toMatchObject({ code: 'operation_not_pending' })

      await expect(sql`UPDATE local_license_operations SET state='pending', response_attempt_no=NULL, response_digest=NULL, response_saved_at=NULL WHERE operation_id=${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`UPDATE local_license_operations SET response_attempt_no=1 WHERE operation_id=${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`UPDATE local_license_operations SET state='projected', finalized_at=clock_timestamp() WHERE operation_id=${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`UPDATE local_license_operations SET state='terminal', encrypted_center_evidence=decode('01','hex'),
        center_evidence_key_id='center-v1', center_evidence_digest=${'E'.repeat(43)}, finalized_at=clock_timestamp()
        WHERE operation_id=${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`UPDATE local_license_operation_attempts SET send_state='prepared' WHERE operation_id=${input.operationId}::uuid AND attempt_no=1`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`DELETE FROM local_license_operations WHERE operation_id=${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`DELETE FROM local_license_operation_attempts WHERE operation_id=${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`TRUNCATE local_license_operations CASCADE`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`TRUNCATE local_license_operation_attempts`.execute(sandbox.db)).rejects.toBeDefined()
      await expect(sql`INSERT INTO local_license_operations (
        operation_id, kind, intent_digest, license_id, database_id, instance_id, identity_jkt,
        expected_generation, payload_key_id, encrypted_intent_payload, state,
        response_attempt_no, response_digest, encrypted_center_evidence, center_evidence_key_id,
        center_evidence_digest, response_saved_at, finalized_at
      ) SELECT ${randomUUID()}::uuid, kind, intent_digest, license_id, database_id, instance_id, identity_jkt,
        NULL, payload_key_id, encrypted_intent_payload, 'terminal', 1, ${'F'.repeat(43)}, decode('01','hex'),
        'center-v1', ${'G'.repeat(43)}, clock_timestamp(), clock_timestamp()
      FROM local_license_operations WHERE operation_id=${input.operationId}::uuid`.execute(sandbox.db)).rejects.toBeDefined()
      const retained = await sandbox.db.selectFrom('local_license_operations').select('state')
        .where('operation_id', '=', input.operationId).executeTakeFirst()
      expect(retained?.state).toBe('response_saved')
    })
  })

  it('recovers operation and attempt commits across SIGKILL, and rolls back uncommitted transactions', async () => {
    await withSandbox(async sandbox => {
      const input = activationInput()
      const beforeOperationCommit = await runChild(sandbox, 'rollback-operation', input)
      expect(beforeOperationCommit.signal).toBe('SIGKILL')
      expect(await sandbox.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).execute()).toHaveLength(0)

      const afterOperationCommit = await runChild(sandbox, 'commit-operation', input)
      expect(afterOperationCommit.signal).toBe('SIGKILL')
      expect(afterOperationCommit.stderr).not.toContain(input.activationCode)
      expect(await createOrLoadActivationOperation(sandbox.db, sandbox.pendingRoot, input))
        .toMatchObject({ operationId: input.operationId, created: false })

      const beforeAttemptCommit = await runChild(sandbox, 'rollback-attempt', input)
      expect(beforeAttemptCommit.signal).toBe('SIGKILL')
      expect(await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).execute()).toHaveLength(0)

      const afterAttemptCommit = await runChild(sandbox, 'commit-attempt', input)
      expect(afterAttemptCommit.signal).toBe('SIGKILL')
      expect(afterAttemptCommit.stderr).not.toContain(input.activationCode)
      const operation = await sandbox.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).executeTakeFirstOrThrow()
      const sameAttempt = await allocateLicenseOperationAttempt(sandbox.db, sandbox.pendingRoot,
        attemptInput(input.operationId, operation.intent_digest))
      expect(sameAttempt).toMatchObject({ attemptNo: 1, state: 'prepared' })
      expect(await sandbox.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).execute()).toHaveLength(1)
      const recovered = await readLicenseOperationAttemptEnvelope(sandbox.db, sandbox.pendingRoot, input.operationId, 1)
      const recoveredEnvelope = JSON.parse(recovered.requestEnvelope.toString('utf8')) as { body_base64url: string }
      expect(Buffer.from(recoveredEnvelope.body_base64url, 'base64url').toString('utf8')).toContain(input.activationCode)
    })
  })

  it('restores a PostgreSQL pending operation and its separate key volume as one decryptable backup pair', async () => {
    await withSandbox(async source => {
      const input = activationInput()
      const operation = await createOrLoadActivationOperation(source.db, source.pendingRoot, input)
      await allocateLicenseOperationAttempt(source.db, source.pendingRoot,
        attemptInput(input.operationId, operation.intentDigest))
      const sourceOperation = await source.db.selectFrom('local_license_operations').selectAll()
        .where('operation_id', '=', input.operationId).executeTakeFirstOrThrow()
      const sourceAttempt = await source.db.selectFrom('local_license_operation_attempts').selectAll()
        .where('operation_id', '=', input.operationId).where('attempt_no', '=', 1).executeTakeFirstOrThrow()

      const restoredSchema = `license_pending_restore_${randomUUID().replaceAll('-', '')}`
      schemas.add(restoredSchema)
      await adminPool.query(`CREATE SCHEMA "${restoredSchema}"`)
      const restoredPool = new Pool({
        connectionString: testDatabaseUrl,
        options: `-c search_path=${restoredSchema}`,
        max: 2,
        application_name: 'aikayun-license-pending-restore-test',
      })
      const restoredDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: restoredPool }) })
      const restoredRoot = await mkdtemp(join(tmpdir(), 'aikayun-license-pending-restored-'))
      pendingRoots.add(restoredRoot)
      try {
        await sql.raw(`CREATE TABLE installation_binding (
          singleton boolean PRIMARY KEY DEFAULT true,
          database_id uuid NOT NULL UNIQUE,
          instance_id uuid NOT NULL UNIQUE,
          identity_jkt char(43) NOT NULL,
          binding_revision bigint NOT NULL DEFAULT 1,
          binding_state text NOT NULL DEFAULT 'ready',
          created_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )`).execute(restoredDb)
        await restoredDb.insertInto('installation_binding').values({
          singleton: true,
          database_id: vector.input.databaseId,
          instance_id: vector.input.instanceId,
          identity_jkt: testIdentityJkt,
          binding_revision: '1',
          binding_state: 'ready',
        }).execute()
        await localLicenseOperationsMigration.up(restoredDb)
        await restoredDb.insertInto('local_license_operations').values(sourceOperation).execute()
        await restoredDb.insertInto('local_license_operation_attempts').values(sourceAttempt).execute()
        const sourceKey = join(source.pendingRoot, 'license-pending-aes-256-gcm.json')
        const restoredKey = join(restoredRoot, 'license-pending-aes-256-gcm.json')
        await copyFile(sourceKey, restoredKey)
        await chmod(restoredKey, 0o600)

        const check = await runChild({ schema: restoredSchema, pendingRoot: restoredRoot } as Sandbox, 'restore-check', input)
        expect(check.code).toBe(0)
        expect(check.stdout).toContain('verified operations=1 attempts=1')
        expect(check.stdout).not.toContain(input.activationCode)
        expect(await readActivationOperationPayload(restoredDb, restoredRoot, input.operationId))
          .toEqual({ activationCode: input.activationCode, origin: input.origin })

        const missingRoot = await mkdtemp(join(tmpdir(), 'aikayun-license-pending-missing-'))
        pendingRoots.add(missingRoot)
        await expect(readActivationOperationPayload(restoredDb, missingRoot, input.operationId))
          .rejects.toMatchObject({ code: 'pending_key_missing' })
        const secondKeyRoot = await mkdtemp(join(tmpdir(), 'aikayun-license-pending-substitute-'))
        pendingRoots.add(secondKeyRoot)
        await initializeTemporaryLicensePendingKey(secondKeyRoot, 'test')
        await expect(readActivationOperationPayload(restoredDb, secondKeyRoot, input.operationId))
          .rejects.toMatchObject({ code: 'pending_key_id_mismatch' })

        const pairedKey = JSON.parse(await readFile(restoredKey, 'utf8')) as {
          schema: number; purpose: string; key_id: string; key: string
        }
        pairedKey.key = Buffer.alloc(32, 0x44).toString('base64url')
        await writeFile(restoredKey, `${JSON.stringify(pairedKey)}\n`, { mode: 0o600 })
        await expect(readActivationOperationPayload(restoredDb, restoredRoot, input.operationId))
          .rejects.toMatchObject({ code: 'pending_decryption_authentication_failed' })
        const retained = await restoredDb.selectFrom('local_license_operations').select('state')
          .where('operation_id', '=', input.operationId).executeTakeFirst()
        expect(retained?.state).toBe('pending')
      } finally {
        await restoredDb.destroy()
        await adminPool.query(`DROP SCHEMA IF EXISTS "${restoredSchema}" CASCADE`)
        schemas.delete(restoredSchema)
        await rm(restoredRoot, { recursive: true, force: true })
        pendingRoots.delete(restoredRoot)
      }
    })
  })
})
