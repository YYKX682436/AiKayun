<script setup lang="ts">
import type {
  ApiSuccess,
  ProductListItem,
  ProductListResponse,
  StorefrontFeaturedProduct,
  StorefrontFeaturedProducts,
} from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '首页推荐' })

const api = useAdminApi()
const { data: initialResponse, error: loadError, pending: loadPending } = await useFetch<ApiSuccess<StorefrontFeaturedProducts>>(
  '/api/v1/admin/storefront/featured-products',
  { key: 'admin-storefront-featured-products' },
)
const featured = ref<StorefrontFeaturedProduct[]>([...(initialResponse.value?.data.items ?? [])])
const productResults = ref<ProductListItem[]>([])
const searchInput = ref('')
const resultPage = ref(1)
const totalPages = ref(0)
const resultTotal = ref(0)
const searchPending = ref(false)
const searchLoaded = ref(false)
const searchError = ref('')
const saving = ref(false)
const saveError = ref('')
const saveSuccess = ref('')

const statusLabels = {
  draft: '草稿',
  active: '销售中',
  paused: '已暂停',
  archived: '已归档',
} as const
const productTypeLabels = {
  physical: '实物商品',
  digital: '数字商品',
  service: '服务商品',
} as const
const canSave = computed(() => !loadPending.value && !loadError.value && !!initialResponse.value)

let latestSearchRequest = 0

async function loadProducts(page = 1) {
  if (searchPending.value) return
  const requestId = ++latestSearchRequest
  searchPending.value = true
  searchError.value = ''
  productResults.value = []
  resultTotal.value = 0
  totalPages.value = 0
  const query = new URLSearchParams({ page: String(page), pageSize: '20', status: 'active' })
  const search = searchInput.value.trim()
  if (search) query.set('search', search)
  try {
    const response = await api.request<ProductListResponse>('/api/v1/admin/products?' + query.toString())
    if (requestId !== latestSearchRequest) return
    productResults.value = response.items
    resultPage.value = response.page
    totalPages.value = response.totalPages
    resultTotal.value = response.total
  } catch (error) {
    if (requestId !== latestSearchRequest) return
    searchError.value = error instanceof AdminApiError ? error.message : '商品搜索失败，请稍后重试。'
    productResults.value = []
  } finally {
    if (requestId === latestSearchRequest) {
      searchPending.value = false
      searchLoaded.value = true
    }
  }
}

function addProduct(product: ProductListItem) {
  saveSuccess.value = ''
  saveError.value = ''
  if (product.status !== 'active') {
    searchError.value = '只能推荐正在销售的商品。'
    return
  }
  if (featured.value.some(item => item.id === product.id)) return
  if (featured.value.length >= 8) {
    saveError.value = '首页推荐最多可选择 8 件商品。'
    return
  }
  featured.value = [...featured.value, {
    id: product.id,
    name: product.name,
    productType: product.productType,
    status: product.status,
    coverImage: product.coverImage,
  }]
}

function removeProduct(productId: string) {
  saveSuccess.value = ''
  saveError.value = ''
  featured.value = featured.value.filter(item => item.id !== productId)
}

function moveProduct(index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= featured.value.length) return
  const reordered = [...featured.value]
  ;[reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!]
  featured.value = reordered
  saveSuccess.value = ''
  saveError.value = ''
}

async function saveFeaturedProducts() {
  if (!canSave.value || saving.value) return
  saving.value = true
  saveError.value = ''
  saveSuccess.value = ''
  try {
    const response = await api.request<StorefrontFeaturedProducts>('/api/v1/admin/storefront/featured-products', {
      method: 'PUT',
      body: { productIds: featured.value.map(item => item.id) },
    })
    featured.value = response.items
    saveSuccess.value = '首页推荐已保存，商城刷新后会按此顺序展示。'
  } catch (error) {
    saveError.value = error instanceof AdminApiError ? error.message : '保存失败，请稍后重试。'
  } finally {
    saving.value = false
  }
}

onMounted(() => { void loadProducts() })
</script>

