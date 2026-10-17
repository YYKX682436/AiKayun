import type { Page } from '@playwright/test'

/** Give brand contrast tests stable semantic-token samples without depending on page marketing content. */
export async function addBrandContrastProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById('brand-contrast-probe')) return

    const probe = document.createElement('div')
    probe.id = 'brand-contrast-probe'
    probe.style.position = 'fixed'
    probe.style.left = '-10000px'
    probe.style.top = '0'

    const text = document.createElement('span')
    text.id = 'brand-color-text-probe'
    text.className = 'text-primary'
    text.textContent = '品牌颜色对比度样本'

    const badge = document.createElement('span')
    badge.id = 'brand-color-badge-probe'
    badge.className = 'bg-primary/10 text-primary'
    badge.textContent = '品牌状态样本'

    probe.append(text, badge)
    document.body.append(probe)
  })
}
