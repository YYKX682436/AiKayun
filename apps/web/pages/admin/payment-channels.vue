<script setup lang="ts">
import type { AdminPaymentChannel, ExternalPaymentMethod, PaymentCredentialReencryptionResult, PaymentProviderType } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '支付通道管理' })
useResponseHeader('Cache-Control').value = 'private, no-store, max-age=0'

type ChannelDraft = {
  name: string
  enabled: boolean
  paymentMethods: ExternalPaymentMethod[]
  displayOrder: number
  merchantId: string
  merchantKey: string
}

const { request } = useAdminApi()
const channels = shallowRef<AdminPaymentChannel[]>([])
const paymentMethodOptions: ExternalPaymentMethod[] = ['alipay', 'wechat']
const drafts = reactive<Record<string, ChannelDraft>>({})
const creating = ref(false)
const loading = ref(false)
const savingId = ref('')
const testingId = ref('')
const reencrypting = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const testMessages = reactive<Record<string, string>>({})

const createDraft = reactive({
  providerType: 'zpay_epay_v1' as PaymentProviderType,
  name: '易支付通道',
  enabled: false,
  paymentMethods: ['alipay', 'wechat'] as ExternalPaymentMethod[],
  displayOrder: 0,
  merchantId: '',
  merchantKey: '',
})

function methodName(method: ExternalPaymentMethod): string {
  return method === 'wechat' ? '微信支付' : '支付宝'
}

function methodsFor(providerType: PaymentProviderType, methods: ExternalPaymentMethod[]): ExternalPaymentMethod[] {
  return providerType === 'codepay_unconfigured' ? [] : methods
}

function toggleMethod(methods: ExternalPaymentMethod[], method: ExternalPaymentMethod, selected: boolean): ExternalPaymentMethod[] {
  if (selected) return methods.includes(method) ? methods : [...methods, method]
  return methods.filter(item => item !== method)
}

function resetDrafts(items: AdminPaymentChannel[]) {
  for (const key of Object.keys(drafts)) delete drafts[key]
  for (const channel of items) {
    drafts[channel.id] = {
      name: channel.name,
      enabled: channel.enabled,
      paymentMethods: [...channel.paymentMethods],
      displayOrder: channel.displayOrder,
      merchantId: '',
      merchantKey: '',
    }
  }
}

async function loadChannels() {
  loading.value = true
  errorMessage.value = ''
  try {
    const result = await request<{ items: AdminPaymentChannel[] }>('/api/v1/admin/payment-channels')
    channels.value = result.items
    resetDrafts(result.items)
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError || error instanceof Error
      ? error.message
      : '支付通道暂时无法读取。'
  } finally {
    loading.value = false
  }
}

async function createChannel() {
  if (creating.value) return
  creating.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  const methods = methodsFor(createDraft.providerType, createDraft.paymentMethods)
  const body: Record<string, unknown> = {
    providerType: createDraft.providerType,
    name: createDraft.name.trim(),
    enabled: createDraft.providerType === 'codepay_unconfigured' ? false : createDraft.enabled,
    paymentMethods: methods,
    displayOrder: createDraft.displayOrder,
  }
  if (createDraft.providerType === 'zpay_epay_v1') {
    body.merchantId = createDraft.merchantId.trim()
    body.merchantKey = createDraft.merchantKey.trim()
  }
  try {
    await request('/api/v1/admin/payment-channels', { method: 'POST', body })
    createDraft.name = createDraft.providerType === 'zpay_epay_v1' ? '易支付通道' : '码支付（待协议确认）'
    createDraft.enabled = false
    createDraft.displayOrder = 0
    createDraft.merchantId = ''
    createDraft.merchantKey = ''
    statusMessage.value = '支付通道已创建；商户密钥只显示在本次提交表单中。'
    await loadChannels()
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError || error instanceof Error
      ? error.message
      : '支付通道未能创建。'
  } finally {
    creating.value = false
  }
}

async function saveChannel(channel: AdminPaymentChannel) {
  const draft = drafts[channel.id]
  if (!draft || savingId.value) return
  savingId.value = channel.id
  errorMessage.value = ''
  statusMessage.value = ''
  const body: Record<string, unknown> = {
    name: draft.name.trim(),
    enabled: channel.providerType === 'codepay_unconfigured' ? false : draft.enabled,
    paymentMethods: methodsFor(channel.providerType, draft.paymentMethods),
    displayOrder: draft.displayOrder,
  }
  if (draft.merchantId.trim()) body.merchantId = draft.merchantId.trim()
  if (draft.merchantKey.trim()) body.merchantKey = draft.merchantKey.trim()
  try {
    await request(`/api/v1/admin/payment-channels/${channel.id}`, { method: 'PATCH', body })
    statusMessage.value = draft.merchantId.trim() || draft.merchantKey.trim()
      ? '通道设置已保存，新的支付尝试将使用新凭据版本。'
      : '通道设置已保存。'
    testMessages[channel.id] = ''
    await loadChannels()
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError || error instanceof Error
      ? error.message
      : '支付通道设置未能保存。'
  } finally {
    savingId.value = ''
  }
}

