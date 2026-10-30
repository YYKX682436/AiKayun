import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import type { LookupFunction } from 'node:net'
import { performance } from 'node:perf_hooks'
import { parseStrictJson } from '../strict-json.js'
import { createTimeAnchorNonce, MAX_TIME_ANCHOR_RTT_MS, verifyTimeAnchorWithTrustBundleCandidate } from '../crypto/time-anchor.js'
import type { VerifiedTimeAnchor } from '../crypto/time-anchor.js'
import type { RootAuthenticatedTrustBundleCandidate } from './trust-bundle.js'
import type { TrustedReleaseLicenseConfig } from '../trusted-release-config.js'

const MAX_RESPONSE_BYTES = 4 * 1024
const MAX_ANCHOR_AGE_MS = 30_000

export interface TrustedTimeSample {
  readonly anchor: VerifiedTimeAnchor
  readonly requestStartedAt: number
  readonly responseReceivedAt: number
  readonly roundTripMs: number
  readCurrentTrustedTime(): number
  assertFresh(): number
}

function exactObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\n') !== [...fields].sort().join('\n')) throw new Error(`${label} has an invalid schema`)
  return record
}

function readBoundedJson(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    response.on('data', (chunk: Buffer | Uint8Array | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        response.destroy(new Error('Time-anchor response exceeds its size limit'))
        return
      }
      chunks.push(bytes)
    })
    response.on('error', reject)
    response.on('end', () => resolve(Buffer.concat(chunks, size)))
  })
}

function postNonce(
  config: TrustedReleaseLicenseConfig,
  nonce: string,
  options: { testCa?: string | Buffer; testLookup?: LookupFunction } = {},
): Promise<{ body: Buffer; roundTripMs: number; requestStartedAt: number; responseReceivedAt: number }> {
  const target = new URL('/v1/time-anchor', config.expected_center_origin)
  if (target.protocol !== 'https:' || target.origin !== config.expected_center_origin || target.pathname !== '/v1/time-anchor' || target.search || target.hash) {
    throw new Error('Time-anchor target must be the configured HTTPS origin')
  }
  if ((options.testCa !== undefined || options.testLookup !== undefined) && process.env.NODE_ENV !== 'test') {
    throw new Error('Test-only TLS and DNS overrides are restricted to isolated test runs')
  }
  const requestBody = Buffer.from(JSON.stringify({ client_nonce: nonce }), 'utf8')
  let requestOptions: RequestOptions = {
    protocol: 'https:',
    hostname: target.hostname,
    port: target.port || 443,
    path: '/v1/time-anchor',
    method: 'POST',
    agent: false,
    rejectUnauthorized: true,
    servername: target.hostname,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': requestBody.byteLength,
    },
  }
  if (options.testCa !== undefined) requestOptions = { ...requestOptions, ca: options.testCa }
  if (options.testLookup !== undefined) requestOptions = { ...requestOptions, lookup: options.testLookup }

  return new Promise((resolve, reject) => {
    const requestStartedAt = performance.now()
    const request = httpsRequest(requestOptions, async (response) => {
      try {
        if (response.statusCode !== 200) throw new Error('Time-anchor endpoint returned a non-success status')
        const contentType = String(response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase()
        if (contentType !== 'application/json') throw new Error('Time-anchor endpoint returned a non-JSON response')
        const contentLength = response.headers['content-length']
        if (contentLength !== undefined) {
          if (typeof contentLength !== 'string' || !/^(0|[1-9][0-9]*)$/.test(contentLength)) {
            throw new Error('Time-anchor response has an invalid content length')
          }
          if (Number(contentLength) > MAX_RESPONSE_BYTES) throw new Error('Time-anchor response exceeds its size limit')
        }
        const body = await readBoundedJson(response)
        const responseReceivedAt = performance.now()
        const roundTripMs = responseReceivedAt - requestStartedAt
        if (!Number.isFinite(roundTripMs) || roundTripMs < 0 || roundTripMs > MAX_TIME_ANCHOR_RTT_MS) {
          throw new Error('Time-anchor network round trip exceeded 5000ms')
        }
        resolve({ body, roundTripMs, requestStartedAt, responseReceivedAt })
      } catch (error) {
        response.destroy()
        reject(error)
      }
    })
    const timer = setTimeout(() => request.destroy(new Error('Time-anchor request timed out')), MAX_TIME_ANCHOR_RTT_MS)
    request.once('close', () => clearTimeout(timer))
    request.once('error', reject)
    request.end(requestBody)
  })
}

/** Node's normal TLS validation stays enabled; redirects are rejected because this client never follows them. */
export async function fetchTrustedTimeAnchor(
  config: TrustedReleaseLicenseConfig,
  candidate: RootAuthenticatedTrustBundleCandidate,
  options: { testCa?: string | Buffer; testLookup?: LookupFunction } = {},
): Promise<TrustedTimeSample> {
  if (candidate.claims.sub !== config.expected_center_issuer) throw new Error('Candidate bundle does not match the configured center issuer')
  const nonce = createTimeAnchorNonce()
  const response = await postNonce(config, nonce, options)
  const json = parseStrictJson(response.body)
  const envelope = exactObject(json, ['time_anchor'], 'Time-anchor response')
  if (typeof envelope.time_anchor !== 'string' || envelope.time_anchor.length === 0) throw new Error('Time-anchor response token is missing')
  const anchor = await verifyTimeAnchorWithTrustBundleCandidate(envelope.time_anchor, {
    candidate,
    clientNonce: nonce,
    roundTripMs: response.roundTripMs,
  })
  const assertFresh = (): number => {
    const now = performance.now()
    const afterResponseMs = now - response.responseReceivedAt
    if (!Number.isFinite(afterResponseMs) || afterResponseMs < 0 || response.roundTripMs + afterResponseMs >= MAX_ANCHOR_AGE_MS) {
      throw new Error('Time-anchor sample is stale; fetch a new signed anchor')
    }
    const trustedTime = anchor.serverTime + Math.floor(afterResponseMs / 1000)
    if (!Number.isSafeInteger(trustedTime) || trustedTime >= anchor.expiresAt) throw new Error('Time-anchor sample has expired')
    return trustedTime
  }
  const sample: TrustedTimeSample = Object.freeze({
    anchor,
    requestStartedAt: response.requestStartedAt,
    responseReceivedAt: response.responseReceivedAt,
    roundTripMs: response.roundTripMs,
    readCurrentTrustedTime: assertFresh,
    assertFresh,
  })
  sample.assertFresh()
  return sample
}
