import { randomUUID } from 'node:crypto'
import { expect, request as apiRequest, test, type APIRequestContext, type Page } from '@playwright/test'
import type { SupplierConnection } from '@aikayun/contracts'
import { createBrowserAdminSession } from './browser-admin-session'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100'
const contexts: APIRequestContext[] = []
let ip = 80
const pendingSignals: Array<() => void> = []
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); pendingSignals.push(resolve); return { promise, resolve } }
test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true', 'Requires the isolated V3 fixture.'); test.setTimeout(60000) })
test.afterEach(async () => { pendingSignals.splice(0).forEach(resolve => resolve()); await Promise.all(contexts.splice(0).map(context => context.dispose())) })
async function prepare(page: Page) {
  const session = { name: 'aikayun_admin_session', value: createBrowserAdminSession(), domain: new URL(baseURL).hostname,
    path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' as const }
  await page.context().addCookies([session])
  const forwarded = { 'x-forwarded-for': `198.51.100.${ip++}` }
  await page.setExtraHTTPHeaders(forwarded)
  const api = await apiRequest.newContext({ baseURL, storageState: { cookies: [session], origins: [] }, extraHTTPHeaders: forwarded })
  contexts.push(api)
  const csrf = (await (await api.get('/api/v1/admin/auth/csrf')).json()).data.csrfToken
  const headers = { origin: baseURL, 'x-csrf-token': csrf }
  const create = async (label: string) => {
    const response = await api.post('/api/v1/admin/supplier-connections', { headers, data: {
      name: `R1-${label}-${randomUUID().slice(0, 8)}`, providerType: 'kayixin_customer_v3', baseUrl: 'http://127.0.0.1:3102',
      credentials: { appId: '602401', appSecret: 'fixture-V3-secret-only-never-real-2026!' },
    } })
    expect(response.status()).toBe(201)
    return (await response.json()).data[0] as SupplierConnection
  }
  const a = await create('A'), b = await create('B')
  await page.goto('/admin/supplier-connections')
  await choose(page, a)
  return { a, b, api, headers }
}
async function choose(page: Page, connection: SupplierConnection) {
  await page.getByRole('button', { name: new RegExp(connection.name) }).click()
  await expect(page.getByLabel('供应商名称')).toHaveValue(connection.name)
}
const status = (page: Page) => page.locator('p').filter({ hasText: /^只读连接 (通过|失败)/u })
async function holdTest(page: Page, id: string, fail = false) {
  const arrived = deferred(), release = deferred(), done = deferred()
  await page.route(`**/api/v1/admin/supplier-connections/${id}/test`, async route => {
    const response = await route.fetch()
    const json = await response.json()
    arrived.resolve(); await release.promise
    await route.fulfill(fail ? { status: 502, json: { error: { code: 'R1_DELAYED_ERROR', message: 'R1-A迟到错误' } } }
      : { response, json: { ...json, data: { ...json.data, message: 'R1-A迟到测试结果' } } })
    done.resolve()
  })
  return { arrived, release, done }
}
for (const fail of [false, true]) test(`R1 ignores delayed A test ${fail ? 'error' : 'success'} after switching to B`, async ({ page }) => {
  const { a, b } = await prepare(page)
  const gate = await holdTest(page, a.id, fail)
  await page.getByRole('button', { name: '测试只读连接' }).click()
  await gate.arrived.promise
  await choose(page, b)
  gate.release.resolve(); await gate.done.promise
  await expect(page.getByRole('button', { name: '测试只读连接' })).toBeEnabled()
  await expect(status(page)).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('R1-A迟到')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('供应商名称')).toHaveValue(b.name)
})
test('R1 discards a v1 test after refreshing the same connection to v2', async ({ page }) => {
  const { a, api, headers } = await prepare(page)
  const gate = await holdTest(page, a.id)
  await page.getByRole('button', { name: '测试只读连接' }).click(); await gate.arrived.promise
  const saved = await api.put(`/api/v1/admin/supplier-connections/${a.id}`, { headers, data: {
    providerType: 'kayixin_customer_v3', name: a.name, baseUrl: a.currentVersion.baseUrl,
  } })
  expect(saved.status()).toBe(200)
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByText(`${a.name} · v2`, { exact: true })).toBeVisible()
  gate.release.resolve(); await gate.done.promise
  await expect(page.getByRole('button', { name: '测试只读连接' })).toBeEnabled()
  await expect(status(page)).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('R1-A迟到测试结果')
})
test('R1 shows the current test and complete nested expand requirements safely', async ({ page }) => {
  await prepare(page)
  await page.getByRole('button', { name: '测试只读连接' }).click()
  await expect(page.getByRole('status')).toContainText('只读连接正常')
  await expect(status(page)).toContainText('只读连接 通过')
  await page.getByRole('button', { name: '读取商品列表' }).click()
  await page.getByRole('button', { name: '夹具会员 中文 & 特殊字符', exact: true }).click()
  const detail = page.getByRole('article', { name: '上游商品详情' })
  await expect(detail).toContainText('扩展验证编号 · 单项选择 · 必填')
  await expect(detail).toContainText('提示：请输入扩展号码 <b>提示</b>')
  await expect(detail).toContainText('校验说明（不执行）：^[A-Z]{6}$ <script>window.KAYIXIN_EXPAND_XSS=true</script>')
  await expect(detail).toContainText('扩展备注 · 单行文本 · 选填')
  await expect(detail).toContainText('更深扩展字段 · 多行文本 · 必填性未知')
  await expect(detail).toContainText('更深提示 <img src=x onerror=alert(1)>')
  await expect(detail).toContainText('校验说明（不执行）：^深层.*$')
  expect(await page.evaluate(() => 'KAYIXIN_EXPAND_XSS' in window)).toBe(false)
  await expect(detail.locator('script,img,svg')).toHaveCount(0)
})
test('R1 adopts a confirmed save before failed refresh and ignores an in-flight v1 observation', async ({ page }) => {
  const { a } = await prepare(page)
  await page.getByRole('button', { name: '测试只读连接' }).click()
  await expect(status(page)).toContainText('通过')
  await page.getByRole('button', { name: '读取账户余额' }).click()
  await expect(page.getByText('账户余额：1234.123456789012345678')).toBeVisible()
  await page.getByRole('button', { name: '读取商品列表' }).click()
  await page.getByRole('button', { name: '夹具会员 中文 & 特殊字符', exact: true }).click()
  await expect(page.getByRole('article', { name: '上游商品详情' })).toBeVisible()
  const arrived = deferred(), release = deferred(), done = deferred()
  await page.route(`**/api/v1/admin/supplier-connections/${a.id}/catalog/account`, async route => {
    const response = await route.fetch(); arrived.resolve(); await release.promise
    await route.fulfill({ response }); done.resolve()
  })
  await page.getByRole('button', { name: '读取账户余额' }).click(); await arrived.promise
  let block = true
  await page.route('**/api/v1/admin/supplier-connections', async route => {
    if (block && route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: { code: 'R1_LIST_DOWN', message: 'R1列表刷新暂不可用' } } })
    else await route.continue()
  })
  await page.getByLabel('AppID', { exact: true }).fill('602413')
  await page.getByLabel('AppSecret', { exact: true }).fill('R1-fixture-"quotes\\and\\slashes"-secret!')
  await page.getByRole('button', { name: '保存新版本' }).click()
  await expect(page.getByText(`${a.name} · v2`, { exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('凭据已加密保存')
  await expect(page.getByRole('alert')).toContainText('配置已保存，但刷新失败')
  await expect(page.getByRole('list', { name: '上游商品列表' })).toHaveCount(0)
  await expect(page.getByRole('article', { name: '上游商品详情' })).toHaveCount(0)
  await expect(status(page)).toHaveCount(0)
  release.resolve(); await done.promise
  await expect(page.getByText('账户余额：1234.123456789012345678')).toHaveCount(0)
  block = false
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.unroute(`**/api/v1/admin/supplier-connections/${a.id}/catalog/account`)
  await page.getByRole('button', { name: '读取账户余额' }).click()
  await expect(page.getByText('账户余额：1234.123456789012345678')).toBeVisible()
  await expect(page.getByText(/最近读取：.*配置 v2/u)).toBeVisible()
})
test('R1 does not apply A save messages or editor state to B', async ({ page }) => {
  const { a, b } = await prepare(page)
  const arrived = deferred(), release = deferred(), done = deferred()
  await page.route(`**/api/v1/admin/supplier-connections/${a.id}`, async route => {
    const response = await route.fetch(); arrived.resolve(); await release.promise
    await route.fulfill({ response }); done.resolve()
  })
  await page.getByLabel('供应商名称').fill(`${a.name}-saved`)
  await page.getByRole('button', { name: '保存新版本' }).click(); await arrived.promise
  await choose(page, b)
  release.resolve(); await done.promise
  await expect(page.getByRole('button', { name: '保存新版本' })).toBeEnabled()
  await expect(page.getByLabel('供应商名称')).toHaveValue(b.name)
  await expect(page.getByRole('status')).toHaveCount(0)
})
