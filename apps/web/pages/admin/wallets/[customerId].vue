<script setup lang="ts">
import type { AdminPaymentReconciliationResult, AdminWalletDetail, CustomerWalletLedgerEntry, CustomerTopUp } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '顾客钱包明细' })

const route = useRoute()
const { request } = useAdminApi()
const detail = ref<AdminWalletDetail | null>(null)
const page = ref(1)
const loading = ref(true)
const errorMessage = ref('')
const reconciliationMessage = ref('')
const reconcilingAttemptId = ref('')
let sequence = 0
const customerId = computed(() => String(route.params.customerId))
const totalPages = computed(() => Math.max(detail.value?.ledger.totalPages ?? 0, detail.value?.topUps.totalPages ?? 0))

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function ledgerAction(item: CustomerWalletLedgerEntry) {
  const source = item.bucket === 'gift' ? '赠送余额' : '现金余额'
  const actions: Record<CustomerWalletLedgerEntry['action'], string> = {
    credit_available: '入账', debit_available: '扣款', freeze: '冻结', unfreeze: '解冻', debit_frozen: '冻结扣款',
  }
  return `${source}${actions[item.action]}`
}

function topUpStatus(item: CustomerTopUp) {
  if (item.reconciliationOpen || item.status === 'reconciliation_required') return '异常核对中'
  if (item.status === 'succeeded') return '已到账'
  if (item.status === 'late_succeeded') return '迟到收款待处理'
  if (item.status === 'failed') return '支付失败'
  if (item.status === 'expired') return '已过期'
  if (item.status === 'cancelled') return '已取消'
  if (item.providerState === 'unknown' || item.providerState === 'requesting') return '结果确认中'
  return '待支付'
}

function reconciliationReasonLabel(value: CustomerTopUp['reconciliationReasons'][number]) {
  const labels = {
    callback_query_mismatch: '回调与查单不一致', provider_identity_conflict: '服务商身份不一致',
    provider_transaction_conflict: '服务商交易号重复', provider_amount_mismatch: '实收金额不符',
    receipt_conflict: '收款凭证冲突', late_confirmed_payment: '迟到收款',
  }
  return labels[value]
}

