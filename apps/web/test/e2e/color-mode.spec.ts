import { expect, test } from '@playwright/test'

const systemPreferences = [
  { scheme: 'light', storedPreference: 'dark' },
  { scheme: 'dark', storedPreference: 'system' },
] as const

for (const { scheme, storedPreference } of systemPreferences) {
  test(`keeps the storefront light with ${scheme} system preference and a legacy ${storedPreference} setting`, async ({ page }) => {
    const browserErrors: string[] = []
    page.on('pageerror', error => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' || /hydration|mismatch/i.test(message.text())) {
        browserErrors.push(message.text())
      }
    })

    await page.emulateMedia({ colorScheme: scheme })
    await page.addInitScript((value) => {
      localStorage.setItem('nuxt-color-mode', value)
    }, storedPreference)

    const response = await page.goto('/')
    expect(response?.status()).toBe(200)
    expect(await response?.text()).toContain('让数字商品')
    await expect(page.getByRole('heading', { name: /让数字商品/ })).toBeVisible()

    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))

    const theme = await page.evaluate(() => {
      const root = document.documentElement
      const body = getComputedStyle(document.body)
      const heading = document.querySelector('h1')
      const colorMode = Reflect.get(window, '__NUXT_COLOR_MODE__') as { preference?: string, value?: string } | undefined

      return {
        hasLightClass: root.classList.contains('light'),
        hasDarkClass: root.classList.contains('dark'),
        preference: colorMode?.preference,
        value: colorMode?.value,
        colorScheme: getComputedStyle(root).colorScheme,
        backgroundColor: body.backgroundColor,
        bodyTextColor: body.color,
        headingTextColor: heading ? getComputedStyle(heading).color : null,
        legacyPreference: localStorage.getItem('nuxt-color-mode'),
      }
    })

    expect(theme).toEqual({
      hasLightClass: true,
      hasDarkClass: false,
      preference: 'light',
      value: 'light',
      colorScheme: 'light',
      backgroundColor: 'oklch(0.984 0.003 247.858)',
      bodyTextColor: 'oklch(0.372 0.044 257.287)',
      headingTextColor: 'oklch(0.129 0.042 264.695)',
      legacyPreference: storedPreference,
    })
    expect(browserErrors).toEqual([])
  })
}
