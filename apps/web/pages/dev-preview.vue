<script setup lang="ts">
if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
}

definePageMeta({ layout: false })

const storeBrand = useStoreBrand()
const sampleEmail = ref('sample@example.com')

useSeoMeta({ title: '设计系统预览' })
</script>

<template>
  <div class="min-h-dvh bg-default">
    <NuxtLink
      to="#preview-main"
      class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-elevated focus:px-4 focus:py-3 focus:text-highlighted focus:shadow-lg"
    >
      跳转到预览内容
    </NuxtLink>

    <header class="border-b border-default bg-elevated">
      <UContainer class="flex min-h-16 items-center justify-between gap-4 py-2">
        <div class="min-w-0">
          <p class="text-sm font-medium text-primary">
            开发环境
          </p>
          <p class="truncate font-semibold text-highlighted">
            设计系统预览
          </p>
        </div>
        <ThemeModeSelect />
      </UContainer>
    </header>

    <main
      id="preview-main"
      class="mx-auto grid w-full max-w-7xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-2 lg:gap-8 lg:px-8"
    >
      <section
        aria-labelledby="color-samples-title"
        class="grid content-start gap-4"
      >
        <UCard>
          <h1
            id="color-samples-title"
            class="text-xl font-semibold text-highlighted"
          >
            品牌与语义颜色
          </h1>
          <p class="mt-1 text-sm text-muted">
            当前店铺品牌色：{{ storeBrand.storeBrandColor }}
          </p>
          <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div class="rounded-lg border border-default bg-primary p-3 text-inverted">
              <p class="font-medium">
                品牌主色
              </p>
              <p class="mt-1 text-xs opacity-90">
                primary
              </p>
            </div>
            <div class="rounded-lg border border-default bg-success/10 p-3 text-success">
              <p class="font-medium">
                成功
              </p>
              <p class="mt-1 text-xs">
                success
              </p>
            </div>
            <div class="rounded-lg border border-default bg-warning/10 p-3 text-warning">
              <p class="font-medium">
                等待处理
              </p>
              <p class="mt-1 text-xs">
                warning
              </p>
            </div>
            <div class="rounded-lg border border-default bg-error/10 p-3 text-error">
              <p class="font-medium">
                需要处理
              </p>
              <p class="mt-1 text-xs">
                error
              </p>
            </div>
          </div>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg border border-default bg-default p-4">
              <p class="font-medium text-highlighted">
                页面背景与主要文字
              </p>
              <p class="mt-1 text-sm text-muted">
                次要说明使用 muted 文字。
              </p>
            </div>
            <div class="rounded-lg border border-default bg-elevated p-4">
              <p class="font-medium text-highlighted">
                提升表面
              </p>
              <p class="mt-1 text-sm text-muted">
                卡片和浮层使用 elevated 背景。
              </p>
            </div>
          </div>
        </UCard>

        <UCard>
          <h2 class="text-lg font-semibold text-highlighted">
            标签、通知与空状态
          </h2>
          <div class="mt-4 flex flex-wrap gap-2">
            <UBadge
              color="primary"
              variant="soft"
            >
              品牌
            </UBadge>
            <UBadge
              color="success"
              variant="soft"
              icon="i-lucide-circle-check"
            >
              已完成
            </UBadge>
            <UBadge
              color="warning"
              variant="soft"
              icon="i-lucide-clock-3"
            >
              等待处理
            </UBadge>
          </div>
          <div class="mt-4 grid gap-3">
            <UAlert
              color="info"
              variant="soft"
              icon="i-lucide-info"
              title="信息提示样例"
              description="状态同时提供图标与文字说明。"
            />
            <UAlert
              color="error"
              variant="soft"
              icon="i-lucide-circle-alert"
              title="错误反馈样例"
              description="此预览不连接或修改业务数据。"
            />
          </div>
          <UEmpty
            icon="i-lucide-inbox"
            title="空状态样例"
            description="页面没有可展示内容时，在这里说明当前状态。"
            variant="naked"
            class="mt-5 min-h-36 rounded-lg border border-dashed border-default"
          />
        </UCard>
      </section>

      <section
        aria-labelledby="component-samples-title"
        class="grid content-start gap-4"
      >
        <UCard>
          <h2
            id="component-samples-title"
            class="text-xl font-semibold text-highlighted"
          >
            按钮与输入框
          </h2>
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <UButton icon="i-lucide-check">
              主要操作
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
            >
              次要操作
            </UButton>
            <UButton
              color="error"
              variant="soft"
            >
              危险状态
            </UButton>
            <UButton
              loading
              disabled
            >
              提交中
            </UButton>
            <UButton disabled>
              不可用
            </UButton>
          </div>
          <div class="mt-5 grid gap-4">
            <UFormField
              label="邮箱输入"
              name="sample-email"
              description="带有可见标签与说明。"
            >
              <UInput
                v-model="sampleEmail"
                type="email"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="错误输入"
              name="sample-error"
              error="请检查输入内容。"
            >
              <UInput
                type="email"
                value="invalid-value"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="禁用输入"
              name="sample-disabled"
            >
              <UInput
                value="当前不可编辑"
                disabled
                class="w-full"
              />
            </UFormField>
          </div>
        </UCard>

        <UCard>
          <h2 class="text-lg font-semibold text-highlighted">
            加载状态样例
          </h2>
          <p class="mt-1 text-sm text-muted">
            使用骨架占位表达加载中的内容区域。
          </p>
          <div
            class="mt-4 grid gap-3"
            aria-label="加载中的内容"
          >
            <USkeleton class="h-4 w-2/3" />
            <USkeleton class="h-4 w-full" />
            <USkeleton class="h-24 w-full rounded-lg" />
          </div>
        </UCard>
      </section>
    </main>
  </div>
</template>
