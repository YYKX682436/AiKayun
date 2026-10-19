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
  if (error instanceof CustomerApiError) return error
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

function isCustomerAuthMutation(path: string): boolean {
  return /^\/api\/v1\/customer\/auth\/(?:login|register|logout)$/u.test(path)
}

export function useCustomerApi() {
  const session = useState<CustomerSession | null>('storefront-customer-session', () => null)
  const sessionResolved = useState('storefront-customer-session-resolved', () => false)
  const identityVersion = useState('storefront-customer-identity-version', () => 0)
  const sessionRequestVersion = useState('storefront-customer-session-request-version', () => 0)
  const authMutationVersion = useState('storefront-customer-auth-mutation-version', () => 0)
  const authMutationPending = useState('storefront-customer-auth-mutation-pending', () => 0)
  const csrfRequestVersion = useState('storefront-customer-csrf-request-version', () => 0)
  const csrfToken = useState<string | null>('storefront-customer-csrf-token', () => null)
  const nuxtApp = useNuxtApp() as ReturnType<typeof useNuxtApp> & {
    _customerCsrfPromise?: Promise<string>
    _customerAuthMutationQueue?: Promise<void>
  }

  async function queueAuthMutation<T>(action: () => Promise<T>): Promise<T> {
    const previous = nuxtApp._customerAuthMutationQueue ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.catch(() => {}).then(() => turn)
    nuxtApp._customerAuthMutationQueue = queued
    await previous.catch(() => {})
    try {
      return await action()
    } finally {
      release()
    }
  }

  function commitSession(next: CustomerSession | null, forceIdentityChange = false): void {
    const previousId = session.value?.customer.id ?? null
    const nextId = next?.customer.id ?? null
    session.value = next
    sessionResolved.value = true
    if (forceIdentityChange || previousId !== nextId) {
      identityVersion.value += 1
      csrfToken.value = null
      csrfRequestVersion.value += 1
      nuxtApp._customerCsrfPromise = undefined
      sessionRequestVersion.value += 1
    }
  }

  function readCustomerCsrfCookie(): string | null {
    if (!import.meta.client) return null
    const cookie = document.cookie.split('; ').find(value => value.startsWith('aikayun_customer_csrf='))
    return cookie ? decodeURIComponent(cookie.slice('aikayun_customer_csrf='.length)) : null
  }

  async function getCsrfToken(force = false): Promise<string> {
    if (!force && csrfToken.value
      && (!import.meta.client || readCustomerCsrfCookie() === csrfToken.value)) return csrfToken.value
    if (import.meta.client && csrfToken.value && readCustomerCsrfCookie() !== csrfToken.value) {
      csrfToken.value = null
      csrfRequestVersion.value += 1
      nuxtApp._customerCsrfPromise = undefined
    }
    if (!nuxtApp._customerCsrfPromise || force) {
      const identityAtStart = identityVersion.value
      const requestVersion = ++csrfRequestVersion.value
      const requestPromise = $fetch<ApiSuccess<CsrfToken>>('/api/v1/customer/auth/csrf')
        .then((result) => {
          if (identityVersion.value === identityAtStart && csrfRequestVersion.value === requestVersion) {
            csrfToken.value = result.data.csrfToken
          }
          return result.data.csrfToken
        })
        .finally(() => {
          if (nuxtApp._customerCsrfPromise === requestPromise) nuxtApp._customerCsrfPromise = undefined
        })
      nuxtApp._customerCsrfPromise = requestPromise
    }
    const token = await nuxtApp._customerCsrfPromise
    if (import.meta.client && readCustomerCsrfCookie() !== token) {
      csrfToken.value = null
      csrfRequestVersion.value += 1
      nuxtApp._customerCsrfPromise = undefined
      if (force) throw new CustomerApiError(0, 'CSRF_TOKEN_UNAVAILABLE', '安全校验信息已更新，请重试此操作。')
      return getCsrfToken(true)
    }
    return token
  }

  async function refreshSession(): Promise<CustomerSession | null> {
    if (authMutationPending.value > 0) return session.value
    const identityAtStart = identityVersion.value
    const authMutationAtStart = authMutationVersion.value
    const requestVersion = ++sessionRequestVersion.value
    const requestFetch = useRequestFetch()
    try {
      const result = await requestFetch<ApiSuccess<CustomerSession | null>>('/api/customer/session')
      if (requestVersion === sessionRequestVersion.value && identityAtStart === identityVersion.value
        && authMutationAtStart === authMutationVersion.value && authMutationPending.value === 0) {
        commitSession(result.data)
      }
    } catch {
      if (requestVersion === sessionRequestVersion.value && identityAtStart === identityVersion.value
        && authMutationAtStart === authMutationVersion.value && authMutationPending.value === 0) {
        commitSession(null)
      }
    }
    return session.value
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const identityAtStart = identityVersion.value
    const method = String(options.method ?? 'GET').toUpperCase()
    const headers = new Headers(options.headers as HeadersInit | undefined)
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        if (!isCustomerAuthMutation(path) && authMutationPending.value > 0) {
          await nuxtApp._customerAuthMutationQueue?.catch(() => {})
          if (identityAtStart !== identityVersion.value) {
            throw new CustomerApiError(0, 'STALE_IDENTITY', '登录状态已变化，请重试此操作。')
          }
        }
        headers.set('x-csrf-token', await getCsrfToken())
        if (identityAtStart !== identityVersion.value) {
          throw new CustomerApiError(0, 'STALE_IDENTITY', '登录状态已变化，请重试此操作。')
        }
        if (import.meta.client && readCustomerCsrfCookie() !== headers.get('x-csrf-token')) {
          throw new CustomerApiError(0, 'CSRF_TOKEN_UNAVAILABLE', '安全校验信息已更新，请重试此操作。')
        }
      }
      const requestFetch = import.meta.server ? useRequestFetch() : $fetch
      const result = await requestFetch<ApiSuccess<T>>(path, { ...options, headers })
      return result.data
    } catch (error) {
      const normalized = normalizeError(error)
      const invalidCustomerRequest = path.includes('/profile')
        || path.includes('/customer/cart')
        || path.endsWith('/auth/logout')
      if (identityAtStart === identityVersion.value
        && normalized.status === 401
        && (path.endsWith('/session') || invalidCustomerRequest)) {
        commitSession(null)
      }
      throw normalized
    }
  }

  async function register(body: CustomerRegisterBody): Promise<CustomerSession> {
    const mutationVersion = ++authMutationVersion.value
    authMutationPending.value += 1
    try {
      return await queueAuthMutation(async () => {
        const identityAtStart = identityVersion.value
        const result = await request<CustomerSession>('/api/v1/customer/auth/register', { method: 'POST', body })
        if (mutationVersion === authMutationVersion.value && identityAtStart === identityVersion.value) {
          commitSession(result, true)
        }
        return result
      })
    } finally {
      authMutationPending.value -= 1
    }
  }

  async function login(body: CustomerLoginBody): Promise<CustomerSession> {
    const mutationVersion = ++authMutationVersion.value
    authMutationPending.value += 1
    try {
      return await queueAuthMutation(async () => {
        const identityAtStart = identityVersion.value
        const result = await request<CustomerSession>('/api/v1/customer/auth/login', { method: 'POST', body })
        if (mutationVersion === authMutationVersion.value && identityAtStart === identityVersion.value) {
          commitSession(result, true)
        }
        return result
      })
    } finally {
      authMutationPending.value -= 1
    }
  }

  async function logout(): Promise<void> {
    const mutationVersion = ++authMutationVersion.value
    authMutationPending.value += 1
    try {
      await queueAuthMutation(async () => {
        const identityAtStart = identityVersion.value
        await request<{ loggedOut: true }>('/api/v1/customer/auth/logout', { method: 'POST' })
        if (mutationVersion === authMutationVersion.value && identityAtStart === identityVersion.value) {
          commitSession(null, true)
          csrfToken.value = null
        }
      })
    } finally {
      authMutationPending.value -= 1
    }
  }

  async function getProfile(): Promise<CustomerProfile> {
    return request<CustomerProfile>('/api/v1/customer/profile')
  }

  async function updateProfile(body: UpdateCustomerProfileBody): Promise<CustomerProfile> {
    return request<CustomerProfile>('/api/v1/customer/profile', { method: 'PATCH', body })
  }

  async function changePassword(body: ChangeCustomerPasswordBody): Promise<CustomerPasswordChanged> {
    const identityAtStart = identityVersion.value
    const result = await request<CustomerPasswordChanged>('/api/v1/customer/password', { method: 'PUT', body })
    if (identityAtStart === identityVersion.value && session.value) session.value = { ...session.value, expiresAt: result.expiresAt }
    return result
  }

  async function getPolicy(): Promise<StorefrontCustomerPolicy> {
    const result = await $fetch<ApiSuccess<StorefrontCustomerPolicy>>('/api/v1/public/storefront/customer-policy')
    return result.data
  }

  return {
    session,
    sessionResolved,
    identityVersion,
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
