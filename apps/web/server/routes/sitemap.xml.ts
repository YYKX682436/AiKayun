import type { ApiSuccess, PublicSitemapResponse } from '@aikayun/contracts'
import { resolvePublicOrigin } from '../../utils/public-site-url'

function xmlEscape(value: string): string {
  return value.replace(/[<>&"']/gu, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character] ?? character)
}

function sitemapUrl(origin: string, type: 'product' | 'category', id: string): string {
  const path = type === 'product' ? `/products/${encodeURIComponent(id)}` : `/categories/${encodeURIComponent(id)}`
  return xmlEscape(new URL(path, `${origin}/`).toString())
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const apiUrl = String(config.apiInternalUrl).replace(/\/$/u, '')
  const origin = resolvePublicOrigin(config.public.siteUrl)
  const response = await $fetch<ApiSuccess<PublicSitemapResponse>>(`${apiUrl}/api/v1/public/sitemap`, {
    query: { page: 1, pageSize: 50_000 },
  })

  if (response.data.totalPages > 1) {
    const entries = Array.from({ length: response.data.totalPages }, (_, index) => {
      const loc = xmlEscape(new URL(`/sitemap-${index + 1}.xml`, `${origin}/`).toString())
      return `<sitemap><loc>${loc}</loc></sitemap>`
    }).join('')
    setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
    setResponseHeader(event, 'cache-control', 'no-store')
    return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`
  }

  const entries = response.data.items.map(item => {
    const lastModified = xmlEscape(new Date(item.lastModified).toISOString())
    return `<url><loc>${sitemapUrl(origin, item.type, item.id)}</loc><lastmod>${lastModified}</lastmod></url>`
  }).join('')
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`
})
