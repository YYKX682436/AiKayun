import { randomUUID } from 'node:crypto'
import type { Kysely, Selectable, Transaction } from 'kysely'
import { canonicalPurchaseFormJson, PURCHASE_FORM_LIMITS, PURCHASE_FORM_NORMALIZATION_VERSION, normalizePurchaseFormAnswers, validatePurchaseFormDefinition } from '@aikayun/contracts'
import type { PurchaseFormDefinition, PurchaseFormLeafField, PurchaseFormValues } from '@aikayun/contracts'
import type { AppConfig } from '../config.js'
import type { AuthenticatedCustomer } from '../auth/customer.js'
import { hashToken } from '../auth/security.js'
import type { Database, PurchaseDraftAttachmentsTable, PurchaseDraftsTable } from '../db/types.js'
import { PurchaseAttachmentError, PurchaseAttachmentStorage, PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES, processPurchaseImageUpload } from '../media/purchase-attachment-storage.js'
import { decryptPurchaseDraft, encryptPurchaseDraft, purchaseFormContentIdentity } from './purchase-form-crypto.js'
import { effectivePurchaseFormForSku } from './purchase-form-config.js'

export const PURCHASE_DRAFT_TTL_DAYS = 30
export const PURCHASE_DRAFT_MAX_PER_OWNER = 50
export const PURCHASE_DRAFT_RECONCILE_GRACE_HOURS = 24
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const guestSessionTokenPattern = /^[A-Za-z0-9_-]{43}$/u

export type PurchaseDraftOwner =
  | { kind: 'customer'; customer: Pick<AuthenticatedCustomer, 'id' | 'sessionId'> }
  | { kind: 'guest'; guestSessionToken: string }

export class PurchaseDraftServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldIds: string[] = [],
  ) {
    super(message)
    this.name = 'PurchaseDraftServiceError'
  }
}

export interface PurchaseDraftView {
  id: string
  templateVersionId: string
  revision: number
  normalizationVersion: number
  expiresAt: string
  values: PurchaseFormValues
  attachments: Array<Pick<Selectable<PurchaseDraftAttachmentsTable>, 'id' | 'field_id' | 'mime_type' | 'byte_size' | 'width' | 'height' | 'sha256'>>
  templateChanged: boolean
}

export interface PurchaseDraftWriteResult {
  id: string
  revision: number
  expiresAt: string
  complete: boolean
  incompleteFieldIds: string[]
  normalizedValues: PurchaseFormValues
  normalizedContentHash: string
  replacedAttachmentIds?: string[]
}

export interface ValidatedPurchaseDraft extends PurchaseDraftWriteResult {
  templateVersionId: string
  normalizationVersion: number
  attachments: Array<{
    id: string
    fieldId: string
    storageKey: string
    byteSize: number
    width: number
    height: number
    sha256: string
  }>
}

export interface PurchaseDraftReference {
  draftId: string
  expectedRevision?: number
  expectedTemplateVersionId?: string
}

type OwnerIdentity = { kind: 'customer'; customerId: string } | { kind: 'guest'; guestSessionId: string }
type DraftRow = Selectable<PurchaseDraftsTable>
type DraftAttachmentRow = Selectable<PurchaseDraftAttachmentsTable>
type ImageReference = { attachmentId: string; fieldId: string }

function draftNotFound(): PurchaseDraftServiceError {
  return new PurchaseDraftServiceError(404, 'PURCHASE_DRAFT_NOT_FOUND', '找不到可访问的填写草稿。')
}

function expiredDraft(): PurchaseDraftServiceError {
  return new PurchaseDraftServiceError(410, 'PURCHASE_DRAFT_EXPIRED', '填写草稿已过期，请重新开始。')
}

function validationError(issues: Array<{ fieldId: string | null; code: string }>): PurchaseDraftServiceError {
  const fieldIds = [...new Set(issues.map(issue => issue.fieldId).filter((value): value is string => Boolean(value)))].sort()
  return new PurchaseDraftServiceError(400, 'PURCHASE_DRAFT_INVALID', '填写内容格式无效，请检查标出的字段。', fieldIds)
}

function assertTemplateDefinition(value: unknown): PurchaseFormDefinition {
  const result = validatePurchaseFormDefinition(value)
  if (!result.ok) throw new PurchaseDraftServiceError(500, 'PURCHASE_TEMPLATE_INVALID', '填写模板配置无法读取。')
  return result.value
}

export async function validateAndLockPurchaseDraftOwner(
  trx: Transaction<Database>,
  owner: PurchaseDraftOwner,
  lock: 'share' | 'update' = 'share',
): Promise<OwnerIdentity> {
  if (owner.kind === 'customer') {
    const customerQuery = trx.selectFrom('customers').select(['id', 'status', 'username'])
      .where('id', '=', owner.customer.id).where('status', '=', 'active').where('username', 'is not', null)
    const customer = await (lock === 'update' ? customerQuery.forUpdate() : customerQuery.forShare()).executeTakeFirst()
    if (!customer) throw new PurchaseDraftServiceError(401, 'UNAUTHORIZED', '顾客登录状态已失效，请重新登录。')
    const session = await trx.selectFrom('customer_sessions').select('id')
      .where('id', '=', owner.customer.sessionId).where('customer_id', '=', owner.customer.id)
      .where('revoked_at', 'is', null).where('expires_at', '>', new Date())
      .forShare().executeTakeFirst()
    if (!session) throw new PurchaseDraftServiceError(401, 'UNAUTHORIZED', '顾客登录状态已失效，请重新登录。')
    return { kind: 'customer', customerId: customer.id }
  }
  if (!guestSessionTokenPattern.test(owner.guestSessionToken)) {
    throw new PurchaseDraftServiceError(401, 'GUEST_SESSION_REQUIRED', '游客订单会话无效或已过期。')
  }
  const sessionQuery = trx.selectFrom('guest_order_sessions').select('id')
    .where('token_hash', '=', hashToken(owner.guestSessionToken))
    .where('revoked_at', 'is', null).where('expires_at', '>', new Date())
  const session = await (lock === 'update' ? sessionQuery.forUpdate() : sessionQuery.forShare()).executeTakeFirst()
  if (!session) throw new PurchaseDraftServiceError(401, 'GUEST_SESSION_REQUIRED', '游客订单会话无效或已过期。')
  return { kind: 'guest', guestSessionId: session.id }
}

async function lockOwnedDraft(
  trx: Transaction<Database>,
  owner: OwnerIdentity,
  draftId: string,
  mode: 'share' | 'update',
): Promise<DraftRow> {
  if (!uuidPattern.test(draftId)) throw draftNotFound()
  let query = trx.selectFrom('purchase_drafts').selectAll().where('id', '=', draftId)
  query = owner.kind === 'customer'
    ? query.where('customer_id', '=', owner.customerId).where('guest_order_session_id', 'is', null)
    : query.where('guest_order_session_id', '=', owner.guestSessionId).where('customer_id', 'is', null)
  const locked = await (mode === 'update' ? query.forUpdate() : query.forShare()).executeTakeFirst()
  if (!locked) throw draftNotFound()
  if (locked.status !== 'active') throw draftNotFound()
  if (locked.expires_at <= new Date()) throw expiredDraft()
  return locked
}

