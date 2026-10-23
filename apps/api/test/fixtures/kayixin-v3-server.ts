import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export const fixtureKayixinCredentials = { appId: '602401', appSecret: 'fixture-V3-secret-only-never-real-2026!' }
export type FixtureMode = 'ok' | 'auth' | 'invalid_json' | 'missing' | 'redirect' | 'large' | 'timeout' | 'echo_secret'
export function fixtureProduct(goodsId = 201001) {
  return {
    goodsId, name: goodsId === 201001 ? '夹具会员 中文 & 特殊字符' : '夹具多单规格',
    goodsType: 3, status: 1, skuType: goodsId === 201001 ? 1 : 2,
    salesPrice: '12.345678901234567890', stockCount: 19, minQuantity: 2, maxQuantity: 100, multiple: 3,
    isRepeat: 0, isRefOrder: 1, isRefMoney: 0, warrantyDays: 7, warrantyTime: 7, warrantyUnit: 0,
    imgUrl: 'https://images.example.test/product.png', goodsDescribe: '仅用于协议夹具验证',
    goodsDetail: '<script>window.KAYIXIN_XSS = true</script><b>未信任详情</b>', buyNotice: '请核对地区和充值账号',
    goodsSku: { typeNames: [{ name: '地区', skuNames: [{ name: '中国' }, { name: '海外' }] }],
      details: [
        { sku: 'cn-member', names: [{ title: '地区', value: '中国' }], status: 1, money: '12.345678901234567890', count: 9 },
        { sku: 'global-member', names: [{ title: '地区', value: '海外' }], status: 0, money: '15.00001', count: 0 },
      ] },
    goodsSpec: [{ name: '套餐', items: [{ title: '月卡', sku: 'monthly', status: 1, money: '1.23456', count: 7 }] }],
    rechargeTemplates: [
      { type: 0, title: '充值账号', placeholder: '请输入账号', required: 1, regex: '^[a-zA-Z0-9]+$', options: [] },
      { type: 1, title: '图片凭证', placeholder: '', required: 0, regex: '', options: [] },
      { type: 13, title: '数字编号', placeholder: '', required: 1, regex: '', options: [] },
      { type: 14, title: '渠道', placeholder: '', required: 1, regex: '', options: [{ name: '默认', value: '' }] },
      { type: 15, title: '备注', placeholder: '', required: 0, regex: '', options: [] },
      { type: 16, title: '地区与验证', placeholder: '省市', required: 1, regex: '', options: [
        { name: '广西', value: 'guangxi', children: [{ name: '南宁市', value: 'nanning' }],
          expand: [{ type: 14, options: [{ name: '身份证后六位', value: '1' }] }, { type: 0, options: [] }] },
      ] },
    ],
  }
}
function encode(value: unknown): string {
  // Simulate the vendor's numeric JSON tokens with more digits than JS Number.
  return JSON.stringify(value).replace(/"(12\.345678901234567890|15\.00001|1\.23456|1234\.123456789012345678)"/gu, '$1')
}
export async function startKayixinV3Fixture(options: { port?: number; credentials?: Array<{ appId: string; appSecret: string }> } = {}) {
  const credentials = options.credentials ?? [fixtureKayixinCredentials]
  const requests: Array<{ path: string; method: string; body: Buffer; headers: Record<string, string | string[] | undefined> }> = []
  let mode: FixtureMode = 'ok'
  let override: ((path: string, body: Record<string, unknown>) => unknown) | undefined
  let barrier: { arrived: () => void; wait: Promise<void> } | undefined
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer(async (request, response) => {
    if (request.url === '/__fixture/health') { response.end('ok'); return }
    if (request.url === '/__fixture/stats') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ paths: requests.map(row => row.path) })); return
    }
    const parts: Buffer[] = []
    for await (const part of request) parts.push(Buffer.from(part))
    const bytes = Buffer.concat(parts)
    const bodyText = bytes.toString('utf8')
    const path = request.url ?? ''
    requests.push({ path, method: request.method ?? '', body: bytes, headers: { ...request.headers } })
    const allowedPaths = ['/api/v3/user/getAccount', '/api/v3/goods/getList', '/api/v3/goods/getDetail']
    response.setHeader('content-type', 'application/json')
    if (!allowedPaths.includes(path) || request.method !== 'POST') { response.statusCode = 405; response.end('{"code":4005,"msg":"forbidden operation"}'); return }
    const credential = credentials.find(row => row.appId === request.headers['x-app-id'])
    const timestamp = String(request.headers['x-timestamp'] ?? '')
    // Independent wire verifier: signs the bytes the server actually received.
    const expected = createHash('md5').update(Buffer.concat([
      Buffer.from(`${credential?.appId ?? ''}${credential?.appSecret ?? ''}3.0${timestamp}`, 'utf8'), bytes,
    ])).digest('hex')
    const signature = String(request.headers['x-signature'] ?? '')
    if (!credential || request.headers['x-version'] !== '3.0' || !/^\d{10}$/u.test(timestamp)
      || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) || mode === 'auth') {
      response.end(encode({ code: 1001, msg: `签名错误 ${credentials[0]!.appSecret}` })); return
    }
    if (barrier && path === '/api/v3/user/getAccount') {
      const pending = barrier; barrier = undefined; pending.arrived(); await pending.wait
    }
    if (mode === 'timeout') { await new Promise(resolve => setTimeout(resolve, 8500)); if (response.destroyed) return }
    if (mode === 'redirect') { response.statusCode = 302; response.setHeader('location', '/api/v3/order/create'); response.end('{}'); return }
    if (mode === 'invalid_json') { response.end('{"code":'); return }
    if (mode === 'missing') { response.end('{"code":1000,"msg":"ok","data":{}}'); return }
    if (mode === 'large') { response.end(' '.repeat(2 * 1024 * 1024 + 1)); return }
    if (mode === 'echo_secret') { response.end(encode({ code: 1000, msg: 'ok', data: { balance: credential.appSecret } })); return }
    let body: Record<string, unknown> = {}
    try { if (bodyText) body = JSON.parse(bodyText) } catch { response.statusCode = 400; response.end('{}'); return }
    let data: unknown
    if (override) data = override(path, body)
    else if (path.endsWith('/getAccount')) data = { balance: '1234.123456789012345678' }
    else if (path.endsWith('/getList')) data = { allCount: 2, allPage: 2, items: Number(body.page) <= 2 ? [fixtureProduct(Number(body.page) === 2 ? 201002 : 201001)] : [] }
    else data = fixtureProduct(Number(body.goodsId))
    response.end(encode({ code: 1000, msg: 'success', data }))
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    baseUrl, requests,
    setMode(value: FixtureMode) { mode = value },
    setData(value?: typeof override) { override = value },
    pauseNextAccount() {
      let arrived!: () => void; let release!: () => void
      const received = new Promise<void>(resolve => { arrived = resolve })
      const wait = new Promise<void>(resolve => { release = resolve })
      barrier = { arrived, wait }
      return { received, release }
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
if (process.argv.includes('--serve')) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Kayixin fixture may only run in NODE_ENV=test')
  const fixture = await startKayixinV3Fixture({ port: Number(process.env.KAYIXIN_FIXTURE_PORT ?? 3102) })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void fixture.close().then(() => process.exit(0)) })
}
