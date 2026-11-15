import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIResponse, type Page } from '@playwright/test'

const categoryId = '550e8400-e29b-41d4-a716-446655440001'
const productId = '550e8400-e29b-41d4-a716-446655440000'
const multiSpecProductId = '550e8400-e29b-41d4-a716-446655440011'
const formProductId = '550e8400-e29b-41d4-a716-446655440022'
const outOfStockProductId = '550e8400-e29b-41d4-a716-446655440033'
const hiddenCategoryId = '550e8400-e29b-41d4-a716-446655440002'
const apiOrigin = 'http://127.0.0.1:3111'
const screenshotsDir = resolve(import.meta.dirname, '../../../../docs/screenshots')
const artifactDir = '/Users/muchen/.gemini/antigravity/brain/aa31761c-37cf-4e80-af20-641363032cad'

async function failApi(path: string): Promise<void> {
  await fetch(`${apiOrigin}/__test/fail?path=${encodeURIComponent(path)}`)
}

async function resetApi(): Promise<void> {
  await fetch(`${apiOrigin}/__test/reset`)
}

async function html(page: Page, path: string, status: number): Promise<{ response: APIResponse; body: string }> {
  const response = await page.request.get(path)
  expect(response.status()).toBe(status)
  const body = await response.text()
  expect(response.headers()['content-type']).toContain('text/html')
  return { response, body }
}

function canonical(body: string): string | undefined {
  return body.match(/<link rel="canonical" href="([^"]+)"/u)?.[1]
}

test('SSR returns real success, unavailable and retryable server statuses with no upstream details', async ({ page }) => {
  const home = await html(page, '/', 200)
  expect(home.response.headers()['cache-control']).toBe('no-store')
  expect(home.body).toContain('全部商品')

  const category = await html(page, `/categories/${categoryId}`, 200)
  expect(category.body).toContain('SSR可见分类')
  expect(category.response.headers()['cache-control']).toBe('no-store')

  const search = await html(page, '/search?q=%E6%B5%8B%E8%AF%95', 200)
  expect(search.body).toContain('搜索商品')
  expect(search.body).toContain('name="robots" content="noindex, follow"')

  const product = await html(page, `/products/${productId}`, 200)
  expect(product.body).toContain('SSR真实商品')
  expect(product.body).toContain('安全 SSR 内容')
  expect(product.response.headers()['cache-control']).toBe('no-store')

  const missingCategory = await html(page, `/categories/${hiddenCategoryId}`, 404)
  expect(missingCategory.body).toContain('分类不存在或暂不可见')
  expect(missingCategory.body).not.toContain('SSR隐藏分类名')
  expect((await html(page, '/categories/not-a-uuid', 404)).body).toContain('分类不存在或暂不可见')

  const unavailableProduct = await page.request.get(`/products/${hiddenCategoryId}`, { maxRedirects: 0 })
  expect(unavailableProduct.status()).toBe(302)
  expect(unavailableProduct.headers().location).toBe('/')
  expect(await unavailableProduct.text()).not.toContain('SSR真实商品')

  const errorCases = [
    { path: '/api/v1/public/products', url: '/', title: '商品暂时无法加载' },
    { path: `/api/v1/public/categories/${categoryId}/products`, url: `/categories/${categoryId}`, title: '分类暂时无法加载' },
    { path: '/api/v1/public/search', url: '/search', title: '搜索暂时失败' },
    { path: `/api/v1/public/products/${productId}`, url: `/products/${productId}`, title: '商品暂时无法加载' },
  ]

  for (const item of errorCases) {
    await failApi(item.path)
    const result = await html(page, item.url, 502)
    expect(result.response.headers()['location']).toBeUndefined()
    expect(result.response.headers()['cache-control']).toBe('no-store')
    expect(result.body).toContain(item.title)
    expect(result.body).toContain('请检查网络后重试')
    expect(result.body).not.toContain('private database stack marker')
    expect(result.body).not.toContain('D7_PRIVATE_DATABASE_STACK_TRACE')
    expect(result.body).not.toContain('ssr-error-probe')
    await resetApi()
  }
})

test('SSR canonical includes validated pagination and sort only, and never trusts Host or arbitrary query keys', async ({ page }) => {
  const pageOne = await html(page, '/', 200)
  expect(canonical(pageOne.body)).toBe('http://127.0.0.1:3110/')

  const pageTwo = await html(page, '/?page=2&sort=price_desc&xss=%3Cimg%3E', 200)
  expect(canonical(pageTwo.body)).toBe('http://127.0.0.1:3110/?page=2')

  const categoryOne = await html(page, `/categories/${categoryId}?sort=default&page=1&unknown=yes`, 200)
  expect(canonical(categoryOne.body)).toBe(`http://127.0.0.1:3110/categories/${categoryId}`)

  const categoryTwo = await html(page, `/categories/${categoryId}?page=2&sort=price_asc&unknown=yes`, 200)
  expect(canonical(categoryTwo.body)).toBe(`http://127.0.0.1:3110/categories/${categoryId}?page=2&sort=price_asc`)

  const search = await html(page, '/search?q=中文&page=2&sort=price_desc', 200)
  expect(canonical(search.body)).toBe('http://127.0.0.1:3110/search')
  expect(search.body).toContain('name="robots" content="noindex, follow"')

  const spoofedHost = await page.request.get('/', { headers: { 'x-forwarded-host': 'attacker.invalid' } })
  expect(spoofedHost.status()).toBe(200)
  expect(await spoofedHost.text()).toContain('href="http://127.0.0.1:3110/"')
})

