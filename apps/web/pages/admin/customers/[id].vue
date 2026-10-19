<script setup lang="ts">
import type {
  AdminCustomerAuditPage,
  AdminCustomerDetail,
  AdminCustomerOrderPage,
  AdminCustomerProfileUpdateBody,
  AdminCustomerAuditEvent,
} from '@aikayun/contracts'
import { AdminApiError, useAdminApi } from '~/composables/useAdminApi'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '顾客详情' })

const route = useRoute()
const router = useRouter()
const { request } = useAdminApi()
const id = computed(() => String(route.params.id))
const orderPage = computed(() => Math.max(1, Math.min(100_000, Number(route.query.orderPage) || 1)))
const customer = ref<AdminCustomerDetail['customer'] | null>(null)
const orders = ref<AdminCustomerOrderPage | null>(null)
const auditEvents = ref<AdminCustomerAuditEvent[]>([])
const loading = ref(true)
const ordersLoading = ref(false)
const savingProfile = ref(false)
const actionBusy = ref(false)
const errorMessage = ref('')
const actionError = ref('')
const successMessage = ref('')
const profileForm = reactive({ username: '', email: '', phone: '' })
const statusModalOpen = ref(false)
const desiredStatus = ref<'active' | 'disabled' | null>(null)
const passwordModalOpen = ref(false)
const temporaryPassword = ref('')
const deleteModalOpen = ref(false)
const deleteAcknowledged = ref(false)
const deleteConfirmation = ref('')

const isDeleted = computed(() => customer.value?.status === 'deleted')
const canMutate = computed(() => customer.value !== null && !isDeleted.value)
const statusLabel = computed(() => customer.value?.status === 'active'
  ? '正常' : customer.value?.status === 'disabled' ? '已禁用' : customer.value?.status === 'deleted' ? '已删除' : '读取中')
const statusColor = computed(() => customer.value?.status === 'active'
  ? 'success' : customer.value?.status === 'disabled' ? 'warning' : 'neutral')
const canDelete = computed(() => !!customer.value?.username
  && deleteAcknowledged.value
  && deleteConfirmation.value.trim() === customer.value.username)
const canResetPassword = computed(() => temporaryPassword.value.length >= 12 && temporaryPassword.value.length <= 128)

watch(customer, (value) => {
  if (!value) return
  profileForm.username = value.username ?? ''
  profileForm.email = value.email ?? ''
  profileForm.phone = value.phone ?? ''
}, { immediate: true })

function pageQuery(page: number) {
  const next = { ...route.query }
  if (page <= 1) delete next.orderPage
  else next.orderPage = String(page)
  void router.replace({ query: next })
}

async function loadOrders() {
  if (!import.meta.client) return
  ordersLoading.value = true
  try {
    orders.value = await request<AdminCustomerOrderPage>(
      `/api/v1/admin/customers/${id.value}/orders?page=${orderPage.value}&pageSize=10`,
    )
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '歷史訂單暫時無法載入。'
  } finally {
    ordersLoading.value = false
  }
}

async function loadCustomer() {
  if (!import.meta.client) return
  loading.value = true
  errorMessage.value = ''
  const params = new URLSearchParams({ page: '1', pageSize: '20' })
  try {
    const [detail, audit] = await Promise.all([
      request<AdminCustomerDetail>(`/api/v1/admin/customers/${id.value}`),
      request<AdminCustomerAuditPage>(`/api/v1/admin/customers/${id.value}/audit?${params.toString()}`),
    ])
    customer.value = detail.customer
    auditEvents.value = audit.items
    await loadOrders()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '顧客资料暂时无法加载。'
  } finally {
    loading.value = false
  }
}

onMounted(() => { void loadCustomer() })
watch(orderPage, () => { void loadOrders() })
watch(id, () => { void loadCustomer() })

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value))
}

function verificationLabel(value: string | null) {
  return value ? `已验证 · ${formatDate(value)}` : '未验证'
}

function orderStatusLabel(value: AdminCustomerOrderPage['items'][number]['customerStatus']) {
  const labels: Record<typeof value, string> = {
    refunded: '已退款',
    closed: '已关闭',
    completed: '已完成',
    pending_payment: '待付款',
    awaiting_fulfillment: '待履约',
    in_progress: '处理中',
  }
  return labels[value]
}

