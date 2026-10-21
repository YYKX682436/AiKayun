<script setup lang="ts">
import type {
  PrivateFileConfig,
  PrivateFileUpload,
  PrivateFileVersion,
  PrivateFileVersionsPage,
} from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

const props = defineProps<{
  productId: string
  skuOptions: Array<{ label: string; value: string }>
  archived?: boolean
}>()
const emit = defineEmits<{ updated: [] }>()
const skuId = defineModel<string>('skuId', { default: '' })
const { request, upload } = useAdminApi()
const config = shallowRef<PrivateFileConfig | null>(null)
const versions = shallowRef<PrivateFileVersionsPage | null>(null)
const historyDetail = shallowRef<PrivateFileVersion | null>(null)
const selectedFile = shallowRef<File | null>(null)
const stagedUpload = shallowRef<PrivateFileUpload | null>(null)
const displayFilename = ref('')
const progress = ref<number | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const root = computed(() => `/api/v1/admin/products/${props.productId}/variants/${skuId.value}/private-files`)
const allowedTypes = '.zip,.pdf,.txt,.md,.markdown,.csv,.json,.png,.jpg,.jpeg,.webp,.gif,.mp3,.mp4'
const canEnable = computed(() => Boolean(config.value?.currentVersion
  && config.value.productType === 'digital' && config.value.integrityStatus === 'verified'))

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function integrityLabel(value: PrivateFileVersion['integrityStatus'] | PrivateFileConfig['integrityStatus']): string {
  if (value === 'verified') return '完整性已验证'
  if (value === 'missing') return '文件缺失'
  if (value === 'corrupt') return '校验失败'
  return '尚未验证'
}

function integrityColor(value: PrivateFileVersion['integrityStatus'] | PrivateFileConfig['integrityStatus']) {
  return value === 'verified' ? 'success' : value === 'unknown' ? 'warning' : 'error'
}

async function load() {
  if (!skuId.value || !props.productId) return
  const selectedSku = skuId.value
  loading.value = true
  errorMessage.value = ''
  try {
    const [current, history] = await Promise.all([
      request<PrivateFileConfig>(root.value),
      request<PrivateFileVersionsPage>(`${root.value}/versions?page=1&pageSize=20`),
    ])
    if (selectedSku !== skuId.value) return
    config.value = current
    versions.value = history
    historyDetail.value = null
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '私有文件配置暂时无法读取。'
  } finally {
    loading.value = false
  }
}

function selectFile(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0] ?? null
  selectedFile.value = file
  stagedUpload.value = null
  progress.value = null
  displayFilename.value = file?.name ?? ''
  errorMessage.value = ''
  successMessage.value = ''
}

async function uploadFile() {
  if (!selectedFile.value || loading.value || props.archived) return
  loading.value = true
  progress.value = 0
  errorMessage.value = ''
  successMessage.value = ''
  try {
    stagedUpload.value = await upload<PrivateFileUpload>(`${root.value}/uploads`, selectedFile.value, (value) => {
      progress.value = value
    })
    displayFilename.value = stagedUpload.value.uploadFilename
    successMessage.value = `文件已安全上传并完成格式与 SHA-256 校验（${formatBytes(stagedUpload.value.fileSizeBytes)}）。保存版本后仍需单独启用销售。`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '私有文件上传失败，请检查文件后重试。'
    stagedUpload.value = null
  } finally {
    loading.value = false
  }
}

async function saveVersion() {
  if (!config.value || !stagedUpload.value || loading.value || props.archived) return
  const filename = displayFilename.value.trim()
  if (!filename) {
    errorMessage.value = '请填写顾客下载时看到的文件名。'
    return
  }
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    config.value = await request<PrivateFileConfig>(`${root.value}/versions`, {
      method: 'POST',
      body: {
        expectedRevision: config.value.configurationRevision,
        uploadId: stagedUpload.value.uploadId,
        displayFilename: filename,
      },
    })
    stagedUpload.value = null
    selectedFile.value = null
    progress.value = null
    successMessage.value = `版本 v${config.value.currentVersion?.versionNumber ?? ''} 已保存；新订单销售资格已暂停，请核对完整性后明确启用。`
    emit('updated')
    await load()
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError && error.code === 'FULFILLMENT_REVISION_CONFLICT'
      ? 'SKU 履约配置已变化，请刷新当前版本后重试。'
      : error instanceof Error ? error.message : '保存私有文件版本失败。'
  } finally {
    loading.value = false
  }
}

