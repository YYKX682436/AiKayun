import { createServer } from 'node:http'

const categoryId = '550e8400-e29b-41d4-a716-446655440001'
const productId = '550e8400-e29b-41d4-a716-446655440000'
const hiddenCategoryId = '550e8400-e29b-41d4-a716-446655440002'
const brokenPaths = new Set()

const svgCloudServer = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><rect width="600" height="600" fill="#f8fafc"/><rect x="120" y="160" width="360" height="80" rx="16" fill="#eff6ff" stroke="#3b82f6" stroke-width="4"/><circle cx="170" cy="200" r="10" fill="#3b82f6"/><circle cx="210" cy="200" r="10" fill="#60a5fa"/><rect x="340" y="190" width="100" height="20" rx="6" fill="#bfdbfe"/><rect x="120" y="260" width="360" height="80" rx="16" fill="#eff6ff" stroke="#3b82f6" stroke-width="4"/><circle cx="170" cy="300" r="10" fill="#3b82f6"/><circle cx="210" cy="300" r="10" fill="#60a5fa"/><rect x="340" y="290" width="100" height="20" rx="6" fill="#bfdbfe"/><rect x="120" y="360" width="360" height="80" rx="16" fill="#eff6ff" stroke="#3b82f6" stroke-width="4"/><circle cx="170" cy="400" r="10" fill="#3b82f6"/><circle cx="210" cy="400" r="10" fill="#60a5fa"/><rect x="340" y="390" width="100" height="20" rx="6" fill="#bfdbfe"/></svg>')}`

const svgFidoKey = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><rect width="600" height="600" fill="#f8fafc"/><rect x="220" y="140" width="160" height="320" rx="32" fill="#1e293b"/><circle cx="300" cy="230" r="32" fill="#334155" stroke="#0ea5e9" stroke-width="6"/><rect x="250" y="370" width="100" height="40" rx="10" fill="#0ea5e9"/><rect x="270" y="110" width="60" height="40" rx="6" fill="#94a3b8"/></svg>')}`

const sampleProducts = [
  {
    id: productId,
    name: '云服务器轻量订阅月卡 (标准版)',
    description: '即时自动发货，支持全协议 API 密钥与一键配置',
    productType: 'digital',
    selectionStatus: 'available',
    inventoryStatus: 'in_stock',
    priceRange: { min: '29.90', max: '29.90', currency: 'CNY' },
    cover: { url: svgCloudServer, alt: '云服务器轻量订阅月卡', width: 600, height: 600 },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440011',
    name: '安全双因子认证硬件令牌 FIDO2',
    description: 'Type-C 与 NFC 双模，无缝兼容各操作系统',
    productType: 'physical',
    selectionStatus: 'available',
    inventoryStatus: 'in_stock',
    priceRange: { min: '128.00', max: '198.00', currency: 'CNY' },
    cover: { url: svgFidoKey, alt: '安全双因子认证硬件令牌 FIDO2', width: 600, height: 600 },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440022',
    name: '企业域名解析与 SSL 证书部署服务',
    description: '专业工程师一对一技术支持与极速排查',
    productType: 'service',
    selectionStatus: 'available',
    inventoryStatus: 'unconfirmed',
    priceRange: { min: '80.00', max: '80.00', currency: 'CNY' },
    cover: null,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440033',
    name: '开发者高阶 API 专属算力包',
    description: '专线高并发配额，资源紧张补货中',
    productType: 'digital',
    selectionStatus: 'available',
    inventoryStatus: 'out_of_stock',
    priceRange: { min: '199.00', max: '199.00', currency: 'CNY' },
    cover: null,
  },
]

function page(url) {
  const pageNumber = Number(url.searchParams.get('page') ?? 1)
  const pageSize = 24
  const total = sampleProducts.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  return {
    items: pageNumber === 1 ? sampleProducts : [],
    page: pageNumber,
    pageSize,
    total,
    totalPages,
  }
}

function category() {
  const result = { id: categoryId, parentId: null, name: 'SSR可见分类', sortOrder: 0, level: 0, path: [{ id: categoryId, name: 'SSR可见分类' }] }
  return { category: result, breadcrumbs: result.path, children: [], products: page(new URL('http://fixture/')) }
}

