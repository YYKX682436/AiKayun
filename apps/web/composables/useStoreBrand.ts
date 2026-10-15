import { computed } from 'vue'
import { resolveStoreBrand } from '~/utils/store-brand'

export function useStoreBrand() {
  const runtimeConfig = useRuntimeConfig()

  return computed(() => resolveStoreBrand(runtimeConfig.public))
}
