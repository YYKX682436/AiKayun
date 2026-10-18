import { expect, type Page } from '@playwright/test'

const browserErrors = new WeakMap<Page, string[]>()

export function captureBrowserDiagnostics(page: Page): void {
  const errors: string[] = []
  browserErrors.set(page, errors)

  page.on('pageerror', error => errors.push(`pageerror: ${error.stack ?? error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' || /hydration/i.test(message.text())) {
      errors.push(`console.${message.type()}: ${message.text()}`)
    }
  })
  page.on('requestfailed', (request) => {
    if (request.resourceType() === 'script' || request.resourceType() === 'document') {
      errors.push(`requestfailed ${request.resourceType()}: ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`)
    }
  })
  page.on('response', (response) => {
    const resourceType = response.request().resourceType()
    if (response.status() >= 400 && (resourceType === 'script' || resourceType === 'document')) {
      errors.push(`http ${response.status()} ${resourceType}: ${response.url()}`)
    }
  })
}

export async function expectClientMounted(page: Page, selector: string): Promise<void> {
  try {
    await expect(page.locator(selector)).toBeAttached()
  }
  catch (error) {
    const runtime = await page.evaluate((selector) => {
      const nuxt = (window as typeof window & { __NUXT__?: { isHydrating?: boolean } }).__NUXT__
      return {
        url: window.location.href,
        readyState: document.readyState,
        title: document.title,
        bodyText: document.body.innerText.slice(0, 1500),
        marker: document.querySelector(selector)?.getAttribute(selector.match(/data-[\w-]+/)?.[0] ?? '') ?? null,
        nuxtHydrating: nuxt?.isHydrating ?? null,
        nuxtKeys: Object.keys(nuxt ?? {}),
        scripts: Array.from(document.scripts).map(script => ({ type: script.type, src: script.src || null })),
        appRoot: document.querySelector('#__nuxt')?.outerHTML.slice(0, 2500) ?? null,
        loadedAssets: performance.getEntriesByType('resource')
          .filter(entry => /\/_nuxt\/|\.(?:js|css)(?:\?|$)/.test(entry.name))
          .slice(-30)
          .map(entry => ({ name: entry.name, duration: Math.round(entry.duration), transferSize: (entry as PerformanceResourceTiming).transferSize })),
      }
    }, selector).catch(runtimeError => ({ runtimeError: String(runtimeError) }))
    console.error('[e2e client mount diagnostic]', JSON.stringify({
      selector,
      browserErrors: browserErrors.get(page) ?? [],
      runtime,
    }))
    throw error
  }
}