async function loadDetail() {
  if (!import.meta.client) return
  const requestSequence = ++sequence
  loading.value = true
  errorMessage.value = ''
  try {
    const query = new URLSearchParams({ page: String(page.value), pageSize: '20' })
    detail.value = await request<AdminWalletDetail>(`/api/v1/admin/wallets/${customerId.value}?${query}`)
  } catch (error) {
    if (sequence === requestSequence) errorMessage.value = error instanceof Error ? error.message : '钱包明细暂时无法加载。'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

async function reconcileTopUp(attemptId: string) {
  if (reconcilingAttemptId.value) return
  reconcilingAttemptId.value = attemptId
  reconciliationMessage.value = ''
  errorMessage.value = ''
  try {
    const result = await request<AdminPaymentReconciliationResult>(
      `/api/v1/admin/wallets/${customerId.value}/top-ups/${attemptId}/reconcile`, { method: 'POST' },
    )
    reconciliationMessage.value = result.message
    await loadDetail()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '充值核对暂时无法完成。'
  } finally {
    reconcilingAttemptId.value = ''
  }
}

watch([customerId, page], () => { void loadDetail() }, { immediate: true })
onBeforeUnmount(() => { sequence++ })
</script>

<template>
  <UDashboardPanel id="admin-wallet-detail">
    <template #header>
      <UDashboardNavbar title="钱包与充值">
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main
        id="admin-main"
        class="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8"
      >
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p class="text-sm font-medium text-primary">
              资金与账务
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              顾客钱包明细
            </h1>
            <p
              v-if="detail"
              class="mt-2 text-sm text-muted"
            >
              {{ detail.username ?? '已删除顾客' }} · {{ detail.status }} · {{ detail.customerId }}
            </p>
          </div>
          <UButton
            to="/admin/wallets"
            color="neutral"
            variant="outline"
            icon="i-lucide-arrow-left"
            class="min-h-11"
          >
            返回钱包列表
          </UButton>
        </div>
        <UAlert
          v-if="errorMessage"
          class="mt-5"
          color="error"
          variant="soft"
          :title="errorMessage"
          role="alert"
        />
        <UAlert
          v-if="reconciliationMessage"
          class="mt-5"
          color="neutral"
          variant="soft"
          :title="reconciliationMessage"
          role="status"
          aria-live="polite"
        />
        <div
          v-if="loading && !detail"
          class="mt-5 h-40 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
          aria-busy="true"
        />
        <template v-if="detail">
          <section
            class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
            aria-label="顾客钱包余额"
          >
            <UCard>
              <p class="text-sm text-muted">
                可用现金
              </p><p class="mt-2 text-xl font-semibold tabular-nums text-highlighted">
                ¥{{ detail.wallet.cashAvailable }}
              </p>
            </UCard>
            <UCard>
              <p class="text-sm text-muted">
                冻结现金
              </p><p class="mt-2 text-xl font-semibold tabular-nums text-highlighted">
                ¥{{ detail.wallet.cashFrozen }}
              </p>
            </UCard>
            <UCard>
              <p class="text-sm text-muted">
                可用赠送
              </p><p class="mt-2 text-xl font-semibold tabular-nums text-highlighted">
                ¥{{ detail.wallet.giftAvailable }}
              </p>
            </UCard>
            <UCard>
              <p class="text-sm text-muted">
                冻结赠送
              </p><p class="mt-2 text-xl font-semibold tabular-nums text-highlighted">
                ¥{{ detail.wallet.giftFrozen }}
              </p>
            </UCard>
            <UCard class="border-primary/30 bg-primary/5">
              <p class="text-sm text-muted">
                总可用
              </p><p class="mt-2 text-xl font-semibold tabular-nums text-highlighted">
                ¥{{ detail.wallet.totalAvailable }}
              </p>
            </UCard>
          </section>
          <UAlert
            class="mt-5"
            color="warning"
            variant="soft"
            icon="i-lucide-shield-alert"
            title="只读资金审计：后台不提供直接修改余额或伪造充值的入口。异常凭证需要通过支付对账流程处理。"
          />

          <section
            class="mt-8"
            aria-labelledby="admin-topups-title"
          >
            <div class="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2
                  id="admin-topups-title"
                  class="text-xl font-semibold text-highlighted"
                >
                  充值记录与支付凭证
                </h2><p class="mt-1 text-sm text-muted">
                  异常状态会阻止充值入账，凭证与到账金额保留原始关联。
                </p>
              </div>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-refresh-cw"
                :loading="loading"
                @click="loadDetail"
              >
                刷新
              </UButton>
            </div>
            <div
              v-if="detail.topUps.items.length"
              class="mt-4 grid gap-3"
            >
              <UCard
                v-for="item in detail.topUps.items"
                :key="item.id"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="font-semibold tabular-nums text-highlighted">
                      充值 ¥{{ item.amount }}
                    </p>
                    <p class="mt-1 text-sm text-muted">
                      {{ item.channelName ?? '在线支付' }} · {{ item.paymentMethod ?? '支付方式未知' }} · {{ formatDate(item.createdAt) }}
                    </p>
                    <p class="mt-1 break-all font-mono text-xs text-muted">
                      支付尝试 {{ item.id }}
                    </p>
                    <p
                      v-if="item.providerTransactionId"
                      class="mt-1 break-all font-mono text-xs text-muted"
                    >
                      平台交易号 {{ item.providerTransactionId }}
                    </p>
                    <p
                      v-if="item.receiptDisposition"
                      class="mt-1 text-xs text-muted"
                    >
                      回执 {{ item.receiptDisposition }} · 实收 ¥{{ item.receiptAmount }}
                    </p>
                    <p
                      v-if="item.reconciliationReasons.length"
                      class="mt-1 text-xs text-warning"
                    >
                      待核对：{{ item.reconciliationReasons.map(reconciliationReasonLabel).join('、') }}
                    </p>
                  </div>
                  <UBadge
                    :color="item.reconciliationOpen || item.status === 'reconciliation_required' ? 'warning' : item.status === 'succeeded' ? 'success' : 'neutral'"
                    variant="soft"
                  >
                    {{ topUpStatus(item) }}
                  </UBadge>
                  <UButton
                    v-if="item.reconciliationOpen"
                    color="warning"
                    variant="outline"
                    size="sm"
                    :loading="reconcilingAttemptId === item.id"
                    :disabled="Boolean(reconcilingAttemptId)"
                    @click="reconcileTopUp(item.id)"
                  >
                    服务商查单核对
                  </UButton>
                </div>
              </UCard>
            </div>
            <UCard
              v-else
              class="mt-4"
            >
              <p class="text-sm text-muted">
                暂无充值记录。
              </p>
            </UCard>
          </section>

          <section
            class="mt-8"
            aria-labelledby="admin-ledger-title"
          >
            <div>
              <h2
                id="admin-ledger-title"
                class="text-xl font-semibold text-highlighted"
              >
                不可变钱包流水
              </h2><p class="mt-1 text-sm text-muted">
                展示资金来源、账本操作、订单与支付尝试关联。
              </p>
            </div>
            <div
              v-if="detail.ledger.items.length"
              class="mt-4 grid gap-3"
            >
              <UCard
                v-for="item in detail.ledger.items"
                :key="item.id"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="font-medium text-highlighted">
                      {{ ledgerAction(item) }} · {{ item.operationType }}
                    </p>
                    <p class="mt-1 text-sm text-muted">
                      {{ formatDate(item.createdAt) }} · 操作 {{ item.operationId }}
                    </p>
                    <p
                      v-if="item.orderId"
                      class="mt-1 break-all text-xs text-muted"
                    >
                      关联订单 {{ item.orderId }}
                    </p>
                    <p
                      v-if="item.paymentAttemptId"
                      class="mt-1 break-all text-xs text-muted"
                    >
                      支付尝试 {{ item.paymentAttemptId }} · {{ item.paymentStatus }} · {{ item.paymentDisposition }}
                    </p>
                    <p
                      v-if="item.providerTransactionId"
                      class="mt-1 break-all font-mono text-xs text-muted"
                    >
                      平台交易号 {{ item.providerTransactionId }}
                    </p>
                  </div>
                  <p class="shrink-0 font-semibold tabular-nums text-highlighted">
                    ¥{{ item.amount }}
                  </p>
                </div>
              </UCard>
            </div>
            <UCard
              v-else
              class="mt-4"
            >
              <p class="text-sm text-muted">
                暂无钱包流水。
              </p>
            </UCard>
          </section>
          <div
            v-if="totalPages > 1"
            class="mt-5 flex flex-wrap items-center justify-between gap-3"
          >
            <p class="text-sm text-muted">
              第 {{ page }} / {{ totalPages }} 页（充值与流水分别按服务端分页）
            </p>
            <div class="flex gap-2">
              <UButton
                color="neutral"
                variant="outline"
                :disabled="page <= 1 || loading"
                @click="page--"
              >
                上一页
              </UButton><UButton
                color="neutral"
                variant="outline"
                :disabled="page >= totalPages || loading"
                @click="page++"
              >
                下一页
              </UButton>
            </div>
          </div>
        </template>
      </main>
    </template>
  </UDashboardPanel>
</template>
