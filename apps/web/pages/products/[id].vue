<script setup lang="ts">
import type { ApiSuccess, CheckoutQuote, CheckoutQuoteItem, PublicInventorySummary, PublicProductDetail, PublicProductVariant } from '@aikayun/contracts'

const route = useRoute()
const siteUrl = usePublicSiteUrl()
useUncachedPublicPage()
const id = computed(() => String(route.params.id ?? ''))
const asyncDataKey = computed(() => `public-product-detail-${id.value}`)
const { data: fetchedData, error, status, refresh } = await useAsyncData(
  asyncDataKey,
  async (_nuxtApp, { signal }) => {
    try {
      return (await $fetch<ApiSuccess<PublicProductDetail>>(`/api/v1/public/products/${encodeURIComponent(id.value)}`, { signal })).data
    }
    catch (cause) {
      // FetchError.data contains the upstream body; keep it out of Nuxt payloads.
      return throwSafePublicApiError(cause, signal)
    }
  },
  { default: () => null, deep: false, getCachedData: (key, nuxtApp) => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : undefined },
)
const product = computed(() => fetchedData.value?.id === id.value ? fetchedData.value : null)
const responseStatus = computed(() => Number((error.value as { statusCode?: number; status?: number } | null)?.statusCode ?? (error.value as { status?: number } | null)?.status ?? 0))
const isValidProductId = computed(() => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id.value))
const notFound = computed(() => responseStatus.value === 404 || (!isValidProductId.value && Boolean(id.value)))
const productTypeLabels = { physical: '实物商品', digital: '数字商品', service: '服务商品' } as const
const selections = reactive<Record<string, string>>({})
const selectedImage = ref(0)
const imageFailed = ref(false)
const quantity = ref(1)
const shoppingCart = useShoppingCart()
const customerApi = useCustomerApi()
const cartFeedback = ref('')
const purchaseQuote = ref<CheckoutQuote | null>(null)
const purchaseQuoteError = ref('')
const purchaseQuoteBusy = ref(false)
let purchaseQuoteSequence = 0
const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))

watch(product, (value) => {
  for (const key of Object.keys(selections)) delete selections[key]
  if (value?.optionGroups.length === 0 && value.variants.length === 1) {
    // A single no-spec SKU is unambiguous and may be selected automatically.
  }
  selectedImage.value = 0
  imageFailed.value = false
  quantity.value = 1
}, { immediate: true })

const selectedVariant = computed<PublicProductVariant | null>(() => {
  const current = product.value
  if (!current) return null
  if (current.optionGroups.length === 0) return current.variants.length === 1 ? current.variants[0]! : null
  if (!current.optionGroups.every(group => selections[group.id])) return null
  return current.variants.find(variant => current.optionGroups.every((group) => {
    const option = variant.options.find(candidate => candidate.groupId === group.id)
    return option?.valueId === selections[group.id]
  })) ?? null
})
const selectedPurchaseQuote = computed<CheckoutQuoteItem | null>(() =>
  purchaseQuote.value?.items.find(item => item.skuId === selectedVariant.value?.skuId) ?? null,
)
const selectedPurchaseItems = computed(() => selectedVariant.value
  ? [{ skuId: selectedVariant.value.skuId, quantity: quantity.value }]
  : [])
const purchaseLoginPath = computed(() => {
  const intent = shoppingCart.checkoutPath(selectedPurchaseItems.value)
  return `/login?redirect=${encodeURIComponent(intent)}`
})

function optionHasVariant(groupId: string, valueId: string): boolean {
  const current = product.value
  if (!current) return false
  const candidate = { ...selections, [groupId]: valueId }
  const matchesCurrentSelection = current.variants.some(variant => current.optionGroups.every((group) => {
    const requested = candidate[group.id]
    if (!requested) return true
    return variant.options.some(option => option.groupId === group.id && option.valueId === requested)
  }))
  if (matchesCurrentSelection) return true
  // Let customers change an already selected group; dependent selections will be cleared if needed.
  return Boolean(selections[groupId]) && current.variants.some(variant =>
    variant.options.some(option => option.groupId === groupId && option.valueId === valueId),
  )
}

function selectOption(groupId: string, valueId: string): void {
  const current = product.value
  if (!current) return
  const candidate = { ...selections, [groupId]: valueId }
  const completeCombinationExists = current.variants.some(variant => current.optionGroups.every((group) => {
    const requested = candidate[group.id]
    return !requested || variant.options.some(option => option.groupId === group.id && option.valueId === requested)
  }))

  if (!completeCombinationExists) {
    for (const selectedGroupId of Object.keys(selections)) delete selections[selectedGroupId]
  }
  selections[groupId] = valueId
}

