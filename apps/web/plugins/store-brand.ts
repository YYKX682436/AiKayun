import type { ApiSuccess, StorefrontBrandSettings } from '@aikayun/contracts'
import type { StoreBrandConfig } from '~/utils/store-brand'

export default defineNuxtPlugin(async () => {
  const savedBrand = useState<StoreBrandConfig | null>('saved-storefront-brand', () => null)
  const loaded = useState('saved-storefront-brand-loaded', () => false)
  if (loaded.value) return

  try {
    const requestFetch = useRequestFetch()
    const response = await requestFetch<ApiSuccess<StorefrontBrandSettings>>('/api/v1/public/storefront/brand')
    savedBrand.value = response.data.brand
  } catch {
    // Keep the deployment runtimeConfig defaults available while the public API is unavailable.
  } finally {
    loaded.value = true
  }
})