const product = {
  id: productId,
  name: 'SSR真实商品',
  description: '安全 SSR 内容',
  productType: 'digital',
  purchaseLimits: { perOrder: null, lifetime: null, rolling24Hours: null },
  priceRange: { min: '10.00', max: '10.00', currency: 'CNY' },
  selectionStatus: 'available',
  gallery: [],
  richContentHtml: '<p>详情正文</p>',
  categories: [],
  optionGroups: [],
  variants: [{
    skuId: '550e8400-e29b-41d4-a716-446655440003',
    options: [],
    salePrice: '10.00',
    compareAtPrice: null,
    purchaseLimits: { perOrder: null, lifetime: null, rolling24Hours: null },
    inventory: { mode: 'quantity', status: 'in_stock' },
  }],
  attributes: [],
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  response.setHeader('content-type', 'application/json; charset=utf-8')

  if (url.pathname === '/health') {
    response.writeHead(200).end('{"status":"ok"}')
    return
  }
  if (url.pathname === '/__test/fail') {
    const target = url.searchParams.get('path')
    if (target) brokenPaths.add(target)
    response.writeHead(200).end('{"ok":true}')
    return
  }
  if (url.pathname === '/__test/reset') {
    brokenPaths.clear()
    response.writeHead(200).end('{"ok":true}')
    return
  }

  if (brokenPaths.has(url.pathname)) {
    response.writeHead(500).end(JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'private database stack marker',
        stack: 'D7_PRIVATE_DATABASE_STACK_TRACE',
        requestId: 'ssr-error-probe',
      },
    }))
    return
  }
  if (url.pathname === '/api/v1/customer/session') {
    const cookie = request.headers.cookie ?? ''
    if (cookie.includes('aikayun_customer_session=mock-test-session') || url.searchParams.get('mock_customer') === 'true') {
      response.writeHead(200).end(JSON.stringify({
        data: {
          customer: {
            id: '550e8400-e29b-41d4-a716-446655440099',
            username: '测试顾客',
            email: 'customer@example.test',
            phone: null,
            status: 'active',
          },
          wallet: {
            balance: '688.00',
            currency: 'CNY',
          },
        },
      }))
      return
    }
    response.writeHead(401).end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'No session' } }))
    return
  }
  if (url.pathname === '/api/v1/public/categories') {
    const cookie = request.headers.cookie ?? ''
    const isEmpty = cookie.includes('mock_empty_categories=true') || url.searchParams.get('empty') === 'true'
    response.writeHead(200).end(JSON.stringify({ data: { categories: isEmpty ? [] : [category().category] } }))
    return
  }
  if (url.pathname === '/api/v1/public/storefront/support') {
    response.writeHead(200).end(JSON.stringify({ data: {
      channels: [{ name: 'SSR售后渠道', type: 'https', content: 'https://support.example.test/contact' }],
    } }))
    return
  }
  if (url.pathname === '/api/v1/public/storefront/featured-products') {
    response.writeHead(200).end(JSON.stringify({ data: { products: [sampleProducts[0], sampleProducts[1]] } }))
    return
  }
  if (url.pathname === '/api/v1/public/products') {
    response.writeHead(200).end(JSON.stringify({ data: page(url) }))
    return
  }
  if (url.pathname === `/api/v1/public/categories/${categoryId}/products`) {
    response.writeHead(200).end(JSON.stringify({ data: category() }))
    return
  }
  if (url.pathname === `/api/v1/public/categories/${hiddenCategoryId}/products` || url.pathname === '/api/v1/public/categories/not-a-uuid/products') {
    response.writeHead(404).end('{"error":{"code":"NOT_FOUND","message":"Not found"}}')
    return
  }
  if (url.pathname === '/api/v1/public/search') {
    const q = (url.searchParams.get('q') ?? '').trim()
    const pageNumber = Number(url.searchParams.get('page') ?? 1)
    const matched = q ? sampleProducts.filter(p => p.name.includes(q) || p.description?.includes(q)) : sampleProducts
    const total = matched.length
    const totalPages = Math.max(1, Math.ceil(total / 24))
    response.writeHead(200).end(JSON.stringify({
      data: {
        items: pageNumber === 1 ? matched : [],
        page: pageNumber,
        pageSize: 24,
        total,
        totalPages,
      },
    }))
    return
  }
  if (url.pathname === `/api/v1/public/products/${productId}`) {
    response.writeHead(200).end(JSON.stringify({ data: product }))
    return
  }
  if (/^\/api\/v1\/public\/products\/[0-9a-f-]+$/iu.test(url.pathname)) {
    response.writeHead(404).end('{"error":{"code":"NOT_FOUND","message":"Not found"}}')
    return
  }
  response.writeHead(404).end('{"error":{"code":"NOT_FOUND","message":"Not found"}}')
})

server.listen(3111, '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
