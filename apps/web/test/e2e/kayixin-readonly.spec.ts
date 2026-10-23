import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

const secret = 'fixture-V3-secret-only-never-real-2026!'
test('uses the real V3 fixture through the admin UI, rotates credentials, reads goods and remains read-only', async ({ page }, testInfo) => {
  test.skip(process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true', 'The external Compose server does not include the isolated V3 fixture.')
  test.setTimeout(120000)
  const token = await createBrowserAdminSession()
  await page.context().addCookies([{ name: 'aikayun_admin_session', value: token,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin, httpOnly: true, sameSite: 'Lax' }])
  const name = `卡易信只读 ${randomUUID().slice(0, 8)}`
  await page.goto('/admin/supplier-connections')
  await expect(page.getByRole('heading', { name: '外部供应商 API' })).toBeVisible()
  await page.getByRole('button', { name: '新增连接', exact: true }).click()
  await page.getByRole('combobox', { name: '连接协议' }).click()
  await page.getByRole('option', { name: '卡易信客户 V3 · 只读' }).click()
  await page.getByLabel('供应商名称').fill(name)
  await page.getByLabel('接口基础地址').fill('http://127.0.0.1:3102')
  await page.getByLabel('AppID', { exact: true }).fill('602401')
  await page.getByLabel('AppSecret', { exact: true }).fill('incorrect-fixture-secret')
  await page.getByRole('button', { name: '加密保存连接' }).click()
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
  await expect(page.getByLabel('AppSecret', { exact: true })).toHaveValue('')
  await expect(page.getByRole('combobox', { name: '连接协议' })).toBeDisabled()
  await page.getByRole('button', { name: '测试只读连接' }).click()
  await expect(page.getByRole('alert')).toContainText('认证失败')
  await expect(page.getByRole('button', { name: '明确启用连接' })).toHaveCount(0)

  await page.getByLabel('AppID', { exact: true }).fill('602401')
  await page.getByLabel('AppSecret', { exact: true }).fill(secret)
  await page.getByRole('button', { name: '保存新版本' }).click()
  await expect(page.getByRole('status')).toContainText('凭据已加密保存')
  await expect(page.getByLabel('AppSecret', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('AppID', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '测试只读连接' }).click()
  await expect(page.getByRole('status')).toContainText('只读连接正常')
  await expect(page.getByRole('status')).toContainText('自动采购尚未开放')
  await page.getByRole('button', { name: '读取账户余额' }).click()
  await expect(page.getByText('账户余额：1234.123456789012345678')).toBeVisible()
  await page.getByRole('button', { name: '读取商品列表' }).click()
  await expect(page.getByRole('list', { name: '上游商品列表' })).toContainText('夹具会员 中文 & 特殊字符')
  await page.getByRole('button', { name: '夹具会员 中文 & 特殊字符', exact: true }).click()
  const detail = page.getByRole('article', { name: '上游商品详情' })
  await expect(detail.getByRole('heading', { name: '购买填写要求' })).toBeVisible()
  await expect(detail).toContainText('12.345678901234567890')
  await expect(detail).toContainText('cn-member')
  await expect(detail).toContainText('multiple 3')
  await expect(detail).toContainText('地区与验证 · 级联选择 · 必填')
  await expect(detail).toContainText('南宁市')
  await expect(detail).toContainText('身份证后六位')
  await expect(detail).toContainText('<script>window.KAYIXIN_XSS = true</script>')
  expect(await page.evaluate(() => 'KAYIXIN_XSS' in window)).toBe(false)
  await expect(page.locator('body')).not.toContainText(secret)
  const html = await page.request.get('/admin/supplier-connections')
  expect(await html.text()).not.toContain(secret)

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('kayixin-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByRole('button', { name: '夹具多单规格', exact: true }).click()
  await expect(detail).toContainText('monthly')
  await expect(detail).toContainText('套餐：月卡')
  await page.screenshot({ path: testInfo.outputPath('kayixin-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: '轮换加密密钥' }).click()
  await expect(page.getByRole('status')).toContainText('历史凭据版本')
  await expect(page.locator('body')).not.toContainText(secret)
  const stats = await (await page.request.get('http://127.0.0.1:3102/__fixture/stats')).json()
  expect(stats.paths.length).toBeGreaterThan(5)
  expect(stats.paths.every((path: string) => ['/api/v3/user/getAccount', '/api/v3/goods/getList', '/api/v3/goods/getDetail'].includes(path))).toBe(true)

  // Check the existing SKU entry point after a successful read-only test.
  const csrf = (await (await page.request.get('/api/v1/admin/auth/csrf')).json()).data.csrfToken
  const created = await page.request.post('/api/v1/admin/products', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf },
    data: { name: `只读资格隔离 ${name}`, productType: 'digital', defaultSku: { salePrice: '1.00' } },
  })
  expect(created.status()).toBe(201)
  const productId = (await created.json()).data.id
  const supplierRead = page.waitForResponse(response => response.url().endsWith('/api/v1/admin/supplier-connections') && response.request().method() === 'GET')
  await page.goto(`/admin/products/${productId}`)
  await supplierRead
  const panel = page.getByRole('region', { name: '外部 API 自动发货' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: '明确启用自动销售' })).toBeDisabled()
  const selector = panel.getByRole('combobox', { name: '供应商连接版本' })
  if (await selector.isEnabled()) {
    await selector.click()
    await expect(page.getByRole('option', { name: new RegExp(name) })).toHaveCount(0)
  } else await expect(selector).toBeDisabled()
})
