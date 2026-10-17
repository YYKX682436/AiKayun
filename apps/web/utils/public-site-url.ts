export function resolvePublicOrigin(configuredOrigin: unknown): string {
  if (typeof configuredOrigin !== 'string') return 'http://localhost:3000'
  let origin = 'http://localhost:3000'
  try {
    const parsed = new URL(configuredOrigin)
    if (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === ''
    ) origin = parsed.origin
  }
  catch {
    // Keep a stable fallback when deployment configuration is malformed.
  }

  return origin
}

/** Capture deployment configuration once while inside setup, then build stable SEO URLs. */
export function usePublicSiteUrl(): (path: string) => string {
  const runtimeConfig = useRuntimeConfig()
  const origin = resolvePublicOrigin(runtimeConfig.public.siteUrl)
  return (path: string) => new URL(path.startsWith('/') ? path : `/${path}`, `${origin}/`).toString()
}
