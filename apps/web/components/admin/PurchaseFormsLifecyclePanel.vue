<script setup lang="ts">
import type { PurchaseFormsLifecycle } from '@aikayun/contracts'
import { useAdminApi } from '~/composables/useAdminApi'

const { request } = useAdminApi()
const lifecycle = ref<PurchaseFormsLifecycle | null>(null)
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
let generation = 0

const statusLabel = computed(() => lifecycle.value?.status === 'preparing' ? '准备中'
  : lifecycle.value?.status === 'active' ? '已启用' : '已暂停')
const statusColor = computed(() => lifecycle.value?.status === 'active' ? 'success'
  : lifecycle.value?.status === 'paused' ? 'warning' : 'neutral')

async function load() {
  const current = ++generation
  loading.value = true
  errorMessage.value = ''
  try {
    lifecycle.value = await request<PurchaseFormsLifecycle>('/api/v1/admin/storefront/purchase-forms')
  } catch (error) {
    if (generation === current) errorMessage.value = error instanceof Error ? error.message : '读取购买填写状态失败。'
  } finally { if (generation === current) loading.value = false }
}

async function transition(nextStatus: 'active' | 'paused') {
  const current = lifecycle.value
  if (!current || busy.value) return
  const activation = current.status === 'preparing'
  const nextLabel = nextStatus === 'active' ? '启用' : '暂停'
  const impact = activation
    ? `将正式启用购买填写，并一次应用全部当前准备关联。统计范围：${current.productCount} 个商品、${current.skuCount} 个 SKU、${current.skuWithTemplateCount} 个有模板 SKU、${current.templateVersionCount} 个冻结版本。人工查看处理 SKU ${current.manualHandlingSkuCount} 个，自动履约 SKU ${current.automaticFulfillmentSkuCount} 个（自动履约不会收到填写内容）。`
    : '将阻止已有填写模板的 SKU 创建新订单；无模板 SKU 照常购买。已创建订单、履约、支付与售后继续运行。'
  if (activation && !current.readyToActivate) return
  if (!window.confirm(`确认${nextLabel}购买填写？\n\n${impact}\n\n已成交订单使用原冻结快照。`)) return
  busy.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    lifecycle.value = await request<PurchaseFormsLifecycle>('/api/v1/admin/storefront/purchase-forms/transition', {
      method: 'POST', body: {
        expectedStatus: current.status,
        nextStatus,
        ...(activation ? { expectedImpactHash: current.impactHash } : {}),
      },
    })
    successMessage.value = current.status === 'preparing' ? '购买填写已首次启用；当前准备关联已应用。'
      : nextStatus === 'paused' ? '购买填写已暂停，新模板购买将被拦截。' : '购买填写已恢复运行。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? `${error.message}请刷新影响范围后重试。` : '购买填写状态切换失败。'
    await load()
  } finally { busy.value = false }
}

onMounted(() => { void load() })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <section
    class="mt-6 rounded-2xl border border-default bg-elevated p-4 sm:p-6"
    aria-labelledby="purchase-form-lifecycle-title"
  >
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-sm font-medium text-primary">
          顾客购买规则
        </p>
        <h2
          id="purchase-form-lifecycle-title"
          class="mt-1 text-xl font-semibold text-highlighted"
        >
          购买填写启用状态
        </h2>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-muted">
          首次启用需要管理员明确确认影响范围。启用后只能暂停或恢复，不能退回准备状态。
        </p>
      </div>
      <UBadge
        v-if="lifecycle"
        :color="statusColor"
        variant="soft"
      >
        {{ statusLabel }}
      </UBadge>
    </header>
    <USkeleton
      v-if="loading"
      class="mt-4 h-32 rounded-xl"
      aria-label="读取购买填写状态"
    />
    <template v-else-if="lifecycle">
      <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-xl border border-default p-3">
          <dt class="text-xs text-muted">
            商品 / SKU
          </dt><dd class="mt-1 font-semibold tabular-nums text-highlighted">
            {{ lifecycle.productCount }} / {{ lifecycle.skuCount }}
          </dd>
        </div>
        <div class="rounded-xl border border-default p-3">
          <dt class="text-xs text-muted">
            有冻结模板的 SKU
          </dt><dd class="mt-1 font-semibold tabular-nums text-highlighted">
            {{ lifecycle.skuWithTemplateCount }}
          </dd>
        </div>
        <div class="rounded-xl border border-default p-3">
          <dt class="text-xs text-muted">
            冻结版本完整性
          </dt><dd class="mt-1 font-semibold text-highlighted">
            {{ lifecycle.invalidTemplateVersionCount ? `${lifecycle.invalidTemplateVersionCount} 个异常` : '检查通过' }}
          </dd>
        </div>
        <div class="rounded-xl border border-default p-3">
          <dt class="text-xs text-muted">
            保存后待应用关联
          </dt><dd class="mt-1 font-semibold tabular-nums text-highlighted">
            {{ lifecycle.pendingProductApplyCount }} 个商品 · {{ lifecycle.pendingSkuApplyCount }} 个 SKU
          </dd>
        </div>
      </dl>
      <UAlert
        v-if="lifecycle.status === 'preparing'"
        class="mt-4"
        color="warning"
        variant="soft"
        title="首次启用将应用全部当前准备关联。"
      >
        <template #description>
          人工查看处理：{{ lifecycle.manualHandlingSkuCount }} 个 SKU。自动履约：{{ lifecycle.automaticFulfillmentSkuCount }} 个 SKU；自动履约不会接收顾客填写的正文，也不会因此获得直充或上游采购能力。
        </template>
      </UAlert>
      <UAlert
        v-else
        class="mt-4"
        color="neutral"
        variant="soft"
        title="已成交订单保持成交时的购买资料快照。"
        description="后续关联修改须在商品或 SKU 页面明确保存并应用。暂停仅阻止新建包含有模板 SKU 的订单。"
      />
      <UAlert
        v-if="errorMessage"
        class="mt-4"
        color="error"
        variant="soft"
        :title="errorMessage"
        role="alert"
      />
      <UAlert
        v-if="successMessage"
        class="mt-4"
        color="success"
        variant="soft"
        :title="successMessage"
        role="status"
      />
      <div class="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          class="min-h-11 justify-center"
          :disabled="busy"
          :loading="loading"
          @click="load"
        >
          刷新影响范围
        </UButton>
        <UButton
          v-if="lifecycle.status === 'preparing'"
          color="primary"
          icon="i-lucide-shield-check"
          class="min-h-11 justify-center"
          :loading="busy"
          :disabled="busy || !lifecycle.readyToActivate"
          @click="transition('active')"
        >
          确认并首次启用
        </UButton>
        <UButton
          v-else-if="lifecycle.status === 'active'"
          color="warning"
          variant="soft"
          icon="i-lucide-pause"
          class="min-h-11 justify-center"
          :loading="busy"
          :disabled="busy"
          @click="transition('paused')"
        >
          暂停新购买
        </UButton>
        <UButton
          v-else
          color="primary"
          icon="i-lucide-play"
          class="min-h-11 justify-center"
          :loading="busy"
          :disabled="busy"
          @click="transition('active')"
        >
          恢复新购买
        </UButton>
      </div>
    </template>
  </section>
</template>
