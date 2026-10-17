<script setup lang="ts">
import type { CreateProductBody, ProductDetail } from '@aikayun/contracts'

definePageMeta({ middleware: 'admin-auth', layout: 'admin' })
useSeoMeta({ title: '新建商品' })

const storageKey = 'aikayun-admin-product-create-v1'
const { request } = useAdminApi()
const route = useRoute()
const name = ref('')
const productType = ref<CreateProductBody['productType']>('digital')
const salePrice = ref('')
const idempotencyKey = ref('')
const busy = ref(false)
const requestUncertain = ref(false)
const requestSubmitted = ref(false)
const restoring = ref(true)
const productId = ref('')
const errorMessage = ref('')
const restored = ref(false)

const productTypeItems = [
  { label: '数字商品', value: 'digital' },
  { label: '实物商品', value: 'physical' },
  { label: '服务', value: 'service' },
]

onMounted(async () => {
  const raw = sessionStorage.getItem(storageKey)
  if (raw) {
    try {
      const saved = JSON.parse(raw) as Partial<{ name: string; productType: CreateProductBody['productType']; salePrice: string; idempotencyKey: string; productId: string; requestUncertain: boolean; requestSubmitted: boolean }>
      name.value = saved.name ?? ''
      productType.value = saved.productType ?? 'digital'
      salePrice.value = saved.salePrice ?? ''
      idempotencyKey.value = saved.idempotencyKey ?? crypto.randomUUID()
      productId.value = saved.productId ?? ''
      requestSubmitted.value = saved.requestSubmitted ?? saved.requestUncertain ?? false
      requestUncertain.value = saved.requestUncertain ?? requestSubmitted.value
      restored.value = Boolean(raw)
    } catch {
      sessionStorage.removeItem(storageKey)
    }
  }
  if (!idempotencyKey.value) idempotencyKey.value = crypto.randomUUID()
  await nextTick()
  restoring.value = false
  persist()
})

function persist() {
  if (!import.meta.client) return
  sessionStorage.setItem(storageKey, JSON.stringify({
    name: name.value,
    productType: productType.value,
    salePrice: salePrice.value,
    idempotencyKey: idempotencyKey.value,
    productId: productId.value,
    requestUncertain: requestUncertain.value,
    requestSubmitted: requestSubmitted.value,
  }))
}

watch([name, productType, salePrice, productId, requestUncertain], persist)

watch([name, productType, salePrice], () => {
  if (!restoring.value && !requestSubmitted.value && !busy.value && !productId.value) idempotencyKey.value = crypto.randomUUID()
})

async function openCreatedProduct() {
  if (!productId.value) return
  try {
    await navigateTo(`/admin/products/${productId.value}`)
    if (route.path === `/admin/products/${productId.value}`) sessionStorage.removeItem(storageKey)
  } catch {
    errorMessage.value = '商品已创建。页面跳转失败，请使用下方按钮继续编辑。'
  }
}

async function createProduct() {
  if (busy.value || productId.value) return
  busy.value = true
  errorMessage.value = ''
  requestSubmitted.value = true
  requestUncertain.value = true
  persist()
  const body: CreateProductBody = {
    name: name.value.trim(),
    productType: productType.value,
    defaultSku: { salePrice: salePrice.value.trim() },
  }
  try {
    const result = await request<ProductDetail>('/api/v1/admin/products', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey.value },
      body,
    })
    productId.value = result.id
    requestSubmitted.value = false
    persist()
    try {
      await navigateTo(`/admin/products/${result.id}`)
      if (route.path === `/admin/products/${result.id}`) sessionStorage.removeItem(storageKey)
    } catch {
      errorMessage.value = '商品已创建。页面跳转失败，请使用下方按钮继续编辑。'
    }
  } catch (error) {
    const status = Number((error as { status?: number })?.status ?? 0)
    requestUncertain.value = status === 0 || status >= 500
    requestSubmitted.value = requestUncertain.value
    if (!requestUncertain.value) idempotencyKey.value = crypto.randomUUID()
    errorMessage.value = error instanceof Error ? error.message : '创建商品失败。'
    persist()
  } finally {
    busy.value = false
  }
}