function auditActionLabel(event: AdminCustomerAuditEvent) {
  const labels: Record<AdminCustomerAuditEvent['action'], string> = {
    username_updated: '修改用户名',
    contact_updated: '修改联系方式',
    password_reset: '重置密码',
    disabled: '禁用账户',
    restored: '恢复账户',
    deleted: '删除并匿名化账户',
  }
  return labels[event.action]
}

function auditSummary(event: AdminCustomerAuditEvent) {
  if (event.action === 'username_updated') return '管理员修改了用户名。'
  if (event.action === 'contact_updated') {
    const fields = event.summary.changedFields?.map(field => field === 'email' ? '邮箱' : field === 'phone' ? '手机号' : field) ?? []
    return fields.length ? `变更了${fields.join('、')}；新联系方式未自动验证。` : '管理员修改了联系方式。'
  }
  if (event.action === 'password_reset') return `撤销了 ${event.summary.revokedSessionCount ?? 0} 个旧会话。`
  if (event.action === 'disabled') return `账户已禁用，并撤销 ${event.summary.revokedSessionCount ?? 0} 个旧会话。`
  if (event.action === 'restored') return '账户已恢复登录；先前会话仍然无效。'
  return '清除了身份资料，保留顾客 UUID 与交易关联。'
}

async function saveProfile() {
  if (!customer.value || !canMutate.value || savingProfile.value) return
  savingProfile.value = true
  actionError.value = ''
  successMessage.value = ''
  const body: AdminCustomerProfileUpdateBody = {}
  const username = profileForm.username.trim()
  const email = profileForm.email.trim() || null
  const phone = profileForm.phone.trim() || null
  if (username !== customer.value.username) body.username = username
  if (email !== customer.value.email) body.email = email
  if (phone !== customer.value.phone) body.phone = phone
  if (Object.keys(body).length === 0) {
    successMessage.value = '资料没有变化。'
    savingProfile.value = false
    return
  }
  try {
    const result = await request<AdminCustomerDetail>(`/api/v1/admin/customers/${id.value}/profile`, {
      method: 'PATCH',
      body,
    })
    customer.value = result.customer
    await loadCustomer()
    successMessage.value = '顾客资料已保存；有变化的联系方式保持未验证状态。'
  } catch (error) {
    actionError.value = error instanceof AdminApiError ? error.message : '顾客资料保存失败，请稍后重试。'
  } finally {
    savingProfile.value = false
  }
}

