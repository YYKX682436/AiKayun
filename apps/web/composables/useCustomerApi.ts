import type {
  ApiSuccess,
  ChangeCustomerPasswordBody,
  CheckoutQuote,
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

export class CheckoutConflictError extends CustomerApiError {
  constructor(status: number, code: string, message: string, readonly currentQuote: CheckoutQuote) {
    super(status, code, message)
    this.name = 'CheckoutConflictError'
  }
}

type ApiErrorBody = { error?: { code?: string; message?: string; currentQuote?: CheckoutQuote } }
type RequestOptions = Parameters<typeof $fetch>[1]
const customerIdentityLockName = 'aikayun:customer-identity:v1'
const customerIdentityRevisionKey = 'aikayun-customer-identity-revision-v1'

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
  if (status === 409 && body?.error?.currentQuote) {
    return new CheckoutConflictError(status, code, serverMessage ?? '报价已变化，请核对最新内容后继续。', body.error.currentQuote)
  }
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
  const identityRevision = useState<string | null>('storefront-customer-identity-revision', () => null)
  const identityRevisionReady = useState('storefront-customer-identity-revision-ready', () => false)
  const identityRevisionStorageAvailable = useState('storefront-customer-identity-revision-storage', () => true)
  const nuxtApp = useNuxtApp() as ReturnType<typeof useNuxtApp> & {
    _customerCsrfPromise?: Promise<string>
    _customerAuthMutationQueue?: Promise<void>
    _customerIdentityStorageListener?: (event: StorageEvent) => void
    _customerIdentityChannel?: BroadcastChannel
  }

  function identitySensitivePath(path: string): boolean {
    return path.includes('/api/v1/customer/')
      || path === '/api/v1/checkout/quote'
      || path.startsWith('/api/v1/checkout/orders')
      || path.startsWith('/api/v1/guest/')
  }

  function requiresCurrentSessionProbe(path: string): boolean {
    return path.includes('/api/v1/customer/cart')
      || path.includes('/api/v1/customer/orders')
      || path === '/api/v1/checkout/quote'
      || path.startsWith('/api/v1/checkout/orders')
      || path.startsWith('/api/v1/guest/')
  }

  function readIdentityRevision(): { ok: boolean; value: string | null } {
    if (!import.meta.client) return { ok: true, value: null }
    try { return { ok: true, value: localStorage.getItem(customerIdentityRevisionKey) } }
    catch { return { ok: false, value: null } }
  }

  function resetCsrfState(): void {
    csrfToken.value = null
    csrfRequestVersion.value += 1
    nuxtApp._customerCsrfPromise = undefined
  }

  function invalidateForExternalIdentityChange(revision: string | null): void {
    identityRevision.value = revision
    identityRevisionReady.value = true
    session.value = null
    sessionResolved.value = false
    identityVersion.value += 1
    sessionRequestVersion.value += 1
    resetCsrfState()
  }

  function initializeIdentityRevision(): void {
    if (!import.meta.client || identityRevisionReady.value) return
    const current = readIdentityRevision()
    identityRevisionStorageAvailable.value = current.ok
    if (current.ok) {
      identityRevision.value = current.value
      identityRevisionReady.value = true
    }
  }

  function installIdentityStorageListener(): void {
    if (!import.meta.client) return
    const observeRevision = (revision: string | null) => {
      if (revision === identityRevision.value) return
      invalidateForExternalIdentityChange(revision)
      void refreshSession(true)
    }
    if (typeof BroadcastChannel !== 'undefined' && !nuxtApp._customerIdentityChannel) {
      try {
        const channel = new BroadcastChannel(customerIdentityRevisionKey)
        channel.onmessage = (event: MessageEvent<{ type?: string; revision?: string }>) => {
          if (event.data?.type === 'identity-change' && typeof event.data.revision === 'string') {
            observeRevision(event.data.revision)
          }
        }
        nuxtApp._customerIdentityChannel = channel
      }
      catch {
        // Storage revision checks and the server session probe remain authoritative.
      }
    }
    if (nuxtApp._customerIdentityStorageListener) return
    const listener = (event: StorageEvent) => {
      if (event.key === customerIdentityRevisionKey) observeRevision(event.newValue)
    }
    window.addEventListener('storage', listener)
    nuxtApp._customerIdentityStorageListener = listener
  }

  initializeIdentityRevision()
  installIdentityStorageListener()

  function publishIdentityRevision(): void {
    if (!import.meta.client) return
    const revision = crypto.randomUUID()
    try {
      localStorage.setItem(customerIdentityRevisionKey, revision)
      identityRevision.value = revision
      identityRevisionReady.value = true
      identityRevisionStorageAvailable.value = true
    }
    catch {
      identityRevisionStorageAvailable.value = false
    }
    nuxtApp._customerIdentityChannel?.postMessage({ type: 'identity-change', revision })
  }

  function verifyIdentityRevision(path: string): void {
    if (!import.meta.client) return
    const current = readIdentityRevision()
    if (!current.ok) {
      if (requiresCurrentSessionProbe(path)) {
        throw new CustomerApiError(0, 'CROSS_TAB_SYNC_UNAVAILABLE', '浏览器无法安全确认购物车归属，请检查本地存储后重试。')
      }
      return
    }
    if (requiresCurrentSessionProbe(path) && !identityRevisionStorageAvailable.value) {
      throw new CustomerApiError(0, 'CROSS_TAB_SYNC_UNAVAILABLE', '浏览器无法保存身份变更标记，购物车操作已暂停以保护账户数据。')
    }
    if (!identityRevisionReady.value) {
      identityRevision.value = current.value
      identityRevisionReady.value = true
      return
    }
    if (current.value !== identityRevision.value) {
      invalidateForExternalIdentityChange(current.value)
      void refreshSession(true)
      throw new CustomerApiError(0, 'STALE_IDENTITY', '登录状态已在其他标签页变化，请重试此操作。')
    }
  }

  async function verifyCurrentSession(path: string): Promise<void> {
    verifyIdentityRevision(path)
    if (!requiresCurrentSessionProbe(path)) return
    const current = await $fetch<ApiSuccess<CustomerSession | null>>('/api/customer/session')
    const actualId = current.data?.customer.id ?? null
    const expectedId = session.value?.customer.id ?? null
    if (actualId !== expectedId) {
      const revision = readIdentityRevision()
      invalidateForExternalIdentityChange(revision.ok ? revision.value : identityRevision.value)
      void refreshSession(true)
      throw new CustomerApiError(0, 'STALE_IDENTITY', '服务端登录身份已变化，请重新同步购物车。')
    }
  }

  async function withIdentityMutationLock<T>(action: () => Promise<T>): Promise<T> {
    if (!import.meta.client) return action()
    const locks = navigator.locks
    if (!locks) return action()
    return locks.request(customerIdentityLockName, { mode: 'exclusive' }, action)
  }

  async function dispatchWithIdentityLock<T>(path: string, dispatch: () => Promise<T>, lockAlreadyHeld: boolean): Promise<T> {
    if (!import.meta.client || lockAlreadyHeld || !identitySensitivePath(path)) return dispatch()
    const locks = navigator.locks
    if (!locks) {
      if (identitySensitivePath(path)) {
        throw new CustomerApiError(0, 'CROSS_TAB_SYNC_UNAVAILABLE', '当前浏览器不支持安全的跨标签购物车同步。')
      }
      return dispatch()
    }
    let result: Promise<T> | undefined
    await locks.request(customerIdentityLockName, { mode: 'shared' }, async () => {
      await verifyCurrentSession(path)
      result = dispatch()
    })
    if (!result) throw new CustomerApiError(0, 'REQUEST_NOT_STARTED', '请求未能安全启动，请重试。')
    return result
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

  function commitSession(next: CustomerSession | null, forceIdentityChange = false, broadcast = false): void {
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
      if (broadcast) publishIdentityRevision()
    }
  }

  function readCustomerCsrfCookie(): string | null {
    if (!import.meta.client) return null
    const cookie = document.cookie.split('; ').find(value => value.startsWith('aikayun_customer_csrf='))
    return cookie ? decodeURIComponent(cookie.slice('aikayun_customer_csrf='.length)) : null
  }

  async function getCsrfToken(force = false, identityLockAlreadyHeld = false): Promise<string> {
    const currentCookie = import.meta.client ? readCustomerCsrfCookie() : null
    if (currentCookie && (!force || currentCookie !== csrfToken.value)) {
      csrfToken.value = currentCookie
      return currentCookie
    }
    if (!force && csrfToken.value && (!import.meta.client || currentCookie === csrfToken.value)) return csrfToken.value
    if (import.meta.client && csrfToken.value && currentCookie !== csrfToken.value) {
      csrfToken.value = null
      csrfRequestVersion.value += 1
      nuxtApp._customerCsrfPromise = undefined
    }
    if (!nuxtApp._customerCsrfPromise || force) {
      const identityAtStart = identityVersion.value
      const requestVersion = ++csrfRequestVersion.value
      const fetchToken = async (): Promise<string> => {
        if (import.meta.client && !force) {
          const latestCookie = readCustomerCsrfCookie()
          if (latestCookie) {
            if (identityVersion.value === identityAtStart && csrfRequestVersion.value === requestVersion) csrfToken.value = latestCookie
            return latestCookie
          }
        }
        const result = await $fetch<ApiSuccess<CsrfToken>>('/api/v1/customer/auth/csrf')
        if (identityVersion.value === identityAtStart && csrfRequestVersion.value === requestVersion) {
          csrfToken.value = result.data.csrfToken
        }
        return result.data.csrfToken
      }
      const requestPromise = (async () => {
        if (import.meta.client && !identityLockAlreadyHeld && navigator.locks) {
          return navigator.locks.request(customerIdentityLockName, { mode: 'exclusive' }, fetchToken)
        }
        return fetchToken()
      })().finally(() => {
        if (nuxtApp._customerCsrfPromise === requestPromise) nuxtApp._customerCsrfPromise = undefined
      })
      nuxtApp._customerCsrfPromise = requestPromise
    }
    const token = await nuxtApp._customerCsrfPromise
    if (import.meta.client) {
      const latestCookie = readCustomerCsrfCookie()
      if (latestCookie && latestCookie !== token) {
        csrfToken.value = latestCookie
        return latestCookie
      }
      if (!latestCookie) {
        csrfToken.value = null
        csrfRequestVersion.value += 1
        nuxtApp._customerCsrfPromise = undefined
        if (force) throw new CustomerApiError(0, 'CSRF_TOKEN_UNAVAILABLE', '安全校验信息已更新，请重试此操作。')
        return getCsrfToken(true, identityLockAlreadyHeld)
      }
    }
    return token
  }

  async function refreshSession(fromCrossTab = false): Promise<CustomerSession | null> {
    if (authMutationPending.value > 0) return session.value
    const identityAtStart = identityVersion.value
    const authMutationAtStart = authMutationVersion.value
    const requestVersion = ++sessionRequestVersion.value
    const requestFetch = useRequestFetch()
    try {
      const result = await requestFetch<ApiSuccess<CustomerSession | null>>('/api/customer/session')
      if (requestVersion === sessionRequestVersion.value && identityAtStart === identityVersion.value
        && authMutationAtStart === authMutationVersion.value && authMutationPending.value === 0) {
        commitSession(result.data, false, !fromCrossTab && (session.value?.customer.id ?? null) !== (result.data?.customer.id ?? null))
      }
    } catch {
      if (requestVersion === sessionRequestVersion.value && identityAtStart === identityVersion.value
        && authMutationAtStart === authMutationVersion.value && authMutationPending.value === 0) {
        commitSession(null, false, !fromCrossTab && session.value !== null)
      }
    }
    return session.value
  }

  async function performRequest<T>(path: string, options: RequestOptions = {}, lockAlreadyHeld = false): Promise<T> {
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
        headers.set('x-csrf-token', await getCsrfToken(false, lockAlreadyHeld))
        if (identityAtStart !== identityVersion.value) {
          throw new CustomerApiError(0, 'STALE_IDENTITY', '登录状态已变化，请重试此操作。')
        }
        if (import.meta.client && readCustomerCsrfCookie() !== headers.get('x-csrf-token')) {
          throw new CustomerApiError(0, 'CSRF_TOKEN_UNAVAILABLE', '安全校验信息已更新，请重试此操作。')
        }
      }
      const requestFetch = import.meta.server ? useRequestFetch() : $fetch
      const result = await dispatchWithIdentityLock(path, () => requestFetch<ApiSuccess<T>>(path, { ...options, headers }), lockAlreadyHeld)
      if (import.meta.client && identitySensitivePath(path)) verifyIdentityRevision(path)
      return result.data
    } catch (error) {
      const normalized = normalizeError(error)
      const invalidCustomerRequest = path.includes('/profile')
        || path.includes('/customer/cart')
        || path.endsWith('/auth/logout')
      if (identityAtStart === identityVersion.value
        && normalized.status === 401
        && (path.endsWith('/session') || invalidCustomerRequest)) {
        commitSession(null, false, true)
      }
      throw normalized
    }
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return performRequest<T>(path, options)
  }

  async function requestDuringIdentityMutation<T>(path: string, options: RequestOptions): Promise<T> {
    return performRequest<T>(path, options, true)
  }

  async function register(body: CustomerRegisterBody): Promise<CustomerSession> {
    const mutationVersion = ++authMutationVersion.value
    authMutationPending.value += 1
    try {
      return await queueAuthMutation(() => withIdentityMutationLock(async () => {
        const identityAtStart = identityVersion.value
        const result = await requestDuringIdentityMutation<CustomerSession>('/api/v1/customer/auth/register', { method: 'POST', body })
        if (mutationVersion === authMutationVersion.value && identityAtStart === identityVersion.value) {
          commitSession(result, true, true)
        }
        return result
      }))
    } finally {
      authMutationPending.value -= 1
    }
  }

  async function login(body: CustomerLoginBody): Promise<CustomerSession> {
    const mutationVersion = ++authMutationVersion.value
    authMutationPending.value += 1
    try {
      return await queueAuthMutation(() => withIdentityMutationLock(async () => {
        const identityAtStart = identityVersion.value
        const result = await requestDuringIdentityMutation<CustomerSession>('/api/v1/customer/auth/login', { method: 'POST', body })
        if (mutationVersion === authMutationVersion.value && identityAtStart === identityVersion.value) {
          commitSession(result, true, true)
        }
        return result
      }))
    } finally {
      authMutationPending.value -= 1
    }
  }

  async function logout(): Promise<void> {
    const mutationVersion = ++authMutationVersion.value
    authMutationPending.value += 1
    try {
      await queueAuthMutation(() => withIdentityMutationLock(async () => {
        const identityAtStart = identityVersion.value
        await requestDuringIdentityMutation<{ loggedOut: true }>('/api/v1/customer/auth/logout', { method: 'POST' })
        if (mutationVersion === authMutationVersion.value && identityAtStart === identityVersion.value) {
          commitSession(null, true, true)
          csrfToken.value = null
        }
      }))
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