function startFresh() {
  if (!window.confirm('清除当前尚未创建的商品资料？')) return
  sessionStorage.removeItem(storageKey)
  name.value = ''
  productType.value = 'digital'
  salePrice.value = ''
  idempotencyKey.value = crypto.randomUUID()
  productId.value = ''
  requestUncertain.value = false
  requestSubmitted.value = false
  errorMessage.value = ''
  restored.value = false
  persist()
}
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar title="新建商品">
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <main class="mx-auto w-full max-w-3xl min-w-0 px-4 py-5 sm:px-6 lg:py-8">
        <nav
          aria-label="面包屑"
          class="mb-4 text-sm text-muted"
        >
          <NuxtLink
            to="/admin/products"
            class="rounded-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
          >
            商品管理
          </NuxtLink>
          <span
            aria-hidden="true"
            class="px-2"
          >/</span>
          <span class="text-highlighted">新建商品</span>
        </nav>
        <header class="mb-6">
          <p class="text-sm font-medium text-primary">
            草稿
          </p>
          <h1 class="mt-1 text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl">
            创建商品
          </h1>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
            先填写必要信息创建草稿，之后可在同一编辑页配置分类、图片、规格、价格和库存。
          </p>
        </header>

        <UAlert
          v-if="restored && !productId"
          class="mb-4"
          color="info"
          variant="soft"
          title="已恢复本次会话中未完成的商品资料。"
        />
        <UAlert
          v-if="productId"
          class="mb-4"
          color="success"
          variant="soft"
          title="商品已创建，草稿保存在后台。"
        >
          <template #actions>
            <UButton
              :to="`/admin/products/${productId}`"
              icon="i-lucide-arrow-right"
            >
              继续编辑商品
            </UButton>
          </template>
        </UAlert>
        <UAlert
          v-if="requestUncertain && !productId"
          class="mb-4"
          color="warning"
          variant="soft"
          title="创建结果暂时无法确认。"
        >
          <p class="mt-1 text-sm">
            请用相同内容重试。服务器会核验本次请求键，避免重复创建商品。
          </p>
        </UAlert>
        <UAlert
          v-if="errorMessage"
          class="mb-4"
          color="error"
          variant="soft"
          :title="errorMessage"
          role="alert"
        />

        <UCard class="border-default bg-elevated">
          <form
            class="grid gap-5"
            @submit.prevent="productId ? openCreatedProduct() : createProduct()"
          >
            <UFormField
              label="商品名称"
              name="name"
              required
              hint="最多 200 个字符"
            >
              <UInput
                v-model="name"
                class="w-full"
                size="lg"
                maxlength="200"
                placeholder="例如：年度会员服务"
                :disabled="restoring || busy || Boolean(productId) || requestUncertain"
                required
              />
            </UFormField>
            <UFormField
              label="商品性质"
              name="productType"
              required
            >
              <USelect
                v-model="productType"
                :items="productTypeItems"
                size="lg"
                class="w-full"
                :disabled="restoring || busy || Boolean(productId) || requestUncertain"
              />
              <template #description>
                <span>性质会影响后续库存配置限制。</span>
              </template>
            </UFormField>
            <UFormField
              label="默认 SKU 销售价（人民币）"
              name="salePrice"
              required
              hint="最多两位小数；金额按字符串提交。"
            >
              <UInput
                v-model="salePrice"
                class="w-full sm:max-w-xs"
                size="lg"
                inputmode="decimal"
                placeholder="例如：29.90"
                :disabled="restoring || busy || Boolean(productId) || requestUncertain"
                required
              />
            </UFormField>

            <div class="flex flex-col-reverse gap-3 border-t border-default pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex gap-2">
                <UButton
                  to="/admin/products"
                  color="neutral"
                  variant="outline"
                  size="lg"
                  :disabled="busy"
                >
                  取消
                </UButton>
                <UButton
                  v-if="requestUncertain && !productId"
                  type="button"
                  color="neutral"
                  variant="ghost"
                  size="lg"
                  @click="startFresh"
                >
                  放弃本次创建
                </UButton>
              </div>
              <UButton
                type="submit"
                size="lg"
                :loading="busy"
                :disabled="restoring || busy || (!productId && (!name.trim() || !salePrice.trim()))"
              >
                {{ productId ? '继续编辑商品' : requestUncertain ? '核验并重试创建' : '保存为草稿' }}
              </UButton>
            </div>
          </form>
        </UCard>
      </main>
    </template>
  </UDashboardPanel>
</template>
