<script setup lang="ts">
import type { AdminBusinessOverview, AdminSession, ApiSuccess } from '@aikayun/contracts'

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
    { label: '今日新订单', value: data.todayNewOrders, icon: 'i-lucide-calendar-plus' },
    { label: '待付款订单', value: data.pendingPaymentOrders, icon: 'i-lucide-clock-3' },
    { label: '处理中订单', value: data.processingOrders, icon: 'i-lucide-loader-circle' },
    { label: '累计完成订单', value: data.completedOrders, icon: 'i-lucide-circle-check' },
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
        class="mx-auto w-full max-w-6xl p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <p class="text-sm font-medium text-primary">
              工作区
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              管理概览
            </h1>
            <p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
              查看当前管理员会话与已开放的管理内容。
            </p>
          </div>

          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-log-out"
            :loading="busy"
            :disabled="busy"
            class="min-h-11 shrink-0"
            @click="logout"
          >
            退出登录
          </UButton>
        </div>

        <UAlert
          v-if="logoutError"
          class="mt-6"
          color="error"
          variant="soft"
          :title="logoutError"
          role="alert"
          aria-live="assertive"
        />

        <section
          aria-labelledby="session-title"
          class="mt-8"
        >
          <h2
            id="session-title"
            class="text-lg font-semibold text-highlighted"
          >
            当前会话
          </h2>
          <UCard class="mt-4 max-w-2xl">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0">
                <p class="text-sm text-muted">
                  管理员邮箱
                </p>
                <p class="mt-1 break-all font-medium text-highlighted">
                  {{ session?.data.admin.email }}
                </p>
              </div>
              <UBadge
                color="success"
                variant="soft"
                icon="i-lucide-shield-check"
                class="w-fit shrink-0"
              >
                已验证
              </UBadge>
            </div>
          </UCard>
        </section>

        <section
          aria-labelledby="license-title"
          class="mt-10 border-t border-default pt-8"
        >
          <h2
            id="license-title"
            class="text-lg font-semibold text-highlighted"
          >
            经营授权状态
          </h2>
          <UCard class="mt-4 max-w-2xl">
            <p
              v-if="licenseError"
              role="status"
              class="text-sm text-muted"
            >
              授权状态暂时无法读取。
            </p>
            <template v-else>
              <p class="font-medium text-highlighted">
                {{ licenseStatus }}
              </p>
              <p
                v-if="license?.data.allowedUntil"
                class="mt-2 text-sm text-muted"
              >
                有效截止：{{ license.data.allowedUntil }}
              </p>
              <p class="mt-2 text-sm text-muted">
                新订单和充值以提交时的授权检查为准；已有业务继续处理。
              </p>
            </template>
            <UButton
              class="mt-4"
              color="neutral"
              variant="outline"
              @click="refreshLicense()"
            >
              刷新状态
            </UButton>
            <UButton
              to="/admin/license"
              class="mt-4 ml-2"
              icon="i-lucide-key-round"
            >
              管理授权
            </UButton>
          </UCard>
        </section>

        <section
          aria-labelledby="business-data-title"
          class="mt-10 border-t border-default pt-8"
        >
          <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p class="text-sm font-medium text-muted">
                店铺经营
              </p>
              <h2
                id="business-data-title"
                class="mt-1 text-xl font-semibold text-highlighted"
              >
                经营数据
              </h2>
              <p class="mt-2 text-sm text-muted">
                今日订单与付款按北京时间自然日统计。
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
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
            </div>
          </div>

          <UAlert
            v-if="businessOverviewError"
            class="mt-5"
            color="error"
            variant="soft"
            title="经营数据暂时无法读取"
            description="请检查连接后重试。"
            role="alert"
            aria-live="assertive"
          />

          <UCard
            v-else-if="businessOverviewPending && !businessOverview"
            class="mt-5"
          >
            <p
              role="status"
              class="text-sm text-muted"
            >
              正在读取经营数据…
            </p>
          </UCard>

          <template v-else-if="businessOverview">
            <p class="mt-4 text-xs text-muted">
              {{ businessPeriodLabel }} · {{ businessMeasuredAtLabel }}
            </p>
            <div class="mt-4 grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 xl:grid-cols-4">
              <div
                v-for="metric in businessMetrics"
                :key="metric.label"
                role="group"
                :aria-label="metric.label"
                class="min-w-0"
              >
                <UCard class="h-full">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="text-sm text-muted">
                        {{ metric.label }}
                      </p>
                      <p class="mt-3 text-3xl font-semibold tabular-nums text-highlighted">
                        {{ metric.value }}
                      </p>
                    </div>
                    <UIcon
                      :name="metric.icon"
                      class="size-5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                  </div>
                </UCard>
              </div>
            </div>

            <div
              role="group"
              aria-label="今日已确认订单付款"
              class="mt-3"
            >
              <UCard>
                <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p class="text-sm font-medium text-muted">
                      今日已确认订单付款
                    </p>
                    <p class="mt-2 text-3xl font-semibold tabular-nums text-highlighted">
                      {{ formatCnyAmount(businessOverview.todayConfirmedOrderPaymentAmount) }}
                      <span class="text-base font-medium text-muted">CNY</span>
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
                <p class="mt-3 text-xs leading-5 text-muted">
                  按付款回执记录时间统计；仅含关联真实订单、支付成功、准时回执且没有开放对账案例的付款。包含外部支付、钱包现金和赠送余额，按回执原金额汇总，不扣退款；不代表净收入、现金实收或利润。
                </p>
              </UCard>
            </div>
          </template>

          <UAlert
            v-else
            class="mt-5"
            color="error"
            variant="soft"
            title="经营数据暂时无法读取"
            description="请检查连接后重试。"
            role="alert"
            aria-live="assertive"
          />
        </section>
      </main>
    </template>
  </UDashboardPanel>
</template>
