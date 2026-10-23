<script setup lang="ts">
import type { useAdminApi } from '~/composables/useAdminApi'
import type { SupplierAccountObservation, SupplierCatalogPage, SupplierCatalogProduct, SupplierConnection, SupplierPurchaseField } from '@aikayun/contracts'
const props = defineProps<{ connection: SupplierConnection; request: ReturnType<typeof useAdminApi>['request'] }>()
const request = props.request
const account = shallowRef<SupplierAccountObservation | null>(null)
const catalog = shallowRef<SupplierCatalogPage | null>(null)
const detail = shallowRef<SupplierCatalogProduct | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const keyWord = ref('')
const page = ref(1)
let generation = 0
const root = computed(() => `/api/v1/admin/supplier-connections/${props.connection.id}/catalog`)
const productStatus = (value: number) => ({ 1: '上游在售', 2: '上游暂停', 3: '上游禁售' }[value] ?? `未知状态 ${value}`)
const fieldType = (value: number | null) => value === null ? '未知类型' : ({ 0: '单行文本', 1: '图片', 13: '数字', 14: '单项选择', 15: '多行文本', 16: '级联选择' }[value] ?? `未知类型 ${value}`)
const fieldRequired = (field: SupplierPurchaseField) => field.required === null ? '必填性未知' : field.required ? '必填' : '选填'
const time = (value: string) => new Date(value).toLocaleString('zh-CN')
watch(() => props.connection.currentVersion.id, () => { generation++; account.value = null; catalog.value = null; detail.value = null; errorMessage.value = ''; page.value = 1; keyWord.value = ''; loading.value = false })
async function read(kind: 'account' | 'goods' | 'detail', goodsId?: string) {
  if (loading.value) return
  const current = ++generation
  const path = root.value
  loading.value = true
  errorMessage.value = ''
  try {
    if (kind === 'account') {
      account.value = null
      const result = await request<SupplierAccountObservation>(`${path}/account`, { method: 'POST' })
      if (current === generation) account.value = result
    } else if (kind === 'goods') {
      catalog.value = null
      detail.value = null
      const result = await request<SupplierCatalogPage>(`${path}/goods`, { method: 'POST', body: { page: page.value, keyWord: keyWord.value.trim() } })
      if (current === generation) catalog.value = result
    } else {
      detail.value = null
      const result = await request<SupplierCatalogProduct>(`${path}/goods/${goodsId}`, { method: 'POST' })
      if (current === generation) detail.value = result
    }
  } catch (error) {
    if (current === generation) errorMessage.value = error instanceof Error ? error.message : '上游读取失败，请重试。'
  } finally { if (current === generation) loading.value = false }
}
function turn(delta: number) { page.value = Math.min(100000, Math.max(1, page.value + delta)); void read('goods') }
</script>

