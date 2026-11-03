<script setup lang="ts">
import type { ApiSuccess, CsrfToken } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '经营授权' })

interface LicenseActivationStatus {
  status: string
  allowedUntil: string | null
  retryable: boolean
  pendingOperation: string | null
  trustBundle: string
}

const activationCredential = ref('')
const loading = ref(false)
const refreshing = ref(false)
const importingBundle = ref(false)
const errorMessage = ref('')
const notice = ref('')
const licenseStatus = ref<LicenseActivationStatus | null>(null)

function statusOf(error: unknown): number {
  return error && typeof error === 'object' && 'statusCode' in error
    ? Number((error as { statusCode: unknown }).statusCode)
    : 0
}

function codeOf(error: unknown): string {
  if (!error || typeof error !== 'object' || !('data' in error)) return ''
  const data = (error as { data?: { error?: { code?: unknown } } }).data
  return typeof data?.error?.code === 'string' ? data.error.code : ''
}

function licenseLabel(status: string): string {
  switch (status) {
    case 'active': return '授权有效'
    case 'offline_valid': return '当前离线有效'
    case 'unactivated': return '尚未激活'
    case 'expired': case 'offline_expired': return '授权已过期'
    case 'revoked': return '授权已撤销'
    case 'superseded': return '授权已被替代'
    case 'clock_suspect': return '系统时间需要检查'
    case 'identity_mismatch': return '实例身份检查失败'
    case 'pending': return '正在确认授权结果'
    default: return '暂时无法确认授权状态'
  }
}

async function refreshStatus() {
  refreshing.value = true
  try {
    const [license, activation] = await Promise.all([
      $fetch<ApiSuccess<{ status: string; allowedUntil: string | null; retryable: boolean }>>('/api/v1/admin/license-status'),
      $fetch<ApiSuccess<LicenseActivationStatus>>('/api/v1/admin/license-activation/status'),
    ])
    licenseStatus.value = { ...activation.data, status: license.data.status, allowedUntil: license.data.allowedUntil, retryable: license.data.retryable }
  } catch {
    errorMessage.value = '暂时无法读取授权状态，请稍后刷新。'
  } finally {
    refreshing.value = false
  }
}

onMounted(() => { void refreshStatus() })

async function submitCredential() {
  if (loading.value) return
  errorMessage.value = ''
  notice.value = ''
  loading.value = true
  try {
    const { data: csrf } = await $fetch<ApiSuccess<CsrfToken>>('/api/v1/admin/auth/csrf')
    const { data } = await $fetch<ApiSuccess<{ status: string; allowedUntil: string | null; retryable: boolean }>>(
      '/api/v1/admin/license-activation',
      { method: 'POST', headers: { 'x-csrf-token': csrf.csrfToken }, body: { credential: activationCredential.value } },
    )
    if (data.status === 'active' || data.status === 'offline_valid') {
      activationCredential.value = ''
      notice.value = '授权已激活。'
    } else {
      notice.value = '操作仍在确认中。请保留原组合凭证，再次提交会继续同一操作。'
    }
    await refreshStatus()
  } catch (error) {
    const code = codeOf(error)
    if (code === 'LICENSE_ACTIVATION_PENDING') {
      errorMessage.value = '这个授权已有未完成操作。请使用原组合凭证继续。'
    } else if (code === 'LICENSE_ACTIVATION_CREDENTIAL_INVALID' || code === 'LICENSE_ACTIVATION_FORMAT_INVALID') {
      errorMessage.value = '组合凭证格式不正确或未获授权，请检查后重试。'
    } else if (code === 'LICENSE_ALREADY_BOUND') {
      errorMessage.value = '此实例已经绑定授权记录，请检查上方状态。'
    } else if (code === 'LICENSE_TRUST_UNCONFIGURED' || code === 'LICENSE_ACTIVATION_UNAVAILABLE') {
      errorMessage.value = '授权服务暂时无法完成验证。请稍后使用同一组合凭证安全重试。'
    } else if (statusOf(error) === 403) {
      errorMessage.value = '请求未通过安全校验，请刷新页面后重试。'
    } else if (statusOf(error) === 429) {
      errorMessage.value = '操作过于频繁，请稍后再试。'
    } else {
      errorMessage.value = '操作结果暂时无法确认。请保留原组合凭证，稍后再次提交以继续原操作。'
    }
    await refreshStatus()
  } finally {
    loading.value = false
  }
}