async function assertDraftNotBoundToCart(trx: Transaction<Database>, draftId: string): Promise<void> {
  const binding = await trx.selectFrom('customer_cart_items').select('line_id')
    .where('draft_id', '=', draftId).executeTakeFirst()
  if (binding) {
    throw new PurchaseDraftServiceError(
      409, 'PURCHASE_DRAFT_CART_BOUND', '此填写草稿已绑定购物车购买行，请在购物车中编辑。',
    )
  }
}

async function loadDraftTemplate(trx: Transaction<Database>, versionId: string): Promise<PurchaseFormDefinition> {
  const version = await trx.selectFrom('purchase_form_template_versions').select('definition')
    .where('id', '=', versionId).executeTakeFirst()
  if (!version) throw new PurchaseDraftServiceError(409, 'PURCHASE_TEMPLATE_VERSION_UNAVAILABLE', '填写模板版本已不可用。')
  return assertTemplateDefinition(version.definition)
}

function envelope(row: DraftRow) {
  return {
    keyId: row.encryption_key_id,
    nonce: row.payload_nonce,
    ciphertext: row.encrypted_payload,
    authTag: row.payload_auth_tag,
  }
}

async function listDraftAttachments(trx: Transaction<Database>, draftId: string, forUpdate = false): Promise<DraftAttachmentRow[]> {
  const query = trx.selectFrom('purchase_draft_attachments').selectAll()
    .where('draft_id', '=', draftId).where('status', 'in', ['uploading', 'ready', 'failed'])
    .orderBy('id')
  return await (forUpdate ? query.forUpdate() : query.forShare()).execute()
}

function normalizeForDraft(
  definition: PurchaseFormDefinition,
  rawValues: unknown,
  attachments: DraftAttachmentRow[],
  requireComplete = false,
) {
  const usable = attachments.filter(attachment => attachment.status === 'ready')
  const ids = new Set(usable.map(attachment => attachment.id.toLowerCase()))
  const fieldIds = new Map(usable.map(attachment => [attachment.id.toLowerCase(), attachment.field_id.toLowerCase()]))
  const result = normalizePurchaseFormAnswers(definition, rawValues, {
    requireComplete,
    attachmentIds: ids,
    attachmentFieldIds: fieldIds,
  })
  if (!result.ok) throw validationError(result.issues)
  return result
}

function collectImageReferences(definition: PurchaseFormDefinition, values: PurchaseFormValues): ImageReference[] {
  const result: ImageReference[] = []
  const collectExpanded = (fields: PurchaseFormLeafField[], expanded: Record<string, unknown>) => {
    for (const field of fields) {
      if (field.type !== 'image') continue
      const ids = expanded[field.id.toLowerCase()]
      if (Array.isArray(ids)) {
        for (const attachmentId of ids) if (typeof attachmentId === 'string') result.push({ attachmentId, fieldId: field.id.toLowerCase() })
      }
    }
  }
  for (const field of definition.fields) {
    if (field.type === 'image') {
      const ids = values[field.id.toLowerCase()]
      if (Array.isArray(ids)) for (const attachmentId of ids) {
        if (typeof attachmentId === 'string') result.push({ attachmentId, fieldId: field.id.toLowerCase() })
      }
    }
    if (field.type !== 'cascade') continue
    const value = values[field.id.toLowerCase()]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const cascadeValue = value as { path?: unknown; expanded?: unknown }
    if (!Array.isArray(cascadeValue.path) || !cascadeValue.expanded || typeof cascadeValue.expanded !== 'object') continue
    const expanded = cascadeValue.expanded as Record<string, unknown>
    let options = field.options
    for (const optionId of cascadeValue.path) {
      if (typeof optionId !== 'string') break
      const selected = options.find(option => option.id.toLowerCase() === optionId.toLowerCase())
      if (!selected) break
      collectExpanded(selected.expandedFields ?? [], expanded)
      options = selected.children ?? []
    }
  }
  return result
}

function activeImageFieldLimit(definition: PurchaseFormDefinition, values: PurchaseFormValues, fieldId: string): number | null {
  for (const field of definition.fields) {
    if (field.id.toLowerCase() === fieldId.toLowerCase()) return field.type === 'image' ? field.maxCount : null
    if (field.type !== 'cascade') continue
    const value = values[field.id.toLowerCase()]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const path = (value as { path?: unknown }).path
    if (!Array.isArray(path)) continue
    let options = field.options
    for (const optionId of path) {
      if (typeof optionId !== 'string') break
      const selected = options.find(option => option.id.toLowerCase() === optionId.toLowerCase())
      if (!selected) break
      const expandedImage = selected.expandedFields?.find(expanded => expanded.id.toLowerCase() === fieldId.toLowerCase() && expanded.type === 'image')
      if (expandedImage?.type === 'image') return expandedImage.maxCount
      options = selected.children ?? []
    }
  }
  return null
}

function assertAttachmentCapacity(
  attachments: DraftAttachmentRow[],
  replacement?: { id: string; byteSize: number },
  newReservation?: { id: string; bytes: number },
  excludingIds: ReadonlySet<string> = new Set(),
): void {
  const candidates = attachments.filter(attachment => attachment.status !== 'deleting' && !excludingIds.has(attachment.id))
  const count = candidates.length + (newReservation ? 1 : 0)
  if (count > PURCHASE_FORM_LIMITS.attachmentsPerDraft) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_LIMIT', '此填写草稿已达到图片数量上限。')
  }
  let total = 0
  for (const attachment of candidates) {
    if (replacement?.id === attachment.id) total += replacement.byteSize
    else total += attachment.status === 'ready' && attachment.byte_size !== null ? attachment.byte_size : attachment.reserved_bytes
  }
  if (newReservation) total += newReservation.bytes
  if (total > PURCHASE_FORM_LIMITS.attachmentBytesPerDraft) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_QUOTA', '此填写草稿已达到图片总容量上限。')
  }
}

async function assertOwnerAttachmentCapacity(
  trx: Transaction<Database>,
  owner: OwnerIdentity,
  newReservationBytes: number,
  replacement?: { attachmentId: string; byteSize: number },
  newReservationCount = 1,
): Promise<void> {
  const query = trx.selectFrom('purchase_draft_attachments as attachment')
    .innerJoin('purchase_drafts as draft', 'draft.id', 'attachment.draft_id')
    .select(['attachment.id', 'attachment.byte_size', 'attachment.reserved_bytes'])
    .where('attachment.status', 'in', ['uploading', 'ready', 'failed'])
  const rows = owner.kind === 'customer'
    ? await query.where('draft.customer_id', '=', owner.customerId).where('draft.guest_order_session_id', 'is', null).execute()
    : await query.where('draft.guest_order_session_id', '=', owner.guestSessionId).where('draft.customer_id', 'is', null).execute()
  const totalBytes = rows.reduce((total, row) => total + (replacement?.attachmentId === row.id
    ? replacement.byteSize
    : row.byte_size ?? row.reserved_bytes), newReservationBytes)
  if (rows.length + (replacement ? 0 : newReservationCount) > PURCHASE_FORM_LIMITS.attachmentsPerOwner
    || totalBytes > PURCHASE_FORM_LIMITS.attachmentBytesPerOwner) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_OWNER_QUOTA', '此账号的私有图片已达到保存容量上限。')
  }
}

