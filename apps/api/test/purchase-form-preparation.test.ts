import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES,
  PurchaseAttachmentError,
  PurchaseAttachmentStorage,
  collectPurchaseImage,
  preparePurchaseAttachment,
} from '../src/media/purchase-attachment-storage.js'
import {
  PURCHASE_FORM_LIMITS,
  canonicalPurchaseFormJson,
  normalizePurchaseFormAnswers,
  validatePurchaseFormDefinition,
} from '@aikayun/contracts'
import type { PurchaseFormDefinition } from '@aikayun/contracts'
import type { AppConfig } from '../src/config.js'
import {
  decryptPurchaseDraft,
  decryptPurchaseOrderValues,
  encryptPurchaseDraft,
  encryptPurchaseOrderValues,
  purchaseFormContentIdentity,
} from '../src/commerce/purchase-form-crypto.js'
import { PurchaseOrderAttachmentStorage } from '../src/media/purchase-order-attachment-storage.js'

const generatedRoots: string[] = []
afterEach(async () => {
  await Promise.all(generatedRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function field(type: 'text' | 'textarea' | 'digits' | 'select' | 'image', label: string, options?: Record<string, unknown>) {
  return { id: randomUUID(), meaningKey: `field_${randomUUID().slice(0, 8)}`, type, label, required: true, ...options }
}

function definitionFixture() {
  const digits = field('digits', '账号', { maxLength: 128 })
  const text = field('text', '显示名称', { maxLength: 80 })
  const textarea = field('textarea', '备注', { maxLength: 400 })
  const select = field('select', '套餐', { options: [
    { id: randomUUID(), meaningKey: `option_${randomUUID().slice(0, 8)}`, label: '标准版' },
    { id: randomUUID(), meaningKey: `option_${randomUUID().slice(0, 8)}`, label: '高级版' },
  ] })
  const branchAccount = field('text', '角色名', { maxLength: 80 })
  const branchServer = field('digits', '区服编号', { maxLength: 40 })
  const asia = { id: randomUUID(), meaningKey: `option_${randomUUID().slice(0, 8)}`, label: '亚洲', children: [
    { id: randomUUID(), meaningKey: `option_${randomUUID().slice(0, 8)}`, label: '中国', expandedFields: [branchAccount, branchServer] },
    { id: randomUUID(), meaningKey: `option_${randomUUID().slice(0, 8)}`, label: '日本' },
  ] }
  const cascade = { id: randomUUID(), meaningKey: `field_${randomUUID().slice(0, 8)}`, type: 'cascade', label: '区服', required: true, options: [asia] }
  const image = field('image', '截图', { required: false, maxCount: 2 })
  const value: PurchaseFormDefinition = { fields: [digits, text, textarea, select, cascade, image] as PurchaseFormDefinition['fields'] }
  return { value, digits, text, textarea, select, cascade, asia, branchAccount, branchServer }
}

describe('⑥-2A purchase form definition and normalization', () => {
  it('rejects duplicate IDs, unsupported types, malformed option trees and resource boundaries', () => {
    const { value } = definitionFixture()
    const duplicate = structuredClone(value)
    duplicate.fields[1]!.id = duplicate.fields[0]!.id
    expect(validatePurchaseFormDefinition(duplicate)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'DUPLICATE_ID' })]) })
    const caseDuplicate = structuredClone(value) as unknown as { fields: Array<Record<string, unknown>> }
    caseDuplicate.fields[0]!.id = 'abcdef12-3456-4234-8abc-def123456789'
    caseDuplicate.fields[1]!.id = 'ABCDEF12-3456-4234-8ABC-DEF123456789'
    expect(validatePurchaseFormDefinition(caseDuplicate)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'DUPLICATE_ID' })]) })

    const unsupported = structuredClone(value) as unknown as { fields: Array<Record<string, unknown>> }
    unsupported.fields[0]!.type = 'script'
    expect(validatePurchaseFormDefinition(unsupported).ok).toBe(false)

    const missingIdentity = structuredClone(value) as unknown as { fields: Array<Record<string, unknown>> }
    const cascade = missingIdentity.fields.find(row => row.type === 'cascade')!
    ;(cascade.options as Array<Record<string, unknown>>)[0]!.children = [{ id: randomUUID(), meaningKey: 'option_child', label: '子项', unexpected: true }]
    expect(validatePurchaseFormDefinition(missingIdentity).ok).toBe(false)

    const tooMany = structuredClone(value)
    tooMany.fields = Array.from({ length: PURCHASE_FORM_LIMITS.topLevelFields + 1 }, () => field('text', '字段') as PurchaseFormDefinition['fields'][number])
    expect(validatePurchaseFormDefinition(tooMany)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'FIELD_LIMIT_EXCEEDED' })]) })

    let child: Record<string, unknown> = { id: randomUUID(), meaningKey: 'option_deep', label: '末端' }
    for (let index = 0; index < PURCHASE_FORM_LIMITS.optionDepth; index += 1) {
      child = { id: randomUUID(), meaningKey: `option_${index}`, label: '层', children: [child] }
    }
    const deep = { fields: [{ id: randomUUID(), meaningKey: 'region', type: 'cascade', label: '地区', required: true, options: [child] }] }
    expect(validatePurchaseFormDefinition(deep)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'OPTION_TREE_LIMIT_EXCEEDED' })]) })
  })

  it('reports malformed deep expanded fields and accepts the deepest legal cascade with a select expansion', () => {
    const malformedValues: unknown[] = [null, 7, []]
    for (const malformed of malformedValues) {
      const { value } = definitionFixture()
      const cascade = value.fields.find(row => row.type === 'cascade')
      if (cascade?.type !== 'cascade') throw new Error('cascade fixture missing')
      const branch = cascade.options[0]!
      const child = branch.children![0]!
      child.expandedFields = [malformed] as never
      const result = validatePurchaseFormDefinition(value)
      expect(result.ok, `expected invalid expanded field ${String(malformed)}`).toBe(false)
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0)
    }

    let option: Record<string, unknown> = {
      id: randomUUID(), meaningKey: 'level_5', label: '第五层',
      expandedFields: [{
        id: randomUUID(), meaningKey: 'expanded_choice', type: 'select', label: '扩展选项', required: true,
        options: [{ id: randomUUID(), meaningKey: 'choice_one', label: '选项一' }],
      }],
    }
    for (let depth = 4; depth >= 1; depth -= 1) {
      option = { id: randomUUID(), meaningKey: `level_${depth}`, label: `第${depth}层`, children: [option] }
    }
    const fiveLevelCascade = {
      fields: [{ id: randomUUID(), meaningKey: 'five_level_region', type: 'cascade', label: '五级区服', required: true, options: [option] }],
    }
    expect(validatePurchaseFormDefinition(fiveLevelCascade).ok).toBe(true)

    const sixth = { id: randomUUID(), meaningKey: 'level_6', label: '第六层' }
    const sixthRoot = { id: randomUUID(), meaningKey: 'level_1', label: '第一层', children: [
      { id: randomUUID(), meaningKey: 'level_2', label: '第二层', children: [
        { id: randomUUID(), meaningKey: 'level_3', label: '第三层', children: [
          { id: randomUUID(), meaningKey: 'level_4', label: '第四层', children: [
            { id: randomUUID(), meaningKey: 'level_5', label: '第五层', children: [sixth] },
          ] },
        ] },
      ] },
    ] }
    const sixLevelCascade = {
      fields: [{ id: randomUUID(), meaningKey: 'six_level_region', type: 'cascade', label: '六级区服', required: true, options: [sixthRoot] }],
    }
    expect(validatePurchaseFormDefinition(sixLevelCascade)).toMatchObject({
      ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'OPTION_TREE_LIMIT_EXCEEDED' })]),
    })
  })

  it('allows incomplete drafts but reports exact stable IDs during explicit completeness checks', () => {
    const { value, digits, text, textarea, select, cascade } = definitionFixture()
    const draft = normalizePurchaseFormAnswers(value, {})
    expect(draft).toEqual({ ok: true, value: {}, incompleteFieldIds: [] })
    const complete = normalizePurchaseFormAnswers(value, {}, { requireComplete: true, attachmentIds: new Set() })
    expect(complete).toMatchObject({ ok: true, incompleteFieldIds: [digits.id, text.id, textarea.id, select.id, cascade.id].sort() })
  })

  it('keeps inactive branch fields out of completeness and rejects submitted stale branch values', () => {
    const { value, digits, text, textarea, select, cascade, asia, branchAccount, branchServer } = definitionFixture()
    const completeBase = {
      [digits.id]: '001234',
      [text.id]: 'Player',
      [textarea.id]: 'memo',
      [select.id]: select.options[0]!.id,
    }
    const japan = cascade.options[0]!.children![1]!
    const selectedJapan = { ...completeBase, [cascade.id]: { path: [asia.id, japan.id], expanded: {} } }
    const valid = normalizePurchaseFormAnswers(value, selectedJapan, { requireComplete: true, attachmentIds: new Set() })
    expect(valid).toMatchObject({ ok: true, incompleteFieldIds: [] })

    const noPathWithValues = { ...completeBase, [cascade.id]: { path: [], expanded: { [branchAccount.id]: 'old account' } } }
    expect(normalizePurchaseFormAnswers(value, noPathWithValues)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'INACTIVE_BRANCH_VALUE' })]) })

    const staleValue = { ...completeBase, [cascade.id]: { path: [asia.id, japan.id], expanded: { [branchServer.id]: '12' } } }
    expect(normalizePurchaseFormAnswers(value, staleValue)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'INACTIVE_BRANCH_VALUE' })]) })

    const activeRequired = { ...completeBase, [cascade.id]: { path: [asia.id, cascade.options[0]!.children![0]!.id], expanded: {} } }
    expect(normalizePurchaseFormAnswers(value, activeRequired, { requireComplete: true, attachmentIds: new Set() })).toMatchObject({ ok: true, incompleteFieldIds: [branchAccount.id, branchServer.id].sort() })
  })

  it('preserves digit strings, case and meaningful whitespace while normalizing line endings and object key order', () => {
    const { value, digits, text, textarea, select, cascade, asia, branchAccount } = definitionFixture()
    const account = '000123456789012345678901234567890123456789'
    const textValue = ' AbC-xYz '
    const raw = {
      [digits.id]: account,
      [text.id]: textValue,
      [textarea.id]: '  first\r\nsecond\rthird  ',
      [select.id]: select.options[1]!.id,
      [cascade.id]: { path: [asia.id, asia.children![0]!.id], expanded: { [branchAccount.id]: ' Player-A ' } },
    }
    const normalized = normalizePurchaseFormAnswers(value, raw)
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    expect(normalized.value[digits.id]).toBe(account)
    expect(normalized.value[text.id]).toBe(textValue)
    expect(normalized.value[textarea.id]).toBe('  first\nsecond\nthird  ')
    const firstKeyOrder = canonicalPurchaseFormJson(normalized.value)
    const reordered = Object.fromEntries(Object.entries(raw).reverse())
    const again = normalizePurchaseFormAnswers(value, reordered)
    expect(again.ok && canonicalPurchaseFormJson(again.value)).toBe(firstKeyOrder)

    expect(normalizePurchaseFormAnswers(value, { [select.id]: randomUUID() })).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'OPTION_NOT_ALLOWED' })]) })
    expect(normalizePurchaseFormAnswers(value, { [digits.id]: 123456 })).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'DIGITS_VALUE_INVALID' })]) })

    const imageField = value.fields.find(field => field.type === 'image')!
    if (imageField.type === 'image') {
      imageField.maxCount = 2
      const imageIds = ['f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002']
      const imageResult = normalizePurchaseFormAnswers(value, { [imageField.id]: imageIds }, {
        attachmentIds: new Set(imageIds),
        attachmentFieldIds: new Map(imageIds.map(id => [id, imageField.id])),
      })
      expect(imageResult.ok && imageResult.value[imageField.id]).toEqual(imageIds)
    }
  })

  it('uses canonical payload identity that changes with template version or effective values', async () => {
    const { value, digits } = definitionFixture()
    const content = { [digits.id]: '001234' }
    const normalized = normalizePurchaseFormAnswers(value, content)
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    expect(purchaseFormContentIdentity('version-a', normalized.value)).toBe(purchaseFormContentIdentity('version-a', { [digits.id]: '001234' }))
    expect(purchaseFormContentIdentity('version-a', normalized.value)).not.toBe(purchaseFormContentIdentity('version-b', normalized.value))
    expect(purchaseFormContentIdentity('version-a', normalized.value)).not.toBe(purchaseFormContentIdentity('version-a', { [digits.id]: '001235' }))
  })
})

