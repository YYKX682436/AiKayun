<script setup lang="ts">
import type { CartSkuQuantity, CheckoutQuote, CheckoutQuoteItem, CheckoutRequestLineV2 } from '@aikayun/contracts'

const customerApi = useCustomerApi()
const shoppingCart = useShoppingCart()
const selectedLineKeys = ref<string[]>([])
const selectedQuote = ref<CheckoutQuote | null>(null)
const quoteError = ref('')
const checkoutError = ref('')
const quoteBusy = ref(false)
const checkoutPreparing = ref(false)
let quoteSequence = 0
let selectionInitialized = false

useSeoMeta({ title: '购物车', description: '查看购物车商品和当前结算报价。', robots: 'noindex, nofollow' })

const items = computed(() => shoppingCart.cartView.value?.items ?? [])
const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
const isEmpty = computed(() => shoppingCart.ready.value && items.value.length === 0)
function lineKey(item: CheckoutQuoteItem): string {
  return item.lineId ?? `legacy:${item.skuId}`
}

function purchaseEditPath(item: CheckoutQuoteItem): string {
  if (!item.productId) return '/cart'
  const query = new URLSearchParams({ skuId: item.skuId, quantity: String(item.quantity) })
  if (item.lineId) query.set('editLineId', item.lineId)
  if (item.lineRevision !== null) query.set('lineRevision', String(item.lineRevision))
  if (item.draftRevision !== null) query.set('expectedDraftRevision', String(item.draftRevision))
  if (item.draftId) query.set('draftId', item.draftId)
  return `/products/${encodeURIComponent(item.productId)}?${query.toString()}`
}

const selectedItems = computed(() => items.value.filter(item => selectedLineKeys.value.includes(lineKey(item))))
const selectedCount = computed(() => selectedItems.value.reduce((total, item) => total + item.quantity, 0))
const selectedQuoteItems = computed<CartSkuQuantity[] | CheckoutRequestLineV2[] | null>(() => {
  if (!selectedItems.value.length) return []
  if (selectedItems.value.every(item => item.lineId === null)) {
    return selectedItems.value.map(item => ({ skuId: item.skuId, quantity: item.quantity }))
  }
  if (selectedItems.value.some(item => !item.lineId || (item.draftId === null) !== (item.draftRevision === null))) return null
  return selectedItems.value.map(item => ({
    lineId: item.lineId!, skuId: item.skuId, quantity: item.quantity,
    draftId: item.draftId, draftRevision: item.draftRevision,
  }))
})
// Legacy guest rows require a Web Lock migration before entering v2 checkout.
// Their fallback link stays on the cart; ordinary clicks use openCheckout.
const checkoutPath = computed(() => selectedQuoteItems.value?.length
  && selectedQuoteItems.value.every(item => 'lineId' in item)
  ? shoppingCart.checkoutPath(selectedQuoteItems.value)
  : '/cart')
const purchaseLoginRedirect = computed(() => `/login?redirect=${encodeURIComponent(checkoutPath.value)}`)
const purchaseLoginRequired = computed(() => !isCustomer.value
  && Boolean(selectedQuote.value?.items.some(item => item.purchaseLimits.requiresLogin)))

function statusLabel(item: CheckoutQuoteItem): string {
  switch (item.reason) {
    case 'product_not_found':
    case 'sku_not_found': return '商品规格已不存在'
    case 'product_not_active': return item.productStatus === 'paused' ? '商品已暂停' : item.productStatus === 'archived' ? '商品已归档' : '商品暂不可购买'
    case 'sku_disabled': return '此规格已停用'
    case 'sku_retired': return '此规格已永久退役'
    case 'specification_invalid': return '规格组合已变化，请重新选择'
    case 'inventory_not_configured': return '库存尚未配置'
    case 'insufficient_inventory': return `库存不足，当前可售 ${item.availableQuantity ?? 0} 件`
    case 'inventory_not_ready': return '此库存来源尚未就绪'
    case 'fulfillment_not_ready': return '当前发货能力尚未开放'
    case 'guest_checkout_disabled': return '游客结算未开放，请登录'
    case 'guest_free_claim_disabled': return '游客领取免费商品未开放，请登录'
    case 'purchase_limit_exceeded': return '超过商品或规格限购额度'
    case 'login_required_for_purchase_limit': return '该商品需要登录后购买'
    case 'purchase_form_invalid': return '购买资料已失效，请重新确认'
    case 'purchase_form_version_changed': return '填写模板已变化，请重新确认'
    case 'purchase_form_required': return '此商品需要填写购买资料'
    case 'purchase_forms_paused': return '填写商品已暂停新订单'
    default: return item.canPurchase ? '可继续报价' : '暂不可购买'
  }
}

