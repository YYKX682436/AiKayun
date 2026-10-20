<script setup lang="ts">
import type { AdminWithdrawalDetail, WithdrawalPayoutAttempt, WithdrawalStatus } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '提现申请详情' })
if (import.meta.server) useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const route = useRoute()
const withdrawalId = computed(() => String(route.params.id))
const { request } = useAdminApi()
const detail = shallowRef<AdminWithdrawalDetail | null>(null)
const loading = ref(false)
const busy = ref('')
const errorMessage = ref('')
const successMessage = ref('')
const rejectionReason = ref('')
const evidenceSummary = ref('')
const evidenceSha256 = ref('')
const providerReference = ref('')
const actualPayoutAt = ref('')
const revealRecipient = ref(false)
let sequence = 0

const activeAttempt = computed(() => {
  const attempts = detail.value?.payoutAttempts ?? []
  return [...attempts].reverse().find(attempt => attempt.status === 'started' || attempt.status === 'unknown') ?? null
})

function statusLabel(value: WithdrawalStatus): string {
  const names: Record<WithdrawalStatus, string> = {
    pending_review: '待审核', pending_transfer: '待打款', transfer_processing: '打款处理中',
    transfer_uncertain: '结果未知 · 资金冻结', completed: '已完成', rejected: '已拒绝', cancelled: '已取消',
  }
  return names[value]
}

function attemptStatusLabel(value: WithdrawalPayoutAttempt['status']): string {
  return value === 'started' ? '处理中' : value === 'unknown' ? '结果未知' : value === 'succeeded' ? '打款成功' : '确认未转账'
}

