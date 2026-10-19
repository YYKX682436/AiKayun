<script setup lang="ts">
import type { ApiSuccess, StorefrontCustomerPolicy } from '@aikayun/contracts'
import { CustomerApiError } from '~/composables/useCustomerApi'

useSeoMeta({ title: '创建顾客账户', description: '创建商城顾客账户。' })

const customerApi = useCustomerApi()
const route = useRoute()
const { data: policyResponse, error: policyLoadError, pending: policyPending } = await useFetch<ApiSuccess<StorefrontCustomerPolicy>>(
  '/api/v1/public/storefront/customer-policy',
  { key: 'storefront-registration-policy' },
)
const policy = computed(() => policyResponse.value?.data ?? null)

const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const email = ref('')
const phone = ref('')
const showPasswords = ref(false)
const busy = ref(false)
const errorMessage = ref('')
const usernameError = ref('')
const confirmError = ref('')
const clientReady = ref(false)

onMounted(() => { clientReady.value = true })

const redirectPath = computed(() => {
  const requested = route.query.redirect
  if (typeof requested !== 'string' || !requested.startsWith('/') || requested.startsWith('//') || requested.includes('\\')) {
    return '/account'
  }
  return requested
})

async function submitRegistration() {
  if (busy.value || !policy.value) return
  errorMessage.value = ''
  usernameError.value = ''
  confirmError.value = ''
  if (password.value !== confirmPassword.value) {
    confirmError.value = '两次输入的密码不一致。'
    return
  }

  busy.value = true
  try {
    await customerApi.register({
      username: username.value,
      password: password.value,
      ...(email.value.trim() ? { email: email.value.trim() } : {}),
      ...(phone.value.trim() ? { phone: phone.value.trim() } : {}),
    })
    await navigateTo(redirectPath.value)
  } catch (error) {
    if (error instanceof CustomerApiError && error.code === 'USERNAME_TAKEN') {
      usernameError.value = error.message
    } else {
      errorMessage.value = error instanceof CustomerApiError ? error.message : '暂时无法创建账户，请稍后重试。'
    }
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
              加入商城
            </p>
            <h1 class="mt-3 text-3xl font-semibold tracking-tight text-highlighted sm:text-4xl">
              创建顾客账户
            </h1>
            <p class="mt-4 max-w-md text-base leading-7 text-muted">
              用户名和密码用于登录。联系方式只会按店铺要求收集，填写联系方式不会代表已完成验证。
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
              注册信息
            </h2>
            <p class="mt-2 text-sm leading-6 text-muted">
              用户名不区分大小写；密码至少 12 位，最多 128 位。
            </p>
          </div>

          <UAlert
            v-if="policyLoadError"
            class="mb-5"
            color="error"
            variant="soft"
            title="暂时无法读取注册规则，请稍后刷新重试。"
            role="alert"
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
            class="grid gap-4"
            method="post"
            action="/api/v1/customer/auth/register"
            :data-customer-register-ready="clientReady"
            :aria-busy="busy"
            @submit.prevent="submitRegistration"
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
                pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,31}"
                aria-describedby="username-help"
                required
                :disabled="busy || policyPending || !policy || !clientReady"
              />
              <template #description>
                <span id="username-help">3～32 位字母、数字、下划线、点或连字符，首位须为字母或数字。</span>
              </template>
              <template
                v-if="usernameError"
                #error
              >
                <span role="alert">{{ usernameError }}</span>
              </template>
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
                  :type="showPasswords ? 'text' : 'password'"
                  autocomplete="new-password"
                  minlength="12"
                  maxlength="128"
                  required
                  :disabled="busy || policyPending || !policy || !clientReady"
                />
                <UButton
                  type="button"
                  color="neutral"
                  variant="outline"
                  :icon="showPasswords ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  :aria-label="showPasswords ? '隐藏密码' : '显示密码'"
                  :aria-pressed="showPasswords"
                  class="min-h-11 min-w-11 justify-center"
                  :disabled="busy || !clientReady"
                  @click="showPasswords = !showPasswords"
                />
              </div>
            </UFormField>

            <UFormField
              label="确认密码"
              name="confirmPassword"
              required
            >
              <UInput
                v-model="confirmPassword"
                class="w-full"
                size="lg"
                name="confirmPassword"
                :type="showPasswords ? 'text' : 'password'"
                autocomplete="new-password"
                minlength="12"
                maxlength="128"
                required
                :disabled="busy || policyPending || !policy || !clientReady"
              />
              <template
                v-if="confirmError"
                #error
              >
                <span role="alert">{{ confirmError }}</span>
              </template>
            </UFormField>

            <UFormField
              label="邮箱"
              name="email"
              :required="policy?.requireEmail"
              :hint="policy?.requireEmail ? '必填' : '选填'"
            >
              <UInput
                v-model="email"
                type="email"
                inputmode="email"
                class="w-full"
                size="lg"
                name="email"
                autocomplete="email"
                maxlength="254"
                :required="policy?.requireEmail"
                :disabled="busy || policyPending || !policy || !clientReady"
              />
            </UFormField>

            <UFormField
              label="手机号"
              name="phone"
              :required="policy?.requirePhone"
              :hint="policy?.requirePhone ? '必填' : '选填'"
            >
              <UInput
                v-model="phone"
                type="tel"
                inputmode="tel"
                class="w-full"
                size="lg"
                name="phone"
                autocomplete="tel"
                minlength="7"
                maxlength="32"
                pattern="\+?[0-9][0-9 ()-]{5,30}[0-9]"
                :required="policy?.requirePhone"
                :disabled="busy || policyPending || !policy || !clientReady"
              />
            </UFormField>

            <UButton
              type="submit"
              size="lg"
              block
              :loading="busy"
              :disabled="busy || policyPending || !policy || !clientReady"
            >
              创建账户
            </UButton>
          </form>

          <p class="mt-6 text-center text-sm leading-6 text-muted">
            已经有账户？
            <NuxtLink
              to="/login"
              class="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              登录
            </NuxtLink>
          </p>
        </section>
      </div>
    </main>
  </UContainer>
</template>
