import type { ApiSuccess, CsrfToken } from '@aikayun/contracts'

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AdminApiError'
  }
}

type ApiErrorBody = { error?: { code?: string; message?: string } }
type RequestOptions = Parameters<typeof $fetch>[1]
const conflictMessages: Record<string, string> = {
  USERNAME_TAKEN: '该用户名已被其他顾客使用，请调整后重试。',
  CUSTOMER_DELETED: '该顾客身份已删除，不能再修改或恢复。',
  CUSTOMER_HAS_WALLET_BALANCE: '顾客账户仍有可用或冻结余额，处理完余额后才能删除。',
  CUSTOMER_HAS_UNFINISHED_ORDERS: '顾客存在未完成订单，订单结清后才能删除。',
  CUSTOMER_HAS_PENDING_PAYMENT: '顾客存在待处理支付或对账义务，处理完成后才能删除。',
  CUSTOMER_HAS_PENDING_REFUND: '顾客存在待处理退款，处理完成后才能删除。',
  CUSTOMER_HAS_PENDING_WITHDRAWAL: '顾客存在待处理提现或打款，处理完成后才能删除。',
  CUSTOMER_HAS_UNRESOLVED_FULFILLMENT: '顾客存在未完成的履约义务，处理完成后才能删除。',
  PRODUCT_REVISION_CONFLICT: '商品已被其他管理员修改，请重新读取并选择如何处理本地修改。',
  PRODUCT_ARCHIVED: '商品已归档；请先恢复为草稿，再修改经营配置。',
  PRODUCT_HAS_RETIRED_SKU: '商品含永久退役 SKU，不能永久删除；归档可保留 SKU 身份与历史。',
  PRODUCT_HAS_INVENTORY: '商品仍有实际或预留库存，不能永久删除；请先按规则清理库存或归档。',
  PRODUCT_HAS_INVENTORY_HISTORY: '商品存在库存调整历史，不能永久删除；归档可保留商品与库存流水。',
  PRODUCT_HAS_BUSINESS_RESOURCES: '商品已关联资源池或外部来源，不能永久删除；请归档保留记录。',
  SKU_REVISION_CONFLICT: 'SKU 已被其他管理员修改，请重新读取价格或库存状态后再操作。',
  SKU_PERMANENTLY_RETIRED: '此 SKU 已永久退役，不能恢复销售或重新定价。',
  SKU_RETIRED: '此 SKU 已永久退役，不能恢复销售或重新生成。',
  SKU_ENABLED_UPDATE_NOT_IN_MATRIX: '启用状态修改的 SKU 不在当前矩阵中；请保留该组合或取消此状态修改。',
  CATEGORY_REVISION_CONFLICT: '分类已被其他管理员修改，请重新读取分类树后再操作。',
  CATEGORY_HAS_CHILDREN: '此分类仍有子分类，请先移动或删除子分类。',
  PRIMARY_CATEGORY_IN_USE: '商品仍将此分类用作主分类，请先更换或移除商品分类关联。',
  CATEGORY_HAS_PRODUCTS: '仍有商品关联此分类，请先移除商品关联。',
  CATEGORY_CYCLE: '此移动会形成循环层级，请选择其他父级。',
  CATEGORY_DEPTH_LIMIT: '此移动会超过四级分类限制，请选择更浅的父级。',
  SKU_HAS_REFERENCES: '此 SKU 存在库存或历史业务引用，不能移除；请保留为永久退役记录。',
  SKU_STOCK_NOT_CLEARED: '实际库存尚未清零，不能永久退役此 SKU。',
  SKU_STOCK_RESERVED: '此 SKU 仍有预留库存，释放预留前不能永久退役。',
  INVENTORY_REVISION_CONFLICT: '库存已被其他管理员调整，请重新读取库存后再操作。',
  INVENTORY_OPERATION_ID_CONFLICT: '该 operationId 已用于不同库存内容。请勿更换操作内容后复用此编号。',
  INSUFFICIENT_STOCKED_QUANTITY: '减少数量超过当前实际库存，请刷新库存后调整。',
  STOCK_BELOW_RESERVED_QUANTITY: '调整后的实际库存不能低于预留库存。',
  INVENTORY_MODE_SWITCH_BLOCKED: '实际或预留库存未清零，不能切换库存模式。',
  LEGACY_SKU_REMAP_PROHIBITED: '默认 SKU 不能改配到规格组合；请显式永久退役并新建组合，保留原 SKU 历史。',
  SPECIFICATION_GROUP_IN_USE: '规格组仍被历史 SKU 使用，不能移除。',
  SPECIFICATION_VALUE_IN_USE: '规格值仍被历史 SKU 使用，不能移除。',
  PRODUCT_LIFECYCLE_TRANSITION_INVALID: '当前商品状态不允许此生命周期操作，请重新读取状态。',
}

