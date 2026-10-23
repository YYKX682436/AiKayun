import { createHash } from 'node:crypto'
import { preserveSupplierReferenceAmount } from '@aikayun/money'
import type {
  SupplierAccountObservation, SupplierCatalogPage, SupplierCatalogProduct,
  SupplierCatalogQuery, SupplierPurchaseField, SupplierPurchaseOption, SupplierReadSource,
} from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import { SupplierHttpError, appendPath, parseSupplierJson, requestSupplierWire, validateSupplierBaseUrl } from './supplier-http.js'

export interface KayixinV3Supplier { baseUrl: string; appId: string; appSecret: string }
export type KayixinV3Source = Omit<SupplierReadSource, 'readAt' | 'protocol' | 'apiVersion'>
// Business read-only operations only. No caller-supplied path, method or payload.
const operations = {
  account: { path: '/api/v3/user/getAccount', maxResponseBytes: 64 * 1024 },
  list: { path: '/api/v3/goods/getList', maxResponseBytes: 1024 * 1024 },
  detail: { path: '/api/v3/goods/getDetail', maxResponseBytes: 2 * 1024 * 1024 },
} as const
export class KayixinV3Error extends Error {
  constructor(readonly code: string, readonly classification: 'authentication_failed' | 'response_invalid' | 'upstream_rejected' = 'response_invalid') {
    super(code)
    this.name = 'KayixinV3Error'
  }
}

/** bodyJson is the final UTF-8 string; the transport sends these exact bytes. */
export function signKayixinV3(appId: string, appSecret: string, timestamp: string, bodyJson: string): string {
  return createHash('md5').update(`${appId}${appSecret}3.0${timestamp}${bodyJson}`, 'utf8').digest('hex')
}

export function validateKayixinBaseUrl(value: string, config: AppConfig): URL {
  const base = validateSupplierBaseUrl(value, config)
  if (base.pathname !== '/') throw new SupplierHttpError('response_invalid', 'kayixin_origin_required')
  return base
}

const moneyFields = new Set(['balance', 'salesPrice', 'money'])
async function readOperation(config: AppConfig, supplier: KayixinV3Supplier,
  operation: keyof typeof operations, bodyJson: string): Promise<unknown> {
  if (!/^[0-9]{1,32}$/u.test(supplier.appId) || !/^[!-~]{1,512}$/u.test(supplier.appSecret)) throw new KayixinV3Error('kayixin_credentials_invalid')
  const target = appendPath(validateKayixinBaseUrl(supplier.baseUrl, config), operations[operation].path)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  if (!/^\d{10}$/u.test(timestamp)) throw new KayixinV3Error('kayixin_clock_invalid')
  const body = Buffer.from(bodyJson, 'utf8')
  const response = await requestSupplierWire(config, target, 'POST', {
    'X-APP-ID': supplier.appId, 'X-Version': '3.0', 'X-Timestamp': timestamp,
    'X-Signature': signKayixinV3(supplier.appId, supplier.appSecret, timestamp, bodyJson),
  }, body, { maxRequestBytes: 16 * 1024, maxResponseBytes: operations[operation].maxResponseBytes })
  // Node 24 supplies the original numeric token to the reviver. Never pass a
  // supplier quote through Number or round it into a two-decimal sale price.
  if (response.status === 401 || response.status === 403) throw new KayixinV3Error('kayixin_authentication_failed', 'authentication_failed')
  const row = parseSupplierJson(response, (key, value, context) =>
    moneyFields.has(key) && typeof value === 'number' ? context?.source ?? invalid() : value)
  if (!Number.isSafeInteger(row.code) || typeof row.msg !== 'string') invalid()
  if (row.code !== 1000) {
    const auth = /签名|app.?id|app.?secret|密钥|认证|鉴权|时间戳/iu.test(row.msg as string)
    throw new KayixinV3Error(auth ? 'kayixin_authentication_failed' : `kayixin_business_${row.code}`,
      auth ? 'authentication_failed' : 'upstream_rejected')
  }
  if (row.data === null || row.data === undefined) invalid()
  // A hostile upstream must not echo a signing secret into admin pages/audits.
  if (JSON.stringify(row.data).includes(supplier.appSecret)) throw new KayixinV3Error('kayixin_sensitive_response')
  return row.data
}