<template>
  <section
    class="min-w-0 rounded-xl border border-default bg-elevated p-4 sm:p-5"
    aria-labelledby="supplier-catalog-title"
    data-supplier-catalog
  >
    <h2
      id="supplier-catalog-title"
      class="font-semibold text-highlighted"
    >
      上游账户与商品
    </h2>
    <UAlert
      class="mt-3"
      color="info"
      variant="soft"
      title="自动采购尚未开放"
      description="仅核对上游账户报价、供货观察和填写要求。只读成功不授予自动履约资格。"
    />
    <div class="mt-4 flex flex-wrap items-center gap-3">
      <UButton
        color="neutral"
        variant="outline"
        :loading="loading"
        @click="read('account')"
      >
        读取账户余额
      </UButton>
      <div
        v-if="account"
        class="text-sm tabular-nums"
      >
        <p>账户余额：{{ account.balance.amount }} <span class="text-muted">币种未声明</span></p>
        <p class="text-xs text-muted">
          最近读取：{{ time(account.source.readAt) }} · 配置 v{{ account.source.configurationVersionNumber }}
        </p>
      </div>
    </div>
    <form
      class="mt-5 flex min-w-0 flex-wrap items-end gap-3"
      @submit.prevent="page = 1; read('goods')"
    >
      <UFormField
        label="商品名称或编号"
        class="min-w-0 flex-1"
      >
        <UInput
          v-model="keyWord"
          class="w-full"
          maxlength="120"
          :disabled="loading"
        />
      </UFormField>
      <UButton
        type="submit"
        :loading="loading"
      >
        读取商品列表
      </UButton>
    </form>
    <UAlert
      v-if="errorMessage"
      class="mt-4"
      color="error"
      variant="soft"
      :title="errorMessage"
      description="可重新点击对应读取按钮重试。"
      role="alert"
    />
    <div
      v-if="catalog"
      class="mt-4 space-y-3"
    >
      <p class="text-xs leading-5 text-muted">
        最近读取：{{ time(catalog.source.readAt) }} · 配置 v{{ catalog.source.configurationVersionNumber }} · 第 {{ catalog.requestedPage }} 页
      </p>
      <p class="text-xs leading-5 text-muted">
        上游分页原值 allCount={{ catalog.upstreamPagination.allCount ?? '未提供' }} / allPage={{ catalog.upstreamPagination.allPage ?? '未提供' }}。文档字段描述与示例不一致，暂不推算总页数。
      </p>
      <ul
        class="space-y-2"
        aria-label="上游商品列表"
      >
        <li
          v-for="item in catalog.items"
          :key="item.upstreamProductId"
          class="min-w-0 rounded-lg border border-default bg-default p-3"
        >
          <div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <UButton
              variant="link"
              color="neutral"
              class="min-w-0 max-w-full whitespace-normal p-0 text-left"
              :disabled="loading"
              @click="read('detail', item.upstreamProductId)"
            >
              {{ item.name }}
            </UButton>
            <UBadge
              color="neutral"
              variant="soft"
            >
              {{ productStatus(item.status) }}
            </UBadge>
          </div>
          <p class="mt-2 break-words text-sm tabular-nums">
            编号 {{ item.upstreamProductId }} · 参考报价 {{ item.quote.amount ?? '未知' }} · {{ item.stock.reportedCount === null ? '库存未知' : `上游报告库存 ${item.stock.reportedCount}` }}
          </p>
        </li>
      </ul>
      <UEmpty
        v-if="!catalog.items.length"
        title="此页没有商品"
        description="请更换关键词或返回上一页。"
      />
      <div class="flex flex-wrap gap-2">
        <UButton
          color="neutral"
          variant="outline"
          :disabled="loading || page <= 1"
          @click="turn(-1)"
        >
          上一页
        </UButton>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="loading || page >= 100000 || !catalog.items.length"
          @click="turn(1)"
        >
          下一页
        </UButton>
      </div>
    </div>
    <article
      v-if="detail"
      class="mt-5 min-w-0 space-y-4 border-t border-default pt-5"
      aria-label="上游商品详情"
    >
      <div>
        <h3 class="break-words font-semibold text-highlighted">
          {{ detail.name }}
        </h3>
        <p class="mt-1 text-xs text-muted">
          商品 {{ detail.upstreamProductId }} · 类型 {{ detail.goodsType === 1 ? '卡券' : detail.goodsType === 3 ? '直充' : `未知 ${detail.goodsType}` }} · {{ productStatus(detail.status) }}
        </p>
        <p class="mt-1 text-xs text-muted">
          最近读取：{{ time(detail.source.readAt) }} · 配置 v{{ detail.source.configurationVersionNumber }}
        </p>
      </div>
      <dl class="grid gap-3 rounded-lg bg-default p-3 text-sm sm:grid-cols-2">
        <div>
          <dt class="text-muted">
            账户参考报价（币种未声明）
          </dt><dd class="mt-1 tabular-nums">
            {{ detail.quote.amount ?? '未知' }} · 实际扣费未验证
          </dd>
        </div>
        <div>
          <dt class="text-muted">
            上游报告库存
          </dt><dd class="mt-1 tabular-nums">
            {{ detail.stock.reportedCount ?? '未知' }}
          </dd>
        </div>
        <div>
          <dt class="text-muted">
            数量规则原值
          </dt><dd class="mt-1">
            最小 {{ detail.quantityRules.minQuantity ?? '未知' }} / 最大 {{ detail.quantityRules.maxQuantity ?? '未知' }} / multiple {{ detail.quantityRules.multiple ?? '未知' }}
          </dd>
        </div>
        <div>
          <dt class="text-muted">
            上游售后能力声明
          </dt><dd class="mt-1">
            退单 {{ detail.capabilities.refundOrder === null ? '未知' : detail.capabilities.refundOrder ? '允许' : '不允许' }} / 退款 {{ detail.capabilities.refundMoney === null ? '未知' : detail.capabilities.refundMoney ? '允许' : '不允许' }}
          </dd>
        </div>
      </dl>
      <div v-if="detail.specificationGroups.length">
        <h4 class="font-medium">
          规格分组
        </h4>
        <p
          v-for="(group, index) in detail.specificationGroups"
          :key="index"
          class="mt-2 break-words text-sm"
        >
          {{ group.name }}：{{ group.values.join('、') }}
        </p>
      </div>
      <div>
        <h4 class="font-medium">
          规格与供货观察
        </h4>
        <ul
          v-if="detail.variants.length"
          class="mt-2 space-y-2"
        >
          <li
            v-for="variant in detail.variants"
            :key="variant.upstreamSku"
            class="break-words rounded-lg border border-default p-3 text-sm"
          >
            <p>{{ variant.combination.map(part => `${part.title}：${part.value}`).join(' / ') }}</p>
            <p class="mt-1 text-muted">
              规格编码 {{ variant.upstreamSku }} · 报价 {{ variant.quote.amount ?? '未知' }} · 库存 {{ variant.stock.reportedCount ?? '未知' }} · {{ variant.status === 1 ? '上游已上架' : variant.status === 0 ? '上游已下架' : '规格状态未知' }}
            </p>
          </li>
        </ul>
        <p
          v-else
          class="mt-2 text-sm text-muted"
        >
          {{ detail.skuType === 0 ? '上游声明单规格，未报告独立规格编码。' : '未报告规格明细。' }}
        </p>
      </div>
      <div>
        <h4 class="font-medium">
          购买填写要求
        </h4>
        <p class="mt-1 text-xs leading-5 text-muted">
          仅查看模板；不填写或提交。正则仅作说明，图片与级联选择的实际提交编码待验证。
        </p>
        <p
          v-if="detail.purchaseFields === null"
          class="mt-2 text-sm text-muted"
        >
          上游未提供填写规则。
        </p>
        <p
          v-else-if="!detail.purchaseFields.length"
          class="mt-2 text-sm text-muted"
        >
          上游返回空模板。
        </p>
        <ol
          v-else
          class="mt-2 space-y-3"
        >
          <li
            v-for="(field, index) in detail.purchaseFields"
            :key="index"
            class="min-w-0 rounded-lg border border-default p-3 text-sm"
          >
            <p class="font-medium">
              {{ index + 1 }}. {{ field.title ?? '标题未提供' }} · {{ fieldType(field.type) }} · {{ fieldRequired(field) }}
            </p>
            <p
              v-if="field.placeholder"
              class="mt-1 break-words text-muted"
            >
              提示：{{ field.placeholder }}
            </p>
            <p
              v-if="field.regex"
              class="mt-1 break-words text-muted"
            >
              校验说明（不执行）：{{ field.regex }}
            </p>
            <AdminSupplierPurchaseOptions
              v-if="field.options.length"
              :options="field.options"
              class="mt-2"
            />
          </li>
        </ol>
      </div>
      <div
        v-for="(content, index) in [detail.description, detail.detail, detail.buyNotice]"
        :key="index"
      >
        <template v-if="content">
          <h4 class="font-medium">
            {{ ['商品简介', '商品详情原文', '购买提醒'][index] }}
          </h4><p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted">
            {{ content }}
          </p>
        </template>
      </div>
      <a
        v-if="detail.imageUrl"
        :href="detail.imageUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-primary underline"
      >查看上游图片</a>
      <ul class="space-y-1 text-xs leading-5 text-muted">
        <li
          v-for="warning in detail.warnings"
          :key="warning"
        >
          {{ warning }}
        </li>
      </ul>
    </article>
  </section>
</template>
