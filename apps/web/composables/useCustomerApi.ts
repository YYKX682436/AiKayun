import type {
  ApiSuccess,
  ChangeCustomerPasswordBody,
  CsrfToken,
  CustomerLoginBody,
  CustomerProfile,
  CustomerRegisterBody,
  CustomerSession,
  CustomerPasswordChanged,
  StorefrontCustomerPolicy,
  UpdateCustomerProfileBody,
} from '@aikayun/contracts'

export class CustomerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CustomerApiError'
  }
}

type ApiErrorBody = { error?: { code?: string; message?: string } }
type RequestOptions = Parameters<typeof $fetch>[1]

function statusOf(error: unknown): number {
  return Number((error as { statusCode?: number; response?: { status?: number } } | null)?.statusCode
    ?? (error as { response?: { status?: number } } | null)?.response?.status ?? 0)
}

function normalizeError(error: unknown): CustomerApiError {
  const status = statusOf(error)
  const body = (error as { data?: ApiErrorBody; response?: { _data?: ApiErrorBody } } | null)?.data
    ?? (error as { response?: { _data?: ApiErrorBody } } | null)?.response?._data
  const code = body?.error?.code ?? 'REQUEST_FAILED'
  const serverMessage = body?.error?.message
  const message = code === 'INVALID_CREDENTIALS'
    ? '用户名或密码不正确。'
    : code === 'USERNAME_TAKEN'
      ? '该用户名已被使用，请换一个用户名。'
      : code === 'REGISTRATION_REQUIREMENTS_NOT_MET' || code === 'CURRENT_PASSWORD_INCORRECT'
        ? serverMessage ?? '请检查填写内容后重试。'
        : status === 401
          ? '登录状态已失效，请重新登录。'
          : status === 403
            ? '请求未通过安全校验，请刷新页面后重试。'
            : status === 429
              ? '尝试次数过多，请稍后再试。'
              : status >= 500 || status === 0
                ? '服务暂时无法处理此请求，请稍后重试。'
                : '请检查填写内容是否正确，再重试。'
  return new CustomerApiError(status, code, message)
}

export function useCustomerApi() {
  const session = useState<CustomerSession | null>('storefront-customer-session', () => null)
  const sessionResolved = useState('storefront-customer-session-resolved', () => false)
  const csrfToken = useState<string | null>('storefront-customer-csrf-token', () => null)
  let csrfPromise: Promise<string> | undefined

  async function getCsrfToken(force = false): Promise<string> {
    if (!force && csrfToken.value) return csrfToken.value
    if (!csrfPromise || force) {
      csrfPromise = $fetch<ApiSuccess<CsrfToken>>('/api/v1/customer/auth/csrf')
        .then((result) => {
          csrfToken.value = result.data.csrfToken
          return result.data.csrfToken
        })
        .finally(() => { csrfPromise = undefined })
    }
    return csrfPromise
  }

  async function refreshSession(): Promise<CustomerSession | null> {
    const requestFetch = useRequestFetch()
    try {
      const result = await requestFetch<ApiSuccess<CustomerSession | null>>('/api/customer/session')
      session.value = result.data
      sessionResolved.value = true
      return result.data
    } catch {
      session.value = null
      sessionResolved.value = true
      return null
    }
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = String(options.method ?? 'GET').toUpperCase()
    const headers = new Headers(options.headers as HeadersInit | undefined)
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        headers.set('x-csrf-token', await getCsrfToken())
      }
      const requestFetch = import.meta.server ? useRequestFetch() : $fetch
      const result = await requestFetch<ApiSuccess<T>>(path, { ...options, headers })
      return result.data
    } catch (error) {
      const normalized = normalizeError(error)
      if (normalized.status === 401 && (path.endsWith('/session') || path.includes('/profile'))) {
        session.value = null
        sessionResolved.value = true
      }
      throw normalized
    }
  }

  async function register(body: CustomerRegisterBody): Promise<CustomerSession> {
    const result = await request<CustomerSession>('/api/v1/customer/auth/register', { method: 'POST', body })
    session.value = result
    sessionResolved.value = true
    return result
  }

  async function login(body: CustomerLoginBody): Promise<CustomerSession> {
    const result = await request<CustomerSession>('/api/v1/customer/auth/login', { method: 'POST', body })
    session.value = result
    sessionResolved.value = true
    return result
  }

  async function logout(): Promise<void> {
    await request<{ loggedOut: true }>('/api/v1/customer/auth/logout', { method: 'POST' })
    session.value = null
    sessionResolved.value = true
    csrfToken.value = null
  }

  async function getProfile(): Promise<CustomerProfile> {
    return request<CustomerProfile>('/api/v1/customer/profile')
  }

  async function updateProfile(body: UpdateCustomerProfileBody): Promise<CustomerProfile> {
    return request<CustomerProfile>('/api/v1/customer/profile', { method: 'PATCH', body })
  }

  async function changePassword(body: ChangeCustomerPasswordBody): Promise<CustomerPasswordChanged> {
    const result = await request<CustomerPasswordChanged>('/api/v1/customer/password', { method: 'PUT', body })
    if (session.value) session.value = { ...session.value, expiresAt: result.expiresAt }
    return result
  }

  async function getPolicy(): Promise<StorefrontCustomerPolicy> {
    const result = await $fetch<ApiSuccess<StorefrontCustomerPolicy>>('/api/v1/public/storefront/customer-policy')
    return result.data
  }

  return {
    session,
    sessionResolved,
    refreshSession,
    request,
    register,
    login,
    logout,
    getProfile,
    updateProfile,
    changePassword,
    getPolicy,
  }
}