function inventoryLabel(inventory: PublicInventorySummary | undefined): string {
  if (!inventory) return '请选择规格'
  if (inventory.mode === 'quantity') return inventory.status === 'in_stock' ? '有货' : '暂时缺货'
  if (inventory.mode === 'resource_pool' || inventory.mode === 'external') return '供货能力尚未就绪'
  if (inventory.mode === 'unlimited') return '数量不限，交付能力尚未开放'
  return '库存尚未配置'
}

async function refreshPurchaseQuote(): Promise<void> {
  const sequence = ++purchaseQuoteSequence
  const variant = selectedVariant.value
  purchaseQuote.value = null
  purchaseQuoteError.value = ''
  if (!variant || !import.meta.client) {
    purchaseQuoteBusy.value = false
    return
  }
  purchaseQuoteBusy.value = true
  try {
    const result = await shoppingCart.quote([{ skuId: variant.skuId, quantity: quantity.value }])
    if (sequence === purchaseQuoteSequence) purchaseQuote.value = result
  } catch (error) {
    if (sequence === purchaseQuoteSequence) {
      purchaseQuoteError.value = error instanceof Error ? error.message : '限购额度暂时无法读取。'
    }
  } finally {
    if (sequence === purchaseQuoteSequence) purchaseQuoteBusy.value = false
  }
}

watch([() => selectedVariant.value?.skuId, quantity, () => customerApi.identityVersion.value], () => {
  if (import.meta.client) void refreshPurchaseQuote()
})

onMounted(() => { void refreshPurchaseQuote() })

const selectedImageItem = computed(() => product.value?.gallery[selectedImage.value] ?? null)
const pageTitle = computed(() => product.value?.name ?? '商品详情')
const pageDescription = computed(() => product.value?.description || `${product.value?.name ?? '商品'}的商品详情。`)
const primaryCategory = computed(() => product.value?.categories.find(category => category.isPrimary) ?? product.value?.categories[0])
const structuredData = computed(() => {
  const current = product.value
  if (!current) return ''
  const value = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: current.name,
    description: current.description || undefined,
    image: current.gallery.map(image => siteUrl(image.url)),
    category: primaryCategory.value?.path.map(item => item.name).join(' / '),
    additionalProperty: current.attributes.map(attribute => ({
      '@type': 'PropertyValue',
      name: attribute.name,
      value: attribute.value,
    })),
  }
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' })[character] ?? character)
})

useSeoMeta({
  title: pageTitle,
  description: pageDescription,
  ogTitle: pageTitle,
  ogDescription: pageDescription,
  ogImage: computed(() => selectedImageItem.value ? siteUrl(selectedImageItem.value.url) : undefined),
  ogUrl: computed(() => siteUrl(`/products/${encodeURIComponent(id.value)}`)),
  twitterCard: 'summary_large_image',
  robots: computed(() => product.value ? 'index, follow' : 'noindex, nofollow'),
})
useHead(() => ({
  link: [{ rel: 'canonical', href: siteUrl(`/products/${encodeURIComponent(id.value)}`) }],
  script: structuredData.value ? [{ type: 'application/ld+json', innerHTML: structuredData.value }] : [],
}))

if (import.meta.server && !isValidProductId.value) {
  await navigateTo('/', { redirectCode: 302, replace: true })
}
else if (import.meta.server && notFound.value) {
  await navigateTo('/', { redirectCode: 302, replace: true })
}
else if (import.meta.server && error.value) {
  setPublicPageFailureStatus(error.value)
}

let handledMissingId = ''
watch([id, notFound], async ([currentId, missing]) => {
  if (import.meta.client && missing && currentId !== handledMissingId) {
    handledMissingId = currentId
    await navigateTo('/', { replace: true })
  }
}, { flush: 'post' })

const galleryPath = computed(() => product.value?.gallery ?? [])
const typeLabel = computed(() => product.value ? productTypeLabels[product.value.productType] : '')

async function addSelectedToCart() {
  if (!selectedVariant.value || shoppingCart.busy.value) return
  cartFeedback.value = ''
  await shoppingCart.add(selectedVariant.value.skuId, quantity.value)
  cartFeedback.value = shoppingCart.errorMessage.value ?? shoppingCart.noticeMessage.value ?? ''
}

async function buySelectedNow() {
  if (!selectedVariant.value || shoppingCart.busy.value) return
  cartFeedback.value = ''
  await navigateTo(shoppingCart.checkoutPath([{ skuId: selectedVariant.value.skuId, quantity: quantity.value }]))
}
</script>

