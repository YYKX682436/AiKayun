<script setup lang="ts">
import type { ApiSuccess, AdminSession, CsrfToken } from '@aikayun/contracts'

definePageMeta({ layout: false })
useSeoMeta({ title: '管理员登录' })

const email = ref('')
const password = ref('')
const errorMessage = ref('')
const busy = ref(false)
const clientReady = ref(false)

onMounted(() => {
  clientReady.value = true
})

async function submitLogin() {
  errorMessage.value = ''
  busy.value = true
  try {
    const { data: csrf } = await $fetch<ApiSuccess<CsrfToken>>('/api/v1/admin/auth/csrf')
    await $fetch<ApiSuccess<AdminSession>>('/api/v1/admin/auth/login', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf.csrfToken },
      body: { email: email.value, password: password.value },
    })
    await navigateTo('/admin')
  } catch (error) {
    const status = 'statusCode' in (error as object) ? Number((error as { statusCode: number }).statusCode) : 0
    errorMessage.value = status === 401
      ? '邮箱或密码不正确。'
      : status === 403
        ? '登录请求已过期，请重试。'
        : status === 429
          ? '尝试次数过多，请稍后再试。'
          : '暂时无法登录，请稍后重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="grid min-h-screen bg-slate-50 lg:grid-cols-[1fr_0.9fr]">
    <section class="flex items-center justify-center px-5 py-12 sm:px-10">
      <div class="w-full max-w-md">
        <NuxtLink
          to="/"
          class="mb-10 inline-flex items-center gap-3 font-semibold tracking-tight text-slate-950"
        >
          <span class="grid size-9 place-items-center rounded-xl bg-primary text-sm font-bold text-inverted">A</span>
          AiKayun
        </NuxtLink>
        <h1 class="text-3xl font-semibold tracking-tight text-slate-950">
          管理员登录
        </h1>
        <p class="mt-2 text-sm leading-6 text-slate-600">
          登录后管理你的独立数字商品商城。
        </p>

        <UAlert
          v-if="errorMessage"
          class="mt-6"
          color="error"
          variant="soft"
          :title="errorMessage"
          role="alert"
        />

        <form
          class="mt-8 grid gap-5"
          method="post"
          action="/api/v1/admin/auth/login"
          @submit.prevent="submitLogin"
        >
          <UFormField
            label="管理员邮箱"
            name="email"
            required
          >
            <UInput
              v-model="email"
              type="email"
              autocomplete="username"
              inputmode="email"
              required
              class="w-full"
              size="lg"
            />
          </UFormField>
          <UFormField
            label="密码"
            name="password"
            required
          >
            <UInput
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              class="w-full"
              size="lg"
            />
          </UFormField>
          <UButton
            type="submit"
            size="lg"
            block
            :loading="busy"
            :disabled="busy || !clientReady"
          >
            安全登录
          </UButton>
        </form>

        <p class="mt-6 text-xs leading-5 text-slate-500">
          管理接口需要经过服务端会话验证。请勿在共享设备上保存管理员密码。
        </p>
      </div>
    </section>
    <aside class="relative hidden overflow-hidden bg-[#202653] p-12 text-white lg:flex lg:flex-col lg:justify-between">
      <div
        class="absolute -right-28 -top-24 size-[480px] rounded-full border border-white/10"
        aria-hidden="true"
      />
      <div
        class="absolute -right-8 -top-4 size-[320px] rounded-full border border-white/10"
        aria-hidden="true"
      />
      <p class="relative max-w-sm text-sm font-medium text-indigo-200">
        独立部署 · 面向数字商品
      </p>
      <div class="relative max-w-xl pb-10">
        <p class="text-sm font-semibold uppercase tracking-[0.18em] text-indigo-200">
          经营你的数字业务
        </p>
        <p class="mt-5 text-4xl font-semibold leading-tight tracking-tight">
          从一个可靠、清晰的管理体验开始。
        </p>
        <p class="mt-5 max-w-lg leading-7 text-indigo-100/75">
          AiKayun 正在搭建数字商品商城基础。首版专注管理员、商品展示和安全的交付准备。
        </p>
      </div>
      <p class="relative text-xs text-indigo-200/70">
        © AiKayun
      </p>
    </aside>
  </main>
</template>
