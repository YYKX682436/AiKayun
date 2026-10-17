import type { ApiSuccess, PublicCategoriesResponse } from '@aikayun/contracts'

export function usePublicCategories() {
  return useAsyncData(
    'public-storefront-categories',
    () => $fetch<ApiSuccess<PublicCategoriesResponse>>('/api/v1/public/categories'),
    { default: () => undefined, deep: false },
  )
}
