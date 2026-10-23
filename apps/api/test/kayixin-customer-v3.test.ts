import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readConfig, type AppConfig } from '../src/config.js'
import { readKayixinAccount, readKayixinGoodDetail, readKayixinGoods, signKayixinV3, type KayixinV3Source } from '../src/commerce/kayixin-customer-v3.js'
import { requestSupplierWire, validateSupplierBaseUrl } from '../src/commerce/supplier-http.js'
import { fixtureKayixinCredentials, fixtureProduct, startKayixinV3Fixture } from './fixtures/kayixin-v3-server.js'

let fixture: Awaited<ReturnType<typeof startKayixinV3Fixture>>
let config: AppConfig
const identity: KayixinV3Source = { connectionId: randomUUID(), configurationVersionId: randomUUID(), configurationVersionNumber: 1 }
const supplier = () => ({ baseUrl: fixture.baseUrl, ...fixtureKayixinCredentials })
beforeAll(async () => {
  fixture = await startKayixinV3Fixture()
  config = readConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000', SUPPLIER_HTTP_TEST_ALLOWLIST: fixture.baseUrl })
})
afterAll(async () => { await fixture.close() })

describe('⑥-1 concrete Kayixin customer V3 wire contract', () => {
  it('matches fixed UTF-8 vectors independently calculated with Python hashlib and OpenSSL', async () => {
    const vectors = JSON.parse(await readFile(new URL('./fixtures/kayixin-signature-vectors.json', import.meta.url), 'utf8')) as Array<{
      appId: string; appSecret: string; timestamp: string; bodyJson: string; expected: string
    }>
    for (const row of vectors) expect(signKayixinV3(row.appId, row.appSecret, row.timestamp, row.bodyJson)).toBe(row.expected)
    expect(new Set(vectors.map(row => row.expected)).size).toBe(vectors.length)
  })
  it('captures real POST bytes, signs empty account body, preserves numeric lexemes and pagination', async () => {
    const account = await readKayixinAccount(config, supplier(), identity)
    expect(account.balance).toEqual({ amount: '1234.123456789012345678', currency: null, basis: 'upstream_account_reference', actualDebitVerified: false })
    expect(fixture.requests.at(-1)!.body.byteLength).toBe(0)
    const keyWord = '中文 & + "会员" / 😃'
    const page = await readKayixinGoods(config, supplier(), identity, { page: 2, keyWord })
    expect(page).toMatchObject({ requestedPage: 2, upstreamPagination: { allCount: 2, allPage: 2, semanticsVerified: false } })
    expect(page.items[0]).toMatchObject({ upstreamProductId: '201002', quote: { amount: '12.345678901234567890' }, procurementReady: false })
    const captured = fixture.requests.at(-1)!
    const expectedBody = JSON.stringify({ page: 2, goodsType: '', keyWord, skuType: '', showDirId: '1', dirId: '', brandId: '' })
    expect(captured.body.equals(Buffer.from(expectedBody, 'utf8'))).toBe(true)
    expect(captured.headers.authorization).toBeUndefined()
    expect(captured.headers['x-version']).toBe('3.0')
    expect(captured.headers['content-length']).toBe(String(Buffer.byteLength(expectedBody)))
    const independent = createHash('md5').update(Buffer.concat([
      Buffer.from(`${fixtureKayixinCredentials.appId}${fixtureKayixinCredentials.appSecret}3.0${captured.headers['x-timestamp']}`, 'utf8'), captured.body,
    ])).digest('hex')
    expect(captured.headers['x-signature']).toBe(independent)
  })
  it('parses documented multi-SKU, multiple single-SKU and nested recharge template structures without running code', async () => {
    const detail = await readKayixinGoodDetail(config, supplier(), identity, 201001)
    expect(detail.source).toMatchObject(identity)
    expect(detail.quantityRules).toEqual({ minQuantity: 2, maxQuantity: 100, multiple: 3, conversionVerified: false })
    expect(detail.variants[0]).toMatchObject({ upstreamSku: 'cn-member', combination: [{ title: '地区', value: '中国' }], quote: { amount: '12.345678901234567890' }, stock: { reportedCount: 9 } })
    expect(detail.capabilities).toMatchObject({ repeatOrder: false, refundOrder: true, refundMoney: false, warrantyDays: 7 })
    expect(detail.purchaseFields?.map(field => field.type)).toEqual([0, 1, 13, 14, 15, 16])
    expect(detail.purchaseFields?.[5]?.options[0]).toMatchObject({ name: '广西', value: 'guangxi', children: [{ name: '南宁市', value: 'nanning' }], expand: [{ type: 14, options: [{ name: '身份证后六位', value: '1' }] }, { type: 0 }] })
    expect(detail.detail).toContain('<script>')
    expect((await readKayixinGoodDetail(config, supplier(), identity, 201002)).variants[0]).toMatchObject({ upstreamSku: 'monthly', combination: [{ title: '套餐', value: '月卡' }] })
  })
  it('keeps missing quote, supply, and quantity fields unknown instead of zero or unlimited', async () => {
    fixture.setData(() => ({ goodsId: 201001, name: '不完整观察', goodsType: 77, status: 88 }))
    try {
      const item = await readKayixinGoodDetail(config, supplier(), identity, 201001)
      expect(item).toMatchObject({ quote: { amount: null }, stock: { reportedCount: null, availability: 'unknown' }, quantityRules: { minQuantity: null, maxQuantity: null, multiple: null }, purchaseFields: null, procurementReady: false })
      expect(item.warnings).toContain('上游商品类型或状态未知。')
    } finally { fixture.setData() }
  })
  it('rejects malformed essential fields, false free pricing, invalid stock and detail identity', async () => {
    for (const changed of [{ goodsId: undefined }, { name: null }, { goodsType: '3' }, { status: null }, { salesPrice: '-1' },
      { salesPrice: '0.1234567890123456789' }, { stockCount: -1 }, { multiple: '2' }, { goodsSku: {} },
      { rechargeTemplates: [{ type: 14, required: 2, options: [] }] }, { goodsId: 999 }]) {
      fixture.setData(() => ({ ...fixtureProduct(), ...changed }))
      try { await expect(readKayixinGoodDetail(config, supplier(), identity, 201001)).rejects.toHaveProperty('code') }
      finally { fixture.setData() }
    }
  })
  it('rejects auth failures, invalid JSON, missing data, redirects, excessive responses and secret echoes with safe errors', async () => {
    for (const [mode, code] of [['auth', 'kayixin_authentication_failed'], ['invalid_json', 'supplier_json_invalid'],
      ['missing', 'kayixin_response_invalid'], ['redirect', 'supplier_redirect_rejected'], ['large', 'supplier_response_too_large'],
      ['echo_secret', 'kayixin_sensitive_response']] as const) {
      fixture.setMode(mode)
      try {
        await expect(readKayixinAccount(config, supplier(), identity)).rejects.toMatchObject({ code })
      } finally { fixture.setMode('ok') }
    }
  })
  it('allows a bounded directory larger than 64 KiB while a legacy-sized wire call still rejects it', async () => {
    const data = { allCount: 6, allPage: 1, items: Array.from({ length: 6 }, (_, index) => ({ ...fixtureProduct(201001 + index), goodsDescribe: 'x'.repeat(16000) })) }
    fixture.setData(() => data)
    try {
      expect((await readKayixinGoods(config, supplier(), identity, { page: 1 })).items).toHaveLength(6)
      const timestamp = Math.floor(Date.now() / 1000).toString(), body = '{"page":1}'
      await expect(requestSupplierWire(config, new URL(`${fixture.baseUrl}/api/v3/goods/getList`), 'POST', {
        'X-APP-ID': fixtureKayixinCredentials.appId, 'X-Version': '3.0', 'X-Timestamp': timestamp,
        'X-Signature': signKayixinV3(fixtureKayixinCredentials.appId, fixtureKayixinCredentials.appSecret, timestamp, body),
      }, Buffer.from(body), { maxRequestBytes: 16384, maxResponseBytes: 65536 })).rejects.toMatchObject({ code: 'supplier_response_too_large' })
    } finally { fixture.setData() }
  })
  it('enforces an end-to-end timeout, including a server that never sends headers', async () => {
    fixture.setMode('timeout')
    try { await expect(readKayixinAccount(config, supplier(), identity)).rejects.toMatchObject({ code: 'supplier_timeout' }) }
    finally { fixture.setMode('ok') }
  }, 12000)
  it('keeps production HTTPS and request/operation bounds without expanding the legacy response limit', async () => {
    const production = { ...config, nodeEnv: 'production' as const }
    expect(() => validateSupplierBaseUrl(fixture.baseUrl, production)).toThrow()
    const countBefore = fixture.requests.length
    await expect(readKayixinAccount(config, { ...supplier(), baseUrl: `${fixture.baseUrl}/arbitrary-prefix` }, identity)).rejects.toMatchObject({ code: 'kayixin_origin_required' })
    expect(fixture.requests.length).toBe(countBefore)
    await expect(requestSupplierWire(production, new URL('http://8.8.8.8/api/v3/user/getAccount'), 'POST', {}, Buffer.alloc(0), { maxRequestBytes: 16384, maxResponseBytes: 65536 })).rejects.toMatchObject({ code: 'supplier_https_required' })
    await expect(requestSupplierWire(config, new URL(fixture.baseUrl), 'POST', {}, Buffer.alloc(17), { maxRequestBytes: 16, maxResponseBytes: 100 })).rejects.toMatchObject({ code: 'supplier_request_too_large' })
    expect(fixture.requests.every(row => ['/api/v3/user/getAccount', '/api/v3/goods/getList', '/api/v3/goods/getDetail'].includes(row.path))).toBe(true)
    expect(fixture.requests.every(row => row.method === 'POST')).toBe(true)
  })
})
