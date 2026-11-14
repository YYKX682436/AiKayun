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
  <div
    class="min-h-dvh flex flex-col bg-default text-default"
    :data-admin-login-ready="clientReady ? 'true' : 'false'"
  >
    <header class="border-b border-default/70 bg-elevated/80 backdrop-blur-md sticky top-0 z-30">
      <UContainer class="flex h-14 items-center justify-between gap-4">
        <NuxtLink
          to="/"
          class="flex items-center gap-2.5 rounded-lg font-semibold text-highlighted transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <BrandMark
            name="AiKayun"
            class="size-7"
          />
          <span class="text-sm font-semibold tracking-tight">AiKayun</span>
          <UBadge
            variant="subtle"
            color="neutral"
            size="xs"
            class="hidden sm:inline-flex"
          >
            工作区
          </UBadge>
        </NuxtLink>
        <ThemeModeSelect />
      </UContainer>
    </header>

    <main
      id="main-content"
      class="mx-auto flex flex-1 w-full max-w-7xl items-center p-4 sm:p-6 lg:p-8"
    >
      <div class="grid w-full items-center gap-8 lg:grid-cols-12 lg:gap-12">
        <!-- Left Brand & Context Intro -->
        <section
          aria-labelledby="login-intro-title"
          class="lg:col-span-7 space-y-6"
        >
          <div class="space-y-3">
            <div class="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <UIcon
                name="i-lucide-shield-check"
                class="size-3.5"
              />
              <span>AiKayun 管理工作区</span>
            </div>
            <h1
              id="login-intro-title"
              class="text-3xl font-bold tracking-tight text-highlighted sm:text-4xl"
            >
              数字商品管理工作台
            </h1>
            <p class="max-w-xl text-sm leading-6 text-muted sm:text-base">
              面向数字商品、卡密自动发卡及渠道供应链的独立管理系统。登录后可进入控制中心查看实时经营状况。
            </p>
          </div>

          <div class="grid gap-3 pt-2 sm:grid-cols-3">
            <div class="space-y-1 rounded-xl border border-default/70 bg-elevated p-3.5">
              <div class="flex items-center gap-2 text-sm font-medium text-primary">
                <UIcon
                  name="i-lucide-zap"
                  class="size-4"
                />
                <span>自动发卡</span>
              </div>
              <p class="text-xs leading-relaxed text-muted">
                卡密与交付文件准时处理
              </p>
            </div>
            <div class="space-y-1 rounded-xl border border-default/70 bg-elevated p-3.5">
              <div class="flex items-center gap-2 text-sm font-medium text-primary">
                <UIcon
                  name="i-lucide-scale"
                  class="size-4"
                />
                <span>账单核验</span>
              </div>
              <p class="text-xs leading-relaxed text-muted">
                多支付通道精准回执对账
              </p>
            </div>
            <div class="space-y-1 rounded-xl border border-default/70 bg-elevated p-3.5">
              <div class="flex items-center gap-2 text-sm font-medium text-primary">
                <UIcon
                  name="i-lucide-lock"
                  class="size-4"
                />
                <span>安全自主</span>
              </div>
              <p class="text-xs leading-relaxed text-muted">
                独立部署与数据自主掌控
              </p>
            </div>
          </div>

          <div class="pt-2">
            <NuxtLink
              to="/"
              class="inline-flex items-center gap-2 text-sm font-medium text-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors"
            >
              <UIcon
                name="i-lucide-arrow-left"
                class="size-4"
                aria-hidden="true"
              />
              返回店铺首页
            </NuxtLink>
          </div>
        </section>

        <!-- Right Auth Form Card -->
        <section
          aria-labelledby="login-title"
          class="lg:col-span-5 flex justify-center"
        >
          <UCard class="w-full max-w-md border border-default/80 bg-elevated shadow-sm">
            <template #header>
              <div class="space-y-1">
                <h2
                  id="login-title"
                  class="text-xl font-bold tracking-tight text-highlighted"
                >
                  管理员登录
                </h2>
                <p class="text-xs text-muted">
                  使用管理员邮箱和密码继续。
                </p>
              </div>
            </template>

            <UAlert
              v-if="errorMessage"
              class="mb-5"
              color="error"
              variant="soft"
              :title="errorMessage"
              role="alert"
              aria-live="assertive"
            />

            <form
              class="grid gap-4"
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
                  placeholder="admin@example.com"
                  icon="i-lucide-mail"
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
                  placeholder="••••••••"
                  icon="i-lucide-lock"
                  class="w-full"
                  size="lg"
                  :disabled="busy || !clientReady"
                />
              </UFormField>

              <div class="pt-1">
                <UButton
                  type="submit"
                  size="lg"
                  block
                  icon="i-lucide-log-in"
                  :loading="busy"
                  :disabled="busy || !clientReady"
                  class="min-h-11"
                >
                  安全登录
                </UButton>
              </div>
            </form>

            <template #footer>
              <div class="flex items-start gap-2 text-xs leading-relaxed text-muted">
                <UIcon
                  name="i-lucide-shield-alert"
                  class="mt-0.5 size-4 shrink-0 text-muted"
                />
                <p>
                  请勿在共享设备上保存管理员密码。管理接口通过服务端会话验证。
                </p>
              </div>
            </template>
          </UCard>
        </section>
      </div>
    </main>
  </div>
</template>
