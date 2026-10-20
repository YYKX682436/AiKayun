<script setup lang="ts">
import type {
  ApiSuccess,
  CustomerWithdrawalPage,
  CustomerTopUpPage,
  CustomerWalletLedgerPage,
  CustomerWalletSummary,
  ExternalPaymentMethod,
  WithdrawalPayoutMethod,
  WithdrawalQrUpload,
} from '@aikayun/contracts'
import { calculateWithdrawalFee } from '@aikayun/money'
import { CustomerApiError, useCustomerApi } from '~/composables/useCustomerApi'

definePageMeta({ middleware: 'customer-auth' })
useSeoMeta({ title: '我的钱包', description: '查看钱包余额、充值进度和不可变收支明细。', robots: 'noindex, nofollow' })
if (import.meta.server) useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

type PublicPaymentChannel = { id: string; name: string; paymentMethods: ExternalPaymentMethod[] }
type PublicPaymentChannelList = { items: PublicPaymentChannel[] }

const customerApi = useCustomerApi()
const customerId = computed(() => customerApi.session.value?.customer.id ?? 'unknown')
const identity = computed(() => `${customerId.value}-${customerApi.identityVersion.value}`)
const ledgerPage = ref(1)
const topUpPage = ref(1)
const withdrawalPageNumber = ref(1)
const amountInput = ref('')
const withdrawalAmountInput = ref('')
const withdrawalMethod = ref<WithdrawalPayoutMethod>('alipay')
const withdrawalAccount = ref('')
const withdrawalAccountName = ref('')
const withdrawalRecipientName = ref('')
const withdrawalBankName = ref('')
const withdrawalCardNumber = ref('')
const withdrawalQrFileId = ref('')
const withdrawalQrBusy = ref(false)
const withdrawalBusy = ref(false)
const withdrawalCancelBusyId = ref('')
const withdrawalError = ref('')
const withdrawalMessage = ref('')
const withdrawalConfirmed = ref(false)
const selectedChannelId = ref('')
const selectedPaymentMethod = ref<ExternalPaymentMethod>('alipay')
const topUpBusy = ref(false)
const refreshingAttemptId = ref('')
const errorMessage = ref('')
const successMessage = ref('')
const qrDataUrl = ref('')
const qrError = ref('')
const clientMounted = ref(false)
let qrSequence = 0

onMounted(() => {
  clientMounted.value = true
})

const { data: walletResponse, error: walletError, pending: walletPending, refresh: refreshWallet } = await useFetch<ApiSuccess<CustomerWalletSummary>>(
  '/api/v1/customer/wallet',
  { key: computed(() => `customer-wallet-${identity.value}`) },
)
const { data: ledgerResponse, error: ledgerError, pending: ledgerPending, refresh: refreshLedger } = await useFetch<ApiSuccess<CustomerWalletLedgerPage>>(
  '/api/v1/customer/wallet/ledger',
  { key: computed(() => `customer-wallet-ledger-${identity.value}-${ledgerPage.value}`), query: { page: ledgerPage, pageSize: 10 } },
)
const { data: topUpsResponse, error: topUpsError, pending: topUpsPending, refresh: refreshTopUps } = await useFetch<ApiSuccess<CustomerTopUpPage>>(
  '/api/v1/customer/wallet/top-ups',
  { key: computed(() => `customer-wallet-topups-${identity.value}-${topUpPage.value}`), query: { page: topUpPage, pageSize: 10 } },
)
const { data: withdrawalsResponse, error: withdrawalsError, pending: withdrawalsPending, refresh: refreshWithdrawals } = await useFetch<ApiSuccess<CustomerWithdrawalPage>>(
  '/api/v1/customer/wallet/withdrawals',
  { key: computed(() => `customer-wallet-withdrawals-${identity.value}-${withdrawalPageNumber.value}`), query: { page: withdrawalPageNumber, pageSize: 10 } },
)
const { data: channelsResponse } = await useFetch<ApiSuccess<PublicPaymentChannelList>>(
  '/api/v1/public/payment-channels',
  { key: 'wallet-public-payment-channels' },
)

const wallet = computed(() => walletResponse.value?.data ?? null)
const ledger = computed(() => ledgerResponse.value?.data ?? null)
const topUps = computed(() => topUpsResponse.value?.data ?? null)
const withdrawals = computed(() => withdrawalsResponse.value?.data ?? null)
const withdrawalPolicy = computed(() => withdrawals.value?.policy ?? null)
const channels = computed(() => channelsResponse.value?.data.items ?? [])
const selectedChannel = computed(() => channels.value.find(channel => channel.id === selectedChannelId.value) ?? null)
const loading = computed(() => walletPending.value || ledgerPending.value || topUpsPending.value || withdrawalsPending.value)
const hasPageError = computed(() => walletError.value || ledgerError.value || topUpsError.value || withdrawalsError.value)
const latestActiveTopUp = computed(() => topUps.value?.items.find(item => ['created', 'pending', 'reconciliation_required'].includes(item.status)) ?? null)
const activeQrAction = computed(() => latestActiveTopUp.value?.action?.type === 'qr_code' ? latestActiveTopUp.value.action.value : '')
const availableWithdrawalMethods = computed(() => withdrawalPolicy.value?.methods ?? [])
const withdrawalAmountValid = computed(() => {
  const value = withdrawalAmountInput.value.trim()
  if (!/^\d{1,16}(?:\.\d{1,2})?$/u.test(value) || !withdrawalPolicy.value || !wallet.value) return false
  const amount = toCents(value)
  return amount > 0n && amount >= toCents(withdrawalPolicy.value.minAmount)
    && amount <= toCents(withdrawalPolicy.value.maxAmount) && amount <= toCents(wallet.value.cashAvailable)
})
const withdrawalEstimate = computed(() => {
  const value = withdrawalAmountInput.value.trim()
  if (!withdrawalAmountValid.value || !withdrawalPolicy.value) return null
  try {
    const amount = value.includes('.') ? value.padEnd(value.indexOf('.') + 3, '0') : `${value}.00`
    return calculateWithdrawalFee(amount, withdrawalPolicy.value.percentFee, withdrawalPolicy.value.fixedFee)
  } catch {
    return null
  }
})
const recipientValid = computed(() => withdrawalMethod.value === 'bank_card'
  ? /^\d{12,19}$/u.test(withdrawalCardNumber.value)
    && Boolean(withdrawalRecipientName.value.trim()) && Boolean(withdrawalBankName.value.trim())
  : Boolean(withdrawalAccount.value.trim() || withdrawalQrFileId.value))
