import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { captureBrowserDiagnostics, expectClientMounted } from './browser-diagnostics'

type ProductRecord = {
  id: string
  name: string
  description: string
  revision: number
  status: 'draft' | 'active' | 'paused' | 'archived'
  variants: Array<{ id: string; revision: number; salePrice: string; options: Array<{ groupName: string; valueName: string }> }>
}

let authenticatedCookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>['cookies'] | null = null

test.beforeEach(async ({ page }) => {
  captureBrowserDiagnostics(page)
})

async function dataOf<T>(response: Awaited<ReturnType<APIRequestContext['get']>>, status: number): Promise<T> {
  expect(response.status()).toBe(status)
  const body = await response.json() as { data: T; error?: { message?: string } }
  if (status >= 400) throw new Error(body.error?.message ?? `Expected API status ${status}`)
  return body.data
}

async function authenticate(page: Page): Promise<void> {
  if (authenticatedCookies) {
    await page.context().addCookies(authenticatedCookies)
    return
  }

  const csrfResponse = await page.request.get('/api/v1/admin/auth/csrf')
  expect(csrfResponse.status()).toBe(200)
  const csrf = (await csrfResponse.json()).data.csrfToken as string
  const login = await page.request.post('/api/v1/admin/auth/login', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf },
    data: { email: 'browser-test@example.com', password: 'Only-For-E2E-Tests-2026!!' },
  })
  expect(login.status()).toBe(200)
  authenticatedCookies = (await page.context().storageState()).cookies
}

async function createCategory(page: Page, name: string, parentId?: string) {
  const response = await page.request.post('/api/v1/admin/categories', {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: { name, ...(parentId ? { parentId } : {}) },
  })
  return dataOf<{ id: string; revision: number }>(response, 201)
}

async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get('/api/v1/admin/auth/csrf')
  expect(response.status()).toBe(200)
  return (await response.json()).data.csrfToken as string
}

async function createProduct(page: Page, name: string, description: string, salePrice = '19.90', productType: 'physical' | 'digital' | 'service' = 'digital'): Promise<ProductRecord> {
  const response = await page.request.post('/api/v1/admin/products', {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: { name, description, productType, defaultSku: { salePrice } },
  })
  return dataOf<ProductRecord>(response, 201)
}

async function assignProductCategory(page: Page, product: ProductRecord, categoryId: string): Promise<ProductRecord> {
  const response = await page.request.put(`/api/v1/admin/products/${product.id}/categories`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: { expectedRevision: product.revision, assignments: [{ categoryId, isPrimary: true, sortOrder: 0 }] },
  })
  return dataOf<ProductRecord>(response, 200)
}

async function getAdminProduct(page: Page, productId: string): Promise<ProductRecord> {
  const response = await page.request.get(`/api/v1/admin/products/${productId}`)
  expect(response.status()).toBe(200)
  return (await response.json()).data as ProductRecord
}

async function setLifecycle(page: Page, product: ProductRecord, status: 'active' | 'paused' | 'archived'): Promise<ProductRecord> {
  const response = await page.request.patch(`/api/v1/admin/products/${product.id}/lifecycle`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: { expectedRevision: product.revision, status },
  })
  return dataOf<ProductRecord>(response, 200)
}

async function deleteProduct(page: Page, product: ProductRecord): Promise<void> {
  const response = await page.request.delete(`/api/v1/admin/products/${product.id}`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: { expectedRevision: product.revision },
  })
  expect(response.status()).toBe(200)
}

async function deleteProductFromList(page: Page, product: { id: string; revision: number }): Promise<void> {
  const response = await page.request.delete(`/api/v1/admin/products/${product.id}`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: { expectedRevision: product.revision },
  })
  expect(response.status()).toBe(200)
}

