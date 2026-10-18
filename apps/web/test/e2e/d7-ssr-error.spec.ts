import { expect, test, type APIResponse, type Page } from '@playwright/test'

const categoryId = '550e8400-e29b-41d4-a716-446655440001'
const productId = '550e8400-e29b-41d4-a716-446655440000'
const hiddenCategoryId = '550e8400-e29b-41d4-a716-446655440002'
const apiOrigin = 'http://127.0.0.1:3111'

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
