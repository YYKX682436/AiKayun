<script setup lang="ts">
import type { AdminWalletList, AdminWalletListItem } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '钱包与充值' })

const { request } = useAdminApi()
const rows = ref<AdminWalletListItem[]>([])
const total = ref(0)
const totalPages = ref(0)
const page = ref(1)
const pageSize = 20
const searchInput = ref('')
const search = ref('')
const loading = ref(true)
const errorMessage = ref('')
let sequence = 0

async function loadWallets() {
  if (!import.meta.client) return
  const requestSequence = ++sequence
  loading.value = true
  errorMessage.value = ''
  const query = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) })
  if (search.value) query.set('search', search.value)
  try {
    const result = await request<AdminWalletList>(`/api/v1/admin/wallets?${query}`)
    if (sequence !== requestSequence) return
    rows.value = result.items
    total.value = result.total
    totalPages.value = result.totalPages
  } catch (error) {
    if (sequence !== requestSequence) return
    errorMessage.value = error instanceof Error ? error.message : '钱包列表暂时无法加载。'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

function submitSearch() {
  page.value = 1
  search.value = searchInput.value.trim()
}

function accountStatus(status: AdminWalletListItem['status']) {
  return status === 'active' ? '正常' : status === 'disabled' ? '已禁用' : '已删除'
}

watch([page, search], () => { void loadWallets() }, { immediate: true })
onBeforeUnmount(() => { sequence++ })
</script>

<template>
  <UDashboardPanel id="admin-wallets">
    <template #header>
      <UDashboardNavbar title="钱包与充值">
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main
        id="admin-main"
        class="mx-auto w-full max-w-[90rem] min-w-0 p-4 sm:p-6 lg:p-8"
      >
        <header>
          <p class="text-sm font-medium text-primary">
            资金与账务
          </p>
          <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
            钱包与充值
          </h1>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-muted">
            只读查看顾客现金、赠送及冻结余额。所有余额只能由有来源的不可变账本流水产生。
          </p>
        </header>
        <UAlert
          v-if="errorMessage"
          class="mt-5"
          color="error"
          variant="soft"
          :title="errorMessage"
          role="alert"
        />
        <UCard class="mt-6">
          <form
            class="grid gap-3 sm:grid-cols-[minmax(16rem,1fr)_auto] sm:items-end"
            @submit.prevent="submitSearch"
          >
            <UFormField
              label="按顾客用户名搜索"
              name="walletSearch"
            >
              <UInput
                v-model="searchInput"
                class="w-full"
                icon="i-lucide-search"
                placeholder="输入用户名"
                autocomplete="off"
              />
            </UFormField>
            <UButton
              type="submit"
              icon="i-lucide-search"
              class="min-h-11"
            >
              搜索钱包
            </UButton>
          </form>
        </UCard>
        <div
          v-if="loading && rows.length === 0"
          class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          aria-busy="true"
          aria-label="正在读取顾客钱包"
        >
          <div
            v-for="item in 6"
            :key="item"
            class="h-40 animate-pulse rounded-xl border border-default bg-elevated motion-reduce:animate-none"
          />
        </div>
        <div
          v-else-if="rows.length"
          class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          role="list"
          aria-label="顾客钱包列表"
        >
          <UCard
            v-for="wallet in rows"
            :key="wallet.customerId"
            class="min-w-0"
            role="listitem"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h2 class="truncate font-semibold text-highlighted">
                  {{ wallet.username ?? '已删除顾客' }}
                </h2>
                <p class="mt-1 text-xs text-muted">
                  {{ accountStatus(wallet.status) }} · {{ wallet.customerId }}
                </p>
              </div>
              <UBadge
                color="neutral"
                variant="soft"
              >
                只读
              </UBadge>
            </div>
            <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt class="text-muted">
                  可用现金
                </dt><dd class="mt-0.5 font-medium tabular-nums text-highlighted">
                  ¥{{ wallet.cashAvailable }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  冻结现金
                </dt><dd class="mt-0.5 font-medium tabular-nums text-highlighted">
                  ¥{{ wallet.cashFrozen }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  可用赠送
                </dt><dd class="mt-0.5 font-medium tabular-nums text-highlighted">
                  ¥{{ wallet.giftAvailable }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  冻结赠送
                </dt><dd class="mt-0.5 font-medium tabular-nums text-highlighted">
                  ¥{{ wallet.giftFrozen }}
                </dd>
              </div>
            </dl>
            <div class="mt-4 flex items-center justify-between border-t border-default pt-3">
              <p class="text-sm text-muted">
                总可用 ¥{{ wallet.totalAvailable }}
              </p>
              <UButton
                :to="`/admin/wallets/${wallet.customerId}`"
                color="neutral"
                variant="outline"
                icon="i-lucide-arrow-up-right"
                class="min-h-11"
              >
                流水与充值
              </UButton>
            </div>
          </UCard>
        </div>
        <UCard
          v-else-if="!loading"
          class="mt-4"
        >
          <p class="text-sm text-muted">
            没有找到顾客钱包。
          </p>
        </UCard>
        <div
          v-if="totalPages > 1"
          class="mt-4 flex flex-wrap items-center justify-between gap-3"
        >
          <p class="text-sm text-muted">
            第 {{ page }} / {{ totalPages }} 页 · 共 {{ total }} 个钱包
          </p>
          <div class="flex gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="page <= 1 || loading"
              @click="page--"
            >
              上一页
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              :disabled="page >= totalPages || loading"
              @click="page++"
            >
              下一页
            </UButton>
          </div>
        </div>
      </main>
    </template>
  </UDashboardPanel>
</template>