function selectionChanged(key: string, checked: boolean): void {
  selectedLineKeys.value = checked
    ? [...new Set([...selectedLineKeys.value, key])]
    : selectedLineKeys.value.filter(id => id !== key)
}

function selectAll(checked: boolean): void {
  selectedLineKeys.value = checked ? items.value.map(lineKey) : []
}

async function openCheckout(loginFirst = false): Promise<void> {
  const selection = selectedQuoteItems.value
  if (checkoutPreparing.value || !selection?.length) return
  const identityAtStart = customerApi.identityVersion.value
  checkoutPreparing.value = true
  checkoutError.value = ''
  try {
    const path = await shoppingCart.prepareCheckoutPath(selection)
    if (identityAtStart !== customerApi.identityVersion.value) return
    if (path === '/cart') throw new Error('结算选择未能安全保存，请重试。')
    await navigateTo(loginFirst ? `/login?redirect=${encodeURIComponent(path)}` : path)
  } catch (error) {
    if (identityAtStart === customerApi.identityVersion.value) {
      checkoutError.value = error instanceof Error ? error.message : '无法安全准备结算，请重试。'
    }
  } finally {
    checkoutPreparing.value = false
  }
}

watch(items, (value) => {
  if (!value.length && shoppingCart.guestItems.value.length && !isCustomer.value) return
  const currentIds = new Set(value.map(lineKey))
  selectedLineKeys.value = [...new Set(selectedLineKeys.value.map(shoppingCart.resolveLineKey))]
    .filter(id => currentIds.has(id))
  if (!selectionInitialized && value.length) {
    selectedLineKeys.value = value.map(lineKey)
    selectionInitialized = true
  }
}, { immediate: true })

watch(selectedQuoteItems, async (value) => {
  const sequence = ++quoteSequence
  quoteError.value = ''
  checkoutError.value = ''
  if (!value?.length) {
    selectedQuote.value = null
    quoteBusy.value = false
    if (value === null) quoteError.value = '所选购买行身份已失效，请刷新购物车。'
    return
  }
  quoteBusy.value = true
  try {
    const result = await shoppingCart.quote(value)
    if (sequence === quoteSequence) selectedQuote.value = result
  } catch (error) {
    if (sequence === quoteSequence) {
      quoteError.value = error instanceof Error ? error.message : '所选商品报价暂时无法加载。'
      selectedQuote.value = null
    }
  } finally {
    if (sequence === quoteSequence) quoteBusy.value = false
  }
}, { deep: true })

watch(() => customerApi.identityVersion.value, () => {
  quoteSequence += 1
  selectedQuote.value = null
  quoteError.value = ''
  checkoutError.value = ''
  quoteBusy.value = false
}, { flush: 'sync' })

onMounted(() => {
  if (!shoppingCart.ready.value) void shoppingCart.syncSession()
})
</script>

