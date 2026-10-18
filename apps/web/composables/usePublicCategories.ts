import type { ApiSuccess, PublicCategoriesResponse } from '@aikayun/contracts'

export function usePublicCategories() {
  return useAsyncData(
    'public-storefront-categories',
    async (_nuxtApp, { signal }) => {
      try {
        return await $fetch<ApiSuccess<PublicCategoriesResponse>>('/api/v1/public/categories', { signal })
      }
      catch (cause) {
        return throwSafePublicApiError(cause, signal)
      }
    },
    { default: () => undefined, deep: false },
  )
}
