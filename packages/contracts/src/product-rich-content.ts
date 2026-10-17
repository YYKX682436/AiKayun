import type { ProductRichContent } from './index.js'

export const EMPTY_PRODUCT_RICH_CONTENT: ProductRichContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
}

export const MAX_RICH_CONTENT_BYTES = 128 * 1024
export const MAX_RICH_CONTENT_TEXT = 50_000
export const MAX_RICH_CONTENT_NODES = 500
export const MAX_RICH_CONTENT_DEPTH = 20
export const MAX_RICH_CONTENT_IMAGES = 100

export interface ValidatedProductRichContent {
  document: ProductRichContent
  mediaIds: string[]
  summary: {
    byteLength: number
    textLength: number
    nodeCount: number
    mediaCount: number
  }
}

type JsonObject = Record<string, unknown>
type RichNode = Record<string, unknown>

export class ProductRichContentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductRichContentValidationError'
  }
}

function invalid(message: string): never {
  throw new ProductRichContentValidationError(message)
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: JsonObject, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`Rich content is missing the ${key} field`)
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalid('Rich content contains an unsupported field')
  }
}

function safeHref(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048
    || Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x20 || code === 0x7f
    })) {
    invalid('A rich content link has an invalid URL')
  }
  if (value.startsWith('/') && !value.startsWith('//')) {
    if (value.includes('\\')) invalid('A rich content link has an invalid URL')
    const local = new URL(value, 'https://aikayun.invalid')
    if (local.origin !== 'https://aikayun.invalid') invalid('A rich content link must remain on the current site')
    return value
  }
  if (value.startsWith('#')) return value
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    invalid('A rich content link has an invalid URL')
  }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
    invalid('Rich content links may use only HTTP, HTTPS, mailto, or tel URLs')
  }
  return value
}

function validateLinkAttrs(value: unknown): JsonObject {
  if (!object(value)) invalid('A rich content link has invalid attributes')
  exactKeys(value, ['href'], ['target', 'rel', 'class'])
  const href = safeHref(value.href)
  const target = value.target
  if (target !== undefined && target !== null && target !== '_blank' && target !== '_self') {
    invalid('A rich content link has an unsupported target')
  }
  const rel = value.rel
  if (rel !== undefined && rel !== null && rel !== 'noopener noreferrer nofollow') {
    invalid('A rich content link has an unsupported rel attribute')
  }
  if (value.class !== undefined && value.class !== null) {
    invalid('Rich content links cannot set a CSS class')
  }
  return {
    href,
    ...(target === undefined ? {} : { target }),
  }
}

function validateMarks(value: unknown): Array<{ type: string; attrs?: JsonObject }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 3) invalid('Rich content text has invalid marks')
  const seen = new Set<string>()
  return value.map((mark) => {
    if (!object(mark) || typeof mark.type !== 'string') invalid('Rich content contains an invalid mark')
    if (seen.has(mark.type)) invalid('A rich content mark cannot be repeated')
    seen.add(mark.type)
    if (mark.type === 'bold' || mark.type === 'italic') {
      exactKeys(mark, ['type'])
      return { type: mark.type }
    }
    if (mark.type === 'link') {
      exactKeys(mark, ['type', 'attrs'])
      return { type: 'link', attrs: validateLinkAttrs(mark.attrs) }
    }
    invalid('Rich content contains an unsupported mark')
  })
}