<template>
  <UContainer class="py-6 sm:py-10">
    <main
      id="main-content"
      class="mx-auto max-w-6xl"
    >
      <nav
        aria-label="面包屑"
        class="mb-4 min-w-0 text-xs sm:text-sm text-muted"
      >
        <ol class="flex items-center gap-1.5 sm:gap-2">
          <li>
            <NuxtLink
              to="/"
              class="transition-colors hover:text-primary"
            >
              首页
            </NuxtLink>
          </li>
          <li class="flex items-center gap-1.5 sm:gap-2">
            <span
              aria-hidden="true"
              class="text-muted/40"
            >/</span>
            <span
              class="font-medium text-highlighted"
              aria-current="page"
            >购物车</span>
          </li>
        </ol>
      </nav>

      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold tracking-tight text-highlighted sm:text-3xl">
            购物车
          </h1>
          <p class="mt-1 text-xs sm:text-sm text-muted">
            价格与库存将在报价时实时核对
          </p>
        </div>
        <NuxtLink
          to="/search"
          class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-default/70 bg-elevated/60 px-3.5 py-2 text-xs sm:text-sm font-medium text-muted shadow-2xs backdrop-blur-xs transition-all hover:border-default hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <UIcon
            name="i-lucide-search"
            class="size-4"
            aria-hidden="true"
          />
          继续选购
        </NuxtLink>
      </div>

      <UAlert
        v-if="shoppingCart.errorMessage.value"
        class="mt-6 rounded-2xl border border-error/30 bg-error/5 shadow-xs"
        color="error"
        variant="subtle"
        title="购物车暂时无法同步"
        :description="shoppingCart.errorMessage.value"
        role="alert"
        aria-live="assertive"
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="sm"
            class="rounded-lg"
            :loading="shoppingCart.busy.value"
            @click="shoppingCart.refresh()"
          >
            重试
          </UButton>
        </template>
      </UAlert>
      <UAlert
        v-if="shoppingCart.noticeMessage.value"
        class="mt-4 rounded-2xl border border-success/30 bg-success/5 shadow-xs"
        color="success"
        variant="subtle"
        :title="shoppingCart.noticeMessage.value"
        role="status"
        aria-live="polite"
      />

      <div
        v-if="!shoppingCart.ready.value"
        class="mt-6 space-y-4"
        aria-label="正在加载购物车"
        aria-busy="true"
      >
        <div
          v-for="index in 3"
          :key="index"
          class="h-32 animate-pulse rounded-2xl border border-default/60 bg-elevated/40 motion-reduce:animate-none"
        />
      </div>

      <section
        v-else-if="isEmpty"
        class="mt-8 rounded-2xl border border-dashed border-default/80 bg-elevated/40 px-5 py-16 text-center shadow-xs backdrop-blur-xs sm:py-24"
      >
        <div class="mx-auto flex size-16 items-center justify-center rounded-2xl border border-default/60 bg-muted/30 text-muted/70 shadow-2xs">
          <UIcon
            name="i-lucide-shopping-basket"
            class="size-8 stroke-[1.4]"
            aria-hidden="true"
          />
        </div>
        <h2 class="mt-4 text-lg font-semibold tracking-tight text-highlighted sm:text-xl">
          购物车还是空的
        </h2>
        <p class="mt-1.5 text-xs sm:text-sm text-muted">
          挑选心仪商品后，它们会显示在这里
        </p>
        <UButton
          to="/search"
          color="primary"
          size="lg"
          class="mt-6 rounded-xl px-6 font-medium shadow-xs"
        >
          浏览商品
        </UButton>
      </section>

      <div
        v-else-if="shoppingCart.ready.value"
        class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start xl:gap-8"
      >
        <section
          aria-label="购物车商品"
          class="min-w-0"
        >
          <div class="mb-3.5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-default/60 bg-elevated/50 px-3.5 py-2.5 shadow-2xs backdrop-blur-xs sm:px-4 sm:py-3">
            <label class="inline-flex min-h-8 cursor-pointer items-center gap-2.5 text-xs sm:text-sm font-medium text-highlighted select-none">
              <input
                type="checkbox"
                class="size-4 rounded accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary cursor-pointer"
                :checked="items.length > 0 && selectedLineKeys.length === items.length"
                :indeterminate="selectedLineKeys.length > 0 && selectedLineKeys.length < items.length"
                aria-label="全选购物车商品"
                @change="selectAll(($event.target as HTMLInputElement).checked)"
              >
              全选（{{ items.length }} 件商品）
            </label>
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-trash-2"
              class="text-xs text-muted hover:text-error transition-colors"
              :disabled="shoppingCart.busy.value"
              @click="shoppingCart.clear()"
            >
              清空购物车
            </UButton>
          </div>

          <ul class="space-y-3.5">
            <li
              v-for="(item, index) in items"
              :key="lineKey(item)"
              class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3.5 rounded-2xl border border-default/70 bg-elevated/70 p-4 shadow-xs backdrop-blur-xs transition-all hover:border-default sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-4 sm:p-5"
            >
              <div class="flex items-start pt-1 sm:pt-0.5">
                <input
                  type="checkbox"
                  class="size-4.5 rounded accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary cursor-pointer"
                  :checked="selectedLineKeys.includes(lineKey(item))"
                  :aria-label="`选择${item.productName ?? '不可用商品'}`"
                  @change="selectionChanged(lineKey(item), ($event.target as HTMLInputElement).checked)"
                >
              </div>

              <div class="min-w-0">
                <h2 class="break-words text-base sm:text-lg font-semibold tracking-tight text-highlighted">
                  {{ item.productName ?? '商品信息暂不可用' }}
                </h2>
                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span>购买行 {{ index + 1 }}</span>
                  <span v-if="item.draftId"> · 已绑定填写资料</span>
                  <span
                    v-if="item.skuCode"
                    class="font-mono text-muted/70"
                  >· SKU {{ item.skuCode }}</span>
                </div>

                <ul
                  v-if="item.options.length"
                  class="mt-2.5 flex flex-wrap gap-1.5 text-xs text-muted"
                  aria-label="当前规格"
                >
                  <li
                    v-for="option in item.options"
                    :key="option.groupId"
                    class="inline-flex items-center rounded-md border border-default/50 bg-muted/30 px-2 py-0.5 text-xs"
                  >
                    <span class="text-muted/70">{{ option.groupName }}：</span>
                    <span class="font-medium text-highlighted">{{ option.valueName }}</span>
                  </li>
                </ul>

                <div class="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
                  <UBadge
                    :color="item.canPurchase ? 'success' : 'warning'"
                    variant="subtle"
                    size="sm"
                    class="rounded-md font-medium"
                  >
                    <UIcon
                      :name="item.canPurchase ? 'i-lucide-check-circle-2' : 'i-lucide-alert-circle'"
                      class="size-3.5"
                    />
                    {{ statusLabel(item) }}
                  </UBadge>
                  <span
                    v-if="item.productStatus && item.productStatus !== 'active'"
                    class="text-xs text-muted"
                  >
                    商品状态：{{ item.productStatus }}
                  </span>
                </div>

                <StorefrontPurchaseLimitNotice
                  class="mt-3"
                  :purchase-limits="item.purchaseLimits"
                />

                <NuxtLink
                  v-if="item.productId && (item.templateVersionId || item.draftId || ['purchase_form_required', 'purchase_form_invalid', 'purchase_form_version_changed', 'purchase_forms_paused'].includes(item.reason ?? ''))"
                  :to="purchaseEditPath(item)"
                  class="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <UIcon
                    name="i-lucide-pencil"
                    class="size-3.5"
                    aria-hidden="true"
                  />
                  {{ item.draftId ? '编辑购买资料' : '重新填写购买资料' }}
                </NuxtLink>

                <div class="mt-3.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-default/40 pt-2.5 text-xs sm:border-0 sm:pt-0 sm:text-sm">
                  <span class="text-muted">
                    单价 <strong class="font-medium tabular-nums text-highlighted">{{ item.unitPrice === null ? '暂不可计价' : `¥${item.unitPrice}` }}</strong>
                  </span>
                  <span class="text-muted">
                    小计 <strong class="text-base font-semibold tabular-nums text-primary">{{ item.lineTotal === null ? '暂不可计价' : `¥${item.lineTotal}` }}</strong>
                  </span>
                </div>
              </div>

              <div class="col-start-2 flex min-w-0 items-center justify-between gap-3 pt-2 sm:col-start-auto sm:flex-col sm:items-end sm:justify-between sm:pt-0">
                <div
                  class="inline-flex items-center rounded-lg border border-default/80 bg-default/40 p-0.5 shadow-2xs"
                  :aria-label="`${item.productName ?? '商品'}购买数量`"
                >
                  <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-minus"
                    :aria-label="`减少${item.productName ?? '商品'}数量`"
                    class="min-h-9 min-w-9 justify-center rounded-md"
                    :disabled="item.quantity <= 1 || shoppingCart.busy.value"
                    @click="shoppingCart.setQuantity(item.lineId ?? item.skuId, item.quantity - 1)"
                  />
                  <span
                    class="min-w-8 px-1 text-center text-xs sm:text-sm font-semibold tabular-nums text-highlighted"
                    aria-live="polite"
                  >{{ item.quantity }}</span>
                  <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-plus"
                    :aria-label="`增加${item.productName ?? '商品'}数量`"
                    class="min-h-9 min-w-9 justify-center rounded-md"
                    :disabled="item.quantity >= 99 || shoppingCart.busy.value"
                    @click="shoppingCart.setQuantity(item.lineId ?? item.skuId, item.quantity + 1)"
                  />
                </div>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-trash-2"
                  class="text-xs text-muted hover:text-error transition-colors"
                  :disabled="shoppingCart.busy.value"
                  @click="shoppingCart.remove(item.lineId ?? item.skuId)"
                >
                  移除
                </UButton>
              </div>
            </li>
          </ul>
        </section>

        <aside
          class="rounded-2xl border border-default/70 bg-elevated/70 p-5 sm:p-6 shadow-xs backdrop-blur-xs lg:sticky lg:top-24"
          aria-labelledby="cart-summary-title"
        >
          <h2
            id="cart-summary-title"
            class="text-base sm:text-lg font-semibold tracking-tight text-highlighted"
          >
            所选商品
          </h2>
          <dl class="mt-4 space-y-3 border-b border-default/60 pb-4 text-xs sm:text-sm">
            <div class="flex items-center justify-between gap-3">
              <dt class="text-muted">
                商品数量
              </dt>
              <dd class="font-medium tabular-nums text-highlighted">
                {{ selectedCount }} 件
              </dd>
            </div>
            <div class="flex items-baseline justify-between gap-3 pt-1">
              <dt class="text-muted">
                当前报价合计
              </dt>
              <dd class="text-xl sm:text-2xl font-bold tracking-tight tabular-nums text-primary">
                {{ quoteBusy ? '正在报价…' : selectedQuote?.totalAmount === null ? '无法完整计价' : selectedQuote ? `¥${selectedQuote.totalAmount}` : '—' }}
              </dd>
            </div>
          </dl>

          <div
            v-if="selectedQuote?.totalComplete === false"
            class="mt-3.5 flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/10 p-3 text-xs leading-5 text-warning"
          >
            <UIcon
              name="i-lucide-alert-triangle"
              class="size-4 shrink-0 mt-0.5"
            />
            <span>有商品当前无法读取售价，合计金额不完整。</span>
          </div>

          <p
            v-if="quoteError"
            class="mt-3 rounded-xl border border-error/20 bg-error/10 p-3 text-xs leading-5 text-error"
            role="alert"
          >
            {{ quoteError }}
          </p>
          <p
            v-if="checkoutError"
            class="mt-3 rounded-xl border border-error/20 bg-error/10 p-3 text-xs leading-5 text-error"
            role="alert"
          >
            {{ checkoutError }}
          </p>

          <div class="mt-4 space-y-2 text-xs leading-5 text-muted/80">
            <p v-if="!isCustomer">
              游客可以使用本地购物车。店铺的游客结算与免费领取政策会在报价中检查。
            </p>
            <p>
              报价不会锁定价格或库存。结算提交时会重新验证并创建真实订单；未开放的发货方式不会进入可购买状态。
            </p>
          </div>

          <div class="mt-5 space-y-2.5">
            <UButton
              :to="checkoutPath"
              color="primary"
              block
              size="lg"
              class="min-h-12 rounded-xl text-base font-semibold shadow-xs transition-all active:scale-[0.99]"
              :loading="checkoutPreparing"
              :disabled="!selectedQuoteItems?.length || checkoutPreparing || quoteBusy || Boolean(quoteError) || (selectedQuote !== null && !selectedQuote.canContinue)"
              @click.prevent="openCheckout()"
            >
              查看结算报价
            </UButton>
            <UButton
              v-if="purchaseLoginRequired"
              :to="purchaseLoginRedirect"
              color="primary"
              variant="outline"
              block
              size="lg"
              class="min-h-12 rounded-xl font-medium"
              :loading="checkoutPreparing"
              :disabled="checkoutPreparing"
              @click.prevent="openCheckout(true)"
            >
              该商品需要登录后购买
            </UButton>
          </div>
        </aside>
      </div>
    </main>
  </UContainer>
</template>