function invalid(): never { throw new KayixinV3Error('kayixin_response_invalid') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid()
  return value
}
function text(value: unknown, max: number, required = false): string | null {
  if (value === null || value === undefined) { if (required) invalid(); return null }
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || [...value].some(c => { const code = c.codePointAt(0)!; return code < 32 && ![9, 10, 13].includes(code) || code === 127 })) invalid()
  return value
}
function integer(value: unknown, required = false, minimum = 0): number | null {
  if (value === null || value === undefined) { if (required) invalid(); return null }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid()
  return value
}
function flag(value: unknown): boolean | null {
  const result = integer(value)
  if (result !== null && result !== 0 && result !== 1) invalid()
  return result === null ? null : result === 1
}
function quote(value: unknown): SupplierCatalogProduct['quote'] {
  if (value === undefined || value === null) return { amount: null, currency: null, basis: 'upstream_account_reference', actualDebitVerified: false }
  // The wire parser preserves numeric tokens as strings. String amounts are
  // accepted only under the same bounded decimal contract.
  if (typeof value !== 'string') invalid()
  let amount: string
  try { amount = preserveSupplierReferenceAmount(value) } catch { return invalid() }
  return { amount, currency: null, basis: 'upstream_account_reference', actualDebitVerified: false }
}
function stock(value: unknown): SupplierCatalogProduct['stock'] {
  const count = integer(value)
  return { reportedCount: count, availability: count === null ? 'unknown' : count === 0 ? 'reported_empty' : 'reported_available' }
}
function source(identity: KayixinV3Source): SupplierReadSource {
  return { ...identity, protocol: 'kayixin_customer_v3', apiVersion: '3.0', readAt: new Date().toISOString() }
}
function image(value: unknown): string | null {
  const url = text(value, 2048)
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null
  } catch { return null }
}

function purchaseFields(value: unknown): SupplierPurchaseField[] | null {
  if (value === null || value === undefined) return null
  let nodes = 0
  const budget = (depth: number) => { if (++nodes > 4000 || depth > 8) invalid() }
  const field = (input: unknown, depth: number): SupplierPurchaseField => {
    budget(depth)
    const row = record(input)
    return { type: integer(row.type), title: text(row.title, 2000), placeholder: text(row.placeholder, 2000),
      required: flag(row.required), regex: text(row.regex, 2000),
      options: row.options == null ? [] : list(row.options, 500).map(item => option(item, depth + 1)) }
  }
  const option = (input: unknown, depth: number): SupplierPurchaseOption => {
    budget(depth)
    const row = record(input)
    return { name: text(row.name, 2000, true)!, value: text(row.value, 2000) ?? invalid(),
      children: row.children == null ? [] : list(row.children, 500).map(item => option(item, depth + 1)),
      expand: row.expand == null ? [] : list(row.expand, 50).map(item => field(item, depth + 1)) }
  }
  return list(value, 50).map(item => field(item, 0))
}

