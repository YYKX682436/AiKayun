<script setup lang="ts">
import type { ApiSuccess, StorefrontCustomerPolicy } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '顾客与游客设置' })

const api = useAdminApi()
const { data: policyResponse, error: loadError, pending } = await useFetch<ApiSuccess<StorefrontCustomerPolicy>>(
  '/api/v1/admin/storefront/customer-policy',
  { key: 'admin-storefront-customer-policy' },
)

const settings = reactive({
  requireEmail: policyResponse.value?.data.requireEmail ?? false,
  requirePhone: policyResponse.value?.data.requirePhone ?? false,
  guestCheckoutEnabled: policyResponse.value?.data.guestCheckoutEnabled ?? false,
  guestFreeClaimEnabled: policyResponse.value?.data.guestFreeClaimEnabled ?? false,
  unpaidOrderTimeoutMinutes: policyResponse.value?.data.unpaidOrderTimeoutMinutes ?? 15,
})
const busy = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

async function saveSettings() {
  if (busy.value) return
  busy.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    await api.request<StorefrontCustomerPolicy>('/api/v1/admin/storefront/customer-policy', {
      method: 'PUT',
      body: { ...settings },
    })
    successMessage.value = '顾客注册与游客策略已保存。'
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError ? error.message : '暂时无法保存设置，请稍后重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="admin-customer-policy">
    <template #header>
      <UDashboardNavbar
        title="顾客设置"
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
        <div>
          <p class="text-sm font-medium text-primary">
            店铺经营
          </p>
          <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
            顾客与游客设置
          </h1>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
            调整新顾客的注册资料要求，以及后续游客流程的策略开关。注册要求不会阻止已有顾客登录。
          </p>
        </div>

        <UAlert
          v-if="loadError"
          class="mt-6"
          color="error"
          variant="soft"
          title="无法读取当前设置，请刷新页面重试。"
          role="alert"
        />
        <UAlert
          v-if="errorMessage"
          class="mt-6"
          color="error"
          variant="soft"
          :title="errorMessage"
          role="alert"
          aria-live="assertive"
        />
        <UAlert
          v-if="successMessage"
          class="mt-6"
          color="success"
          variant="soft"
          :title="successMessage"
          role="status"
          aria-live="polite"
        />

        <form
          class="mt-7 grid gap-6"
          :aria-busy="busy || pending"
          @submit.prevent="saveSettings"
        >
          <UCard>
            <template #header>
              <div>
                <h2 class="text-lg font-semibold text-highlighted">
                  顾客注册
                </h2>
                <p class="mt-1 text-sm leading-6 text-muted">
                  用户名和密码始终必填；邮箱和手机号可分别设置为必填。
                </p>
              </div>
            </template>
            <div class="grid gap-5 sm:grid-cols-2">
              <UFormField name="requireEmail">
                <USwitch
                  v-model="settings.requireEmail"
                  label="注册时要求邮箱"
                  description="开启后，新注册顾客必须填写有效邮箱。"
                  :disabled="busy || pending || !policyResponse"
                />
              </UFormField>
              <UFormField name="requirePhone">
                <USwitch
                  v-model="settings.requirePhone"
                  label="注册时要求手机号"
                  description="开启后，新注册顾客必须填写有效手机号。"
                  :disabled="busy || pending || !policyResponse"
                />
              </UFormField>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <div>
                <h2 class="text-lg font-semibold text-highlighted">
                  游客策略
                </h2>
                <p class="mt-1 text-sm leading-6 text-muted">
                  游客下单与免费领取分别按商品金额执行。超时期限只影响之后创建的待付款订单。
                </p>
              </div>
            </template>
            <div class="grid gap-5 sm:grid-cols-2">
              <UFormField name="guestCheckoutEnabled">
                <USwitch
                  v-model="settings.guestCheckoutEnabled"
                  label="允许游客下单"
                  description="仅保存策略，不会开放尚未实现的购买流程。"
                  :disabled="busy || pending || !policyResponse"
                />
              </UFormField>
              <UFormField name="guestFreeClaimEnabled">
                <USwitch
                  v-model="settings.guestFreeClaimEnabled"
                  label="允许游客领取免费商品"
                  description="仅保存策略，不会开放领取、订单或支付接口。"
                  :disabled="busy || pending || !policyResponse"
                />
              </UFormField>
            </div>
            <div class="mt-6 max-w-sm">
              <UFormField
                label="未付款订单关闭时间"
                description="已创建订单的过期时间保持不变。"
                name="unpaidOrderTimeoutMinutes"
              >
                <USelect
                  id="unpaid-order-timeout"
                  v-model="settings.unpaidOrderTimeoutMinutes"
                  :items="[
                    { label: '5 分钟', value: 5 },
                    { label: '15 分钟', value: 15 },
                    { label: '30 分钟', value: 30 },
                  ]"
                  value-key="value"
                  class="w-full"
                  :disabled="busy || pending || !policyResponse"
                />
              </UFormField>
            </div>
          </UCard>

          <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <UButton
              type="submit"
              size="lg"
              icon="i-lucide-save"
              :loading="busy"
              :disabled="busy || pending || !policyResponse"
              class="min-h-11 sm:min-w-44"
            >
              保存设置
            </UButton>
          </div>
        </form>
      </main>
    </template>
  </UDashboardPanel>
</template>
