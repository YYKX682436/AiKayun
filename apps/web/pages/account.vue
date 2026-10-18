<script setup lang="ts">
import type { ApiSuccess, CustomerProfile } from '@aikayun/contracts'
import { CustomerApiError } from '~/composables/useCustomerApi'

definePageMeta({ middleware: 'customer-auth' })
useSeoMeta({ title: '个人账户' })

const customerApi = useCustomerApi()
const profileKey = computed(() => `storefront-customer-profile-${customerApi.session.value?.customer.id ?? 'anonymous'}`)
const { data: profileResponse, error: profileLoadError } = await useFetch<ApiSuccess<CustomerProfile>>(
  '/api/v1/customer/profile',
  { key: profileKey },
)
const profile = ref<CustomerProfile | null>(profileResponse.value?.data ?? null)
const profileError = ref(profileLoadError.value ? '暂时无法读取账户资料，请刷新页面重试。' : '')
const profileMessage = ref('')
const passwordError = ref('')
const passwordMessage = ref('')
const logoutError = ref('')

const email = ref('')
const phone = ref('')
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const showCurrentPassword = ref(false)
const showNewPassword = ref(false)
const profileBusy = ref(false)
const passwordBusy = ref(false)
const logoutBusy = ref(false)
const clientReady = ref(false)
email.value = profile.value?.email ?? ''
phone.value = profile.value?.phone ?? ''

onMounted(() => { clientReady.value = true })

async function saveProfile() {
  if (profileBusy.value) return
  profileBusy.value = true
  profileError.value = ''
  profileMessage.value = ''
  try {
    profile.value = await customerApi.updateProfile({
      email: email.value.trim() || null,
      phone: phone.value.trim() || null,
    })
    if (profileResponse.value) profileResponse.value.data = profile.value
    email.value = profile.value.email ?? ''
    phone.value = profile.value.phone ?? ''
    profileMessage.value = '账户资料已保存。联系方式变更后需要重新验证。'
  } catch (error) {
    profileError.value = error instanceof CustomerApiError ? error.message : '暂时无法保存资料，请稍后重试。'
  } finally {
    profileBusy.value = false
  }
}

async function savePassword() {
  if (passwordBusy.value) return
  passwordError.value = ''
  passwordMessage.value = ''
  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = '两次输入的新密码不一致。'
    return
  }

  passwordBusy.value = true
  try {
    await customerApi.changePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value })
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    passwordMessage.value = '密码已更新，其他旧会话已退出。'
  } catch (error) {
    passwordError.value = error instanceof CustomerApiError ? error.message : '暂时无法更新密码，请稍后重试。'
  } finally {
    passwordBusy.value = false
  }
}

async function logout() {
  if (logoutBusy.value) return
  logoutBusy.value = true
  logoutError.value = ''
  try {
    await customerApi.logout()
    await navigateTo('/')
  } catch (error) {
    logoutError.value = error instanceof CustomerApiError ? error.message : '暂时无法退出登录，请稍后重试。'
  } finally {
    logoutBusy.value = false
  }
}
</script>