function draftInsertOwner(owner: OwnerIdentity) {
  return owner.kind === 'customer'
    ? { customer_id: owner.customerId, guest_order_session_id: null, claimed_from_guest_order_session_id: null }
    : { customer_id: null, guest_order_session_id: owner.guestSessionId, claimed_from_guest_order_session_id: null }
}

export async function createPurchaseDraft(
  db: Kysely<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  templateVersionId: string,
  now = new Date(),
): Promise<{ id: string; revision: number; expiresAt: string }> {
  if (!uuidPattern.test(templateVersionId)) throw new PurchaseDraftServiceError(400, 'PURCHASE_TEMPLATE_VERSION_INVALID', '填写模板版本无效。')
  return db.transaction().execute(trx => createPurchaseDraftInTransaction(trx, config, owner, templateVersionId, now))
}

export async function createPurchaseDraftInTransaction(
  trx: Transaction<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  templateVersionId: string,
  now = new Date(),
): Promise<{ id: string; revision: number; expiresAt: string }> {
  if (!uuidPattern.test(templateVersionId)) throw new PurchaseDraftServiceError(400, 'PURCHASE_TEMPLATE_VERSION_INVALID', '填写模板版本无效。')
  const identity = await validateAndLockPurchaseDraftOwner(trx, owner, 'update')
  await loadDraftTemplate(trx, templateVersionId)
  let countQuery = trx.selectFrom('purchase_drafts').select(trx.fn.countAll<number>().as('count'))
      .where('status', '=', 'active').where('expires_at', '>', now)
  countQuery = identity.kind === 'customer'
    ? countQuery.where('customer_id', '=', identity.customerId)
    : countQuery.where('guest_order_session_id', '=', identity.guestSessionId)
  const current = await countQuery.executeTakeFirstOrThrow()
  if (Number(current.count) >= PURCHASE_DRAFT_MAX_PER_OWNER) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_LIMIT', '可保存的填写草稿数量已达到上限。')
  }
  const id = randomUUID()
  const expiresAt = new Date(now.getTime() + PURCHASE_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000)
  const encrypted = encryptPurchaseDraft(config, id, {})
  await trx.insertInto('purchase_drafts').values({
      id,
      ...draftInsertOwner(identity),
      template_version_id: templateVersionId,
      normalization_version: PURCHASE_FORM_NORMALIZATION_VERSION,
      revision: 1,
      status: 'active',
      encrypted_payload: encrypted.ciphertext,
      payload_nonce: encrypted.nonce,
      payload_auth_tag: encrypted.authTag,
      encryption_key_id: encrypted.keyId,
      expires_at: expiresAt,
  }).execute()
  return { id, revision: 1, expiresAt: expiresAt.toISOString() }
}

export async function getPurchaseDraft(
  db: Kysely<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  draftId: string,
  skuId?: string,
): Promise<PurchaseDraftView> {
  return db.transaction().execute(async (trx) => {
    const identity = await validateAndLockPurchaseDraftOwner(trx, owner)
    let templateChanged = false
    if (skuId) {
      const effective = await effectivePurchaseFormForSku(trx, skuId, { lockStatus: 'share' })
      if (!effective.templateVersionId || !effective.templateId) throw draftNotFound()
      if (!uuidPattern.test(draftId)) throw draftNotFound()
      const pinned = await trx.selectFrom('purchase_drafts as draft')
        .innerJoin('purchase_form_template_versions as version', 'version.id', 'draft.template_version_id')
        .select(['version.template_id']).where('draft.id', '=', draftId)
        .where(identity.kind === 'customer' ? 'draft.customer_id' : 'draft.guest_order_session_id', '=',
          identity.kind === 'customer' ? identity.customerId : identity.guestSessionId)
        .executeTakeFirst()
      if (!pinned || pinned.template_id !== effective.templateId) throw draftNotFound()
      const pinnedVersion = await trx.selectFrom('purchase_drafts').select('template_version_id')
        .where('id', '=', draftId).executeTakeFirst()
      templateChanged = pinnedVersion?.template_version_id !== effective.templateVersionId
    }
    const draft = await lockOwnedDraft(trx, identity, draftId, 'share')
    const definition = await loadDraftTemplate(trx, draft.template_version_id)
    const attachments = await listDraftAttachments(trx, draft.id, false)
    const values = decryptPurchaseDraft(config, draft.id, envelope(draft))
    const normalized = normalizeForDraft(definition, values, attachments)
    const refs = collectImageReferences(definition, normalized.value)
    const byId = new Map(attachments.map(attachment => [attachment.id, attachment]))
    if (refs.some(reference => byId.get(reference.attachmentId)?.field_id !== reference.fieldId)) {
      throw new PurchaseDraftServiceError(500, 'PURCHASE_DRAFT_INTEGRITY_ERROR', '填写草稿暂时无法读取。')
    }
    return {
      id: draft.id,
      templateVersionId: draft.template_version_id,
      revision: draft.revision,
      normalizationVersion: draft.normalization_version,
      expiresAt: draft.expires_at.toISOString(),
      values: normalized.value,
      attachments: attachments.filter(attachment => attachment.status === 'ready'),
      templateChanged,
    }
  })
}

