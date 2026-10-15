import { expect, test, type Page } from '@playwright/test'
import { wcagContrast, wcagLuminance } from 'culori'

const preferenceKey = 'aikayun-color-mode'

function watchBrowserErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || /hydration|mismatch/i.test(message.text())) {
      errors.push(message.text())
    }
  })
  return errors
}

async function selectPreference(page: Page, label: string) {
  await page.getByRole('button', { name: '显示模式' }).click()
  await page.getByRole('option', { name: label }).click()
  const preference = label === '浅色' ? 'light' : label === '深色' ? 'dark' : 'system'
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBe(preference)
  await expect(page.getByRole('option', { name: label })).toBeHidden()
}

async function readTheme(page: Page) {
  return page.evaluate((key) => {
    const root = document.documentElement
    const heading = [...document.querySelectorAll('h1 span')]
      .find(element => element.classList.contains('text-primary'))
    const primaryButton = [...document.querySelectorAll('a[href="/admin/login"]')]
      .find((element) => getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)')
    const buttonStyle = primaryButton ? getComputedStyle(primaryButton) : undefined

    return {
      area: root.dataset.aikayunArea,
      preference: localStorage.getItem(key),
      value: root.classList.contains('dark') ? 'dark' : root.classList.contains('light') ? 'light' : 'unknown',
      colorScheme: getComputedStyle(root).colorScheme,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      textColor: getComputedStyle(document.body).color,
      primaryShade600: getComputedStyle(root).getPropertyValue('--ui-color-primary-600').trim(),
      primaryShade400: getComputedStyle(root).getPropertyValue('--ui-color-primary-400').trim(),
      brandTextColor: heading ? getComputedStyle(heading).color : null,
      buttonBackground: buttonStyle?.backgroundColor ?? null,
      buttonText: buttonStyle?.color ?? null,
      modeControlHeight: document.querySelector<HTMLElement>('[aria-label="显示模式"]')?.getBoundingClientRect().height ?? 0,
      width: window.innerWidth,
      documentWidth: root.scrollWidth,
    }
  }, preferenceKey)
}

async function assertThemeValue(page: Page, expected: 'light' | 'dark') {
  await expect.poll(async () => (await readTheme(page)).value).toBe(expected)
  const theme = await readTheme(page)
  expect(theme.colorScheme).toBe(expected)
  const backgroundLuminance = wcagLuminance(theme.backgroundColor)
  expect(expected === 'dark' ? backgroundLuminance : 1 - backgroundLuminance).toBeLessThan(0.06)
  expect(wcagContrast(theme.textColor, theme.backgroundColor)).toBeGreaterThanOrEqual(4.5)
  expect(theme.area).toBe('storefront')
  expect(theme.buttonBackground).not.toBeNull()
  expect(theme.buttonText).not.toBeNull()
  expect(wcagContrast(theme.buttonBackground!, theme.buttonText!)).toBeGreaterThanOrEqual(4.5)
  expect(wcagContrast(theme.brandTextColor!, theme.backgroundColor)).toBeGreaterThanOrEqual(4.5)
  return theme
}

test('a first visit follows a light system preference and hydrates without errors', async ({ page }) => {
  const errors = watchBrowserErrors(page)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript((key) => {
    localStorage.removeItem(key)
    localStorage.removeItem('nuxt-color-mode')
    localStorage.removeItem('aikayun-color-mode-r1')
  }, preferenceKey)

  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  const serverHtml = await response?.text()
  expect(serverHtml).toContain('data-aikayun-area="storefront"')
  expect(serverHtml).toMatch(/--ui-color-primary-600:#[\da-f]{6}/i)
  const headEnd = serverHtml?.indexOf('</head>') ?? -1
  const colorModeBootstrap = serverHtml?.indexOf('__NUXT_COLOR_MODE__') ?? -1
  expect(colorModeBootstrap).toBeGreaterThanOrEqual(0)
  expect(colorModeBootstrap).toBeLessThan(headEnd)
  await expect(page.getByRole('heading', { name: /让数字商品/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '显示模式' })).toContainText('跟随系统')
  await assertThemeValue(page, 'light')
  expect(errors).toEqual([])
})

test('a first visit follows a dark system preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript((key) => {
    localStorage.removeItem(key)
    localStorage.removeItem('nuxt-color-mode')
    localStorage.removeItem('aikayun-color-mode-r1')
  }, preferenceKey)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /让数字商品/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '显示模式' })).toContainText('跟随系统')
  await assertThemeValue(page, 'dark')
})

