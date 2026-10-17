<script setup lang="ts">
import type { ProductGalleryImage, ProductRichContent } from '@aikayun/contracts'
import type { Editor } from '@tiptap/core'
import { Image } from '@tiptap/extension-image'
import Blockquote from '@tiptap/extension-blockquote'
import Bold from '@tiptap/extension-bold'
import BulletList from '@tiptap/extension-bullet-list'
import Heading from '@tiptap/extension-heading'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import Italic from '@tiptap/extension-italic'
import Link from '@tiptap/extension-link'
import ListItem from '@tiptap/extension-list-item'
import OrderedList from '@tiptap/extension-ordered-list'

const props = defineProps<{
  modelValue: ProductRichContent
  gallery: ProductGalleryImage[]
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [content: ProductRichContent] }>()

const selectedMediaId = ref(props.gallery[0]?.id ?? '')
const linkUrl = ref('')
type EditorCommands = Pick<Editor, 'chain' | 'isActive'>
const editorComponent = ref<{ editor?: EditorCommands } | null>(null)

watch(() => props.gallery, (gallery) => {
  if (!gallery.some(image => image.id === selectedMediaId.value)) selectedMediaId.value = gallery[0]?.id ?? ''
}, { deep: true })

const MediaImage = Image.extend({
  addAttributes() {
    return {
      mediaId: {
        default: null,
        parseHTML: element => element.getAttribute('data-media-id'),
        renderHTML: attributes => attributes.mediaId ? { 'data-media-id': attributes.mediaId } : {},
      },
      alt: {
        default: '',
        parseHTML: element => element.getAttribute('alt') ?? '',
        renderHTML: attributes => ({ alt: attributes.alt ?? '' }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'img[data-media-id]' }]
  },
  renderHTML({ node }) {
    const mediaId = String(node.attrs.mediaId ?? '')
    return ['img', {
      'data-media-id': mediaId,
      src: `/api/v1/media/${mediaId}/detail.webp`,
      alt: String(node.attrs.alt ?? ''),
      loading: 'lazy',
    }]
  },
})

const ProductLink = Link.extend({
  addAttributes() {
    return {
      href: { default: null },
      target: { default: null },
    }
  },
})

const editorExtensions = [
  Bold,
  Italic,
  Heading.configure({ levels: [1, 2, 3] }),
  Blockquote,
  BulletList,
  OrderedList,
  ListItem,
  HorizontalRule,
  ProductLink.configure({ openOnClick: false, autolink: false, linkOnPaste: false }),
  MediaImage.configure({ inline: false, allowBase64: false }),
]

function cleanLinkAttrs(attrs: Record<string, unknown>) {
  const output: Record<string, unknown> = {}
  if (typeof attrs.href === 'string') output.href = attrs.href
  if (attrs.target === '_blank' || attrs.target === '_self') output.target = attrs.target
  return output
}

function cleanNode(input: Record<string, unknown>): Record<string, unknown> {
  const type = String(input.type ?? '')
  if (type === 'text') {
    const result: Record<string, unknown> = { type, text: String(input.text ?? '') }
    if (Array.isArray(input.marks)) {
      const marks = input.marks.flatMap((mark) => {
        if (!mark || typeof mark !== 'object') return []
        const value = mark as Record<string, unknown>
        if (value.type === 'bold' || value.type === 'italic') return [{ type: value.type }]
        if (value.type === 'link' && value.attrs && typeof value.attrs === 'object') {
          return [{ type: 'link', attrs: cleanLinkAttrs(value.attrs as Record<string, unknown>) }]
        }
        return []
      })
      if (marks.length) result.marks = marks
    }
    return result
  }
  if (type === 'image') {
    const attrs = (input.attrs && typeof input.attrs === 'object' ? input.attrs : {}) as Record<string, unknown>
    return { type, attrs: {
      mediaId: String(attrs.mediaId ?? ''),
      ...(typeof attrs.alt === 'string' && attrs.alt.length ? { alt: attrs.alt } : {}),
    } }
  }
  if (type === 'heading') {
    const attrs = (input.attrs && typeof input.attrs === 'object' ? input.attrs : {}) as Record<string, unknown>
    return {
      type,
      attrs: { level: Number(attrs.level) },
      ...(Array.isArray(input.content) ? { content: input.content.map(child => cleanNode(child as Record<string, unknown>)) } : {}),
    }
  }
  if (type === 'orderedList') {
    const attrs = (input.attrs && typeof input.attrs === 'object' ? input.attrs : {}) as Record<string, unknown>
    return {
      type,
      ...(Number.isInteger(attrs.start) && Number(attrs.start) > 1 ? { attrs: { start: Number(attrs.start) } } : {}),
      content: Array.isArray(input.content) ? input.content.map(child => cleanNode(child as Record<string, unknown>)) : [],
    }
  }
  if (type === 'doc' || type === 'paragraph' || type === 'blockquote' || type === 'bulletList' || type === 'listItem') {
    return {
      type,
      ...(Array.isArray(input.content) ? { content: input.content.map(child => cleanNode(child as Record<string, unknown>)) } : {}),
    }
  }
  if (type === 'hardBreak' || type === 'horizontalRule') return { type }
  return { type }
}

function normalizedDocument(value: unknown): ProductRichContent {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    type: 'doc',
    content: Array.isArray(root.content)
      ? root.content.map(child => cleanNode(child as Record<string, unknown>))
      : [{ type: 'paragraph' }],
  } as ProductRichContent
}

