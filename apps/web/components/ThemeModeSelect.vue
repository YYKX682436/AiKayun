<script setup lang="ts">
import { computed } from 'vue'

const colorMode = useColorMode()
type ModePreference = 'system' | 'light' | 'dark'
interface ModeOption {
  label: string
  value: ModePreference
  icon: string
}

const systemOption: ModeOption = { label: '跟随系统', value: 'system', icon: 'i-lucide-monitor' }
const options: ModeOption[] = [
  systemOption,
  { label: '浅色', value: 'light', icon: 'i-lucide-sun' },
  { label: '深色', value: 'dark', icon: 'i-lucide-moon' },
]

const preference = computed<ModeOption>({
  get: () => options.find(option => option.value === colorMode.preference) ?? systemOption,
  set: (option: ModeOption) => colorMode.preference = option.value,
})
</script>

<template>
  <ClientOnly>
    <USelectMenu
      v-model="preference"
      :icon="preference.icon"
      :items="options"
      :search-input="false"
      aria-label="显示模式"
      title="显示模式"
      size="sm"
      class="min-h-11 min-w-[6.5rem]"
    />

    <template #fallback>
      <USelectMenu
        :model-value="systemOption"
        :icon="systemOption.icon"
        :items="options"
        :search-input="false"
        aria-label="显示模式"
        title="显示模式"
        size="sm"
        class="min-h-11 min-w-[6.5rem]"
        disabled
      />
    </template>
  </ClientOnly>
</template>
