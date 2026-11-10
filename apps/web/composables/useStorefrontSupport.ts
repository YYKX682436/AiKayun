import type { ApiSuccess, StorefrontSupportSettings } from '@aikayun/contracts'

export function useStorefrontSupport() {
  return useAsyncData('public-storefront-support', async (_nuxtApp, { signal }) => {
    try {
      const response = await $fetch<ApiSuccess<StorefrontSupportSettings>>('/api/v1/public/storefront/support', { signal })
      return response.data
    } catch (error) {
      if (signal.aborted) throw error
      throw createError({ statusCode: 502, statusMessage: 'Storefront support temporarily unavailable' })
    }
  }, {
    dedupe: 'defer',
    getCachedData: (key, nuxtApp) => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : undefined,
  })
}
