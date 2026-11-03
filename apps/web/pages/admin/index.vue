<script setup lang="ts">
import type { AdminSession, ApiSuccess } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '管理概览' })

const { data: session } = await useFetch<ApiSuccess<AdminSession>>('/api/v1/admin/session')
const { data: license, error: licenseError, refresh: refreshLicense } = await useFetch<ApiSuccess<{
  status: string
  allowedUntil: string | null
  retryable: boolean
}>>('/api/v1/admin/license-status')
const licenseStatus = computed(() => {
  switch (license.value?.data.status) {
    case 'active': return '正常'
    case 'offline_valid': return '离线有效'
    case 'unactivated': return '未激活'
    case 'expired': case 'offline_expired': return '已过期'
    case 'revoked': return '已撤销'
    case 'superseded': return '已被替代'
    case 'clock_suspect': return '时间异常'
    case 'identity_mismatch': return '安装身份异常'
    default: return '暂时无法确认'
  }
})
const busy = ref(false)
const logoutError = ref('')

async function logout() {
  if (busy.value) return

  logoutError.value = ''
  busy.value = true
  try {
    const { data: csrf } = await $fetch<ApiSuccess<{ csrfToken: string }>>('/api/v1/admin/auth/csrf')
    await $fetch('/api/v1/admin/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf.csrfToken },
    })
    await navigateTo('/admin/login')
  } catch {
    logoutError.value = '退出登录暂时失败，请重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="admin-overview">
    <template #header>
      <UDashboardNavbar
        title="管理后台"
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
        class="mx-auto w-full max-w-6xl p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <p class="text-sm font-medium text-primary">
              工作区
            </p>
            <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              管理概览
            </h1>
            <p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
              查看当前管理员会话与已开放的管理内容。
            </p>
          </div>

          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-log-out"
            :loading="busy"
            :disabled="busy"
            class="min-h-11 shrink-0"
            @click="logout"
          >
            退出登录
          </UButton>
        </div>

        <UAlert
          v-if="logoutError"
          class="mt-6"
          color="error"
          variant="soft"
          :title="logoutError"
          role="alert"
          aria-live="assertive"
        />

        <section
          aria-labelledby="session-title"
          class="mt-8"
        >
          <h2
            id="session-title"
            class="text-lg font-semibold text-highlighted"
          >
            当前会话
          </h2>
          <UCard class="mt-4 max-w-2xl">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0">
                <p class="text-sm text-muted">
                  管理员邮箱
                </p>
                <p class="mt-1 break-all font-medium text-highlighted">
                  {{ session?.data.admin.email }}
                </p>
              </div>
              <UBadge
                color="success"
                variant="soft"
                icon="i-lucide-shield-check"
                class="w-fit shrink-0"
              >
                已验证
              </UBadge>
            </div>
          </UCard>
        </section>

        <section
          aria-labelledby="license-title"
          class="mt-10 border-t border-default pt-8"
        >
          <h2
            id="license-title"
            class="text-lg font-semibold text-highlighted"
          >
            经营授权状态
          </h2>
          <UCard class="mt-4 max-w-2xl">
            <p
              v-if="licenseError"
              role="status"
              class="text-sm text-muted"
            >
              授权状态暂时无法读取。
            </p>
            <template v-else>
              <p class="font-medium text-highlighted">
                {{ licenseStatus }}
              </p>
              <p
                v-if="license?.data.allowedUntil"
                class="mt-2 text-sm text-muted"
              >
                有效截止：{{ license.data.allowedUntil }}
              </p>
              <p class="mt-2 text-sm text-muted">
                新订单和充值以提交时的授权检查为准；已有业务继续处理。
              </p>
            </template>
            <UButton
              class="mt-4"
              color="neutral"
              variant="outline"
              @click="refreshLicense()"
            >
              刷新状态
            </UButton>
            <UButton
              to="/admin/license"
              class="mt-4 ml-2"
              icon="i-lucide-key-round"
            >
              管理授权
            </UButton>
          </UCard>
        </section>

        <section
          aria-labelledby="business-data-title"
          class="mt-10 border-t border-default pt-8"
        >
          <div>
            <p class="text-sm font-medium text-muted">
              店铺经营
            </p>
            <h2
              id="business-data-title"
              class="mt-1 text-xl font-semibold text-highlighted"
            >
              经营数据
            </h2>
          </div>

          <div class="mt-4 rounded-xl border border-default bg-elevated">
            <UEmpty
              icon="i-lucide-chart-no-axes-combined"
              title="经营数据尚未开放"
              description="目前没有商品、订单或销售数据可供查看。相关数据接入后，概览会在这里展示。"
              variant="naked"
              size="lg"
              class="min-h-56"
            />
          </div>
        </section>
      </main>
    </template>
  </UDashboardPanel>
</template>
