import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { captureBrowserDiagnostics, expectClientMounted } from './browser-diagnostics'

const adminEmail = 'browser-test@example.com'
const adminPassword = 'Only-For-E2E-Tests-2026!!'
const customerPassword = 'Browser-Customer-Password-2026!'
const temporaryPassword = 'Admin-Temporary-Password-2026!'
const browserOrigin = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100'

async function assertNoHorizontalOverflow(page: import('@playwright/test').Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: width, scrollWidth: width })
}

async function adminSignIn(page: import('@playwright/test').Page) {
  await page.goto('/admin/login')
  await expectClientMounted(page, '[data-admin-login-ready="true"]')
  await page.getByLabel('管理员邮箱').fill(adminEmail)
  await page.getByLabel('密码').fill(adminPassword)
  await page.getByRole('button', { name: '安全登录' }).click()
  await expect(page).toHaveURL(/\/admin$/)
}

test('administrator searches, edits, disables, restores, resets and anonymizes a real customer', async ({ page }) => {
  test.setTimeout(90_000)
  captureBrowserDiagnostics(page)
  const username = `manage-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const updatedUsername = `${username}-renamed`
  const initialEmail = `${username}@example.test`
  const updatedEmail = `updated-${username}@example.test`
  const initialPhone = '+8613800000123'
  const updatedPhone = '+86 139 0000 0456'

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/register')
  await expectClientMounted(page, '[data-customer-register-ready="true"]')
  await expect(page.getByLabel('用户名')).toBeEnabled()
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(customerPassword)
  await page.getByLabel('确认密码').fill(customerPassword)
  await page.getByLabel('邮箱').fill(initialEmail)
  await page.getByLabel('手机号').fill(initialPhone)
  await page.getByRole('button', { name: '创建账户' }).click()
  await expect(page).toHaveURL(/\/account$/)
  const customerSession = await page.request.get('/api/v1/customer/session')
  expect(customerSession.status()).toBe(200)
  const customerId = (await customerSession.json()).data.customer.id as string
  expect(customerId).toMatch(/^[0-9a-f-]{36}$/)

  await adminSignIn(page)
  await page.goto('/admin/customers')
  await expect(page.locator('#admin-main-content').getByRole('heading', { name: '顾客管理' })).toBeVisible()
  await assertNoHorizontalOverflow(page, 320)
  await page.getByLabel('搜索用户名、邮箱或手机号').fill(initialEmail)
  const mobileRows = page.getByRole('list', { name: '顾客列表' })
  await expect(mobileRows.getByText(username, { exact: true })).toBeVisible()
  await expect(mobileRows.getByText(initialPhone, { exact: true })).toBeVisible()
  await page.getByLabel('按账户状态筛选').click()
  await page.getByRole('option', { name: '正常', exact: true }).click()
  await expect(mobileRows.getByText(username, { exact: true })).toBeVisible()
  await page.getByLabel('注册时间排序').click()
  await page.getByRole('option', { name: '最早注册', exact: true }).click()
  await page.getByLabel('每页显示数量').click()
  await page.getByRole('option', { name: '50 条 / 页', exact: true }).click()
  await mobileRows.getByRole('link', { name: '查看详情' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/customers/${customerId}$`))
  await expect(page.getByRole('heading', { name: username, level: 1 })).toBeVisible()
  await expect(page.getByText('验证状态：未验证', { exact: true })).toHaveCount(2)

  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false)
  await page.screenshot({ path: '/tmp/aikayun-admin-customers-detail.png', fullPage: true })
  await assertNoHorizontalOverflow(page, 390)
  await assertNoHorizontalOverflow(page, 768)
  await assertNoHorizontalOverflow(page, 1440)

  await page.getByLabel('用户名', { exact: true }).fill(updatedUsername)
  await page.getByLabel('邮箱', { exact: true }).fill(updatedEmail)
  await page.getByLabel('手机号', { exact: true }).fill(updatedPhone)
  await page.getByRole('button', { name: '保存资料' }).click()
  await expect(page.getByRole('status')).toContainText('联系方式保持未验证状态')
  await expect(page.getByRole('heading', { name: updatedUsername, level: 1 })).toBeVisible()
  const savedProfile = await page.request.get(`/api/v1/admin/customers/${customerId}`)
  expect((await savedProfile.json()).data.customer).toMatchObject({ username: updatedUsername, email: updatedEmail, phone: '+8613900000456' })
  expect((await savedProfile.json()).data.customer).not.toHaveProperty('password_hash')

  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '深色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
  await assertNoHorizontalOverflow(page, 320)
  await assertNoHorizontalOverflow(page, 1440)

  await page.getByRole('button', { name: '禁用账户' }).click()
  const disableDialog = page.getByRole('dialog', { name: '确认禁用顾客账户' })
  await expect(disableDialog).toContainText('不会退款、关闭订单、清空余额或删除已购权益')
  await disableDialog.getByRole('button', { name: '确认禁用' }).click()
  await expect(page.getByRole('status')).toContainText('所有旧会话已撤销')
  expect((await page.request.get('/api/v1/customer/profile')).status()).toBe(401)

  await page.getByRole('button', { name: '恢复账户' }).click()
  const restoreDialog = page.getByRole('dialog', { name: '确认恢复顾客账户' })
  await expect(restoreDialog).toContainText('旧会话不会恢复')
  await restoreDialog.getByRole('button', { name: '确认恢复' }).click()
  await expect(page.getByRole('status')).toContainText('此前撤销的会话不会恢复')
  expect((await page.request.get('/api/v1/customer/profile')).status()).toBe(401)

  await page.getByRole('button', { name: '重置密码' }).click()
  const passwordDialog = page.getByRole('dialog', { name: '重置顾客密码' })
  await passwordDialog.getByLabel('新临时密码').fill(temporaryPassword)
  await passwordDialog.getByRole('button', { name: '确认重置并撤销会话' }).click()
  await expect(page.getByRole('status')).toContainText('临时密码已设置')
  await expect(page.locator('body')).not.toContainText(temporaryPassword)
  expect((await page.request.get('/api/v1/customer/profile')).status()).toBe(401)

  const csrfResponse = await page.request.get('/api/v1/customer/auth/csrf')
  expect(csrfResponse.status()).toBe(200)
  const csrfToken = (await csrfResponse.json()).data.csrfToken as string
  const oldPasswordLogin = await page.request.post('/api/v1/customer/auth/login', {
    headers: { origin: browserOrigin, 'x-csrf-token': csrfToken },
    data: { username: updatedUsername, password: customerPassword },
  })
  expect(oldPasswordLogin.status()).toBe(401)
  const newPasswordLogin = await page.request.post('/api/v1/customer/auth/login', {
    headers: { origin: browserOrigin, 'x-csrf-token': csrfToken },
    data: { username: updatedUsername, password: temporaryPassword },
  })
  expect(newPasswordLogin.status()).toBe(200)
  expect(newPasswordLogin.headers()['set-cookie']).not.toContain(temporaryPassword)

  await page.getByRole('button', { name: '删除顾客' }).click()
  const deleteDialog = page.getByRole('dialog', { name: '删除并匿名化顾客账户' })
  await expect(deleteDialog).toContainText('身份不能恢复')
  await expect(deleteDialog.getByRole('button', { name: '确认删除账户' })).toBeDisabled()
  await deleteDialog.getByRole('checkbox', { name: '我已理解删除影响，并确认需要删除此账户。' }).check()
  await deleteDialog.getByLabel('输入当前用户名以继续').fill(updatedUsername)
  await expect(deleteDialog.getByRole('button', { name: '确认删除账户' })).toBeEnabled()
  await deleteDialog.getByRole('button', { name: '确认删除账户' }).click()
  await expect(page).toHaveURL(/\/admin\/customers\?notice=deleted$/)
  await expect(page.getByRole('status')).toContainText('顾客已删除')
  await page.getByLabel('按账户状态筛选').click()
  await page.getByRole('option', { name: '已删除', exact: true }).click()
  await expect(page.locator('tbody').getByText('已删除顾客', { exact: true })).toBeVisible()
  await page.locator('tbody').getByRole('link', { name: '查看详情' }).click()
  await expect(page.getByRole('heading', { name: '已删除顾客', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: '恢复账户' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重置密码' })).toHaveCount(0)
  await expect(page.getByText('暂无历史订单')).toBeVisible()
  await expect(page.getByText('删除并匿名化账户')).toBeVisible()

  const deletedProfile = await page.request.get(`/api/v1/admin/customers/${customerId}`)
  expect((await deletedProfile.json()).data.customer).toMatchObject({ username: null, email: null, phone: null, status: 'deleted' })
  const audit = await page.request.get(`/api/v1/admin/customers/${customerId}/audit`)
  expect((await audit.json()).data.items.map((event: { action: string }) => event.action))
    .toEqual(expect.arrayContaining(['username_updated', 'contact_updated', 'disabled', 'restored', 'password_reset', 'deleted']))
  expect(await audit.text()).not.toContain(temporaryPassword)
})
