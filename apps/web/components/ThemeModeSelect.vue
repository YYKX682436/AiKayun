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
      class="min-h-11 w-9 min-w-9 sm:w-auto sm:min-w-[6.5rem]"
      :ui="{
        base: 'justify-center ps-2 pe-2 sm:ps-8 sm:pe-8 min-w-9 w-9 sm:w-auto',
        value: 'hidden sm:inline',
        trailing: 'hidden sm:inline-flex',
        leading: 'inset-y-0 start-0 flex items-center sm:absolute sm:ps-2.5',
      }"
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
        class="min-h-11 w-9 min-w-9 sm:w-auto sm:min-w-[6.5rem]"
        :ui="{
          base: 'justify-center ps-2 pe-2 sm:ps-8 sm:pe-8 min-w-9 w-9 sm:w-auto',
          value: 'hidden sm:inline',
          trailing: 'hidden sm:inline-flex',
          leading: 'inset-y-0 start-0 flex items-center sm:absolute sm:ps-2.5',
        }"
        disabled
      />
    </template>
  </ClientOnly>
</template>
