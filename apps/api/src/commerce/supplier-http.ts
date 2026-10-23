import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { AppConfig } from '../config.js'

const timeoutMs = 8_000

export function containsAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
}

export type SupplierErrorClass = 'transport_unknown' | 'http_unknown' | 'redirect_rejected'
  | 'response_invalid' | 'identity_mismatch' | 'result_invalid' | 'capability_missing'

export class SupplierHttpError extends Error {
  constructor(
    readonly classification: SupplierErrorClass,
    readonly code: string,
    readonly httpStatus: number | null = null,
  ) {
    super(code)
    this.name = 'SupplierHttpError'
  }
}

interface ResolvedAddress { address: string; family: 4 | 6 }

function ipv4Number(value: string): number | null {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0
}

function inV4Cidr(value: number, base: string, bits: number): boolean {
  const network = ipv4Number(base)
  if (network === null) return true
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (network & mask)
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address)
  if (value === null) return false
  const denied: Array<[string, number]> = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ]
  return !denied.some(([base, bits]) => inV4Cidr(value, base, bits))
}

function ipv6Groups(value: string): number[] | null {
  if (value.includes('%')) return null
  let input = value.toLowerCase()
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':')
    const v4 = ipv4Number(input.slice(lastColon + 1))
    if (v4 === null) return null
    input = `${input.slice(0, lastColon)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = input.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0]!.split(':') : []
  const right = halves[1] ? halves[1]!.split(':') : []
  if (halves.length === 1 && left.length !== 8) return null
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0
  if (zeros < 0 || (halves.length === 2 && zeros < 1)) return null
  const groups = [...left, ...Array.from({ length: zeros }, () => '0'), ...right]
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/u.test(group))) return null
  return groups.map(group => Number.parseInt(group, 16))
}

function isPublicIpv6(address: string): boolean {
  const groups = ipv6Groups(address)
  if (!groups) return false
  const first = groups[0]!
  const second = groups[1]!
  // Global unicast only. This excludes unspecified, loopback, mapped IPv4,
  // link-local, ULA, multicast, NAT64 and other non-global ranges.
  if ((first & 0xe000) !== 0x2000) return false
  if (first === 0x2002 || (first === 0x2001 && second <= 0x01ff)) return false
  if (first === 0x2001 && second === 0x0db8) return false
  // RFC 9637 documentation prefix, also inside 2000::/3.
  if (first === 0x3fff && (second & 0xf000) === 0) return false
  return true
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '')
  const family = isIP(normalized)
  return family === 4 ? isPublicIpv4(normalized) : family === 6 ? isPublicIpv6(normalized) : false
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '').toLowerCase()
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  const groups = ipv6Groups(normalized)
  return Boolean(groups && groups.every((part, index) => index === 7 ? part === 1 : part === 0))
}

export function validateSupplierBaseUrl(value: string, config: AppConfig): URL {
  if (value !== value.trim() || value.length > 2048 || containsAsciiControl(value) || /\s|\\/u.test(value)
    || /(?:^|\/)\.{1,2}(?:\/|$)|%(?:2e|2f|5c)/iu.test(value)) {
    throw new SupplierHttpError('response_invalid', 'supplier_url_invalid')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new SupplierHttpError('response_invalid', 'supplier_url_invalid') }
  if (!url.hostname || url.username || url.password || url.search || url.hash || url.href.length > 2048
    || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new SupplierHttpError('response_invalid', 'supplier_url_invalid')
  }
  if (url.protocol === 'http:' && !(config.nodeEnv === 'test' && config.supplierHttpTestAllowlist.includes(url.origin))) {
    throw new SupplierHttpError('response_invalid', 'supplier_https_required')
  }
  if (url.protocol === 'https:' && config.supplierHttpTestAllowlist.includes(url.origin)) {
    throw new SupplierHttpError('response_invalid', 'supplier_test_allowlist_is_http_only')
  }
  return url
}

export async function resolvePinnedAddress(
  url: URL,
  config: AppConfig,
  resolveHostname: (hostname: string) => Promise<ResolvedAddress[]> = async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true }))
      .map(row => ({ address: row.address, family: row.family as 4 | 6 })),
): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/gu, '')
  const family = isIP(host)
  let addresses: ResolvedAddress[]
  if (family) {
    addresses = [{ address: host, family: family as 4 | 6 }]
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      addresses = await Promise.race([
        resolveHostname(host),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SupplierHttpError('transport_unknown', 'supplier_dns_timeout')), timeoutMs)
          timer.unref()
        }),
      ])
    } catch (error) {
      if (error instanceof SupplierHttpError) throw error
      throw new SupplierHttpError('transport_unknown', 'supplier_dns_failed')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  if (!addresses.length) throw new SupplierHttpError('transport_unknown', 'supplier_dns_empty')
  const testAllowed = config.nodeEnv === 'test' && url.protocol === 'http:'
    && config.supplierHttpTestAllowlist.includes(url.origin)
  const allAllowed = addresses.every(row => testAllowed ? isLoopbackAddress(row.address) : isPublicAddress(row.address))
  if (!allAllowed) throw new SupplierHttpError('response_invalid', 'supplier_address_not_public')
  return addresses[0]!
}

export function appendPath(baseUrl: URL, suffix: string): URL {
  const basePath = baseUrl.pathname.replace(/\/+$/u, '')
  return new URL(`${basePath}${suffix}`, baseUrl.origin)
}

export interface WireResponse { status: number; contentType: string; body: Buffer; sha256: string }

export async function requestSupplierWire(
  config: AppConfig,
  target: URL,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  encodedBody: Buffer | undefined,
  limits: { maxRequestBytes: number; maxResponseBytes: number },
): Promise<WireResponse> {
  // Enforce transport policy even when an internal caller bypasses the base URL helper.
  // Do not apply base-path rules to escaped operation IDs in legacy query URLs.
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new SupplierHttpError('response_invalid', 'supplier_url_invalid')
  }
  if (target.protocol === 'http:' && !(config.nodeEnv === 'test' && config.supplierHttpTestAllowlist.includes(target.origin))) {
    throw new SupplierHttpError('response_invalid', 'supplier_https_required')
  }
  const { maxRequestBytes, maxResponseBytes } = limits
  const startedAt = performance.now()
  if (encodedBody && encodedBody.length > maxRequestBytes) throw new SupplierHttpError('response_invalid', 'supplier_request_too_large')
  const pinned = await resolvePinnedAddress(target, config)
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise<WireResponse>((resolve, reject) => {
    let settled = false
    const finishReject = (error: SupplierHttpError) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = transport(target, {
      method,
      agent: false,
      rejectUnauthorized: true,
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        ...headers,
        ...(encodedBody ? { 'content-type': 'application/json', 'content-length': String(encodedBody.length) } : {}),
      },
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) {
          callback(null, [{ address: pinned.address, family: pinned.family }])
        } else callback(null, pinned.address, pinned.family)
      },
      servername: isIP(target.hostname.replace(/^\[|\]$/gu, '')) ? undefined : target.hostname,
    }, (response) => {
      const status = response.statusCode ?? 0
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        response.destroy()
        finishReject(new SupplierHttpError('response_invalid', 'supplier_response_too_large', status))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += value.length
        if (size > maxResponseBytes) {
          response.destroy()
          finishReject(new SupplierHttpError('response_invalid', 'supplier_response_too_large', status))
          return
        }
        chunks.push(value)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        const bytes = Buffer.concat(chunks)
        resolve({
          status,
          contentType: String(response.headers['content-type'] ?? '').toLowerCase(),
          body: bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      })
      response.on('error', () => finishReject(new SupplierHttpError('transport_unknown', 'supplier_response_interrupted', status || null)))
    })
    const timer = setTimeout(() => request.destroy(new Error('supplier_timeout')), Math.max(1, timeoutMs - (performance.now() - startedAt)))
    timer.unref()
    request.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      const code = error.message === 'supplier_timeout' ? 'supplier_timeout'
        : error.code === 'ECONNREFUSED' ? 'supplier_connection_refused'
          : error.code === 'ETIMEDOUT' ? 'supplier_timeout' : 'supplier_network_error'
      finishReject(new SupplierHttpError('transport_unknown', code))
    })
    request.on('close', () => clearTimeout(timer))
    if (encodedBody) request.write(encodedBody)
    request.end()
  })
}

export function parseSupplierJson(response: WireResponse, reviver?: (key: string, value: unknown, context?: { source?: string }) => unknown): Record<string, unknown> {
  if (response.status >= 300 && response.status < 400) {
    throw new SupplierHttpError('redirect_rejected', 'supplier_redirect_rejected', response.status)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SupplierHttpError('http_unknown', `supplier_http_${response.status || 'unknown'}`, response.status || null)
  }
  if (!response.contentType.startsWith('application/json')) {
    throw new SupplierHttpError('response_invalid', 'supplier_content_type_invalid', response.status)
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body), reviver) as unknown }
  catch { throw new SupplierHttpError('response_invalid', 'supplier_json_invalid', response.status) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SupplierHttpError('response_invalid', 'supplier_json_shape_invalid', response.status)
  }
  return value as Record<string, unknown>
}