test('client navigation keeps retryable errors on the requested public route', async ({ page }) => {
  await page.goto('/')
  await failApi(`/api/v1/public/products/${productId}`)
  await page.evaluate((id) => {
    const link = document.createElement('a')
    link.id = 'client-product-link'
    link.href = `/products/${id}`
    link.textContent = '打开测试商品'
    document.body.append(link)
  }, productId)
  await page.locator('#client-product-link').click()
  await expect(page).toHaveURL(`/products/${productId}`)
  await expect(page.getByText('商品暂时无法加载')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
  expect(await page.locator('body').innerText()).not.toContain('private database stack marker')
  await resetApi()
})

test('support errors hide previously loaded contacts and can retry without leaving the page', async ({ page }) => {
  test.setTimeout(90_000)
  const linkName = '打开SSR售后渠道（新窗口）'
  try {
    await page.goto('/')
    await expect(page.locator('[data-storefront-ready="true"]')).toBeAttached({ timeout: 30_000 })
    const footerLink = page.locator('footer').getByRole('link', { name: '联系客服' })
    await expect(footerLink).toHaveAttribute('href', '/support')
    await failApi('/api/v1/public/storefront/support')
    const unavailable = await html(page, '/support', 502)
    expect(unavailable.response.headers()['cache-control']).toBe('no-store')
    expect(unavailable.body).toContain('暂时无法读取客服联系方式')
    expect(unavailable.body).not.toContain('店主暂未设置客服联系方式')
    expect(unavailable.body).not.toContain('private database stack marker')
    expect(unavailable.body).not.toContain('https://support.example.test/contact')

    await footerLink.click()
    await expect(page).toHaveURL('/support')
    await expect(page.getByRole('alert')).toContainText('暂时无法读取客服联系方式')
    await expect(page.getByRole('link', { name: linkName })).toHaveCount(0)
    await expect(footerLink).toHaveCount(0)
    await expect(page.getByText('店主暂未设置客服联系方式')).toHaveCount(0)
    await resetApi()
    await page.getByRole('button', { name: '重试' }).click()
    await expect(page.getByRole('link', { name: linkName })).toHaveAttribute('href', 'https://support.example.test/contact')
    await expect(footerLink).toHaveAttribute('href', '/support')
  } finally {
    await resetApi()
  }
})


test('unauthenticated admin SSR redirect preserves only the requested path', async ({ request }) => {
  const sensitive = 'sensitive-callback-signature-marker'
  const requestedPath = `/admin/orders/${productId}`
  const response = await request.get(`${requestedPath}?token=${sensitive}&sign=${sensitive}`, {
    maxRedirects: 0, headers: { cookie: `private=${sensitive}`, authorization: `Bearer ${sensitive}` },
  })
  expect(response.status()).toBe(302)
  const location = response.headers().location
  expect(location).toBeDefined()
  const destination = new URL(location!, 'http://127.0.0.1:3110')
  expect(destination.pathname).toBe('/admin/login')
  expect(destination.searchParams.get('redirect')).toBe(requestedPath)
  expect(location).not.toContain(sensitive)
  expect(await response.text()).not.toContain(sensitive)
})

test('product detail page visual, multi-spec SKU selection, purchase form and responsive experience', async ({ page }) => {
  mkdirSync(screenshotsDir, { recursive: true })
  mkdirSync(artifactDir, { recursive: true })

  function saveShot(filename: string): void {
    const destRepo = resolve(screenshotsDir, filename)
    const destArtifact = resolve(artifactDir, filename)
    copyFileSync(destRepo, destArtifact)
  }

  // 1. Multi-spec product detail page
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/products/${multiSpecProductId}`)
  await expect(page.locator('[data-storefront-ready="true"]')).toBeVisible()

  await expect(page.getByRole('heading', { level: 1, name: '安全双因子认证硬件令牌 FIDO2' })).toBeVisible()
  await expect(page.getByText('¥128.00 起')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Type-C', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '双模 (Type-C + NFC)' })).toBeVisible()
  await expect(page.getByRole('button', { name: '深空黑' })).toBeVisible()
  await expect(page.getByRole('button', { name: '星光银' })).toBeVisible()
  await expect(page.getByText('请选择完整规格以查看对应价格和供货状态。')).toBeVisible()

  // Select Type-C and 深空黑
  await page.getByRole('button', { name: 'Type-C', exact: true }).click()
  await page.getByRole('button', { name: '深空黑' }).click()
  await expect(page.getByText('¥128.00', { exact: true })).toBeVisible()
  await expect(page.locator('del')).toHaveText('¥158.00')
  await expect(page.getByText('有货')).toBeVisible()

  // Switch to out-of-stock combination
  await page.getByRole('button', { name: '双模 (Type-C + NFC)' }).click()
  await page.getByRole('button', { name: '星光银' }).click()
  await expect(page.getByText('¥198.00', { exact: true })).toBeVisible()
  await expect(page.getByText('暂时缺货')).toBeVisible()

  // Clear selection
  await page.getByRole('button', { name: '清除规格选择' }).click()
  await expect(page.getByText('请选择完整规格以查看对应价格和供货状态。')).toBeVisible()

  // Re-select in-stock SKU
  await page.getByRole('button', { name: 'Type-C', exact: true }).click()
  await page.getByRole('button', { name: '深空黑' }).click()
  await expect(page.getByText('¥128.00', { exact: true })).toBeVisible()

  // Stepper test
  await page.getByRole('button', { name: '增加数量' }).click()
  await expect(page.getByLabel('购买数量')).toHaveValue('2')
  await page.getByRole('button', { name: '减少数量' }).click()
  await expect(page.getByLabel('购买数量')).toHaveValue('1')

  // Purchase buttons
  await expect(page.getByRole('button', { name: '加入购物车' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '立即购买' })).toBeEnabled()

  // Attributes & Rich Content
  await expect(page.getByRole('heading', { name: '商品信息' })).toBeVisible()
  await expect(page.getByText('认证标准')).toBeVisible()
  await expect(page.getByText('FIDO2 Level 2, WebAuthn')).toBeVisible()
  await expect(page.getByRole('heading', { name: '商品分类' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '商品详情' })).toBeVisible()
  await expect(page.getByText('产品概述')).toBeVisible()

  // Desktop Light Screenshot
  const desktopLightPath = resolve(screenshotsDir, 'product-detail-desktop-light.png')
  await page.screenshot({ path: desktopLightPath, fullPage: true })
  saveShot('product-detail-desktop-light.png')

  // Desktop Dark Screenshot
  await page.evaluate(() => {
    document.documentElement.classList.remove('light')
    document.documentElement.classList.add('dark')
  })
  const desktopDarkPath = resolve(screenshotsDir, 'product-detail-desktop-dark.png')
  await page.screenshot({ path: desktopDarkPath, fullPage: true })
  saveShot('product-detail-desktop-dark.png')

  // Mobile Dark Screenshot (390x844)
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileDarkPath = resolve(screenshotsDir, 'product-detail-mobile-dark.png')
  await page.screenshot({ path: mobileDarkPath, fullPage: true })
  saveShot('product-detail-mobile-dark.png')

  // Mobile Light Screenshot (390x844)
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
  })
  const mobileLightPath = resolve(screenshotsDir, 'product-detail-mobile-light.png')
  await page.screenshot({ path: mobileLightPath, fullPage: true })
  saveShot('product-detail-mobile-light.png')

  // Mobile 320px Light Screenshot
  await page.setViewportSize({ width: 320, height: 640 })
  const mobile320Path = resolve(screenshotsDir, 'product-detail-mobile-320px-light.png')
  await page.screenshot({ path: mobile320Path, fullPage: true })
  saveShot('product-detail-mobile-320px-light.png')

  // 2. Product with purchase form
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/products/${formProductId}`)
  await expect(page.locator('[data-storefront-ready="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: '企业域名解析与 SSL 证书部署服务' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /域名与证书配置资料 · 购买资料/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建一组购买资料' })).toBeVisible()

  // Click create new draft
  await page.getByRole('button', { name: '新建一组购买资料' }).click()
  await expect(page.getByLabel('待部署主域名')).toBeVisible()
  await page.getByLabel('待部署主域名').fill('shop.aiove.top')
  await expect(page.getByRole('button', { name: '保存填写内容' })).toBeEnabled()
  await page.getByRole('button', { name: '保存填写内容' }).click()
  await expect(page.getByRole('button', { name: '校验完整性' })).toBeEnabled()
  await page.getByRole('button', { name: '校验完整性' }).click()

  const formDesktopPath = resolve(screenshotsDir, 'product-detail-form-desktop-light.png')
  await page.screenshot({ path: formDesktopPath, fullPage: true })
  saveShot('product-detail-form-desktop-light.png')

  // 3. Product without cover and out of stock
  await page.goto(`/products/${outOfStockProductId}`)
  await expect(page.locator('[data-storefront-ready="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: '开发者高阶 API 专属算力包' })).toBeVisible()
  await expect(page.getByLabel('暂无可展示图片')).toBeVisible()
  await expect(page.getByText('暂无可选规格')).toBeVisible()
  await expect(page.getByText('暂时缺货')).toBeVisible()

  const emptyCoverPath = resolve(screenshotsDir, 'product-detail-empty-cover-light.png')
  await page.screenshot({ path: emptyCoverPath, fullPage: true })
  saveShot('product-detail-empty-cover-light.png')
})
