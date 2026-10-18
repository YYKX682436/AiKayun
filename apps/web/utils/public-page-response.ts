/** Convert upstream failures to a small, safe error suitable for the Nuxt payload. */
export function throwSafePublicApiError(cause: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw cause

  const upstream = cause as { statusCode?: unknown; status?: unknown }
  const candidate = Number(upstream?.statusCode ?? upstream?.status)
  const statusCode = Number.isInteger(candidate) && candidate >= 400 && candidate <= 499
    ? candidate
    : 502

  throw createError({
    statusCode,
    statusMessage: statusCode === 404 ? 'Not Found' : 'Public catalog temporarily unavailable',
  })
}

/** Dynamic storefront HTML must not be retained by browsers or intermediary caches. */
export function useUncachedPublicPage(): void {
  if (import.meta.server) useResponseHeader('cache-control').value = 'no-store'
}

/** Keep retryable page errors in the document while returning an honest HTTP failure status. */
export function setPublicPageFailureStatus(error: unknown): void {
  if (!import.meta.server || !error) return
  const value = error as { statusCode?: unknown; status?: unknown }
  const candidate = Number(value.statusCode ?? value.status)
  setResponseStatus(Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 502)
}

export function canonicalPagePath(path: string, page: number, sort?: string, defaultSort?: string): string {
  const query = new URLSearchParams()
  if (page > 1) query.set('page', String(page))
  if (sort && sort !== defaultSort) query.set('sort', sort)
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}
