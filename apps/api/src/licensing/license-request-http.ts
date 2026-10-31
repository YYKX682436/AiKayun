import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { LookupFunction } from 'node:net'
import {
  genSingleRFC9530DigestHeader,
  signAsRFC9421ToRequestOrResponse,
} from '@misskey-dev/node-http-message-signatures'
import type { CustomSigningKey } from '@misskey-dev/node-http-message-signatures'
import { ByteSequence, parseDictionary, serializeDictionary } from 'structured-headers'

export const LICENSE_CHALLENGE_PATH = '/v1/challenges'
export const LICENSE_ACTIVATION_PATH = '/v1/activations'
export const LICENSE_LEASE_RENEW_PATH = '/v1/leases/renew'
export const LICENSE_OPERATION_QUERY_PATH = '/v1/operations/query'
export const LICENSE_OPERATION_CONTINUE_PATH = '/v1/operations/continue'
export const LICENSE_REQUEST_TIMEOUT_MS = 5_000
export const LICENSE_RESPONSE_HEADER_LIMIT = 8 * 1024
export const LICENSE_RESPONSE_BODY_LIMIT = 16 * 1024
export const LICENSE_SIGNED_COMPONENTS = ['@method', '@target-uri', 'content-type', 'content-digest'] as const

export type LicenseRequestPath = typeof LICENSE_CHALLENGE_PATH | typeof LICENSE_ACTIVATION_PATH |
  typeof LICENSE_LEASE_RENEW_PATH | typeof LICENSE_OPERATION_QUERY_PATH | typeof LICENSE_OPERATION_CONTINUE_PATH

export interface LicenseRequestIdentity {
  readonly identityJkt: string
  sign(message: Uint8Array): Buffer
}

export interface SignedLicenseRequest {
  readonly body: Buffer
  readonly headers: Record<string, string>
}

export interface LicenseResponse {
  readonly statusCode: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

export interface TestLicenseTlsOptions {
  readonly ca?: string | Buffer
  readonly lookup?: LookupFunction
}

export class LicenseHttpsRequestError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LicenseHttpsRequestError'
  }
}

function fail(code: string): never {
  throw new LicenseHttpsRequestError(code)
}

function validOrigin(origin: URL): void {
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
    origin.search || origin.hash || origin.origin !== origin.href.replace(/\/$/u, '')) {
    fail('license_request_target_invalid')
  }
}

/** Build RFC 9421/RFC 9530 evidence once; callers persist and later send these exact bytes. */
export async function createSignedLicenseRequest(input: {
  origin: URL
  path: LicenseRequestPath
  body: Buffer
  identity: LicenseRequestIdentity
  nonce: string
  created: number
}): Promise<SignedLicenseRequest> {
  validOrigin(input.origin)
  if (!Number.isSafeInteger(input.created) || input.created <= 0 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(input.nonce) || Buffer.from(input.nonce, 'base64url').length !== 32 ||
    Buffer.from(input.nonce, 'base64url').toString('base64url') !== input.nonce) fail('license_request_signing_failed')

  const digestEntries = await genSingleRFC9530DigestHeader(new Uint8Array(input.body), 'SHA-256')
  const digestEntryGenerated = digestEntries[0]
  if (!digestEntryGenerated) fail('license_request_signing_failed')
  const [digestName, [digestBytes, digestParams]] = digestEntryGenerated
  const digestHeader = serializeDictionary(new Map([
    [digestName, [new ByteSequence(digestBytes.toBase64()), digestParams]],
  ]))
  const host = input.origin.host
  const signable = {
    method: 'POST',
    url: input.path,
    headers: { host, 'content-type': 'application/json', 'content-digest': digestHeader },
  }
  const signingKey: CustomSigningKey = {
    keyId: input.identity.identityJkt,
    algorithm: { name: 'Ed25519' },
    signatureAlgorithm: 'ed25519',
    signer: async ({ signingString }) => input.identity.sign(Buffer.from(signingString, 'utf8')),
  }
  let signed: Awaited<ReturnType<typeof signAsRFC9421ToRequestOrResponse>>
  try {
    signed = await signAsRFC9421ToRequestOrResponse(signable, {
      sig1: {
        key: signingKey,
        identifiers: [...LICENSE_SIGNED_COMPONENTS],
        created: input.created,
        expiresAfter: 60,
        nonce: input.nonce,
        tag: 'aikayun-license-v1',
      },
    }, { scheme: 'https' })
  } catch {
    return fail('license_request_signing_failed')
  }

  let signatureInput: ReturnType<typeof parseDictionary>
  let signatureDictionary: ReturnType<typeof parseDictionary>
  let contentDigest: ReturnType<typeof parseDictionary>
  try {
    signatureInput = parseDictionary(signed.inputHeader)
    signatureDictionary = parseDictionary(signed.signatureHeader)
    contentDigest = parseDictionary(digestHeader)
  } catch {
    return fail('license_request_signing_failed')
  }
  const signatureInputEntry = signatureInput.get('sig1')
  const signatureEntry = signatureDictionary.get('sig1')
  const digestEntry = contentDigest.get('sha-256')
  if (signatureInput.size !== 1 || !signatureInputEntry || !Array.isArray(signatureInputEntry) ||
    signatureDictionary.size !== 1 || !signatureEntry || !Array.isArray(signatureEntry) ||
    signatureEntry[1].size !== 0 || !(signatureEntry[0] instanceof ByteSequence) ||
    contentDigest.size !== 1 || !digestEntry || !Array.isArray(digestEntry) ||
    !(digestEntry[0] instanceof ByteSequence) || digestEntry[1].size !== 0) return fail('license_request_signing_failed')

  const [components, params] = signatureInputEntry
  const componentNames = Array.isArray(components)
    ? components.map((entry) => Array.isArray(entry) ? entry[0] : entry)
    : []
  const expectedParamNames = ['alg', 'created', 'expires', 'keyid', 'nonce', 'tag']
  if (componentNames.length !== LICENSE_SIGNED_COMPONENTS.length ||
    componentNames.some((name, index) => name !== LICENSE_SIGNED_COMPONENTS[index]) ||
    [...params.keys()].sort().join(',') !== expectedParamNames.join(',') ||
    params.get('created') !== input.created || params.get('expires') !== input.created + 60 ||
    params.get('nonce') !== input.nonce || params.get('keyid') !== input.identity.identityJkt ||
    params.get('alg') !== 'ed25519' || params.get('tag') !== 'aikayun-license-v1') {
    return fail('license_request_signing_failed')
  }
  const expectedDigest = createHash('sha256').update(input.body).digest('base64')
  if (digestEntry[0].toBase64() !== expectedDigest) return fail('license_request_signing_failed')

  return {
    body: input.body,
    headers: {
      host,
      accept: 'application/json',
      'content-type': 'application/json',
      'content-digest': digestHeader,
      'signature-input': signed.inputHeader,
      signature: signed.signatureHeader,
      'content-length': String(input.body.byteLength),
      connection: 'close',
    },
  }
}