export async function savePurchaseDraftInTransaction(
  trx: Transaction<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  input: { draftId: string; expectedRevision: number; values: unknown },
  options: {
    coordinatedCartEdit?: boolean
    expectedTemplateVersionId?: string
    replacements?: Array<{ oldAttachmentId: string; newAttachmentId: string }>
  } = {},
): Promise<PurchaseDraftWriteResult> {
  const identity = await validateAndLockPurchaseDraftOwner(trx, owner, 'update')
  const draft = await lockOwnedDraft(trx, identity, input.draftId, 'update')
  if (options.expectedTemplateVersionId && draft.template_version_id !== options.expectedTemplateVersionId) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_TEMPLATE_VERSION_CONFLICT', '填写模板版本已变化，请重新确认资料。')
  }
  if (!options.coordinatedCartEdit) await assertDraftNotBoundToCart(trx, draft.id)
  if (!Number.isSafeInteger(input.expectedRevision) || draft.revision !== input.expectedRevision) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '填写草稿已被其他操作修改，请重新读取。')
  }
  const definition = await loadDraftTemplate(trx, draft.template_version_id)
  const attachments = await listDraftAttachments(trx, draft.id, true)
  const replacementIds = new Set((options.replacements ?? []).map(replacement => replacement.oldAttachmentId))
  if (replacementIds.size !== (options.replacements ?? []).length) {
    throw new PurchaseDraftServiceError(400, 'PURCHASE_ATTACHMENT_REPLACEMENT_INVALID', '图片替换请求无效。')
  }
  assertAttachmentCapacity(attachments, undefined, undefined, replacementIds)
  const normalized = normalizeForDraft(definition, input.values, attachments)
  const refs = collectImageReferences(definition, normalized.value)
  const attachmentById = new Map(attachments.map(attachment => [attachment.id, attachment]))
  if (refs.some(reference => attachmentById.get(reference.attachmentId)?.field_id !== reference.fieldId
    || attachmentById.get(reference.attachmentId)?.status !== 'ready')) {
    throw validationError(refs.map(reference => ({ fieldId: reference.fieldId, code: 'ATTACHMENT_NOT_OWNED' })))
  }
  for (const replacement of options.replacements ?? []) {
    const oldAttachment = attachmentById.get(replacement.oldAttachmentId)
    const newAttachment = attachmentById.get(replacement.newAttachmentId)
    const newIsReferenced = refs.some(reference => reference.attachmentId === replacement.newAttachmentId)
    const oldReference = await trx.selectFrom('purchase_draft_attachment_references').select('attachment_id')
      .where('draft_id', '=', draft.id).where('attachment_id', '=', replacement.oldAttachmentId).forShare().executeTakeFirst()
    if (!oldAttachment || !newAttachment || oldAttachment.status !== 'ready' || newAttachment.status !== 'ready'
      || oldAttachment.field_id !== newAttachment.field_id || !oldReference || !newIsReferenced
      || replacement.oldAttachmentId === replacement.newAttachmentId) {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_REPLACEMENT_INVALID', '待替换图片已变化，请重新读取后重试。')
    }
  }
  const complete = normalizeForDraft(definition, input.values, attachments, true)
  const payload = Buffer.from(canonicalPurchaseFormJson(normalized.value), 'utf8')
  if (payload.length > PURCHASE_FORM_LIMITS.requestBytes - 16 * 1024) {
    throw new PurchaseDraftServiceError(413, 'PURCHASE_DRAFT_TOO_LARGE', '填写资料超过保存容量上限。')
  }
  const encrypted = encryptPurchaseDraft(config, draft.id, normalized.value)
  const previousReferences = await trx.selectFrom('purchase_draft_attachment_references')
    .select('attachment_id').where('draft_id', '=', draft.id).execute()
  const currentReferenceIds = new Set(refs.map(reference => reference.attachmentId))
  const retiredAttachmentIds = previousReferences.map(row => row.attachment_id)
    .filter(attachmentId => !currentReferenceIds.has(attachmentId))
  await trx.deleteFrom('purchase_draft_attachment_references').where('draft_id', '=', draft.id).execute()
  for (const reference of refs) {
    await trx.insertInto('purchase_draft_attachment_references').values({
      draft_id: draft.id,
      attachment_id: reference.attachmentId,
      field_id: reference.fieldId,
    }).execute()
  }
  if (retiredAttachmentIds.length) {
    await trx.updateTable('purchase_draft_attachments').set({ status: 'deleting', updated_at: new Date() })
      .where('draft_id', '=', draft.id).where('id', 'in', retiredAttachmentIds).where('status', '=', 'ready').execute()
  }
  const updated = await trx.updateTable('purchase_drafts').set({
    encrypted_payload: encrypted.ciphertext,
    payload_nonce: encrypted.nonce,
    payload_auth_tag: encrypted.authTag,
    encryption_key_id: encrypted.keyId,
  }).where('id', '=', draft.id).returning(['revision', 'expires_at']).executeTakeFirstOrThrow()
  return {
    id: draft.id,
    revision: updated.revision,
    expiresAt: updated.expires_at.toISOString(),
    complete: complete.incompleteFieldIds.length === 0,
    incompleteFieldIds: complete.incompleteFieldIds,
    normalizedValues: normalized.value,
    normalizedContentHash: purchaseFormContentIdentity(draft.template_version_id, normalized.value),
    ...(retiredAttachmentIds.length ? { replacedAttachmentIds: retiredAttachmentIds } : {}),
  }
}

export async function savePurchaseDraft(
  db: Kysely<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  input: { draftId: string; expectedRevision: number; values: unknown },
  options: { replacements?: Array<{ oldAttachmentId: string; newAttachmentId: string }> } = {},
): Promise<PurchaseDraftWriteResult> {
  return db.transaction().execute(trx => savePurchaseDraftInTransaction(trx, config, owner, input, options))
}

export async function validatePurchaseDraftForPurchaseInTransaction(
  trx: Transaction<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  reference: PurchaseDraftReference,
  mode: 'share' | 'update' = 'share',
): Promise<ValidatedPurchaseDraft> {
  const identity = await validateAndLockPurchaseDraftOwner(trx, owner, owner.kind === 'customer' ? 'update' : mode)
  const draft = await lockOwnedDraft(trx, identity, reference.draftId, mode)
  if (reference.expectedRevision !== undefined
    && (!Number.isSafeInteger(reference.expectedRevision) || draft.revision !== reference.expectedRevision)) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '填写草稿已变化，请重新确认并报价。')
  }
  if (reference.expectedTemplateVersionId && draft.template_version_id !== reference.expectedTemplateVersionId) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_TEMPLATE_VERSION_CONFLICT', '填写模板版本已变化，请重新确认并报价。')
  }
  const definition = await loadDraftTemplate(trx, draft.template_version_id)
  const attachments = await listDraftAttachments(trx, draft.id, mode === 'update')
  const values = decryptPurchaseDraft(config, draft.id, envelope(draft))
  const complete = normalizeForDraft(definition, values, attachments, true)
  if (complete.incompleteFieldIds.length) {
    throw new PurchaseDraftServiceError(400, 'PURCHASE_DRAFT_INCOMPLETE', '请完成所有必填字段和级联选择。', complete.incompleteFieldIds)
  }
  const refs = collectImageReferences(definition, complete.value)
  const byId = new Map(attachments.map(attachment => [attachment.id.toLowerCase(), attachment]))
  const imageAttachments = refs.map(reference => {
    const attachment = byId.get(reference.attachmentId.toLowerCase())
    if (!attachment || attachment.status !== 'ready' || attachment.field_id.toLowerCase() !== reference.fieldId
      || attachment.byte_size === null || attachment.width === null || attachment.height === null
      || attachment.sha256 === null) {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_UNAVAILABLE', '填写图片已变化，请重新确认并报价。')
    }
    return {
      id: attachment.id,
      fieldId: attachment.field_id,
      storageKey: attachment.storage_key,
      byteSize: attachment.byte_size,
      width: attachment.width,
      height: attachment.height,
      sha256: attachment.sha256,
    }
  })
  return {
    id: draft.id,
    revision: draft.revision,
    expiresAt: draft.expires_at.toISOString(),
    templateVersionId: draft.template_version_id,
    normalizationVersion: draft.normalization_version,
    complete: true,
    incompleteFieldIds: [],
    normalizedValues: complete.value,
    normalizedContentHash: purchaseFormContentIdentity(draft.template_version_id, complete.value),
    attachments: imageAttachments,
  }
}

export async function validatePurchaseDraftForPurchase(
  db: Kysely<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  draftId: string,
): Promise<PurchaseDraftWriteResult> {
  return db.transaction().execute(trx => validatePurchaseDraftForPurchaseInTransaction(
    trx, config, owner, { draftId },
  ))
}

