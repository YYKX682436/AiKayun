<script setup lang="ts">
import type { ApiSuccess, CsrfToken } from '@aikayun/contracts'

definePageMeta({ layout: false })
useSeoMeta({ title: '首次初始化 · AiKayun' })

type SetupStatus = 'checking' | 'required' | 'completed' | 'unavailable'
const setupStatus = ref<SetupStatus>('checking')
const phase = ref<'token' | 'administrator' | 'complete'>('token')
const token = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const errorMessage = ref('')

function httpStatus(error: unknown): number {
  return error && typeof error === 'object' && 'statusCode' in error
    ? Number((error as { statusCode: unknown }).statusCode)
    : 0
}

function apiCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('data' in error)) return ''
  const data = (error as { data?: { error?: { code?: unknown } } }).data
  return typeof data?.error?.code === 'string' ? data.error.code : ''
}

async function readSetupStatus() {
  try {
    const { data } = await $fetch<ApiSuccess<{ status: string }>>('/api/v1/setup/status')
    setupStatus.value = data.status === 'completed' ? 'completed' : data.status === 'required' ? 'required' : 'unavailable'
  } catch {
    setupStatus.value = 'unavailable'
  }
}

onMounted(() => { void readSetupStatus() })

async function verifyToken() {
  if (busy.value) return
  errorMessage.value = ''
  busy.value = true
  try {
    const { data: csrf } = await $fetch<ApiSuccess<CsrfToken>>('/api/v1/setup/csrf')
    await $fetch('/api/v1/setup/verify', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf.csrfToken },
      body: { token: token.value },
    })
    token.value = ''
    phase.value = 'administrator'
  } catch (error) {
    const code = apiCode(error)
    if (code === 'SETUP_ALREADY_COMPLETED' || httpStatus(error) === 409) {
      setupStatus.value = 'completed'
    } else if (httpStatus(error) === 429) {
      errorMessage.value = '尝试次数过多，请稍后再试。'
    } else if (httpStatus(error) === 403) {
      errorMessage.value = '请求未通过安全校验，请刷新页面后重试。'
    } else {
      errorMessage.value = '初始化口令无效或已过期。需要新口令时，请在服务器执行本机签发命令。'
    }
  } finally {
    busy.value = false
  }
}

