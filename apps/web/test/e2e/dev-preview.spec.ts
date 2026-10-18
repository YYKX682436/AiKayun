import { expect, test } from '@playwright/test'
import { wcagContrast } from 'culori'

test('development design preview composes existing components without business actions', async ({ page }) => {
  const response = await page.goto('/dev-preview')
  expect(response?.status()).toBe(200)
  await expect(page).toHaveTitle('设计系统预览 · AiKayun 数字商城')
  await expect(page.getByRole('heading', { name: '品牌与语义颜色' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '按钮与输入框' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '空状态样例' })).toBeVisible()
  await expect(page.getByRole('button', { name: '提交中' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '不可用' })).toBeDisabled()
  await expect(page.getByRole('link', { name: /购买|加入购物车/ })).toHaveCount(0)
})

test('semantic status text keeps WCAG AA contrast in both themes', async ({ page }) => {
  await page.goto('/dev-preview')

  for (const mode of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      document.documentElement.classList.remove('light', 'dark')
      document.documentElement.classList.add(value)
    }, mode)
    await page.waitForFunction(() => !document.getAnimations().some(
      animation => animation instanceof CSSTransition && animation.playState === 'running',
    ))

    const samples = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext('2d')!
      const bodyColor = getComputedStyle(document.body).backgroundColor

      function renderedBackground(element: HTMLElement): string {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = bodyColor
        context.fillRect(0, 0, 1, 1)
        const ancestors: HTMLElement[] = []
        for (let current: HTMLElement | null = element; current && current !== document.body; current = current.parentElement) {
          ancestors.push(current)
        }
        for (const ancestor of ancestors.reverse()) {
          const background = getComputedStyle(ancestor).backgroundColor
          if (background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') {
            context.fillStyle = background
            context.fillRect(0, 0, 1, 1)
          }
        }
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
        return `rgb(${red} ${green} ${blue})`
      }

      return [...document.querySelectorAll<HTMLElement>(
        '#preview-main .text-success, #preview-main .text-warning, #preview-main .text-error, #preview-main .text-info',
      )].map(element => ({
        label: element.textContent?.trim() ?? '',
        foreground: getComputedStyle(element).color,
        background: renderedBackground(element),
      }))
    })

    expect(samples.length).toBeGreaterThanOrEqual(4)
    for (const sample of samples) {
      expect(
        wcagContrast(sample.foreground, sample.background),
        `${mode} ${sample.label}: ${sample.foreground} on ${sample.background}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  }
})
