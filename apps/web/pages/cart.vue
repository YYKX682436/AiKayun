<script setup lang="ts">
import type { CartSkuQuantity, CheckoutQuote, CheckoutQuoteItem } from '@aikayun/contracts'

const customerApi = useCustomerApi()
const shoppingCart = useShoppingCart()
const selectedSkuIds = ref<string[]>([])
const selectedQuote = ref<CheckoutQuote | null>(null)
const quoteError = ref('')
const quoteBusy = ref(false)
let quoteSequence = 0
let selectionInitialized = false

useSeoMeta({ title: '购物车', description: '查看购物车商品和当前结算报价。', robots: 'noindex, nofollow' })

const items = computed(() => shoppingCart.cartView.value?.items ?? [])
const isCustomer = computed(() => Boolean(customerApi.session.value?.customer.id))
const isEmpty = computed(() => shoppingCart.ready.value && items.value.length === 0)
const selectedItems = computed(() => items.value.filter(item => selectedSkuIds.value.includes(item.skuId)))
const selectedCount = computed(() => selectedItems.value.reduce((total, item) => total + item.quantity, 0))
const selectedQuoteItems = computed<CartSkuQuantity[]>(() => selectedItems.value.map(item => ({ skuId: item.skuId, quantity: item.quantity })))
const checkoutPath = computed(() => selectedQuoteItems.value.length
  ? shoppingCart.checkoutPath(selectedQuoteItems.value)
  : '/cart')

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
    default: return item.canPurchase ? '可继续报价' : '暂不可购买'
  }
}

function selectionChanged(skuId: string, checked: boolean): void {
  selectedSkuIds.value = checked
    ? [...new Set([...selectedSkuIds.value, skuId])]
    : selectedSkuIds.value.filter(id => id !== skuId)
}

function selectAll(checked: boolean): void {
  selectedSkuIds.value = checked ? items.value.map(item => item.skuId) : []
}

watch(items, (value) => {
  const currentIds = new Set(value.map(item => item.skuId))
  selectedSkuIds.value = selectedSkuIds.value.filter(id => currentIds.has(id))
  if (!selectionInitialized && value.length) {
    selectedSkuIds.value = value.map(item => item.skuId)
    selectionInitialized = true
  }
}, { immediate: true })

