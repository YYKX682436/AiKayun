import http from 'node:http'
import { expect, test } from '@playwright/test'

let mockServer: http.Server | null = null

test.beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url?.startsWith('/api/v1/admin/session')) {
      res.writeHead(200)
      res.end(JSON.stringify({ data: { id: 'admin-mock', email: 'admin@example.com' } }))
      return
    }
    if (req.url?.startsWith('/api/v1/admin/categories')) {
      res.writeHead(200)
      res.end(JSON.stringify({ data: { categories: [] } }))
      return
    }
    if (req.url?.startsWith('/api/v1/admin/products')) {
      res.writeHead(200)
      res.end(JSON.stringify({ data: { items: [], total: 0, totalPages: 0 } }))
      return
    }
    res.writeHead(200)
    res.end(JSON.stringify({ data: {} }))
  })

  await new Promise<void>((resolve) => {
    mockServer!.listen(3121, '127.0.0.1', resolve)
  })
})

test.afterAll(async () => {
  if (mockServer) {
    await new Promise<void>((resolve) => mockServer!.close(() => resolve()))
  }
})

test.describe('Modern Web专项验证', () => {
  test('admin/products/new 商品性质卡片键盘方向键移动焦点与状态', async ({ page }) => {
    await page.goto('/admin/products/new')
    await page.waitForSelector('[role="radiogroup"][aria-label="商品性质"]')

    const radiogroup = page.locator('[role="radiogroup"][aria-label="商品性质"]')
    const radios = radiogroup.locator('[role="radio"]')
    await expect(radios).toHaveCount(3)

    // 等待初始化恢复完成（按钮解除 disabled）
    await expect(radios.nth(0)).toBeEnabled()
    await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true')
    await radios.nth(0).focus()
    await expect(radios.nth(0)).toBeFocused()

    // 按下方向键 Right，焦点与状态同步移动到第 2 个 (physical)
    await page.keyboard.press('ArrowRight')
    await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'true')
    await expect(radios.nth(1)).toBeFocused()

    // 按下方向键 Down，移动到第 3 个 (service)
    await page.keyboard.press('ArrowDown')
    await expect(radios.nth(2)).toHaveAttribute('aria-checked', 'true')
    await expect(radios.nth(2)).toBeFocused()

    // 按下方向键 Right，循环回第 1 个 (digital)
    await page.keyboard.press('ArrowRight')
    await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true')
    await expect(radios.nth(0)).toBeFocused()

    // 按下 End 键，直接移动到最后 1 个
    await page.keyboard.press('End')
    await expect(radios.nth(2)).toHaveAttribute('aria-checked', 'true')
    await expect(radios.nth(2)).toBeFocused()

    // 按下 Home 键，直接移动到第 1 个
    await page.keyboard.press('Home')
    await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true')
    await expect(radios.nth(0)).toBeFocused()
  })

  test('admin/products 快捷状态标签在触屏宽度与桌面端尺寸适配', async ({ browser }) => {
    // 1. 模拟触屏平板设备 (iPad 768px, pointer: coarse, hasTouch: true)
    const touchContext = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      hasTouch: true,
    })
    const touchPage = await touchContext.newPage()
    await touchPage.goto('/admin/products')
    const quickNavTouch = touchPage.locator('nav[aria-label="快捷状态分类"]')
    await expect(quickNavTouch).toBeVisible()
    const firstTabTouch = quickNavTouch.locator('button').first()
    const touchBox = await firstTabTouch.boundingBox()
    expect(touchBox).not.toBeNull()
    // 触屏设备保证至少 44px 触控目标高度
    expect(touchBox!.height).toBeGreaterThanOrEqual(44)
    await touchContext.close()

    // 2. 模拟普通桌面端设备 (1280px, pointer: fine, hasTouch: false)
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      hasTouch: false,
    })
    const desktopPage = await desktopContext.newPage()
    await desktopPage.goto('/admin/products')
    const quickNavDesktop = desktopPage.locator('nav[aria-label="快捷状态分类"]')
    await expect(quickNavDesktop).toBeVisible()
    const firstTabDesktop = quickNavDesktop.locator('button').first()
    const desktopBox = await firstTabDesktop.boundingBox()
    expect(desktopBox).not.toBeNull()
    // 桌面端控件紧凑展示 (36px)
    expect(desktopBox!.height).toBeLessThanOrEqual(36.5)
    await desktopContext.close()
  })
})
