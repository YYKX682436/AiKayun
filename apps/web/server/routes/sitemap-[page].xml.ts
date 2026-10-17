import type { ApiSuccess, PublicSitemapResponse } from '@aikayun/contracts'
import { resolvePublicOrigin } from '../../utils/public-site-url'

function xmlEscape(value: string): string {
  return value.replace(/[<>&"']/gu, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character] ?? character)
}

export default defineEventHandler(async (event) => {
  const page = Number(getRouterParam(event, 'page'))
  if (!Number.isInteger(page) || page < 1 || page > 100_000) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const config = useRuntimeConfig(event)
  const apiUrl = String(config.apiInternalUrl).replace(/\/$/u, '')
  const origin = resolvePublicOrigin(config.public.siteUrl)
  const response = await $fetch<ApiSuccess<PublicSitemapResponse>>(`${apiUrl}/api/v1/public/sitemap`, {
    query: { page, pageSize: 50_000 },
  })
  const entries = response.data.items.map((item) => {
    const path = item.type === 'product' ? `/products/${encodeURIComponent(item.id)}` : `/categories/${encodeURIComponent(item.id)}`
    const loc = xmlEscape(new URL(path, `${origin}/`).toString())
    const lastModified = xmlEscape(new Date(item.lastModified).toISOString())
    return `<url><loc>${loc}</loc><lastmod>${lastModified}</lastmod></url>`
  }).join('')
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`
})