<template>
  <UContainer class="py-8 sm:py-12">
    <main
      id="main-content"
      class="mx-auto w-full max-w-5xl"
    >
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div class="min-w-0">
          <p class="text-sm font-medium text-primary">
            顾客账户
          </p>
          <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
            个人账户
          </h1>
          <p class="mt-2 text-sm leading-6 text-muted">
            查看并更新基础资料和登录密码。
          </p>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-log-out"
          :loading="logoutBusy"
          :disabled="logoutBusy || !clientReady"
          class="min-h-11 shrink-0"
          @click="logout"
        >
          退出登录
        </UButton>
      </div>

      <UAlert
        v-if="logoutError"
        class="mt-5"
        color="error"
        variant="soft"
        :title="logoutError"
        role="alert"
        aria-live="assertive"
      />

      <section
        aria-labelledby="account-identity-title"
        class="mt-8"
      >
        <h2
          id="account-identity-title"
          class="text-xl font-semibold text-highlighted"
        >
          账户身份
        </h2>
        <UCard class="mt-4">
          <div class="grid gap-5 sm:grid-cols-2">
            <div>
              <p class="text-sm text-muted">
                用户名
              </p>
              <p class="mt-1 break-all font-medium text-highlighted">
                {{ profile?.username }}
              </p>
            </div>
            <div>
              <p class="text-sm text-muted">
                注册时间
              </p>
              <p class="mt-1 font-medium text-highlighted">
                <time
                  v-if="profile"
                  :datetime="profile.createdAt"
                >{{ profile.createdAt.slice(0, 10) }}</time>
              </p>
            </div>
          </div>
        </UCard>
      </section>

      <div class="mt-8 grid min-w-0 gap-6 lg:grid-cols-2">
        <section
          aria-labelledby="contact-title"
          class="min-w-0"
        >
          <h2
            id="contact-title"
            class="text-xl font-semibold text-highlighted"
          >
            联系方式
          </h2>
          <UCard class="mt-4 h-full">
            <p class="mb-5 text-sm leading-6 text-muted">
              未验证的邮箱或手机号不能用于找回密码。本阶段尚未开放联系方式验证和密码找回。
            </p>

            <UAlert
              v-if="profileError"
              class="mb-5"
              color="error"
              variant="soft"
              :title="profileError"
              role="alert"
              aria-live="assertive"
            />
            <UAlert
              v-if="profileMessage"
              class="mb-5"
              color="success"
              variant="soft"
              :title="profileMessage"
              role="status"
              aria-live="polite"
            />

            <form
              class="grid gap-5"
              @submit.prevent="saveProfile"
            >
              <UFormField
                label="邮箱"
                name="email"
                :hint="profile?.emailVerifiedAt ? '已验证' : '未验证'"
              >
                <UInput
                  v-model="email"
                  type="email"
                  inputmode="email"
                  class="w-full"
                  size="lg"
                  autocomplete="email"
                  maxlength="254"
                  :disabled="profileBusy || !profile || !clientReady"
                />
              </UFormField>
              <UFormField
                label="手机号"
                name="phone"
                :hint="profile?.phoneVerifiedAt ? '已验证' : '未验证'"
              >
                <UInput
                  v-model="phone"
                  type="tel"
                  inputmode="tel"
                  class="w-full"
                  size="lg"
                  autocomplete="tel"
                  minlength="7"
                  maxlength="32"
                  pattern="\+?[0-9][0-9 ()-]{5,30}[0-9]"
                  :disabled="profileBusy || !profile || !clientReady"
                />
              </UFormField>
              <UButton
                type="submit"
                size="lg"
                block
                :loading="profileBusy"
                :disabled="profileBusy || !profile || !clientReady"
              >
                保存联系方式
              </UButton>
            </form>
          </UCard>
        </section>

        <section
          aria-labelledby="password-title"
          class="min-w-0"
        >
          <h2
            id="password-title"
            class="text-xl font-semibold text-highlighted"
          >
            修改密码
          </h2>
          <UCard class="mt-4 h-full">
            <p class="mb-5 text-sm leading-6 text-muted">
              新密码为 12～128 位。保存后其他登录设备会退出，当前设备会继续登录。
            </p>

            <UAlert
              v-if="passwordError"
              class="mb-5"
              color="error"
              variant="soft"
              :title="passwordError"
              role="alert"
              aria-live="assertive"
            />
            <UAlert
              v-if="passwordMessage"
              class="mb-5"
              color="success"
              variant="soft"
              :title="passwordMessage"
              role="status"
              aria-live="polite"
            />

            <form
              class="grid gap-5"
              @submit.prevent="savePassword"
            >
              <UFormField
                label="当前密码"
                name="currentPassword"
                required
              >
                <div class="flex min-w-0 items-center gap-2">
                  <UInput
                    v-model="currentPassword"
                    class="min-w-0 flex-1"
                    size="lg"
                    :type="showCurrentPassword ? 'text' : 'password'"
                    autocomplete="current-password"
                    maxlength="128"
                    required
                    :disabled="passwordBusy || !clientReady"
                  />
                  <UButton
                    type="button"
                    color="neutral"
                    variant="outline"
                    :icon="showCurrentPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    :aria-label="showCurrentPassword ? '隐藏当前密码' : '显示当前密码'"
                    :aria-pressed="showCurrentPassword"
                    class="min-h-11 min-w-11 justify-center"
                    :disabled="passwordBusy || !clientReady"
                    @click="showCurrentPassword = !showCurrentPassword"
                  />
                </div>
              </UFormField>
              <UFormField
                label="新密码"
                name="newPassword"
                required
              >
                <div class="flex min-w-0 items-center gap-2">
                  <UInput
                    v-model="newPassword"
                    class="min-w-0 flex-1"
                    size="lg"
                    :type="showNewPassword ? 'text' : 'password'"
                    autocomplete="new-password"
                    minlength="12"
                    maxlength="128"
                    required
                    :disabled="passwordBusy || !clientReady"
                  />
                  <UButton
                    type="button"
                    color="neutral"
                    variant="outline"
                    :icon="showNewPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    :aria-label="showNewPassword ? '隐藏新密码' : '显示新密码'"
                    :aria-pressed="showNewPassword"
                    class="min-h-11 min-w-11 justify-center"
                    :disabled="passwordBusy || !clientReady"
                    @click="showNewPassword = !showNewPassword"
                  />
                </div>
              </UFormField>
              <UFormField
                label="确认新密码"
                name="confirmPassword"
                required
              >
                <UInput
                  v-model="confirmPassword"
                  class="w-full"
                  size="lg"
                  :type="showNewPassword ? 'text' : 'password'"
                  autocomplete="new-password"
                  minlength="12"
                  maxlength="128"
                  required
                  :disabled="passwordBusy || !clientReady"
                />
              </UFormField>
              <UButton
                type="submit"
                size="lg"
                block
                :loading="passwordBusy"
                :disabled="passwordBusy || !profile || !clientReady"
              >
                更新密码
              </UButton>
            </form>
          </UCard>
        </section>
      </div>
    </main>
  </UContainer>
</template>
