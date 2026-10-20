import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import type { ApiSuccess, WithdrawalSettings } from '@aikayun/contracts'
import { createBrowserAdminSession } from './browser-admin-session'
import { expectClientMounted } from './browser-diagnostics'

const customerPassword = 'Withdrawal-Browser-Password-2026!'
const merchantId = 'playwright-fixture-merchant'
const merchantKey = 'playwright-only-secret-never-returned'

async function csrfToken(page: Page, path = '/api/v1/admin/auth/csrf'): Promise<string> {
  const response = await page.request.get(path)
  expect(response.status()).toBe(200)
  return (await response.json()).data.csrfToken as string
}

async function adminHeaders(page: Page) {
  return { origin: new URL(page.url()).origin, 'x-csrf-token': await csrfToken(page) }
}

async function attachAdmin(page: Page): Promise<void> {
  const token = createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session',
    value: token,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin,
    httpOnly: true,
    sameSite: 'Lax',
  }])
}

async function noHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }))
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport)
}

async function chooseColorMode(page: Page, mode: '浅色' | '深色'): Promise<void> {
  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: mode, exact: true }).click()
  await expect(page.locator('html')).toHaveClass(mode === '浅色' ? /light/u : /dark/u)
}

test('customer applies for withdrawal and admin completes the two-step review workflow', async ({ page }) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(10_000)
  const unique = randomUUID().replaceAll('-', '').slice(0, 12)
  const username = `wd${unique}`
  const channelName = `提现浏览器测试通道-${unique}`
  const adminPage = await page.context().newPage()
  let createdChannelId = ''

  try {
    await attachAdmin(adminPage)
    await adminPage.goto('/admin/withdrawals/settings')
    await expect(adminPage.locator('#admin-main-content').getByRole('heading', { name: '提现设置', exact: true })).toBeVisible()
    await expect(adminPage.getByLabel('允许顾客提现')).toBeVisible()
    await adminPage.getByLabel('允许顾客提现').check()
    await adminPage.getByLabel('单次最低金额').fill('1.00')
    await adminPage.getByLabel('单次最高金额').fill('500.00')
    await adminPage.getByLabel('百分比手续费（%）').fill('1.2500')
    await adminPage.getByLabel('固定手续费（元）').fill('0.75')
    await adminPage.getByRole('button', { name: '保存提现设置' }).click()
    await expect(adminPage.getByRole('status')).toContainText('新设置只应用于之后提交的申请')

    const channel = await adminPage.request.post('/api/v1/admin/payment-channels', {
      headers: await adminHeaders(adminPage),
      data: {
        providerType: 'zpay_epay_v1', name: channelName, enabled: true,
        paymentMethods: ['alipay', 'wechat'], displayOrder: 20, merchantId, merchantKey,
      },
    })
    expect(channel.status()).toBe(201)
    createdChannelId = (await channel.json()).data.channel.id as string
    const channelListText = await (await adminPage.request.get('/api/v1/admin/payment-channels')).text()
    expect(channelListText).not.toContain(merchantKey)

    const policyResponse = await adminPage.request.get('/api/v1/admin/storefront/customer-policy')
    expect(policyResponse.status()).toBe(200)
    const policy = (await policyResponse.json()).data
    const enabledTopUps = await adminPage.request.put('/api/v1/admin/storefront/customer-policy', {
      headers: await adminHeaders(adminPage),
      data: {
        requireEmail: policy.requireEmail,
        requirePhone: policy.requirePhone,
        guestCheckoutEnabled: policy.guestCheckoutEnabled,
        guestFreeClaimEnabled: policy.guestFreeClaimEnabled,
        unpaidOrderTimeoutMinutes: policy.unpaidOrderTimeoutMinutes,
        walletTopUpEnabled: true,
        walletTopUpMinAmount: '1.00',
        walletTopUpMaxAmount: '500.00',
      },
    })
    expect(enabledTopUps.status()).toBe(200)

    await page.goto('/register')
    await expect(page.locator('[data-customer-register-ready="true"]')).toBeAttached()
    await page.getByLabel('用户名').fill(username)
    await page.getByLabel('密码', { exact: true }).fill(customerPassword)
    await page.getByLabel('确认密码').fill(customerPassword)
    await page.getByRole('button', { name: '创建账户' }).click()
    await expect(page).toHaveURL(/\/account$/u)

    await page.goto('/wallet')
    await expect(page.getByRole('heading', { name: '我的钱包', exact: true })).toBeVisible()
    await expectClientMounted(page, '[data-wallet-ready="true"]')
    await page.getByLabel('充值金额').fill('150.00')
    await page.getByRole('button', { name: '创建充值支付' }).click()
    await expect(page.getByRole('heading', { name: '充值处理中' })).toBeVisible()
    const fixturePort = process.env.ZPAY_FIXTURE_PORT ?? '3099'
    const fixtureBaseUrl = `http://127.0.0.1:${fixturePort}`
    const fixtureOrders = await page.request.get(`${fixtureBaseUrl}/__fixture/orders`)
    expect(fixtureOrders.status()).toBe(200)
    const fixtureOrder = (await fixtureOrders.json()).items.at(-1) as { merchantOrderNo: string; amount: string }
    expect(fixtureOrder.amount).toBe('150.00')
    const paid = await page.request.post(`${fixtureBaseUrl}/__fixture/mark-paid`, { data: { merchantOrderNo: fixtureOrder.merchantOrderNo } })
    expect(paid.status()).toBe(200)
    const callback = (await paid.json()).callback as Record<string, string>
    const callbackQuery = new URLSearchParams(callback).toString()
    const apiPort = process.env.AIKAYUN_TEST_API_PORT ?? '3001'
    const callbackResponse = await page.request.get(`http://127.0.0.1:${apiPort}/api/v1/payments/callback/zpay?${callbackQuery}`)
    expect(callbackResponse.status()).toBe(200)
    expect(await callbackResponse.text()).toBe('success')

    await page.goto('/wallet')
    await expect(page.getByText('可用现金', { exact: true })).toBeVisible()
    await expectClientMounted(page, '[data-wallet-ready="true"]')
    const withdrawalAmount = page.getByRole('textbox', { name: '提现金额' })
    await withdrawalAmount.fill('100.00')
    await expect(withdrawalAmount).toHaveValue('100.00')
    const recipientAccount = page.getByLabel('收款账号（可选）')
    await recipientAccount.fill('withdrawal-owner@example.test')
    await expect(withdrawalAmount).toHaveValue('100.00')
    await page.getByLabel('收款人姓名（可选）').fill('浏览器顾客')
    await expect(withdrawalAmount).toHaveValue('100.00')
    await page.getByLabel('上传收款二维码').setInputFiles(fileURLToPath(new URL('../fixtures/d6-upload.png', import.meta.url)))
    await expect(page.getByText('收款二维码已安全保存，仅你和授权管理员可读取。')).toBeVisible()
    await expect(page.getByText('¥2.00', { exact: true })).toBeVisible()
    await expect(page.getByText('¥98.00', { exact: true })).toBeVisible()
    await page.getByLabel(/我确认收款信息正确/u).check()
    await page.getByRole('button', { name: '提交提现申请' }).click()
    await expect(page.getByText('提现申请已提交，完整金额已由服务端冻结。')).toBeVisible()
    await expect(page.getByText('待审核', { exact: true })).toBeVisible()
    await expect(page.getByText('冻结现金金额', { exact: true })).toBeVisible()

    for (const mode of ['浅色', '深色'] as const) {
      await chooseColorMode(page, mode)
      for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
    }
    await page.setViewportSize({ width: 1280, height: 900 })

    await adminPage.goto('/admin/withdrawals')
    await expect(adminPage.locator('#admin-main-content').getByRole('heading', { name: '提现管理', exact: true })).toBeVisible()
    const application = adminPage.locator('article').filter({ hasText: username })
    await expect(application).toBeVisible()
    await application.getByRole('link', { name: '审核与处理' }).click()
    await expect(adminPage.locator('#admin-main-content').getByRole('heading', { name: '申请审核与人工打款' })).toBeVisible()
    await adminPage.getByRole('button', { name: '查看收款信息' }).click()
    await expect(adminPage.getByText('withdrawal-owner@example.test', { exact: true })).toBeVisible()
    const privateQr = adminPage.getByRole('img', { name: '顾客提交的私有收款二维码' })
    await expect(privateQr).toBeVisible()
    await expect.poll(() => privateQr.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await adminPage.getByRole('button', { name: '审核通过' }).click()
    await expect(adminPage.getByRole('status')).toContainText('进入待打款')
    await adminPage.getByRole('button', { name: '记录开始人工打款' }).click()
    await expect(adminPage.getByText('操作 ID：', { exact: false }).last()).toBeVisible()
    await expect(adminPage.getByRole('heading', { name: '第二步：记录打款结果' })).toBeVisible()

    await adminPage.getByLabel('真实转账参考号（成功时必填）').fill(`TEST-FIXTURE-${unique}`)
    await adminPage.getByLabel('转账凭证 SHA-256').fill('1'.repeat(64))
    await adminPage.getByLabel('核对摘要').fill('Playwright 合成数据，未发生真实外部转账。')
    await adminPage.getByRole('button', { name: '确认实际打款成功并扣除冻结金额' }).click()
    await expect(adminPage.getByRole('status')).toContainText('原有账本已扣除全部冻结金额')
    await expect(adminPage.getByText('已完成', { exact: true })).toBeVisible()

    for (const mode of ['浅色', '深色'] as const) {
      await chooseColorMode(adminPage, mode)
      for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(adminPage, width)
    }

    const settingsResponse = await adminPage.request.get('/api/v1/admin/withdrawals/settings')
    expect(settingsResponse.status()).toBe(200)
    const settings = (await settingsResponse.json() as ApiSuccess<WithdrawalSettings>).data
    expect(settings).toMatchObject({ enabled: true, minAmount: '1.00', maxAmount: '500.00', fixedFee: '0.75', percentFee: '1.2500' })
    const customerList = await page.request.get('/api/v1/customer/wallet/withdrawals')
    expect(customerList.status()).toBe(200)
    expect((await customerList.json()).data.items[0]).toMatchObject({ amount: '100.00', feeAmount: '2.00', payoutAmount: '98.00', status: 'completed' })
  } finally {
    if (createdChannelId) {
      await adminPage.request.delete(`/api/v1/admin/payment-channels/${createdChannelId}`, { headers: await adminHeaders(adminPage) }).catch(() => undefined)
    }
    await adminPage.close()
  }
})
