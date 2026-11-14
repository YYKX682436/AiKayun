<script setup lang="ts">
import type { AdminBusinessOverview, AdminSession, ApiSuccess } from '@aikayun/contracts'
import { NuxtLink } from '#components'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '管理概览' })

const { data: session } = await useFetch<ApiSuccess<AdminSession>>('/api/v1/admin/session')
const { data: license, error: licenseError, refresh: refreshLicense } = await useFetch<ApiSuccess<{
  status: string
  allowedUntil: string | null
  retryable: boolean
}>>('/api/v1/admin/license-status')
const {
  data: businessOverviewResponse,
  error: businessOverviewError,
  pending: businessOverviewPending,
  refresh: refreshBusinessOverview,
} = await useFetch<ApiSuccess<AdminBusinessOverview>>('/api/v1/admin/business-overview')
const businessOverview = computed(() => businessOverviewResponse.value?.data)
const businessMetrics = computed(() => {
  const data = businessOverview.value
  if (!data) return []
  return [
    { label: '今日新订单', value: data.todayNewOrders, icon: 'i-lucide-calendar-plus', to: undefined },
    { label: '待付款订单', value: data.pendingPaymentOrders, icon: 'i-lucide-clock-3', to: '/admin/orders?status=pending_payment' },
    { label: '处理中订单', value: data.processingOrders, icon: 'i-lucide-loader-circle', to: '/admin/orders?status=processing' },
    { label: '累计完成订单', value: data.completedOrders, icon: 'i-lucide-circle-check', to: '/admin/orders?status=completed' },
  ]
})
const refreshingBusinessOverview = ref(false)
const beijingTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function formatBeijingDateTime(value: string): string {
  const parts = beijingTimeFormatter.formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}

