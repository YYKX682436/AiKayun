import { expect, test } from '@playwright/test'
import { wcagContrast } from 'culori'
import { createStorefrontThemeStyle, defaultStoreBrand, normalizeHex, resolveStoreBrand } from '../../utils/store-brand'
import { addBrandContrastProbe } from './brand-probe'

test('the AiKayun deployment uses the default storefront name and brand blue', async ({ page }) => {
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || /hydration/i.test(message.text())) browserErrors.push(message.text())
  })

  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  expect(await response?.text()).toContain('<title>全部商品 · AiKayun 数字商城</title>')
  await expect(page).toHaveTitle('全部商品 · AiKayun 数字商城')
  await expect(page.getByRole('link', { name: /AiKayun 数字商城/ }).first()).toBeVisible()
  await expect(page.locator('header img')).toHaveCount(0)

  const brand = await page.evaluate(() => ({
    area: document.documentElement.dataset.aikayunArea,
    color: getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-600').trim(),
  }))
  expect(brand.area).toBe('storefront')
  expect(brand.color).toMatch(/^#[\da-f]{6}$/i)

  await page.getByRole('banner').getByRole('link', { name: '管理入口', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/login$/)
  await expect(page).toHaveTitle('管理员登录 · AiKayun')
  await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'admin')

  await page.getByRole('link', { name: 'AiKayun' }).click()
  await expect(page).toHaveTitle('全部商品 · AiKayun 数字商城')
  await expect(page.locator('html')).toHaveAttribute('data-aikayun-area', 'storefront')
  expect(browserErrors).toEqual([])
})

test('generated brand colors keep storefront text, status labels and keyboard focus contrast in both modes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || /hydration/i.test(message.text())) errors.push(message.text())
  })

  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await addBrandContrastProbe(page)

  const brandSamples = [
    ['default blue', '#2563EB'],
    ['purple', '#7C3AED'],
    ['gray', '#808080'],
    ['yellow', '#FFEB00'],
    ['green', '#16A34A'],
    ['near white', '#FDFDFD'],
    ['near black', '#080808'],
  ] as const
  const textContrasts: number[] = []
  const focusContrasts: number[] = []

  for (const [name, color] of brandSamples) {
    const declarations = createStorefrontThemeStyle(color)
      .split(';')
      .filter(Boolean)
      .map(value => value.split(':', 2) as [string, string])

    await page.evaluate((variables) => {
      for (const [name, value] of variables) document.documentElement.style.setProperty(name, value)
    }, declarations)

    for (const mode of ['light', 'dark'] as const) {
      const modeButton = page.getByRole('button', { name: '显示模式' })
      await expect(modeButton).toBeEnabled()
      await modeButton.click()
      await page.getByRole('option', { name: mode === 'light' ? '浅色' : '深色' }).click()
      await expect(page.locator('html')).toHaveClass(new RegExp(mode))
      await page.keyboard.press('Tab')

      const measurements = await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const context = canvas.getContext('2d')!

        function composite(background: string, surface: string): string {
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = surface
          context.fillRect(0, 0, 1, 1)
          context.fillStyle = background
          context.fillRect(0, 0, 1, 1)
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
          return `rgb(${red} ${green} ${blue})`
        }

        const pageSurface = document.querySelector<HTMLElement>('.bg-default')!
        const heroText = document.querySelector<HTMLElement>('#brand-color-text-probe')!
        const badge = document.querySelector<HTMLElement>('#brand-color-badge-probe')!
        const badgeText = getComputedStyle(badge).color
        const badgeBackground = composite(getComputedStyle(badge).backgroundColor, getComputedStyle(pageSurface).backgroundColor)
        const focusControl = document.querySelector<HTMLElement>('[aria-label="显示模式"]')!

        document.documentElement.focus()
        focusControl.focus()
        const focusStyle = getComputedStyle(focusControl)

        return {
          hero: { foreground: getComputedStyle(heroText).color, background: getComputedStyle(pageSurface).backgroundColor },
          badge: { foreground: badgeText, background: badgeBackground },
          focus: {
            visible: focusControl.matches(':focus-visible'),
            width: focusStyle.outlineWidth,
            style: focusStyle.outlineStyle,
            foreground: focusStyle.outlineColor,
            background: getComputedStyle(pageSurface).backgroundColor,
          },
        }
      })

      const contrast = (foreground: string, background: string) => wcagContrast(foreground, background)
      const textRatios = [
        contrast(measurements.hero.foreground, measurements.hero.background),
        contrast(measurements.badge.foreground, measurements.badge.background),
      ]
      textContrasts.push(...textRatios)
      const focusRatio = contrast(measurements.focus.foreground, measurements.focus.background)
      focusContrasts.push(focusRatio)
      expect(textRatios[0], `${name} ${mode} hero brand text`).toBeGreaterThanOrEqual(4.5)
      expect(textRatios[1], `${name} ${mode} tinted brand label`).toBeGreaterThanOrEqual(4.5)
      expect(measurements.focus.visible, `${name} ${mode} keyboard focus is visible`).toBe(true)
      expect(measurements.focus.width).toBe('2px')
      expect(measurements.focus.style).toBe('solid')
      expect(focusRatio, `${name} ${mode} focus outline`).toBeGreaterThanOrEqual(3)
    }
  }

  console.info(`Browser contrast minima across ${brandSamples.length} colors × 2 modes: text ${Math.min(...textContrasts).toFixed(2)}:1, focus ${Math.min(...focusContrasts).toFixed(2)}:1`)
  expect(errors).toEqual([])
})

test('valid HEX inputs normalize and invalid public brand config safely falls back', () => {
  expect(normalizeHex('#abc')).toBe('#AABBCC')
  expect(normalizeHex('rgb(255 0 0)')).toBeUndefined()
  expect(normalizeHex('red; background: url(javascript:alert(1))')).toBeUndefined()

  const brand = resolveStoreBrand({
    storeName: '  ',
    storeLogoUrl: 'javascript:alert(1)',
    storeBrandColor: 'red; --ui-primary: url(javascript:alert(1))',
  })
  expect(brand).toEqual(defaultStoreBrand)

  const style = createStorefrontThemeStyle(brand.storeBrandColor)
  expect(style).toMatch(/--ui-color-primary-600:#[\da-f]{6}/i)
  expect(style).not.toMatch(/javascript|url\(|red;/i)
  expect(style.split(';')).toHaveLength(11)
})
