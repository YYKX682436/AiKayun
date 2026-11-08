<script setup lang="ts">
import type { ApiSuccess, StorefrontBrandSettings } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'
import { useSavedStoreBrand } from '~/composables/useStoreBrand'
import { createStorefrontThemeStyle, defaultStoreBrand, normalizeHex, resolveStoreBrand } from '~/utils/store-brand'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '店铺设置' })

const runtimeConfig = useRuntimeConfig()
const api = useAdminApi()
const savedStoreBrand = useSavedStoreBrand()
const { data: brandResponse, error: loadError, pending } = await useFetch<ApiSuccess<StorefrontBrandSettings>>(
  '/api/v1/admin/storefront/brand',
  { key: 'admin-storefront-brand' },
)

const deploymentBrand = resolveStoreBrand(runtimeConfig.public)
const currentBrand = brandResponse.value?.data.brand ?? deploymentBrand
const settings = reactive({ ...currentBrand })
const busy = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const pickerColor = computed({
  get: () => normalizeHex(settings.storeBrandColor) ?? defaultStoreBrand.storeBrandColor,
  set: (value: string) => { settings.storeBrandColor = value },
})
const previewStyle = computed(() => Object.fromEntries(
  createStorefrontThemeStyle(settings.storeBrandColor).split(';').filter(Boolean).map((declaration) => {
    const separator = declaration.indexOf(':')
    return [declaration.slice(0, separator), declaration.slice(separator + 1)]
  }),
))

async function saveSettings() {
  if (busy.value || pending.value || !brandResponse.value) return
  busy.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const saved = await api.request<StorefrontBrandSettings>('/api/v1/admin/storefront/brand', {
      method: 'PUT',
      body: { ...settings },
    })
    savedStoreBrand.value = saved.brand
    if (saved.brand) Object.assign(settings, saved.brand)
    successMessage.value = '店铺品牌已保存，商城刷新后会在所有设备上显示新设置。'
  } catch (error) {
    errorMessage.value = error instanceof AdminApiError ? error.message : '暂时无法保存设置，请稍后重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="admin-store-brand">
    <template #header>
      <UDashboardNavbar
        title="店铺设置"
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
            店铺设置
          </h1>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
            设置顾客看到的店名、Logo 和品牌主色。保存后配置写入本店数据库，前台刷新即可生效。
          </p>
        </div>

        <UAlert
          v-if="loadError"
          class="mt-6"
          color="error"
          variant="soft"
          title="无法读取店铺设置，请刷新页面重试。"
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
          <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.85fr)]">
            <UCard>
              <template #header>
                <div>
                  <h2 class="text-lg font-semibold text-highlighted">
                    品牌信息
                  </h2>
                  <p class="mt-1 text-sm leading-6 text-muted">
                    Logo 可填写站内绝对路径或 HTTPS 图片地址；留空时使用店名首字。
                  </p>
                </div>
              </template>
              <div class="grid gap-5">
                <UFormField
                  name="storeName"
                  label="店铺名称"
                  description="最多 80 个字符，不支持尖括号或控制字符。"
                  required
                >
                  <UInput
                    v-model="settings.storeName"
                    class="w-full"
                    autocomplete="organization"
                    maxlength="80"
                    placeholder="例如：青屿数字商店"
                    :disabled="busy || pending || !brandResponse"
                  />
                </UFormField>

                <UFormField
                  name="storeLogoUrl"
                  label="店铺 Logo 地址"
                  description="仅接受本站路径（如 /logo.svg）或 HTTPS URL。"
                >
                  <UInput
                    v-model="settings.storeLogoUrl"
                    class="w-full"
                    type="text"
                    inputmode="url"
                    maxlength="2048"
                    placeholder="/store-logo.svg 或 https://example.com/logo.png"
                    :disabled="busy || pending || !brandResponse"
                  />
                </UFormField>

                <UFormField
                  name="storeBrandColor"
                  label="品牌主色"
                  description="输入 #RGB 或 #RRGGBB，也可以使用颜色选择器。前台会自动生成适配明暗模式的色阶。"
                  required
                >
                  <div class="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3">
                    <input
                      v-model="pickerColor"
                      type="color"
                      aria-label="选择店铺品牌主色"
                      class="size-11 cursor-pointer rounded-lg border border-default bg-elevated p-1"
                      :disabled="busy || pending || !brandResponse"
                    >
                    <UInput
                      v-model="settings.storeBrandColor"
                      class="w-full"
                      aria-label="品牌主色 HEX 值"
                      maxlength="7"
                      placeholder="#2563EB"
                      spellcheck="false"
                      :disabled="busy || pending || !brandResponse"
                    />
                  </div>
                </UFormField>
              </div>
            </UCard>

            <UCard>
              <template #header>
                <div>
                  <h2 class="text-lg font-semibold text-highlighted">
                    实时预览
                  </h2>
                  <p class="mt-1 text-sm leading-6 text-muted">
                    预览展示店铺标识、名称与按钮主色，前台会按当前明暗模式生成对应色阶。
                  </p>
                </div>
              </template>
              <div
                class="grid gap-5 rounded-xl border border-default bg-default p-4 sm:p-5"
                :style="previewStyle"
              >
                <div class="flex min-w-0 items-center gap-3">
                  <BrandMark
                    :name="settings.storeName.trim() || '店铺名称'"
                    :logo-url="settings.storeLogoUrl"
                  />
                  <div class="min-w-0">
                    <p class="text-xs text-muted">
                      店铺首页
                    </p>
                    <p class="break-words font-semibold text-highlighted">
                      {{ settings.storeName.trim() || '店铺名称' }}
                    </p>
                  </div>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                  <UButton
                    color="primary"
                    icon="i-lucide-shopping-bag"
                    class="min-h-11"
                    tabindex="-1"
                  >
                    浏览商品
                  </UButton>
                  <span class="text-sm font-medium text-primary">品牌链接示例</span>
                </div>
              </div>
            </UCard>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <UButton
              type="submit"
              icon="i-lucide-save"
              :loading="busy"
              :disabled="pending || !!loadError || !brandResponse"
              class="min-h-11 min-w-32"
            >
              保存设置
            </UButton>
            <span
              v-if="pending"
              class="text-sm text-muted"
              role="status"
            >
              正在读取当前设置…
            </span>
          </div>
        </form>
      </main>
    </template>
  </UDashboardPanel>
</template>