async function testChannel(channel: AdminPaymentChannel) {
  if (testingId.value || !channel.providerAvailable) return
  testingId.value = channel.id
  errorMessage.value = ''
  testMessages[channel.id] = ''
  try {
    const result = await request<{ valid: boolean; message: string }>(`/api/v1/admin/payment-channels/${channel.id}/test`, { method: 'POST' })
    testMessages[channel.id] = result.message
  } catch (error) {
    testMessages[channel.id] = error instanceof Error ? error.message : '服务商配置测试失败。'
  } finally {
    testingId.value = ''
  }
}

async function reencryptCredentials() {
  if (reencrypting.value) return
  reencrypting.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const result = await request<PaymentCredentialReencryptionResult>('/api/v1/admin/payment-channels/reencrypt', { method: 'POST' })
    statusMessage.value = `已用活动加密密钥 ${result.activeKeyId} 重新加密 ${result.channelsReencrypted} 个通道和 ${result.attemptsReencrypted} 份历史支付凭据快照。`
    await loadChannels()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '凭据重新加密失败。'
  } finally {
    reencrypting.value = false
  }
}

onMounted(() => { void loadChannels() })
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="支付通道管理">
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main
        id="admin-main-content"
        class="mx-auto w-full max-w-[76rem] min-w-0 px-4 py-5 sm:px-6 lg:px-8"
      >
        <header class="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-medium text-primary">
              订单收款配置
            </p>
            <h1 class="mt-1 text-2xl font-semibold tracking-tight text-highlighted">
              支付通道
            </h1>
            <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
              一个通道可同时提供支付宝和微信支付。商户密钥使用环境密钥加密保存；后台列表和顾客页面都不会读取或返回明文密钥。
            </p>
          </div>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            :loading="loading"
            @click="loadChannels"
          >
            重新读取
          </UButton>
        </header>

        <UAlert
          v-if="errorMessage"
          class="mb-4"
          color="error"
          variant="subtle"
          :title="errorMessage"
          role="alert"
          aria-live="assertive"
        />
        <UAlert
          v-if="statusMessage"
          class="mb-4"
          color="success"
          variant="subtle"
          :title="statusMessage"
          role="status"
          aria-live="polite"
        />

        <section
          class="rounded-xl border border-default bg-elevated p-4 sm:p-5"
          aria-labelledby="create-payment-channel-title"
        >
          <h2
            id="create-payment-channel-title"
            class="font-semibold text-highlighted"
          >
            新增支付通道
          </h2>
          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            <UFormField
              label="服务商协议"
              name="providerType"
            >
              <USelect
                v-model="createDraft.providerType"
                :items="[
                  { label: 'ZPAY 易支付兼容协议 v1', value: 'zpay_epay_v1' },
                  { label: '码支付（协议待确认）', value: 'codepay_unconfigured' },
                ]"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="通道名称"
              name="name"
              required
            >
              <UInput
                v-model="createDraft.name"
                maxlength="80"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="展示顺序"
              name="displayOrder"
              description="数值越小越靠前。"
            >
              <UInput
                v-model.number="createDraft.displayOrder"
                type="number"
                min="0"
                max="100000"
                class="w-full"
              />
            </UFormField>
            <UFormField
              v-if="createDraft.providerType === 'zpay_epay_v1'"
              label="商户号"
              name="merchantId"
              required
            >
              <UInput
                v-model="createDraft.merchantId"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>
            <UFormField
              v-if="createDraft.providerType === 'zpay_epay_v1'"
              label="商户密钥"
              name="merchantKey"
              required
              description="仅此次输入，不会在保存后回显。"
              class="sm:col-span-2"
            >
              <UInput
                v-model="createDraft.merchantKey"
                type="password"
                autocomplete="new-password"
                class="w-full"
              />
            </UFormField>
          </div>
          <fieldset
            v-if="createDraft.providerType === 'zpay_epay_v1'"
            class="mt-4 grid gap-2"
          >
            <legend class="text-sm font-medium text-highlighted">
              支持的支付方式
            </legend>
            <div class="flex flex-wrap gap-x-5 gap-y-2">
              <UCheckbox
                v-for="method in paymentMethodOptions"
                :key="method"
                :model-value="createDraft.paymentMethods.includes(method)"
                :label="methodName(method)"
                @update:model-value="value => createDraft.paymentMethods = toggleMethod(createDraft.paymentMethods, method, Boolean(value))"
              />
            </div>
          </fieldset>
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
            <UCheckbox
              v-if="createDraft.providerType === 'zpay_epay_v1'"
              v-model="createDraft.enabled"
              label="创建后立即启用"
            />
            <UAlert
              v-else
              color="warning"
              variant="subtle"
              title="码支付协议尚未核实"
              description="目前只能创建停用占位通道；需先确认具体服务商文档、签名、回调、金额单位和查单规则。"
            />
            <UButton
              color="primary"
              icon="i-lucide-plus"
              :loading="creating"
              :disabled="creating"
              @click="createChannel"
            >
              新增通道
            </UButton>
          </div>
        </section>

        <section
          class="mt-6"
          aria-labelledby="payment-channels-title"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="payment-channels-title"
              class="text-lg font-semibold text-highlighted"
            >
              已配置通道
            </h2>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-key-round"
              :loading="reencrypting"
              :disabled="reencrypting || !channels.some(channel => channel.credentialsConfigured)"
              @click="reencryptCredentials"
            >
              用活动密钥重新加密历史凭据
            </UButton>
          </div>
          <UAlert
            v-if="!channels.length && !loading"
            class="mt-3"
            color="neutral"
            variant="subtle"
            title="尚无支付通道"
            description="新增并验证服务商配置后，启用的支付方式会出现在顾客订单页。"
          />
          <ul class="mt-3 grid gap-4">
            <li
              v-for="channel in channels"
              :key="channel.id"
              class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="break-all font-mono text-xs text-muted">
                    {{ channel.providerType }} · 配置版本 {{ channel.credentialVersion }}
                  </p>
                  <p class="mt-1 break-words font-medium text-highlighted">
                    {{ channel.name }}
                  </p>
                  <p class="mt-1 text-sm text-muted">
                    商户号 {{ channel.merchantIdMasked ?? (channel.credentialsConfigured ? '已配置但当前加密密钥不可用' : '尚未配置') }}
                    · {{ channel.paymentMethods.length ? channel.paymentMethods.map(methodName).join('、') : '无可用支付方式' }}
                  </p>
                </div>
                <UBadge
                  :color="channel.enabled && channel.providerAvailable ? 'success' : 'neutral'"
                  variant="soft"
                >
                  {{ channel.enabled && channel.providerAvailable ? '已启用' : channel.enabled ? '不可用' : '已停用' }}
                </UBadge>
              </div>

              <div class="mt-4 grid gap-4 border-t border-default pt-4 sm:grid-cols-2">
                <UFormField
                  label="通道名称"
                  :name="`name-${channel.id}`"
                >
                  <UInput
                    v-model="drafts[channel.id]!.name"
                    maxlength="80"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  label="展示顺序"
                  :name="`order-${channel.id}`"
                >
                  <UInput
                    v-model.number="drafts[channel.id]!.displayOrder"
                    type="number"
                    min="0"
                    max="100000"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  v-if="channel.providerType === 'zpay_epay_v1'"
                  label="更换商户号"
                  :name="`merchant-${channel.id}`"
                >
                  <UInput
                    v-model="drafts[channel.id]!.merchantId"
                    autocomplete="off"
                    placeholder="留空保持不变"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  v-if="channel.providerType === 'zpay_epay_v1'"
                  label="轮换商户密钥"
                  :name="`key-${channel.id}`"
                  description="留空保持不变；旧支付尝试继续使用各自的凭据快照。"
                >
                  <UInput
                    v-model="drafts[channel.id]!.merchantKey"
                    type="password"
                    autocomplete="new-password"
                    placeholder="仅输入新密钥"
                    class="w-full"
                  />
                </UFormField>
              </div>

              <fieldset
                v-if="channel.providerType === 'zpay_epay_v1'"
                class="mt-4 grid gap-2"
              >
                <legend class="text-sm font-medium text-highlighted">
                  支持的支付方式
                </legend>
                <div class="flex flex-wrap gap-x-5 gap-y-2">
                  <UCheckbox
                    v-for="method in paymentMethodOptions"
                    :key="method"
                    :model-value="drafts[channel.id]!.paymentMethods.includes(method)"
                    :label="methodName(method)"
                    @update:model-value="value => drafts[channel.id]!.paymentMethods = toggleMethod(drafts[channel.id]!.paymentMethods, method, Boolean(value))"
                  />
                </div>
              </fieldset>
              <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
                <UCheckbox
                  v-if="channel.providerType === 'zpay_epay_v1'"
                  v-model="drafts[channel.id]!.enabled"
                  label="启用该支付通道"
                  :disabled="!channel.providerAvailable"
                />
                <p
                  v-else
                  class="text-sm text-muted"
                >
                  协议确认前，此占位通道保持停用。
                </p>
                <div class="flex flex-wrap gap-2">
                  <UButton
                    v-if="channel.providerType === 'zpay_epay_v1'"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-plug-zap"
                    :loading="testingId === channel.id"
                    :disabled="!channel.providerAvailable || Boolean(testingId)"
                    @click="testChannel(channel)"
                  >
                    测试配置
                  </UButton>
                  <UButton
                    color="primary"
                    icon="i-lucide-save"
                    :loading="savingId === channel.id"
                    :disabled="Boolean(savingId)"
                    @click="saveChannel(channel)"
                  >
                    保存通道
                  </UButton>
                </div>
              </div>
              <p
                v-if="testMessages[channel.id]"
                class="mt-3 text-sm text-muted"
                role="status"
              >
                {{ testMessages[channel.id] }}
              </p>
              <p class="mt-2 text-xs text-dimmed">
                最近修改 {{ new Date(channel.updatedAt).toLocaleString('zh-CN') }}
              </p>
            </li>
          </ul>
        </section>
      </main>
    </template>
  </UDashboardPanel>
</template>
