import { expect, test } from '@playwright/test'

test('renders the server-side storefront and its foundation capabilities', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: /让数字商品/ })).toBeVisible()
  await expect(page.getByText('PostgreSQL 数据持久化')).toBeVisible()
  await expect(page.getByRole('link', { name: '进入管理后台' })).toBeVisible()
})

test('blocks the admin page until login, then creates and ends a session', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/login/)
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible()

  await expect(page.getByRole('button', { name: '安全登录' })).toBeEnabled()
  await page.getByLabel('管理员邮箱').fill('browser-test@example.com')
  await page.getByLabel('密码').fill('Only-For-E2E-Tests-2026!!')
  await page.getByRole('button', { name: '安全登录' }).click()

  await expect(page).toHaveURL(/\/admin$/)
  expect(page.url()).not.toContain('Only-For-E2E-Tests-2026!!')
  await expect(page.getByRole('heading', { name: '管理概览' })).toBeVisible()
  await expect(page.getByText('browser-test@example.com')).toBeVisible()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/admin\/login/)
  const protectedResponse = await page.request.get('/api/v1/admin/overview')
  expect(protectedResponse.status()).toBe(401)
  expect((await protectedResponse.json()).error.code).toBe('UNAUTHORIZED')
})