async function cleanInterruptedD7Fixtures(page: Page): Promise<void> {
  await authenticate(page)

  for (const search of ['D7', 'R2搜索B专属商品']) {
    const response = await page.request.get(`/api/v1/admin/products?search=${encodeURIComponent(search)}&pageSize=100`)
    const result = await dataOf<{ items: Array<{ id: string; name: string; revision: number }> }>(response, 200)
    const fixtures = search === 'D7'
      ? result.items.filter(product => product.name.startsWith('D7'))
      : result.items.filter(product => product.name === 'R2搜索B专属商品')
    for (const product of fixtures) await deleteProductFromList(page, product)
  }

  const categoriesResponse = await page.request.get('/api/v1/admin/categories')
  const categories = (await dataOf<{ categories: Array<{ id: string; name: string; revision: number }> }>(categoriesResponse, 200)).categories
  for (const name of ['D7四级分类', 'D7三级分类', 'D7二级分类', 'D7真实目录']) {
    const category = categories.find(item => item.name === name)
    if (!category) continue
    const response = await page.request.delete(`/api/v1/admin/categories/${category.id}`, {
      headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
      data: { expectedRevision: category.revision },
    })
    expect(response.status()).toBe(200)
  }

  const mediaResponse = await page.request.get('/api/v1/admin/media?pageSize=100')
  const media = await dataOf<{ items: Array<{ id: string; referenceCount: number }> }>(mediaResponse, 200)
  for (const item of media.items.filter(candidate => candidate.referenceCount === 0)) {
    const response = await page.request.delete(`/api/v1/admin/media/${item.id}`, {
      headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    })
    expect(response.status()).toBe(200)
  }
}

async function expectTemporaryHomeRedirect(page: Page, product: ProductRecord): Promise<void> {
  const response = await page.request.get(`/products/${product.id}`, { maxRedirects: 0 })
  expect(response.status()).toBe(302)
  expect(response.headers().location).toBe('/')
  expect(await response.text()).not.toContain(product.name)
}

async function navigateClient(page: Page, path: string): Promise<void> {
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  await page.evaluate(async (nextPath) => {
    const root = document.querySelector('#__nuxt') as (HTMLElement & {
      __vue_app__?: { config: { globalProperties: { $router?: { push: (location: string) => Promise<unknown> } } } }
    }) | null
    const router = root?.__vue_app__?.config.globalProperties.$router
    if (!router) throw new Error('Nuxt client router is unavailable')
    await router.push(nextPath)
  }, path)
}

