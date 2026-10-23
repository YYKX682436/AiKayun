<script setup lang="ts">
import type {
  CreateSupplierConnectionBody,
  SupplierConnection,
  SupplierConnectionAuditPage,
  SupplierConnectionTestResult,
  SupplierConnectionVersion,
  SupplierConnectionVersionsPage,
} from '@aikayun/contracts'
import { useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '供应商连接' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const { request } = useAdminApi()
const connections = shallowRef<SupplierConnection[]>([])
const selectedId = ref('')
const versions = shallowRef<SupplierConnectionVersionsPage | null>(null)
const audit = shallowRef<SupplierConnectionAuditPage | null>(null)
const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const testResult = shallowRef<SupplierConnectionTestResult | null>(null)
const form = reactive({ name: '', baseUrl: '', bearerToken: '' })
const selected = computed(() => connections.value.find(row => row.id === selectedId.value) ?? null)
const actionPath = computed(() => `/api/v1/admin/supplier-connections/${selectedId.value}`)

const actionLabels: Record<SupplierConnectionAuditPage['events'][number]['action'], string> = {
  created: '创建连接', configuration_updated: '更新配置', credential_rotated: '轮换凭据',
  credential_key_rewrapped: '轮换加密密钥', enabled: '启用连接', disabled: '停用连接',
  connection_test_succeeded: '连接与查单测试通过', connection_test_failed: '连接测试失败',
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function clearMessages() {
  errorMessage.value = ''
  successMessage.value = ''
}

async function load() {
  loading.value = true
  try {
    connections.value = await request<SupplierConnection[]>('/api/v1/admin/supplier-connections')
    if (!connections.value.some(row => row.id === selectedId.value)) selectedId.value = connections.value[0]?.id ?? ''
    await loadSelected()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '供应商连接暂时无法读取。'
  } finally {
    loading.value = false
  }
}

async function loadSelected() {
  const current = selected.value
  if (!current) {
    versions.value = null
    audit.value = null
    form.name = ''
    form.baseUrl = ''
    form.bearerToken = ''
    return
  }
  form.name = current.name
  form.baseUrl = current.currentVersion.baseUrl
  form.bearerToken = ''
  testResult.value = null
  const [versionPage, auditPage] = await Promise.all([
    request<SupplierConnectionVersionsPage>(`${actionPath.value}/versions?page=1&pageSize=50`),
    request<SupplierConnectionAuditPage>(`${actionPath.value}/audit`),
  ])
  if (selectedId.value !== current.id) return
  versions.value = versionPage
  audit.value = auditPage
}

watch(selectedId, () => {
  clearMessages()
  if (!loading.value) void loadSelected().catch(error => {
    errorMessage.value = error instanceof Error ? error.message : '供应商版本和审计暂时无法读取。'
  })
})

async function createConnection() {
  if (saving.value || !form.name.trim() || !form.baseUrl.trim() || !form.bearerToken) return
  saving.value = true
  clearMessages()
  const body: CreateSupplierConnectionBody = {
    name: form.name.trim(), providerType: 'http_json_v1',
    baseUrl: form.baseUrl.trim(), bearerToken: form.bearerToken,
  }
  try {
    const created = await request<SupplierConnection[]>('/api/v1/admin/supplier-connections', { method: 'POST', body })
    form.bearerToken = ''
    selectedId.value = created[0]?.id ?? ''
    successMessage.value = '供应商连接已加密保存并保持停用。请先测试，再明确启用。'
    await load()
  } catch (error) {
    form.bearerToken = ''
    errorMessage.value = error instanceof Error ? error.message : '供应商连接保存失败。'
  } finally {
    saving.value = false
  }
}

async function saveConfiguration() {
  if (!selected.value || saving.value || !form.name.trim() || !form.baseUrl.trim()) return
  saving.value = true
  clearMessages()
  const bearerToken = form.bearerToken
  form.bearerToken = ''
  try {
    await request<SupplierConnection[]>(actionPath.value, {
      method: 'PUT',
      body: { name: form.name.trim(), baseUrl: form.baseUrl.trim(), ...(bearerToken ? { bearerToken } : {}) },
    })
    successMessage.value = bearerToken
      ? '新供应商版本与凭据已加密保存，连接已停用。请测试新版本后再启用。'
      : '新供应商地址版本已保存，连接已停用。请测试新版本后再启用。'
    await load()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '供应商配置保存失败。'
  } finally {
    saving.value = false
  }
}

async function testConnection() {
  if (!selected.value || saving.value) return
  saving.value = true
  clearMessages()
  testResult.value = null
  try {
    testResult.value = await request<SupplierConnectionTestResult>(`${actionPath.value}/test`, { method: 'POST' })
    successMessage.value = testResult.value.message
    await load()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '供应商测试请求失败。'
  } finally {
    saving.value = false
  }
}

async function setEnabled(enabled: boolean) {
  if (!selected.value || saving.value) return
  saving.value = true
  clearMessages()
  try {
    await request<SupplierConnection[]>(`${actionPath.value}/enabled`, { method: 'PUT', body: { enabled } })
    successMessage.value = enabled ? '供应商连接已启用。' : '供应商连接已停用；历史订单仍可使用绑定凭据查单。'
    await load()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '供应商启停操作失败。'
  } finally {
    saving.value = false
  }
}

async function rewrapCredentials() {
  if (!selected.value || saving.value) return
  saving.value = true
  clearMessages()
  try {
    const result = await request<{ rewrappedCredentialVersions: number }>(`${actionPath.value}/rewrap-credentials`, { method: 'POST' })
    successMessage.value = `已用当前加密密钥安全轮换 ${result.rewrappedCredentialVersions} 个历史凭据版本。`
    await load()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '凭据加密密钥轮换失败。'
  } finally {
    saving.value = false
  }
}

function versionLabel(version: SupplierConnectionVersion): string {
  return `v${version.versionNumber} · 凭据版本 ${version.credentialVersion} · ${formatDate(version.createdAt)}`
}

void load()
</script>

<template>
  <UDashboardPanel
    id="supplier-connections"
    :ui="{ body: 'min-w-0' }"
  >
    <template #header>
      <UDashboardNavbar title="供应商连接">
        <template #right>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            :loading="loading"
            @click="load"
          >
            刷新
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main class="mx-auto w-full max-w-6xl min-w-0 px-3 py-5 sm:px-6 lg:px-8">
        <div class="mb-5 max-w-3xl">
          <h1 class="text-xl font-semibold text-highlighted">
            外部供应商 API
          </h1>
          <p class="mt-2 text-sm leading-6 text-muted">
            首版仅支持遵守 http_json_v1 的供应商。认证仅以加密形式存储，不会从服务端返回或写入操作日志。更新地址或凭据会创建新版本并停用连接，历史订单仍绑定原版本。
          </p>
        </div>
        <UAlert
          v-if="errorMessage"
          color="error"
          variant="soft"
          icon="i-lucide-circle-alert"
          :title="errorMessage"
          class="mb-4"
          role="alert"
        />
        <UAlert
          v-if="successMessage"
          color="success"
          variant="soft"
          icon="i-lucide-check"
          :title="successMessage"
          class="mb-4"
          role="status"
        />

        <div class="grid min-w-0 gap-5 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.6fr)]">
          <section
            class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            aria-labelledby="supplier-list-title"
          >
            <div class="flex items-center justify-between gap-2">
              <h2
                id="supplier-list-title"
                class="font-semibold text-highlighted"
              >
                连接列表
              </h2>
              <UBadge
                color="neutral"
                variant="subtle"
              >
                {{ connections.length }}
              </UBadge>
            </div>
            <ul
              v-if="connections.length"
              class="mt-3 grid gap-2"
            >
              <li
                v-for="connection in connections"
                :key="connection.id"
              >
                <button
                  type="button"
                  class="min-h-14 w-full rounded-lg border px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  :class="selectedId === connection.id ? 'border-primary/50 bg-primary/5' : 'border-default bg-default hover:bg-muted/50'"
                  :aria-pressed="selectedId === connection.id"
                  @click="selectedId = connection.id"
                >
                  <span class="flex items-center justify-between gap-2">
                    <span class="truncate font-medium text-highlighted">{{ connection.name }}</span>
                    <UBadge
                      :color="connection.enabled ? 'success' : 'neutral'"
                      variant="soft"
                    >{{ connection.enabled ? '已启用' : '已停用' }}</UBadge>
                  </span>
                  <span class="mt-1 block truncate text-xs text-muted">v{{ connection.currentVersion.versionNumber }} · {{ connection.currentVersion.baseUrl }}</span>
                </button>
              </li>
            </ul>
            <p
              v-else
              class="mt-3 rounded-lg bg-muted/40 p-3 text-sm text-muted"
            >
              还没有供应商连接，请在右侧新建。
            </p>
          </section>

          <section class="min-w-0 space-y-5">
            <section
              class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
              aria-labelledby="supplier-form-title"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2
                    id="supplier-form-title"
                    class="font-semibold text-highlighted"
                  >
                    {{ selected ? '连接配置' : '新增连接' }}
                  </h2>
                  <p class="mt-1 text-xs leading-5 text-muted">
                    协议：http_json_v1 · Bearer 身份认证
                  </p>
                </div>
                <UBadge
                  v-if="selected"
                  :color="selected.enabled ? 'success' : 'neutral'"
                  variant="soft"
                >
                  {{ selected.enabled ? '新订单可使用' : '新订单已暂停' }}
                </UBadge>
              </div>
              <div class="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
                <UFormField label="供应商名称">
                  <UInput
                    v-model="form.name"
                    class="w-full"
                    maxlength="120"
                    :disabled="loading || saving"
                    autocomplete="organization"
                  />
                </UFormField>
                <UFormField
                  label="接口基础地址"
                  hint="生产只允许 HTTPS；测试 HTTP 仅允许隔离测试环境显式白名单的本机夹具。"
                >
                  <UInput
                    v-model="form.baseUrl"
                    class="w-full"
                    maxlength="2048"
                    type="url"
                    placeholder="https://supplier.example/api"
                    :disabled="loading || saving"
                    autocomplete="url"
                  />
                </UFormField>
                <UFormField
                  class="sm:col-span-2"
                  :label="selected ? 'Bearer Token（可选轮换）' : 'Bearer Token'"
                  hint="保存后立即清空输入框；服务端不会回显凭据。留空表示保留当前凭据。"
                >
                  <UInput
                    v-model="form.bearerToken"
                    class="w-full"
                    type="password"
                    maxlength="2048"
                    autocomplete="new-password"
                    :disabled="loading || saving"
                  />
                </UFormField>
              </div>
              <div class="mt-4 flex flex-wrap gap-2">
                <UButton
                  v-if="!selected"
                  color="primary"
                  icon="i-lucide-plus"
                  :loading="saving"
                  :disabled="loading || !form.name.trim() || !form.baseUrl.trim() || !form.bearerToken"
                  @click="createConnection"
                >
                  加密保存连接
                </UButton>
                <template v-else>
                  <UButton
                    color="primary"
                    icon="i-lucide-save"
                    :loading="saving"
                    :disabled="loading || !form.name.trim() || !form.baseUrl.trim()"
                    @click="saveConfiguration"
                  >
                    保存新版本
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-radio-tower"
                    :loading="saving"
                    :disabled="loading"
                    @click="testConnection"
                  >
                    测试连接与查单
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-key-round"
                    :loading="saving"
                    :disabled="loading"
                    @click="rewrapCredentials"
                  >
                    轮换加密密钥
                  </UButton>
                  <UButton
                    :color="selected.enabled ? 'warning' : 'success'"
                    variant="outline"
                    :icon="selected.enabled ? 'i-lucide-pause' : 'i-lucide-play'"
                    :loading="saving"
                    :disabled="loading || (!selected.enabled && selected.currentVersion.id === '')"
                    @click="setEnabled(!selected.enabled)"
                  >
                    {{ selected.enabled ? '停用连接' : '明确启用连接' }}
                  </UButton>
                </template>
              </div>
              <div
                v-if="selected"
                class="mt-4 grid gap-2 rounded-lg border border-default bg-default p-3 text-sm sm:grid-cols-2"
              >
                <p><span class="text-muted">当前版本：</span><span class="text-highlighted">{{ selected.currentVersion.name }} · v{{ selected.currentVersion.versionNumber }}</span></p>
                <p><span class="text-muted">认证：</span><span class="text-highlighted">Bearer 已加密保存</span></p>
                <p class="sm:col-span-2 break-all">
                  <span class="text-muted">地址：</span><span class="text-highlighted">{{ selected.currentVersion.baseUrl }}</span>
                </p>
              </div>
              <p
                v-if="testResult"
                class="mt-3 text-sm"
                :class="testResult.connectionOk && testResult.queryCapable ? 'text-success' : 'text-warning'"
              >
                连接 {{ testResult.connectionOk ? '通过' : '失败' }} · 查单 {{ testResult.queryCapable ? '通过' : '失败' }} · {{ formatDate(testResult.checkedAt) }}
              </p>
              <p
                v-if="selected"
                class="mt-3 text-xs leading-5 text-muted"
              >
                停用连接只阻止新订单销售；历史订单仍保留对应版本与加密凭据，以便恢复查单。更换 Token 会保留旧凭据版本。
              </p>
            </section>

            <section
              v-if="selected"
              class="grid min-w-0 gap-5 xl:grid-cols-2"
            >
              <div
                class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
                aria-labelledby="supplier-versions-title"
              >
                <h2
                  id="supplier-versions-title"
                  class="font-semibold text-highlighted"
                >
                  不可变连接版本
                </h2>
                <ol
                  v-if="versions?.items.length"
                  class="mt-3 space-y-2"
                >
                  <li
                    v-for="version in versions.items"
                    :key="version.id"
                    class="min-w-0 rounded-lg border border-default p-3 text-sm"
                  >
                    <p class="font-medium text-highlighted">
                      {{ versionLabel(version) }}
                    </p>
                    <p class="mt-1 break-all text-xs text-muted">
                      {{ version.baseUrl }} · http_json_v1
                    </p>
                  </li>
                </ol>
                <p
                  v-else
                  class="mt-3 text-sm text-muted"
                >
                  没有版本记录。
                </p>
              </div>
              <div
                class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
                aria-labelledby="supplier-audit-title"
              >
                <h2
                  id="supplier-audit-title"
                  class="font-semibold text-highlighted"
                >
                  操作审计
                </h2>
                <ol
                  v-if="audit?.events.length"
                  class="mt-3 space-y-2"
                >
                  <li
                    v-for="event in audit.events"
                    :key="event.id"
                    class="rounded-lg border border-default p-3 text-sm"
                  >
                    <p class="font-medium text-highlighted">
                      {{ actionLabels[event.action] }}
                    </p>
                    <p class="mt-1 text-xs text-muted">
                      管理员 {{ event.administratorId }} · {{ formatDate(event.createdAt) }}
                    </p>
                    <p
                      v-if="event.details.versionNumber"
                      class="mt-1 text-xs text-dimmed"
                    >
                      连接版本 {{ event.details.versionNumber }}{{ event.details.credentialVersion ? ` · 凭据版本 ${event.details.credentialVersion}` : '' }}
                    </p>
                  </li>
                </ol>
                <p
                  v-else
                  class="mt-3 text-sm text-muted"
                >
                  没有操作记录。
                </p>
              </div>
            </section>
          </section>
        </div>
      </main>
    </template>
  </UDashboardPanel>
</template>
