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

const multiSpecProduct = {
  id: '550e8400-e29b-41d4-a716-446655440011',
  name: '安全双因子认证硬件令牌 FIDO2',
  description: 'Type-C 与 NFC 双模，无缝兼容各操作系统，支持无密码登录与物理防钓鱼保护。',
  productType: 'physical',
  purchaseLimits: { perOrder: 5, lifetime: 10, rolling24Hours: null },
  priceRange: { min: '128.00', max: '198.00', currency: 'CNY' },
  selectionStatus: 'available',
  gallery: [
    { url: svgFidoKey, thumbnailUrl: svgFidoKey, alt: '正面特写', width: 600, height: 600 },
    { url: svgCloudServer, thumbnailUrl: svgCloudServer, alt: '接口与细节', width: 600, height: 600 },
  ],
  richContentHtml: `
    <h2>产品概述</h2>
    <p>该硬件认证令牌专为极高安全需求的账号防护打造，采用银行级安全芯片，抵御恶意远程截获与中间人钓鱼攻击。</p>
    <blockquote>遵循 FIDO 联盟最新标准，受主流浏览器与操作系统原生支持，即插即用。</blockquote>
    <h3>核心特性</h3>
    <ul>
      <li>双模连接：原生 Type-C 接口搭配近场通讯 NFC 无线轻触。</li>
      <li>多协议支持：FIDO2 / WebAuthn / U2F 标准，全面兼容主流账号体系。</li>
      <li>坚固耐用：一体成型航空级锌合金外壳，IP68 级防水抗压设计。</li>
    </ul>
    <h3>常见问题</h3>
    <p>如需批量采购或企业定制 Logo 激光雕刻，请通过商城客服渠道咨询。</p>
  `,
  categories: [{
    id: categoryId,
    name: '安全硬件',
    isPrimary: true,
    path: [{ id: categoryId, name: '数字安全' }, { id: '550e8400-e29b-41d4-a716-446655440091', name: '安全硬件' }],
  }],
  optionGroups: [
    {
      id: 'group-port',
      name: '接口类型',
      values: [
        { id: 'val-type-c', name: 'Type-C' },
        { id: 'val-dual', name: '双模 (Type-C + NFC)' },
      ],
    },
    {
      id: 'group-color',
      name: '颜色外观',
      values: [
        { id: 'val-black', name: '深空黑' },
        { id: 'val-silver', name: '星光银' },
      ],
    },
  ],
  variants: [
    {
      skuId: '550e8400-e29b-41d4-a716-4466554400a1',
      options: [{ groupId: 'group-port', valueId: 'val-type-c' }, { groupId: 'group-color', valueId: 'val-black' }],
      salePrice: '128.00',
      compareAtPrice: '158.00',
      purchaseLimits: { perOrder: 5, lifetime: 10, rolling24Hours: null },
      inventory: { mode: 'quantity', status: 'in_stock' },
    },
    {
      skuId: '550e8400-e29b-41d4-a716-4466554400a2',
      options: [{ groupId: 'group-port', valueId: 'val-type-c' }, { groupId: 'group-color', valueId: 'val-silver' }],
      salePrice: '128.00',
      compareAtPrice: null,
      purchaseLimits: { perOrder: 5, lifetime: 10, rolling24Hours: null },
      inventory: { mode: 'quantity', status: 'in_stock' },
    },
    {
      skuId: '550e8400-e29b-41d4-a716-4466554400a3',
      options: [{ groupId: 'group-port', valueId: 'val-dual' }, { groupId: 'group-color', valueId: 'val-black' }],
      salePrice: '198.00',
      compareAtPrice: '228.00',
      purchaseLimits: { perOrder: 5, lifetime: 10, rolling24Hours: null },
      inventory: { mode: 'quantity', status: 'in_stock' },
    },
    {
      skuId: '550e8400-e29b-41d4-a716-4466554400a4',
      options: [{ groupId: 'group-port', valueId: 'val-dual' }, { groupId: 'group-color', valueId: 'val-silver' }],
      salePrice: '198.00',
      compareAtPrice: '228.00',
      purchaseLimits: { perOrder: 5, lifetime: 10, rolling24Hours: null },
      inventory: { mode: 'quantity', status: 'out_of_stock' },
    },
  ],
  attributes: [
    { name: '认证标准', value: 'FIDO2 Level 2, WebAuthn' },
    { name: '外壳材质', value: '航空级锌合金' },
    { name: '接口规格', value: 'USB 3.2 Gen 1 Type-C / 13.56 MHz NFC' },
    { name: '防尘防水', value: 'IP68' },
    { name: '售后保修', value: '3 年质保，只换不修' },
  ],
}

