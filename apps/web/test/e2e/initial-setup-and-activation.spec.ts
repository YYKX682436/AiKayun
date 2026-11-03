import { expect, test } from '@playwright/test'

const meta = { requestId: 'browser-test' }

test('first-run setup verifies the terminal token, creates one administrator, and closes', async ({ page }) => {
  const token = 'T'.repeat(43)
  let created: Record<string, unknown> | undefined

  await page.route('**/api/v1/setup/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { status: 'required' }, meta }),
  }))
  await page.route('**/api/v1/setup/csrf', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'set-cookie': 'aikayun_setup_csrf=browser-csrf; Path=/; SameSite=Strict' },
    body: JSON.stringify({ data: { csrfToken: 'browser-csrf' }, meta }),
  }))
  await page.route('**/api/v1/setup/verify', async route => {
    expect(route.request().postDataJSON()).toEqual({ token })
    expect(route.request().url()).not.toContain(token)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'set-cookie': 'aikayun_setup_session=short-lived; Path=/; HttpOnly; SameSite=Strict' },
      body: JSON.stringify({ data: { authenticated: true }, meta }),
    })
  })
  await page.route('**/api/v1/setup/admin', async route => {
    created = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { completed: true }, meta }),
    })
  })

  await page.goto('/setup')
  await page.getByLabel('服务器初始化口令').fill(token)
  await page.getByRole('button', { name: '验证并继续' }).click()
  await expect(page.getByRole('heading', { name: '设置管理员' })).toBeVisible()
  await page.getByLabel('管理员邮箱').fill('owner@example.com')
  await page.getByLabel('管理员密码', { exact: true }).fill('Correct-Horse-Battery-2026! strong')
  await page.getByLabel('再次输入密码').fill('Correct-Horse-Battery-2026! strong')
  await page.getByRole('button', { name: '创建管理员并完成初始化' }).click()

  await expect(page.getByRole('heading', { name: '初始化已完成' })).toBeVisible()
  await expect(page.getByRole('link', { name: '前往管理员登录' })).toHaveAttribute('href', '/admin/login')
  expect(created).toEqual({ email: 'owner@example.com', password: 'Correct-Horse-Battery-2026! strong' })
  expect(page.url()).toContain('/setup')
  expect(page.url()).not.toContain(token)
})

test('admin activation accepts one combined credential and keeps it out of the URL and rendered status', async ({ page }) => {
  const credential = `AK1.123e4567-e89b-42d3-a456-426614174000.${'A'.repeat(43)}`
  let requestCredential = ''
  let activated = false

  const webOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin
  const authOrigin = webOrigin
  const loginCsrf = await page.request.get(`${authOrigin}/api/v1/admin/auth/csrf`)
  const loginCsrfBody = await loginCsrf.json() as { data: { csrfToken: string } }
  const login = await page.request.post(`${authOrigin}/api/v1/admin/auth/login`, {
    headers: { origin: webOrigin, 'x-csrf-token': loginCsrfBody.data.csrfToken },
    data: { email: 'browser-test@example.com', password: 'Only-For-E2E-Tests-2026!!' },
  })
  expect(login.status()).toBe(200)
  await page.route('**/api/v1/admin/license-status', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: {
      status: activated ? 'active' : 'unactivated',
      allowedUntil: activated ? '2030-01-01T00:00:00.000Z' : null,
      retryable: false,
    }, meta }),
  }))
  await page.route('**/api/v1/admin/license-activation/status', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: {
      status: activated ? 'active' : 'unactivated',
      allowedUntil: activated ? '2030-01-01T00:00:00.000Z' : null,
      retryable: false,
      pendingOperation: null,
      trustBundle: 'ready',
    }, meta }),
  }))
  await page.route('**/api/v1/admin/auth/csrf', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'set-cookie': 'aikayun_admin_csrf=browser-csrf; Path=/; SameSite=Strict' },
    body: JSON.stringify({ data: { csrfToken: 'browser-csrf' }, meta }),
  }))
  await page.route('**/api/v1/admin/license-activation', async route => {
    requestCredential = (route.request().postDataJSON() as { credential: string }).credential
    activated = true
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: { status: 'active', allowedUntil: '2030-01-01T00:00:00.000Z', retryable: false }, meta }),
    })
  })

  await page.goto('/admin/license')
  await expect(page.getByRole('region', { name: '当前状态' }).getByText('尚未激活').first()).toBeVisible()
  const credentialInput = page.getByRole('textbox', { name: /组合授权凭证/u })
  await expect(credentialInput).toBeEnabled()
  await credentialInput.fill(credential)
  await expect(credentialInput).toHaveValue(credential)
  const activateButton = page.getByRole('button', { name: '验证并激活' })
  await expect(activateButton).toBeEnabled()
  await activateButton.click()
  await expect(page.getByText('授权已激活。')).toBeVisible()
  await expect(page.getByText('AK1.123e4567-e89b-42d3-a456-426614174000')).toHaveCount(0)
  expect(requestCredential).toBe(credential)
  expect(page.url()).not.toContain(credential)
  await expect(credentialInput).toHaveValue('')
})