function canonicalDocument(root: unknown): ValidatedProductRichContent {
  if (!object(root)) invalid('Rich content must be a Tiptap JSON document')
  exactKeys(root, ['type', 'content'])
  if (root.type !== 'doc' || !Array.isArray(root.content)) {
    invalid('Rich content must use a Tiptap doc root with a content array')
  }

  let nodeCount = 0
  let textLength = 0
  let imageCount = 0
  const mediaIds = new Set<string>()
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  const visit = (value: unknown, depth: number, context: 'block' | 'inline' | 'list-item'): RichNode => {
    if (depth > MAX_RICH_CONTENT_DEPTH) invalid('Rich content nesting is too deep')
    if (!object(value) || typeof value.type !== 'string') invalid('Rich content contains an invalid node')
    nodeCount += 1
    if (nodeCount >= MAX_RICH_CONTENT_NODES) invalid('Rich content contains too many nodes')

    const type = value.type
    const children = value.content
    const marks = value.marks
    const visitChildren = (required: boolean, childContext: 'block' | 'inline' | 'list-item'): RichNode[] | undefined => {
      if (children === undefined && !required) return undefined
      if (!Array.isArray(children) || (required && children.length === 0)) {
        invalid('Rich content has an invalid or empty node structure')
      }
      return children.map((child) => visit(child, depth + 1, childContext))
    }

    if (type === 'text') {
      if (context !== 'inline') invalid('Text nodes must appear inside text blocks')
      exactKeys(value, ['type', 'text'], ['marks'])
      if (typeof value.text !== 'string' || value.text.length === 0) invalid('Rich text nodes must contain text')
      textLength += value.text.length
      if (textLength > MAX_RICH_CONTENT_TEXT) invalid('Rich content text is too long')
      const validMarks = validateMarks(marks)
      return { type, text: value.text, ...(validMarks === undefined ? {} : { marks: validMarks }) }
    }

    if (type === 'hardBreak') {
      if (context !== 'inline') invalid('Hard breaks must appear inside text blocks')
      exactKeys(value, ['type'], ['marks'])
      const validMarks = validateMarks(marks)
      return { type, ...(validMarks === undefined ? {} : { marks: validMarks }) }
    }

    if (type === 'image') {
      if (context !== 'block') invalid('Product images must be block nodes')
      exactKeys(value, ['type', 'attrs'])
      if (!object(value.attrs)) invalid('A product image must reference a media identity')
      exactKeys(value.attrs, ['mediaId'], ['alt'])
      const mediaId = value.attrs.mediaId
      if (typeof mediaId !== 'string' || !uuidPattern.test(mediaId)) {
        invalid('A product image must reference a valid media UUID')
      }
      const alt = value.attrs.alt
      if (alt !== undefined && (typeof alt !== 'string' || alt.length > 200)) {
        invalid('Product image alt text must be at most 200 characters')
      }
      imageCount += 1
      if (imageCount > MAX_RICH_CONTENT_IMAGES) invalid('Rich content contains too many images')
      mediaIds.add(mediaId.toLowerCase())
      return { type, attrs: { mediaId: mediaId.toLowerCase(), ...(alt === undefined ? {} : { alt }) } }
    }

    if (type === 'paragraph') {
      if (context !== 'block' && context !== 'list-item') invalid('Paragraphs must be block nodes')
      exactKeys(value, ['type'], ['content'])
      const content = visitChildren(false, 'inline')
      return { type, ...(content ? { content } : {}) }
    }

    if (type === 'heading') {
      if (context !== 'block' && context !== 'list-item') invalid('Headings must be block nodes')
      exactKeys(value, ['type', 'attrs'], ['content'])
      if (!object(value.attrs)) invalid('A heading has invalid attributes')
      exactKeys(value.attrs, ['level'])
      if (![1, 2, 3].includes(value.attrs.level as number)) invalid('Heading levels must be between 1 and 3')
      const content = visitChildren(false, 'inline')
      return { type, attrs: { level: value.attrs.level }, ...(content ? { content } : {}) }
    }

    if (type === 'horizontalRule') {
      if (context !== 'block' && context !== 'list-item') invalid('Separators must be block nodes')
      exactKeys(value, ['type'])
      return { type }
    }

    if (type === 'blockquote') {
      if (context !== 'block' && context !== 'list-item') invalid('Quotes must be block nodes')
      exactKeys(value, ['type', 'content'])
      return { type, content: visitChildren(true, 'block')! }
    }

    if (type === 'bulletList' || type === 'orderedList') {
      if (context !== 'block' && context !== 'list-item') invalid('Lists must be block nodes')
      exactKeys(value, ['type', 'content'], type === 'orderedList' ? ['attrs'] : [])
      if (type === 'bulletList' && value.attrs !== undefined) invalid('Bullet lists do not accept attributes')
      const content = visitChildren(true, 'list-item')!
      if (content.some((child) => child.type !== 'listItem')) invalid('Lists may contain only list items')
      if (type === 'bulletList') return { type, content }
      let attrs: JsonObject | undefined
      if (value.attrs !== undefined) {
        if (!object(value.attrs)) invalid('An ordered list has invalid attributes')
        exactKeys(value.attrs, [], ['start'])
        if (value.attrs.start !== undefined
          && (!Number.isInteger(value.attrs.start) || (value.attrs.start as number) < 1 || (value.attrs.start as number) > 9999)) {
          invalid('An ordered list start must be a positive integer')
        }
        attrs = value.attrs.start === undefined ? {} : { start: value.attrs.start }
      }
      return { type, ...(attrs === undefined ? {} : { attrs }), content }
    }

    if (type === 'listItem') {
      if (context !== 'list-item') invalid('List items may appear only inside lists')
      exactKeys(value, ['type', 'content'])
      return { type, content: visitChildren(true, 'block')! }
    }

    invalid('Rich content contains an unsupported node')
  }

  const content = root.content.length === 0
    ? [{ type: 'paragraph' }]
    : root.content.map((node) => visit(node, 1, 'block'))
  if (root.content.length === 0) nodeCount += 1
  // The recursive visitor has validated each node against the explicit allowlist;
  // this cast exposes that validated shape through the shared contract type.
  const document = { type: 'doc', content } as unknown as ProductRichContent
  const serialized = JSON.stringify(document)
  const byteLength = new TextEncoder().encode(serialized).byteLength
  if (byteLength > MAX_RICH_CONTENT_BYTES) invalid('Rich content JSON is too large')

  return {
    document,
    mediaIds: [...mediaIds],
    summary: { byteLength, textLength, nodeCount: nodeCount + 1, mediaCount: mediaIds.size },
  }
}