function formatCnyAmount(value: string): string {
  const [integer, fraction = '00'] = value.split('.')
  const groupedInteger = (integer ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `¥${groupedInteger}.${fraction.padEnd(2, '0')}`
}

const businessPeriodLabel = computed(() => {
  const data = businessOverview.value
  if (!data) return ''
  return `统计区间：${formatBeijingDateTime(data.periodStart)} 至 ${formatBeijingDateTime(data.periodEnd)}（北京时间）`
})
const businessMeasuredAtLabel = computed(() => {
  const data = businessOverview.value
  return data ? `统计时间：${formatBeijingDateTime(data.measuredAt)}（北京时间）` : ''
})

async function refreshBusinessData() {
  if (refreshingBusinessOverview.value) return
  refreshingBusinessOverview.value = true
  try {
    await refreshBusinessOverview()
  } finally {
    refreshingBusinessOverview.value = false
  }
}

const licenseStatus = computed(() => {
  switch (license.value?.data.status) {
    case 'active': return '正常'
    case 'offline_valid': return '离线有效'
    case 'unactivated': return '未激活'
    case 'expired': case 'offline_expired': return '已过期'
    case 'revoked': return '已撤销'
    case 'superseded': return '已被替代'
    case 'clock_suspect': return '时间异常'
    case 'identity_mismatch': return '安装身份异常'
    default: return '暂时无法确认'
  }
})
const busy = ref(false)
const logoutError = ref('')

async function logout() {
  if (busy.value) return

  logoutError.value = ''
  busy.value = true
  try {
    const { data: csrf } = await $fetch<ApiSuccess<{ csrfToken: string }>>('/api/v1/admin/auth/csrf')
    await $fetch('/api/v1/admin/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf.csrfToken },
    })
    await navigateTo('/admin/login')
  } catch {
    logoutError.value = '退出登录暂时失败，请重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="admin-overview">
    <template #header>
      <UDashboardNavbar
        title="管理后台"
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
        class="mx-auto w-full max-w-7xl space-y-6 p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <!-- Top Workspace Bar -->
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <h1 class="text-2xl font-bold tracking-tight text-highlighted sm:text-3xl">
              管理概览
            </h1>
            <p class="mt-1 text-sm text-muted">
              店铺核心经营指标与系统运行状态概览。
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2.5">
            <UButton
              to="/admin/orders"
              color="neutral"
              variant="outline"
              icon="i-lucide-receipt"
              class="min-h-11"
            >
              查看订单
            </UButton>
            <UButton
              to="/admin/operations"
              color="neutral"
              variant="outline"
              icon="i-lucide-activity"
              class="min-h-11"
            >
              运维中心
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="businessOverviewPending || refreshingBusinessOverview"
              :disabled="businessOverviewPending || refreshingBusinessOverview"
              class="min-h-11"
              @click="refreshBusinessData"
            >
              刷新经营数据
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-log-out"
              :loading="busy"
              :disabled="busy"
              class="min-h-11 text-muted hover:text-error"
              @click="logout"
            >
              退出登录
            </UButton>
          </div>
        </div>

        <UAlert
          v-if="logoutError"
          color="error"
          variant="soft"
          :title="logoutError"
          role="alert"
          aria-live="assertive"
        />

        <!-- Section: 经营数据 (Hero Section at Top!) -->
        <section
          aria-labelledby="business-data-title"
          class="space-y-4"
        >
          <div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
            <h2
              id="business-data-title"
              class="text-lg font-semibold tracking-tight text-highlighted"
            >
              经营数据
            </h2>
            <p
              v-if="businessOverview"
              class="text-xs text-muted"
            >
              {{ businessPeriodLabel }} · {{ businessMeasuredAtLabel }}
            </p>
          </div>

          <UAlert
            v-if="businessOverviewError"
            color="error"
            variant="soft"
            title="经营数据暂时无法读取"
            description="请检查连接后重试。"
            role="alert"
            aria-live="assertive"
          />

          <UCard
            v-else-if="businessOverviewPending && !businessOverview"
          >
            <p
              role="status"
              class="text-sm text-muted"
            >
              正在读取经营数据…
            </p>
          </UCard>

          <template v-else-if="businessOverview">
            <!-- Featured Payment Card -->
            <div
              role="group"
              aria-label="今日已确认订单付款"
            >
              <UCard class="border border-default/80 bg-elevated transition-all hover:shadow-xs">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p class="text-sm font-medium text-muted">
                      今日已确认订单付款
                    </p>
                    <p class="mt-2 text-3xl font-bold tracking-tight tabular-nums text-highlighted sm:text-4xl">
                      {{ formatCnyAmount(businessOverview.todayConfirmedOrderPaymentAmount) }}
                      <span class="ml-1 text-base font-semibold text-muted">CNY</span>
                    </p>
                  </div>
                  <UBadge
                    color="success"
                    variant="soft"
                    icon="i-lucide-circle-check"
                    class="w-fit"
                  >
                    已确认
                  </UBadge>
                </div>
                <p class="mt-3 border-t border-default/60 pt-3 text-xs leading-5 text-muted">
                  今日订单与付款按北京时间自然日统计。按付款回执记录时间统计；仅含关联真实订单、支付成功、准时回执且没有开放对账案例的付款。包含外部支付、钱包现金和赠送余额，按回执原金额汇总，不扣退款；不代表净收入、现金实收或利润。
                </p>
              </UCard>
            </div>

            <!-- KPI Metric Cards Grid -->
            <div class="grid grid-cols-1 gap-3.5 min-[360px]:grid-cols-2 xl:grid-cols-4">
              <component
                :is="metric.to ? NuxtLink : 'div'"
                v-for="metric in businessMetrics"
                :key="metric.label"
                :to="metric.to"
                :role="metric.to ? undefined : 'group'"
                :aria-label="metric.label"
                class="group block min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <UCard class="h-full border border-default/80 bg-elevated transition-all hover:border-primary/50 hover:shadow-xs">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="text-sm font-medium text-muted">
                        {{ metric.label }}
                      </p>
                      <p class="mt-2.5 text-2xl font-bold tracking-tight tabular-nums text-highlighted sm:text-3xl">
                        {{ metric.value }}
                      </p>
                    </div>
                    <span
                      class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-inverted"
                      aria-hidden="true"
                    >
                      <UIcon
                        :name="metric.icon"
                        class="size-5"
                      />
                    </span>
                  </div>
                  <div
                    v-if="metric.to"
                    class="mt-3 flex items-center gap-1 text-xs font-medium text-primary"
                  >
                    <span>前往处理</span>
                    <UIcon
                      name="i-lucide-arrow-right"
                      class="size-3.5 transition-transform group-hover:translate-x-0.5"
                    />
                  </div>
                </UCard>
              </component>
            </div>
          </template>

          <UAlert
            v-else
            color="error"
            variant="soft"
            title="经营数据暂时无法读取"
            description="请检查连接后重试。"
            role="alert"
            aria-live="assertive"
          />
        </section>

        <!-- Section: 系统状态与会话 (2 Columns, neat and compact) -->
        <div class="grid grid-cols-1 gap-4 pt-2 lg:grid-cols-2">
          <!-- 经营授权状态 -->
          <section
            aria-labelledby="license-title"
            class="h-full"
          >
            <UCard class="flex h-full flex-col justify-between border border-default/80 bg-elevated">
              <template #header>
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <UIcon
                      name="i-lucide-key-round"
                      class="size-4 text-primary"
                    />
                    <h2
                      id="license-title"
                      class="text-base font-semibold text-highlighted"
                    >
                      经营授权状态
                    </h2>
                  </div>
                  <UBadge
                    v-if="!licenseError"
                    :color="license?.data.status === 'active' || license?.data.status === 'offline_valid' ? 'success' : 'warning'"
                    variant="soft"
                  >
                    {{ licenseStatus }}
                  </UBadge>
                </div>
              </template>

              <div class="space-y-2">
                <p
                  v-if="licenseError"
                  role="status"
                  class="text-sm text-muted"
                >
                  授权状态暂时无法读取。
                </p>
                <template v-else>
                  <p
                    v-if="license?.data.allowedUntil"
                    class="text-sm font-medium text-highlighted"
                  >
                    有效截止：<span class="font-normal tabular-nums text-muted">{{ license.data.allowedUntil }}</span>
                  </p>
                  <p class="text-xs leading-5 text-muted">
                    新订单和充值以提交时的授权检查为准；已有业务继续处理。
                  </p>
                </template>
              </div>

              <template #footer>
                <div class="flex flex-wrap items-center gap-2">
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="sm"
                    icon="i-lucide-refresh-cw"
                    @click="refreshLicense()"
                  >
                    刷新状态
                  </UButton>
                  <UButton
                    to="/admin/license"
                    size="sm"
                    icon="i-lucide-shield"
                  >
                    管理授权
                  </UButton>
                </div>
              </template>
            </UCard>
          </section>

          <!-- 当前会话 -->
          <section
            aria-labelledby="session-title"
            class="h-full"
          >
            <UCard class="flex h-full flex-col justify-between border border-default/80 bg-elevated">
              <template #header>
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <UIcon
                      name="i-lucide-user-check"
                      class="size-4 text-primary"
                    />
                    <h2
                      id="session-title"
                      class="text-base font-semibold text-highlighted"
                    >
                      当前会话
                    </h2>
                  </div>
                  <UBadge
                    color="success"
                    variant="soft"
                    icon="i-lucide-shield-check"
                  >
                    已验证
                  </UBadge>
                </div>
              </template>

              <div class="space-y-2">
                <p class="text-xs text-muted">
                  已登录管理员
                </p>
                <p class="break-all text-sm font-semibold text-highlighted sm:text-base">
                  {{ session?.data.admin.email }}
                </p>
                <p class="text-xs text-muted">
                  接口通过安全 HTTP Cookie 与 CSRF 双重校验。
                </p>
              </div>

              <template #footer>
                <div class="flex items-center gap-2">
                  <UButton
                    to="/admin/operations"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    icon="i-lucide-activity"
                    class="text-muted hover:text-highlighted"
                  >
                    系统指标
                  </UButton>
                </div>
              </template>
            </UCard>
          </section>
        </div>
      </main>
    </template>
  </UDashboardPanel>
</template>