async function importTrustBundle(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  errorMessage.value = ''
  notice.value = ''
  if (file.size < 100 || file.size > 16 * 1024) {
    errorMessage.value = '签名信任文件大小不符合要求。'
    input.value = ''
    return
  }
  importingBundle.value = true
  try {
    const text = await file.text()
    const bundleJws = text.endsWith('\n') ? text.slice(0, -1) : text
    const { data: csrf } = await $fetch<ApiSuccess<CsrfToken>>('/api/v1/admin/auth/csrf')
    const { data } = await $fetch<ApiSuccess<{ imported: boolean; bundleVersion: string }>>('/api/v1/admin/license-trust-bundle/import', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf.csrfToken },
      body: { bundleJws },
    })
    notice.value = `签名信任材料已导入，版本 ${data.bundleVersion}。`
    await refreshStatus()
  } catch {
    errorMessage.value = '签名信任文件未通过内嵌授权根验证，请取得当前有效的 root 签名文件后重试。'
    await refreshStatus()
  } finally {
    importingBundle.value = false
    input.value = ''
  }
}

const trustMessage = computed(() => {
  if (!licenseStatus.value) return '正在读取…'
  if (licenseStatus.value.trustBundle === 'ready') return '签名信任材料已就绪。'
  if (licenseStatus.value.trustBundle === 'release_unconfigured') return '当前发行没有可用的正式授权信任配置。'
  if (licenseStatus.value.trustBundle === 'uninitialized') return 'Trust Bundle 尚未初始化。请检查已验证发行工件中的签名文件。'
  return '无法读取 Trust Store。新经营仍按安全策略暂停。'
})

const licenseReason = computed(() => {
  switch (licenseStatus.value?.status) {
    case 'clock_suspect': return '系统时间与可信时间记录不一致，请检查服务器时钟后重试。'
    case 'identity_mismatch': return '实例身份文件与数据库绑定不一致，系统已停止自动更换身份。'
    case 'offline_expired': return '当前授权期限已过，且授权中心暂时无法确认新状态。'
    case 'expired': return '授权已过期，新订单和充值保持关闭；已有交易继续处理。'
    case 'revoked': return '授权中心已确认撤销。历史付款、退款、提现、履约和下载仍可继续恢复。'
    case 'superseded': return '此授权实例已被更新的授权登记替代。'
    case 'unactivated': return '完成首次激活后，新订单和充值才会开放。'
    default: return ''
  }
})
</script>

