import { expect, test } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

test('operations uses protected, read-only summaries with responsive and bounded export', async ({ page }) => {
  const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100'
  for (const path of ['risk', 'workers', 'files', 'diagnostics']) {
    const response = await page.request.get(`/api/v1/admin/operations/${path}`)
    expect(response.status()).toBe(401)
  }
  await page.context().addCookies([{ name: 'aikayun_admin_session', value: createBrowserAdminSession(), url: base, httpOnly: true, sameSite: 'Lax' }])
  const response = await page.request.get('/admin/operations')
  expect(response.status()).toBe(200)
  const ssr = await response.text()
  expect(ssr).toContain('运维中心')
  expect(ssr).toContain('后台任务')
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto('/admin/operations')
  await expect(page.locator('[data-operations-mounted=true]')).toBeAttached()
  await expect(page.locator('#admin-main').getByRole('heading', { name: '运维中心', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '文件一致性', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出脱敏诊断' }).click()])
  const stream = await download.createReadStream()
  const parts: Buffer[] = []
  for await (const chunk of stream) parts.push(Buffer.from(chunk))
  const text = Buffer.concat(parts).toString('utf8')
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024)
  expect(JSON.parse(text)).toHaveProperty('workers')
  expect(text).not.toMatch(/cookie|authorization|password|ciphertext|recipient_snapshot/iu)
  await page.route('**/api/v1/admin/operations/risk', route => route.fulfill({ status: 503, body: '{}' }))
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByText('风险数据未知')).toBeVisible()
})
