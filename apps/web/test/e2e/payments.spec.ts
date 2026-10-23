import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'
import { expectClientMounted } from './browser-diagnostics'

type Product = { id: string; name: string; revision: number; variants: Array<{ id: string }> }

const customerPassword = 'Payment-Browser-Password-2026!'
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
  await page.goto('/admin/login')
}

async function createProduct(page: Page, name: string): Promise<Product> {
  const created = await page.request.post('/api/v1/admin/products', {
    headers: await adminHeaders(page),
    data: { name, description: '在线支付浏览器验收商品。', productType: 'digital', defaultSku: { salePrice: '5.00' } },
  })
  expect(created.status()).toBe(201)
  let product = (await created.json()).data as Product
  const active = await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
    headers: await adminHeaders(page),
    data: { expectedRevision: product.revision, status: 'active' },
  })
  expect(active.status()).toBe(200)
  product = (await active.json()).data as Product
  const inventoryResponse = await page.request.get(`/api/v1/admin/products/${product.id}/inventory`)
  expect(inventoryResponse.status()).toBe(200)
  const inventory = (await inventoryResponse.json()).data
  const variant = inventory.variants.find((row: { skuId: string }) => row.skuId === product.variants[0]!.id)
  expect(variant).toBeTruthy()
  const mode = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${variant.skuId}/inventory-mode`, {
    headers: await adminHeaders(page),
    data: {
      expectedRevision: inventory.productRevision,
      expectedSkuRevision: variant.skuRevision,
      expectedInventoryRevision: variant.inventoryRevision,
      inventoryMode: 'unlimited',
    },
  })
  expect(mode.status()).toBe(200)
  const fulfillment = await page.request.put(`/api/v1/admin/products/${product.id}/variants/${variant.skuId}/manual-fulfillment`, {
    headers: await adminHeaders(page), data: { enabled: true },
  })
  expect(fulfillment.status()).toBe(200)
  return product
}

async function registerCustomer(page: Page, username: string): Promise<void> {
  await page.goto('/register')
  await expect(page.locator('[data-customer-register-ready="true"]')).toBeAttached()
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(customerPassword)
  await page.getByLabel('确认密码').fill(customerPassword)
  await page.getByRole('button', { name: '创建账户' }).click()
  await expect(page).toHaveURL(/\/account$/u)
}

async function addProductToCart(page: Page, product: Product, quantity = 1): Promise<void> {
  await page.goto(`/products/${product.id}`)
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  await page.getByLabel('购买数量').fill(String(quantity))
  await page.getByRole('button', { name: '加入购物车' }).click()
  await expect(page.getByRole('status')).toContainText('已加入购物车。')
}

async function noHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }))
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport)
}

test('creates a channel in the admin UI and confirms real payment evidence in a customer order', async ({ page }) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(10_000)
  const unique = randomUUID().slice(0, 8)
  const channelName = `浏览器支付通道-${unique}`
  const productName = `浏览器在线支付-${unique}`
  const username = `pay${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const testIp = `198.51.100.${(Number.parseInt(unique.slice(0, 2), 16) % 200) + 20}`
  let createdChannelId = ''
  const consoleMessages: string[] = []
  page.on('console', message => consoleMessages.push(message.text()))
  await page.route('**/api/v1/**', route => route.continue({
    headers: { ...route.request().headers(), 'x-forwarded-for': testIp },
  }))

  try {
    await attachAdmin(page)
    await page.goto('/admin/payment-channels')
    await expect(page.getByRole('heading', { name: '支付通道', exact: true })).toBeVisible()
    await expect(page.locator('[data-payment-channels-ready="true"]')).toBeAttached()
    await page.getByRole('textbox', { name: '通道名称*' }).fill(channelName)
    await page.getByRole('textbox', { name: '商户号*' }).fill(merchantId)
    await page.getByRole('textbox', { name: '商户密钥*' }).fill(merchantKey)
    await page.getByRole('checkbox', { name: '创建后立即启用' }).check()
    await page.getByRole('button', { name: '新增通道' }).click()
    await expect(page.getByRole('status')).toContainText('商户密钥只显示在本次提交表单中。')

    const channelsResponse = await page.request.get('/api/v1/admin/payment-channels')
    expect(channelsResponse.status()).toBe(200)
    const channelListBody = await channelsResponse.text()
    expect(channelListBody).not.toContain(merchantKey)
    expect(channelListBody).not.toContain(merchantId)
    const channel = (await channelsResponse.json()).data.items.find((item: { name: string }) => item.name === channelName)
    expect(channel).toBeTruthy()
    createdChannelId = channel.id as string

    const channelCard = page.getByRole('listitem').filter({ hasText: channelName })
    await channelCard.getByRole('button', { name: '测试配置' }).click()
    await expect(channelCard.getByRole('status')).toContainText('服务商确认配置可用。')

    const product = await createProduct(page, productName)
    await registerCustomer(page, username)
    await addProductToCart(page, product)
    await page.goto('/cart')
    await expectClientMounted(page, '[data-storefront-ready="true"]')
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/iu)
    const orderId = page.url().split('/').at(-1)!
    await expect(page.getByText('外部支付', { exact: true })).toBeVisible()
    await expect(page.getByText('¥5.00', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: /创建外部支付/u }).click()
    await expect(page.getByAltText('本次订单的支付二维码')).toBeVisible()
    for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
    await page.setViewportSize({ width: 1280, height: 900 })

    const fixturePort = process.env.ZPAY_FIXTURE_PORT ?? '3099'
    const fixtureBaseUrl = `http://127.0.0.1:${fixturePort}`
    const fixtureOrdersResponse = await page.request.get(`${fixtureBaseUrl}/__fixture/orders`)
    expect(fixtureOrdersResponse.status()).toBe(200)
    const merchantOrderNo = (await fixtureOrdersResponse.json()).items.at(-1).merchantOrderNo as string
    const paidResponse = await page.request.post(`${fixtureBaseUrl}/__fixture/mark-paid`, {
      data: { merchantOrderNo },
    })
    expect(paidResponse.status()).toBe(200)
    const callback = (await paidResponse.json()).callback as Record<string, string>
    const callbackUrl = new URLSearchParams(callback).toString()
    const apiPort = process.env.AIKAYUN_TEST_API_PORT ?? '3001'
    const callbackResponse = await page.request.get(`http://127.0.0.1:${apiPort}/api/v1/payments/callback/zpay?${callbackUrl}`)
    expect(callbackResponse.status()).toBe(200)
    expect(await callbackResponse.text()).toBe('success')

    await page.getByRole('button', { name: '刷新支付状态' }).click()
    await expect(page.getByText('服务端已确认付款').first()).toBeVisible()
    await expect(page.getByText('等待商家交付').first()).toBeVisible()

    await page.goto(`/admin/orders/${orderId}`)
    await expect(page.getByRole('heading', { name: '在线支付与收款凭证' })).toBeVisible()
    await expect(page.getByText('已验证实收')).toBeVisible()
    const paidFixture = await paidResponse.json() as { callback: Record<string, string> }
    const tradeNo = paidFixture.callback.trade_no
    if (!tradeNo) throw new Error('The paid test fixture did not return a provider transaction ID.')
    await expect(page.getByText(tradeNo, { exact: true })).toBeVisible()
    await expect(page.getByText('无待核对异常')).toBeVisible()
    await expect(page.getByRole('button', { name: /标记.*付款|确认.*付款/u })).toHaveCount(0)

    const policyResponse = await page.request.get('/api/v1/admin/storefront/customer-policy')
    expect(policyResponse.status()).toBe(200)
    const policy = (await policyResponse.json()).data
    const enabledTopUps = await page.request.put('/api/v1/admin/storefront/customer-policy', {
      headers: await adminHeaders(page),
      data: {
        requireEmail: policy.requireEmail,
        requirePhone: policy.requirePhone,
        guestCheckoutEnabled: policy.guestCheckoutEnabled,
        guestFreeClaimEnabled: policy.guestFreeClaimEnabled,
        unpaidOrderTimeoutMinutes: policy.unpaidOrderTimeoutMinutes,
        walletTopUpEnabled: true,
        walletTopUpMinAmount: policy.walletTopUpMinAmount,
        walletTopUpMaxAmount: policy.walletTopUpMaxAmount,
      },
    })
    expect(enabledTopUps.status()).toBe(200)

    await page.goto('/wallet')
    await expect(page.getByRole('heading', { name: '我的钱包', exact: true })).toBeVisible()
    await expect(page.locator('[data-wallet-ready="true"]')).toBeAttached()
    await page.getByLabel('充值金额').fill('2.00')
    await page.getByRole('button', { name: '创建充值支付' }).click()
    await expect(page.getByRole('heading', { name: '充值处理中' })).toBeVisible()
    await expect(page.getByAltText('钱包充值支付二维码')).toBeVisible()

    const walletFixturePort = process.env.ZPAY_FIXTURE_PORT ?? '3099'
    const walletFixtureBaseUrl = `http://127.0.0.1:${walletFixturePort}`
    const topUpOrdersResponse = await page.request.get(`${walletFixtureBaseUrl}/__fixture/orders`)
    expect(topUpOrdersResponse.status()).toBe(200)
    const topUpOrder = (await topUpOrdersResponse.json()).items.at(-1) as { merchantOrderNo: string; amount: string }
    expect(topUpOrder.amount).toBe('2.00')
    const topUpPaid = await page.request.post(`${walletFixtureBaseUrl}/__fixture/mark-paid`, {
      data: { merchantOrderNo: topUpOrder.merchantOrderNo },
    })
    expect(topUpPaid.status()).toBe(200)
    const topUpCallback = (await topUpPaid.json()).callback as Record<string, string>
    const topUpApiPort = process.env.AIKAYUN_TEST_API_PORT ?? '3001'
    const topUpCallbackResponse = await page.request.get(
      `http://127.0.0.1:${topUpApiPort}/api/v1/payments/callback/zpay?${new URLSearchParams(topUpCallback).toString()}`,
    )
    expect(topUpCallbackResponse.status()).toBe(200)
    expect(await topUpCallbackResponse.text()).toBe('success')
    await page.reload()
    await expect(page.getByText('可用现金', { exact: true })).toBeVisible()
    await expect(page.getByText('¥2.00', { exact: true }).first()).toBeVisible()

    await page.goto('/cart')
    await page.getByRole('button', { name: '清空购物车' }).click()
    await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible()
    await addProductToCart(page, product, 2)
    await page.goto('/cart')
    await expectClientMounted(page, '[data-storefront-ready="true"]')
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/iu)
    const comboOrderId = page.url().split('/').at(-1)!
    await page.getByRole('radio', { name: '钱包与外部组合' }).check()
    await expect(page.getByText('钱包 ¥2.00（赠送 ¥0.00，现金 ¥2.00），外部支付 ¥8.00')).toBeVisible()
    await page.getByRole('button', { name: '创建组合支付 · ¥2.00 + ¥8.00' }).click()
    await expect(page.getByAltText('本次订单的支付二维码')).toBeVisible()

    const comboOrdersResponse = await page.request.get(`${walletFixtureBaseUrl}/__fixture/orders`)
    const comboProviderOrder = (await comboOrdersResponse.json()).items.at(-1) as { merchantOrderNo: string; amount: string }
    expect(comboProviderOrder.amount).toBe('8.00')
    const comboPaid = await page.request.post(`${walletFixtureBaseUrl}/__fixture/mark-paid`, {
      data: { merchantOrderNo: comboProviderOrder.merchantOrderNo },
    })
    expect(comboPaid.status()).toBe(200)
    const comboCallback = (await comboPaid.json()).callback as Record<string, string>
    const comboCallbackResponse = await page.request.get(
      `http://127.0.0.1:${topUpApiPort}/api/v1/payments/callback/zpay?${new URLSearchParams(comboCallback).toString()}`,
    )
    expect(comboCallbackResponse.status()).toBe(200)
    expect(await comboCallbackResponse.text()).toBe('success')
    await page.getByRole('button', { name: '刷新支付状态' }).click()
    await expect(page.getByText('服务端已确认付款').first()).toBeVisible()
    await expect(page.getByText('等待商家交付').first()).toBeVisible()

    await page.goto('/admin/wallets')
    await page.getByLabel('按顾客用户名搜索').fill(username)
    await page.getByRole('button', { name: '搜索钱包' }).click()
    await expect(page.getByText(username, { exact: true })).toBeVisible()
    await page.getByRole('listitem').filter({ hasText: username })
      .getByRole('link', { name: '流水与充值' }).click()
    await expect(page.getByRole('heading', { name: '顾客钱包明细' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '充值记录与支付凭证' })).toBeVisible()
    await expect(page.getByText('不可变钱包流水', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /修改余额|人工充值/u })).toHaveCount(0)
    expect(comboOrderId).toMatch(/^[0-9a-f-]{36}$/iu)
    expect(consoleMessages.join('\n')).not.toContain(merchantKey)
  } finally {
    if (createdChannelId) {
      const headers = await adminHeaders(page)
      const response = await page.request.get('/api/v1/admin/payment-channels')
      if (response.ok()) {
        const item = (await response.json()).data.items.find((value: { id: string }) => value.id === createdChannelId)
        if (item?.enabled) {
          await page.request.patch(`/api/v1/admin/payment-channels/${createdChannelId}`, {
            headers, data: { enabled: false },
          })
        }
      }
    }
  }
})