async function confirmStatusChange() {
  if (!desiredStatus.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  successMessage.value = ''
  try {
    await request(`/api/v1/admin/customers/${id.value}/status`, {
      method: 'PATCH',
      body: { status: desiredStatus.value },
    })
    successMessage.value = desiredStatus.value === 'disabled'
      ? '账户已禁用，所有旧会话已撤销；订单、余额和已购权益均予保留。'
      : '账户已恢复登录；此前撤销的会话不会恢复。'
    statusModalOpen.value = false
    desiredStatus.value = null
    await loadCustomer()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '账户状态修改失败。'
  } finally {
    actionBusy.value = false
  }
}

async function confirmPasswordReset() {
  if (!canResetPassword.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  successMessage.value = ''
  try {
    const result = await request<{ passwordReset: true; revokedSessionCount: number }>(
      `/api/v1/admin/customers/${id.value}/password-reset`,
      { method: 'PUT', body: { temporaryPassword: temporaryPassword.value } },
    )
    temporaryPassword.value = ''
    passwordModalOpen.value = false
    successMessage.value = `临时密码已设置，撤销了 ${result.revokedSessionCount} 个旧会话。顾客需使用新密码重新登录。`
    await loadCustomer()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '密码重置失败。'
  } finally {
    actionBusy.value = false
  }
}

async function confirmDelete() {
  if (!canDelete.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    await request(`/api/v1/admin/customers/${id.value}`, { method: 'DELETE' })
    await router.replace({ path: '/admin/customers', query: { notice: 'deleted' } })
  } catch (error) {
    actionError.value = error instanceof AdminApiError ? error.message : '账户不能安全删除，请检查未结交易义务。'
    deleteModalOpen.value = false
  } finally {
    actionBusy.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="admin-main">
    <template #header>
      <UDashboardNavbar
        title="顾客详情"
        :toggle="{ size: 'md', class: 'min-h-11 min-w-11' }"
      >
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <main class="mx-auto grid w-full max-w-[90rem] min-w-0 gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <UButton
            to="/admin/customers"
            color="neutral"
            variant="ghost"
            leading-icon="i-lucide-arrow-left"
          >
            返回顾客列表
          </UButton>
          <UBadge
            v-if="customer"
            :color="statusColor"
            variant="subtle"
            size="lg"
          >
            {{ statusLabel }}
          </UBadge>
        </div>

        <UAlert
          v-if="errorMessage"
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
              size="sm"
              @click="loadCustomer"
            >
              重试
            </UButton>
          </template>
        </UAlert>
        <UAlert
          v-if="actionError"
          color="error"
          variant="soft"
          :title="actionError"
          role="alert"
          aria-live="assertive"
        />
        <UAlert
          v-if="successMessage"
          color="success"
          variant="soft"
          :title="successMessage"
          role="status"
          aria-live="polite"
        />

        <div
          v-if="loading"
          class="grid gap-4"
          aria-label="正在加载顾客详情"
          aria-busy="true"
        >
          <div class="h-48 animate-pulse rounded-xl bg-elevated" />
          <div class="h-64 animate-pulse rounded-xl bg-elevated" />
        </div>

        <template v-else-if="customer">
          <UCard :ui="{ body: 'p-4 sm:p-6' }">
            <div class="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <p class="text-sm font-medium text-primary">
                  顾客账户
                </p>
                <h1 class="mt-1 break-all text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl">
                  {{ customer.username ?? '已删除顾客' }}
                </h1>
                <p class="mt-2 break-all text-xs text-muted">
                  顾客 UUID：{{ customer.id }}
                </p>
              </div>
              <div
                v-if="canMutate"
                class="flex flex-wrap gap-2"
              >
                <UButton
                  color="neutral"
                  variant="outline"
                  @click="passwordModalOpen = true"
                >
                  重置密码
                </UButton>
                <UButton
                  v-if="customer.status === 'active'"
                  color="warning"
                  variant="soft"
                  @click="desiredStatus = 'disabled'; statusModalOpen = true"
                >
                  禁用账户
                </UButton>
                <UButton
                  v-else
                  color="success"
                  variant="soft"
                  @click="desiredStatus = 'active'; statusModalOpen = true"
                >
                  恢复账户
                </UButton>
                <UButton
                  color="error"
                  variant="outline"
                  @click="deleteModalOpen = true"
                >
                  删除顾客
                </UButton>
              </div>
              <p
                v-else
                class="max-w-md text-sm leading-6 text-muted"
              >
                身份已匿名化，无法恢复或修改。交易历史和必要审计仍以此 UUID 关联。
              </p>
            </div>

            <USeparator class="my-5" />

            <UForm
              class="grid min-w-0 gap-4 sm:grid-cols-2"
              :state="profileForm"
              @submit="saveProfile"
            >
              <UFormField
                label="用户名"
                name="username"
                description="3–32 位；以字母或数字开头，可使用字母、数字、下划线、点和连字符。"
              >
                <UInput
                  v-model="profileForm.username"
                  class="w-full"
                  autocomplete="username"
                  minlength="3"
                  maxlength="32"
                  pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,31}"
                  required
                  :disabled="!canMutate || savingProfile"
                  aria-label="用户名"
                />
              </UFormField>
              <UFormField
                label="邮箱"
                name="email"
                :description="`验证状态：${verificationLabel(customer.emailVerifiedAt)}`"
              >
                <UInput
                  v-model="profileForm.email"
                  class="w-full"
                  type="email"
                  autocomplete="email"
                  maxlength="254"
                  :disabled="!canMutate || savingProfile"
                  aria-label="邮箱"
                />
              </UFormField>
              <UFormField
                label="手机号"
                name="phone"
                :description="`验证状态：${verificationLabel(customer.phoneVerifiedAt)}`"
              >
                <UInput
                  v-model="profileForm.phone"
                  class="w-full"
                  type="tel"
                  autocomplete="tel"
                  maxlength="32"
                  pattern="\+?[0-9][0-9 ()-]{5,30}[0-9]"
                  :disabled="!canMutate || savingProfile"
                  aria-label="手机号"
                />
              </UFormField>
              <div class="flex flex-wrap items-end justify-between gap-3 sm:col-span-2">
                <p class="text-xs leading-5 text-muted">
                  修改邮箱或手机号会清除对应验证状态；管理员修改不会使联系方式自动通过验证。
                </p>
                <UButton
                  v-if="canMutate"
                  type="submit"
                  color="primary"
                  :loading="savingProfile"
                  :disabled="savingProfile"
                >
                  保存资料
                </UButton>
              </div>
            </UForm>

            <USeparator class="my-5" />
            <dl class="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-muted">
                  账户状态
                </dt>
                <dd class="mt-1 font-medium text-highlighted">
                  {{ statusLabel }}
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  注册时间
                </dt>
                <dd class="mt-1 font-medium text-highlighted">
                  <time :datetime="customer.createdAt">{{ formatDate(customer.createdAt) }}</time>
                </dd>
              </div>
              <div>
                <dt class="text-muted">
                  资料最后更新
                </dt>
                <dd class="mt-1 font-medium text-highlighted">
                  <time :datetime="customer.updatedAt">{{ formatDate(customer.updatedAt) }}</time>
                </dd>
              </div>
            </dl>
          </UCard>

          <UCard :ui="{ body: 'p-4 sm:p-6' }">
            <header class="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 class="text-lg font-semibold text-highlighted">
                  历史订单
                </h2>
                <p class="mt-1 text-sm text-muted">
                  只读关联记录；本阶段不开放订单操作。
                </p>
              </div>
              <p
                v-if="orders"
                class="text-sm text-muted"
              >
                共 {{ orders.total.toLocaleString('zh-CN') }} 笔
              </p>
            </header>

            <div
              v-if="ordersLoading"
              class="grid gap-3"
              aria-label="正在加载历史订单"
              aria-busy="true"
            >
              <div
                v-for="row in 2"
                :key="row"
                class="h-14 animate-pulse rounded-lg bg-elevated"
              />
            </div>
            <UEmpty
              v-else-if="!orders?.items.length"
              icon="i-lucide-receipt-text"
              title="暂无历史订单"
              description="顾客尚无关联订单。"
              class="py-8"
            />
            <ul
              v-else
              class="divide-y divide-muted"
            >
              <li
                v-for="order in orders.items"
                :key="order.id"
                class="grid min-w-0 gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div class="min-w-0">
                  <p class="break-all font-medium text-highlighted">
                    订单 {{ order.id }}
                  </p>
                  <p class="mt-1 text-xs text-muted">
                    <time :datetime="order.createdAt">{{ formatDate(order.createdAt) }}</time>
                    · {{ orderStatusLabel(order.customerStatus) }}
                    · 支付 {{ order.paymentStatus }}
                    <span v-if="order.refundStatus !== 'none'"> · 退款 {{ order.refundStatus }}</span>
                  </p>
                </div>
                <p class="font-semibold tabular-nums text-highlighted">
                  ¥{{ order.totalAmount }}
                </p>
              </li>
            </ul>
            <div
              v-if="orders && orders.totalPages > 1"
              class="flex flex-col gap-3 border-t border-muted pt-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <p class="text-sm text-muted">
                第 {{ orders.page }} / {{ orders.totalPages }} 页
              </p>
              <UPagination
                :page="orders.page"
                :total="orders.total"
                :items-per-page="orders.pageSize"
                :sibling-count="1"
                show-edges
                aria-label="历史订单分页"
                @update:page="pageQuery"
              />
            </div>
          </UCard>

          <UCard :ui="{ body: 'p-4 sm:p-6' }">
            <header class="mb-4">
              <h2 class="text-lg font-semibold text-highlighted">
                管理审计
              </h2>
              <p class="mt-1 text-sm text-muted">
                只记录管理员身份、操作、时间与不含秘密的变更摘要。
              </p>
            </header>
            <UEmpty
              v-if="!auditEvents.length"
              icon="i-lucide-history"
              title="暂无管理记录"
              description="后续资料和账户操作会写入不可变审计记录。"
              class="py-7"
            />
            <ol
              v-else
              class="grid gap-3"
            >
              <li
                v-for="event in auditEvents"
                :key="event.id"
                class="min-w-0 rounded-lg border border-muted p-3 sm:p-4"
              >
                <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div class="min-w-0">
                    <p class="font-medium text-highlighted">
                      {{ auditActionLabel(event) }}
                    </p>
                    <p class="mt-1 text-sm leading-6 text-muted">
                      {{ auditSummary(event) }}
                    </p>
                    <p class="mt-1 break-all text-xs text-muted">
                      操作管理员：{{ event.administratorEmail }}
                    </p>
                  </div>
                  <time
                    class="shrink-0 text-xs text-muted"
                    :datetime="event.createdAt"
                  >{{ formatDate(event.createdAt) }}</time>
                </div>
              </li>
            </ol>
          </UCard>
        </template>

        <UModal
          v-model:open="statusModalOpen"
          :title="desiredStatus === 'disabled' ? '确认禁用顾客账户' : '确认恢复顾客账户'"
          :description="desiredStatus === 'disabled' ? '禁用后顾客不能登录，现有会话会立即撤销。' : '恢复后顾客可以重新登录，旧会话不会恢复。'"
          :ui="{ footer: 'justify-end' }"
        >
          <template #body>
            <UAlert
              v-if="desiredStatus === 'disabled'"
              color="warning"
              variant="soft"
              title="禁用不会退款、关闭订单、清空余额或删除已购权益。"
            />
            <UAlert
              v-else
              color="info"
              variant="soft"
              title="恢复只允许重新登录；此前撤销的会话仍然无效。"
            />
          </template>
          <template #footer>
            <UButton
              color="neutral"
              variant="outline"
              :disabled="actionBusy"
              @click="statusModalOpen = false"
            >
              取消
            </UButton>
            <UButton
              :color="desiredStatus === 'disabled' ? 'warning' : 'success'"
              :loading="actionBusy"
              @click="confirmStatusChange"
            >
              {{ desiredStatus === 'disabled' ? '确认禁用' : '确认恢复' }}
            </UButton>
          </template>
        </UModal>

        <UModal
          v-model:open="passwordModalOpen"
          title="重置顾客密码"
          description="设置新的临时密码。旧密码立即失效，所有旧会话都会撤销。"
          :ui="{ footer: 'justify-end' }"
          @after:leave="temporaryPassword = ''"
        >
          <template #body>
            <UAlert
              class="mb-4"
              color="warning"
              variant="soft"
              title="请通过安全渠道将临时密码交给顾客；系统不会再次展示它。"
            />
            <UFormField
              label="新临时密码"
              name="temporaryPassword"
              description="12–128 个字符；输入内容不会写入审计记录。"
            >
              <UInput
                v-model="temporaryPassword"
                type="password"
                class="w-full"
                autocomplete="new-password"
                minlength="12"
                maxlength="128"
                :disabled="actionBusy"
                aria-label="新临时密码"
              />
            </UFormField>
          </template>
          <template #footer>
            <UButton
              color="neutral"
              variant="outline"
              :disabled="actionBusy"
              @click="passwordModalOpen = false"
            >
              取消
            </UButton>
            <UButton
              color="primary"
              :disabled="!canResetPassword || actionBusy"
              :loading="actionBusy"
              @click="confirmPasswordReset"
            >
              确认重置并撤销会话
            </UButton>
          </template>
        </UModal>

        <UModal
          v-model:open="deleteModalOpen"
          title="删除并匿名化顾客账户"
          description="此操作不可撤销。请核对影响后再次确认。"
          :ui="{ footer: 'justify-end' }"
          @after:leave="deleteAcknowledged = false; deleteConfirmation = ''"
        >
          <template #body>
            <div class="grid gap-4">
              <UAlert
                color="error"
                variant="soft"
                title="删除后身份不能恢复，且仅在没有未结交易义务时允许执行。"
              >
                <template #description>
                  用户名、密码哈希、邮箱、手机号和验证状态会被清除；顾客 UUID、历史订单、支付、退款、提现、库存与对账记录会保留。不会自动退款、关闭订单或清空余额。
                </template>
              </UAlert>
              <UCheckbox
                v-model="deleteAcknowledged"
                label="我已理解删除影响，并确认需要删除此账户。"
              />
              <UFormField
                label="输入当前用户名以继续"
                name="deleteConfirmation"
              >
                <UInput
                  v-model="deleteConfirmation"
                  class="w-full"
                  autocomplete="off"
                  :placeholder="customer?.username ?? ''"
                  :disabled="actionBusy"
                />
              </UFormField>
            </div>
          </template>
          <template #footer>
            <UButton
              color="neutral"
              variant="outline"
              :disabled="actionBusy"
              @click="deleteModalOpen = false"
            >
              取消
            </UButton>
            <UButton
              color="error"
              :disabled="!canDelete || actionBusy"
              :loading="actionBusy"
              @click="confirmDelete"
            >
              确认删除账户
            </UButton>
          </template>
        </UModal>
      </main>
    </template>
  </UDashboardPanel>
</template>
