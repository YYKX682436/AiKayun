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
  if (busy.value) return

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
  <div class="min-h-dvh bg-default">
    <header class="border-b border-default bg-elevated">
      <UContainer class="flex min-h-16 items-center justify-between gap-4 py-2">
        <NuxtLink
          to="/"
          class="flex min-h-11 items-center gap-3 rounded-sm font-semibold text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          <BrandMark name="AiKayun" />
          <span>AiKayun</span>
        </NuxtLink>
        <ThemeModeSelect />
      </UContainer>
    </header>

    <main
      id="main-content"
      class="mx-auto grid min-h-[calc(100dvh-4rem)] w-full min-w-0 max-w-7xl lg:grid-cols-2"
    >
      <section
        aria-labelledby="login-intro-title"
        class="flex min-w-0 items-center px-4 py-10 sm:px-8 lg:px-12 lg:py-16"
      >
        <div class="max-w-xl">
          <p class="text-sm font-medium text-primary">
            AiKayun 管理后台
          </p>
          <h1
            id="login-intro-title"
            class="mt-3 text-3xl font-semibold leading-tight text-highlighted sm:text-4xl"
          >
            店铺管理工作区
          </h1>
          <p class="mt-4 max-w-lg leading-7 text-muted">
            此入口仅供管理员使用。登录后可查看当前已经开放的店铺管理内容。
          </p>
          <NuxtLink
            to="/"
            class="mt-6 inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <UIcon
              name="i-lucide-arrow-left"
              class="size-4"
              aria-hidden="true"
            />
            返回店铺
          </NuxtLink>
        </div>
      </section>

      <section
        aria-labelledby="login-title"
        class="flex min-w-0 items-center justify-center border-t border-default bg-muted/40 px-4 py-10 sm:px-8 lg:border-l lg:border-t-0 lg:px-12 lg:py-16"
      >
        <UCard class="w-full min-w-0 max-w-md bg-elevated">
          <template #header>
            <h2
              id="login-title"
              class="text-2xl font-semibold text-highlighted"
            >
              管理员登录
            </h2>
            <p class="mt-2 text-sm leading-6 text-muted">
              使用管理员邮箱和密码继续。
            </p>
          </template>

          <UAlert
            v-if="errorMessage"
            class="mb-6"
            color="error"
            variant="soft"
            :title="errorMessage"
            role="alert"
            aria-live="assertive"
          />

          <form
            class="grid gap-5"
            method="post"
            action="/api/v1/admin/auth/login"
            :aria-busy="busy"
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
                :disabled="busy || !clientReady"
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
                :disabled="busy || !clientReady"
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

          <template #footer>
            <p class="text-sm leading-6 text-muted">
              请勿在共享设备上保存管理员密码。管理接口通过服务端会话验证。
            </p>
          </template>
        </UCard>
      </section>
    </main>
  </div>
</template>