export function validateProductRichContent(value: unknown): ValidatedProductRichContent {
  return canonicalDocument(value)
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function renderText(node: RichNode): string {
  let output = escapeHtml(node.text as string)
  const marks = node.marks as Array<{ type: string; attrs?: JsonObject }> | undefined
  for (const mark of marks ?? []) {
    if (mark.type === 'bold') output = `<strong>${output}</strong>`
    else if (mark.type === 'italic') output = `<em>${output}</em>`
    else if (mark.type === 'link') {
      const attrs = mark.attrs!
      const href = escapeHtml(attrs.href as string)
      const target = attrs.target === undefined || attrs.target === null ? '' : ` target="${attrs.target}"`
      const rel = attrs.target === '_blank' ? ' rel="noopener noreferrer nofollow"' : ''
      output = `<a href="${href}"${target}${rel}>${output}</a>`
    }
  }
  return output
}

function renderNode(node: RichNode): string {
  const content = Array.isArray(node.content) ? node.content.map(renderNode).join('') : ''
  switch (node.type) {
    case 'text': return renderText(node)
    case 'paragraph': return `<p>${content}</p>`
    case 'heading': {
      const level = (node.attrs as JsonObject).level as number
      return `<h${level}>${content}</h${level}>`
    }
    case 'blockquote': return `<blockquote>${content}</blockquote>`
    case 'bulletList': return `<ul>${content}</ul>`
    case 'orderedList': {
      const start = (node.attrs as JsonObject | undefined)?.start
      return `<ol${typeof start === 'number' && start !== 1 ? ` start="${start}"` : ''}>${content}</ol>`
    }
    case 'listItem': return `<li>${content}</li>`
    case 'horizontalRule': return '<hr>'
    case 'hardBreak': return '<br>'
    case 'image': {
      const attrs = node.attrs as JsonObject
      const mediaId = attrs.mediaId as string
      const alt = escapeHtml((attrs.alt as string | undefined) ?? '')
      return `<img src="/api/v1/media/${mediaId}/detail.webp" alt="${alt}">`
    }
    default: throw new Error('Unexpected node in validated rich content')
  }
}

/** Converts only a validated document into escaped HTML for a future renderer. */
export function productRichContentToSafeHtml(value: unknown): string {
  const { document } = validateProductRichContent(value)
  return document.content.map((node) => renderNode(node as RichNode)).join('')
}
