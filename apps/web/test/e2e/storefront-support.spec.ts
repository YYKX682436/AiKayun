import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'
import { expectClientMounted } from './browser-diagnostics'

const publicEndpoint = '/api/v1/public/storefront/support'
const account = `<img data-support-probe>${'x'.repeat(130)}`
const contactUrl = 'https://support.example.test/help'

async function expectNoOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true)
}

test('store owner publishes and removes ordered contacts, and shoppers can use them without signing in', async ({ page, browser, baseURL }) => {
  const shopper = await browser.newContext({ baseURL, viewport: { width: 320, height: 780 }, colorScheme: 'dark' })
  const guest = await shopper.newPage()
  const initial = await guest.goto('/support')
  expect(initial?.status()).toBe(200)
  expect(await initial?.text()).toContain('店主暂未设置客服联系方式')
  await expect(guest.getByRole('heading', { name: '联系客服' })).toBeVisible()
  await expect(guest.locator('footer').getByRole('link', { name: '联系客服' })).toHaveCount(0)

  await page.context().addCookies([{
    name: 'aikayun_admin_session', value: createBrowserAdminSession(), url: baseURL, httpOnly: true, sameSite: 'Lax',
  }])
  try {
    await page.setViewportSize({ width: 320, height: 844 })
    await page.goto('/admin/storefront/support')
    await expect(page.locator('#admin-main').getByRole('heading', { name: '客服设置' })).toBeVisible()
    await expect(page.getByRole('button', { name: '显示模式' })).toBeEnabled()
    await page.getByRole('button', { name: '打开侧边栏' }).click()
    await expect(page.getByRole('link', { name: '客服设置' })).toHaveAttribute('href', '/admin/storefront/support')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('link', { name: '客服设置' })).toBeHidden()

    const add = page.getByRole('button', { name: '添加渠道' })
    await add.click()
    const first = page.getByRole('group', { name: '渠道 1' })
    await first.getByLabel('渠道名称').fill('售后账号')
    await first.getByLabel('客服账号').fill(account)
    await add.click()
    const second = page.getByRole('group', { name: '渠道 2' })
    await second.getByLabel('渠道名称').fill('商家帮助中心')
    await second.getByRole('combobox').click()
    await page.getByRole('option', { name: 'HTTPS 联系链接' }).click()
    await second.getByLabel('HTTPS 地址').fill(contactUrl)
    await add.click()
    await expect(add).toBeDisabled()
    await page.getByRole('button', { name: '移除渠道 3' }).click()
    await page.getByRole('button', { name: '下移渠道 1' }).click()
    await expect(first.getByLabel('渠道名称')).toHaveValue('商家帮助中心')
    await page.getByRole('button', { name: '上移渠道 2' }).click()
    await expect(first.getByLabel('渠道名称')).toHaveValue('售后账号')
    await page.getByRole('button', { name: '上移渠道 2' }).click()
    await expectNoOverflow(page)

    const mode = page.getByRole('button', { name: '显示模式' })
    await mode.click()
    await page.getByRole('option', { name: '深色' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expectNoOverflow(page)

    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('status').filter({ hasText: '客服设置已保存' })).toBeVisible()
    await page.reload()
    await expect(first.getByLabel('渠道名称')).toHaveValue('商家帮助中心')

    const publicSettings = await guest.request.get(publicEndpoint)
    expect(publicSettings.headers()['cache-control']).toBe('no-store')
    expect((await publicSettings.json()).data.channels).toEqual([
      { name: '商家帮助中心', type: 'https', content: contactUrl },
      { name: '售后账号', type: 'account', content: account },
    ])

    const response = await guest.reload()
    expect(response?.headers()['cache-control']).toBe('no-store')
    expect(await response?.text()).toContain(`href="${contactUrl}"`)
    expect(await response?.text()).toContain('&lt;img data-support-probe&gt;')
    await expect(guest.locator('main header').getByText('AiKayun 数字商城')).toBeVisible()
    await expect(guest.getByRole('heading', { level: 2 })).toHaveText(['商家帮助中心', '售后账号'])
    await expect(guest.locator('[data-support-probe]')).toHaveCount(0)
    await expect(guest.locator('footer').getByRole('link', { name: '联系客服' })).toHaveAttribute('href', '/support')
    await expect(guest.locator('html')).toHaveClass(/dark/)
    await expectNoOverflow(guest)
    const external = guest.getByRole('link', { name: '打开商家帮助中心（新窗口）' })
    await expect(external).toHaveAttribute('href', contactUrl)
    await expect(external).toHaveAttribute('target', '_blank')
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer')
    await shopper.route(contactUrl, route => route.fulfill({ body: 'contact test fixture' }))
    const popupPromise = guest.waitForEvent('popup')
    await external.click()
    const popup = await popupPromise
    await expect(popup).toHaveURL(contactUrl)
    expect(await popup.evaluate(() => window.opener)).toBeNull()
    await popup.close()

    await shopper.grantPermissions(['clipboard-read', 'clipboard-write'])
    await expectClientMounted(guest, '[data-storefront-ready="true"]')
    await guest.getByRole('button', { name: '复制账号：售后账号' }).click()
    await expect(guest.getByRole('status').filter({ hasText: '已复制' })).toBeVisible()
    expect(await guest.evaluate(() => navigator.clipboard.readText())).toBe(account)

    await page.setViewportSize({ width: 1440, height: 900 })
    await expectNoOverflow(page)
    await guest.setViewportSize({ width: 1440, height: 900 })
    await guest.emulateMedia({ colorScheme: 'light' })
    await expect(guest.locator('html')).toHaveClass(/light/)
    await expectNoOverflow(guest)

    await page.getByRole('button', { name: '移除渠道 2' }).click()
    await page.getByRole('button', { name: '移除渠道 1' }).click()
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('status').filter({ hasText: '客服设置已保存' })).toBeVisible()
    await guest.reload()
    await expect(guest.getByText('店主暂未设置客服联系方式')).toBeVisible()
    await expect(guest.locator('footer').getByRole('link', { name: '联系客服' })).toHaveCount(0)
  } finally {
    await shopper.close()
    const csrfResponse = await page.request.get('/api/v1/admin/auth/csrf')
    const csrfToken = (await csrfResponse.json()).data.csrfToken as string
    const cleared = await page.request.put('/api/v1/admin/storefront/support', {
      headers: { origin: new URL(baseURL!).origin, 'x-csrf-token': csrfToken },
      data: { channels: [] },
    })
    expect(cleared.status(), await cleared.text()).toBe(200)
  }
})
