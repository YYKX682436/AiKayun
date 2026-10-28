import { createServer, request as httpRequest } from 'node:http'
import { signKayixinV3 } from '../src/commerce/kayixin-customer-v3.js'
import { describe, expect, it, vi } from 'vitest'
import { encodeFixtureCreate } from '../src/commerce/kayixin-procurement-protocol.js'
import { createKayixinProcurementFixtureTransport } from './fixtures/kayixin-procurement-transport.js'

const source = { baseUrl: 'https://fixture.invalid', appId: '123', appSecret: 'secret' }
const query = { operationId: 'op', requestIdentity: 'local', generation: 1, action: 'query' as const, supplierOrderNumber: null }

describe('offline V3 procurement protocol boundary', () => {
  it('encodes documented synthetic create shape and rejects malformed values', () => {
    const input = { goodsId: 1, count: 2, notifyUrl: '', outerNumber: 'test', safePrice: '12.30', sku: 'S', attach: [{ name: '账号', value: '一' }] }
    expect(JSON.parse(encodeFixtureCreate(input))).toEqual(input)
    expect(() => encodeFixtureCreate({ ...input, count: 0 })).toThrow()
    expect(() => encodeFixtureCreate({ ...input, goodsId: 1.5 })).toThrow()
    expect(() => encodeFixtureCreate({ ...input, count: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(() => encodeFixtureCreate({ ...input, sku: 'x'.repeat(201) })).toThrow()
    expect(() => encodeFixtureCreate({ ...input, attach: [{ name: '', value: 'x' }] })).toThrow()
    expect(() => encodeFixtureCreate({ ...input, safePrice: '1e2' })).toThrow()
    expect(() => encodeFixtureCreate({ ...input, attach: [input.attach[0]!, input.attach[0]!] })).toThrow()
  })
  it('signs exact query bytes, checks identity and never interprets status as delivery', async () => {
    const wire = vi.fn(async (request: { path: string; headers: Record<string, string>; body: string }) => {
      expect(request.path).toBe('/api/v3/order/getDetail')
      expect(request.headers['X-Signature']).toBe('6e9b5a869cc019b941ac409e4dbafe54')
      expect(JSON.parse(request.body)).toEqual({ outerNumber: 'fixture-一' })
      return { status: 200, body: JSON.stringify({ code: 1000, msg: 'ok', data: { orderNumber: 'order', outerNumber: 'fixture-一', status: 3 } }) }
    })
    const transport = createKayixinProcurementFixtureTransport({ supplier: source, timestamp: () => '1700000000', outerNumberForOperation: () => 'fixture-一', wire })
    expect(await transport(query)).toMatchObject({ kind: 'unknown', supplierOrderNumber: 'order', requestIdentity: 'local' })
    expect(await transport({ ...query, action: 'submit' })).toMatchObject({ kind: 'unknown', supplierOrderNumber: null })
    expect(wire).toHaveBeenCalledTimes(1)
    // No fixture data, even syntactically valid data, permits submission.
    expect(await transport({ ...query, action: 'submit', supplierOrderNumber: 'known' })).toMatchObject({ kind: 'unknown' })
    expect(wire).toHaveBeenCalledTimes(1)
  })
  it('sends the synthetic documented create shape and exact signed bytes to an isolated loopback fixture', async () => {
    const body = encodeFixtureCreate({ goodsId: 1, count: 2, notifyUrl: '', outerNumber: 'fixture-1', safePrice: '12.30', sku: 'S', attach: [{ name: 'account', value: 'abc' }] })
    const signature = signKayixinV3('123', 'secret', '1700000000', body)
    expect(signature).toBe('1ada481219b3ed7d99d518cba2c379cf')
    const fixture = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const bytes = Buffer.concat(chunks)
        const valid = req.method === 'POST' && req.url === '/api/v3/order/create'
          && req.headers['x-app-id'] === '123' && req.headers['x-version'] === '3.0'
          && req.headers['x-timestamp'] === '1700000000' && req.headers['x-signature'] === '1ada481219b3ed7d99d518cba2c379cf'
          && bytes.equals(Buffer.from(body, 'utf8'))
        res.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: valid ? 1000 : 400, msg: 'fixture only' }))
      })
    })
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
    try {
      const address = fixture.address()
      if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/v3/order/create', method: 'POST', headers: {
          'X-APP-ID': '123', 'X-Version': '3.0', 'X-Timestamp': '1700000000', 'X-Signature': signature,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
        req.on('error', reject)
        req.end(body, 'utf8')
      })
      expect(status).toBe(200)
    } finally { await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve())) }
  })
  it('uses known supplier identity and reports conflicting echoes without retaining the wrong number', async () => {
    const wire = vi.fn(async (request: { body: string }) => {
      expect(JSON.parse(request.body)).toEqual({ orderNumber: 'known' })
      return { status: 200, body: JSON.stringify({ code: 1000, msg: 'ok', data: { outerNumber: 'fixture', orderNumber: 'different' } }) }
    })
    const transport = createKayixinProcurementFixtureTransport({ supplier: source, timestamp: () => '1700000000', outerNumberForOperation: () => 'fixture', wire })
    expect(await transport({ ...query, supplierOrderNumber: 'known' })).toMatchObject({ kind: 'unknown', identityConflict: true, supplierOrderNumber: null })
  })
  it('fails closed on missing or mismatching identity and upstream errors', async () => {
    for (const body of ['{}', '{', JSON.stringify({ code: 1000, msg: 'ok', data: { outerNumber: 'other', orderNumber: 'order' } })]) {
      const transport = createKayixinProcurementFixtureTransport({ supplier: source, timestamp: () => '1700000000', outerNumberForOperation: () => 'fixture', wire: async () => ({ status: 200, body }) })
      expect(await transport(query)).toMatchObject({ kind: 'unknown', supplierOrderNumber: null })
    }
  })
})
