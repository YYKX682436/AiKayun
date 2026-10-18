import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

type ProductRecord = {
  id: string
  name: string
  revision: number
  status: 'draft' | 'active' | 'paused' | 'archived'
  variants: Array<{ id: string; revision: number; salePrice: string; options: Array<{ groupName: string; valueName: string }> }>
}

async function dataOf<T>(response: Awaited<ReturnType<APIRequestContext['get']>>, status: number): Promise<T> {
  expect(response.status()).toBe(status)
  const body = await response.json() as { data: T; error?: { message?: string } }
  if (status >= 400) throw new Error(body.error?.message ?? `Expected API status ${status}`)
  return body.data
}

async function authenticate(page: Page): Promise<void> {
  const csrfResponse = await page.request.get('/api/v1/admin/auth/csrf')
  expect(csrfResponse.status()).toBe(200)
  const csrf = (await csrfResponse.json()).data.csrfToken as string
  const login = await page.request.post('/api/v1/admin/auth/login', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf },
    data: { email: 'browser-test@example.com', password: 'Only-For-E2E-Tests-2026!!' },
  })
  expect(login.status()).toBe(200)
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

async function createProduct(page: Page, name: string, description: string): Promise<ProductRecord> {
  const response = await page.request.post('/api/v1/admin/products', {
    headers: { 'x-csrf-token': await csrfToken(page), origin: new URL(page.url()).origin },
    data: { name, description, productType: 'digital', defaultSku: { salePrice: '19.90' } },
  })
  return dataOf<ProductRecord>(response, 201)
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

async function expectTemporaryHomeRedirect(page: Page, product: ProductRecord): Promise<void> {
  const response = await page.request.get(`/products/${product.id}`, { maxRedirects: 0 })
  expect(response.status()).toBe(302)
  expect(response.headers().location).toBe('/')
  expect(await response.text()).not.toContain(product.name)
}

test('D7 serves a real SSR catalog, visible category path, safe media details, sparse SKU selection, and responsive search', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-storefront-ready="true"]')).toBeAttached()
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
  expect(sitemapXml).toContain('http://127.0.0.1:3100')
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

  const detailRequest = await page.request.get(`/products/${product.id}`)
  expect(detailRequest.status()).toBe(200)
  expect(detailRequest.headers()['cache-control']).toBe('no-store')
  const detailHtml = await detailRequest.text()
  expect(detailHtml).toContain('<title>D7真实中文商品')
  expect(detailHtml).toContain('name="description"')
  expect(detailHtml).toContain('rel="canonical"')
  expect(detailHtml).toContain(`href="http://127.0.0.1:3100/products/${product.id}"`)
  expect(detailHtml).toContain('property="og:image"')
  expect(detailHtml).toContain('D7安全详情')
  expect(detailHtml).toContain('真实结构化商品说明')
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
  await expect(page.locator('[data-storefront-ready="true"]')).toBeAttached()
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
  await expect(page.locator('[data-storefront-ready="true"]')).toBeAttached()
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
