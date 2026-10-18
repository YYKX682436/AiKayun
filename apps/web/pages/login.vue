<script setup lang="ts">
import { CustomerApiError } from '~/composables/useCustomerApi'

useSeoMeta({ title: '顾客登录', description: '登录你的商城顾客账户。' })

const route = useRoute()
const customerApi = useCustomerApi()
const username = ref('')
const password = ref('')
const showPassword = ref(false)
const busy = ref(false)
const errorMessage = ref('')
const clientReady = ref(false)

onMounted(() => { clientReady.value = true })

const redirectPath = computed(() => {
  const requested = route.query.redirect
  if (typeof requested !== 'string' || !requested.startsWith('/') || requested.startsWith('//') || requested.includes('\\')) {
    return '/account'
  }
  return requested
})

async function submitLogin() {
  if (busy.value) return
  errorMessage.value = ''
  busy.value = true
  try {
    await customerApi.login({ username: username.value, password: password.value })
    await navigateTo(redirectPath.value)
  } catch (error) {
    errorMessage.value = error instanceof CustomerApiError ? error.message : '暂时无法登录，请稍后重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UContainer class="py-8 sm:py-14">
    <main
      id="main-content"
      class="mx-auto w-full max-w-5xl"
    >
      <div class="grid overflow-hidden rounded-2xl border border-default bg-elevated shadow-sm lg:grid-cols-2">
        <section class="flex min-w-0 flex-col justify-between gap-8 bg-muted/40 p-6 sm:p-9 lg:p-12">
          <div>
            <p class="text-sm font-medium text-primary">
              顾客账户
            </p>
            <h1 class="mt-3 text-3xl font-semibold tracking-tight text-highlighted sm:text-4xl">
              欢迎回来
            </h1>
            <p class="mt-4 max-w-md text-base leading-7 text-muted">
              登录后查看和更新你的账户资料。账户凭证由服务端安全处理。
            </p>
          </div>
          <NuxtLink
            to="/"
            class="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <UIcon
              name="i-lucide-arrow-left"
              class="size-4"
              aria-hidden="true"
            />
            返回商城
          </NuxtLink>
        </section>

        <section class="min-w-0 p-5 sm:p-9 lg:p-12">
          <div class="mb-6">
            <h2 class="text-2xl font-semibold text-highlighted">
              顾客登录
            </h2>
            <p class="mt-2 text-sm leading-6 text-muted">
              输入用户名和密码继续。
            </p>
          </div>

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
            class="grid gap-5"
            method="post"
            action="/api/v1/customer/auth/login"
            :data-customer-login-ready="clientReady"
            :aria-busy="busy"
            @submit.prevent="submitLogin"
          >
            <UFormField
              label="用户名"
              name="username"
              required
            >
              <UInput
                v-model="username"
                class="w-full"
                size="lg"
                name="username"
                autocomplete="username"
                minlength="3"
                maxlength="32"
                pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}"
                required
                :disabled="busy || !clientReady"
              />
            </UFormField>

            <UFormField
              label="密码"
              name="password"
              required
            >
              <div class="flex min-w-0 items-center gap-2">
                <UInput
                  v-model="password"
                  class="min-w-0 flex-1"
                  size="lg"
                  name="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="current-password"
                  maxlength="128"
                  required
                  :disabled="busy || !clientReady"
                />
                <UButton
                  type="button"
                  color="neutral"
                  variant="outline"
                  :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                  :aria-pressed="showPassword"
                  class="min-h-11 min-w-11 justify-center"
                  :disabled="busy || !clientReady"
                  @click="showPassword = !showPassword"
                />
              </div>
            </UFormField>

            <UButton
              type="submit"
              size="lg"
              block
              :loading="busy"
              :disabled="busy || !clientReady"
            >
              登录
            </UButton>
          </form>

          <p class="mt-6 text-center text-sm leading-6 text-muted">
            还没有账户？
            <NuxtLink
              to="/register"
              class="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              创建账户
            </NuxtLink>
          </p>
        </section>
      </div>
    </main>
  </UContainer>
</template>