async function setReadiness(enabled: boolean) {
  if (!config.value || loading.value || props.archived) return
  if (enabled && !window.confirm('确认使用当前不可变文件版本启用此 SKU 的新订单自动交付？旧订单仍使用原先绑定的版本。')) return
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    config.value = await request<PrivateFileConfig>(`${root.value}/readiness`, {
      method: 'PUT',
      body: { expectedRevision: config.value.configurationRevision, enabled },
    })
    successMessage.value = enabled ? '新订单文件自动交付已启用。' : '新订单文件自动交付已暂停，已创建订单仍保留其文件版本。'
    emit('updated')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '更新文件销售状态失败。'
  } finally {
    loading.value = false
  }
}

async function showHistory(versionId: string) {
  if (loading.value) return
  errorMessage.value = ''
  try {
    historyDetail.value = await request<PrivateFileVersion>(`${root.value}/versions/${versionId}`)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '历史文件版本暂时无法读取。'
  }
}

watch([() => props.productId, skuId], () => {
  config.value = null
  versions.value = null
  historyDetail.value = null
  selectedFile.value = null
  stagedUpload.value = null
  progress.value = null
  if (!skuId.value && props.skuOptions.length) skuId.value = props.skuOptions[0]!.value
  void load()
}, { immediate: true })
</script>