watch(selectedQuoteItems, async (value) => {
  const sequence = ++quoteSequence
  quoteError.value = ''
  if (!value.length) {
    selectedQuote.value = null
    quoteBusy.value = false
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
  quoteBusy.value = false
}, { flush: 'sync' })

onMounted(() => {
  if (!shoppingCart.ready.value) void shoppingCart.syncSession()
})
</script>

<template>
  <UContainer class="py-7 sm:py-10">
    <main
      id="main-content"
      class="mx-auto max-w-6xl"
    >
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p class="text-sm font-medium text-primary">
            商城
          </p>
          <h1 class="mt-1 text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl">
            购物车
          </h1>
          <p class="mt-2 text-sm text-muted">
            价格和库存会在每次报价时重新读取；购物车不保留价格或库存。
          </p>
        </div>
        <NuxtLink
          to="/search"
          class="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
        class="mt-6"
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
            :loading="shoppingCart.busy.value"
            @click="shoppingCart.refresh()"
          >
            重试
          </UButton>
        </template>
      </UAlert>
      <UAlert
        v-if="shoppingCart.noticeMessage.value"
        class="mt-4"
        color="success"
        variant="subtle"
        :title="shoppingCart.noticeMessage.value"
        role="status"
        aria-live="polite"
      />

      <div
        v-if="!shoppingCart.ready.value"
        class="mt-7 space-y-3"
        aria-label="正在加载购物车"
        aria-busy="true"
      >
        <div
          v-for="index in 3"
          :key="index"
          class="h-28 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
        />
      </div>

      <section
        v-else-if="isEmpty"
        class="mt-8 rounded-2xl border border-dashed border-default bg-elevated px-5 py-14 text-center sm:py-20"
      >
        <UIcon
          name="i-lucide-shopping-basket"
          class="mx-auto size-10 text-muted"
          aria-hidden="true"
        />
        <h2 class="mt-4 text-lg font-semibold text-highlighted">
          购物车还是空的
        </h2>
        <p class="mt-2 text-sm text-muted">
          挑选商品和规格后，它们会显示在这里。
        </p>
        <UButton
          to="/search"
          color="primary"
          class="mt-6"
        >
          浏览商品
        </UButton>
      </section>

      <div
        v-else-if="shoppingCart.ready.value"
        class="mt-7 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
      >
        <section
          aria-label="购物车商品"
          class="min-w-0"
        >
          <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
            <label class="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-highlighted">
              <input
                type="checkbox"
                class="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                :checked="items.length > 0 && selectedSkuIds.length === items.length"
                :indeterminate="selectedSkuIds.length > 0 && selectedSkuIds.length < items.length"
                aria-label="全选购物车商品"
                @change="selectAll(($event.target as HTMLInputElement).checked)"
              >
              全选（{{ items.length }} 件商品）
            </label>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-trash-2"
              :disabled="shoppingCart.busy.value"
              @click="shoppingCart.clear()"
            >
              清空购物车
            </UButton>
          </div>

          <ul class="space-y-3">
            <li
              v-for="item in items"
              :key="item.skuId"
              class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl border border-default bg-elevated p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-4 sm:p-5"
            >
              <input
                type="checkbox"
                class="mt-1 size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                :checked="selectedSkuIds.includes(item.skuId)"
                :aria-label="`选择${item.productName ?? '不可用商品'}`"
                @change="selectionChanged(item.skuId, ($event.target as HTMLInputElement).checked)"
              >
              <div class="min-w-0">
                <h2 class="break-words font-medium text-highlighted">
                  {{ item.productName ?? '商品信息暂不可用' }}
                </h2>
                <p
                  v-if="item.skuCode"
                  class="mt-1 break-all text-xs text-muted"
                >
                  SKU {{ item.skuCode }}
                </p>
                <ul
                  v-if="item.options.length"
                  class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted"
                  aria-label="当前规格"
                >
                  <li
                    v-for="option in item.options"
                    :key="option.groupId"
                  >
                    {{ option.groupName }}：{{ option.valueName }}
                  </li>
                </ul>
                <p class="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <UBadge
                    :color="item.canPurchase ? 'success' : 'warning'"
                    variant="soft"
                  >
                    {{ statusLabel(item) }}
                  </UBadge>
                  <span
                    v-if="item.productStatus && item.productStatus !== 'active'"
                    class="text-muted"
                  >商品状态：{{ item.productStatus }}</span>
                </p>
                <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                  <span class="text-muted">单价 <strong class="font-medium tabular-nums text-highlighted">{{ item.unitPrice === null ? '暂不可计价' : `¥${item.unitPrice}` }}</strong></span>
                  <span class="text-muted">小计 <strong class="font-medium tabular-nums text-highlighted">{{ item.lineTotal === null ? '暂不可计价' : `¥${item.lineTotal}` }}</strong></span>
                </div>
              </div>

              <div class="col-start-2 flex min-w-0 items-center justify-between gap-3 sm:col-start-auto sm:flex-col sm:items-end sm:justify-between">
                <div
                  class="flex items-center rounded-lg border border-default"
                  :aria-label="`${item.productName ?? '商品'}购买数量`"
                >
                  <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-minus"
                    :aria-label="`减少${item.productName ?? '商品'}数量`"
                    class="min-h-10 min-w-10 justify-center"
                    :disabled="item.quantity <= 1 || shoppingCart.busy.value"
                    @click="shoppingCart.setQuantity(item.skuId, item.quantity - 1)"
                  />
                  <span
                    class="min-w-9 px-1 text-center text-sm tabular-nums text-highlighted"
                    aria-live="polite"
                  >{{ item.quantity }}</span>
                  <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-plus"
                    :aria-label="`增加${item.productName ?? '商品'}数量`"
                    class="min-h-10 min-w-10 justify-center"
                    :disabled="item.quantity >= 99 || shoppingCart.busy.value"
                    @click="shoppingCart.setQuantity(item.skuId, item.quantity + 1)"
                  />
                </div>
                <UButton
                  color="neutral"
                  variant="link"
                  icon="i-lucide-x"
                  :disabled="shoppingCart.busy.value"
                  @click="shoppingCart.remove(item.skuId)"
                >
                  移除
                </UButton>
              </div>
            </li>
          </ul>
        </section>

        <aside
          class="rounded-xl border border-default bg-elevated p-4 sm:p-5 lg:sticky lg:top-4"
          aria-labelledby="cart-summary-title"
        >
          <h2
            id="cart-summary-title"
            class="text-lg font-semibold text-highlighted"
          >
            所选商品
          </h2>
          <dl class="mt-4 space-y-3 border-b border-default pb-4 text-sm">
            <div class="flex justify-between gap-3">
              <dt class="text-muted">
                商品数量
              </dt><dd class="tabular-nums text-highlighted">
                {{ selectedCount }}
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-muted">
                当前报价合计
              </dt><dd class="font-semibold tabular-nums text-primary">
                {{ quoteBusy ? '正在报价…' : selectedQuote?.totalAmount === null ? '无法完整计价' : selectedQuote ? `¥${selectedQuote.totalAmount}` : '—' }}
              </dd>
            </div>
          </dl>
          <p
            v-if="selectedQuote?.totalComplete === false"
            class="mt-3 text-sm text-warning"
          >
            有商品当前无法读取售价，合计金额不完整。
          </p>
          <p
            v-if="quoteError"
            class="mt-3 text-sm text-error"
            role="alert"
          >
            {{ quoteError }}
          </p>
          <p
            v-if="!isCustomer"
            class="mt-3 text-sm leading-6 text-muted"
          >
            游客可以使用本地购物车。店铺的游客结算与免费领取政策会在报价中检查。
          </p>
          <p class="mt-3 text-xs leading-5 text-muted">
            报价不会锁定价格或库存。结算提交时会重新验证并创建真实订单；未开放的发货方式不会进入可购买状态。
          </p>
          <UButton
            :to="checkoutPath"
            color="primary"
            block
            class="mt-5 min-h-11"
            :disabled="selectedQuoteItems.length === 0 || quoteBusy || Boolean(quoteError)"
          >
            查看结算报价
          </UButton>
        </aside>
      </div>
    </main>
  </UContainer>
</template>
