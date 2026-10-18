import { createServer } from 'node:http'

const categoryId = '550e8400-e29b-41d4-a716-446655440001'
const productId = '550e8400-e29b-41d4-a716-446655440000'
const hiddenCategoryId = '550e8400-e29b-41d4-a716-446655440002'
const brokenPaths = new Set()

function page(url) {
  const pageNumber = Number(url.searchParams.get('page') ?? 1)
  return { items: [], page: pageNumber, pageSize: 24, total: 25, totalPages: 2 }
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
  priceRange: { min: '10.00', max: '10.00', currency: 'CNY' },
  selectionStatus: 'available',
  gallery: [],
  richContentHtml: '<p>详情正文</p>',
  categories: [],
  optionGroups: [],
  variants: [{ options: [], salePrice: '10.00', compareAtPrice: null, inventory: { mode: 'quantity', status: 'in_stock' } }],
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
  if (url.pathname === '/api/v1/public/categories') {
    response.writeHead(200).end(JSON.stringify({ data: { categories: [category().category] } }))
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
    response.writeHead(200).end(JSON.stringify({ data: page(url) }))
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
