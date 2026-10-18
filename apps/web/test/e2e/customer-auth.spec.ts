import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

const initialPassword = 'Browser-Customer-Password-2026!'
const changedPassword = 'Browser-Customer-Password-Updated-2026!'
const customerPolicyPath = '/api/v1/public/storefront/customer-policy'

async function assertNoHorizontalOverflow(page: import('@playwright/test').Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  const measurements = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.clientWidth)
}

test('customer can register, edit their account, change password, refresh, log in and log out', async ({ page }) => {
  const runtimeErrors: string[] = []
  page.on('pageerror', error => runtimeErrors.push(error.message))
  const username = `browser-${randomUUID().replaceAll('-', '').slice(0, 20)}`

  await page.setViewportSize({ width: 390, height: 844 })
  const registrationResponse = await page.goto('/register')
  expect(registrationResponse?.status()).toBe(200)
  const registrationHtml = await registrationResponse?.text()
  expect(registrationHtml).toContain('创建顾客账户')
  expect(registrationHtml).toContain('注册信息')
  await expect(page.getByRole('heading', { name: '创建顾客账户' })).toBeVisible()
  await expect(page.locator('[data-customer-register-ready="true"]')).toBeAttached()
  await expect(page.getByLabel('用户名')).toBeVisible()
  await expect(page.getByLabel('邮箱')).toBeVisible()
  await expect(page.getByLabel('手机号')).toBeVisible()

  for (const width of [320, 390, 768, 1440]) {
    await assertNoHorizontalOverflow(page, width)
  }

  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(initialPassword)
  const showRegistrationPassword = page.getByRole('button', { name: '显示密码' })
  await expect(showRegistrationPassword).toBeEnabled()
  await showRegistrationPassword.click()
  await expect(page.getByRole('button', { name: '隐藏密码' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'text')
  await page.getByLabel('确认密码').fill('different-confirmation')
  await page.getByRole('button', { name: '创建账户' }).click()
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致')
  await page.getByLabel('确认密码').fill(initialPassword)
  await page.getByLabel('邮箱').fill(`${username}@example.test`)
  await page.getByLabel('手机号').fill('+86 138 0000 0123')
  await page.getByRole('button', { name: '创建账户' }).click()

  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole('heading', { name: '个人账户' })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(username) })).toHaveAttribute('href', '/account')
  const sessionCookie = (await page.context().cookies()).find(cookie => cookie.name === 'aikayun_customer_session')
  const csrfCookie = (await page.context().cookies()).find(cookie => cookie.name === 'aikayun_customer_csrf')
  expect(sessionCookie?.httpOnly).toBe(true)
  expect(sessionCookie?.sameSite).toBe('Lax')
  expect(csrfCookie?.httpOnly).toBe(false)
  expect(csrfCookie?.sameSite).toBe('Strict')

  const currentSession = await page.request.get('/api/v1/customer/session')
  expect(currentSession.status()).toBe(200)
  expect((await currentSession.json()).data.customer.username).toBe(username)

  await page.getByLabel('邮箱').fill(`updated-${username}@example.test`)
  await page.getByLabel('手机号').fill('+86 139 0000 0124')
  await page.getByRole('button', { name: '保存联系方式' }).click()
  await expect(page.getByRole('status')).toContainText('账户资料已保存')
  await expect(page.getByText('未验证', { exact: true })).toHaveCount(2)

  await page.locator('input[autocomplete="current-password"]').fill(initialPassword)
  await page.locator('input[autocomplete="new-password"]').nth(0).fill(changedPassword)
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(changedPassword)
  await page.getByRole('button', { name: '更新密码' }).click()
  await expect(page.getByRole('region', { name: '修改密码' }).getByRole('status')).toContainText('密码已更新')
  await expect(page.locator('input[autocomplete="current-password"]')).toHaveValue('')

  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '深色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
  await assertNoHorizontalOverflow(page, 390)
  await assertNoHorizontalOverflow(page, 1440)

  const refreshed = await page.reload()
  expect(refreshed?.status()).toBe(200)
  const accountHtml = await refreshed?.text()
  expect(accountHtml).toContain(username)
  expect(accountHtml).toContain(`updated-${username}@example.test`)
  await expect(page.getByRole('heading', { name: '个人账户' })).toBeVisible()
  await expect(page.getByLabel('邮箱')).toHaveValue(`updated-${username}@example.test`)
  await expect(page.getByRole('link', { name: new RegExp(username) })).toHaveAttribute('href', '/account')
  expect(runtimeErrors).toEqual([])

  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('banner').getByRole('link', { name: '顾客登录' })).toHaveAttribute('href', '/login')
  expect((await page.request.get('/api/v1/customer/session')).status()).toBe(401)

  await page.goto('/login')
  await expect(page.locator('[data-customer-login-ready="true"]')).toBeAttached()
  await page.getByLabel('用户名').fill(username)
  await page.locator('input[autocomplete="current-password"]').fill(changedPassword)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole('heading', { name: '个人账户' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('link', { name: new RegExp(username) })).toHaveAttribute('href', '/account')
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL('/')
  expect((await page.request.get('/api/v1/customer/session')).status()).toBe(401)

  await page.goto('/register')
  const secondUsername = `browser-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  await page.getByLabel('用户名').fill(secondUsername)
  await page.getByLabel('密码', { exact: true }).fill(initialPassword)
  await page.getByLabel('确认密码').fill(initialPassword)
  await page.getByRole('button', { name: '创建账户' }).click()
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole('link', { name: new RegExp(secondUsername) })).toHaveAttribute('href', '/account')
  await expect(page.getByLabel('邮箱')).toHaveValue('')
  await expect(page.getByLabel('手机号')).toHaveValue('')
  expect(runtimeErrors).toEqual([])
})

test('administrator updates real customer and guest policy without opening purchase routes', async ({ page }) => {
  const response = await page.goto('/admin/login')
  expect(response?.status()).toBe(200)
  await page.getByLabel('管理员邮箱').fill('browser-test@example.com')
  await page.getByLabel('密码').fill('Only-For-E2E-Tests-2026!!')
  await page.getByRole('button', { name: '安全登录' }).click()
  await expect(page).toHaveURL(/\/admin$/)

  await page.goto('/admin/storefront/customer-policy')
  await expect(page.getByRole('heading', { name: '顾客与游客设置' })).toBeVisible()
  const labels = [
    '注册时要求邮箱',
    '注册时要求手机号',
    '允许游客下单',
    '允许游客领取免费商品',
  ]
  const switches = labels.map(label => page.getByRole('switch', { name: label }))
  for (const toggle of switches) await expect(toggle).toBeVisible()

  try {
    for (const toggle of switches) {
      if (await toggle.getAttribute('aria-checked') === 'true') await toggle.click()
    }
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('status')).toContainText('已保存')

    for (const toggle of switches) await toggle.click()
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('status')).toContainText('已保存')

    const publicPolicy = await page.request.get(customerPolicyPath)
    expect(publicPolicy.status()).toBe(200)
    expect((await publicPolicy.json()).data).toMatchObject({
      requireEmail: true,
      requirePhone: true,
      guestCheckoutEnabled: true,
      guestFreeClaimEnabled: true,
    })

    await page.goto('/register')
    await expect(page.getByLabel('邮箱')).toHaveAttribute('required', '')
    await expect(page.getByLabel('手机号')).toHaveAttribute('required', '')
    const orderRoute = await page.request.post('/api/v1/orders', { data: {} })
    expect(orderRoute.status()).toBe(404)
    expect((await page.request.get('/api/v1/customer/session')).status()).toBe(401)

    for (const width of [390, 768, 1440]) await assertNoHorizontalOverflow(page, width)
  } finally {
    await page.goto('/admin/storefront/customer-policy')
    const resetSwitches = labels.map(label => page.getByRole('switch', { name: label }))
    for (const toggle of resetSwitches) {
      if (await toggle.getAttribute('aria-checked') === 'true') await toggle.click()
    }
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('status')).toContainText('已保存')
  }
})
