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
  { label: '数字商品', value: 'digital', description: '虚拟卡密、软件许可、数字资源，支持自动发货', icon: 'i-lucide-key-round' },
  { label: '实物商品', value: 'physical', description: '实体快递货物，支持实物库存扣减与物流履约', icon: 'i-lucide-package' },
  { label: '服务', value: 'service', description: '在线咨询、人工履约、定制服务，无需物流卡密', icon: 'i-lucide-headset' },
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
    errorMessage.value = '商品已创建成功。页面自动跳转失败，请点击下方按钮进入编辑。'
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
      errorMessage.value = '商品已创建成功。页面自动跳转失败，请点击下方按钮进入编辑。'
    }
  } catch (error) {
    const status = Number((error as { status?: number })?.status ?? 0)
    requestUncertain.value = status === 0 || status >= 500
    requestSubmitted.value = requestUncertain.value
    if (!requestUncertain.value) idempotencyKey.value = crypto.randomUUID()
    errorMessage.value = error instanceof Error ? error.message : '创建商品失败，请稍后重试。'
    persist()
  } finally {
    busy.value = false
  }
}

const productTypeButtons = ref<Record<string, HTMLButtonElement | null>>({})

function selectProductTypeByIndex(index: number) {
  if (restoring.value || busy.value || Boolean(productId.value) || requestUncertain.value) return
  const target = productTypeItems[index]
  if (!target) return
  productType.value = target.value as ProductDetail['productType']
  void nextTick(() => {
    productTypeButtons.value[target.value]?.focus()
  })
}

function selectNextProductType(direction: number) {
  if (restoring.value || busy.value || Boolean(productId.value) || requestUncertain.value) return
  const currentIndex = productTypeItems.findIndex(item => item.value === productType.value)
  const nextIndex = (currentIndex + direction + productTypeItems.length) % productTypeItems.length
  selectProductTypeByIndex(nextIndex)
}

