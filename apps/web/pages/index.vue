<script setup lang="ts">
const storeBrand = useStoreBrand()

useSeoMeta({ title: '店铺首页' })
</script>

<template>
  <main id="main-content">
    <section aria-labelledby="store-title">
      <UContainer class="py-14 sm:py-20 lg:py-24">
        <UBadge
          color="primary"
          variant="soft"
          size="md"
          icon="i-lucide-store"
        >
          店铺首页
        </UBadge>

        <h1
          id="store-title"
          class="mt-6 max-w-4xl break-words text-[2rem] font-semibold leading-tight text-highlighted sm:text-5xl lg:text-6xl"
        >
          <span class="text-primary">{{ storeBrand.storeName }}</span>
        </h1>
        <p class="mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg sm:leading-8">
          欢迎来到 {{ storeBrand.storeName }}。这里会展示店铺当前可浏览的内容。
        </p>
      </UContainer>
    </section>

    <section
      aria-labelledby="store-content-title"
      class="border-y border-default bg-elevated"
    >
      <UContainer class="py-10 sm:py-14">
        <div class="max-w-2xl">
          <p class="text-sm font-medium text-muted">
            店铺内容
          </p>
          <h2
            id="store-content-title"
            class="mt-1 text-2xl font-semibold text-highlighted"
          >
            商品展示
          </h2>
        </div>

        <UEmpty
          icon="i-lucide-package-open"
          title="暂无可展示的商品"
          description="店铺正在准备中，目前还没有可以浏览的商品。"
          variant="naked"
          size="lg"
          class="mt-6 min-h-52"
        />
      </UContainer>
    </section>
  </main>
</template>