test('D7 serves a real SSR catalog, visible category path, safe media details, sparse SKU selection, and responsive search', async ({ page }) => {
  await page.goto('/')
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  await cleanInterruptedD7Fixtures(page)
  await page.goto('/')
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  await expect(page.getByRole('heading', { name: '暂无可展示的商品' })).toBeVisible()
  await authenticate(page)

  const root = await createCategory(page, 'D7真实目录')
  const second = await createCategory(page, 'D7二级分类', root.id)
  const third = await createCategory(page, 'D7三级分类', second.id)
  const fourth = await createCategory(page, 'D7四级分类', third.id)

  const png = readFileSync(new URL('../fixtures/d6-upload.png', import.meta.url))
  const mediaIds: string[] = []
  for (const index of [1, 2]) {
    const response = await page.request.post('/api/v1/admin/media', {
      headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
      multipart: { file: { name: `d7-real-${index}.png`, mimeType: 'image/png', buffer: png } },
    })
    const media = await dataOf<{ id: string }>(response, 201)
    mediaIds.push(media.id)
  }

  let product = await createProduct(page, 'D7真实中文商品', '支持中文目录检索的商品基础说明。')
  const gallery = await page.request.put(`/api/v1/admin/products/${product.id}/media`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: { expectedRevision: product.revision, mediaIds },
  })
  expect(gallery.status()).toBe(200)
  const galleryResult = (await gallery.json()).data as { revision: number; images: unknown[] }

  const richContent = await page.request.put(`/api/v1/admin/products/${product.id}/rich-content`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: {
      expectedRevision: galleryResult.revision,
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'D7安全详情' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '真实结构化商品说明。' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
          { type: 'image', attrs: { mediaId: mediaIds[0], alt: '真实商品图' } },
        ],
      },
    },
  })
  expect(richContent.status()).toBe(200)
  product = await getAdminProduct(page, product.id)

  const categoryUpdate = await page.request.put(`/api/v1/admin/products/${product.id}/categories`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: {
      expectedRevision: product.revision,
      assignments: [
        { categoryId: root.id, isPrimary: true, sortOrder: 0 },
        { categoryId: fourth.id, isPrimary: false, sortOrder: 1 },
      ],
    },
  })
  product = await dataOf<ProductRecord>(categoryUpdate, 200)
  product = await setLifecycle(page, product, 'active')

  const lowPriceProduct = await createProduct(page, 'D7价格排序低价测试商品', 'D7分类升降序回归。', '8.80')
  await setLifecycle(page, await assignProductCategory(page, lowPriceProduct, root.id), 'active')
  const highPriceProduct = await createProduct(page, 'D7价格排序高价测试商品', 'D7分类升降序回归。', '28.80')
  await setLifecycle(page, await assignProductCategory(page, highPriceProduct, root.id), 'active')
  const searchBProduct = await createProduct(page, 'R2搜索B专属商品', 'R2搜索结果身份回归。', '23.40')
  await setLifecycle(page, await assignProductCategory(page, searchBProduct, root.id), 'active')

  const unpublished = await page.request.get(`/api/v1/public/products/${product.id}`)
  expect(unpublished.status()).toBe(200)
  expect(unpublished.headers()['cache-control']).toBe('no-store')

  const publicPage = await page.request.get('/')
  expect(publicPage.status()).toBe(200)
  expect(publicPage.headers()['cache-control']).toBe('no-store')
  const publicHtml = await publicPage.text()
  expect(publicHtml).toContain(product.name)
  expect(publicHtml).toContain('19.90')
  expect(publicHtml).not.toContain('costPrice')
  const draftForSitemap = await createProduct(page, 'D7未发布不可进入地图', '仅用于验证 sitemap 的公开边界。')
  const sitemap = await page.request.get('/sitemap.xml')
  expect(sitemap.status()).toBe(200)
  const sitemapXml = await sitemap.text()
  expect(sitemapXml).toContain(`/products/${product.id}`)
  expect(sitemapXml).toContain(new URL(page.url()).origin)
  expect(sitemapXml).not.toContain(draftForSitemap.id)

  let lifecycle = await createProduct(page, 'D7生命周期前台跳转验证', '下架状态不能通过 SSR 泄露商品内容。')
  expect((await page.request.get(`/api/v1/public/products/${lifecycle.id}`)).status()).toBe(404)
  await expectTemporaryHomeRedirect(page, lifecycle)
  lifecycle = await setLifecycle(page, lifecycle, 'active')
  expect((await page.request.get(`/api/v1/public/products/${lifecycle.id}`)).status()).toBe(200)
  lifecycle = await setLifecycle(page, lifecycle, 'paused')
  expect((await page.request.get(`/api/v1/public/products/${lifecycle.id}`)).status()).toBe(404)
  await expectTemporaryHomeRedirect(page, lifecycle)
  lifecycle = await setLifecycle(page, lifecycle, 'archived')
  expect((await page.request.get(`/api/v1/public/products/${lifecycle.id}`)).status()).toBe(404)
  await expectTemporaryHomeRedirect(page, lifecycle)
  await deleteProduct(page, lifecycle)
  expect((await page.request.get(`/api/v1/public/products/${lifecycle.id}`)).status()).toBe(404)
  await expectTemporaryHomeRedirect(page, lifecycle)

  const categoryPage = await page.goto(`/categories/${root.id}`)
  expect(categoryPage?.status()).toBe(200)
  expect(categoryPage?.headers()['cache-control']).toBe('no-store')
  await expect(page.getByRole('heading', { name: 'D7真实目录' })).toBeVisible()
  await expect(page.locator(`a[href="/products/${product.id}"]`)).toBeVisible()
  const categoryApi = await page.request.get(`/api/v1/public/categories/${root.id}/products`)
  const categoryData = await dataOf<{ products: { items: Array<{ id: string }> } }>(categoryApi, 200)
  expect(categoryData.products.items.filter(item => item.id === product.id)).toHaveLength(1)
  await page.getByRole('link', { name: 'D7二级分类' }).click()
  await expect(page).toHaveURL(`/categories/${second.id}`)
  await expect(page.getByRole('heading', { name: 'D7二级分类' })).toBeVisible()
  await page.getByRole('navigation', { name: '面包屑' }).getByRole('link', { name: 'D7真实目录' }).click()
  await expect(page).toHaveURL(`/categories/${root.id}`)

  const categoryNames = () => page.locator('ul > li h2').allTextContents()
  await expect.poll(categoryNames).toContain('D7价格排序低价测试商品')
  let signalOldSortStarted!: () => void
  let releaseOldSort!: () => void
  const oldSortStarted = new Promise<void>(resolve => signalOldSortStarted = resolve)
  const oldSortGate = new Promise<void>(resolve => releaseOldSort = resolve)
  await page.route(`**/api/v1/public/categories/${root.id}/products**`, async (requestRoute) => {
    const url = new URL(requestRoute.request().url())
    if (url.searchParams.get('sort') === 'price_asc') {
      signalOldSortStarted()
      await oldSortGate
      try {
        await requestRoute.continue()
      }
      catch {
        // The ascending response is intentionally stale after descending is selected.
      }
      return
    }
    if (url.searchParams.get('sort') === 'newest') {
      await requestRoute.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'PRIVATE_SORT_DATABASE_STACK' } }) })
      return
    }
    await requestRoute.continue()
  })
  await navigateClient(page, `/categories/${root.id}?sort=price_asc`)
  await oldSortStarted
  await expect(page.locator('ul > li h2')).toHaveCount(0)
  await navigateClient(page, `/categories/${root.id}?sort=price_desc`)
  await expect.poll(categoryNames).toEqual(['D7价格排序高价测试商品', 'R2搜索B专属商品', 'D7真实中文商品', 'D7价格排序低价测试商品'])
  releaseOldSort()
  await expect.poll(categoryNames).toEqual(['D7价格排序高价测试商品', 'R2搜索B专属商品', 'D7真实中文商品', 'D7价格排序低价测试商品'])
  await navigateClient(page, `/categories/${root.id}?sort=newest`)
  await expect(page.getByText('分类暂时无法加载')).toBeVisible()
  await expect(page.locator('ul > li h2')).toHaveCount(0)
  await expect(page.getByText('PRIVATE_SORT_DATABASE_STACK')).toHaveCount(0)
  await page.unroute(`**/api/v1/public/categories/${root.id}/products**`)
  await page.goto(`/categories/${root.id}`)

  const detailRequest = await page.request.get(`/products/${product.id}`)
  expect(detailRequest.status()).toBe(200)
  expect(detailRequest.headers()['cache-control']).toBe('no-store')
  const detailHtml = await detailRequest.text()
  expect(detailHtml).toContain('<title>D7真实中文商品')
  expect(detailHtml).toContain('name="description"')
  expect(detailHtml).toContain('rel="canonical"')
  expect(detailHtml).toContain(`href="${new URL(page.url()).origin}/products/${product.id}"`)
  expect(detailHtml).toContain('property="og:image"')
  expect(detailHtml).toContain('D7安全详情')
  expect(detailHtml).toContain('真实结构化商品说明')
  expect(detailHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(detailHtml).not.toContain('<script>alert(1)</script>')
  const structuredDataMatch = detailHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/u)
  expect(structuredDataMatch?.[1]).toBeTruthy()
  const structuredData = JSON.parse(structuredDataMatch![1]!) as Record<string, unknown>
  expect(structuredData).toMatchObject({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description,
    category: 'D7真实目录',
  })
  expect(structuredData.image).toHaveLength(2)
  expect(structuredData).not.toHaveProperty('offers')
  expect(detailHtml).not.toContain('"offers"')
  expect(detailHtml).toContain('购买功能尚未开放')
  expect(detailHtml).not.toContain('立即购买')

  const detailBrowserRequests: string[] = []
  const recordDetailRequest = (request: import('@playwright/test').Request) => detailBrowserRequests.push(request.url())
  page.on('request', recordDetailRequest)
  await page.goto(`/products/${product.id}`)
  await expect(page.getByRole('heading', { level: 1, name: product.name })).toBeVisible()
  expect(detailBrowserRequests.filter(url => url.includes(`/api/v1/public/products/${product.id}`))).toHaveLength(0)
  expect(detailBrowserRequests.some(url => /ProductRichContentEditor|@tiptap|prosemirror/iu.test(url))).toBe(false)
  page.off('request', recordDetailRequest)
  await expect(page.getByText('购买功能尚未开放')).toBeVisible()
  await expect(page.getByRole('button', { name: /购买|加入购物车|立即购买/ })).toHaveCount(0)
  await expect(page.locator('.product-rich-content')).toContainText('真实结构化商品说明')
  await expect(page.locator('img[fetchpriority="high"]')).toBeVisible()
  await expect(page.locator('img[loading="lazy"]').first()).toBeVisible()
  await expect(page.locator('.product-rich-content img')).toHaveAttribute('src', `/api/v1/media/${mediaIds[0]}/detail.webp`)
  const immutableMedia = await page.request.get(`/api/v1/media/${mediaIds[0]}/thumbnail.webp`)
  expect(immutableMedia.status()).toBe(200)
  expect(immutableMedia.headers()['cache-control']).toContain('immutable')

  const unavailableId = randomUUID()
  const notFound = await page.request.get(`/products/${unavailableId}`, { maxRedirects: 0 })
  expect(notFound.status()).toBe(302)
  expect(notFound.headers().location).toBe('/')
  const notFoundPublicApi = await page.request.get(`/api/v1/public/products/${unavailableId}`)
  expect(notFoundPublicApi.status()).toBe(404)

  await page.route(`**/api/v1/public/products/${product.id}`, route => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }),
  }))
  await page.goto('/')
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  await page.getByRole('link', { name: /D7真实中文商品/ }).first().click()
  await expect(page).toHaveURL(`/products/${product.id}`)
  await expect(page.getByText('商品暂时无法加载')).toBeVisible()
  await page.unroute(`**/api/v1/public/products/${product.id}`)

  const sparse = await createProduct(page, 'D7稀疏矩阵月卡年卡设备数', '只存在两种真实规格组合。')
  const groupTerm = randomUUID()
  const groupDevices = randomUUID()
  const month = randomUUID()
  const year = randomUUID()
  const oneDevice = randomUUID()
  const threeDevices = randomUUID()
  const matrixResponse = await page.request.put(`/api/v1/admin/products/${sparse.id}/variant-matrix`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: {
      expectedRevision: sparse.revision,
      mode: 'selected',
      groups: [
        { id: groupTerm, name: '期限', sortOrder: 0, enabled: true, values: [
          { id: month, name: '月卡', sortOrder: 0, enabled: true },
          { id: year, name: '年卡', sortOrder: 1, enabled: true },
        ] },
        { id: groupDevices, name: '设备数', sortOrder: 1, enabled: true, values: [
          { id: oneDevice, name: '1台', sortOrder: 0, enabled: true },
          { id: threeDevices, name: '3台', sortOrder: 1, enabled: true },
        ] },
      ],
      combinations: [
        { optionValueIds: [month, oneDevice], salePrice: '10.00', enabled: true },
        { optionValueIds: [year, threeDevices], salePrice: '30.00', enabled: true },
      ],
    },
  })
  const matrix = await dataOf<{ product: ProductRecord }>(matrixResponse, 200)
  const skuPrices = await page.request.get(`/api/v1/admin/products/${sparse.id}/prices?page=1&pageSize=20`)
  const priceRows = (await skuPrices.json()).data.items as Array<{ skuId: string; skuRevision: number; salePrice: string }>
  const monthlySku = matrix.product.variants.find(variant => variant.salePrice === '10.00')!
  const priceResponse = await page.request.patch(`/api/v1/admin/products/${sparse.id}/prices/batch`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: {
      expectedRevision: matrix.product.revision,
      updates: [{
        skuId: monthlySku.id,
        expectedSkuRevision: priceRows.find(row => row.skuId === monthlySku.id)!.skuRevision,
        compareAtPrice: '15.00',
      }],
    },
  })
  const updatedPrice = await dataOf<{ productRevision: number }>(priceResponse, 200)
  const sparseCurrent = await getAdminProduct(page, sparse.id)
  sparseCurrent.revision = updatedPrice.productRevision
  const sparseActive = await setLifecycle(page, sparseCurrent, 'active')

  await page.goto(`/products/${sparseActive.id}`)
  await expect(page.getByRole('heading', { level: 1, name: sparse.name })).toBeVisible()
  await expect(page.getByText('请选择完整规格以查看对应价格和供货状态。')).toBeVisible()
  await expect(page.getByRole('button', { name: '3台' })).toBeEnabled()
  await page.getByRole('button', { name: '月卡' }).click()
  await expect(page.getByRole('button', { name: '3台' })).toBeDisabled()
  await page.getByRole('button', { name: '1台' }).click()
  await expect(page.getByText('¥10.00', { exact: true })).toBeVisible()
  await expect(page.locator('del')).toHaveText('¥15.00')
  await page.getByRole('button', { name: '年卡' }).click()
  await expect(page.getByRole('button', { name: '1台' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '3台' })).toBeEnabled()
  await page.getByRole('button', { name: '3台' }).click()
  await expect(page.getByText('¥30.00', { exact: true })).toBeVisible()
  await expect(page.locator('del')).toHaveCount(0)

  const searchPage = await page.goto(`/search?q=${encodeURIComponent('中文目录检索')}`)
  expect(searchPage?.status()).toBe(200)
  expect(searchPage?.headers()['cache-control']).toBe('no-store')
  await expect(page.getByRole('heading', { name: '搜索商品' })).toBeVisible()
  await expect(page.getByRole('link', { name: /D7真实中文商品/ })).toBeVisible()
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  const searchInput = page.getByLabel('搜索商品名称或描述')
  await searchInput.fill('D7不存在的检索词')
  await expect(searchInput).toHaveValue('D7不存在的检索词')
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('D7不存在的检索词')
  await expect(page.getByRole('heading', { name: '没有找到商品' })).toBeVisible()
  await searchInput.fill('中文目录检索')
  await expect(page.getByRole('link', { name: /D7真实中文商品/ })).toBeVisible()

  const delayedResponse = await page.request.get(`/api/v1/public/search?q=${encodeURIComponent('中文目录检索')}`)
  expect(delayedResponse.status()).toBe(200)
  const delayedBody = await delayedResponse.text()
  let signalSlowRouteStarted!: () => void
  let releaseSlowRoute!: () => void
  let signalSlowRouteSettled!: () => void
  const slowRouteStarted = new Promise<void>((resolve) => { signalSlowRouteStarted = resolve })
  const slowRouteGate = new Promise<void>((resolve) => { releaseSlowRoute = resolve })
  const slowRouteSettled = new Promise<void>((resolve) => { signalSlowRouteSettled = resolve })
  await page.route('**/api/v1/public/search**', async (requestRoute) => {
    const url = new URL(requestRoute.request().url())
    if (url.searchParams.get('q') !== 'D7慢速旧词') return requestRoute.continue()
    signalSlowRouteStarted()
    await slowRouteGate
    try {
      await requestRoute.fulfill({ status: 200, contentType: 'application/json', body: delayedBody })
    }
    catch {
      // The stale fetch is expected to be aborted as soon as the query changes.
    }
    finally {
      signalSlowRouteSettled()
    }
  })
  await searchInput.fill('D7慢速旧词')
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('D7慢速旧词')
  await slowRouteStarted
  await searchInput.fill('D7快速新词')
  releaseSlowRoute()
  await slowRouteSettled
  await expect(page.getByRole('link', { name: /D7真实中文商品/ })).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('D7快速新词')
  await expect(page.getByRole('heading', { name: '没有找到商品' })).toBeVisible()
  await page.unroute('**/api/v1/public/search**')
  await searchInput.fill('中文目录检索')
  await expect(page.getByRole('link', { name: /D7真实中文商品/ })).toBeVisible()

  await page.getByLabel('商品排序').click()
  await page.getByRole('option', { name: '最新商品' }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('newest')
  await page.goBack()
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBeNull()
  await expect(page.getByRole('link', { name: /D7真实中文商品/ })).toBeVisible()
  await page.goForward()
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('newest')

  for (const path of ['/', `/categories/${root.id}`, `/products/${product.id}`, '/search']) {
    await page.goto(path)
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }))
      expect(dimensions.scrollWidth, `${path} at ${width}px`).toBeLessThanOrEqual(dimensions.width)
    }
  }

  await page.setViewportSize({ width: 320, height: 760 })
  const categoryToggle = page.getByRole('button', { name: '浏览商品分类' })
  await expect(categoryToggle).toBeVisible()
  const touchSize = await categoryToggle.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))
  expect(touchSize.width).toBeGreaterThanOrEqual(36)
  expect(touchSize.height).toBeGreaterThanOrEqual(44)
  await categoryToggle.click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('link', { name: 'D7真实目录' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  await page.goto(`/products/${product.id}`)
  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: '深色' }).click()
  await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
  expect(await page.locator('html').getAttribute('data-aikayun-area')).toBe('storefront')

  const paused = await setLifecycle(page, product, 'paused')
  expect((await page.request.get(`/products/${product.id}`, { maxRedirects: 0 })).status()).toBe(302)
  const archived = await setLifecycle(page, paused, 'archived')
  expect((await page.request.get(`/products/${product.id}`, { maxRedirects: 0 })).status()).toBe(302)
  expect((await page.request.get(`/api/v1/public/products/${archived.id}`)).status()).toBe(404)

  const sparsePaused = await setLifecycle(page, sparseActive, 'paused')
  const sparseArchived = await setLifecycle(page, sparsePaused, 'archived')
  const deleted = await page.request.delete(`/api/v1/admin/products/${sparseArchived.id}`, {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: { expectedRevision: sparseArchived.revision },
  })
  await dataOf<{ productId: string; deleted: true }>(deleted, 200)
  expect((await page.request.get(`/products/${sparseArchived.id}`, { maxRedirects: 0 })).status()).toBe(302)
})