function methodLabel(value: AdminWithdrawalDetail['payoutMethod']): string {
  return value === 'bank_card' ? '银行卡' : value === 'wechat' ? '微信' : '支付宝'
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function localDateTimeValue() {
  const current = new Date()
  return new Date(current.getTime() - current.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

async function loadWithdrawal() {
  const currentSequence = ++sequence
  loading.value = true
  errorMessage.value = ''
  try {
    detail.value = await request<AdminWithdrawalDetail>(`/api/v1/admin/withdrawals/${withdrawalId.value}`)
  } catch (error) {
    if (currentSequence !== sequence) return
    errorMessage.value = error instanceof Error ? error.message : '提现详情暂时无法加载。'
  } finally {
    if (currentSequence === sequence) loading.value = false
  }
}

async function actionKey(action: string, payload: Record<string, unknown> = {}): Promise<string> {
  if (!import.meta.client) throw new Error('请在后台浏览器中处理提现。')
  const bytes = new TextEncoder().encode(JSON.stringify({ withdrawalId: withdrawalId.value, action, payload }))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const keyName = `aikayun-admin-withdrawal-v1:${fingerprint}`
  try {
    const existing = sessionStorage.getItem(keyName)
    if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing
    const next = crypto.randomUUID()
    sessionStorage.setItem(keyName, next)
    return next
  } catch {
    throw new Error('浏览器无法保存提现操作的幂等标识，请启用会话存储后重试。')
  }
}

async function runAction(action: string, path: string, body: Record<string, unknown>, successText: string) {
  if (busy.value || !detail.value) return
  busy.value = action
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await request<AdminWithdrawalDetail>(path, {
      method: 'POST',
      body: { ...body, idempotencyKey: await actionKey(action, body) },
    })
    detail.value = result
    successMessage.value = successText
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError || error instanceof Error
      ? error.message : '操作结果尚未确认，正在读取服务端提现状态。'
    try { detail.value = await request<AdminWithdrawalDetail>(`/api/v1/admin/withdrawals/${withdrawalId.value}`) } catch { /* Keep the action error visible. */ }
  } finally {
    busy.value = ''
  }
}

async function approve() {
  await runAction('approve', `/api/v1/admin/withdrawals/${withdrawalId.value}/approve`, {}, '已通过审核，完整提现金额继续冻结并进入待打款。')
}

async function reject() {
  const reason = rejectionReason.value.trim()
  if (!reason) {
    errorMessage.value = '拒绝申请必须填写原因。'
    return
  }
  await runAction('reject', `/api/v1/admin/withdrawals/${withdrawalId.value}/reject`, { reason }, '已记录审核拒绝，冻结现金已由原有账本触发器完整解冻。')
}

async function startPayout() {
  await runAction('payout-start', `/api/v1/admin/withdrawals/${withdrawalId.value}/payout-attempts`, {}, '打款操作已先记录到服务端。现在才可以前往支付应用或银行实际转账。')
}

function evidenceValid(): boolean {
  return /^[0-9a-f]{64}$/u.test(evidenceSha256.value.trim()) && Boolean(evidenceSummary.value.trim())
}

async function resolve(outcome: 'unknown' | 'failed' | 'succeeded') {
  if (!activeAttempt.value) return
  const summary = evidenceSummary.value.trim()
  const digest = evidenceSha256.value.trim()
  if (!evidenceValid()) {
    errorMessage.value = '请填写转账核对摘要及其 64 位小写 SHA-256 凭证摘要。'
    return
  }
  if (outcome === 'failed' && !noTransferConfirmed.value) {
    errorMessage.value = '只有确认没有发生实际转账后，才能登记失败并允许安全重试。'
    return
  }
  if (outcome === 'succeeded' && !providerReference.value.trim()) {
    errorMessage.value = '成功结果必须填写真实转账参考号。'
    return
  }
  const body: Record<string, unknown> = outcome === 'unknown'
    ? { outcome, evidenceSha256: digest, evidenceSummary: summary }
    : outcome === 'failed'
      ? { outcome, confirmedNoTransfer: true, evidenceSha256: digest, evidenceSummary: summary }
      : {
          outcome,
          providerReference: providerReference.value.trim(),
          actualPayoutAmount: detail.value!.payoutAmount,
          actualPayoutAt: new Date(actualPayoutAt.value).toISOString(),
          evidenceSha256: digest,
          evidenceSummary: summary,
        }
  await runAction(
    `payout-${outcome}:${activeAttempt.value.id}`,
    `/api/v1/admin/withdrawals/${withdrawalId.value}/payout-attempts/${activeAttempt.value.id}/resolve`,
    body,
    outcome === 'succeeded'
      ? '已记录真实转账成功；原有账本已扣除全部冻结金额。'
      : outcome === 'failed'
        ? '已确认未发生转账，资金仍冻结，当前申请允许重新开始打款。'
        : '已记录结果未知；资金继续冻结且禁止新建打款尝试。',
  )
}

const noTransferConfirmed = ref(false)

watch(withdrawalId, () => { void loadWithdrawal() }, { immediate: true })
watch(detail, (value) => {
  if (value) actualPayoutAt.value = localDateTimeValue()
})
onBeforeUnmount(() => { sequence++ })
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="提现申请详情">
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
        <header class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-primary">
              提现管理
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              申请审核与人工打款
            </h1>
            <p class="mt-2 break-all font-mono text-xs text-muted">
              {{ withdrawalId }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton
              to="/admin/withdrawals"
              color="neutral"
              variant="outline"
              icon="i-lucide-arrow-left"
              class="min-h-11"
            >
              返回列表
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              class="min-h-11"
              :loading="loading"
              @click="loadWithdrawal"
            >
              刷新状态
            </UButton>
          </div>
        </header>

        <UAlert
          v-if="errorMessage"
          class="mt-5"
          color="error"
          variant="soft"
          :title="errorMessage"
          role="alert"
          aria-live="assertive"
        />
        <UAlert
          v-if="successMessage"
          class="mt-5"
          color="success"
          variant="soft"
          :title="successMessage"
          role="status"
          aria-live="polite"
        />
        <div
          v-if="loading && !detail"
          class="mt-6 grid gap-3 lg:grid-cols-2"
          aria-busy="true"
          aria-label="正在加载提现详情"
        >
          <div
            v-for="item in 4"
            :key="item"
            class="h-48 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
          />
        </div>

        <template v-if="detail">
          <UAlert
            v-if="detail.status === 'transfer_uncertain'"
            class="mt-5"
            color="warning"
            variant="soft"
            icon="i-lucide-circle-help"
            title="打款结果未知，资金继续冻结"
            description="请核对已经开始的转账操作。确认到账后记录成功；确认没有转账后记录失败；未能确认时保留未知状态。"
            role="status"
          />

          <div class="mt-6 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(19rem,0.9fr)]">
            <div class="grid min-w-0 content-start gap-6">
              <UCard>
                <template #header>
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <h2 class="text-lg font-semibold text-highlighted">
                      申请与顾客
                    </h2>
                    <UBadge
                      :color="detail.status === 'completed' ? 'success' : detail.status === 'transfer_uncertain' ? 'warning' : detail.status === 'rejected' ? 'error' : 'primary'"
                      variant="soft"
                    >
                      {{ statusLabel(detail.status) }}
                    </UBadge>
                  </div>
                </template>
                <dl class="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt class="text-sm text-muted">
                      顾客用户名
                    </dt><dd class="mt-1 break-words font-medium text-highlighted">
                      {{ detail.customer.username ?? '已删除顾客' }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-sm text-muted">
                      账户状态
                    </dt><dd class="mt-1 font-medium text-highlighted">
                      {{ detail.customer.status === 'active' ? '正常' : detail.customer.status === 'disabled' ? '已禁用' : '已删除' }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-sm text-muted">
                      邮箱
                    </dt><dd class="mt-1 break-all text-highlighted">
                      {{ detail.customer.email ?? '未填写' }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-sm text-muted">
                      电话
                    </dt><dd class="mt-1 break-all text-highlighted">
                      {{ detail.customer.phone ?? '未填写' }}
                    </dd>
                  </div>
                </dl>
                <div class="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-muted p-4 sm:grid-cols-4">
                  <div>
                    <p class="text-xs text-muted">
                      申请金额
                    </p><p class="mt-1 font-semibold tabular-nums text-highlighted">
                      ¥{{ detail.amount }}
                    </p>
                  </div>
                  <div>
                    <p class="text-xs text-muted">
                      手续费快照
                    </p><p class="mt-1 font-medium tabular-nums text-highlighted">
                      ¥{{ detail.feeAmount }}
                    </p>
                  </div>
                  <div>
                    <p class="text-xs text-muted">
                      实际应打
                    </p><p class="mt-1 font-semibold tabular-nums text-primary">
                      ¥{{ detail.payoutAmount }}
                    </p>
                  </div>
                  <div>
                    <p class="text-xs text-muted">
                      收款方式
                    </p><p class="mt-1 font-medium text-highlighted">
                      {{ methodLabel(detail.payoutMethod) }}
                    </p>
                  </div>
                </div>
                <p class="mt-3 text-sm text-muted">
                  申请于 {{ formatDate(detail.createdAt) }}<span v-if="detail.reviewedAt"> · 审核于 {{ formatDate(detail.reviewedAt) }}</span>
                </p>
                <p
                  v-if="detail.rejectionReason"
                  class="mt-3 rounded-lg bg-error/5 p-3 text-sm text-error"
                >
                  拒绝原因：{{ detail.rejectionReason }}
                </p>
              </UCard>

              <UCard>
                <template #header>
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 class="text-lg font-semibold text-highlighted">
                        私有收款信息
                      </h2>
                      <p class="mt-1 text-sm text-muted">
                        仅在授权后台详情中读取；银行卡号默认脱敏。
                      </p>
                    </div>
                    <UButton
                      color="neutral"
                      variant="outline"
                      class="min-h-11"
                      @click="revealRecipient = !revealRecipient"
                    >
                      {{ revealRecipient ? '隐藏敏感信息' : '查看收款信息' }}
                    </UButton>
                  </div>
                </template>
                <dl
                  v-if="revealRecipient"
                  class="grid gap-3 sm:grid-cols-2"
                >
                  <template v-if="detail.payoutMethod === 'bank_card'">
                    <div>
                      <dt class="text-sm text-muted">
                        收款人
                      </dt><dd class="mt-1 break-words font-medium text-highlighted">
                        {{ detail.recipient.recipientName }}
                      </dd>
                    </div>
                    <div>
                      <dt class="text-sm text-muted">
                        开户银行
                      </dt><dd class="mt-1 break-words font-medium text-highlighted">
                        {{ detail.recipient.bankName }}
                      </dd>
                    </div>
                    <div class="sm:col-span-2">
                      <dt class="text-sm text-muted">
                        银行卡号
                      </dt><dd class="mt-1 break-all font-mono text-sm text-highlighted">
                        {{ detail.recipient.cardNumber }}
                      </dd>
                    </div>
                  </template>
                  <template v-else>
                    <div>
                      <dt class="text-sm text-muted">
                        收款账号
                      </dt><dd class="mt-1 break-all font-medium text-highlighted">
                        {{ detail.recipient.account ?? '未填写' }}
                      </dd>
                    </div>
                    <div>
                      <dt class="text-sm text-muted">
                        收款人姓名
                      </dt><dd class="mt-1 break-words font-medium text-highlighted">
                        {{ detail.recipient.accountName ?? '未填写' }}
                      </dd>
                    </div>
                  </template>
                </dl>
                <figure
                  v-if="revealRecipient && detail.recipient.qrFileId"
                  class="mt-4 grid justify-items-start gap-2"
                >
                  <img
                    :src="`/api/v1/admin/withdrawals/${detail.id}/recipient-qr`"
                    alt="顾客提交的私有收款二维码"
                    width="256"
                    height="256"
                    class="size-64 max-w-full rounded-xl border border-default bg-white object-contain p-2"
                  >
                  <figcaption class="text-xs text-muted">
                    请核对二维码收款信息。二维码图片不代表已验证真实收款身份。
                  </figcaption>
                </figure>
                <p
                  v-if="!revealRecipient"
                  class="text-sm text-muted"
                >
                  收款信息已隐藏。查看前请确认当前处理的是正确顾客和提现申请。
                </p>
              </UCard>

              <UCard>
                <template #header>
                  <div>
                    <h2 class="text-lg font-semibold text-highlighted">
                      钱包冻结记录
                    </h2>
                    <p class="mt-1 text-sm text-muted">
                      余额由现有不可变钱包账本计算，不使用独立提现余额。
                    </p>
                  </div>
                </template>
                <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <dt class="text-xs text-muted">
                      可用现金
                    </dt><dd class="mt-1 font-medium tabular-nums text-highlighted">
                      ¥{{ detail.wallet.cashAvailable }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-xs text-muted">
                      冻结现金
                    </dt><dd class="mt-1 font-medium tabular-nums text-highlighted">
                      ¥{{ detail.wallet.cashFrozen }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-xs text-muted">
                      可用赠送
                    </dt><dd class="mt-1 font-medium tabular-nums text-highlighted">
                      ¥{{ detail.wallet.giftAvailable }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-xs text-muted">
                      冻结赠送
                    </dt><dd class="mt-1 font-medium tabular-nums text-highlighted">
                      ¥{{ detail.wallet.giftFrozen }}
                    </dd>
                  </div>
                </dl>
                <div
                  v-if="detail.ledgerEntries.length"
                  class="mt-4 overflow-x-auto rounded-lg border border-default"
                >
                  <table class="w-full min-w-[34rem] text-left text-sm">
                    <thead class="bg-muted text-xs text-muted">
                      <tr>
                        <th class="px-3 py-2">
                          流水动作
                        </th><th class="px-3 py-2">
                          金额
                        </th><th class="px-3 py-2">
                          Operation ID
                        </th><th class="px-3 py-2">
                          时间
                        </th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-default">
                      <tr
                        v-for="entry in detail.ledgerEntries"
                        :key="entry.id"
                      >
                        <td class="px-3 py-2 text-highlighted">
                          {{ entry.action === 'freeze' ? '冻结现金' : entry.action === 'unfreeze' ? '解冻现金' : '扣除冻结现金' }}
                        </td>
                        <td class="px-3 py-2 font-medium tabular-nums text-highlighted">
                          ¥{{ entry.amount }}
                        </td>
                        <td class="px-3 py-2 font-mono text-xs text-muted">
                          {{ entry.operationId }}
                        </td>
                        <td class="px-3 py-2 whitespace-nowrap text-muted">
                          {{ formatDate(entry.createdAt) }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p
                  v-else
                  class="mt-4 text-sm text-muted"
                >
                  没有找到与本提现关联的钱包流水。
                </p>
              </UCard>

              <UCard>
                <template #header>
                  <h2 class="text-lg font-semibold text-highlighted">
                    顾客历史提现
                  </h2>
                </template>
                <div
                  v-if="detail.customerHistory.length"
                  class="grid gap-2"
                >
                  <div
                    v-for="history in detail.customerHistory"
                    :key="history.id"
                    class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-default px-3 py-2 text-sm"
                  >
                    <NuxtLink
                      :to="`/admin/withdrawals/${history.id}`"
                      class="break-all font-mono text-xs text-primary hover:underline"
                    >
                      {{ history.id }}
                    </NuxtLink>
                    <span class="text-muted">{{ statusLabel(history.status) }} · {{ formatDate(history.createdAt) }}</span>
                    <span class="font-medium tabular-nums text-highlighted">¥{{ history.amount }} → ¥{{ history.payoutAmount }}</span>
                  </div>
                </div>
                <p
                  v-else
                  class="text-sm text-muted"
                >
                  没有历史提现记录。
                </p>
              </UCard>
            </div>

            <div class="grid min-w-0 content-start gap-6">
              <UCard v-if="detail.status === 'pending_review'">
                <template #header>
                  <div>
                    <h2 class="text-lg font-semibold text-highlighted">
                      审核申请
                    </h2>
                    <p class="mt-1 text-sm leading-5 text-muted">
                      通过后保持冻结并进入待打款。拒绝会由数据库原有提现触发器解冻全额。
                    </p>
                  </div>
                </template>
                <div class="grid gap-4">
                  <UButton
                    color="primary"
                    icon="i-lucide-check"
                    class="min-h-11 w-full"
                    :loading="busy === 'approve'"
                    :disabled="Boolean(busy)"
                    @click="approve"
                  >
                    审核通过
                  </UButton>
                  <UFormField
                    label="拒绝原因（必填）"
                    name="rejectionReason"
                  >
                    <UTextarea
                      v-model="rejectionReason"
                      :rows="3"
                      maxlength="500"
                      class="w-full"
                      :disabled="Boolean(busy)"
                    />
                  </UFormField>
                  <UButton
                    color="error"
                    variant="outline"
                    icon="i-lucide-x"
                    class="min-h-11 w-full"
                    :loading="busy === 'reject'"
                    :disabled="Boolean(busy) || !rejectionReason.trim()"
                    @click="reject"
                  >
                    拒绝并解冻
                  </UButton>
                </div>
              </UCard>

              <UCard v-if="detail.status === 'pending_transfer'">
                <template #header>
                  <h2 class="text-lg font-semibold text-highlighted">
                    第一步：记录开始打款
                  </h2>
                </template>
                <p class="text-sm leading-6 text-muted">
                  创建操作 ID 并提交后，状态会变为“打款处理中”。只有收到服务端成功响应后，才前往支付宝、微信或银行人工转账。此步骤不会解冻或扣除资金。
                </p>
                <UButton
                  class="mt-4 min-h-11 w-full"
                  color="primary"
                  icon="i-lucide-play"
                  :loading="busy === 'payout-start'"
                  :disabled="Boolean(busy)"
                  @click="startPayout"
                >
                  记录开始人工打款
                </UButton>
              </UCard>

              <UCard v-if="activeAttempt">
                <template #header>
                  <div>
                    <h2 class="text-lg font-semibold text-highlighted">
                      第二步：记录打款结果
                    </h2>
                    <p class="mt-1 break-all font-mono text-xs text-muted">
                      操作 ID：{{ activeAttempt.operationId }}
                    </p>
                  </div>
                </template>
                <UAlert
                  v-if="activeAttempt.status === 'unknown'"
                  class="mb-4"
                  color="warning"
                  variant="soft"
                  title="这笔操作结果未知"
                  description="不得创建第二笔打款操作。请先核对原转账是否发生。"
                  role="status"
                />
                <div class="grid gap-4">
                  <UFormField
                    label="真实转账参考号（成功时必填）"
                    name="providerReference"
                  >
                    <UInput
                      v-model="providerReference"
                      autocomplete="off"
                      class="w-full"
                      :disabled="Boolean(busy)"
                    />
                  </UFormField>
                  <div class="grid gap-3 sm:grid-cols-2">
                    <UFormField
                      label="实际打款金额"
                      name="actualPayoutAmount"
                      :description="`必须等于申请净额 ¥${detail.payoutAmount}`"
                    >
                      <UInput
                        :model-value="detail.payoutAmount"
                        readonly
                        class="w-full"
                      />
                    </UFormField>
                    <UFormField
                      label="实际打款时间"
                      name="actualPayoutAt"
                    >
                      <UInput
                        v-model="actualPayoutAt"
                        type="datetime-local"
                        class="w-full"
                        :disabled="Boolean(busy)"
                      />
                    </UFormField>
                  </div>
                  <UFormField
                    label="转账凭证 SHA-256"
                    name="evidenceSha256"
                    description="填写真实凭证文件的 SHA-256 摘要；不要把账号密码或完整卡号写入摘要。"
                  >
                    <UInput
                      v-model="evidenceSha256"
                      inputmode="text"
                      autocomplete="off"
                      class="w-full font-mono"
                      :disabled="Boolean(busy)"
                    />
                  </UFormField>
                  <UFormField
                    label="核对摘要"
                    name="evidenceSummary"
                    description="例如凭证存放位置、核对人及关键核对结论。"
                  >
                    <UTextarea
                      v-model="evidenceSummary"
                      :rows="3"
                      maxlength="500"
                      class="w-full"
                      :disabled="Boolean(busy)"
                    />
                  </UFormField>
                  <UButton
                    color="success"
                    icon="i-lucide-circle-check"
                    class="min-h-11 w-full"
                    :loading="busy.startsWith('payout-succeeded:')"
                    :disabled="Boolean(busy) || !providerReference.trim() || !evidenceValid() || !actualPayoutAt"
                    @click="resolve('succeeded')"
                  >
                    确认实际打款成功并扣除冻结金额
                  </UButton>
                  <label class="flex min-h-11 items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
                    <input
                      v-model="noTransferConfirmed"
                      type="checkbox"
                      class="mt-1 size-4 shrink-0 accent-primary"
                      :disabled="Boolean(busy)"
                    >
                    <span class="text-sm leading-5 text-muted">我已核对原操作，确认没有发生任何实际转账。只有勾选后才能登记失败。</span>
                  </label>
                  <UButton
                    color="warning"
                    variant="outline"
                    icon="i-lucide-rotate-ccw"
                    class="min-h-11 w-full"
                    :loading="busy.startsWith('payout-failed:')"
                    :disabled="Boolean(busy) || !noTransferConfirmed || !evidenceValid()"
                    @click="resolve('failed')"
                  >
                    确认未转账 · 保持冻结并允许重试
                  </UButton>
                  <UButton
                    v-if="activeAttempt.status === 'started'"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-circle-help"
                    class="min-h-11 w-full"
                    :loading="busy.startsWith('payout-unknown:')"
                    :disabled="Boolean(busy) || !evidenceValid()"
                    @click="resolve('unknown')"
                  >
                    标记结果未知并继续冻结
                  </UButton>
                </div>
              </UCard>

              <UCard>
                <template #header>
                  <h2 class="text-lg font-semibold text-highlighted">
                    打款尝试历史
                  </h2>
                </template>
                <div
                  v-if="detail.payoutAttempts.length"
                  class="grid gap-3"
                >
                  <article
                    v-for="attempt in detail.payoutAttempts"
                    :key="attempt.id"
                    class="rounded-lg border border-default p-3"
                  >
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <UBadge
                        :color="attempt.status === 'succeeded' ? 'success' : attempt.status === 'unknown' ? 'warning' : attempt.status === 'failed' ? 'neutral' : 'primary'"
                        variant="soft"
                      >
                        {{ attemptStatusLabel(attempt.status) }}
                      </UBadge>
                      <span class="text-xs text-muted">{{ formatDate(attempt.createdAt) }}</span>
                    </div>
                    <p class="mt-2 break-all font-mono text-xs text-muted">
                      操作 ID：{{ attempt.operationId }}
                    </p>
                    <template v-if="attempt.result">
                      <dl class="mt-3 grid gap-2 text-sm">
                        <div v-if="attempt.result.providerReference">
                          <dt class="text-xs text-muted">
                            真实转账参考号
                          </dt><dd class="mt-0.5 break-all font-mono text-highlighted">
                            {{ attempt.result.providerReference }}
                          </dd>
                        </div>
                        <div v-if="attempt.result.actualPayoutAmount">
                          <dt class="text-xs text-muted">
                            实际打款
                          </dt><dd class="mt-0.5 text-highlighted">
                            ¥{{ attempt.result.actualPayoutAmount }} · {{ attempt.result.actualPayoutAt ? formatDate(attempt.result.actualPayoutAt) : '' }}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-xs text-muted">
                            凭证摘要
                          </dt><dd class="mt-0.5 break-all font-mono text-xs text-muted">
                            {{ attempt.result.evidenceSha256 }}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-xs text-muted">
                            核对记录
                          </dt><dd class="mt-0.5 break-words text-muted">
                            {{ attempt.result.evidenceSummary }}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-xs text-muted">
                            记录管理员
                          </dt><dd class="mt-0.5 break-all text-muted">
                            {{ attempt.result.resolvedByAdminId }}
                          </dd>
                        </div>
                      </dl>
                    </template>
                  </article>
                </div>
                <p
                  v-else
                  class="text-sm text-muted"
                >
                  审核通过并开始打款后，这里会保留每次操作及其最终记录。
                </p>
              </UCard>

              <UCard>
                <template #header>
                  <h2 class="text-lg font-semibold text-highlighted">
                    审核与操作审计
                  </h2>
                </template>
                <ol class="grid gap-3">
                  <li
                    v-for="event in detail.auditEvents"
                    :key="event.id"
                    class="border-l-2 border-primary/30 pl-3"
                  >
                    <p class="break-words text-sm font-medium text-highlighted">
                      {{ event.action }} <span class="font-normal text-muted">· {{ event.actorType === 'admin' ? '管理员' : event.actorType === 'customer' ? '顾客' : '系统' }}</span>
                    </p>
                    <p
                      v-if="event.previousStatus || event.nextStatus"
                      class="mt-1 text-xs text-muted"
                    >
                      {{ event.previousStatus ?? '开始' }} → {{ event.nextStatus ?? '记录' }}
                    </p>
                    <p class="mt-1 text-xs text-muted">
                      {{ formatDate(event.createdAt) }}<span v-if="event.actorId"> · {{ event.actorId }}</span>
                    </p>
                    <pre
                      v-if="Object.keys(event.details).length"
                      class="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-[11px] leading-4 text-muted"
                    >{{ JSON.stringify(event.details, null, 2) }}</pre>
                  </li>
                </ol>
              </UCard>
            </div>
          </div>
        </template>
      </main>
    </template>
  </UDashboardPanel>
</template>
