<script setup lang="ts">
import type { AdminWithdrawalList, WithdrawalStatus } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '提现管理' })
if (import.meta.server) useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const { request } = useAdminApi()
const items = ref<AdminWithdrawalList['items']>([])
const page = ref(1)
const pageSize = 20
const total = ref(0)
const totalPages = ref(0)
const status = ref<'all' | WithdrawalStatus>('pending_review')
const loading = ref(true)
const errorMessage = ref('')
let sequence = 0

const statuses: Array<{ label: string; value: 'all' | WithdrawalStatus }> = [
  { label: '全部状态', value: 'all' },
  { label: '待审核', value: 'pending_review' },
  { label: '待打款', value: 'pending_transfer' },
  { label: '打款处理中', value: 'transfer_processing' },
  { label: '结果未知', value: 'transfer_uncertain' },
  { label: '已完成', value: 'completed' },
  { label: '已拒绝', value: 'rejected' },
  { label: '已取消', value: 'cancelled' },
]

function statusLabel(value: WithdrawalStatus): string {
  return statuses.find(item => item.value === value)?.label ?? value
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function statusColor(value: WithdrawalStatus): 'success' | 'warning' | 'error' | 'neutral' | 'primary' {
  if (value === 'completed') return 'success'
  if (value === 'transfer_uncertain') return 'warning'
  if (value === 'rejected') return 'error'
  if (value === 'cancelled') return 'neutral'
  if (value === 'transfer_processing') return 'warning'
  return 'primary'
}

async function load() {
  if (!import.meta.client) return
  const currentSequence = ++sequence
  loading.value = true
  errorMessage.value = ''
  try {
    const query = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) })
    if (status.value !== 'all') query.set('status', status.value)
    const result = await request<AdminWithdrawalList>(`/api/v1/admin/withdrawals?${query}`)
    if (currentSequence !== sequence) return
    items.value = result.items
    total.value = result.total
    totalPages.value = result.totalPages
  } catch (error) {
    if (currentSequence !== sequence) return
    errorMessage.value = error instanceof Error ? error.message : '提现列表暂时无法加载。'
  } finally {
    if (currentSequence === sequence) loading.value = false
  }
}

function setStatus(value: string) {
  if (statuses.some(item => item.value === value)) {
    status.value = value as typeof status.value
    page.value = 1
  }
}

watch([page, status], () => { void load() })
onMounted(() => { void load() })
onBeforeUnmount(() => { sequence++ })
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="提现管理">
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main
        id="admin-main-content"
        class="mx-auto w-full max-w-[90rem] min-w-0 px-4 py-5 sm:px-6 lg:px-8"
      >
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-primary">
              资金与账务
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              提现管理
            </h1>
            <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
              审核现金提现，并先登记人工打款操作。外部转账必须在操作记录提交后执行；未知结果持续冻结并等待核对。
            </p>
          </div>
          <div class="flex w-full flex-wrap gap-2 sm:w-auto">
            <UButton
              to="/admin/withdrawals/settings"
              color="neutral"
              variant="outline"
              icon="i-lucide-settings-2"
              class="min-h-11"
            >
              提现设置
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              class="min-h-11"
              :loading="loading"
              @click="load"
            >
              刷新列表
            </UButton>
          </div>
        </header>

        <UAlert
          v-if="errorMessage"
          class="mb-4"
          color="error"
          variant="soft"
          :title="errorMessage"
          role="alert"
          aria-live="assertive"
        />

        <UCard class="mb-4">
          <div class="grid gap-3 sm:grid-cols-[minmax(16rem,24rem)_1fr] sm:items-end">
            <UFormField
              label="提现状态"
              name="withdrawalStatus"
            >
              <USelect
                :model-value="status"
                :items="statuses"
                class="w-full"
                @update:model-value="setStatus(String($event))"
              />
            </UFormField>
            <p class="text-sm text-muted sm:text-right">
              {{ loading ? '正在读取服务端状态…' : `当前筛选共 ${total} 笔` }}
            </p>
          </div>
        </UCard>

        <div
          v-if="loading && !items.length"
          class="space-y-3"
          aria-busy="true"
          aria-label="正在加载提现申请"
        >
          <div
            v-for="row in 5"
            :key="row"
            class="h-28 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
          />
        </div>
        <UAlert
          v-else-if="!items.length"
          color="neutral"
          variant="subtle"
          icon="i-lucide-banknote-arrow-up"
          title="没有匹配的提现申请"
          description="新的顾客申请及历史提现状态会显示在这里。"
        />
        <section
          v-else
          class="space-y-3"
          aria-label="提现申请列表"
          :aria-busy="loading"
        >
          <article
            v-for="item in items"
            :key="item.id"
            class="grid min-w-0 gap-4 rounded-xl border border-default bg-elevated p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5"
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="break-all font-mono text-sm font-semibold text-highlighted">
                  {{ item.id }}
                </h2>
                <UBadge
                  :color="statusColor(item.status)"
                  variant="soft"
                >
                  {{ statusLabel(item.status) }}
                </UBadge>
              </div>
              <p class="mt-2 break-words text-sm text-muted">
                {{ item.customerUsername ?? '已删除顾客' }} · {{ item.customerEmail ?? '无邮箱' }} · {{ item.customerId }}
              </p>
              <p class="mt-1 text-sm text-muted">
                {{ item.payoutMethod === 'bank_card' ? '银行卡' : item.payoutMethod === 'wechat' ? '微信' : '支付宝' }} · 收款信息：{{ item.maskedRecipient }} · {{ formatDate(item.createdAt) }}
              </p>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
              <dl class="grid grid-cols-3 gap-x-3 text-right text-xs sm:gap-x-4">
                <div>
                  <dt class="text-muted">
                    申请金额
                  </dt><dd class="mt-1 font-semibold tabular-nums text-highlighted">
                    ¥{{ item.amount }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    手续费
                  </dt><dd class="mt-1 font-medium tabular-nums text-highlighted">
                    ¥{{ item.feeAmount }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    打款金额
                  </dt><dd class="mt-1 font-semibold tabular-nums text-primary">
                    ¥{{ item.payoutAmount }}
                  </dd>
                </div>
              </dl>
              <UButton
                :to="`/admin/withdrawals/${item.id}`"
                color="primary"
                variant="outline"
                class="min-h-11 shrink-0"
              >
                审核与处理
              </UButton>
            </div>
          </article>
        </section>

        <nav
          v-if="totalPages > 1"
          class="mt-4 flex flex-wrap items-center justify-between gap-3"
          aria-label="提现列表分页"
        >
          <UButton
            color="neutral"
            variant="outline"
            :disabled="loading || page <= 1"
            @click="page--"
          >
            上一页
          </UButton>
          <span class="text-sm text-muted">第 {{ page }} / {{ totalPages }} 页 · 共 {{ total }} 笔</span>
          <UButton
            color="neutral"
            variant="outline"
            :disabled="loading || page >= totalPages"
            @click="page++"
          >
            下一页
          </UButton>
        </nav>
      </main>
    </template>
  </UDashboardPanel>
</template>