const formProduct = {
  id: '550e8400-e29b-41d4-a716-446655440022',
  name: '企业域名解析与 SSL 证书部署服务',
  description: '专业工程师一对一技术支持与极速排查，包括泛域名 SSL 证书申请与 Web 服务自动化续期。',
  productType: 'service',
  purchaseLimits: { perOrder: null, lifetime: null, rolling24Hours: null },
  priceRange: { min: '80.00', max: '80.00', currency: 'CNY' },
  selectionStatus: 'available',
  gallery: [
    { url: svgCloudServer, thumbnailUrl: svgCloudServer, alt: '服务流程', width: 600, height: 600 },
  ],
  richContentHtml: `
    <h2>服务说明</h2>
    <p>下单后技术专员将根据您填写的部署要求进行一对一核验，30 分钟内完成全链路 DNS 解析和自动化证书签发。</p>
  `,
  categories: [{
    id: categoryId,
    name: '技术支持服务',
    isPrimary: true,
    path: [{ id: categoryId, name: '企业运维服务' }],
  }],
  optionGroups: [],
  variants: [
    {
      skuId: '550e8400-e29b-41d4-a716-4466554400b1',
      options: [],
      salePrice: '80.00',
      compareAtPrice: '120.00',
      purchaseLimits: { perOrder: null, lifetime: null, rolling24Hours: null },
      inventory: { mode: 'unlimited', status: 'in_stock' },
    },
  ],
  attributes: [
    { name: '响应时间', value: '工作时间内 15 分钟响应' },
    { name: '证书类型', value: 'Let\'s Encrypt 泛域名自动化证书' },
    { name: '售后期限', value: '自部署交付起 30 天质保' },
  ],
}

const outOfStockProduct = {
  id: '550e8400-e29b-41d4-a716-446655440033',
  name: '开发者高阶 API 专属算力包',
  description: '专线高并发配额，资源紧张补货中。',
  productType: 'digital',
  purchaseLimits: { perOrder: null, lifetime: null, rolling24Hours: null },
  priceRange: { min: '199.00', max: '199.00', currency: 'CNY' },
  selectionStatus: 'none',
  gallery: [],
  richContentHtml: '<p>本算力包正处于节点升级调度中，预计下周重新开放认购。</p>',
  categories: [],
  optionGroups: [],
  variants: [
    {
      skuId: '550e8400-e29b-41d4-a716-4466554400c1',
      options: [],
      salePrice: '199.00',
      compareAtPrice: null,
      purchaseLimits: { perOrder: null, lifetime: null, rolling24Hours: null },
      inventory: { mode: 'quantity', status: 'out_of_stock' },
    },
  ],
  attributes: [],
}

function checkDraftCompleteness(values) {
  const domain = String(values?.['550e8400-e29b-41d4-a716-4466554400f1'] ?? '').trim()
  const env = String(values?.['550e8400-e29b-41d4-a716-4466554400f2'] ?? '').trim()
  const incompleteFieldIds = []
  if (!domain) incompleteFieldIds.push('550e8400-e29b-41d4-a716-4466554400f1')
  if (!env) incompleteFieldIds.push('550e8400-e29b-41d4-a716-4466554400f2')
  return {
    complete: incompleteFieldIds.length === 0,
    incompleteFieldIds,
  }
}