function startFresh() {
  if (!window.confirm('确认放弃当前未保存的草稿并重新填写？')) return
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
      <main class="mx-auto w-full max-w-3xl min-w-0 px-4 py-6 sm:px-6 lg:py-8 space-y-6">
        <!-- 面包屑导航 -->
        <nav
          aria-label="面包屑"
          class="flex items-center gap-2 text-xs sm:text-sm text-muted"
        >
          <NuxtLink
            to="/admin/products"
            class="flex items-center gap-1 hover:text-primary transition-colors focus-visible:outline-2 focus-visible:outline-primary rounded-sm"
          >
            <UIcon
              name="i-lucide-arrow-left"
              class="size-3.5"
            />
            <span>商品管理</span>
          </NuxtLink>
          <span
            aria-hidden="true"
            class="text-dimmed"
          >/</span>
          <span class="text-highlighted font-medium">新建商品草稿</span>
        </nav>

        <!-- 页面标题与步骤指引 -->
        <header class="space-y-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="flex items-center gap-2">
                <UBadge
                  color="info"
                  variant="subtle"
                  size="sm"
                  class="font-medium"
                >
                  草稿第一步
                </UBadge>
                <span class="text-xs text-muted">先建基础，后配详情</span>
              </div>
              <h1 class="mt-2 text-2xl font-bold tracking-tight text-highlighted sm:text-3xl">
                创建新商品
              </h1>
              <p class="mt-1.5 text-xs sm:text-sm text-muted leading-relaxed max-w-xl">
                填写商品名称、商品性质与初始售价快速建立草稿。创建后会自动进入编辑页，配置分类、图片、多规格、库存和自动发货规则。
              </p>
            </div>
            <div class="hidden sm:grid size-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
              <UIcon
                name="i-lucide-sparkles"
                class="size-6"
              />
            </div>
          </div>

          <!-- 3步流程导航条 (商业 SaaS 引导体验) -->
          <div class="grid grid-cols-3 gap-2 rounded-xl bg-muted/15 p-2 text-xs">
            <div class="flex items-center gap-2 rounded-lg bg-elevated px-3 py-2 text-primary shadow-2xs font-medium border border-primary/20">
              <span class="grid size-5 place-items-center rounded-full bg-primary text-white text-[11px] font-bold">1</span>
              <span class="truncate">基本信息</span>
            </div>
            <div class="flex items-center gap-2 px-3 py-2 text-muted">
              <span class="grid size-5 place-items-center rounded-full bg-muted/30 text-dimmed text-[11px] font-bold">2</span>
              <span class="truncate">规格与定价</span>
            </div>
            <div class="flex items-center gap-2 px-3 py-2 text-muted">
              <span class="grid size-5 place-items-center rounded-full bg-muted/30 text-dimmed text-[11px] font-bold">3</span>
              <span class="truncate">库存与发布</span>
            </div>
          </div>
        </header>

        <!-- 状态提醒 -->
        <UAlert
          v-if="restored && !productId"
          color="info"
          variant="soft"
          icon="i-lucide-history"
          title="已自动恢复你上次未完成填写的商品资料"
          :close="true"
          @close="restored = false"
        >
          <template #actions>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              @click="startFresh"
            >
              重新填写
            </UButton>
          </template>
        </UAlert>

        <!-- 创建成功提示与继续编辑入口 -->
        <UAlert
          v-if="productId"
          color="success"
          variant="soft"
          icon="i-lucide-check-circle-2"
          title="商品草稿创建成功！"
          description="草稿已安全保存在后台，你可以随时继续完善配置并发布上架。"
        >
          <template #actions>
            <div class="flex items-center gap-2">
              <UButton
                :to="`/admin/products/${productId}`"
                color="success"
                icon="i-lucide-arrow-right"
                class="font-medium"
              >
                继续编辑商品
              </UButton>
            </div>
          </template>
        </UAlert>

        <UAlert
          v-if="requestUncertain && !productId"
          color="warning"
          variant="soft"
          icon="i-lucide-alert-triangle"
          title="创建请求结果暂时无法确认"
          description="网络响应超时或波动，请点击下方重试。系统具备幂等校验保护，不会产生重复商品。"
        >
          <template #actions>
            <UButton
              size="xs"
              color="warning"
              variant="outline"
              @click="startFresh"
            >
              放弃本次并重开
            </UButton>
          </template>
        </UAlert>

        <UAlert
          v-if="errorMessage"
          color="error"
          variant="soft"
          icon="i-lucide-alert-circle"
          :title="errorMessage"
          role="alert"
        />

        <!-- 主表单卡片 -->
        <UCard class="border-default bg-elevated shadow-xs rounded-2xl">
          <form
            class="space-y-6"
            @submit.prevent="productId ? openCreatedProduct() : createProduct()"
          >
            <!-- 商品名称 -->
            <UFormField
              label="商品名称"
              name="name"
              required
              hint="最多 200 个字"
              help="输入吸引顾客且表达清晰的商品标题，后续可随时修改。"
            >
              <UInput
                v-model="name"
                class="w-full"
                size="lg"
                maxlength="200"
                placeholder="例如：ChatGPT Plus 独享包月账号"
                :disabled="restoring || busy || Boolean(productId) || requestUncertain"
                required
              />
            </UFormField>

            <!-- 商品性质（直观卡片选择） -->
            <UFormField
              label="商品性质"
              name="productType"
              required
              help="商品性质决定了后续的库存交付模式（如卡密自动发货、文件下载或物流发货）。"
            >
              <div
                role="radiogroup"
                aria-label="商品性质"
                class="grid grid-cols-1 sm:grid-cols-3 gap-3"
              >
                <button
                  v-for="item in productTypeItems"
                  :key="item.value"
                  :ref="(el) => { if (el) productTypeButtons[item.value] = el as HTMLButtonElement }"
                  type="button"
                  role="radio"
                  :aria-checked="productType === item.value"
                  :tabindex="productType === item.value ? 0 : -1"
                  :aria-label="`${item.label}：${item.description}`"
                  class="flex flex-col text-left p-3.5 rounded-xl border transition-all text-xs cursor-pointer focus-visible:outline-2 focus-visible:outline-primary"
                  :class="productType === item.value
                    ? 'border-primary bg-primary/5 ring-1 ring-primary shadow-2xs'
                    : 'border-default bg-elevated hover:bg-muted/10 opacity-80'"
                  :disabled="restoring || busy || Boolean(productId) || requestUncertain"
                  @click="productType = item.value as any"
                  @keydown.space.prevent="productType = item.value as any"
                  @keydown.enter.prevent="productType = item.value as any"
                  @keydown.arrow-right.prevent="selectNextProductType(1)"
                  @keydown.arrow-down.prevent="selectNextProductType(1)"
                  @keydown.arrow-left.prevent="selectNextProductType(-1)"
                  @keydown.arrow-up.prevent="selectNextProductType(-1)"
                  @keydown.home.prevent="selectProductTypeByIndex(0)"
                  @keydown.end.prevent="selectProductTypeByIndex(productTypeItems.length - 1)"
                >
                  <div class="flex items-center justify-between w-full mb-1.5">
                    <div class="flex items-center gap-2">
                      <UIcon
                        :name="item.icon"
                        class="size-4"
                        :class="productType === item.value ? 'text-primary' : 'text-muted'"
                      />
                      <span
                        class="font-semibold text-sm"
                        :class="productType === item.value ? 'text-primary' : 'text-highlighted'"
                      >
                        {{ item.label }}
                      </span>
                    </div>
                    <UIcon
                      :name="productType === item.value ? 'i-lucide-check-circle-2' : 'i-lucide-circle'"
                      class="size-4"
                      :class="productType === item.value ? 'text-primary' : 'text-dimmed'"
                    />
                  </div>
                  <p class="text-xs text-muted leading-relaxed">
                    {{ item.description }}
                  </p>
                </button>
              </div>
            </UFormField>

            <!-- 初始售价 -->
            <UFormField
              label="初始售价"
              name="salePrice"
              required
              hint="元（保留最多两位小数）"
              help="创建商品的初始销售价格。如需设置多规格不同价格，创建后可在编辑页分别指定。"
            >
              <div class="relative w-full sm:max-w-xs">
                <UInput
                  v-model="salePrice"
                  class="w-full pl-6"
                  size="lg"
                  inputmode="decimal"
                  placeholder="29.90"
                  aria-label="初始售价"
                  :disabled="restoring || busy || Boolean(productId) || requestUncertain"
                  required
                >
                  <template #leading>
                    <span class="text-sm font-semibold text-muted">¥</span>
                  </template>
                </UInput>
              </div>
            </UFormField>

            <!-- 底部操作按钮 -->
            <div class="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-default pt-5">
              <div class="flex items-center gap-2">
                <UButton
                  to="/admin/products"
                  color="neutral"
                  variant="outline"
                  size="lg"
                  :disabled="busy"
                >
                  返回列表
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

              <div class="flex items-center gap-2">
                <UButton
                  type="submit"
                  size="lg"
                  color="primary"
                  class="font-medium min-w-32 justify-center shadow-xs"
                  :loading="busy"
                  :disabled="restoring || busy || (!productId && (!name.trim() || !salePrice.trim()))"
                >
                  {{ productId ? '继续编辑商品' : requestUncertain ? '核验并重试创建' : '保存为草稿' }}
                </UButton>
              </div>
            </div>
          </form>
        </UCard>
      </main>
    </template>
  </UDashboardPanel>
</template>