describe('⑥-2A encrypted draft and private image primitives', () => {
  const keyA = Buffer.alloc(32, 7)
  const keyB = Buffer.alloc(32, 9)
  const config = (activeKeyId: string, keys: Record<string, Buffer>) => ({
    paymentCredentialKeyRing: { activeKeyId, keys },
  }) as unknown as AppConfig

  it('binds ciphertext to a stable draft ID and retains decryption with a historical key', () => {
    const values = { [randomUUID()]: 'Secret Player Name' }
    const encrypted = encryptPurchaseDraft(config('a', { a: keyA, b: keyB }), '11ef68d0-379a-48d0-906b-0cc65c1e6503', values)
    expect(encrypted.ciphertext.includes(Buffer.from('Secret Player Name'))).toBe(false)
    const rotated = config('b', { a: keyA, b: keyB })
    expect(decryptPurchaseDraft(rotated, '11ef68d0-379a-48d0-906b-0cc65c1e6503', encrypted)).toEqual(values)
    expect(() => decryptPurchaseDraft(rotated, randomUUID(), encrypted)).toThrow('Purchase draft ciphertext failed integrity verification')
    expect(() => decryptPurchaseDraft(config('b', { b: keyB }), '11ef68d0-379a-48d0-906b-0cc65c1e6503', encrypted)).toThrow('Purchase draft encryption is unavailable')
  })

  it('keeps order values under an independent purpose and order-item AAD', () => {
    const draftId = randomUUID()
    const orderItemId = randomUUID()
    const values = { account: '00123', player: 'Case Sensitive' }
    const draft = encryptPurchaseDraft(config('a', { a: keyA }), draftId, values)
    const order = encryptPurchaseOrderValues(config('a', { a: keyA }), orderItemId, values)
    expect(order.ciphertext.includes(Buffer.from('Case Sensitive'))).toBe(false)
    expect(decryptPurchaseOrderValues(config('b', { a: keyA, b: keyB }), orderItemId, order)).toEqual(values)
    expect(() => decryptPurchaseOrderValues(config('a', { a: keyA }), randomUUID(), order)).toThrow()
    expect(() => decryptPurchaseOrderValues(config('a', { a: keyA }), orderItemId, draft)).toThrow()
    expect(() => decryptPurchaseDraft(config('a', { a: keyA }), draftId, order)).toThrow()
    expect(() => decryptPurchaseOrderValues(config('b', { b: keyB }), orderItemId, order))
      .toThrow('Purchase order content encryption is unavailable')
  })

  it('keeps a verified order archive readable after removing the draft object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aikayun-purchase-order-archive-unit-'))
    generatedRoots.push(root)
    const draftStorage = new PurchaseAttachmentStorage(root)
    const orderStorage = new PurchaseOrderAttachmentStorage(root)
    const bytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#276e8f' } }).webp().toBuffer()
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
    const draftId = randomUUID()
    const orderObjectId = randomUUID()
    const draftKey = await draftStorage.store(draftId, bytes)
    const copied = await draftStorage.readVerified(draftId, draftKey, bytes.length, sha256)
    const orderKey = await orderStorage.store(orderObjectId, copied, sha256)
    expect(orderKey).not.toBe(draftKey)
    await draftStorage.remove(draftId, draftKey)
    expect(await orderStorage.readVerified(orderObjectId, orderKey, bytes.length, sha256)).toEqual(bytes)
    await expect(orderStorage.readVerified(orderObjectId, orderKey, bytes.length, '0'.repeat(64)))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_ATTACHMENT_UNAVAILABLE' })
    expect((await orderStorage.scanFiles()).filter(file => file.location === 'object')).toHaveLength(1)
  })

  it('decodes actual JPEG, PNG and WebP bytes, rejects MIME mismatch, corruption and size overflow', async () => {
    const png = await sharp({ create: { width: 18, height: 12, channels: 4, background: '#2277aa' } }).png().toBuffer()
    const jpeg = await sharp(png).jpeg().toBuffer()
    const webp = await sharp(png).webp().toBuffer()
    for (const [bytes, mime] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']] as const) {
      const prepared = await preparePurchaseAttachment(bytes, mime)
      expect(prepared).toMatchObject({ width: 18, height: 12, byteSize: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
      expect((await sharp(prepared.bytes).metadata()).format).toBe('webp')
    }
    await expect(preparePurchaseAttachment(png, 'image/jpeg')).rejects.toMatchObject({ code: 'PURCHASE_ATTACHMENT_MIME_MISMATCH' })
    await expect(preparePurchaseAttachment(Buffer.from('broken image'), 'image/png')).rejects.toBeInstanceOf(PurchaseAttachmentError)
    await expect(preparePurchaseAttachment(Buffer.alloc(PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES + 1), 'image/png')).rejects.toMatchObject({ code: 'PURCHASE_ATTACHMENT_TOO_LARGE' })
    const animatedWebp = Buffer.from('UklGRogAAABXRUJQVlA4WAoAAAACAAAAAwAAAwAAQU5JTQYAAAD/////AABBTk1GKgAAAAAAAAAAAAMAAAMAAGQAAAJWUDhMEQAAAC8DwAAAB9CZMpeo/4GI6H8AAEFOTUYqAAAAAAAAAAAAAwAAAwAAZAAAAFZQOEwRAAAALwPAAAAHULOKdLf/gYjofwAA', 'base64')
    await expect(preparePurchaseAttachment(animatedWebp, 'image/webp')).rejects.toMatchObject({ code: 'PURCHASE_ATTACHMENT_MULTIFRAME' })
    const abovePixelLimit = await sharp({ create: { width: 4_001, height: 4_000, channels: 3, background: '#778899' } }).png().toBuffer()
    await expect(preparePurchaseAttachment(abovePixelLimit, 'image/png')).rejects.toMatchObject({ code: 'PURCHASE_ATTACHMENT_PIXELS_EXCEEDED' })
  })

  it('caps streamed input and stores immutable generated identities in an isolated private namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aikayun-purchase-image-unit-'))
    generatedRoots.push(root)
    const storage = new PurchaseAttachmentStorage(root)
    const bytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#228855' } }).png().toBuffer()
    async function* chunks() { yield bytes.subarray(0, 5); yield bytes.subarray(5) }
    expect((await collectPurchaseImage(chunks())).equals(bytes)).toBe(true)
    async function* oversized() { yield Buffer.alloc(PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES + 1) }
    await expect(collectPurchaseImage(oversized())).rejects.toMatchObject({ code: 'PURCHASE_ATTACHMENT_TOO_LARGE' })

    const prepared = await preparePurchaseAttachment(bytes, 'image/png')
    const firstId = randomUUID()
    const firstKey = await storage.store(firstId, prepared.bytes)
    const firstPath = join(root, 'purchase-attachments', firstKey)
    expect((await storage.readVerified(firstId, firstKey, prepared.byteSize, prepared.sha256)).equals(prepared.bytes)).toBe(true)
    expect((await stat(firstPath)).mode & 0o777).toBe(0o400)
    expect(await readFile(firstPath)).toEqual(prepared.bytes)

    const secondId = randomUUID()
    expect(secondId).not.toBe(firstId)
    const secondKey = await storage.store(secondId, prepared.bytes)
    expect(secondKey).not.toBe(firstKey)
    expect((await storage.scanFiles()).filter(file => file.location === 'object')).toHaveLength(2)
  })
})
