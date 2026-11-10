<script setup lang="ts">
const storeBrand = useStoreBrand()
const nuxtApp = useNuxtApp()
useSeoMeta({ title: '联系客服' })
useUncachedPublicPage()

const { data, error, status, refresh } = await useStorefrontSupport()
// The footer keeps the shared request alive between pages. Recheck on entry
// from another page so a previous success cannot stand in for a failed read.
if (import.meta.client && !nuxtApp.isHydrating) await refresh()
setPublicPageFailureStatus(error.value)

const copyMessage = ref('')
async function copyAccount(name: string, content: string) {
  copyMessage.value = ''
  try {
    await navigator.clipboard.writeText(content)
    copyMessage.value = `已复制账号：${name}`
  } catch {
    copyMessage.value = '无法自动复制，请选中账号手动复制。'
  }
}

async function retry() {
  copyMessage.value = ''
  await refresh()
}
</script>

<template>
  <main id="main-content">
    <UContainer class="max-w-3xl py-7 sm:py-10">
      <header class="mb-6">
        <p class="wrap-anywhere text-sm font-medium text-primary">
          {{ storeBrand.storeName }}
        </p>
        <h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
          联系客服
        </h1>
        <p class="mt-2 text-sm leading-6 text-muted">
          如需咨询商品、订单或售后，请通过下方方式联系商家。
        </p>
      </header>

      <p
        v-if="status === 'pending' || status === 'idle'"
        class="text-sm text-muted"
        role="status"
      >
        正在读取客服联系方式…
      </p>
      <UAlert
        v-else-if="status === 'error' || !data"
        color="error"
        variant="soft"
        title="暂时无法读取客服联系方式"
        description="请检查网络后重试。"
        role="alert"
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            class="min-h-11"
            @click="retry"
          >
            重试
          </UButton>
        </template>
      </UAlert>
      <UAlert
        v-else-if="!data.channels.length"
        color="neutral"
        variant="soft"
        icon="i-lucide-headset"
        title="店主暂未设置客服联系方式"
      />
      <ul
        v-else
        class="grid gap-3"
        aria-label="客服联系方式"
      >
        <li
          v-for="channel in data.channels"
          :key="`${channel.type}:${channel.content}`"
          class="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-default bg-elevated p-4"
        >
          <div class="min-w-0 flex-1 basis-40">
            <h2 class="wrap-anywhere font-medium text-highlighted">
              {{ channel.name }}
            </h2>
            <p
              v-if="channel.type === 'account'"
              class="mt-1 select-text wrap-anywhere whitespace-pre-wrap text-sm text-muted"
              dir="auto"
            >
              {{ channel.content }}
            </p>
          </div>
          <a
            v-if="channel.type === 'https'"
            :href="channel.content"
            target="_blank"
            rel="noopener noreferrer"
            :aria-label="`打开${channel.name}（新窗口）`"
            class="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            打开链接
            <UIcon
              name="i-lucide-external-link"
              class="size-4 shrink-0"
              aria-hidden="true"
            />
          </a>
          <UButton
            v-else
            color="neutral"
            variant="outline"
            icon="i-lucide-copy"
            :aria-label="`复制账号：${channel.name}`"
            class="min-h-11"
            @click="copyAccount(channel.name, channel.content)"
          >
            复制账号
          </UButton>
        </li>
      </ul>
      <p
        class="mt-2 text-sm text-muted empty:sr-only"
        role="status"
      >
        {{ copyMessage }}
      </p>
    </UContainer>
  </main>
</template>