test('search re-entry never renders a previous query while the current URL is loading', async ({ page }) => {
  const fixtureToken = randomUUID().slice(0, 8)
  const searchAQuery = `R2搜索A-${fixtureToken}`
  const searchBQuery = `R2搜索B-${fixtureToken}`
  const searchAName = `${searchAQuery}专属商品`
  const searchBName = `${searchBQuery}重进专属商品`
  await page.goto('/')
  await authenticate(page)
  let searchA = await createProduct(page, searchAName, `只匹配搜索关键词 ${fixtureToken} A。`)
  searchA = await setLifecycle(page, searchA, 'active')
  const searchB = await createProduct(page, searchBName, `只匹配搜索关键词 ${fixtureToken} B。`)
  await setLifecycle(page, searchB, 'active')

  const searchAResponse = await page.goto(`/search?q=${encodeURIComponent(searchAQuery)}`)
  expect(searchAResponse?.status()).toBe(200)
  await expect(page.getByRole('link', { name: new RegExp(searchAName) })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(searchBName) })).toHaveCount(0)
  await page.getByRole('link', { name: new RegExp(searchAName) }).click()
  await expect(page).toHaveURL(`/products/${searchA.id}`)

  let signalSearchBStarted!: () => void
  let releaseSearchB!: () => void
  const searchBStarted = new Promise<void>(resolve => signalSearchBStarted = resolve)
  const searchBGate = new Promise<void>(resolve => releaseSearchB = resolve)
  await page.route('**/api/v1/public/search**', async (requestRoute) => {
    if (new URL(requestRoute.request().url()).searchParams.get('q') === searchBQuery) {
      signalSearchBStarted()
      await searchBGate
    }
    await requestRoute.continue()
  })
  await page.getByRole('link', { name: '搜索商品' }).click()
  await expect(page).toHaveURL('/search')
  await expectClientMounted(page, '[data-storefront-ready="true"]')
  await expect(page.locator('ul.grid > li').first()).toBeVisible()
  const searchbox = page.getByRole('searchbox', { name: '搜索商品名称或描述' })
  await searchbox.fill(searchBQuery)
  await expect(searchbox).toHaveValue(searchBQuery)
  await expect(page).toHaveURL(`/search?q=${encodeURIComponent(searchBQuery)}`)
  await searchBStarted
  await expect(page.getByRole('link', { name: new RegExp(searchAName) })).toHaveCount(0)
  releaseSearchB()
  await expect(page.getByRole('link', { name: new RegExp(searchBName) })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(searchAName) })).toHaveCount(0)
  await page.unroute('**/api/v1/public/search**')

  let signalStaleSearchStarted!: () => void
  let releaseStaleSearch!: () => void
  const staleSearchStarted = new Promise<void>(resolve => signalStaleSearchStarted = resolve)
  const staleSearchGate = new Promise<void>(resolve => releaseStaleSearch = resolve)
  await page.route('**/api/v1/public/search**', async (requestRoute) => {
    if (new URL(requestRoute.request().url()).searchParams.get('q') === searchAQuery) {
      signalStaleSearchStarted()
      await staleSearchGate
    }
    try {
      await requestRoute.continue()
    }
    catch {
      // The older search is intentionally allowed to finish after the current query.
    }
  })
  await page.getByRole('searchbox', { name: '搜索商品名称或描述' }).fill(searchAQuery)
  await staleSearchStarted
  await page.getByRole('searchbox', { name: '搜索商品名称或描述' }).fill(searchBQuery)
  await expect(page).toHaveURL(`/search?q=${encodeURIComponent(searchBQuery)}`)
  await expect(page.getByRole('link', { name: new RegExp(searchBName) })).toBeVisible()
  releaseStaleSearch()
  await expect(page.getByRole('link', { name: new RegExp(searchBName) })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(searchAName) })).toHaveCount(0)
  await page.unroute('**/api/v1/public/search**')
})