<template>
  <section
    id="private-file-title"
    class="mt-6 min-w-0 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:p-5"
    aria-labelledby="private-file-heading"
  >
    <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3
          id="private-file-heading"
          class="font-semibold text-highlighted"
        >
          私有文件与自动交付
        </h3>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-muted">
          文件保存在独立私有卷，不会生成公开链接。上传上限 100 MiB；支持 ZIP、PDF、UTF-8 文本、PNG/JPEG/WebP/GIF、MP3 和 MP4。保存为新版本后会暂停销售，历史订单继续绑定原版本。
        </p>
      </div>
      <UBadge
        :color="config?.automaticDeliveryReady ? 'success' : 'neutral'"
        variant="soft"
      >
        {{ config?.automaticDeliveryReady ? '新订单自动交付已启用' : '新订单自动交付已暂停' }}
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
          label="选择文件"
          hint="ZIP、PDF、文本、常用图片、MP3 或 MP4；不超过 100 MiB。"
        >
          <input
            id="private-file-input"
            class="block w-full min-w-0 rounded-md border border-default bg-default px-3 py-2 text-sm text-highlighted file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-medium file:text-white disabled:opacity-50"
            type="file"
            :accept="allowedTypes"
            :disabled="loading || archived"
            aria-describedby="private-file-limit"
            @change="selectFile"
          >
        </UFormField>
        <p
          id="private-file-limit"
          class="text-xs text-muted"
        >
          服务端会重新检测扩展名、文件内容、大小与摘要；浏览器声明的 MIME 类型不会作为信任依据。
        </p>
        <p
          v-if="selectedFile"
          class="break-all text-sm text-highlighted"
        >
          已选：{{ selectedFile.name }} · {{ formatBytes(selectedFile.size) }}
        </p>
        <div class="flex flex-wrap gap-2">
          <UButton
            icon="i-lucide-upload"
            :disabled="!selectedFile || loading || archived"
            :loading="loading && progress !== null"
            @click="uploadFile"
          >
            上传并校验
          </UButton>
          <UButton
            v-if="stagedUpload"
            color="neutral"
            variant="outline"
            icon="i-lucide-save"
            :disabled="loading || archived"
            @click="saveVersion"
          >
            保存为新版本
          </UButton>
          <UButton
            v-if="config?.currentVersion"
            :color="config.automaticDeliveryReady ? 'warning' : 'success'"
            :variant="config.automaticDeliveryReady ? 'outline' : 'solid'"
            :disabled="loading || archived || (!config.automaticDeliveryReady && !canEnable)"
            :aria-pressed="config.automaticDeliveryReady"
            @click="setReadiness(!config.automaticDeliveryReady)"
          >
            {{ config.automaticDeliveryReady ? '暂停新销售' : '明确启用自动交付' }}
          </UButton>
        </div>
        <div
          v-if="progress !== null"
          class="space-y-1"
          aria-live="polite"
        >
          <div class="flex justify-between text-xs text-muted">
            <span>上传进度</span><span>{{ progress }}%</span>
          </div>
          <UProgress
            :model-value="progress"
            :max="100"
            aria-label="私有文件上传进度"
          />
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
          icon="i-lucide-circle-check"
          :title="successMessage"
          role="status"
        />
        <div
          v-if="stagedUpload"
          class="min-w-0 space-y-2 rounded-lg border border-default bg-elevated p-3"
        >
          <p class="break-all text-sm text-highlighted">
            {{ stagedUpload.uploadFilename }} · {{ formatBytes(stagedUpload.fileSizeBytes) }} · {{ stagedUpload.fileMediaType }}
          </p>
          <p class="break-all font-mono text-xs text-muted">
            SHA-256 {{ stagedUpload.sha256 }}
          </p>
          <UFormField
            label="顾客下载时显示的名称"
            hint="扩展名必须与文件实际格式一致。"
          >
            <UInput
              v-model="displayFilename"
              class="w-full"
              :disabled="loading || archived"
              maxlength="255"
            />
          </UFormField>
        </div>
      </div>

      <div class="min-w-0 space-y-4">
        <div class="min-w-0 rounded-lg border border-default bg-elevated p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h4 class="font-medium text-highlighted">
              当前交付版本
            </h4>
            <UBadge
              v-if="config"
              :color="integrityColor(config.integrityStatus)"
              variant="soft"
            >
              {{ integrityLabel(config.integrityStatus) }}
            </UBadge>
          </div>
          <p
            v-if="loading && !config"
            class="mt-2 text-sm text-muted"
            aria-busy="true"
          >
            正在读取私有文件状态…
          </p>
          <template v-else-if="config?.currentVersion">
            <p class="mt-2 break-all text-sm font-medium text-highlighted">
              v{{ config.currentVersion.versionNumber }} · {{ config.currentVersion.displayFilename }}
            </p>
            <p class="mt-1 text-sm text-muted">
              {{ formatBytes(config.currentVersion.fileSizeBytes) }} · {{ config.currentVersion.fileMediaType }} · {{ new Date(config.currentVersion.createdAt).toLocaleString('zh-CN') }}
            </p>
            <p class="mt-2 break-all font-mono text-xs text-muted">
              SHA-256 {{ config.currentVersion.sha256 }}
            </p>
          </template>
          <p
            v-else
            class="mt-2 text-sm text-muted"
          >
            此 SKU 尚未保存私有文件版本。
          </p>
        </div>

        <div class="min-w-0 rounded-lg border border-default bg-elevated p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h4 class="font-medium text-highlighted">
              历史文件版本
            </h4>
            <span class="text-xs text-muted">{{ versions?.total ?? 0 }} 个版本</span>
          </div>
          <ul
            v-if="versions?.items.length"
            class="mt-2 divide-y divide-default"
          >
            <li
              v-for="version in versions.items"
              :key="version.id"
              class="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span class="min-w-0 break-all text-muted">v{{ version.versionNumber }} · {{ version.displayFilename }} · {{ formatBytes(version.fileSizeBytes) }}</span>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                @click="showHistory(version.id)"
              >
                查看
              </UButton>
            </li>
          </ul>
          <p
            v-else
            class="mt-2 text-sm text-muted"
          >
            暂无历史文件版本。
          </p>
          <div
            v-if="historyDetail"
            class="mt-3 min-w-0 border-t border-default pt-3"
          >
            <div class="flex flex-wrap items-center gap-2">
              <p class="break-all text-sm font-medium text-highlighted">
                v{{ historyDetail.versionNumber }} · {{ historyDetail.displayFilename }}
              </p>
              <UBadge
                :color="integrityColor(historyDetail.integrityStatus)"
                variant="soft"
              >
                {{ integrityLabel(historyDetail.integrityStatus) }}
              </UBadge>
            </div>
            <p class="mt-1 text-xs text-muted">
              {{ formatBytes(historyDetail.fileSizeBytes) }} · {{ historyDetail.fileMediaType }} · {{ new Date(historyDetail.createdAt).toLocaleString('zh-CN') }}
            </p>
            <p class="mt-2 break-all font-mono text-xs text-muted">
              SHA-256 {{ historyDetail.sha256 }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
