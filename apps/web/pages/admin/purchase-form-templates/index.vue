<script setup lang="ts">
import type { PurchaseTemplateSummary } from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '购买填写模板 · 管理后台' })

type TemplatePage = { items: PurchaseTemplateSummary[]; total: number; page: number; pageSize: number }
const { request } = useAdminApi()
const items = ref<PurchaseTemplateSummary[]>([])
const page = ref(1)
const pageSize = 50
const total = ref(0)
const loading = ref(true)
const busy = ref(false)
const clientReady = ref(false)
const errorMessage = ref('')
const createError = ref('')
let generation = 0

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const dateLabel = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

async function load() {
  const current = ++generation
  loading.value = true
  errorMessage.value = ''
  try {
    const result = await request<TemplatePage>(`/api/v1/admin/purchase-form-templates?page=${page.value}&pageSize=${pageSize}`)
    if (generation !== current) return
    items.value = result.items
    total.value = result.total
  } catch (error) {
    if (generation !== current) return
    errorMessage.value = error instanceof Error ? error.message : '模板列表加载失败。'
  } finally {
    if (generation === current) loading.value = false
  }
}

async function createTemplate() {
  if (busy.value) return
  busy.value = true
  createError.value = ''
  try {
    const result = await request<{ template: PurchaseTemplateSummary; definition: { fields: [] } }>('/api/v1/admin/purchase-form-templates', {
      method: 'POST',
      body: { name: '新购买填写模板', definition: { fields: [] } },
    })
    await navigateTo(`/admin/purchase-form-templates/${result.template.id}`)
  } catch (error) {
    createError.value = error instanceof AdminApiError ? error.message : '暂时无法创建模板。'
  } finally { busy.value = false }
}

watch(page, () => { void load() })
onMounted(async () => {
  await load()
  clientReady.value = true
})
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <UDashboardPanel id="admin-purchase-form-templates">
    <template #header>
      <UDashboardNavbar
        title="购买填写模板"
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
        :data-purchase-templates-ready="clientReady ? 'true' : 'false'"
        class="mx-auto w-full max-w-6xl p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-sm font-medium text-primary">
              商品经营 / 准备配置
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              购买填写模板
            </h1>
            <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
              定义本地购买字段和不可变版本，明确控制商品填写规则何时应用于顾客购买。
            </p>
          </div>
          <UButton
            icon="i-lucide-plus"
            size="lg"
            :loading="busy"
            :disabled="busy || !clientReady"
            class="min-h-11"
            @click="createTemplate"
          >
            新建模板
          </UButton>
        </header>

        <AdminPurchaseFormsLifecyclePanel />
        <UAlert
          v-if="createError"
          class="mt-4"
          color="error"
          variant="soft"
          :title="createError"
          role="alert"
        />
        <UAlert
          v-if="errorMessage"
          class="mt-4"
          color="error"
          variant="soft"
          :title="errorMessage"
          role="alert"
        />

        <section
          aria-label="模板列表"
          class="mt-6"
        >
          <div
            v-if="loading"
            class="grid gap-3"
            aria-live="polite"
          >
            <USkeleton
              v-for="number in 4"
              :key="number"
              class="h-24 rounded-xl"
            />
          </div>
          <UEmpty
            v-else-if="!items.length"
            icon="i-lucide-list-checks"
            title="还没有本地填写模板"
            description="新建模板后，可先在后台编辑字段、预览交互并保存不可变版本。"
          />
          <div
            v-else
            class="grid gap-3"
          >
            <NuxtLink
              v-for="template in items"
              :key="template.id"
              :to="`/admin/purchase-form-templates/${template.id}`"
              class="group flex min-h-24 flex-col justify-between gap-3 rounded-xl border border-default bg-elevated p-4 transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:flex-row sm:items-center"
            >
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="truncate text-base font-semibold text-highlighted">
                    {{ template.name }}
                  </h2>
                  <UBadge
                    color="neutral"
                    variant="subtle"
                  >
                    准备配置
                  </UBadge>
                </div>
                <p class="mt-1 text-sm text-muted">
                  {{ template.fieldCount }} 个字段 · 修订 {{ template.revision }} · 已保存 {{ template.latestVersionNumber }} 个版本
                </p>
                <p class="mt-1 text-xs text-dimmed">
                  最近更新 {{ dateLabel(template.updatedAt) }}
                </p>
              </div>
              <span class="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary">编辑模板 <UIcon
                name="i-lucide-arrow-right"
                aria-hidden="true"
              /></span>
            </NuxtLink>
          </div>
          <div
            v-if="totalPages > 1"
            class="mt-5 flex items-center justify-between gap-3"
          >
            <p class="text-sm text-muted">
              共 {{ total }} 个模板 · 第 {{ page }} / {{ totalPages }} 页
            </p>
            <div class="flex gap-2">
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-chevron-left"
                aria-label="上一页"
                :disabled="page <= 1 || loading"
                @click="page--"
              />
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-chevron-right"
                aria-label="下一页"
                :disabled="page >= totalPages || loading"
                @click="page++"
              />
            </div>
          </div>
        </section>
      </main>
    </template>
  </UDashboardPanel>
</template>