const canCreateWithdrawal = computed(() => Boolean(withdrawalPolicy.value?.enabled
  && availableWithdrawalMethods.value.includes(withdrawalMethod.value)
  && withdrawalAmountValid.value && withdrawalEstimate.value && recipientValid.value
  && withdrawalConfirmed.value && !withdrawalBusy.value && !withdrawalQrBusy.value))

function toCents(value: string): bigint {
  const normalized = value.includes('.') ? value.padEnd(value.indexOf('.') + 3, '0') : `${value}.00`
  const [whole, fraction = '00'] = normalized.split('.')
  if (!/^\d+$/u.test(whole!) || !/^\d{2}$/u.test(fraction)) return 0n
  return BigInt(whole!) * 100n + BigInt(fraction)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function topUpStatusLabel(value: CustomerTopUpPage['items'][number]): string {
  if (value.reconciliationOpen || value.status === 'reconciliation_required') return '异常核对中'
  if (value.status === 'succeeded') return '已到账'
  if (value.status === 'late_succeeded') return '迟到收款待核对'
  if (value.status === 'failed') return '支付失败'
  if (value.status === 'expired') return '已过期'
  if (value.status === 'cancelled') return '已取消'
  return value.providerState === 'unknown' || value.providerState === 'requesting' ? '结果确认中' : '待支付'
}

function reconciliationReasonLabel(value: CustomerTopUpPage['items'][number]['reconciliationReasons'][number]): string {
  const labels = {
    callback_query_mismatch: '回调与查单不一致', provider_identity_conflict: '服务商身份不一致',
    provider_transaction_conflict: '服务商交易号重复', provider_amount_mismatch: '实收金额不符',
    receipt_conflict: '收款凭证冲突', late_confirmed_payment: '迟到收款',
  }
  return labels[value]
}

function ledgerLabel(item: CustomerWalletLedgerPage['items'][number]): string {
  const bucket = item.bucket === 'gift' ? '赠送余额' : '现金余额'
  const actionNames: Record<typeof item.action, string> = {
    credit_available: '入账', debit_available: '扣款', freeze: '冻结', unfreeze: '解冻', debit_frozen: '冻结扣款',
  }
  return `${bucket}${actionNames[item.action]}`
}

function topUpStorageKey(): string {
  return `aikayun-wallet-topup-v1:${identity.value}:${amountInput.value.trim()}:${selectedChannelId.value}:${selectedPaymentMethod.value}`
}

function getTopUpIdempotencyKey(): string {
  if (!import.meta.client) throw new Error('请在浏览器中发起充值。')
  const key = topUpStorageKey()
  try {
    const existing = sessionStorage.getItem(key)
    if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing
    const next = crypto.randomUUID()
    sessionStorage.setItem(key, next)
    return next
  } catch {
    throw new Error('浏览器无法安全保存充值重试标识，请启用会话存储后重试。')
  }
}

const topUpAmountValid = computed(() => {
  const value = amountInput.value.trim()
  if (!/^\d{1,16}(?:\.\d{1,2})?$/u.test(value) || !wallet.value) return false
  const cents = toCents(value)
  return cents >= toCents(wallet.value.topUpMinAmount) && cents <= toCents(wallet.value.topUpMaxAmount)
})
const canCreateTopUp = computed(() => Boolean(wallet.value?.topUpEnabled && topUpAmountValid.value
  && selectedChannel.value?.paymentMethods.includes(selectedPaymentMethod.value)
  && !topUpBusy.value && !latestActiveTopUp.value))

async function createTopUp() {
  if (!canCreateTopUp.value || !selectedChannelId.value) return
  topUpBusy.value = true
  errorMessage.value = ''
  successMessage.value = ''
  const identityAtStart = identity.value
  try {
    const amount = amountInput.value.includes('.')
      ? amountInput.value.padEnd(amountInput.value.indexOf('.') + 3, '0')
      : `${amountInput.value}.00`
    await customerApi.request<CustomerTopUpPage>('/api/v1/customer/wallet/top-ups', {
      method: 'POST',
      body: {
        idempotencyKey: getTopUpIdempotencyKey(),
        amount,
        channelId: selectedChannelId.value,
        paymentMethod: selectedPaymentMethod.value,
      },
    })
    if (identityAtStart !== identity.value) return
    successMessage.value = '充值请求已记录。余额只会在服务端确认到账后增加。'
    await Promise.all([refreshWallet(), refreshTopUps(), refreshLedger()])
  } catch (error) {
    if (identityAtStart !== identity.value) return
    errorMessage.value = error instanceof Error ? error.message : '充值状态尚未确认，请查看充值记录后恢复。'
  } finally {
    topUpBusy.value = false
  }
}

async function refreshTopUp(id: string) {
  if (refreshingAttemptId.value) return
  refreshingAttemptId.value = id
  errorMessage.value = ''
  successMessage.value = ''
  const identityAtStart = identity.value
  try {
    await customerApi.request<CustomerTopUpPage>(`/api/v1/customer/wallet/top-ups/${id}/refresh`, { method: 'POST' })
    if (identityAtStart !== identity.value) return
    await Promise.all([refreshWallet(), refreshTopUps(), refreshLedger()])
  } catch (error) {
    if (identityAtStart !== identity.value) return
    errorMessage.value = error instanceof CustomerApiError || error instanceof Error
      ? error.message : '充值状态暂时无法确认，请稍后重试。'
  } finally {
    refreshingAttemptId.value = ''
  }
}

function withdrawalStatusLabel(status: CustomerWithdrawalPage['items'][number]['status']): string {
  const labels: Record<CustomerWithdrawalPage['items'][number]['status'], string> = {
    pending_review: '待审核', pending_transfer: '待打款', transfer_processing: '打款处理中',
    transfer_uncertain: '结果未知 · 资金继续冻结', completed: '已完成', rejected: '已拒绝', cancelled: '已取消',
  }
  return labels[status]
}

function withdrawalMethodLabel(method: WithdrawalPayoutMethod): string {
  return method === 'alipay' ? '支付宝' : method === 'wechat' ? '微信' : '银行卡'
}

async function withdrawalBodyFingerprint(): Promise<string> {
  const amount = withdrawalAmountInput.value.includes('.')
    ? withdrawalAmountInput.value.trim().padEnd(withdrawalAmountInput.value.trim().indexOf('.') + 3, '0')
    : `${withdrawalAmountInput.value.trim()}.00`
  const recipient = withdrawalMethod.value === 'bank_card'
    ? { recipientName: withdrawalRecipientName.value.trim(), bankName: withdrawalBankName.value.trim(), cardNumber: withdrawalCardNumber.value.trim() }
    : { account: withdrawalAccount.value.trim(), accountName: withdrawalAccountName.value.trim(), qrFileId: withdrawalQrFileId.value || null }
  const bytes = new TextEncoder().encode(JSON.stringify({ amount, payoutMethod: withdrawalMethod.value, recipient }))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function withdrawalIdempotencyStorageKey(customerIdentity: string, fingerprint: string): string {
  return `aikayun-wallet-withdrawal-v1:${customerIdentity}:${fingerprint}`
}

async function getWithdrawalIdempotencyKey(fingerprint: string): Promise<string> {
  if (!import.meta.client) throw new Error('请在浏览器中提交提现申请。')
  const keyName = withdrawalIdempotencyStorageKey(identity.value, fingerprint)
  try {
    const saved = sessionStorage.getItem(keyName)
    if (saved && /^[0-9a-f-]{36}$/iu.test(saved)) return saved
    const key = crypto.randomUUID()
    sessionStorage.setItem(keyName, key)
    return key
  } catch {
    throw new Error('浏览器无法安全保存提现重试标识，请启用会话存储后重试。')
  }
}

function withdrawalActionKey(id: string, action: string): string {
  const keyName = `aikayun-wallet-withdrawal-action-v1:${identity.value}:${id}:${action}`
  try {
    const saved = sessionStorage.getItem(keyName)
    if (saved && /^[0-9a-f-]{36}$/iu.test(saved)) return saved
    const key = crypto.randomUUID()
    sessionStorage.setItem(keyName, key)
    return key
  } catch {
    return crypto.randomUUID()
  }
}

async function uploadWithdrawalQr(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  withdrawalError.value = ''
  withdrawalMessage.value = ''
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    withdrawalError.value = '收款二维码只支持不超过 5MB 的 JPEG、PNG 或 WebP 图片。'
    input.value = ''
    return
  }
  withdrawalQrBusy.value = true
  try {
    const form = new FormData()
    form.append('file', file, file.name)
    const uploaded = await customerApi.request<WithdrawalQrUpload>('/api/v1/customer/wallet/withdrawal-qr', {
      method: 'POST', body: form,
    })
    withdrawalQrFileId.value = uploaded.id
    withdrawalMessage.value = '收款二维码已安全保存，仅你和授权管理员可读取。'
  } catch (error) {
    withdrawalError.value = error instanceof Error ? error.message : '二维码上传失败，请稍后重试。'
    input.value = ''
  } finally {
    withdrawalQrBusy.value = false
  }
}

async function createWithdrawal() {
  if (!canCreateWithdrawal.value) return
  withdrawalBusy.value = true
  withdrawalError.value = ''
  withdrawalMessage.value = ''
  const identityAtStart = identity.value
  try {
    const fingerprint = await withdrawalBodyFingerprint()
    const amount = withdrawalAmountInput.value.trim().includes('.')
      ? withdrawalAmountInput.value.trim().padEnd(withdrawalAmountInput.value.trim().indexOf('.') + 3, '0')
      : `${withdrawalAmountInput.value.trim()}.00`
    const recipient = withdrawalMethod.value === 'bank_card'
      ? { recipientName: withdrawalRecipientName.value.trim(), bankName: withdrawalBankName.value.trim(), cardNumber: withdrawalCardNumber.value.trim() }
      : {
          account: withdrawalAccount.value.trim() || undefined,
          accountName: withdrawalAccountName.value.trim() || undefined,
          qrFileId: withdrawalQrFileId.value || undefined,
        }
    const result = await customerApi.request<{ repeated: boolean; withdrawal: CustomerWithdrawalPage['items'][number] }>(
      '/api/v1/customer/wallet/withdrawals',
      { method: 'POST', body: { idempotencyKey: await getWithdrawalIdempotencyKey(fingerprint), amount, payoutMethod: withdrawalMethod.value, recipient } },
    )
    try { sessionStorage.removeItem(withdrawalIdempotencyStorageKey(identityAtStart, fingerprint)) } catch { /* The server remains authoritative if session storage is unavailable after success. */ }
    if (identityAtStart !== identity.value) return
    withdrawalMessage.value = result.repeated ? '已恢复这笔提现申请，未重复冻结余额。' : '提现申请已提交，完整金额已由服务端冻结。'
    withdrawalAmountInput.value = ''
    withdrawalAccount.value = ''
    withdrawalAccountName.value = ''
    withdrawalRecipientName.value = ''
    withdrawalBankName.value = ''
    withdrawalCardNumber.value = ''
    withdrawalQrFileId.value = ''
    withdrawalConfirmed.value = false
    await Promise.all([refreshWithdrawals(), refreshWallet(), refreshLedger()])
  } catch (error) {
    if (identityAtStart !== identity.value) return
    withdrawalError.value = error instanceof Error ? error.message : '申请结果尚未确认，请刷新提现记录后恢复。'
  } finally {
    withdrawalBusy.value = false
  }
}

async function cancelWithdrawal(id: string) {
  if (withdrawalCancelBusyId.value) return
  withdrawalCancelBusyId.value = id
  withdrawalError.value = ''
  withdrawalMessage.value = ''
  try {
    const result = await customerApi.request<{ repeated: boolean }>(`/api/v1/customer/wallet/withdrawals/${id}/cancel`, {
      method: 'POST', body: { idempotencyKey: withdrawalActionKey(id, 'cancel') },
    })
    withdrawalMessage.value = result.repeated ? '已恢复取消结果。' : '提现申请已取消，冻结现金已解冻。'
    await Promise.all([refreshWithdrawals(), refreshWallet(), refreshLedger()])
  } catch (error) {
    withdrawalError.value = error instanceof Error ? error.message : '取消结果尚未确认，请刷新提现记录。'
  } finally {
    withdrawalCancelBusyId.value = ''
  }
}

watch(channels, (items) => {
  if (!items.some(channel => channel.id === selectedChannelId.value)) selectedChannelId.value = items[0]?.id ?? ''
  const methods = selectedChannel.value?.paymentMethods ?? []
  if (!methods.includes(selectedPaymentMethod.value) && methods[0]) selectedPaymentMethod.value = methods[0]
}, { immediate: true })

watch(availableWithdrawalMethods, (items) => {
  if (!items.includes(withdrawalMethod.value) && items[0]) withdrawalMethod.value = items[0]
}, { immediate: true })

watch(activeQrAction, async (value) => {
  const sequence = ++qrSequence
  if (!value) {
    qrDataUrl.value = ''
    qrError.value = ''
    return
  }
  if (!import.meta.client) return
  qrError.value = ''
  try {
    const QRCode = await import('qrcode')
    const dataUrl = await QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 2, width: 256 })
    if (sequence === qrSequence && value === activeQrAction.value) qrDataUrl.value = dataUrl
  } catch {
    if (sequence === qrSequence) qrError.value = '二维码暂时无法生成，请刷新充值记录后重试。'
  }
}, { immediate: true })
</script>

