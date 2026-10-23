<script setup lang="ts">
import type {
  ApiFulfillmentConfig,
  ApiFulfillmentHistoryPage,
  SaveApiFulfillmentVersionBody,
  SupplierConnection,
} from '@aikayun/contracts'
import { useAdminApi } from '~/composables/useAdminApi'

const props = defineProps<{
  productId: string
  skuOptions: Array<{ label: string; value: string }>
  archived?: boolean
}>()
const emit = defineEmits<{ updated: [] }>()
const skuId = defineModel<string>('skuId', { default: '' })
const { request } = useAdminApi()
const config = shallowRef<ApiFulfillmentConfig | null>(null)
const history = shallowRef<ApiFulfillmentHistoryPage | null>(null)
const suppliers = shallowRef<SupplierConnection[]>([])
const selectedConnectionVersionId = ref('')
const supplierProductId = ref('')
const parameters = ref<Array<{ name: string; value: string }>>([])
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const root = computed(() => `/api/v1/admin/products/${props.productId}/variants/${skuId.value}/api-fulfillment`)
const enabledOptions = computed(() => suppliers.value.filter(row => row.enabled && row.providerType === 'http_json_v1' && row.fulfillmentEligible).map(row => ({
  label: `${row.name} · v${row.currentVersion.versionNumber}`,
  value: row.currentVersion.id,
})))
const canEnable = computed(() => Boolean(config.value?.currentVersionId
  && config.value.supplierEnabled && config.value.supplierConnectionVersionId
  && suppliers.value.some(row => row.enabled && row.providerType === 'http_json_v1' && row.fulfillmentEligible && row.currentVersion.id === config.value?.supplierConnectionVersionId)))

async function load() {
  if (!skuId.value || !props.productId) return
  const requestedSkuId = skuId.value
  loading.value = true
  errorMessage.value = ''
  try {
    const [current, versions, connections] = await Promise.all([
      request<ApiFulfillmentConfig>(root.value),
      request<ApiFulfillmentHistoryPage>(`${root.value}/versions`),
      request<SupplierConnection[]>('/api/v1/admin/supplier-connections'),
    ])
    if (requestedSkuId !== skuId.value) return
    config.value = current
    history.value = versions
    suppliers.value = connections
    const version = versions.items.find(row => row.id === current.currentVersionId)
    if (version) {
      selectedConnectionVersionId.value = version.supplierConnectionVersionId
      supplierProductId.value = version.supplierProductId
      parameters.value = Object.entries(version.parameters).map(([name, value]) => ({ name, value }))
    } else {
      selectedConnectionVersionId.value = enabledOptions.value[0]?.value ?? ''
      supplierProductId.value = ''
      parameters.value = []
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '外部 API 履约配置暂时无法读取。'
  } finally {
    loading.value = false
  }
}

function addParameter() {
  if (parameters.value.length < 20) parameters.value.push({ name: '', value: '' })
}

function removeParameter(index: number) {
  parameters.value.splice(index, 1)
}

async function saveVersion() {
  if (!config.value || !selectedConnectionVersionId.value || !supplierProductId.value.trim() || loading.value || props.archived) return
  const body: SaveApiFulfillmentVersionBody = {
    expectedRevision: config.value.configurationRevision,
    supplierConnectionVersionId: selectedConnectionVersionId.value,
    supplierProductId: supplierProductId.value.trim(),
    parameters: Object.fromEntries(parameters.value.filter(row => row.name.trim()).map(row => [row.name.trim(), row.value])),
  }
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await request<{ configuration: ApiFulfillmentConfig }>(`${root.value}/versions`, { method: 'POST', body })
    config.value = result.configuration
    successMessage.value = '新版本已保存；自动销售已暂停。历史订单继续使用原版本。'
    emit('updated')
    await load()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保存 API 履约版本失败。'
  } finally {
    loading.value = false
  }
}

async function setReadiness(enabled: boolean) {
  if (!config.value || loading.value || props.archived) return
  if (enabled && !window.confirm('确认启用当前供应商版本的 SKU 新订单自动销售？')) return
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await request<{ configuration: ApiFulfillmentConfig }>(`${root.value}/readiness`, {
      method: 'PUT',
      body: { expectedRevision: config.value.configurationRevision, enabled },
    })
    config.value = result.configuration
    successMessage.value = enabled ? '当前 API 版本已启用新订单自动销售。' : '新订单自动销售已暂停。'
    emit('updated')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '更新自动销售状态失败。'
  } finally {
    loading.value = false
  }
}

watch([() => props.productId, skuId], () => {
  config.value = null
  history.value = null
  if (!skuId.value && props.skuOptions.length) skuId.value = props.skuOptions[0]!.value
  void load()
}, { immediate: true })
</script>

