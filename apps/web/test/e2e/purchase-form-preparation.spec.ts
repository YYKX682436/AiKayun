import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createBrowserAdminSession } from './browser-admin-session'
import { expectClientMounted } from './browser-diagnostics'

type Product = { id: string; revision: number; variants: Array<{ id: string }> }

async function attachAdmin(page: Page): Promise<void> {
  const token = createBrowserAdminSession()
  await page.context().addCookies([{
    name: 'aikayun_admin_session',
    value: token,
    url: new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100').origin,
    httpOnly: true,
    sameSite: 'Lax',
  }])
  const session = await page.request.get('/api/v1/admin/session')
  expect(session.status(), await session.text()).toBe(200)
  await page.goto('/admin/login')
}

async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get('/api/v1/admin/auth/csrf')
  expect(response.status()).toBe(200)
  return (await response.json()).data.csrfToken as string
}

async function adminHeaders(page: Page) {
  return { origin: new URL(page.url()).origin, 'x-csrf-token': await csrfToken(page) }
}

async function noHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }))
  expect(dimensions.page, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewport)
}

test('edits, freezes, previews, and prepares product/SKU references without exposing customer inputs', async ({ page }) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(10_000)
  await attachAdmin(page)
  await page.goto('/admin/purchase-form-templates')
  await expect(page.locator('#admin-main').getByRole('heading', { name: '购买填写模板', exact: true })).toBeVisible()
  await expect(page.locator('#admin-main')).toHaveAttribute('data-purchase-templates-ready', 'true')
  await expect(page.getByText('准备配置，尚未应用到顾客购买。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建模板' }).click()
  await expect(page).toHaveURL(/\/admin\/purchase-form-templates\/[0-9a-f-]+$/u)
  await expect(page.getByRole('heading', { name: /新购买填写模板/u })).toBeVisible()
  await page.getByLabel('模板名称').fill('E2E 本地账号填写模板')

  const fields = page.getByRole('region', { name: '字段定义' })
  const fieldType = fields.getByRole('combobox').first()
  await fieldType.click()
  await page.getByRole('option', { name: '数字字符' }).click()
  await fields.getByRole('button', { name: '添加字段' }).click()
  await fields.getByLabel('字段 1名称').fill('账号编号')
  await fields.getByRole('checkbox', { name: '必填' }).first().check()

  await fieldType.click()
  await page.getByRole('option', { name: '级联选择' }).click()
  await fields.getByRole('button', { name: '添加字段' }).click()
  await fields.getByLabel('级联字段 2 名称').fill('区服')
  await fields.getByRole('checkbox', { name: '必填' }).last().check()
  await fields.getByRole('button', { name: '添加下一层' }).click()
  await fields.getByLabel('第 2 层选项名称').fill('东区')
  await fields.getByRole('button', { name: '添加所选分支字段' }).last().click()

  await fieldType.click()
  await page.getByRole('option', { name: '私有图片' }).click()
  await fields.getByRole('button', { name: '添加字段' }).click()
  await fields.getByLabel('字段 3名称').fill('图片证据')

  await page.getByRole('button', { name: '检查填写完整性' }).click()
  await expect(page.getByText(/还有 \d+ 项需要检查/u)).toBeVisible()
  await expect(page.getByText('此项尚未填写。').first()).toBeVisible()
  await page.getByLabel('账号编号').fill('000012345678901234567890')
  await page.getByLabel('区服第 1 层').click()
  await page.getByRole('option', { name: '一级选项' }).click()
  await page.getByLabel('区服第 2 层').click()
  await page.getByRole('option', { name: '东区' }).click()
  await page.getByLabel('扩展字段').fill('Player-A')
  await expect(page.getByLabel('图片证据图片上传预览（未启用）')).toBeDisabled()
  await expect(page.getByRole('button', { name: '检查填写完整性' })).toBeVisible()
  await page.getByRole('button', { name: '检查填写完整性' }).click()
  await expect(page.getByText('填写完整，当前仅为后台预览。')).toBeVisible()

  for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '保存编辑草稿' }).click()
  await expect(page.getByRole('status')).toContainText('编辑草稿已保存')
  await page.getByRole('button', { name: '保存为准备配置版本' }).click()
  await expect(page.getByText('不可变准备版本已保存；顾客购买填写仍未启用。')).toBeVisible()
  await expect(page.getByText(/E2E 本地账号填写模板 · v1/u).first()).toBeVisible()
  await page.getByRole('button', { name: /E2E 本地账号填写模板 · v1/u }).click()
  await expect(page.getByRole('heading', { name: '历史版本交互预览' })).toBeVisible()

  const created = await page.request.post('/api/v1/admin/products', {
    headers: await adminHeaders(page),
    data: {
      name: `填写准备关联商品-${randomUUID().slice(0, 8)}`,
      description: 'E2E preparation association fixture',
      productType: 'digital',
      defaultSku: { salePrice: '5.00' },
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  const product = (await created.json()).data as Product
  await page.goto(`/admin/products/${product.id}`)
  await expectClientMounted(page, '#purchase-form-preparation')
  const assignment = page.locator('#purchase-form-preparation')
  await expect(assignment).toHaveAttribute('data-assignment-ready', 'true')
  await expect(assignment.getByText('准备配置，尚未应用', { exact: true })).toBeVisible()
  await assignment.getByRole('combobox', { name: '关联方式' }).click()
  await page.getByRole('option', { name: '关联模板版本（准备）' }).click()
  await assignment.getByRole('combobox', { name: '本地模板' }).click()
  await page.getByRole('option', { name: /E2E 本地账号填写模板/u }).click()
  await assignment.getByRole('combobox', { name: '冻结版本' }).click()
  await page.getByRole('option', { name: 'v1 · E2E 本地账号填写模板' }).click()
  await assignment.getByRole('button', { name: '保存商品准备关联' }).click()
  await expect(assignment.getByRole('status')).toContainText('尚未应用到顾客购买')
  await assignment.getByRole('combobox', { name: '覆盖方式' }).click()
  await page.getByRole('option', { name: '明确不使用模板' }).click()
  await assignment.getByRole('button', { name: /保存 SKU 准备覆盖/u }).click()
  await expect(assignment.getByRole('status')).toContainText('尚未应用到顾客购买')
  await expect(page.getByText('顾客填写、图片上传、购物车或结算入口。')).toBeVisible()
  for (const width of [320, 390, 768, 1440]) await noHorizontalOverflow(page, width)
})