<template>
  <main id="main-content">
    <UContainer class="py-5 sm:py-8">
      <template v-if="product">
        <nav
          aria-label="面包屑"
          class="mb-5 min-w-0 overflow-x-auto text-sm text-muted"
        >
          <ol class="flex min-w-max items-center gap-2">
            <li>
              <NuxtLink
                to="/"
                class="hover:text-primary"
              >
                全部商品
              </NuxtLink>
            </li>
            <li
              v-if="primaryCategory"
              class="flex items-center gap-2"
            >
              <span aria-hidden="true">/</span><NuxtLink
                :to="`/categories/${primaryCategory.id}`"
                class="hover:text-primary"
              >
                {{ primaryCategory.name }}
              </NuxtLink>
            </li>
            <li class="flex items-center gap-2">
              <span aria-hidden="true">/</span><span
                class="max-w-[60vw] truncate text-highlighted"
                aria-current="page"
              >{{ product.name }}</span>
            </li>
          </ol>
        </nav>

        <div class="grid min-w-0 gap-7 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)] lg:gap-10">
          <section
            aria-label="商品图片"
            class="min-w-0"
          >
            <div class="relative aspect-[4/3] overflow-hidden rounded-xl border border-default bg-muted sm:aspect-[5/4]">
              <img
                v-if="selectedImageItem && !imageFailed"
                :src="selectedImageItem.url"
                :alt="selectedImageItem.alt || product.name"
                :width="selectedImageItem.width"
                :height="selectedImageItem.height"
                fetchpriority="high"
                decoding="async"
                class="h-full w-full object-contain"
                @error="imageFailed = true"
              >
              <div
                v-else
                class="flex h-full items-center justify-center text-muted"
                aria-label="暂无可展示图片"
              >
                <UIcon
                  name="i-lucide-image"
                  class="size-12"
                />
              </div>
            </div>
            <div
              v-if="galleryPath.length > 1"
              class="mt-3 flex gap-2 overflow-x-auto pb-1"
              aria-label="选择商品图片"
            >
              <button
                v-for="(image, index) in galleryPath"
                :key="image.url"
                type="button"
                class="size-16 shrink-0 overflow-hidden rounded-lg border bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:size-20"
                :class="selectedImage === index ? 'border-primary ring-2 ring-primary/30' : 'border-default'"
                :aria-label="`查看第 ${index + 1} 张商品图片`"
                :aria-pressed="selectedImage === index"
                @click="selectedImage = index; imageFailed = false"
              >
                <img
                  :src="image.thumbnailUrl"
                  :alt="''"
                  width="80"
                  height="80"
                  loading="lazy"
                  decoding="async"
                  class="h-full w-full object-cover"
                  @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
                >
              </button>
            </div>
          </section>

          <section class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <UBadge
                color="primary"
                variant="soft"
              >
                {{ typeLabel }}
              </UBadge>
              <UBadge
                v-if="product.selectionStatus === 'none'"
                color="neutral"
                variant="soft"
              >
                暂无可选规格
              </UBadge>
            </div>
            <h1 class="mt-3 break-words text-2xl font-semibold leading-tight text-highlighted sm:text-3xl">
              {{ product.name }}
            </h1>
            <p
              v-if="product.description"
              class="mt-3 whitespace-pre-line break-words text-sm leading-6 text-muted sm:text-base"
            >
              {{ product.description }}
            </p>

            <div class="mt-5 rounded-xl border border-default bg-elevated p-4 sm:p-5">
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p class="text-2xl font-semibold tabular-nums text-primary sm:text-3xl">
                  <template v-if="selectedVariant">
                    ¥{{ selectedVariant.salePrice }}
                  </template>
                  <template v-else-if="product.priceRange">
                    ¥{{ product.priceRange.min }}<span
                      v-if="product.priceRange.min !== product.priceRange.max"
                      class="text-base font-medium text-muted"
                    > 起</span>
                  </template>
                  <span
                    v-else
                    class="text-base font-medium text-muted"
                  >暂无可选售价</span>
                </p>
                <del
                  v-if="selectedVariant?.compareAtPrice"
                  class="text-sm tabular-nums text-muted"
                >¥{{ selectedVariant.compareAtPrice }}</del>
              </div>

              <div
                v-if="product.optionGroups.length"
                class="mt-5 space-y-5"
              >
                <fieldset
                  v-for="group in product.optionGroups"
                  :key="group.id"
                  class="min-w-0"
                >
                  <legend class="mb-2 text-sm font-medium text-highlighted">
                    {{ group.name }}
                  </legend>
                  <div class="flex flex-wrap gap-2">
                    <button
                      v-for="value in group.values"
                      :key="value.id"
                      type="button"
                      class="min-h-11 max-w-full rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none"
                      :class="[
                        selections[group.id] === value.id ? 'border-primary bg-primary/10 text-highlighted' : 'border-default bg-default text-highlighted hover:bg-muted',
                        !optionHasVariant(group.id, value.id) ? 'cursor-not-allowed opacity-45' : '',
                      ]"
                      :disabled="!optionHasVariant(group.id, value.id)"
                      :aria-pressed="selections[group.id] === value.id"
                      @click="selectOption(group.id, value.id)"
                    >
                      {{ value.name }}
                    </button>
                  </div>
                </fieldset>
                <p
                  v-if="!selectedVariant"
                  class="text-sm text-muted"
                  aria-live="polite"
                >
                  请选择完整规格以查看对应价格和供货状态。
                </p>
                <UButton
                  v-if="Object.keys(selections).some(groupId => selections[groupId])"
                  color="neutral"
                  variant="link"
                  size="sm"
                  @click="Object.keys(selections).forEach(groupId => delete selections[groupId])"
                >
                  清除规格选择
                </UButton>
              </div>
              <div
                v-else
                class="mt-4 text-sm text-muted"
              >
                {{ selectedVariant ? '当前仅有一种规格。' : '暂无可选规格。' }}
              </div>

              <div class="mt-5 border-t border-default pt-4">
                <p class="text-sm font-medium text-highlighted">
                  供货状态
                </p>
                <p
                  class="mt-1 text-sm text-muted"
                  aria-live="polite"
                >
                  {{ inventoryLabel(selectedVariant?.inventory) }}
                </p>
              </div>
              <div
                v-if="selectedVariant"
                class="mt-4 grid gap-3"
              >
                <UFormField
                  label="购买数量"
                  name="quantity"
                >
                  <div class="flex w-fit items-center rounded-lg border border-default">
                    <UButton
                      type="button"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-minus"
                      aria-label="减少数量"
                      class="min-h-11 min-w-11 justify-center"
                      :disabled="quantity <= 1 || shoppingCart.busy.value"
                      @click="quantity = Math.max(1, quantity - 1)"
                    />
                    <UInput
                      v-model.number="quantity"
                      type="number"
                      min="1"
                      max="99"
                      inputmode="numeric"
                      aria-label="购买数量"
                      class="w-20 text-center tabular-nums"
                      :disabled="shoppingCart.busy.value"
                      @change="quantity = Math.min(99, Math.max(1, Math.trunc(quantity || 1)))"
                    />
                    <UButton
                      type="button"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-plus"
                      aria-label="增加数量"
                      class="min-h-11 min-w-11 justify-center"
                      :disabled="quantity >= 99 || shoppingCart.busy.value"
                      @click="quantity = Math.min(99, quantity + 1)"
                    />
                  </div>
                </UFormField>
                <StorefrontPurchaseLimitNotice
                  :purchase-limits="selectedPurchaseQuote?.purchaseLimits"
                  :product-rules="product.purchaseLimits"
                  :sku-rules="selectedVariant.purchaseLimits"
                  :authenticated="isCustomer"
                />
                <p
                  v-if="purchaseQuoteBusy"
                  class="text-xs text-muted"
                  aria-live="polite"
                >
                  正在读取当前账号的限购额度…
                </p>
                <p
                  v-else-if="purchaseQuoteError"
                  class="text-sm text-warning"
                  role="status"
                >
                  {{ purchaseQuoteError }}
                </p>
                <NuxtLink
                  v-if="selectedPurchaseQuote?.purchaseLimits.requiresLogin || (!isCustomer && (product.purchaseLimits.lifetime || product.purchaseLimits.rolling24Hours || selectedVariant.purchaseLimits.lifetime || selectedVariant.purchaseLimits.rolling24Hours))"
                  :to="purchaseLoginPath"
                  class="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-2"
                >
                  登录后继续购买
                </NuxtLink>
                <div class="grid gap-2 sm:grid-cols-2">
                  <UButton
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-shopping-cart"
                    :loading="shoppingCart.busy.value"
                    :disabled="!selectedVariant || quantity < 1 || quantity > 99"
                    @click="addSelectedToCart"
                  >
                    加入购物车
                  </UButton>
                  <UButton
                    color="primary"
                    icon="i-lucide-arrow-right"
                    :disabled="!selectedVariant || quantity < 1 || quantity > 99 || shoppingCart.busy.value || purchaseQuoteBusy || (selectedPurchaseQuote !== null && !selectedPurchaseQuote.canPurchase)"
                    @click="buySelectedNow"
                  >
                    立即购买
                  </UButton>
                </div>
                <p
                  v-if="cartFeedback || shoppingCart.errorMessage.value"
                  class="text-sm text-warning"
                  role="status"
                  aria-live="polite"
                >
                  {{ cartFeedback || shoppingCart.errorMessage.value }}
                  <NuxtLink
                    to="/cart"
                    class="ml-1 font-medium text-primary underline underline-offset-2"
                  >
                    查看购物车
                  </NuxtLink>
                </p>
              </div>
              <UAlert
                color="neutral"
                variant="subtle"
                icon="i-lucide-info"
                title="当前仅提供结算报价预览"
                description="商品、库存和人工数字交付资格会在报价及下单事务中重新校验。正价订单当前仅创建为待付款，不显示未接入的支付操作。"
                class="mt-5"
              />
            </div>

            <section
              v-if="product.attributes.length"
              aria-labelledby="product-attributes-title"
              class="mt-6"
            >
              <h2
                id="product-attributes-title"
                class="text-base font-semibold text-highlighted"
              >
                商品信息
              </h2>
              <dl class="mt-3 divide-y divide-default rounded-xl border border-default">
                <div
                  v-for="attribute in product.attributes"
                  :key="`${attribute.name}:${attribute.value}`"
                  class="grid grid-cols-[minmax(5rem,0.7fr)_minmax(0,1.3fr)] gap-3 px-3 py-3 text-sm sm:px-4"
                >
                  <dt class="break-words text-muted">
                    {{ attribute.name }}
                  </dt>
                  <dd class="break-words text-highlighted">
                    {{ attribute.value }}
                  </dd>
                </div>
              </dl>
            </section>

            <section
              v-if="product.categories.length"
              aria-labelledby="product-categories-title"
              class="mt-6"
            >
              <h2
                id="product-categories-title"
                class="text-sm font-medium text-highlighted"
              >
                商品分类
              </h2>
              <div class="mt-2 flex flex-wrap gap-2">
                <NuxtLink
                  v-for="category in product.categories"
                  :key="category.id"
                  :to="`/categories/${category.id}`"
                  class="inline-flex min-h-10 items-center rounded-full border border-default px-3 text-sm text-muted hover:border-primary/40 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {{ category.path.map(item => item.name).join(' / ') }}
                </NuxtLink>
              </div>
            </section>
          </section>
        </div>

        <section
          v-if="product.richContentHtml"
          aria-labelledby="product-description-title"
          class="mt-10 border-t border-default pt-7 sm:mt-12 sm:pt-9"
        >
          <h2
            id="product-description-title"
            class="text-xl font-semibold text-highlighted"
          >
            商品详情
          </h2>
          <!-- eslint-disable vue/no-v-html -- Public HTML comes only from the shared validated D5 JSON converter. -->
          <div
            class="product-rich-content mt-5 min-w-0 max-w-4xl break-words text-base leading-7 text-default"
            v-html="product.richContentHtml"
          />
          <!-- eslint-enable vue/no-v-html -->
        </section>
      </template>

      <div
        v-else-if="status === 'pending'"
        class="grid min-h-[32rem] gap-6 lg:grid-cols-2"
        aria-label="正在加载商品详情"
      >
        <div class="aspect-[4/3] animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        <div class="space-y-4">
          <div class="h-8 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" /><div class="h-24 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        </div>
      </div>
      <UAlert
        v-else-if="error && !notFound"
        color="error"
        variant="subtle"
        title="商品暂时无法加载"
        description="请检查网络后重试。"
        :actions="[{ label: '重试', onClick: () => refresh() }]"
      />
    </UContainer>
  </main>
</template>

<style>
.product-rich-content {
  overflow-wrap: anywhere;
}

.product-rich-content img {
  max-width: 100%;
  height: auto;
  border-radius: 0.75rem;
}

.product-rich-content p,
.product-rich-content ul,
.product-rich-content ol,
.product-rich-content blockquote,
.product-rich-content h2,
.product-rich-content h3 {
  margin-block: 1rem;
}

.product-rich-content ul,
.product-rich-content ol {
  padding-inline-start: 1.5rem;
}

.product-rich-content ul { list-style: disc; }
.product-rich-content ol { list-style: decimal; }
.product-rich-content blockquote {
  border-inline-start: 3px solid var(--ui-primary);
  padding-inline-start: 1rem;
  color: var(--ui-text-muted);
}

.product-rich-content a {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
</style>
