<script setup lang="ts">
import type { UpdateWithdrawalSettingsBody, WithdrawalPayoutMethod, WithdrawalSettings } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '提现设置' })
if (import.meta.server) useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

const { request } = useAdminApi()
const loading = ref(true)
const saving = ref(false)
const errorMessage = ref('')
const savedMessage = ref('')
const enabled = ref(false)
const minAmount = ref('1.00')
const maxAmount = ref('10000.00')
const fixedFee = ref('0.00')
const percentFee = ref('0.0000')
const methods = ref<WithdrawalPayoutMethod[]>(['alipay', 'wechat', 'bank_card'])

const payoutMethods: Array<{ value: WithdrawalPayoutMethod; label: string }> = [
  { value: 'alipay', label: '支付宝' },
  { value: 'wechat', label: '微信' },
  { value: 'bank_card', label: '银行卡' },
]

function applySettings(settings: WithdrawalSettings) {
  enabled.value = settings.enabled
  minAmount.value = settings.minAmount
  maxAmount.value = settings.maxAmount
  fixedFee.value = settings.fixedFee
  percentFee.value = settings.percentFee
  methods.value = [...settings.methods]
}

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    applySettings(await request<WithdrawalSettings>('/api/v1/admin/withdrawals/settings'))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '提现设置暂时无法加载。'
  } finally {
    loading.value = false
  }
}

function toggleMethod(method: WithdrawalPayoutMethod, checked: boolean) {
  methods.value = checked
    ? [...new Set([...methods.value, method])]
    : methods.value.filter(value => value !== method)
}

async function save() {
  if (saving.value || (enabled.value && methods.value.length === 0)) return
  saving.value = true
  errorMessage.value = ''
  savedMessage.value = ''
  const body: UpdateWithdrawalSettingsBody = {
    enabled: enabled.value,
    minAmount: minAmount.value,
    maxAmount: maxAmount.value,
    fixedFee: fixedFee.value,
    percentFee: percentFee.value,
    methods: payoutMethods.map(item => item.value).filter(method => methods.value.includes(method)),
  }
  try {
    applySettings(await request<WithdrawalSettings>('/api/v1/admin/withdrawals/settings', { method: 'PUT', body }))
    savedMessage.value = '提现设置已保存。新设置只应用于之后提交的申请，历史手续费与收款快照不变。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设置保存结果尚未确认，请重新读取后检查。'
  } finally {
    saving.value = false
  }
}

onMounted(() => { void load() })
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="提现设置">
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main
        id="admin-main-content"
        class="mx-auto w-full max-w-4xl min-w-0 px-4 py-5 sm:px-6 lg:px-8"
      >
        <header class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-primary">
              提现管理
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              提现设置
            </h1>
            <p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
              配置顾客可申请的单次金额、按百分比加固定值计算的手续费，以及开放的收款方式。
            </p>
          </div>
          <UButton
            to="/admin/withdrawals"
            color="neutral"
            variant="outline"
            icon="i-lucide-arrow-left"
            class="min-h-11"
          >
            返回提现列表
          </UButton>
        </header>

        <UAlert
          v-if="errorMessage"
          class="mt-5"
          color="error"
          variant="soft"
          :title="errorMessage"
          role="alert"
          aria-live="assertive"
        >
          <template #actions>
            <UButton
              color="error"
              variant="outline"
              :loading="loading"
              @click="load"
            >
              重新读取
            </UButton>
          </template>
        </UAlert>
        <UAlert
          v-if="savedMessage"
          class="mt-5"
          color="success"
          variant="soft"
          :title="savedMessage"
          role="status"
          aria-live="polite"
        />

        <form
          class="mt-6 grid gap-5"
          :aria-busy="loading || saving"
          @submit.prevent="save"
        >
          <UCard>
            <template #header>
              <h2 class="font-semibold text-highlighted">
                申请规则
              </h2>
            </template>
            <div class="grid gap-5">
              <label class="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-default px-4 py-3">
                <span>
                  <span class="block font-medium text-highlighted">允许顾客提现</span>
                  <span class="mt-1 block text-sm leading-5 text-muted">关闭后阻止新申请；已提交申请仍可在提现列表审核和打款。</span>
                </span>
                <input
                  v-model="enabled"
                  type="checkbox"
                  class="size-5 shrink-0 accent-primary"
                  :disabled="loading || saving"
                >
              </label>
              <div class="grid gap-4 sm:grid-cols-2">
                <UFormField
                  label="单次最低金额"
                  name="withdrawalMinAmount"
                >
                  <UInput
                    v-model="minAmount"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="w-full"
                    :disabled="loading || saving"
                  />
                </UFormField>
                <UFormField
                  label="单次最高金额"
                  name="withdrawalMaxAmount"
                >
                  <UInput
                    v-model="maxAmount"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="w-full"
                    :disabled="loading || saving"
                  />
                </UFormField>
              </div>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <div>
                <h2 class="font-semibold text-highlighted">
                  手续费
                </h2>
                <p class="mt-1 text-sm text-muted">
                  手续费 = 提现金额 × 百分比 + 固定手续费。服务端使用十进制精确计算并按半入规则保留两位小数。
                </p>
              </div>
            </template>
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField
                label="百分比手续费（%）"
                name="withdrawalPercentFee"
                description="最多四位小数，范围 0 至 100。"
              >
                <UInput
                  v-model="percentFee"
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  class="w-full"
                  :disabled="loading || saving"
                />
              </UFormField>
              <UFormField
                label="固定手续费（元）"
                name="withdrawalFixedFee"
                description="按最终结算精度输入，费用必须小于每笔提现金额。"
              >
                <UInput
                  v-model="fixedFee"
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  class="w-full"
                  :disabled="loading || saving"
                />
              </UFormField>
            </div>
            <p class="mt-4 rounded-lg bg-muted p-3 text-sm leading-6 text-muted">
              每笔申请都会保存金额、手续费、预计到账金额和收款信息快照。之后修改本设置不会追溯影响历史申请。
            </p>
          </UCard>

          <UCard>
            <template #header>
              <div>
                <h2 class="font-semibold text-highlighted">
                  支持的收款方式
                </h2>
                <p class="mt-1 text-sm text-muted">
                  可以只开放一种或两种方式；开启提现时至少选择一种。
                </p>
              </div>
            </template>
            <fieldset class="grid gap-3 sm:grid-cols-3">
              <legend class="sr-only">
                选择可用收款方式
              </legend>
              <label
                v-for="method in payoutMethods"
                :key="method.value"
                class="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-default px-4 py-3 hover:bg-muted"
              >
                <input
                  type="checkbox"
                  class="size-4 accent-primary"
                  :checked="methods.includes(method.value)"
                  :disabled="loading || saving"
                  @change="toggleMethod(method.value, ($event.target as HTMLInputElement).checked)"
                >
                <span class="font-medium text-highlighted">{{ method.label }}</span>
              </label>
            </fieldset>
          </UCard>

          <div class="flex flex-wrap items-center justify-between gap-3">
            <p
              v-if="enabled && methods.length === 0"
              class="text-sm text-error"
              role="alert"
            >
              开启提现前，请至少选择一种收款方式。
            </p>
            <span
              v-else
              class="text-sm text-muted"
            >服务端会在每次申请提交时重新校验规则和手续费。</span>
            <UButton
              type="submit"
              color="primary"
              icon="i-lucide-save"
              class="min-h-11"
              :loading="saving"
              :disabled="loading || saving || (enabled && methods.length === 0)"
            >
              保存提现设置
            </UButton>
          </div>
        </form>
      </main>
    </template>
  </UDashboardPanel>
</template>