test('manual light and dark preferences override the system setting', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await selectPreference(page, '深色')
  await assertThemeValue(page, 'dark')

  await page.emulateMedia({ colorScheme: 'light' })
  await assertThemeValue(page, 'dark')
  await selectPreference(page, '浅色')
  await assertThemeValue(page, 'light')

  await page.emulateMedia({ colorScheme: 'dark' })
  await assertThemeValue(page, 'light')
})

test('following the system updates when the operating-system preference changes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await selectPreference(page, '深色')
  await assertThemeValue(page, 'dark')
  await selectPreference(page, '跟随系统')
  await assertThemeValue(page, 'light')

  await page.emulateMedia({ colorScheme: 'dark' })
  await assertThemeValue(page, 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await assertThemeValue(page, 'light')
})

test('a stored preference survives reload and opening another page', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await selectPreference(page, '深色')
  await assertThemeValue(page, 'dark')

  await page.reload()
  await assertThemeValue(page, 'dark')
  const reopenedPage = await page.context().newPage()
  await reopenedPage.emulateMedia({ colorScheme: 'light' })
  await reopenedPage.goto('/')
  await assertThemeValue(reopenedPage, 'dark')
  await reopenedPage.close()
})

test('unsupported values in the two historical storage keys do not affect initialization', async ({ page }) => {
  const errors = watchBrowserErrors(page)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => {
    localStorage.setItem('nuxt-color-mode', 'sepia')
    localStorage.setItem('aikayun-color-mode-r1', 'not-a-mode')
    localStorage.removeItem('aikayun-color-mode')
  })
  await page.goto('/')
  await assertThemeValue(page, 'dark')
  expect(errors).toEqual([])
  expect(await page.evaluate(() => localStorage.getItem('nuxt-color-mode'))).toBe('sepia')
  expect(await page.evaluate(() => localStorage.getItem('aikayun-color-mode-r1'))).toBe('not-a-mode')
})

test('the mode picker is keyboard reachable and remains usable at target widths', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const picker = page.getByRole('button', { name: '显示模式' })
  await expect(picker).toBeEnabled()
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(picker).toBeFocused()
  await expect.poll(() => picker.evaluate(element => element.matches(':focus-visible'))).toBe(true)
  await expect.poll(() => picker.evaluate((element) => {
    const styles = getComputedStyle(element)
    return styles.outlineWidth !== '0px' || styles.boxShadow !== 'none'
  })).toBe(true)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('option', { name: '深色' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('option', { name: '深色' })).toBeHidden()

  for (const mode of ['浅色', '深色'] as const) {
    await selectPreference(page, mode)
    const expectedMode = mode === '浅色' ? 'light' : 'dark'
    await assertThemeValue(page, expectedMode)

    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const theme = await readTheme(page)
      expect(theme.width).toBe(width)
      expect(theme.documentWidth).toBeLessThanOrEqual(width)
      expect(theme.modeControlHeight).toBeGreaterThanOrEqual(44)
      expect(wcagContrast(theme.buttonBackground!, theme.buttonText!)).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({
        path: testInfo.outputPath(`${expectedMode}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      })
    }
  }
})

test('front and admin routes share the display preference and apply separate root themes', async ({ page }) => {
  await page.goto('/')
  await selectPreference(page, '深色')
  const storefront = await assertThemeValue(page, 'dark')

  await page.goto('/admin/login')
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible()
  await expect.poll(async () => page.locator('html').getAttribute('data-aikayun-area')).toBe('admin')
  const admin = await readTheme(page)
  expect(admin.preference).toBe('dark')
  expect(admin.value).toBe('dark')
  expect(admin.primaryShade600.toLowerCase()).toBe('#2563eb')
  expect(admin.primaryShade600.toLowerCase()).not.toBe(storefront.primaryShade600.toLowerCase())
  expect(admin.buttonBackground).not.toBe(storefront.buttonBackground)
})