function statusOf(error: unknown): number {
  return Number((error as { statusCode?: number; response?: { status?: number } } | null)?.statusCode
    ?? (error as { response?: { status?: number } } | null)?.response?.status ?? 0)
}

function normalizeError(error: unknown): AdminApiError {
  const status = statusOf(error)
  const body = (error as { data?: ApiErrorBody; response?: { _data?: ApiErrorBody } } | null)?.data
    ?? (error as { response?: { _data?: ApiErrorBody } } | null)?.response?._data
  const code = body?.error?.code ?? 'REQUEST_FAILED'
  const serverMessage = body?.error?.message
  const localizedConflict = conflictMessages[code]
  const message = status === 401
    ? '登录状态已失效，请重新登录。'
    : status === 403
      ? '请求未通过权限或安全校验，请刷新页面后重试。'
      : status === 409
        ? localizedConflict || '数据已变化或当前业务状态不允许此操作，请重新读取并检查相关记录。'
        : status >= 500 || status === 0
          ? '服务器暂时无法处理此请求，请稍后重试。'
          : serverMessage || '请求参数不符合要求，请检查后重试。'
  return new AdminApiError(status, code, message)
}

export function useAdminApi() {
  const route = useRoute()
  let csrfToken: string | undefined
  let csrfPromise: Promise<string> | undefined

  async function getCsrfToken(force = false): Promise<string> {
    if (!force && csrfToken) return csrfToken
    if (!csrfPromise || force) {
      csrfPromise = $fetch<ApiSuccess<CsrfToken>>('/api/v1/admin/auth/csrf')
        .then(result => (csrfToken = result.data.csrfToken))
        .finally(() => { csrfPromise = undefined })
    }
    return csrfPromise
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = String(options.method ?? 'GET').toUpperCase()
    const headers = new Headers(options.headers as HeadersInit | undefined)
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('x-csrf-token', await getCsrfToken())
      const result = await $fetch<ApiSuccess<T>>(path, { ...options, headers })
      return result.data
    } catch (error) {
      const normalized = normalizeError(error)
      if (normalized.status === 401 && import.meta.client) {
        await navigateTo({ path: '/admin/login', query: { redirect: route.fullPath } })
      }
      throw normalized
    }
  }

  async function upload<T>(path: string, file: File, onProgress?: (percent: number) => void): Promise<T> {
    let token: string
    try {
      token = await getCsrfToken()
    } catch (error) {
      const normalized = normalizeError(error)
      if (normalized.status === 401 && import.meta.client) {
        await navigateTo({ path: '/admin/login', query: { redirect: route.fullPath } })
      }
      throw normalized
    }
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', path)
      xhr.withCredentials = true
      xhr.setRequestHeader('x-csrf-token', token)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)))
      }
      xhr.onerror = () => reject(new AdminApiError(0, 'NETWORK_ERROR', '图片上传失败，网络连接中断；可以使用相同操作重试。'))
      xhr.onload = async () => {
        let payload: ApiSuccess<T> | ApiErrorBody
        try {
          payload = JSON.parse(xhr.responseText) as ApiSuccess<T> | ApiErrorBody
        } catch {
          reject(new AdminApiError(xhr.status, 'INVALID_RESPONSE', '服务器返回了无法识别的上传结果。'))
          return
        }
        if (xhr.status >= 200 && xhr.status < 300 && 'data' in payload) {
          onProgress?.(100)
          resolve(payload.data)
          return
        }
        const error = normalizeError({ statusCode: xhr.status, data: payload })
        if (error.status === 401) await navigateTo({ path: '/admin/login', query: { redirect: route.fullPath } })
        reject(error)
      }
      const form = new FormData()
      form.append('file', file, file.name)
      xhr.send(form)
    })
  }

  return { request, upload }
}