test('search URL identity restores real filters, ordering, pagination, history, and failure state', async ({ page }) => {
  test.setTimeout(180_000)
  const fixtureToken = randomUUID().slice(0, 8)
  const searchTerm = `R2分页商品-${fixtureToken}`
  const categoryName = `R2搜索筛选分类-${fixtureToken}`
  const productName = (number: string) => `${searchTerm}-${number}`
  const physicalName = `R2实物-${fixtureToken}-分类匹配商品`
  await page.goto('/')
  await authenticate(page)
  const category = await createCategory(page, categoryName)

  const products: ProductRecord[] = []
  for (let index = 1; index <= 24; index++) {
    const number = String(index).padStart(2, '0')
    let product = await createProduct(page, productName(number), `${searchTerm}描述${number}`, `${index}.00`)
    product = await setLifecycle(page, product, 'active')
    products.push(product)
  }
  const physical = await createProduct(page, physicalName, `${searchTerm}分类筛选样本`, '30.00', 'physical')
  await setLifecycle(page, await assignProductCategory(page, physical, category.id), 'active')

  const searchPath = `/search?q=${encodeURIComponent(searchTerm)}&sort=price_asc`
  const initialResponse = await page.goto(searchPath)
  expect(initialResponse?.status()).toBe(200)
  await expect(page.getByText('找到 25 件商品')).toBeVisible()
  const productLinks = page.locator('ul.grid > li')
  await expect(productLinks.first()).toContainText(productName('01'))
  await expect(productLinks.last()).toContainText(productName('24'))
  await expect(page.locator('ul.grid > li').first()).toContainText('¥1.00')
  await expect(page.locator('ul.grid > li')).toHaveCount(24)
  await page.getByRole('link', { name: '下一页' }).click()
  await expect(page).toHaveURL(/page=2/u)
  await expect(page.locator('ul.grid > li').first()).toContainText(physicalName)
  await expect(page.locator('ul.grid > li')).toHaveCount(1)
  await page.goBack()
  await expect(page).toHaveURL(/sort=price_asc/u)
  await expect(page.locator('ul.grid > li').first()).toContainText(productName('01'))
  await page.goForward()
  await expect(page).toHaveURL(/page=2/u)
  await expect(page.locator('ul.grid > li').first()).toContainText(physicalName)
  await page.goBack()
  await expect(page.locator('ul.grid > li').first()).toContainText(productName('01'))
  await page.reload()
  await expect(page.locator('ul.grid > li').first()).toContainText(productName('01'))

  await page.getByRole('combobox', { name: '商品排序' }).click()
  await page.getByRole('option', { name: '价格从高到低' }).click()
  await expect(page).toHaveURL(/sort=price_desc/u)
  await expect(page.locator('ul.grid > li').first()).toContainText(physicalName)
  await expect(page.locator('ul.grid > li').first()).toContainText('¥30.00')

  await page.getByRole('combobox', { name: '按分类筛选' }).click()
  await page.getByRole('option', { name: categoryName }).click()
  await expect(page).toHaveURL(new RegExp(`categoryId=${category.id}`, 'u'))
  await expect(page.getByRole('link', { name: new RegExp(physicalName) })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(searchTerm) })).toHaveCount(0)
  await page.getByRole('combobox', { name: '按商品性质筛选' }).click()
  await page.getByRole('option', { name: '实物商品' }).click()
  await expect(page).toHaveURL(/productType=physical/u)
  await expect(page.getByRole('link', { name: new RegExp(physicalName) })).toBeVisible()
  await expect(page.getByText('找到 1 件商品')).toBeVisible()

  await page.getByRole('combobox', { name: '商品排序' }).click()
  await page.getByRole('option', { name: '最新商品' }).click()
  await expect(page).toHaveURL(/sort=newest/u)
  await expect(page.locator('ul.grid > li').first()).toContainText(physicalName)

  await page.route('**/api/v1/public/search**', async (requestRoute) => {
    if (new URL(requestRoute.request().url()).searchParams.get('sort') === 'default') {
      await requestRoute.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'PRIVATE_SEARCH_STACK' } }) })
      return
    }
    await requestRoute.continue()
  })
  await page.getByRole('combobox', { name: '商品排序' }).click()
  await page.getByRole('option', { name: '默认排序' }).click()
  await expect(page.getByText('搜索暂时失败')).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(physicalName) })).toHaveCount(0)
  await expect(page.getByText('PRIVATE_SEARCH_STACK')).toHaveCount(0)
  await page.unroute('**/api/v1/public/search**')
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByRole('link', { name: new RegExp(physicalName) })).toBeVisible()
})