test('customer requests a full refund and an administrator approves it without changing delivered order history', async ({ page }) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(10_000)
  const unique = randomUUID().slice(0, 8)
  const channelName = `退款浏览器验收通道-${unique}`
  const productName = `退款浏览器验收商品-${unique}`
  const username = `refund${randomUUID().replaceAll('-', '').slice(0, 14)}`
  const testIp = `198.51.100.${(Number.parseInt(unique.slice(0, 2), 16) % 200) + 20}`
  let createdChannelId = ''
  const consoleMessages: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') consoleMessages.push(message.text())
  })
  await page.route('**/api/v1/**', route => route.continue({
    headers: { ...route.request().headers(), 'x-forwarded-for': testIp },
  }))

  try {
    await attachAdmin(page)
    const channelCreated = await page.request.post('/api/v1/admin/payment-channels', {
      headers: await adminHeaders(page),
      data: {
        providerType: 'zpay_epay_v1', name: channelName, enabled: true,
        paymentMethods: ['alipay', 'wechat'], displayOrder: 10, merchantId, merchantKey,
      },
    })
    expect(channelCreated.status()).toBe(201)
    createdChannelId = (await channelCreated.json()).data.channel.id as string

    const product = await createProduct(page, productName)
    await registerCustomer(page, username)
    await addProductToCart(page, product)
    await page.goto('/cart')
    await page.getByRole('link', { name: '查看结算报价' }).click()
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/iu)
    const orderId = page.url().split('/').at(-1)!
    await expect(page.getByText('外部支付', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /创建外部支付/u }).click()
    await expect(page.getByAltText('本次订单的支付二维码')).toBeVisible()

    const fixturePort = process.env.ZPAY_FIXTURE_PORT ?? '3099'
    const fixtureBaseUrl = `http://127.0.0.1:${fixturePort}`
    const fixtureOrders = await page.request.get(`${fixtureBaseUrl}/__fixture/orders`)
    expect(fixtureOrders.status()).toBe(200)
    const merchantOrderNo = (await fixtureOrders.json()).items.at(-1).merchantOrderNo as string
    const paid = await page.request.post(`${fixtureBaseUrl}/__fixture/mark-paid`, { data: { merchantOrderNo } })
    expect(paid.status()).toBe(200)
    const callback = (await paid.json()).callback as Record<string, string>
    const apiPort = process.env.AIKAYUN_TEST_API_PORT ?? '3001'
    const callbackResponse = await page.request.get(
      `http://127.0.0.1:${apiPort}/api/v1/payments/callback/zpay?${new URLSearchParams(callback).toString()}`,
    )
    expect(callbackResponse.status()).toBe(200)
    expect(await callbackResponse.text()).toBe('success')
    await page.getByRole('button', { name: '刷新支付状态' }).click()
    await expect(page.getByText('等待商家交付').first()).toBeVisible()

    await page.goto(`/admin/orders/${orderId}`)
    await expect(page.getByRole('heading', { name: '退款与订单售后' })).toBeVisible()
    await page.getByRole('textbox', { name: `${productName}实际交付内容，每行一件` }).fill('REFUND-E2E-DELIVERED-CONTENT')
    await page.getByRole('button', { name: '确认实际交付' }).click()
    await expect(page.getByText('已完成', { exact: true })).toBeVisible()

    await page.goto(`/orders/${orderId}`)
    await expect(page.getByRole('heading', { name: '退款进度' })).toBeVisible()
    await page.getByLabel('申请退款金额').fill('5.00')
    await page.getByLabel('退款原因').fill('浏览器验收全额退款申请')
    await page.getByRole('button', { name: '提交退款申请' }).click()
    await expect(page.getByRole('status')).toContainText('退款申请已提交')
    await expect(page.getByText('审核或处理中', { exact: true })).toBeVisible()

    await page.goto(`/admin/orders/${orderId}`)
    await expect(page.getByText('原因：浏览器验收全额退款申请')).toBeVisible()
    await page.getByRole('button', { name: '审核通过' }).click()
    await expect(page.getByRole('region', { name: '退款与订单售后' }).getByRole('status')).toContainText('已审核通过')
    await expect(page.getByText('外部收款 → 现金余额', { exact: false })).toBeVisible()
    await expect(page.getByText('全额已退', { exact: true })).toBeVisible()
    await expect(page.getByText('退款操作', { exact: false })).toBeVisible()

    await page.goto(`/orders/${orderId}`)
    await expect(page.getByText('订单已完成')).toBeVisible()
    await expect(page.getByText('已全额退款', { exact: true })).toBeVisible()
    await expect(page.getByText('REFUND-E2E-DELIVERED-CONTENT')).toBeVisible()
    await expect(page.getByText('支付宝 / 微信实收 → 退回现金余额')).toBeVisible()
    const wallet = await page.request.get('/api/v1/customer/wallet')
    expect(wallet.status()).toBe(200)
    expect((await wallet.json()).data.cashAvailable).toBe('5.00')

    const ssrResponse = await page.request.get(`/orders/${orderId}`)
    expect(ssrResponse.status()).toBe(200)
    expect(ssrResponse.headers()['cache-control']).toContain('no-store')
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
      }))
      expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport)
    }
    expect(consoleMessages.join('\n')).toBe('')
  } finally {
    if (createdChannelId) {
      await page.request.patch(`/api/v1/admin/payment-channels/${createdChannelId}`, {
        headers: await adminHeaders(page), data: { enabled: false },
      })
    }
  }
})
