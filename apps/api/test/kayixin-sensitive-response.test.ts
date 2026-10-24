import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readConfig, type AppConfig } from '../src/config.js'
import { readKayixinGoodDetail } from '../src/commerce/kayixin-customer-v3.js'
import { fixtureProduct, fixtureKayixinSpecialCredentials as specialCredentials, startKayixinV3Fixture } from './fixtures/kayixin-v3-server.js'

let fixture: Awaited<ReturnType<typeof startKayixinV3Fixture>>, config: AppConfig
const identity = { connectionId: randomUUID(), configurationVersionId: randomUUID(), configurationVersionNumber: 1 }
beforeAll(async () => {
  fixture = await startKayixinV3Fixture({ credentials: specialCredentials })
  config = readConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000', SUPPLIER_HTTP_TEST_ALLOWLIST: fixture.baseUrl })
})
afterEach(() => fixture.setData())
afterAll(async () => fixture.close())
const cases = specialCredentials.flatMap((credentials, index) => ['description', 'nested'].map(location => ({ credentials, label: `${index + 1}/${location}`, location })))
describe('R1 sensitive strings through real V3 HTTP decoding and goods mapping', () => {
  it.each(cases)('rejects escaped secret echo $label without exposing its content', async ({ credentials, location }) => {
    fixture.setData(() => ({ ...fixtureProduct(), ...(location === 'description'
      ? { goodsDescribe: `说明前缀 ${credentials.appSecret} 后缀` }
      : { rechargeTemplates: [{ type: 16, title: '级联', required: 1, options: [{ name: '地区', value: 'cn', expand: [
        { type: 0, title: '嵌套展示字段', required: 1, placeholder: `提示 ${credentials.appSecret}`, regex: '', options: [] },
      ] }] }] }) }))
    const result = await readKayixinGoodDetail(config, { baseUrl: fixture.baseUrl, ...credentials }, identity, 201001)
      .then(value => ({ value, error: null }), error => ({ value: null, error }))
    expect(result.error).toMatchObject({ code: 'kayixin_sensitive_response', message: 'kayixin_sensitive_response' })
    expect(result.value).toBeNull()
    expect(String(result.error)).not.toContain(credentials.appSecret)
  })
  it.each(specialCredentials)('accepts legal special characters in the secret for AppID $appId when no echo exists', async credentials => {
    const result = await readKayixinGoodDetail(config, { baseUrl: fixture.baseUrl, ...credentials }, identity, 201001)
    expect(result.description).toBe('仅用于协议夹具验证')
    expect(result.variants[0]?.upstreamSku).toBe('cn-member')
  })
  it.each(['depth', 'nodes'])('bounds sensitive-response traversal by $0', async dimension => {
    let extra: unknown = 'unused'
    if (dimension === 'depth') for (let i = 0; i < 40; i++) extra = { child: extra }
    else extra = Array.from({ length: 60000 }, () => null)
    fixture.setData(() => ({ ...fixtureProduct(), extra }))
    await expect(readKayixinGoodDetail(config, { baseUrl: fixture.baseUrl, ...specialCredentials[0]! }, identity, 201001)).rejects.toMatchObject({ code: 'kayixin_response_invalid' })
  })
})