function readBoundedResponse(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    response.on('data', (chunk: Buffer | Uint8Array | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.byteLength
      if (size > maxBytes) {
        response.destroy()
        rejectOnce(new Error('response_limit'))
        return
      }
      chunks.push(bytes)
    })
    response.once('aborted', () => rejectOnce(new Error('response_aborted')))
    response.once('error', rejectOnce)
    response.once('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, size))
    })
  })
}

/** HTTPS only, fixed endpoint paths, default certificate/hostname checks, no redirect following. */
export async function postSignedLicenseRequest(input: {
  origin: URL
  path: LicenseRequestPath
  signed: SignedLicenseRequest
  testTls?: TestLicenseTlsOptions
}): Promise<LicenseResponse> {
  if (input.testTls !== undefined && process.env.NODE_ENV !== 'test') fail('license_test_transport_forbidden')
  validOrigin(input.origin)
  if (input.signed.headers.host !== input.origin.host ||
    input.signed.headers['content-length'] !== String(input.signed.body.byteLength)) fail('license_request_target_invalid')

  const requestOptions = {
    protocol: 'https:' as const,
    hostname: input.origin.hostname,
    port: input.origin.port ? Number(input.origin.port) : 443,
    path: input.path,
    method: 'POST' as const,
    agent: false as const,
    rejectUnauthorized: true as const,
    servername: input.origin.hostname,
    headers: input.signed.headers,
    maxHeaderSize: LICENSE_RESPONSE_HEADER_LIMIT,
    ...(input.testTls?.ca === undefined ? {} : { ca: input.testTls.ca }),
    ...(input.testTls?.lookup === undefined ? {} : { lookup: input.testTls.lookup }),
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const rejectOnce = (code: string) => {
      if (settled) return
      settled = true
      reject(new LicenseHttpsRequestError(code))
    }
    const request = httpsRequest(requestOptions, async (response) => {
      try {
        const contentLength = response.headers['content-length']
        if (contentLength !== undefined && (typeof contentLength !== 'string' ||
          !/^(0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > LICENSE_RESPONSE_BODY_LIMIT)) {
          response.destroy()
          rejectOnce('license_response_too_large')
          return
        }
        const body = await readBoundedResponse(response, LICENSE_RESPONSE_BODY_LIMIT)
        if (!settled) {
          settled = true
          resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body })
        }
      } catch {
        rejectOnce('license_response_invalid')
      }
    })
    const timeout = setTimeout(() => request.destroy(new Error('timeout')), LICENSE_REQUEST_TIMEOUT_MS)
    timeout.unref()
    request.once('close', () => clearTimeout(timeout))
    request.once('error', () => rejectOnce('license_transport_failed'))
    request.end(input.signed.body)
  })
}
