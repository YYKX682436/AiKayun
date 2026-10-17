import { expect, test } from '@playwright/test'

test('an SSR public API 500 stays on the product route and renders only a retryable error', async ({ page }) => {
  const productId = '550e8400-e29b-41d4-a716-446655440000'
  const response = await page.goto(`/products/${productId}`)

  expect(response?.status()).toBe(502)
  expect(response?.headers().location).toBeUndefined()
  await expect(page).toHaveURL(`/products/${productId}`)
  await expect(page.getByText('商品暂时无法加载')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()

  const html = await response!.text()
  expect(html).not.toContain('private database stack marker')
  expect(html).not.toContain('D7_PRIVATE_DATABASE_STACK_TRACE')
})
