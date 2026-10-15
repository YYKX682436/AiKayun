<script setup lang="ts">
import type { AdminSession, ApiSuccess } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '管理概览' })

const { data: session } = await useFetch<ApiSuccess<AdminSession>>('/api/v1/admin/session')
const busy = ref(false)

async function logout() {
  busy.value = true
  try {
    const { data: csrf } = await $fetch<ApiSuccess<{ csrfToken: string }>>('/api/v1/admin/auth/csrf')
    await $fetch('/api/v1/admin/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf.csrfToken },
    })
    await navigateTo('/admin/login')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="text-sm font-medium text-primary">
          工作区
        </p>
        <h1 class="mt-2 text-3xl font-semibold tracking-tight text-highlighted">
          管理概览
        </h1>
        <p class="mt-2 text-sm text-muted">
          商城基础已就绪，可以从这里开始配置。
        </p>
      </div>
      <UButton
        color="neutral"
        variant="outline"
        :loading="busy"
        @click="logout"
      >
        退出登录
      </UButton>
    </div>

    <section class="mt-8 grid gap-4 sm:grid-cols-2">
      <UCard>
        <p class="text-sm text-muted">
          当前管理员
        </p>
        <p class="mt-2 break-all text-lg font-semibold text-highlighted">
          {{ session?.data.admin.email }}
        </p>
      </UCard>
      <UCard>
        <p class="text-sm text-muted">
          服务状态
        </p>
        <p class="mt-2 inline-flex items-center gap-2 text-lg font-semibold text-highlighted">
          <span
            class="size-2 rounded-full bg-success"
            aria-hidden="true"
          />
          已安全登录
        </p>
      </UCard>
    </section>

    <UCard class="mt-6">
      <h2 class="text-base font-semibold text-highlighted">
        首版工程状态
      </h2>
      <p class="mt-2 text-sm leading-6 text-muted">
        这套工程已接通共享 API 契约、PostgreSQL 迁移和管理员会话。商品、订单、支付和履约数据模型将在后续阶段按实际业务建立。
      </p>
      <div class="mt-5 flex flex-wrap gap-2">
        <span
          v-for="tag in ['管理员会话', 'PostgreSQL', 'OpenAPI']"
          :key="tag"
          class="rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted"
        >{{ tag }}</span>
      </div>
    </UCard>
  </div>
</template>
