<script setup lang="ts">
import { storefrontSupportLimits, type ApiSuccess, type StorefrontSupportChannel, type StorefrontSupportSettings } from '@aikayun/contracts'
import { AdminApiError } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '客服设置' })

const endpoint = '/api/v1/admin/storefront/support'
const api = useAdminApi()
const { data, status, refresh } = await useFetch<ApiSuccess<StorefrontSupportSettings>>(endpoint, {
  key: 'admin-storefront-support',
  getCachedData: (key, nuxtApp) => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : undefined,
})
const channelTypes = [
  { label: 'HTTPS 联系链接', value: 'https' },
  { label: '可复制的客服账号', value: 'account' },
]

let nextId = 0
const channels = ref<Array<StorefrontSupportChannel & { id: number }>>([])
const busy = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

watch(data, (response) => {
  channels.value = (response?.data.channels ?? []).map(channel => ({ ...channel, id: nextId++ }))
}, { immediate: true })

watch(channels, () => {
  errorMessage.value = ''
  successMessage.value = ''
}, { deep: true, flush: 'sync' })

function addChannel() {
  if (channels.value.length < storefrontSupportLimits.channels) {
    channels.value.push({ id: nextId++, name: '', type: 'account', content: '' })
  }
}

function moveChannel(index: number, offset: -1 | 1) {
  const target = index + offset
  const channel = channels.value[index]
  if (!channel || target < 0 || target >= channels.value.length) return
  channels.value.splice(index, 1)
  channels.value.splice(target, 0, channel)
}

async function save() {
  if (busy.value || status.value !== 'success') return
  busy.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const body = { channels: channels.value.map(({ name, type, content }) => ({ name, type, content })) }
    const saved = await api.request<StorefrontSupportSettings>(endpoint, { method: 'PUT', body })
    channels.value = saved.channels.map(channel => ({ ...channel, id: nextId++ }))
    successMessage.value = '客服设置已保存。'
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError && error.code !== 'VALIDATION_ERROR'
      ? error.message
      : '无法保存，请检查渠道名称、内容和数量后重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="admin-storefront-support">
    <template #header>
      <UDashboardNavbar
        title="客服设置"
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
        class="mx-auto w-full max-w-4xl p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <p class="text-sm font-medium text-primary">
          店铺经营
        </p>
        <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
          客服设置
        </h1>
        <p class="mt-2 text-sm leading-6 text-muted">
          最多添加 {{ storefrontSupportLimits.channels }} 个客服渠道。保存后，顾客可按下方顺序查看这些公开联系方式。
        </p>

        <UAlert
          v-if="status === 'error'"
          class="mt-6"
          color="error"
          variant="soft"
          title="无法读取客服设置"
          role="alert"
        >
          <template #actions>
            <UButton
              color="error"
              variant="outline"
              class="min-h-11"
              @click="refresh()"
            >
              重试
            </UButton>
          </template>
        </UAlert>
        <p
          v-else-if="status !== 'success'"
          class="mt-6 text-sm text-muted"
          role="status"
        >
          正在读取客服设置…
        </p>
        <form
          v-else
          class="mt-6 grid gap-4"
          :aria-busy="busy"
          @submit.prevent="save"
        >
          <UAlert
            v-if="!channels.length"
            color="neutral"
            variant="soft"
            title="还没有客服渠道"
            description="添加渠道，或保存空列表以移除已公开的联系方式。"
          />
          <fieldset
            v-for="(channel, index) in channels"
            :key="channel.id"
            class="grid min-w-0 gap-4 rounded-xl border border-default bg-elevated p-4 sm:p-5"
            :disabled="busy"
          >
            <legend class="mb-4 font-medium text-highlighted">
              渠道 {{ index + 1 }}
            </legend>
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField
                label="渠道名称"
                required
              >
                <UInput
                  v-model="channel.name"
                  class="w-full"
                  placeholder="例如：售后邮箱"
                  :maxlength="storefrontSupportLimits.name"
                  required
                />
              </UFormField>
              <UFormField
                label="渠道类型"
                required
              >
                <USelect
                  v-model="channel.type"
                  :items="channelTypes"
                  class="w-full"
                  :disabled="busy"
                />
              </UFormField>
            </div>
            <UFormField
              :label="channel.type === 'https' ? 'HTTPS 地址' : '客服账号'"
              required
            >
              <UInput
                v-model="channel.content"
                :type="channel.type === 'https' ? 'url' : 'text'"
                class="w-full"
                :maxlength="storefrontSupportLimits[channel.type]"
                required
              />
            </UFormField>
            <div class="flex flex-wrap gap-2">
              <UButton
                type="button"
                color="neutral"
                variant="outline"
                icon="i-lucide-arrow-up"
                class="min-h-11"
                :aria-label="`上移渠道 ${index + 1}`"
                :disabled="index === 0"
                @click="moveChannel(index, -1)"
              >
                上移
              </UButton>
              <UButton
                type="button"
                color="neutral"
                variant="outline"
                icon="i-lucide-arrow-down"
                class="min-h-11"
                :aria-label="`下移渠道 ${index + 1}`"
                :disabled="index === channels.length - 1"
                @click="moveChannel(index, 1)"
              >
                下移
              </UButton>
              <UButton
                type="button"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                class="min-h-11"
                :aria-label="`移除渠道 ${index + 1}`"
                @click="channels.splice(index, 1)"
              >
                移除
              </UButton>
            </div>
          </fieldset>
          <div class="flex flex-wrap gap-3">
            <UButton
              type="submit"
              icon="i-lucide-save"
              class="min-h-11"
              :loading="busy"
            >
              保存设置
            </UButton>
            <UButton
              type="button"
              color="neutral"
              variant="outline"
              icon="i-lucide-plus"
              class="min-h-11"
              :disabled="busy || channels.length >= storefrontSupportLimits.channels"
              @click="addChannel"
            >
              添加渠道
            </UButton>
          </div>
          <UAlert
            v-if="errorMessage"
            color="error"
            variant="soft"
            :title="errorMessage"
            role="alert"
          />
          <UAlert
            v-if="successMessage"
            color="success"
            variant="soft"
            :title="successMessage"
            role="status"
          />
        </form>
      </main>
    </template>
  </UDashboardPanel>
</template>