export async function inspectPurchaseDraftCompleteness(
  db: Kysely<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  draftId: string,
  expectedRevision: number,
): Promise<{ revision: number; complete: boolean; incompleteFieldIds: string[] }> {
  return db.transaction().execute(async trx => {
    const identity = await validateAndLockPurchaseDraftOwner(trx, owner)
    const draft = await lockOwnedDraft(trx, identity, draftId, 'share')
    if (!Number.isSafeInteger(expectedRevision) || draft.revision !== expectedRevision) {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '填写草稿已变化，请重新读取后校验。')
    }
    const definition = await loadDraftTemplate(trx, draft.template_version_id)
    const attachments = await listDraftAttachments(trx, draft.id, false)
    const values = decryptPurchaseDraft(config, draft.id, envelope(draft))
    const complete = normalizeForDraft(definition, values, attachments, true)
    return { revision: draft.revision, complete: complete.incompleteFieldIds.length === 0,
      incompleteFieldIds: complete.incompleteFieldIds }
  })
}

export async function renewPurchaseDraft(
  db: Kysely<Database>,
  owner: PurchaseDraftOwner,
  draftId: string,
  expectedRevision: number,
  now = new Date(),
): Promise<{ revision: number; expiresAt: string }> {
  return db.transaction().execute(async (trx) => {
    const identity = await validateAndLockPurchaseDraftOwner(trx, owner)
    const draft = await lockOwnedDraft(trx, identity, draftId, 'update')
    await assertDraftNotBoundToCart(trx, draft.id)
    if (draft.revision !== expectedRevision) throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '填写草稿已被其他操作修改，请重新读取。')
    const expiresAt = new Date(now.getTime() + PURCHASE_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000)
    const updated = await trx.updateTable('purchase_drafts').set({ expires_at: expiresAt })
      .where('id', '=', draft.id).returning('revision').executeTakeFirstOrThrow()
    return { revision: updated.revision, expiresAt: expiresAt.toISOString() }
  })
}

export async function requestPurchaseDraftDeletion(
  db: Kysely<Database>,
  owner: PurchaseDraftOwner,
  draftId: string,
  expectedRevision: number,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const identity = await validateAndLockPurchaseDraftOwner(trx, owner)
    const draft = await lockOwnedDraft(trx, identity, draftId, 'update')
    await assertDraftNotBoundToCart(trx, draft.id)
    if (draft.revision !== expectedRevision) throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '填写草稿已被其他操作修改，请重新读取。')
    await trx.updateTable('purchase_drafts').set({ status: 'deleting' }).where('id', '=', draft.id).execute()
    await trx.deleteFrom('purchase_draft_attachment_references').where('draft_id', '=', draft.id).execute()
    await trx.updateTable('purchase_draft_attachments').set({ status: 'deleting', updated_at: new Date() })
      .where('draft_id', '=', draft.id).where('status', 'in', ['ready', 'failed']).execute()
  })
}

export async function requestPurchaseDraftAttachmentDeletion(
  db: Kysely<Database>,
  owner: PurchaseDraftOwner,
  draftId: string,
  attachmentId: string,
  expectedRevision: number,
): Promise<{ revision: number }> {
  return db.transaction().execute(async (trx) => {
    const identity = await validateAndLockPurchaseDraftOwner(trx, owner)
    const draft = await lockOwnedDraft(trx, identity, draftId, 'update')
    await assertDraftNotBoundToCart(trx, draft.id)
    if (draft.revision !== expectedRevision) throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '填写草稿已被其他操作修改，请重新读取。')
    if (!uuidPattern.test(attachmentId)) throw draftNotFound()
    const attachment = await trx.selectFrom('purchase_draft_attachments').selectAll()
      .where('draft_id', '=', draft.id).where('id', '=', attachmentId)
      .where('status', 'in', ['uploading', 'ready', 'failed', 'deleting']).forUpdate().executeTakeFirst()
    if (!attachment) throw draftNotFound()
    const reference = await trx.selectFrom('purchase_draft_attachment_references').select('attachment_id')
      .where('draft_id', '=', draft.id).where('attachment_id', '=', attachmentId).executeTakeFirst()
    if (reference) {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_STILL_REFERENCED', '请先从填写草稿中移除此图片，再删除图片文件。', [attachment.field_id])
    }
    if (attachment.status !== 'deleting') {
      await trx.updateTable('purchase_draft_attachments').set({ status: 'deleting', updated_at: new Date() })
        .where('id', '=', attachment.id).execute()
      const updated = await trx.updateTable('purchase_drafts').set({ updated_at: new Date() })
        .where('id', '=', draft.id).returning('revision').executeTakeFirstOrThrow()
      return { revision: updated.revision }
    }
    return { revision: draft.revision }
  })
}

export async function claimGuestPurchaseDraftsInTransaction(
  trx: Transaction<Database>,
  currentCustomer: Pick<AuthenticatedCustomer, 'id' | 'sessionId'>,
  originalGuestSessionToken: string,
  requestedDrafts: Array<string | { draftId: string; expectedRevision: number }>,
  now = new Date(),
): Promise<{ claimedCount: number; alreadyClaimedCount: number; revisions: Record<string, number> }> {
  const draftIds = requestedDrafts.map(draft => typeof draft === 'string' ? draft : draft.draftId)
  const expectedRevisions = new Map(requestedDrafts
    .filter((draft): draft is { draftId: string; expectedRevision: number } => typeof draft !== 'string')
    .map(draft => [draft.draftId.toLowerCase(), draft.expectedRevision]))
  if (!guestSessionTokenPattern.test(originalGuestSessionToken) || draftIds.length < 1 || draftIds.length > 50
    || draftIds.some(id => !uuidPattern.test(id)) || new Set(draftIds.map(id => id.toLowerCase())).size !== draftIds.length
    || [...expectedRevisions.values()].some(revision => !Number.isSafeInteger(revision) || revision < 1)) {
    throw new PurchaseDraftServiceError(400, 'PURCHASE_DRAFT_CLAIM_INVALID', '指定的填写草稿无法认领。')
  }
  const customerOwner = await validateAndLockPurchaseDraftOwner(trx, { kind: 'customer', customer: currentCustomer }, 'update')
  if (customerOwner.kind !== 'customer') throw new PurchaseDraftServiceError(401, 'UNAUTHORIZED', '顾客登录状态已失效，请重新登录。')
  const guestSession = await trx.selectFrom('guest_order_sessions').select('id')
    .where('token_hash', '=', hashToken(originalGuestSessionToken))
    .where('revoked_at', 'is', null).where('expires_at', '>', now)
    .forUpdate().executeTakeFirst()
  if (!guestSession) throw new PurchaseDraftServiceError(401, 'GUEST_SESSION_REQUIRED', '原游客会话无效或已过期。')

  const drafts = await trx.selectFrom('purchase_drafts').selectAll().where('id', 'in', draftIds)
    .orderBy('id').forUpdate().execute()
  if (drafts.length !== draftIds.length) throw draftNotFound()
  const toClaim: DraftRow[] = []
  const revisions: Record<string, number> = {}
  let claimedCount = 0
  let alreadyClaimedCount = 0
  for (const draft of drafts) {
    if (draft.status !== 'active' || draft.expires_at <= now) throw draftNotFound()
    const expectedRevision = expectedRevisions.get(draft.id.toLowerCase())
    if (expectedRevision !== undefined && draft.revision !== expectedRevision) {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '指定填写草稿已变化，请重新确认并合并购物车。')
    }
    if (draft.customer_id === customerOwner.customerId && draft.guest_order_session_id === null
      && draft.claimed_from_guest_order_session_id === guestSession.id) {
      alreadyClaimedCount += 1
      revisions[draft.id] = draft.revision
      continue
    }
    if (draft.customer_id !== null || draft.guest_order_session_id !== guestSession.id
      || draft.claimed_from_guest_order_session_id !== null) throw draftNotFound()
    toClaim.push(draft)
  }
  if (toClaim.length) {
    const activeCustomerDrafts = await trx.selectFrom('purchase_drafts')
      .select(trx.fn.countAll<number>().as('count'))
      .where('customer_id', '=', customerOwner.customerId)
      .where('guest_order_session_id', 'is', null)
      .where('status', '=', 'active').where('expires_at', '>', now)
      .executeTakeFirstOrThrow()
    if (Number(activeCustomerDrafts.count) + toClaim.length > PURCHASE_DRAFT_MAX_PER_OWNER) {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_LIMIT', '可保存的填写草稿数量已达到上限。')
    }
    const transferredAttachments = await trx.selectFrom('purchase_draft_attachments').select(['byte_size', 'reserved_bytes'])
      .where('draft_id', 'in', toClaim.map(draft => draft.id)).where('status', 'in', ['uploading', 'ready', 'failed']).execute()
    const transferredBytes = transferredAttachments.reduce((total, attachment) => total + (attachment.byte_size ?? attachment.reserved_bytes), 0)
    await assertOwnerAttachmentCapacity(trx, customerOwner, transferredBytes, undefined, transferredAttachments.length)
  }
  for (const draft of toClaim) {
    const updated = await trx.updateTable('purchase_drafts').set({
      customer_id: customerOwner.customerId,
      guest_order_session_id: null,
      claimed_from_guest_order_session_id: guestSession.id,
    }).where('id', '=', draft.id).returning('revision').executeTakeFirstOrThrow()
    revisions[draft.id] = updated.revision
    claimedCount += 1
  }
  return { claimedCount, alreadyClaimedCount, revisions }
}