function product(input: unknown, readSource: SupplierReadSource, detail: boolean): SupplierCatalogProduct {
  const row = record(input)
  const id = integer(row.goodsId, true, 1)!
  const skuType = integer(row.skuType)
  const warnings = ['币种未由上游文档声明；报价不代表实际扣费。', '数量与倍数换算尚未实测；自动采购尚未开放。']
  const variants: SupplierCatalogProduct['variants'] = []
  const groups: SupplierCatalogProduct['specificationGroups'] = []
  const variant = (value: unknown, names?: SupplierCatalogProduct['variants'][number]['combination']) => {
    const item = record(value)
    const combination = names ?? list(item.names, 30).map(value => {
      const name = record(value)
      return { title: text(name.title, 200, true)!, value: text(name.value, 200, true)! }
    })
    variants.push({ upstreamSku: text(item.sku, 200, true)!, combination,
      status: integer(item.status), quote: quote(item.money), stock: stock(item.count) })
  }
  if (detail && skuType === 1) {
    const skus = record(row.goodsSku)
    for (const value of list(skus.typeNames, 30)) {
      const group = record(value)
      groups.push({ name: text(group.name, 200, true)!, values: list(group.skuNames, 500).map(v => text(record(v).name, 200, true)!) })
    }
    for (const item of list(skus.details, 2000)) variant(item)
    if (!variants.length) warnings.push('上游多规格明细为空，供货资格未知。')
  } else if (detail && skuType === 2) {
    for (const value of list(row.goodsSpec, 30)) {
      const group = record(value)
      const title = text(group.name, 200, true)!
      const values: string[] = []
      for (const value of list(group.items, 500)) {
        const item = record(value)
        const name = text(item.title, 200, true)!
        values.push(name)
        variant(item, [{ title, value: name }])
      }
      groups.push({ name: title, values })
    }
    if (!variants.length || variants.length > 2000) invalid()
  } else if (skuType !== null && ![0, 1, 2].includes(skuType)) warnings.push('未知规格类型，不能推断提交方式。')
  if (new Set(variants.map(item => item.upstreamSku)).size !== variants.length) invalid()
  const result: SupplierCatalogProduct = {
    source: readSource, upstreamProductId: String(id), name: text(row.name, 500, true)!,
    goodsType: integer(row.goodsType, true)!, status: integer(row.status, true)!, skuType,
    quote: quote(row.salesPrice), stock: stock(row.stockCount),
    quantityRules: { minQuantity: integer(row.minQuantity), maxQuantity: integer(row.maxQuantity),
      multiple: integer(row.multiple), conversionVerified: false },
    capabilities: { repeatOrder: flag(row.isRepeat), refundOrder: flag(row.isRefOrder), refundMoney: flag(row.isRefMoney),
      warrantyDays: integer(row.warrantyDays), warrantyTime: integer(row.warrantyTime), warrantyUnit: integer(row.warrantyUnit) },
    imageUrl: image(row.imgUrl), description: text(row.goodsDescribe, 20000), detail: text(row.goodsDetail, 20000),
    buyNotice: text(row.buyNotice, 20000), variants, specificationGroups: groups,
    purchaseFields: detail ? purchaseFields(row.rechargeTemplates) : null,
    warnings, procurementReady: false,
  }
  if (result.quote.amount === null) warnings.push('上游未提供报价。')
  if (result.stock.availability === 'unknown') warnings.push('上游未报告库存，供货状态未知。')
  if (![1, 3].includes(result.goodsType) || ![1, 2, 3].includes(result.status)) warnings.push('上游商品类型或状态未知。')
  if (result.purchaseFields?.some(item => item.type === null || ![0, 1, 13, 14, 15, 16].includes(item.type))) warnings.push('包含未知购买填写类型，仅供核对。')
  return result
}

export async function readKayixinAccount(config: AppConfig, supplier: KayixinV3Supplier, identity: KayixinV3Source): Promise<SupplierAccountObservation> {
  const row = record(await readOperation(config, supplier, 'account', ''))
  if (row.balance === null || row.balance === undefined) invalid()
  return { source: source(identity), balance: quote(row.balance) }
}
export async function readKayixinGoods(config: AppConfig, supplier: KayixinV3Supplier, identity: KayixinV3Source, query: SupplierCatalogQuery): Promise<SupplierCatalogPage> {
  const page = query.page ?? 1
  const bodyJson = JSON.stringify({ page, goodsType: query.goodsType ?? '', keyWord: query.keyWord ?? '',
    skuType: query.skuType ?? '', showDirId: '1', dirId: query.dirId ?? '', brandId: query.brandId ?? '' })
  const row = record(await readOperation(config, supplier, 'list', bodyJson))
  const readSource = source(identity)
  return { source: readSource, requestedPage: page,
    upstreamPagination: { allCount: integer(row.allCount), allPage: integer(row.allPage), semanticsVerified: false },
    items: list(row.items, 1000).map(item => product(item, readSource, false)) }
}
export async function readKayixinGoodDetail(config: AppConfig, supplier: KayixinV3Supplier, identity: KayixinV3Source, goodsId: number): Promise<SupplierCatalogProduct> {
  if (!Number.isSafeInteger(goodsId) || goodsId < 1) invalid()
  const row = await readOperation(config, supplier, 'detail', JSON.stringify({ goodsId }))
  const result = product(row, source(identity), true)
  if (result.upstreamProductId !== String(goodsId)) throw new KayixinV3Error('kayixin_product_identity_mismatch')
  return result
}