function updateContent(value: unknown) {
  emit('update:modelValue', normalizedDocument(value))
}

function editorAction(action: (editor: EditorCommands) => void) {
  const editor = editorComponent.value?.editor
  if (editor && !props.disabled) action(editor)
}

function editorActive(name: string, attrs?: Record<string, unknown>) {
  return editorComponent.value?.editor?.isActive(name, attrs) ?? false
}

function applyLink() {
  const href = linkUrl.value.trim()
  if (href) editorAction(editor => editor.chain().focus().extendMarkRange('link').setLink({ href }).run())
}

function insertSelectedImage() {
  if (!selectedMediaId.value) return
  editorAction(editor => editor.chain().focus().insertContent({
    type: 'image', attrs: { mediaId: selectedMediaId.value, alt: '' },
  }).run())
}

</script>

<template>
  <div class="min-w-0 overflow-hidden rounded-lg border border-default bg-elevated">
    <div
      class="flex flex-wrap items-center gap-1 border-b border-default bg-muted/30 p-2"
      role="toolbar"
      aria-label="图文详情格式工具"
    >
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-bold"
        aria-label="加粗"
        :aria-pressed="editorActive('bold')"
        :disabled="disabled"
        @click="editorAction(editor => editor.chain().focus().toggleBold().run())"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-italic"
        aria-label="斜体"
        :aria-pressed="editorActive('italic')"
        :disabled="disabled"
        @click="editorAction(editor => editor.chain().focus().toggleItalic().run())"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-heading-1"
        aria-label="标题一级"
        :aria-pressed="editorActive('heading', { level: 1 })"
        :disabled="disabled"
        @click="editorAction(editor => editor.chain().focus().toggleHeading({ level: 1 }).run())"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-heading-2"
        aria-label="标题二级"
        :aria-pressed="editorActive('heading', { level: 2 })"
        :disabled="disabled"
        @click="editorAction(editor => editor.chain().focus().toggleHeading({ level: 2 }).run())"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-list"
        aria-label="无序列表"
        :aria-pressed="editorActive('bulletList')"
        :disabled="disabled"
        @click="editorAction(editor => editor.chain().focus().toggleBulletList().run())"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-list-ordered"
        aria-label="有序列表"
        :aria-pressed="editorActive('orderedList')"
        :disabled="disabled"
        @click="editorAction(editor => editor.chain().focus().toggleOrderedList().run())"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-text-quote"
        aria-label="引用"
        :aria-pressed="editorActive('blockquote')"
        :disabled="disabled"
        @click="editorAction(editor => editor.chain().focus().toggleBlockquote().run())"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-minus"
        aria-label="插入分隔线"
        :disabled="disabled"
        @click="editorAction(editor => editor.chain().focus().setHorizontalRule().run())"
      />
      <span
        class="mx-1 hidden h-6 border-l border-default sm:inline-block"
        aria-hidden="true"
      />
      <UInput
        v-model="linkUrl"
        aria-label="链接地址"
        type="url"
        placeholder="https://…"
        size="sm"
        class="min-w-36 flex-1 sm:max-w-56"
        :disabled="disabled"
        @keydown.enter.prevent="applyLink"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        :disabled="disabled || !linkUrl.trim()"
        @click="applyLink"
      >
        添加链接
      </UButton>
      <USelect
        v-model="selectedMediaId"
        :items="gallery.map(image => ({ label: `图片 ${image.sortOrder + 1} · ${image.id.slice(0, 8)}`, value: image.id }))"
        aria-label="选择要插入的商品图片"
        placeholder="选择商品图片"
        size="sm"
        class="min-w-40 max-w-full"
        :disabled="disabled || gallery.length === 0"
      />
      <UButton
        size="sm"
        color="primary"
        variant="outline"
        icon="i-lucide-image-plus"
        :disabled="disabled || gallery.length === 0 || !selectedMediaId"
        @click="insertSelectedImage"
      >
        插入图片
      </UButton>
    </div>
    <UEditor
      ref="editorComponent"
      :model-value="modelValue"
      content-type="json"
      :starter-kit="false"
      :image="false"
      :mention="false"
      :extensions="editorExtensions"
      :editable="!disabled"
      placeholder="编写商品图文详情…"
      class="min-w-0"
      @update:model-value="updateContent"
    />
  </div>
</template>