<template>
  <section
    id="api-fulfillment-title"
    class="mt-6 min-w-0 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:p-5"
    aria-labelledby="api-fulfillment-heading"
  >
    <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3
          id="api-fulfillment-heading"
          class="font-semibold text-highlighted"
        >
          外部 API 自动发货
        </h3>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-muted">
          只接入遵守 http_json_v1 协议的服务。保存新版本会暂停新销售；旧订单保留原供应商和配置版本。
        </p>
      </div>
      <UBadge
        :color="config?.automaticDeliveryReady ? 'success' : 'neutral'"
        variant="soft"
      >
        {{ config?.automaticDeliveryReady ? '自动销售已启用' : '自动销售已暂停' }}
      </UBadge>
    </div>

    <div class="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
      <div class="min-w-0 space-y-3">
        <UFormField label="管理 SKU">
          <USelect
            v-model="skuId"
            :items="skuOptions"
            class="w-full"
            :disabled="loading || !skuOptions.length"
          />
        </UFormField>
        <UFormField
          label="供应商连接版本"
          hint="仅显示通过履约测试并明确启用的 http_json_v1 连接；卡易信只读连接不可选。请先到供应商连接管理中完成配置。"
        >
          <USelect
            v-model="selectedConnectionVersionId"
            :items="enabledOptions"
            class="w-full"
            :disabled="loading || props.archived || !enabledOptions.length"
            placeholder="选择已启用的供应商"
          />
        </UFormField>
        <UFormField
          label="供应商商品标识"
          hint="对应供应商协议中的 productId。"
        >
          <UInput
            v-model="supplierProductId"
            class="w-full"
            maxlength="200"
            :disabled="loading || props.archived"
          />
        </UFormField>
        <div class="space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-medium text-highlighted">
              交付参数
            </p>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-plus"
              :disabled="loading || props.archived || parameters.length >= 20"
              @click="addParameter"
            >
              添加参数
            </UButton>
          </div>
          <p class="text-xs leading-5 text-muted">
            仅填写非敏感业务参数。Bearer 凭据只保存在供应商连接中；此处不支持认证信息或脚本映射。
          </p>
          <div
            v-for="(parameter, index) in parameters"
            :key="index"
            class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
          >
            <UInput
              v-model="parameter.name"
              aria-label="参数名称"
              placeholder="参数名称"
              maxlength="64"
              :disabled="loading || props.archived"
            />
            <UInput
              v-model="parameter.value"
              aria-label="参数值"
              placeholder="参数值"
              maxlength="500"
              :disabled="loading || props.archived"
            />
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              aria-label="删除参数"
              class="min-h-11"
              :disabled="loading || props.archived"
              @click="removeParameter(index)"
            />
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton
            color="primary"
            icon="i-lucide-save"
            :loading="loading"
            :disabled="props.archived || !config || !enabledOptions.length"
            @click="saveVersion"
          >
            保存新版本并暂停销售
          </UButton>
          <UButton
            color="neutral"
            variant="outline"
            :icon="config?.automaticDeliveryReady ? 'i-lucide-pause' : 'i-lucide-play'"
            :loading="loading"
            :disabled="props.archived || !config?.currentVersionId || (!config?.automaticDeliveryReady && !canEnable)"
            @click="setReadiness(!config?.automaticDeliveryReady)"
          >
            {{ config?.automaticDeliveryReady ? '暂停新销售' : '明确启用自动销售' }}
          </UButton>
        </div>
        <UAlert
          v-if="errorMessage"
          color="error"
          variant="soft"
          icon="i-lucide-circle-alert"
          :title="errorMessage"
          role="alert"
        />
        <UAlert
          v-if="successMessage"
          color="success"
          variant="soft"
          icon="i-lucide-check"
          :title="successMessage"
          role="status"
        />
        <div
          v-if="config?.currentVersionId"
          class="rounded-lg border border-default bg-default p-3 text-sm"
        >
          <p class="font-medium text-highlighted">
            当前版本
          </p>
          <p class="mt-1 break-all text-muted">
            {{ config.supplierConnectionName }} · v{{ config.supplierConnectionVersionNumber }} · 商品 {{ config.supplierProductId }} · 修订 {{ config.configurationRevision }}
          </p>
          <p
            v-if="!config.supplierEnabled"
            class="mt-1 text-warning"
          >
            供应商连接已暂停，不能接受新订单。
          </p>
        </div>
      </div>

      <div class="min-w-0 rounded-lg border border-default bg-default p-3 sm:p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="font-medium text-highlighted">
            版本与操作记录
          </h4>
          <span class="text-xs text-muted">{{ history?.items.length ?? 0 }} 个版本</span>
        </div>
        <ol
          v-if="history?.items.length"
          class="mt-3 space-y-2"
        >
          <li
            v-for="version in history.items"
            :key="version.id"
            class="rounded-md border border-default p-3 text-sm"
          >
            <p class="font-medium text-highlighted">
              v{{ version.versionNumber }} · {{ version.supplierConnectionName }}
            </p>
            <p class="mt-1 break-all text-xs text-muted">
              连接 v{{ version.supplierConnectionVersionNumber }} · {{ version.supplierProductId }}
            </p>
            <p class="mt-1 text-xs text-dimmed">
              {{ new Date(version.createdAt).toLocaleString('zh-CN') }}
            </p>
          </li>
        </ol>
        <p
          v-else
          class="mt-3 text-sm text-muted"
        >
          尚未保存外部 API 履约版本。
        </p>
        <div
          v-if="history?.events.length"
          class="mt-4 border-t border-default pt-3"
        >
          <h5 class="text-sm font-medium text-highlighted">
            最近操作
          </h5>
          <ul class="mt-2 space-y-2 text-xs text-muted">
            <li
              v-for="event in history.events.slice(0, 8)"
              :key="event.id"
              class="flex flex-wrap justify-between gap-2"
            >
              <span>{{ event.action === 'version_saved' ? '保存版本' : event.action === 'automatic_delivery_enabled' ? '启用销售' : '暂停销售' }}</span>
              <time :datetime="event.createdAt">{{ new Date(event.createdAt).toLocaleString('zh-CN') }}</time>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