export async function claimGuestPurchaseDrafts(
  db: Kysely<Database>,
  currentCustomer: Pick<AuthenticatedCustomer, 'id' | 'sessionId'>,
  originalGuestSessionToken: string,
  draftIds: string[],
  now = new Date(),
): Promise<{ claimedCount: number; alreadyClaimedCount: number }> {
  const result = await db.transaction().execute(trx => claimGuestPurchaseDraftsInTransaction(
    trx, currentCustomer, originalGuestSessionToken, draftIds, now,
  ))
  return { claimedCount: result.claimedCount, alreadyClaimedCount: result.alreadyClaimedCount }
}

async function releaseUncommittedPurchaseDraftUpload(
  db: Kysely<Database>,
  storage: PurchaseAttachmentStorage,
  draftId: string,
  attachmentId: string,
  storageKey: string,
): Promise<void> {
  const transitioned = await db.transaction().execute(async (trx) => {
    const draft = await trx.selectFrom('purchase_drafts').select(['id', 'status'])
      .where('id', '=', draftId).forUpdate().executeTakeFirst()
    if (!draft) return false
    const attachment = await trx.selectFrom('purchase_draft_attachments').select(['id', 'status'])
      .where('draft_id', '=', draftId).where('id', '=', attachmentId).forUpdate().executeTakeFirst()
    if (!attachment || attachment.status !== 'uploading') return false
    const reference = await trx.selectFrom('purchase_draft_attachment_references').select('attachment_id')
      .where('draft_id', '=', draftId).where('attachment_id', '=', attachmentId).executeTakeFirst()
    if (reference) return false
    const updated = await trx.updateTable('purchase_draft_attachments').set({ status: 'deleting', updated_at: new Date() })
      .where('draft_id', '=', draftId).where('id', '=', attachmentId).where('status', '=', 'uploading')
      .returning('id').executeTakeFirst()
    return Boolean(updated)
  })
  if (!transitioned) return

  // The deleting state releases field and owner capacity immediately. A failed
  // unlink leaves a retryable row for reconcilePurchaseDrafts.
  await storage.remove(attachmentId, storageKey)
  await db.deleteFrom('purchase_draft_attachments').where('id', '=', attachmentId)
    .where('status', '=', 'deleting').execute()
}