<template>
  <UContainer class="py-7 sm:py-10">
    <main
      id="main-content"
      class="mx-auto w-full max-w-6xl"
      :data-wallet-ready="clientMounted ? 'true' : undefined"
    >
      <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="text-sm font-medium text-primary">
            顾客账户
          </p>
          <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
            我的钱包
          </h1>
          <p class="mt-2 text-sm leading-6 text-muted">
            现金与赠送余额分账显示；每次变动都保留不可变流水。
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton
            to="/orders"
            color="neutral"
            variant="outline"
            icon="i-lucide-receipt-text"
            class="min-h-11"
          >
            我的订单
          </UButton>
          <UButton
            to="/account"
            color="neutral"
            variant="outline"
            icon="i-lucide-user-round"
            class="min-h-11"
          >
            个人账户
          </UButton>
        </div>
      </header>

      <UAlert
        v-if="hasPageError"
        class="mt-5"
        color="error"
        variant="soft"
        title="钱包数据暂时无法读取，请刷新页面重试。"
        role="alert"
      />
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
        v-if="loading && !wallet"
        class="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        aria-busy="true"
        aria-label="正在读取钱包"
      >
        <div
          v-for="item in 5"
          :key="item"
          class="h-28 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
        />
      </div>

      <template v-if="wallet">
        <section
          class="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
          aria-label="钱包余额"
        >
          <UCard>
            <p class="text-sm text-muted">
              可用现金
            </p>
            <p class="mt-2 text-2xl font-semibold tabular-nums text-highlighted">
              ¥{{ wallet.cashAvailable }}
            </p>
          </UCard>
          <UCard>
            <p class="text-sm text-muted">
              冻结现金
            </p>
            <p class="mt-2 text-2xl font-semibold tabular-nums text-highlighted">
              ¥{{ wallet.cashFrozen }}
            </p>
          </UCard>
          <UCard>
            <p class="text-sm text-muted">
              可用赠送余额
            </p>
            <p class="mt-2 text-2xl font-semibold tabular-nums text-highlighted">
              ¥{{ wallet.giftAvailable }}
            </p>
          </UCard>
          <UCard>
            <p class="text-sm text-muted">
              冻结赠送余额
            </p>
            <p class="mt-2 text-2xl font-semibold tabular-nums text-highlighted">
              ¥{{ wallet.giftFrozen }}
            </p>
          </UCard>
          <UCard class="border-primary/30 bg-primary/5">
            <p class="text-sm text-muted">
              总可用余额
            </p>
            <p class="mt-2 text-2xl font-semibold tabular-nums text-highlighted">
              ¥{{ wallet.totalAvailable }}
            </p>
          </UCard>
        </section>

        <section
          class="mt-6 grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"
          aria-labelledby="withdrawals-title"
        >
          <UCard>
            <template #header>
              <div>
                <h2
                  id="withdrawals-title"
                  class="text-lg font-semibold text-highlighted"
                >
                  申请提现
                </h2>
                <p class="mt-1 text-sm leading-6 text-muted">
                  仅可使用现金余额。提交后会冻结提现全额，手续费和预计到账金额以服务端复核为准。
                </p>
              </div>
            </template>

            <UAlert
              v-if="!withdrawalPolicy?.enabled"
              color="neutral"
              variant="soft"
              icon="i-lucide-lock-keyhole"
              title="商家暂未开放提现。"
              description="已提交的历史申请仍可在右侧查看进度。"
            />
            <form
              v-else
              class="grid gap-4"
              :aria-busy="withdrawalBusy || withdrawalQrBusy"
              @submit.prevent="createWithdrawal"
            >
              <div class="grid gap-3 sm:grid-cols-2">
                <UFormField
                  label="提现金额"
                  name="withdrawalAmount"
                  :description="`单次 ¥${withdrawalPolicy.minAmount} 至 ¥${withdrawalPolicy.maxAmount}；可提现现金 ¥${wallet.cashAvailable}。`"
                >
                  <UInput
                    v-model="withdrawalAmountInput"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="例如 100.00"
                    class="w-full"
                    :aria-invalid="withdrawalAmountInput.length > 0 && !withdrawalAmountValid"
                  />
                </UFormField>
                <UFormField
                  label="收款方式"
                  name="withdrawalMethod"
                >
                  <USelect
                    v-model="withdrawalMethod"
                    :items="availableWithdrawalMethods.map(method => ({ label: withdrawalMethodLabel(method), value: method }))"
                    class="w-full"
                  />
                </UFormField>
              </div>

              <fieldset
                v-if="withdrawalMethod === 'bank_card'"
                class="grid gap-3 rounded-xl border border-default p-3 sm:grid-cols-2"
              >
                <legend class="px-1 text-sm font-medium text-highlighted">
                  银行卡收款信息
                </legend>
                <UFormField
                  label="收款人姓名"
                  name="withdrawalRecipientName"
                >
                  <UInput
                    v-model="withdrawalRecipientName"
                    autocomplete="name"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  label="开户银行"
                  name="withdrawalBankName"
                >
                  <UInput
                    v-model="withdrawalBankName"
                    autocomplete="organization"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  label="银行卡号"
                  name="withdrawalCardNumber"
                  class="sm:col-span-2"
                >
                  <UInput
                    v-model="withdrawalCardNumber"
                    type="text"
                    inputmode="numeric"
                    autocomplete="off"
                    class="w-full"
                    aria-describedby="withdrawal-card-privacy"
                  />
                  <template #hint>
                    <span id="withdrawal-card-privacy">仅你和授权管理员可查看，后台默认脱敏展示。</span>
                  </template>
                </UFormField>
              </fieldset>

              <fieldset
                v-else
                class="grid gap-3 rounded-xl border border-default p-3 sm:grid-cols-2"
              >
                <legend class="px-1 text-sm font-medium text-highlighted">
                  {{ withdrawalMethodLabel(withdrawalMethod) }}收款信息
                </legend>
                <UFormField
                  label="收款账号（可选）"
                  name="withdrawalAccount"
                >
                  <UInput
                    v-model="withdrawalAccount"
                    autocomplete="off"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  label="收款人姓名（可选）"
                  name="withdrawalAccountName"
                >
                  <UInput
                    v-model="withdrawalAccountName"
                    autocomplete="name"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  label="收款二维码（可选）"
                  name="withdrawalQr"
                  class="sm:col-span-2"
                >
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="上传收款二维码"
                    class="block min-h-11 w-full rounded-lg border border-default bg-default px-3 py-2 text-sm text-default file:mr-3 file:min-h-8 file:rounded-md file:border-0 file:bg-muted file:px-3 file:font-medium file:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    :disabled="withdrawalQrBusy || withdrawalBusy"
                    @change="uploadWithdrawalQr"
                  >
                  <template #hint>
                    <span>JPEG、PNG 或 WebP，最大 5MB。图片保存在私有存储中，不会生成公开地址。</span>
                  </template>
                </UFormField>
                <figure
                  v-if="withdrawalQrFileId"
                  class="flex items-center gap-3 rounded-lg bg-muted p-3 sm:col-span-2"
                >
                  <img
                    :src="`/api/v1/customer/wallet/withdrawal-qr/${withdrawalQrFileId}`"
                    alt="已上传的私有收款二维码"
                    width="96"
                    height="96"
                    class="size-24 rounded-md border border-default bg-white object-contain"
                  >
                  <figcaption class="text-sm text-muted">
                    二维码已安全上传，提交申请后会与收款信息一起固定保存。
                  </figcaption>
                </figure>
              </fieldset>

              <div class="grid gap-2 rounded-xl bg-muted p-4 sm:grid-cols-3">
                <div>
                  <p class="text-xs text-muted">
                    冻结现金金额
                  </p>
                  <p class="mt-1 font-semibold tabular-nums text-highlighted">
                    ¥{{ withdrawalAmountValid ? withdrawalAmountInput : '0.00' }}
                  </p>
                </div>
                <div>
                  <p class="text-xs text-muted">
                    预计手续费
                  </p>
                  <p class="mt-1 font-semibold tabular-nums text-highlighted">
                    ¥{{ withdrawalEstimate?.feeAmount ?? '—' }}
                  </p>
                  <p class="mt-1 text-xs text-muted">
                    {{ withdrawalPolicy.percentFee }}% + ¥{{ withdrawalPolicy.fixedFee }}
                  </p>
                </div>
                <div>
                  <p class="text-xs text-muted">
                    预计到账
                  </p>
                  <p class="mt-1 font-semibold tabular-nums text-primary">
                    ¥{{ withdrawalEstimate?.payoutAmount ?? '—' }}
                  </p>
                </div>
              </div>

              <label class="flex min-h-11 items-start gap-3 rounded-lg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary">
                <input
                  v-model="withdrawalConfirmed"
                  type="checkbox"
                  class="mt-1 size-4 shrink-0 accent-primary"
                >
                <span class="text-sm leading-6 text-muted">我确认收款信息正确，并了解申请提交后将冻结全部提现金额，审核拒绝或允许取消时才会解冻。</span>
              </label>

              <UAlert
                v-if="withdrawalError"
                color="error"
                variant="soft"
                :title="withdrawalError"
                role="alert"
                aria-live="assertive"
              />
              <UAlert
                v-if="withdrawalMessage"
                color="success"
                variant="soft"
                :title="withdrawalMessage"
                role="status"
                aria-live="polite"
              />
              <UButton
                type="submit"
                color="primary"
                icon="i-lucide-banknote-arrow-up"
                class="min-h-11 w-full sm:w-fit"
                :loading="withdrawalBusy || withdrawalQrBusy"
                :disabled="!canCreateWithdrawal"
              >
                提交提现申请
              </UButton>
            </form>
          </UCard>

          <div class="min-w-0">
            <div class="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 class="text-lg font-semibold text-highlighted">
                  提现记录
                </h2>
                <p class="mt-1 text-sm text-muted">
                  申请进度由服务端记录；打款开始后不能直接取消。
                </p>
              </div>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-refresh-cw"
                class="min-h-11"
                :loading="withdrawalsPending"
                @click="refreshWithdrawals()"
              >
                刷新记录
              </UButton>
            </div>
            <div
              v-if="withdrawals?.items.length"
              class="mt-4 grid gap-3"
            >
              <UCard
                v-for="item in withdrawals.items"
                :key="item.id"
                class="min-w-0"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="font-semibold tabular-nums text-highlighted">
                      ¥{{ item.amount }} <span class="text-xs font-normal text-muted">申请金额</span>
                    </p>
                    <p class="mt-1 text-sm text-muted">
                      {{ withdrawalMethodLabel(item.payoutMethod) }} · {{ formatDate(item.createdAt) }}
                    </p>
                  </div>
                  <UBadge
                    :color="item.status === 'completed' ? 'success' : item.status === 'rejected' || item.status === 'cancelled' ? 'neutral' : item.status === 'transfer_uncertain' ? 'warning' : 'primary'"
                    variant="soft"
                  >
                    {{ withdrawalStatusLabel(item.status) }}
                  </UBadge>
                </div>
                <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt class="text-muted">
                      手续费
                    </dt><dd class="mt-0.5 font-medium tabular-nums text-highlighted">
                      ¥{{ item.feeAmount }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">
                      预计到账
                    </dt><dd class="mt-0.5 font-medium tabular-nums text-highlighted">
                      ¥{{ item.payoutAmount }}
                    </dd>
                  </div>
                  <div v-if="item.reviewedAt">
                    <dt class="text-muted">
                      审核时间
                    </dt><dd class="mt-0.5 text-highlighted">
                      {{ formatDate(item.reviewedAt) }}
                    </dd>
                  </div>
                </dl>
                <p
                  v-if="item.rejectionReason"
                  class="mt-3 rounded-lg bg-error/5 px-3 py-2 text-sm text-error"
                >
                  拒绝原因：{{ item.rejectionReason }}
                </p>
                <p
                  v-if="item.status === 'transfer_uncertain'"
                  class="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-sm leading-5 text-warning"
                >
                  打款结果仍在核对，资金继续冻结。请等待商家确认，不要重复提交提现。
                </p>
                <div
                  v-if="item.payoutAttempts.length"
                  class="mt-3 border-t border-default pt-3"
                >
                  <p class="text-xs font-medium text-muted">
                    人工打款记录
                  </p>
                  <ul class="mt-2 grid gap-2">
                    <li
                      v-for="attempt in item.payoutAttempts"
                      :key="attempt.id"
                      class="flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <span class="text-muted">操作 {{ attempt.operationId.slice(0, 8) }} · {{ formatDate(attempt.createdAt) }}</span>
                      <span class="font-medium text-highlighted">{{ attempt.status === 'started' ? '处理中' : attempt.status === 'unknown' ? '结果未知' : attempt.status === 'succeeded' ? '已确认成功' : '确认未转账' }}</span>
                    </li>
                  </ul>
                </div>
                <div
                  v-if="['pending_review', 'pending_transfer'].includes(item.status)"
                  class="mt-3 flex justify-end"
                >
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="sm"
                    class="min-h-11"
                    :loading="withdrawalCancelBusyId === item.id"
                    :disabled="Boolean(withdrawalCancelBusyId)"
                    @click="cancelWithdrawal(item.id)"
                  >
                    取消申请并解冻
                  </UButton>
                </div>
              </UCard>
            </div>
            <UCard
              v-else
              class="mt-4"
            >
              <p class="text-sm text-muted">
                暂无提现记录。申请提交后会显示冻结、审核及打款进度。
              </p>
            </UCard>
            <div
              v-if="withdrawals && withdrawals.totalPages > 1"
              class="mt-4 flex flex-wrap items-center justify-between gap-3"
            >
              <p class="text-sm text-muted">
                第 {{ withdrawals.page }} / {{ withdrawals.totalPages }} 页 · 共 {{ withdrawals.total }} 笔
              </p>
              <div class="flex gap-2">
                <UButton
                  color="neutral"
                  variant="outline"
                  :disabled="withdrawalsPending || withdrawalPageNumber <= 1"
                  @click="withdrawalPageNumber--"
                >
                  上一页
                </UButton>
                <UButton
                  color="neutral"
                  variant="outline"
                  :disabled="withdrawalsPending || withdrawalPageNumber >= withdrawals.totalPages"
                  @click="withdrawalPageNumber++"
                >
                  下一页
                </UButton>
              </div>
            </div>
          </div>
        </section>

        <section class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
          <UCard>
            <template #header>
              <div>
                <h2 class="text-lg font-semibold text-highlighted">
                  在线充值
                </h2>
                <p class="mt-1 text-sm text-muted">
                  充值目标绑定当前登录顾客。只有服务端确认实收后才增加现金余额。
                </p>
              </div>
            </template>
            <UAlert
              v-if="!wallet.topUpEnabled"
              color="neutral"
              variant="soft"
              icon="i-lucide-lock-keyhole"
              title="商家暂未开放在线充值。"
            />
            <form
              v-else
              class="grid gap-5"
              :aria-busy="topUpBusy"
              @submit.prevent="createTopUp"
            >
              <UFormField
                label="充值金额"
                :description="`可充值 ¥${wallet.topUpMinAmount} 至 ¥${wallet.topUpMaxAmount}。`"
              >
                <UInput
                  v-model="amountInput"
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  placeholder="例如 50.00"
                  class="w-full"
                />
              </UFormField>
              <fieldset class="grid gap-2">
                <legend class="text-sm font-medium text-highlighted">
                  支付通道
                </legend>
                <UAlert
                  v-if="channels.length === 0"
                  color="neutral"
                  variant="soft"
                  title="当前没有可用的在线支付通道。"
                />
                <label
                  v-for="channel in channels"
                  :key="channel.id"
                  class="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-default px-3 py-2 hover:bg-muted"
                  :class="selectedChannelId === channel.id ? 'border-primary bg-primary/5' : ''"
                >
                  <input
                    v-model="selectedChannelId"
                    type="radio"
                    name="wallet-topup-channel"
                    :value="channel.id"
                    class="size-4 accent-primary"
                  >
                  <span class="text-sm font-medium text-highlighted">{{ channel.name }}</span>
                </label>
              </fieldset>
              <fieldset
                v-if="selectedChannel"
                class="grid gap-2"
              >
                <legend class="text-sm font-medium text-highlighted">
                  支付方式
                </legend>
                <label
                  v-for="method in selectedChannel.paymentMethods"
                  :key="method"
                  class="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-default px-3 py-2 hover:bg-muted"
                  :class="selectedPaymentMethod === method ? 'border-primary bg-primary/5' : ''"
                >
                  <input
                    v-model="selectedPaymentMethod"
                    type="radio"
                    name="wallet-topup-method"
                    :value="method"
                    class="size-4 accent-primary"
                  >
                  <span class="text-sm font-medium text-highlighted">{{ method === 'wechat' ? '微信支付' : '支付宝' }}</span>
                </label>
              </fieldset>
              <UButton
                type="submit"
                color="primary"
                icon="i-lucide-lock-keyhole"
                :loading="topUpBusy"
                :disabled="!canCreateTopUp"
              >
                创建充值支付
              </UButton>
              <p
                v-if="latestActiveTopUp"
                class="text-sm text-warning"
              >
                你有一笔尚未确认的充值。请先恢复这笔记录，避免重复支付。
              </p>
            </form>
          </UCard>

          <UCard v-if="latestActiveTopUp">
            <template #header>
              <h2 class="text-lg font-semibold text-highlighted">
                充值处理中
              </h2>
            </template>
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-sm text-muted">
                  充值金额
                </p>
                <p class="mt-1 text-2xl font-semibold tabular-nums text-highlighted">
                  ¥{{ latestActiveTopUp.amount }}
                </p>
                <p class="mt-2 text-sm text-muted">
                  {{ topUpStatusLabel(latestActiveTopUp) }} · {{ latestActiveTopUp.channelName ?? '支付通道' }}
                </p>
                <p
                  v-if="latestActiveTopUp.receiptDisposition"
                  class="mt-1 text-xs text-muted"
                >
                  回执：{{ latestActiveTopUp.receiptDisposition }} · 实收 ¥{{ latestActiveTopUp.receiptAmount ?? '0.00' }}
                </p>
                <p
                  v-if="latestActiveTopUp.reconciliationReasons.length"
                  class="mt-1 text-xs text-warning"
                >
                  待核对：{{ latestActiveTopUp.reconciliationReasons.map(reconciliationReasonLabel).join('、') }}
                </p>
              </div>
              <UBadge
                :color="latestActiveTopUp.reconciliationOpen ? 'warning' : 'neutral'"
                variant="soft"
              >
                {{ topUpStatusLabel(latestActiveTopUp) }}
              </UBadge>
            </div>
            <figure
              v-if="latestActiveTopUp.action?.type === 'qr_code' && qrDataUrl"
              class="mx-auto mt-4 grid w-full max-w-64 justify-items-center gap-2 rounded-xl border border-default bg-default p-4"
            >
              <img
                :src="qrDataUrl"
                alt="钱包充值支付二维码"
                width="256"
                height="256"
                class="size-56 max-w-full"
              >
              <figcaption class="text-center text-xs text-muted">
                使用对应的支付应用扫码
              </figcaption>
            </figure>
            <p
              v-if="qrError"
              class="mt-3 text-sm text-error"
              role="alert"
            >
              {{ qrError }}
            </p>
            <a
              v-if="latestActiveTopUp.action?.type === 'redirect'"
              :href="latestActiveTopUp.action.url"
              target="_blank"
              rel="noopener noreferrer"
              class="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-inverted hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              打开支付页面
            </a>
            <UButton
              class="mt-4"
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="refreshingAttemptId === latestActiveTopUp.id"
              :disabled="Boolean(refreshingAttemptId)"
              @click="refreshTopUp(latestActiveTopUp.id)"
            >
              安全恢复充值状态
            </UButton>
            <p class="mt-3 text-xs leading-5 text-muted">
              不要根据浏览器跳转或支付平台展示的成功页判断到账。请等待此处状态更新。
            </p>
          </UCard>
          <UCard v-else>
            <template #header>
              <h2 class="text-lg font-semibold text-highlighted">
                充值说明
              </h2>
            </template>
            <ul class="grid gap-3 text-sm leading-6 text-muted">
              <li>充值余额只进入现金余额，不兑换赠送余额。</li>
              <li>充值使用服务端支付回执；重复通知不会重复入账。</li>
              <li>处理中或异常充值会保留原记录，可在此页面恢复。</li>
            </ul>
          </UCard>
        </section>

        <section
          class="mt-8"
          aria-labelledby="topups-title"
        >
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2
                id="topups-title"
                class="text-xl font-semibold text-highlighted"
              >
                充值记录
              </h2>
              <p class="mt-1 text-sm text-muted">
                展示支付尝试、实收凭证与异常核对状态。
              </p>
            </div>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="topUpsPending"
              @click="refreshTopUps()"
            >
              刷新记录
            </UButton>
          </div>
          <div
            v-if="topUps?.items.length"
            class="mt-4 grid gap-3"
          >
            <UCard
              v-for="item in topUps.items"
              :key="item.id"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class="font-semibold tabular-nums text-highlighted">
                    ¥{{ item.amount }}
                  </p>
                  <p class="mt-1 text-sm text-muted">
                    {{ item.channelName ?? '在线支付' }} · {{ item.paymentMethod === 'wechat' ? '微信支付' : '支付宝' }}
                  </p>
                  <p class="mt-1 text-xs text-muted">
                    创建于 {{ formatDate(item.createdAt) }}
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
                <div class="flex flex-wrap items-center gap-2">
                  <UBadge
                    :color="item.status === 'succeeded' ? 'success' : item.reconciliationOpen || item.status === 'reconciliation_required' ? 'warning' : 'neutral'"
                    variant="soft"
                  >
                    {{ topUpStatusLabel(item) }}
                  </UBadge>
                  <UButton
                    v-if="['created', 'pending', 'reconciliation_required'].includes(item.status)"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :loading="refreshingAttemptId === item.id"
                    :disabled="Boolean(refreshingAttemptId)"
                    @click="refreshTopUp(item.id)"
                  >
                    恢复状态
                  </UButton>
                </div>
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
          <div
            v-if="topUps && topUps.totalPages > 1"
            class="mt-4 flex items-center justify-between gap-3"
          >
            <p class="text-sm text-muted">
              第 {{ topUps.page }} / {{ topUps.totalPages }} 页 · 共 {{ topUps.total }} 笔
            </p>
            <div class="flex gap-2">
              <UButton
                color="neutral"
                variant="outline"
                :disabled="topUpPage <= 1"
                @click="topUpPage--"
              >
                上一页
              </UButton>
              <UButton
                color="neutral"
                variant="outline"
                :disabled="topUpPage >= topUps.totalPages"
                @click="topUpPage++"
              >
                下一页
              </UButton>
            </div>
          </div>
        </section>

        <section
          class="mt-8"
          aria-labelledby="ledger-title"
        >
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2
                id="ledger-title"
                class="text-xl font-semibold text-highlighted"
              >
                钱包收支明细
              </h2>
              <p class="mt-1 text-sm text-muted">
                资金来源、订单关联与支付回执均来自服务端不可变账本。
              </p>
            </div>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="ledgerPending"
              @click="refreshLedger()"
            >
              刷新流水
            </UButton>
          </div>
          <div
            v-if="ledger?.items.length"
            class="mt-4 grid gap-3"
          >
            <UCard
              v-for="item in ledger.items"
              :key="item.id"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="font-medium text-highlighted">
                    {{ ledgerLabel(item) }}
                  </p>
                  <p class="mt-1 text-sm text-muted">
                    {{ item.operationType }} · {{ formatDate(item.createdAt) }}
                  </p>
                  <NuxtLink
                    v-if="item.orderId"
                    :to="`/orders/${item.orderId}`"
                    class="mt-1 inline-flex min-h-11 items-center text-sm text-primary hover:underline"
                  >
                    查看关联订单
                  </NuxtLink>
                  <p
                    v-if="item.providerTransactionId"
                    class="mt-1 break-all font-mono text-xs text-muted"
                  >
                    平台交易号 {{ item.providerTransactionId }}
                  </p>
                  <p
                    v-if="item.paymentDisposition"
                    class="mt-1 text-xs text-muted"
                  >
                    回执状态 {{ item.paymentDisposition }}
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
          <div
            v-if="ledger && ledger.totalPages > 1"
            class="mt-4 flex items-center justify-between gap-3"
          >
            <p class="text-sm text-muted">
              第 {{ ledger.page }} / {{ ledger.totalPages }} 页 · 共 {{ ledger.total }} 条
            </p>
            <div class="flex gap-2">
              <UButton
                color="neutral"
                variant="outline"
                :disabled="ledgerPage <= 1"
                @click="ledgerPage--"
              >
                上一页
              </UButton>
              <UButton
                color="neutral"
                variant="outline"
                :disabled="ledgerPage >= ledger.totalPages"
                @click="ledgerPage++"
              >
                下一页
              </UButton>
            </div>
          </div>
        </section>
      </template>
    </main>
  </UContainer>
</template>
