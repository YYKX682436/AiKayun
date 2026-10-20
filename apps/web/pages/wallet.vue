<script setup lang="ts">
import type {
  ApiSuccess,
  CustomerTopUpPage,
  CustomerWalletLedgerPage,
  CustomerWalletSummary,
  ExternalPaymentMethod,
} from '@aikayun/contracts'
import { CustomerApiError, useCustomerApi } from '~/composables/useCustomerApi'

definePageMeta({ middleware: 'customer-auth' })
useSeoMeta({ title: '我的钱包', description: '查看钱包余额、充值进度和不可变收支明细。', robots: 'noindex, nofollow' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

type PublicPaymentChannel = { id: string; name: string; paymentMethods: ExternalPaymentMethod[] }
type PublicPaymentChannelList = { items: PublicPaymentChannel[] }

const customerApi = useCustomerApi()
const customerId = computed(() => customerApi.session.value?.customer.id ?? 'unknown')
const identity = computed(() => `${customerId.value}-${customerApi.identityVersion.value}`)
const ledgerPage = ref(1)
const topUpPage = ref(1)
const amountInput = ref('')
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
const { data: channelsResponse } = await useFetch<ApiSuccess<PublicPaymentChannelList>>(
  '/api/v1/public/payment-channels',
  { key: 'wallet-public-payment-channels' },
)

const wallet = computed(() => walletResponse.value?.data ?? null)
const ledger = computed(() => ledgerResponse.value?.data ?? null)
const topUps = computed(() => topUpsResponse.value?.data ?? null)
const channels = computed(() => channelsResponse.value?.data.items ?? [])
const selectedChannel = computed(() => channels.value.find(channel => channel.id === selectedChannelId.value) ?? null)
const loading = computed(() => walletPending.value || ledgerPending.value || topUpsPending.value)
const hasPageError = computed(() => walletError.value || ledgerError.value || topUpsError.value)
const latestActiveTopUp = computed(() => topUps.value?.items.find(item => ['created', 'pending', 'reconciliation_required'].includes(item.status)) ?? null)
const activeQrAction = computed(() => latestActiveTopUp.value?.action?.type === 'qr_code' ? latestActiveTopUp.value.action.value : '')

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

watch(channels, (items) => {
  if (!items.some(channel => channel.id === selectedChannelId.value)) selectedChannelId.value = items[0]?.id ?? ''
  const methods = selectedChannel.value?.paymentMethods ?? []
  if (!methods.includes(selectedPaymentMethod.value) && methods[0]) selectedPaymentMethod.value = methods[0]
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