export async function uploadPurchaseDraftAttachment(
  db: Kysely<Database>,
  config: AppConfig,
  storage: PurchaseAttachmentStorage,
  owner: PurchaseDraftOwner,
  input: {
    draftId: string
    skuId?: string
    expectedRevision: number
    fieldId: string
    claimedMimeType: string
    expectedBytes?: number
    replaceAttachmentId?: string
    stream: AsyncIterable<Buffer | Uint8Array | string>
  },
): Promise<{ attachmentId: string; fieldId: string; mimeType: 'image/webp'; byteSize: number; width: number; height: number; sha256: string }> {
  if (!uuidPattern.test(input.fieldId)) throw new PurchaseDraftServiceError(400, 'PURCHASE_ATTACHMENT_FIELD_INVALID', '图片字段无效。')
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(input.claimedMimeType.toLowerCase())) {
    throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_FORMAT_INVALID', '仅支持 JPEG、PNG 或 WebP 图片。')
  }
  if (input.expectedBytes !== undefined && (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1)) {
    throw new PurchaseDraftServiceError(400, 'PURCHASE_ATTACHMENT_SIZE_INVALID', '图片文件大小无效。')
  }
  if (input.expectedBytes !== undefined && input.expectedBytes > PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES) {
    throw new PurchaseAttachmentError('PURCHASE_ATTACHMENT_TOO_LARGE', '图片文件超过单文件容量限制。')
  }
  const reservedBytes = input.expectedBytes ?? PURCHASE_ATTACHMENT_INPUT_LIMIT_BYTES
  const attachmentId = randomUUID()
  const storageKey = storage.storageKey(attachmentId)
  const replaceAttachmentId = input.replaceAttachmentId?.toLowerCase()
  await db.transaction().execute(async (trx) => {
    const identity = await validateAndLockPurchaseDraftOwner(trx, owner, 'update')
    const draft = await lockOwnedDraft(trx, identity, input.draftId, 'update')
    if (input.skuId) {
      const effective = await effectivePurchaseFormForSku(trx, input.skuId, { lockStatus: 'share' })
      if (!effective.templateVersionId || effective.templateVersionId !== draft.template_version_id) {
        throw new PurchaseDraftServiceError(409, 'PURCHASE_TEMPLATE_VERSION_CONFLICT', '填写模板版本已变化，请重新开始当前 SKU 的资料填写。')
      }
    }
    if (draft.revision !== input.expectedRevision) throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '填写草稿已被其他操作修改，请重新读取。')
    const definition = await loadDraftTemplate(trx, draft.template_version_id)
    const attachments = await listDraftAttachments(trx, draft.id, true)
    const oldAttachment = replaceAttachmentId ? attachments.find(attachment => attachment.id.toLowerCase() === replaceAttachmentId) : undefined
    if (replaceAttachmentId && (!oldAttachment || oldAttachment.status !== 'ready'
      || oldAttachment.field_id.toLowerCase() !== input.fieldId.toLowerCase())) {
      throw new PurchaseDraftServiceError(404, 'PURCHASE_ATTACHMENT_NOT_FOUND', '找不到可替换的填写图片。')
    }
    if (oldAttachment) {
      const reference = await trx.selectFrom('purchase_draft_attachment_references').select('attachment_id')
        .where('draft_id', '=', draft.id).where('attachment_id', '=', oldAttachment.id).forShare().executeTakeFirst()
      if (!reference) throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_REPLACEMENT_INVALID', '原图片已不在当前填写内容中。')
    }
    const excluded = new Set(oldAttachment ? [oldAttachment.id] : [])
    assertAttachmentCapacity(attachments, undefined, { id: attachmentId, bytes: reservedBytes }, excluded)
    await assertOwnerAttachmentCapacity(trx, identity, oldAttachment ? 0 : reservedBytes,
      oldAttachment ? { attachmentId: oldAttachment.id, byteSize: reservedBytes } : undefined)
    const activeAttachments = attachments.filter(attachment => attachment.status === 'ready')
    const currentValues = decryptPurchaseDraft(config, draft.id, envelope(draft))
    const normalized = normalizeForDraft(definition, currentValues, activeAttachments)
    const fieldLimit = activeImageFieldLimit(definition, normalized.value, input.fieldId)
    if (fieldLimit === null) {
      throw new PurchaseDraftServiceError(400, 'PURCHASE_ATTACHMENT_FIELD_INVALID', '图片字段当前不可用。', [input.fieldId])
    }
    if (attachments.filter(attachment => attachment.field_id === input.fieldId.toLowerCase() && attachment.status !== 'deleting'
      && attachment.id !== oldAttachment?.id).length >= fieldLimit) {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_FIELD_LIMIT', '此图片字段已达到附件数量上限。', [input.fieldId])
    }
    await trx.insertInto('purchase_draft_attachments').values({
      id: attachmentId,
      draft_id: draft.id,
      field_id: input.fieldId.toLowerCase(),
      status: 'uploading',
      storage_key: storageKey,
      mime_type: 'image/webp',
      byte_size: null,
      reserved_bytes: reservedBytes,
      width: null,
      height: null,
      sha256: null,
    }).execute()
  })

  try {
    const prepared = await processPurchaseImageUpload(input.stream, input.claimedMimeType)
    const createdKey = await storage.store(attachmentId, prepared.bytes)
    const finalized = await db.transaction().execute(async (trx) => {
      const identity = await validateAndLockPurchaseDraftOwner(trx, owner, 'update')
      const draft = await lockOwnedDraft(trx, identity, input.draftId, 'update')
      if (input.skuId) {
        const effective = await effectivePurchaseFormForSku(trx, input.skuId, { lockStatus: 'share' })
        if (!effective.templateVersionId || effective.templateVersionId !== draft.template_version_id) {
          throw new PurchaseDraftServiceError(409, 'PURCHASE_TEMPLATE_VERSION_CONFLICT', '填写模板版本已变化，请重新开始当前 SKU 的资料填写。')
        }
      }
      if (draft.revision !== input.expectedRevision) throw new PurchaseDraftServiceError(409, 'PURCHASE_DRAFT_REVISION_CONFLICT', '填写草稿已被其他操作修改，请重新读取。')
      const definition = await loadDraftTemplate(trx, draft.template_version_id)
      const currentValues = decryptPurchaseDraft(config, draft.id, envelope(draft))
      const otherAttachments = await listDraftAttachments(trx, draft.id, true)
      const existing = otherAttachments.find(attachment => attachment.id === attachmentId)
      const oldAttachment = replaceAttachmentId
        ? otherAttachments.find(attachment => attachment.id.toLowerCase() === replaceAttachmentId) : undefined
      const currentNormalized = normalizeForDraft(definition, currentValues, otherAttachments.filter(row => row.status === 'ready')).value
      const currentFieldLimit = activeImageFieldLimit(definition, currentNormalized, input.fieldId)
      if (!existing || existing.status !== 'uploading' || currentFieldLimit === null) {
        throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_UPLOAD_STALE', '图片字段或填写草稿已变化，请重新上传。', [input.fieldId])
      }
      if (replaceAttachmentId && (!oldAttachment || oldAttachment.status !== 'ready'
        || oldAttachment.field_id.toLowerCase() !== input.fieldId.toLowerCase())) {
        throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_REPLACEMENT_INVALID', '原图片已变化，请重新读取后替换。')
      }
      if (otherAttachments.filter(attachment => attachment.field_id === input.fieldId.toLowerCase() && attachment.status !== 'deleting'
        && attachment.id !== oldAttachment?.id && attachment.id !== attachmentId).length >= currentFieldLimit) {
        throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_FIELD_LIMIT', '此图片字段已达到附件数量上限。', [input.fieldId])
      }
      assertAttachmentCapacity(otherAttachments, { id: attachmentId, byteSize: prepared.byteSize }, undefined,
        new Set(oldAttachment ? [oldAttachment.id] : []))
      await assertOwnerAttachmentCapacity(trx, identity, oldAttachment ? 0 : prepared.byteSize, oldAttachment
        ? { attachmentId: oldAttachment.id, byteSize: prepared.byteSize }
        : { attachmentId, byteSize: prepared.byteSize })
      await trx.updateTable('purchase_draft_attachments').set({
        status: 'ready',
        storage_key: createdKey,
        byte_size: prepared.byteSize,
        width: prepared.width,
        height: prepared.height,
        sha256: prepared.sha256,
        updated_at: new Date(),
      }).where('id', '=', attachmentId).execute()
      return prepared
    })
    return {
      attachmentId,
      fieldId: input.fieldId.toLowerCase(),
      mimeType: 'image/webp',
      byteSize: finalized.byteSize,
      width: finalized.width,
      height: finalized.height,
      sha256: finalized.sha256,
    }
  } catch (error) {
    // Service/decoder failures are determinate. Recheck the draft and row under
    // the normal draft -> attachment lock order before releasing their quota.
    // Raw database/commit errors remain ambiguous, so preserve their object and
    // reservation for the reconciler rather than risking a committed ready row.
    if (error instanceof PurchaseDraftServiceError || error instanceof PurchaseAttachmentError) {
      await releaseUncommittedPurchaseDraftUpload(db, storage, input.draftId, attachmentId, storageKey).catch(() => undefined)
    }
    if (error instanceof PurchaseDraftServiceError || error instanceof PurchaseAttachmentError) throw error
    throw new PurchaseDraftServiceError(400, 'PURCHASE_ATTACHMENT_UPLOAD_FAILED', '图片未能安全保存，请检查文件后重试。')
  }
}

export async function readPurchaseDraftAttachment(
  db: Kysely<Database>,
  storage: PurchaseAttachmentStorage,
  owner: PurchaseDraftOwner,
  draftId: string,
  attachmentId: string,
): Promise<{ bytes: Buffer; mimeType: 'image/webp'; byteSize: number; sha256: string }> {
  return db.transaction().execute(async (trx) => {
    const identity = await validateAndLockPurchaseDraftOwner(trx, owner, 'update')
    const draft = await lockOwnedDraft(trx, identity, draftId, 'share')
    if (!uuidPattern.test(attachmentId)) throw draftNotFound()
    const attachmentQuery = trx.selectFrom('purchase_draft_attachments').selectAll()
      .where('draft_id', '=', draft.id).where('id', '=', attachmentId).where('status', '=', 'ready')
    const attachment = await attachmentQuery.forShare().executeTakeFirst()
    if (!attachment || attachment.byte_size === null || attachment.sha256 === null) throw draftNotFound()
    const bytes = await storage.readVerified(attachment.id, attachment.storage_key, attachment.byte_size, attachment.sha256)
    return { bytes, mimeType: 'image/webp', byteSize: attachment.byte_size, sha256: attachment.sha256 }
  })
}