<template>
  <UDashboardPanel id="admin-license">
    <template #header>
      <UDashboardNavbar
        title="经营授权"
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
        class="mx-auto w-full max-w-5xl p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <p class="text-sm font-medium text-primary">
              管理后台
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              经营授权
            </h1>
            <p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
              输入由运营方提供的组合凭证。激活请求会与此安装身份绑定，并通过固定授权中心验证。
            </p>
          </div>
          <UButton
            to="/admin"
            color="neutral"
            variant="outline"
            icon="i-lucide-arrow-left"
            class="min-h-11 shrink-0"
          >
            返回概览
          </UButton>
        </div>

        <section
          aria-labelledby="license-state-title"
          class="mt-8"
        >
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2
              id="license-state-title"
              class="text-lg font-semibold text-highlighted"
            >
              当前状态
            </h2>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="refreshing"
              :disabled="refreshing"
              class="min-h-11"
              @click="refreshStatus"
            >
              刷新状态
            </UButton>
          </div>
          <UCard class="mt-4 max-w-3xl">
            <div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <p class="font-medium text-highlighted">
                  {{ licenseStatus ? licenseLabel(licenseStatus.status) : '正在读取授权状态…' }}
                </p>
                <p
                  v-if="licenseStatus?.allowedUntil"
                  class="mt-2 text-sm text-muted"
                >
                  有效截止：{{ new Date(licenseStatus.allowedUntil).toLocaleString() }}
                </p>
                <p
                  v-if="licenseStatus?.pendingOperation"
                  class="mt-2 text-sm text-warning"
                >
                  存在未完成操作：{{ licenseStatus.pendingOperation === 'response_saved' ? '结果待确认' : '等待授权中心确认' }}。请用原组合凭证继续。
                </p>
              </div>
              <UBadge
                :color="licenseStatus?.status === 'active' || licenseStatus?.status === 'offline_valid' ? 'success' : licenseStatus?.status === 'unactivated' ? 'neutral' : 'warning'"
                variant="soft"
                :icon="licenseStatus?.status === 'active' || licenseStatus?.status === 'offline_valid' ? 'i-lucide-shield-check' : 'i-lucide-shield-alert'"
                class="w-fit shrink-0"
              >
                {{ licenseStatus ? licenseLabel(licenseStatus.status) : '读取中' }}
              </UBadge>
            </div>
            <p class="mt-4 border-t border-default pt-4 text-sm leading-6 text-muted">
              {{ trustMessage }} 新订单与充值在授权有效时才开放；历史付款、退款、提现、履约和下载继续按原流程处理。
            </p>
            <p
              v-if="licenseReason"
              class="mt-3 text-sm leading-6 text-warning"
            >
              {{ licenseReason }}
            </p>
          </UCard>
        </section>

        <section
          v-if="licenseStatus && licenseStatus.trustBundle !== 'ready'"
          aria-labelledby="trust-import-title"
          class="mt-10 border-t border-default pt-8"
        >
          <h2
            id="trust-import-title"
            class="text-lg font-semibold text-highlighted"
          >
            导入签名信任文件
          </h2>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
            仅在发行工件未附带有效文件或文件已过期时使用。系统会用发行镜像内固定的授权中心离线根、公证版本和可信时间验证文件；未通过验证的文件不会写入 Trust Store。
          </p>
          <UCard class="mt-4 max-w-3xl">
            <form
              class="grid gap-5"
              @submit.prevent
            >
              <UFormField
                label="root 签名 Trust Bundle（JWS）"
                name="trustBundle"
                description="上传内容不会写入日志或浏览器存储；验证成功后以签名工件形式保存在本机 Trust Store。"
                required
              >
                <input
                  id="trustBundle"
                  type="file"
                  accept=".jws,application/octet-stream,text/plain"
                  class="block min-h-11 w-full cursor-pointer rounded-lg border border-default bg-elevated px-3 py-2 text-sm text-default file:mr-3 file:min-h-8 file:rounded-md file:border-0 file:bg-muted file:px-3 file:font-medium file:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  :disabled="importingBundle"
                  @change="importTrustBundle"
                >
              </UFormField>
              <UBadge
                color="neutral"
                variant="soft"
                class="w-fit"
              >
                {{ importingBundle ? '正在验证签名' : '仅接受与本发行固定授权根匹配的签名文件' }}
              </UBadge>
            </form>
          </UCard>
        </section>

        <section
          aria-labelledby="activate-title"
          class="mt-10 border-t border-default pt-8"
        >
          <h2
            id="activate-title"
            class="text-lg font-semibold text-highlighted"
          >
            输入组合授权凭证
          </h2>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
            格式为 <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-highlighted">AK1.&lt;licenseId&gt;.&lt;activationCode&gt;</code>。系统不会记录或回显凭证原文。
          </p>

          <UCard class="mt-4 max-w-3xl">
            <UAlert
              v-if="notice"
              class="mb-5"
              color="success"
              variant="soft"
              :title="notice"
              role="status"
              aria-live="polite"
            />
            <UAlert
              v-if="errorMessage"
              class="mb-5"
              color="error"
              variant="soft"
              :title="errorMessage"
              role="alert"
              aria-live="assertive"
            />
            <form
              class="grid gap-5"
              :aria-busy="loading"
              @submit.prevent="submitCredential"
            >
              <UFormField
                label="组合授权凭证"
                name="credential"
                description="凭证仅在当前页面内存中使用，不会进入网址。"
                required
              >
                <UInput
                  v-model="activationCredential"
                  type="password"
                  autocomplete="one-time-code"
                  spellcheck="false"
                  required
                  maxlength="128"
                  placeholder="AK1.…"
                  class="w-full font-mono"
                  size="lg"
                  :disabled="loading || !licenseStatus || licenseStatus.status === 'active' || licenseStatus.status === 'offline_valid'"
                />
              </UFormField>
              <UButton
                type="submit"
                size="lg"
                icon="i-lucide-key-round"
                :loading="loading"
                :disabled="loading || !activationCredential || licenseStatus?.status === 'active' || licenseStatus?.status === 'offline_valid'"
              >
                {{ licenseStatus?.pendingOperation ? '继续原激活操作' : '验证并激活' }}
              </UButton>
            </form>
          </UCard>
        </section>
      </main>
    </template>
  </UDashboardPanel>
</template>