function initialDrafts() {
  return new Map([
    ['550e8400-e29b-41d4-a716-446655440081', {
      id: '550e8400-e29b-41d4-a716-446655440081',
      templateVersionId: '550e8400-e29b-41d4-a716-4466554400d2',
      revision: 1,
      values: { '550e8400-e29b-41d4-a716-4466554400f1': 'shop.aikayun.top', '550e8400-e29b-41d4-a716-4466554400f2': '550e8400-e29b-41d4-a716-4466554400e2' },
      attachments: [],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      updatedAt: new Date().toISOString(),
      templateChanged: false,
    }],
  ])
}

let mockDrafts = initialDrafts()

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
    mockDrafts = initialDrafts()
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
  if (url.pathname === '/api/v1/customer/auth/csrf') {
    response.writeHead(200, {
      'set-cookie': 'aikayun_customer_csrf=test-csrf-token; Path=/; SameSite=Lax',
    }).end(JSON.stringify({ data: { csrfToken: 'test-csrf-token' } }))
    return
  }
  if (url.pathname === '/api/v1/guest/session') {
    response.writeHead(200, {
      'set-cookie': 'aikayun_customer_csrf=test-csrf-token; Path=/; SameSite=Lax',
    }).end(JSON.stringify({
      data: {
        sessionId: '550e8400-e29b-41d4-a716-446655440091',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
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
  if (url.pathname === `/api/v1/public/products/${multiSpecProduct.id}`) {
    response.writeHead(200).end(JSON.stringify({ data: multiSpecProduct }))
    return
  }
  if (url.pathname === `/api/v1/public/products/${formProduct.id}`) {
    response.writeHead(200).end(JSON.stringify({ data: formProduct }))
    return
  }
  if (url.pathname === `/api/v1/public/products/${outOfStockProduct.id}`) {
    response.writeHead(200).end(JSON.stringify({ data: outOfStockProduct }))
    return
  }
  if (url.pathname === '/api/v1/storefront/skus/550e8400-e29b-41d4-a716-4466554400b1/purchase-form') {
    response.writeHead(200).end(JSON.stringify({
      data: {
        templateId: '550e8400-e29b-41d4-a716-4466554400d1',
        templateName: '域名与证书配置资料',
        templateVersionId: '550e8400-e29b-41d4-a716-4466554400d2',
        required: true,
        status: 'active',
        definition: {
          fields: [
            { id: '550e8400-e29b-41d4-a716-4466554400f1', meaningKey: 'domain', type: 'text', label: '待部署主域名', placeholder: '例如：shop.example.com', required: true, maxLength: 200, helpText: '请确保域名已通过实名认证并可正常解析。' },
            { id: '550e8400-e29b-41d4-a716-4466554400f2', meaningKey: 'server_env', type: 'select', label: '目标服务器环境', required: true, options: [{ id: '550e8400-e29b-41d4-a716-4466554400e1', meaningKey: 'nginx', label: 'Nginx / OpenResty' }, { id: '550e8400-e29b-41d4-a716-4466554400e2', meaningKey: 'caddy', label: 'Caddy' }], helpText: '根据您的宿主机或集群服务类型选择。' },
            { id: '550e8400-e29b-41d4-a716-4466554400f3', meaningKey: 'remarks', type: 'textarea', label: '部署备注要求', placeholder: '如特定的子域名或证书路径要求...', required: false, maxLength: 500 },
          ],
        },
      },
    }))
    return
  }
  if (url.pathname === '/api/v1/storefront/purchase-drafts' && request.method === 'POST') {
    const draft = {
      id: '550e8400-e29b-41d4-a716-446655440082',
      templateVersionId: '550e8400-e29b-41d4-a716-4466554400d2',
      revision: 1,
      values: {},
      attachments: [],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      updatedAt: new Date().toISOString(),
      templateChanged: false,
    }
    mockDrafts.set(draft.id, draft)
    response.writeHead(200).end(JSON.stringify({ data: draft }))
    return
  }
  if (url.pathname === '/api/v1/storefront/skus/550e8400-e29b-41d4-a716-4466554400b1/purchase-drafts') {
    if (request.method === 'POST') {
      const draft = {
        id: '550e8400-e29b-41d4-a716-446655440082',
        templateVersionId: '550e8400-e29b-41d4-a716-4466554400d2',
        revision: 1,
        values: {},
        attachments: [],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        updatedAt: new Date().toISOString(),
        templateChanged: false,
      }
      mockDrafts.set(draft.id, draft)
      response.writeHead(200).end(JSON.stringify({ data: draft }))
      return
    }
    const list = Array.from(mockDrafts.values()).map(d => ({
      id: d.id,
      templateVersionId: d.templateVersionId,
      revision: d.revision,
      expiresAt: d.expiresAt,
      updatedAt: d.updatedAt,
      templateChanged: d.templateChanged,
    }))
    response.writeHead(200).end(JSON.stringify({ data: list }))
    return
  }
  if (url.pathname.startsWith('/api/v1/storefront/purchase-drafts/')) {
    const parts = url.pathname.slice('/api/v1/storefront/purchase-drafts/'.length).split('/')
    const draftId = decodeURIComponent(parts[0])
    const action = parts[1]
    let current = mockDrafts.get(draftId)
    if (!current) {
      current = {
        id: draftId,
        templateVersionId: '550e8400-e29b-41d4-a716-4466554400d2',
        revision: 1,
        values: {},
        attachments: [],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        updatedAt: new Date().toISOString(),
        templateChanged: false,
      }
      mockDrafts.set(draftId, current)
    }

    if (action === 'validate' && request.method === 'POST') {
      const status = checkDraftCompleteness(current.values)
      response.writeHead(200).end(JSON.stringify({
        data: {
          revision: current.revision,
          complete: status.complete,
          incompleteFieldIds: status.incompleteFieldIds,
        },
      }))
      return
    }

    if (request.method === 'PUT' || request.method === 'PATCH') {
      let body = ''
      for await (const chunk of request) body += chunk
      try {
        const parsed = JSON.parse(body)
        if (parsed.values) current.values = { ...(parsed.values ?? {}) }
        current.revision++
        current.updatedAt = new Date().toISOString()
      } catch (error) {
        void error
      }
      const status = checkDraftCompleteness(current.values)
      response.writeHead(200).end(JSON.stringify({
        data: {
          revision: current.revision,
          complete: status.complete,
          incompleteFieldIds: status.incompleteFieldIds,
        },
      }))
      return
    }

    if (request.method === 'GET') {
      response.writeHead(200).end(JSON.stringify({ data: current }))
      return
    }
  }
  if (url.pathname.startsWith('/api/v1/storefront/skus/') && url.pathname.endsWith('/purchase-form')) {
    response.writeHead(200).end(JSON.stringify({ data: { templateId: null, templateName: '', templateVersionId: '', required: false, status: 'active', definition: { fields: [] } } }))
    return
  }
  if (url.pathname === '/api/v1/checkout/orders' && request.method === 'POST') {
    response.writeHead(201).end(JSON.stringify({
      data: {
        order: {
          id: '550e8400-e29b-41d4-a716-446655440077',
          orderNumber: 'AKY-20261115-0001',
          totalAmount: '128.00',
          status: 'pending_payment',
        },
      },
    }))
    return
  }
  if (url.pathname === '/api/v1/checkout/quote' || url.pathname === '/api/v1/customer/cart/quote') {
    let body = ''
    for await (const chunk of request) body += chunk
    let requestedList = []
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed)) requestedList = parsed
      else if (Array.isArray(parsed?.items)) requestedList = parsed.items
    } catch {
      requestedList = []
    }

    const skuCatalog = {
      '550e8400-e29b-41d4-a716-4466554400a1': {
        productId: '550e8400-e29b-41d4-a716-446655440011',
        productName: '安全双因子认证硬件令牌 FIDO2',
        productType: 'physical',
        productStatus: 'active',
        skuCode: 'FIDO2-TYPEC-BLK',
        unitPrice: '128.00',
        options: [
          { groupId: 'group-port', groupName: '接口规格', valueId: 'val-typec', valueName: 'Type-C' },
          { groupId: 'group-color', groupName: '外观颜色', valueId: 'val-black', valueName: '深空黑' },
        ],
        purchaseLimits: {
          product: { perOrderLimit: 5, lifetimeLimit: 10, rolling24HourLimit: null, lifetimePurchased: 0, rolling24HoursPurchased: 0, maxAvailable: 5, exceeded: false },
          sku: { perOrderLimit: null, lifetimeLimit: null, rolling24HourLimit: null, lifetimePurchased: null, rolling24HoursPurchased: null, maxAvailable: null, exceeded: false },
          requiresLogin: false,
        },
      },
      '550e8400-e29b-41d4-a716-4466554400a2': {
        productId: '550e8400-e29b-41d4-a716-446655440011',
        productName: '安全双因子认证硬件令牌 FIDO2',
        productType: 'physical',
        productStatus: 'active',
        skuCode: 'FIDO2-TYPEC-SLV',
        unitPrice: '128.00',
        options: [
          { groupId: 'group-port', groupName: '接口规格', valueId: 'val-typec', valueName: 'Type-C' },
          { groupId: 'group-color', groupName: '外观颜色', valueId: 'val-silver', valueName: '星光银' },
        ],
        purchaseLimits: {
          product: { perOrderLimit: 5, lifetimeLimit: 10, rolling24HourLimit: null, lifetimePurchased: 0, rolling24HoursPurchased: 0, maxAvailable: 5, exceeded: false },
          sku: { perOrderLimit: null, lifetimeLimit: null, rolling24HourLimit: null, lifetimePurchased: null, rolling24HoursPurchased: null, maxAvailable: null, exceeded: false },
          requiresLogin: false,
        },
      },
      '550e8400-e29b-41d4-a716-4466554400b1': {
        productId: '550e8400-e29b-41d4-a716-446655440022',
        productName: '企业域名解析与 SSL 证书部署服务',
        productType: 'service',
        productStatus: 'active',
        skuCode: 'SSL-AUTO-DEPLOY',
        unitPrice: '80.00',
        options: [],
        purchaseLimits: {
          product: { perOrderLimit: null, lifetimeLimit: null, rolling24HourLimit: null, lifetimePurchased: 0, rolling24HoursPurchased: 0, maxAvailable: null, exceeded: false },
          sku: { perOrderLimit: null, lifetimeLimit: null, rolling24HourLimit: null, lifetimePurchased: null, rolling24HoursPurchased: null, maxAvailable: null, exceeded: false },
          requiresLogin: false,
        },
      },
    }

    const defaultSku = {
      productId: '550e8400-e29b-41d4-a716-446655440000',
      productName: '安全测试商品',
      productType: 'physical',
      productStatus: 'active',
      skuCode: 'SEC-TEST-001',
      unitPrice: '99.00',
      options: [],
      purchaseLimits: {
        product: { perOrderLimit: null, lifetimeLimit: null, rolling24HourLimit: null, lifetimePurchased: null, rolling24HoursPurchased: null, maxAvailable: null, exceeded: false },
        sku: { perOrderLimit: null, lifetimeLimit: null, rolling24HourLimit: null, lifetimePurchased: null, rolling24HoursPurchased: null, maxAvailable: null, exceeded: false },
        requiresLogin: false,
      },
    }

    const items = requestedList.length > 0 ? requestedList.map(req => {
      const info = skuCatalog[req.skuId] ?? defaultSku
      const qty = Number(req.quantity) || 1
      const priceNum = Number(info.unitPrice)
      const lineTotal = (priceNum * qty).toFixed(2)
      return {
        lineId: req.lineId ?? null,
        sourceLineIds: req.lineId ? [req.lineId] : [],
        lineRevision: req.lineRevision ?? null,
        draftId: req.draftId ?? null,
        draftRevision: req.draftRevision ?? null,
        templateVersionId: req.templateVersionId ?? null,
        normalizationVersion: 1,
        contentIdentity: null,
        purchasePreview: req.draftId ? {
          templateVersionId: '550e8400-e29b-41d4-a716-4466554400d2',
          definition: {
            fields: [
              {
                id: '550e8400-e29b-41d4-a716-4466554400f1',
                meaningKey: 'domain',
                type: 'text',
                label: '待部署主域名',
                required: true,
              },
              {
                id: '550e8400-e29b-41d4-a716-4466554400f2',
                meaningKey: 'server_env',
                type: 'select',
                label: '目标服务器环境',
                required: true,
                options: [
                  { id: '550e8400-e29b-41d4-a716-4466554400e1', meaningKey: 'nginx', label: 'Nginx / OpenResty' },
                  { id: '550e8400-e29b-41d4-a716-4466554400e2', meaningKey: 'caddy', label: 'Caddy' },
                ],
              },
            ],
          },
          values: mockDrafts.get(req.draftId)?.values || {
            '550e8400-e29b-41d4-a716-4466554400f1': 'shop.aiove.top',
            '550e8400-e29b-41d4-a716-4466554400f2': '550e8400-e29b-41d4-a716-4466554400e2',
          },
          attachments: [],
        } : null,
        skuId: req.skuId,
        productId: info.productId,
        productName: info.productName,
        productType: info.productType,
        productStatus: info.productStatus,
        skuCode: info.skuCode,
        options: info.options,
        unitPrice: info.unitPrice,
        quantity: qty,
        lineTotal,
        inventoryMode: 'quantity',
        fulfillmentMethod: 'manual',
        fulfillmentRevision: 1,
        fulfillmentVersionId: '550e8400-e29b-41d4-a716-446655440099',
        availableQuantity: 20,
        identityValid: true,
        purchaseLimits: info.purchaseLimits,
        canPurchase: true,
        reason: null,
      }
    }) : [
      {
        lineId: null,
        sourceLineIds: [],
        lineRevision: null,
        draftId: null,
        draftRevision: null,
        templateVersionId: null,
        normalizationVersion: 1,
        contentIdentity: null,
        purchasePreview: null,
        skuId: '550e8400-e29b-41d4-a716-4466554400a1',
        productId: '550e8400-e29b-41d4-a716-446655440011',
        productName: '安全双因子认证硬件令牌 FIDO2',
        productType: 'physical',
        productStatus: 'active',
        skuCode: 'FIDO2-TYPEC-BLK',
        options: [
          { groupId: 'group-port', groupName: '接口规格', valueId: 'val-typec', valueName: 'Type-C' },
          { groupId: 'group-color', groupName: '外观颜色', valueId: 'val-black', valueName: '深空黑' },
        ],
        unitPrice: '128.00',
        quantity: 1,
        lineTotal: '128.00',
        inventoryMode: 'quantity',
        fulfillmentMethod: 'manual',
        fulfillmentRevision: 1,
        fulfillmentVersionId: '550e8400-e29b-41d4-a716-446655440099',
        availableQuantity: 20,
        identityValid: true,
        purchaseLimits: skuCatalog['550e8400-e29b-41d4-a716-4466554400a1'].purchaseLimits,
        canPurchase: true,
        reason: null,
      },
    ]

    const subtotal = items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0).toFixed(2)
    response.writeHead(200).end(JSON.stringify({
      data: {
        quotedAt: new Date().toISOString(),
        quoteToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        currency: 'CNY',
        items,
        pricedSubtotal: subtotal,
        totalAmount: subtotal,
        totalComplete: true,
        canContinue: true,
        customerAuthenticated: false,
        guestCheckoutEnabled: true,
        guestFreeClaimEnabled: false,
        policyReasons: [],
      },
    }))
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