<template>
  <UDashboardPanel id="admin-storefront-featured">
    <template #header>
      <UDashboardNavbar
        title="首页推荐"
        :toggle="{ size: 'md', class: 'min-h-11 min-w-11' }"
      >
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <main
        id="admin-main"
        tabindex="-1"
        class="mx-auto w-full max-w-6xl p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <div>
          <p class="text-sm font-medium text-primary">
            店铺经营
          </p>
          <div class="mt-1 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 class="text-3xl font-semibold tracking-tight text-highlighted">
                首页推荐
              </h1>
              <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
                选择最多 8 件正在销售的商品，并调整首页精选推荐的展示顺序。已推荐商品以后暂停或归档时仍保留在设置中，但不会公开展示。
              </p>
            </div>
            <UBadge
              color="neutral"
              variant="subtle"
              class="min-h-8 px-3 tabular-nums"
            >
              {{ featured.length }} / 8
            </UBadge>
          </div>
        </div>

        <UAlert
          v-if="loadError"
          class="mt-6"
          color="error"
          variant="soft"
          title="无法读取首页推荐，请刷新页面重试。"
          role="alert"
        />
        <UAlert
          v-if="saveError"
          class="mt-6"
          color="error"
          variant="soft"
          :title="saveError"
          role="alert"
          aria-live="assertive"
        />
        <UAlert
          v-if="saveSuccess"
          class="mt-6"
          color="success"
          variant="soft"
          :title="saveSuccess"
          role="status"
          aria-live="polite"
        />

        <div class="mt-7 grid items-start gap-6 lg:grid-cols-2">
          <UCard>
            <template #header>
              <div>
                <h2 class="text-lg font-semibold text-highlighted">
                  当前推荐
                </h2>
                <p class="mt-1 text-sm leading-6 text-muted">
                  上下移动即可调整顺序。暂停或归档的商品仍可移除。
                </p>
              </div>
            </template>

            <div
              v-if="loadPending"
              class="py-8 text-center text-sm text-muted"
              role="status"
            >
              正在读取推荐设置…
            </div>
            <div
              v-else-if="featured.length === 0"
              class="rounded-lg border border-dashed border-default px-4 py-8 text-center text-sm text-muted"
            >
              还没有推荐商品。可从右侧在售商品中搜索并添加。
            </div>
            <ol
              v-else
              class="grid gap-3"
              aria-label="首页推荐顺序"
            >
              <li
                v-for="(product, index) in featured"
                :key="product.id"
                class="flex min-w-0 items-center gap-3 rounded-xl border border-default p-3"
              >
                <span class="w-6 shrink-0 text-center text-sm font-semibold tabular-nums text-muted">
                  {{ index + 1 }}
                </span>
                <img
                  v-if="product.coverImage"
                  :src="product.coverImage.thumbnailUrl"
                  alt=""
                  aria-hidden="true"
                  class="size-14 shrink-0 rounded-lg bg-muted object-cover"
                  width="56"
                  height="56"
                >
                <div
                  v-else
                  class="grid size-14 shrink-0 place-items-center rounded-lg bg-muted text-muted"
                  aria-hidden="true"
                >
                  <UIcon
                    name="i-lucide-image"
                    class="size-5"
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <p class="break-words font-medium text-highlighted">
                    {{ product.name }}
                  </p>
                  <div class="mt-1 flex flex-wrap items-center gap-2">
                    <UBadge
                      color="neutral"
                      variant="subtle"
                      size="xs"
                    >
                      {{ productTypeLabels[product.productType] }}
                    </UBadge>
                    <UBadge
                      :color="product.status === 'active' ? 'success' : product.status === 'archived' ? 'neutral' : 'warning'"
                      variant="subtle"
                      size="xs"
                    >
                      {{ statusLabels[product.status] }}
                    </UBadge>
                  </div>
                  <p
                    v-if="product.status !== 'active'"
                    class="mt-1 text-xs leading-5 text-warning"
                  >
                    此商品当前不会在商城公开展示
                  </p>
                </div>
                <div class="flex shrink-0 flex-col gap-1 sm:flex-row">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-arrow-up"
                    size="sm"
                    class="min-h-11 min-w-11"
                    :aria-label="'将 ' + product.name + ' 上移'"
                    :disabled="index === 0 || saving || loadPending"
                    @click="moveProduct(index, -1)"
                  />
                  <UButton
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-arrow-down"
                    size="sm"
                    class="min-h-11 min-w-11"
                    :aria-label="'将 ' + product.name + ' 下移'"
                    :disabled="index === featured.length - 1 || saving || loadPending"
                    @click="moveProduct(index, 1)"
                  />
                  <UButton
                    color="error"
                    variant="ghost"
                    icon="i-lucide-x"
                    size="sm"
                    class="min-h-11 min-w-11"
                    :aria-label="'移除 ' + product.name"
                    :disabled="saving || loadPending"
                    @click="removeProduct(product.id)"
                  />
                </div>
              </li>
            </ol>

            <template #footer>
              <div class="flex flex-wrap items-center gap-3">
                <UButton
                  icon="i-lucide-save"
                  class="min-h-11 min-w-32"
                  :loading="saving"
                  :disabled="!canSave"
                  @click="saveFeaturedProducts"
                >
                  保存推荐
                </UButton>
                <span
                  v-if="loadPending"
                  class="text-sm text-muted"
                  role="status"
                >
                  正在加载…
                </span>
              </div>
            </template>
          </UCard>

          <UCard>
            <template #header>
              <div>
                <h2 class="text-lg font-semibold text-highlighted">
                  选择在售商品
                </h2>
                <p class="mt-1 text-sm leading-6 text-muted">
                  搜索商品名称、SKU 或商品 ID。暂停、归档和草稿商品不能新增为推荐。
                </p>
              </div>
            </template>

            <form
              class="flex flex-col gap-3 sm:flex-row"
              @submit.prevent="loadProducts(1)"
            >
              <UInput
                v-model="searchInput"
                class="min-w-0 flex-1"
                aria-label="搜索在售商品"
                maxlength="120"
                placeholder="输入商品名称、SKU 或商品 ID"
                :disabled="searchPending"
              />
              <UButton
                type="submit"
                icon="i-lucide-search"
                class="min-h-11"
                :loading="searchPending"
                :disabled="loadPending"
              >
                搜索
              </UButton>
            </form>

            <UAlert
              v-if="searchError"
              class="mt-4"
              color="error"
              variant="soft"
              :title="searchError"
              role="alert"
            />

            <div
              v-if="searchPending || !searchLoaded"
              class="py-8 text-center text-sm text-muted"
              role="status"
            >
              正在加载在售商品…
            </div>
            <UEmpty
              v-else-if="!searchError && productResults.length === 0"
              icon="i-lucide-package-search"
              title="没有找到在售商品"
              description="尝试其他名称、SKU 或商品 ID。"
              variant="naked"
              size="sm"
              class="min-h-40"
            />
            <ul
              v-else-if="productResults.length"
              class="mt-4 grid gap-3"
              aria-label="在售商品搜索结果"
            >
              <li
                v-for="product in productResults"
                :key="product.id"
                class="flex min-w-0 items-center gap-3 rounded-xl border border-default p-3"
              >
                <img
                  v-if="product.coverImage"
                  :src="product.coverImage.thumbnailUrl"
                  alt=""
                  aria-hidden="true"
                  class="size-14 shrink-0 rounded-lg bg-muted object-cover"
                  width="56"
                  height="56"
                >
                <div
                  v-else
                  class="grid size-14 shrink-0 place-items-center rounded-lg bg-muted text-muted"
                  aria-hidden="true"
                >
                  <UIcon
                    name="i-lucide-image"
                    class="size-5"
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <p class="break-words font-medium text-highlighted">
                    {{ product.name }}
                  </p>
                  <div class="mt-1 flex flex-wrap items-center gap-2">
                    <UBadge
                      color="neutral"
                      variant="subtle"
                      size="xs"
                    >
                      {{ productTypeLabels[product.productType] }}
                    </UBadge>
                    <UBadge
                      color="success"
                      variant="subtle"
                      size="xs"
                    >
                      {{ statusLabels[product.status] }}
                    </UBadge>
                  </div>
                </div>
                <UButton
                  :icon="featured.some(item => item.id === product.id) ? 'i-lucide-check' : 'i-lucide-plus'"
                  :aria-label="featured.some(item => item.id === product.id) ? product.name + ' 已在推荐中' : '推荐 ' + product.name"
                  :disabled="featured.some(item => item.id === product.id) || featured.length >= 8 || product.status !== 'active' || saving || loadPending"
                  :color="featured.some(item => item.id === product.id) ? 'neutral' : 'primary'"
                  variant="soft"
                  class="min-h-11"
                  @click="addProduct(product)"
                >
                  {{ featured.some(item => item.id === product.id) ? '已推荐' : '添加' }}
                </UButton>
              </li>
            </ul>

            <template #footer>
              <div class="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
                <span>
                  {{ resultTotal ? '共 ' + resultTotal + ' 件在售商品' : '仅显示在售商品' }}
                </span>
                <div
                  v-if="totalPages > 1"
                  class="flex items-center gap-2"
                >
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="sm"
                    class="min-h-11"
                    :disabled="resultPage <= 1 || searchPending"
                    @click="loadProducts(resultPage - 1)"
                  >
                    上一页
                  </UButton>
                  <span class="tabular-nums">{{ resultPage }} / {{ totalPages }}</span>
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="sm"
                    class="min-h-11"
                    :disabled="resultPage >= totalPages || searchPending"
                    @click="loadProducts(resultPage + 1)"
                  >
                    下一页
                  </UButton>
                </div>
              </div>
            </template>
          </UCard>
        </div>
      </main>
    </template>
  </UDashboardPanel>
</template>