export async function reconcilePurchaseDrafts(
  db: Kysely<Database>,
  storage: PurchaseAttachmentStorage,
  options: { repair: boolean; now?: Date; graceHours?: number; batchSize?: number },
): Promise<{ expiredDrafts: number; deletingAttachments: number; missingObjects: number; oldOrphanFiles: number; removedFiles: number }> {
  const now = options.now ?? new Date()
  const graceMs = (options.graceHours ?? PURCHASE_DRAFT_RECONCILE_GRACE_HOURS) * 60 * 60 * 1000
  const cutoff = new Date(now.getTime() - graceMs)
  const batchSize = Math.min(500, Math.max(1, options.batchSize ?? 100))
  let expiredDrafts = 0
  let oldOrphanFiles = 0
  let removedFiles = 0

  if (options.repair) {
    await db.transaction().execute(async (trx) => {
      const expired = await trx.selectFrom('purchase_drafts').select('id')
        .where('status', '=', 'active').where('expires_at', '<=', now)
        .orderBy('expires_at').orderBy('id').limit(batchSize).forUpdate().skipLocked().execute()
      for (const draft of expired) {
        await trx.updateTable('purchase_drafts').set({ status: 'deleting' }).where('id', '=', draft.id).execute()
        await trx.deleteFrom('purchase_draft_attachment_references').where('draft_id', '=', draft.id).execute()
        await trx.updateTable('purchase_draft_attachments').set({ status: 'deleting', updated_at: now })
          .where('draft_id', '=', draft.id).where('status', 'in', ['ready', 'failed']).execute()
      }
      expiredDrafts = expired.length

      const staleUploading = await trx.selectFrom('purchase_draft_attachments as attachment')
        .innerJoin('purchase_drafts as draft', 'draft.id', 'attachment.draft_id')
        .select(['attachment.id', 'draft.status as draft_status'])
        .where('attachment.status', '=', 'uploading').where('attachment.created_at', '<=', cutoff)
        .orderBy('attachment.created_at').orderBy('attachment.id').limit(batchSize).forUpdate('attachment').skipLocked().execute()
      for (const row of staleUploading) {
        await trx.updateTable('purchase_draft_attachments').set({ status: row.draft_status === 'deleting' ? 'deleting' : 'failed', updated_at: now })
          .where('id', '=', row.id).where('status', '=', 'uploading').execute()
      }

      await trx.updateTable('purchase_draft_attachments').set({ status: 'deleting', updated_at: now })
        .where('status', '=', 'failed').where('created_at', '<=', cutoff).execute()
      const oldReady = await trx.selectFrom('purchase_draft_attachments as attachment')
        .innerJoin('purchase_drafts as draft', 'draft.id', 'attachment.draft_id')
        .select(['attachment.id', 'attachment.draft_id'])
        .where('attachment.status', '=', 'ready').where('attachment.created_at', '<=', cutoff)
        .where(eb => eb.or([eb('draft.status', '=', 'deleting'), eb('draft.expires_at', '<=', now)]))
        .orderBy('attachment.created_at').orderBy('attachment.id').limit(batchSize).execute()
      for (const candidate of oldReady) {
        const draft = await trx.selectFrom('purchase_drafts').select(['id', 'status', 'expires_at'])
          .where('id', '=', candidate.draft_id).forUpdate().skipLocked().executeTakeFirst()
        if (!draft) continue
        const stillExpired = draft.status === 'deleting' || (draft.status === 'active' && draft.expires_at <= now)
        if (!stillExpired) continue
        const attachment = await trx.selectFrom('purchase_draft_attachments').select(['id', 'created_at'])
          .where('id', '=', candidate.id).where('draft_id', '=', candidate.draft_id)
          .where('status', '=', 'ready').where('created_at', '<=', cutoff)
          .forUpdate().skipLocked().executeTakeFirst()
        if (!attachment) continue
        if (attachment.created_at > cutoff) continue
        const reference = await trx.selectFrom('purchase_draft_attachment_references').select('attachment_id')
          .where('draft_id', '=', candidate.draft_id).where('attachment_id', '=', candidate.id).executeTakeFirst()
        if (!reference) {
          await trx.updateTable('purchase_draft_attachments').set({ status: 'deleting', updated_at: now })
            .where('id', '=', candidate.id).where('status', '=', 'ready').execute()
        }
      }
    })

    const pending = await db.selectFrom('purchase_draft_attachments').selectAll()
      .where('status', '=', 'deleting').orderBy('created_at').orderBy('id').limit(batchSize).execute()
    for (const attachment of pending) {
      try {
        await storage.remove(attachment.id, attachment.storage_key)
        const deleted = await db.deleteFrom('purchase_draft_attachments')
          .where('id', '=', attachment.id).where('status', '=', 'deleting').executeTakeFirst()
        if (Number(deleted.numDeletedRows) > 0) removedFiles += 1
      } catch {
        // Keep the deleting row so the next repair can retry safely.
      }
    }
    const candidates = await db.selectFrom('purchase_drafts').select('id')
      .where('status', '=', 'deleting').orderBy('id').limit(batchSize).execute()
    const removableDrafts: Array<{ id: string }> = []
    for (const draft of candidates) {
      const attachment = await db.selectFrom('purchase_draft_attachments').select('id')
        .where('draft_id', '=', draft.id).executeTakeFirst()
      if (!attachment) removableDrafts.push(draft)
    }
    for (const draft of removableDrafts) {
      await db.deleteFrom('purchase_drafts').where('id', '=', draft.id).where('status', '=', 'deleting').execute()
    }
  }

  const readyRows = await db.selectFrom('purchase_draft_attachments').select(['id', 'storage_key', 'status'])
    .where('status', '=', 'ready').execute()
  const expected = new Map(readyRows.map(row => [row.storage_key, row]))
  const files = await storage.scanFiles()
  const objectFiles = files.filter(file => file.location === 'object')
  const byStorageKey = new Map(objectFiles.map(file => [file.storageKey, file]))
  const missingObjects = readyRows.filter(row => !byStorageKey.has(row.storage_key)).length
  for (const file of files) {
    const registered = file.location === 'object'
      ? expected.has(file.storageKey)
      : await db.selectFrom('purchase_draft_attachments').select('id').where('id', '=', file.id)
        .where('status', '=', 'uploading').executeTakeFirst().then(Boolean)
    if (!registered && file.modifiedAt <= cutoff) {
      oldOrphanFiles += 1
      if (options.repair) {
        try { await storage.removeScannedFile(file.path); removedFiles += 1 } catch { /* retain for a later retry */ }
      }
    }
  }
  const deletingAttachments = Number((await db.selectFrom('purchase_draft_attachments').select(db.fn.countAll<number>().as('count'))
    .where('status', '=', 'deleting').executeTakeFirstOrThrow()).count)
  return { expiredDrafts, deletingAttachments, missingObjects, oldOrphanFiles, removedFiles }
}
