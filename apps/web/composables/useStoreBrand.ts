import { computed } from 'vue'
import type { StorefrontBrand } from '@aikayun/contracts'
import { resolveStoreBrand } from '~/utils/store-brand'

const savedBrandStateKey = 'saved-storefront-brand'

export function useSavedStoreBrand() {
  return useState<StorefrontBrand | null>(savedBrandStateKey, () => null)
}

export function useStoreBrand() {
  const runtimeConfig = useRuntimeConfig()
  const savedBrand = useSavedStoreBrand()

  return computed(() => resolveStoreBrand({
    ...runtimeConfig.public,
    ...(savedBrand.value ?? {}),
  }))
}