async function createAdministrator() {
  if (busy.value) return
  errorMessage.value = ''
  if (password.value !== confirmPassword.value) {
    errorMessage.value = '两次输入的密码不一致。'
    return
  }
  busy.value = true
  try {
    const { data: csrf } = await $fetch<ApiSuccess<CsrfToken>>('/api/v1/setup/csrf')
    await $fetch('/api/v1/setup/admin', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf.csrfToken },
      body: { email: email.value, password: password.value },
    })
    password.value = ''
    confirmPassword.value = ''
    phase.value = 'complete'
    setupStatus.value = 'completed'
  } catch (error) {
    const code = apiCode(error)
    if (code === 'SETUP_ALREADY_COMPLETED' || httpStatus(error) === 409) {
      setupStatus.value = 'completed'
    } else if (code === 'SETUP_ADMIN_CREDENTIALS_INVALID') {
      errorMessage.value = '请检查邮箱和密码要求后重试。'
    } else if (code === 'SETUP_SESSION_EXPIRED' || httpStatus(error) === 401) {
      phase.value = 'token'
      errorMessage.value = '初始化会话已过期，请使用新的服务器口令重新验证。'
    } else if (httpStatus(error) === 429) {
      errorMessage.value = '尝试次数过多，请稍后再试。'
    } else {
      errorMessage.value = '提交结果暂时无法确认。请刷新页面查看初始化状态，再决定是否重试。'
    }
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
        <span class="text-sm text-muted">安全初始化</span>
      </UContainer>
    </header>

    <main
      id="main-content"
      class="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-6xl items-center px-4 py-10 sm:px-8 lg:px-12"
    >
      <div class="grid w-full gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)] lg:items-center lg:gap-16">
        <section class="max-w-xl">
          <p class="text-sm font-medium text-primary">
            店铺首次启用
          </p>
          <h1 class="mt-3 text-3xl font-semibold leading-tight text-highlighted sm:text-4xl">
            {{ phase === 'complete' || setupStatus === 'completed' ? '初始化已完成' : '创建管理员账户' }}
          </h1>
          <p class="mt-4 leading-7 text-muted">
            {{ phase === 'complete' || setupStatus === 'completed'
              ? '管理员账户已创建。请使用刚设置的邮箱和密码登录后台。'
              : '先验证服务器本机签发的一次性口令，再设置店铺管理员的邮箱和密码。初始化凭证只通过 HTTPS 提交。' }}
          </p>

          <div class="mt-7 flex items-start gap-3 rounded-xl border border-default bg-elevated p-4">
            <UIcon
              name="i-lucide-shield-check"
              class="mt-0.5 size-5 shrink-0 text-primary"
              aria-hidden="true"
            />
            <p class="text-sm leading-6 text-muted">
              一次性口令有效 30 分钟。过期后只能在服务器通过受控本机命令重新签发；初始化完成后，此入口永久关闭。
            </p>
          </div>
        </section>

        <UCard class="w-full min-w-0 bg-elevated">
          <template #header>
            <h2 class="text-xl font-semibold text-highlighted">
              {{ phase === 'token' ? '验证初始化口令' : phase === 'administrator' ? '设置管理员' : '可以开始使用' }}
            </h2>
            <p class="mt-2 text-sm leading-6 text-muted">
              {{ phase === 'token'
                ? '从服务器受控终端复制口令。它不会放进网址或浏览器存储。'
                : phase === 'administrator'
                  ? '管理员创建后，网页初始化立即永久关闭。'
                  : '登录后台后，可继续完成商城配置和授权激活。' }}
            </p>
          </template>

          <UAlert
            v-if="setupStatus === 'unavailable'"
            class="mb-5"
            color="warning"
            variant="soft"
            title="暂时无法读取初始化状态，请稍后刷新页面。"
            role="status"
          />
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
            v-if="setupStatus !== 'completed' && phase === 'token'"
            class="grid gap-5"
            @submit.prevent="verifyToken"
          >
            <UFormField
              label="服务器初始化口令"
              name="token"
              required
            >
              <UInput
                v-model="token"
                type="password"
                autocomplete="one-time-code"
                spellcheck="false"
                required
                maxlength="43"
                class="w-full"
                size="lg"
                :disabled="busy || setupStatus === 'checking' || setupStatus === 'unavailable'"
              />
            </UFormField>
            <UButton
              type="submit"
              size="lg"
              block
              :loading="busy"
              :disabled="busy || !token || setupStatus !== 'required'"
            >
              验证并继续
            </UButton>
          </form>

          <form
            v-else-if="setupStatus !== 'completed' && phase === 'administrator'"
            class="grid gap-5"
            @submit.prevent="createAdministrator"
          >
            <UFormField
              label="管理员邮箱"
              name="email"
              required
            >
              <UInput
                v-model="email"
                type="email"
                autocomplete="email"
                inputmode="email"
                required
                maxlength="254"
                class="w-full"
                size="lg"
                :disabled="busy"
              />
            </UFormField>
            <UFormField
              label="管理员密码"
              name="password"
              description="至少 14 个字符，不能包含邮箱名称。"
              required
            >
              <UInput
                v-model="password"
                type="password"
                autocomplete="new-password"
                required
                minlength="14"
                maxlength="1024"
                class="w-full"
                size="lg"
                :disabled="busy"
              />
            </UFormField>
            <UFormField
              label="再次输入密码"
              name="confirmPassword"
              required
            >
              <UInput
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                required
                minlength="14"
                maxlength="1024"
                class="w-full"
                size="lg"
                :disabled="busy"
              />
            </UFormField>
            <UButton
              type="submit"
              size="lg"
              block
              :loading="busy"
              :disabled="busy || !email || !password || !confirmPassword"
            >
              创建管理员并完成初始化
            </UButton>
          </form>

          <div
            v-else
            class="grid gap-4"
          >
            <UBadge
              color="success"
              variant="soft"
              icon="i-lucide-check-circle-2"
              class="w-fit"
            >
              初始化已关闭
            </UBadge>
            <UButton
              to="/admin/login"
              size="lg"
              block
            >
              前往管理员登录
            </UButton>
          </div>
        </UCard>
      </div>
    </main>
  </div>
</template>
