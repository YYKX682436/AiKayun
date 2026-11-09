import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100'
const featuredEndpoint = '/api/v1/admin/storefront/featured-products'
const publicFeaturedEndpoint = '/api/v1/public/storefront/featured-products'

type AdminProduct = {
  id: string
  name: string
  revision: number
  status: 'draft' | 'active' | 'paused' | 'archived'
}

async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get('/api/v1/admin/auth/csrf')
  expect(response.status()).toBe(200)
  return (await response.json()).data.csrfToken as string
}

function adminHeaders(page: Page, token: string) {
  return { origin: new URL(baseURL).origin, 'x-csrf-token': token }
}

async function createProduct(page: Page, name: string): Promise<AdminProduct> {
  const response = await page.request.post('/api/v1/admin/products', {
    headers: adminHeaders(page, await csrfToken(page)),
    data: {
      name,
      description: '仅用于验收首页推荐与商品生命周期展示。',
      productType: 'digital',
      defaultSku: { salePrice: '19.90' },
    },
  })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).data as AdminProduct
}

async function changeLifecycle(page: Page, product: AdminProduct, status: 'active' | 'paused' | 'archived'): Promise<AdminProduct> {
  const response = await page.request.patch('/api/v1/admin/products/' + product.id + '/lifecycle', {
    headers: adminHeaders(page, await csrfToken(page)),
    data: { expectedRevision: product.revision, status },
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()).data as AdminProduct
}

async function addFeaturedProduct(page: Page, product: AdminProduct) {
  await page.getByLabel('搜索在售商品').fill(product.name)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const addButton = page.getByRole('button', { name: '推荐 ' + product.name })
  await expect(addButton).toBeVisible()
  await addButton.click()
  await expect(page.getByRole('list', { name: '首页推荐顺序' }).getByText(product.name)).toBeVisible()
}

async function clearFeaturedProducts(page: Page) {
  const response = await page.request.put(featuredEndpoint, {
    headers: adminHeaders(page, await csrfToken(page)),
    data: { productIds: [] },
  })
  expect(response.status()).toBe(200)
}

async function cleanProduct(page: Page, product: AdminProduct) {
  let current = product
  if (current.status === 'active') current = await changeLifecycle(page, current, 'paused')
  if (current.status !== 'archived') current = await changeLifecycle(page, current, 'archived')
  const response = await page.request.delete('/api/v1/admin/products/' + current.id, {
    headers: adminHeaders(page, await csrfToken(page)),
    data: { expectedRevision: current.revision },
  })
  expect(response.status()).toBe(200)
}

test('店主可搜索、排序和保存首页推荐，暂停后隐藏并重新上架恢复 SSR 展示', async ({ page }) => {
  test.setTimeout(60_000)
  const sessionToken = createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session',
    value: sessionToken,
    url: baseURL,
    httpOnly: true,
    sameSite: 'Lax',
  }])
  await page.setViewportSize({ width: 390, height: 844 })

  const suffix = randomUUID().slice(0, 8)
  let alpha: AdminProduct | undefined
  let beta: AdminProduct | undefined
  try {
    alpha = await createProduct(page, '首页推荐 Alpha ' + suffix)
    beta = await createProduct(page, '首页推荐 Beta ' + suffix)
    alpha = await changeLifecycle(page, alpha, 'active')
    beta = await changeLifecycle(page, beta, 'active')

    await page.goto('/admin/storefront/featured')
    await expect(page.locator('#admin-main').getByRole('heading', { name: '首页推荐', exact: true })).toBeVisible()
    await expect(page.getByRole('list', { name: '在售商品搜索结果' })).toBeVisible()

    await addFeaturedProduct(page, alpha)
    await addFeaturedProduct(page, beta)
    await page.getByRole('button', { name: '将 ' + beta.name + ' 上移' }).click()
    await page.getByRole('button', { name: '保存推荐' }).click()
    await expect(page.getByRole('status')).toContainText('首页推荐已保存')

    await page.reload()
    const savedItems = page.getByRole('list', { name: '首页推荐顺序' }).locator(':scope > li')
    await expect(savedItems).toHaveCount(2)
    await expect(savedItems.nth(0)).toContainText(beta.name)
    await expect(savedItems.nth(1)).toContainText(alpha.name)
    await page.getByRole('button', { name: '将 ' + beta.name + ' 下移' }).click()
    await expect(savedItems.nth(0)).toContainText(alpha.name)
    await expect(savedItems.nth(1)).toContainText(beta.name)
    await page.getByRole('button', { name: '将 ' + beta.name + ' 上移' }).click()
    await expect(savedItems.nth(0)).toContainText(beta.name)
    await expect(savedItems.nth(1)).toContainText(alpha.name)

    await page.getByRole('button', { name: '移除 ' + alpha.name }).click()
    await page.getByRole('button', { name: '保存推荐' }).click()
    await expect(page.getByRole('status')).toContainText('首页推荐已保存')
    const removed = await page.request.get(publicFeaturedEndpoint)
    expect((await removed.json()).data.products.map((item: { id: string }) => item.id)).toEqual([beta.id])

    await addFeaturedProduct(page, alpha)
    await page.getByRole('button', { name: '保存推荐' }).click()
    await expect(page.getByRole('status')).toContainText('首页推荐已保存')

    const publicSaved = await page.request.get(publicFeaturedEndpoint)
    expect(publicSaved.status()).toBe(200)
    expect((await publicSaved.json()).data.products.map((item: { id: string }) => item.id)).toEqual([beta.id, alpha.id])
    const allProducts = await page.request.get('/api/v1/public/products?pageSize=24&sort=newest')
    expect((await allProducts.json()).data.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([alpha.id, beta.id]))

    let storefrontResponse = await page.goto('/')
    expect(storefrontResponse?.status()).toBe(200)
    let featuredSection = page.locator('section[aria-labelledby="featured-products-title"]')
    await expect(featuredSection.getByRole('heading', { name: '精选推荐' })).toBeVisible()
    const featuredLinks = featuredSection.locator('ul > li > a')
    await expect(featuredLinks).toHaveCount(2)
    await expect(featuredLinks.nth(0)).toHaveAttribute('href', '/products/' + beta.id)
    await expect(featuredLinks.nth(1)).toHaveAttribute('href', '/products/' + alpha.id)
    const html = await storefrontResponse!.text()
    const featuredSectionStart = html.indexOf('aria-labelledby="featured-products-title"')
    const allProductsHeading = html.indexOf('id="all-products-title"')
    expect(featuredSectionStart).toBeGreaterThanOrEqual(0)
    expect(allProductsHeading).toBeGreaterThan(featuredSectionStart)
    const featuredSectionEnd = html.indexOf('</section>', featuredSectionStart)
    expect(featuredSectionEnd).toBeGreaterThan(featuredSectionStart)
    expect(allProductsHeading).toBeGreaterThan(featuredSectionEnd)
    const featuredSectionHtml = html.slice(featuredSectionStart, featuredSectionEnd)
    expect(featuredSectionHtml).toContain(beta.name)
    expect(featuredSectionHtml).toContain(alpha.name)
    expect(featuredSectionHtml).toContain('/products/' + beta.id)
    expect(featuredSectionHtml).toContain('/products/' + alpha.id)

    beta = await changeLifecycle(page, beta, 'paused')
    const hiddenResponse = await page.request.get(publicFeaturedEndpoint)
    expect((await hiddenResponse.json()).data.products.map((item: { id: string }) => item.id)).toEqual([alpha.id])
    storefrontResponse = await page.goto('/')
    featuredSection = page.locator('section[aria-labelledby="featured-products-title"]')
    await expect(featuredSection.locator('ul > li > a')).toHaveCount(1)
    await expect(featuredSection.locator('ul > li > a').first()).toHaveAttribute('href', '/products/' + alpha.id)
    await expect(featuredSection).not.toContainText(beta.name)

    beta = await changeLifecycle(page, beta, 'active')
    const restored = await page.request.get(publicFeaturedEndpoint)
    expect((await restored.json()).data.products.map((item: { id: string }) => item.id)).toEqual([beta.id, alpha.id])
    storefrontResponse = await page.goto('/?page=2')
    await expect(page.locator('section[aria-labelledby="featured-products-title"]')).toHaveCount(0)
    expect(storefrontResponse?.status()).toBe(200)
  } finally {
    if (alpha || beta) {
      await clearFeaturedProducts(page).catch(() => undefined)
      if (alpha) await cleanProduct(page, alpha).catch(() => undefined)
      if (beta) await cleanProduct(page, beta).catch(() => undefined)
    }
  }
})
