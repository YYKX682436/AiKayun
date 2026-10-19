<script setup lang="ts">
import type {
  CheckoutPurchaseLimits,
  PurchaseLimitSettings,
  SkuPurchaseLimitSettings,
} from '@aikayun/contracts'

const props = defineProps<{
  purchaseLimits?: CheckoutPurchaseLimits | null
  productRules?: PurchaseLimitSettings
  skuRules?: SkuPurchaseLimitSettings
  authenticated?: boolean
}>()

function formatRule(
  label: string,
  rules: Pick<PurchaseLimitSettings, 'perOrder' | 'lifetime' | 'rolling24Hours'> | undefined,
  status: CheckoutPurchaseLimits['product'] | undefined,
): string | null {
  if (!rules && !status) return null
  const perOrder = status?.perOrderLimit ?? rules?.perOrder ?? null
  const lifetime = status?.lifetimeLimit ?? rules?.lifetime ?? null
  const rolling24Hours = status?.rolling24HourLimit ?? rules?.rolling24Hours ?? null
  if (perOrder === null && lifetime === null && rolling24Hours === null) return null

  const parts = [`${label}限购`]
  if (perOrder !== null) parts.push(`每单最多 ${perOrder} 件`)
  if (lifetime !== null) {
    const purchased = status?.lifetimePurchased
    parts.push(`累计最多 ${lifetime} 件${purchased === null || purchased === undefined ? '' : `，已购 ${purchased} 件，剩余 ${Math.max(0, lifetime - purchased)} 件`}`)
  }
  if (rolling24Hours !== null) {
    const purchased = status?.rolling24HoursPurchased
    parts.push(`滚动24小时最多 ${rolling24Hours} 件${purchased === null || purchased === undefined ? '' : `，已购 ${purchased} 件，剩余 ${Math.max(0, rolling24Hours - purchased)} 件`}`)
  }
  if (status?.maxAvailable !== null && status?.maxAvailable !== undefined) {
    parts.push(`当前额度 ${status.maxAvailable} 件`)
  }
  return parts.join(' · ')
}

const lines = computed(() => {
  const status = props.purchaseLimits
  const product = formatRule('商品', props.productRules, status?.product)
  const sku = formatRule('规格', props.skuRules, status?.sku)
  return [product, sku].filter((line): line is string => line !== null)
})

const requiresLogin = computed(() => Boolean(props.purchaseLimits?.requiresLogin)
  || (!props.authenticated && Boolean(props.productRules?.lifetime || props.productRules?.rolling24Hours
    || props.skuRules?.lifetime || props.skuRules?.rolling24Hours)))
const exceeded = computed(() => Boolean(props.purchaseLimits?.product.exceeded || props.purchaseLimits?.sku.exceeded))
</script>

<template>
  <div
    v-if="lines.length || requiresLogin"
    class="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-6"
    :role="exceeded || requiresLogin ? 'status' : undefined"
  >
    <ul
      v-if="lines.length"
      class="space-y-1 text-muted"
    >
      <li
        v-for="line in lines"
        :key="line"
      >
        {{ line }}
      </li>
    </ul>
    <p
      v-if="requiresLogin"
      class="mt-1 font-medium text-warning"
    >
      该商品需要登录后购买。
    </p>
    <p
      v-else-if="exceeded"
      class="mt-1 font-medium text-warning"
    >
      所选数量超过当前限购额度，请调整数量后再结算。
    </p>
  </div>
</template>
