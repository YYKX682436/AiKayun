import { randomUUID } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import type { AppConfig } from '../config.js'
import type { OrderPurchaseSnapshot } from '@aikayun/contracts'
import type { Database } from '../db/types.js'
import { PurchaseAttachmentStorage, PurchaseAttachmentError } from '../media/purchase-attachment-storage.js'
import { PurchaseOrderAttachmentStorage } from '../media/purchase-order-attachment-storage.js'
import {
  decryptPurchaseOrderValues,
  encryptPurchaseOrderValues,
} from './purchase-form-crypto.js'
import {
  PurchaseDraftServiceError,
  validateAndLockPurchaseDraftOwner,
} from './purchase-forms.js'
import type { PurchaseDraftOwner, ValidatedPurchaseDraft } from './purchase-forms.js'

export interface PreparedPurchaseOrderAttachment {
  objectId: string
  sourceDraftId: string
  sourceAttachmentId: string
  fieldId: string
  storageKey: string
  byteSize: number
  width: number
  height: number
  sha256: string
}

export async function preparePurchaseOrderAttachments(
  db: Kysely<Database>,
  sourceStorage: PurchaseAttachmentStorage,
  orderStorage: PurchaseOrderAttachmentStorage,
  draft: ValidatedPurchaseDraft,
): Promise<PreparedPurchaseOrderAttachment[]> {
  const prepared: PreparedPurchaseOrderAttachment[] = []
  for (const attachment of draft.attachments) {
    // The source may change after this read. The order transaction must lock
    // and compare the draft, attachment metadata, and revision again.
    const bytes = await sourceStorage.readVerified(
      attachment.id, attachment.storageKey, attachment.byteSize, attachment.sha256,
    )
    const objectId = randomUUID()
    const storageKey = await orderStorage.store(objectId, bytes, attachment.sha256)
    await db.insertInto('purchase_order_attachment_objects').values({
      id: objectId,
      source_draft_id: draft.id,
      source_attachment_id: attachment.id,
      storage_key: storageKey,
      mime_type: 'image/webp',
      byte_size: attachment.byteSize,
      width: attachment.width,
      height: attachment.height,
      sha256: attachment.sha256,
      status: 'prepared',
    }).execute()
    prepared.push({
      objectId,
      sourceDraftId: draft.id,
      sourceAttachmentId: attachment.id,
      fieldId: attachment.fieldId,
      storageKey,
      byteSize: attachment.byteSize,
      width: attachment.width,
      height: attachment.height,
      sha256: attachment.sha256,
    })
  }
  return prepared
}

export async function persistOrderPurchaseSnapshotInTransaction(
  trx: Transaction<Database>,
  config: AppConfig,
  input: {
    orderItemId: string
    contentIdentity: string
    draft: ValidatedPurchaseDraft | null
    preparedAttachments: PreparedPurchaseOrderAttachment[]
  },
): Promise<void> {
  const { orderItemId, contentIdentity, draft, preparedAttachments } = input
  if (!/^[0-9a-f]{64}$/u.test(contentIdentity)) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_CONTENT_IDENTITY_INVALID', '成交资料身份无效，请重新报价。')
  }
  if (!draft) {
    if (preparedAttachments.length) {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_UNEXPECTED', '成交图片与购买行不匹配。')
    }
    await trx.insertInto('order_item_purchase_snapshots').values({
      order_item_id: orderItemId,
      template_version_id: null,
      normalization_version: null,
      content_identity: contentIdentity,
      encrypted_values: null,
      values_nonce: null,
      values_auth_tag: null,
      encryption_key_id: null,
      attachment_ids: [],
    }).execute()
    return
  }
  if (draft.attachments.length !== preparedAttachments.length) {
    throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_CHANGED', '填写图片已变化，请重新报价。')
  }
  const ids = new Set<string>()
  for (let index = 0; index < draft.attachments.length; index += 1) {
    const source = draft.attachments[index]!
    const archive = preparedAttachments[index]!
    if (ids.has(source.id) || source.id !== archive.sourceAttachmentId
      || draft.id !== archive.sourceDraftId || source.fieldId !== archive.fieldId
      || source.sha256 !== archive.sha256 || source.byteSize !== archive.byteSize
      || source.width !== archive.width || source.height !== archive.height
      || source.storageKey.length === 0) {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_CHANGED', '填写图片已变化，请重新报价。')
    }
    ids.add(source.id)
  }
  const encrypted = encryptPurchaseOrderValues(config, orderItemId, draft.normalizedValues)
  await trx.insertInto('order_item_purchase_snapshots').values({
    order_item_id: orderItemId,
    template_version_id: draft.templateVersionId,
    normalization_version: draft.normalizationVersion,
    content_identity: contentIdentity,
    encrypted_values: encrypted.ciphertext,
    values_nonce: encrypted.nonce,
    values_auth_tag: encrypted.authTag,
    encryption_key_id: encrypted.keyId,
    attachment_ids: draft.attachments.map(attachment => attachment.id),
  }).execute()
  for (let index = 0; index < preparedAttachments.length; index += 1) {
    const source = draft.attachments[index]!
    const archive = preparedAttachments[index]!
    const object = await trx.selectFrom('purchase_order_attachment_objects').selectAll()
      .where('id', '=', archive.objectId).forUpdate().executeTakeFirst()
    if (!object || object.status !== 'prepared' || object.source_draft_id !== draft.id
      || object.source_attachment_id !== source.id || object.storage_key !== archive.storageKey
      || object.sha256 !== source.sha256 || object.byte_size !== source.byteSize
      || object.width !== source.width || object.height !== source.height
      || object.mime_type !== 'image/webp') {
      throw new PurchaseDraftServiceError(409, 'PURCHASE_ATTACHMENT_CHANGED', '成交图片归档已变化，请重新报价。')
    }
    await trx.insertInto('order_item_purchase_attachments').values({
      order_item_id: orderItemId,
      source_attachment_id: source.id,
      archive_object_id: object.id,
      field_id: source.fieldId,
      ordinal: index + 1,
      sha256: source.sha256,
      byte_size: source.byteSize,
    }).execute()
    await trx.updateTable('purchase_order_attachment_objects').set({
      status: 'retained',
      updated_at: new Date(),
    }).where('id', '=', object.id).where('status', '=', 'prepared').execute()
  }
}

export type OwnedOrderPurchaseSnapshot = OrderPurchaseSnapshot

async function ownedOrderItem(
  trx: Transaction<Database>,
  owner: PurchaseDraftOwner,
  orderItemId: string,
): Promise<boolean> {
  const identity = await validateAndLockPurchaseDraftOwner(trx, owner)
  const query = trx.selectFrom('order_items as item')
    .innerJoin('orders as order', 'order.id', 'item.order_id')
    .select('item.id').where('item.id', '=', orderItemId)
  const row = identity.kind === 'customer'
    ? await query.where('order.customer_id', '=', identity.customerId).executeTakeFirst()
    : await query.where('order.guest_order_session_id', '=', identity.guestSessionId).executeTakeFirst()
  return Boolean(row)
}

export async function getOwnedOrderPurchaseSnapshot(
  db: Kysely<Database>,
  config: AppConfig,
  owner: PurchaseDraftOwner,
  orderItemId: string,
): Promise<OwnedOrderPurchaseSnapshot> {
  return db.transaction().execute(async trx => {
    if (!await ownedOrderItem(trx, owner, orderItemId)) {
      throw new PurchaseDraftServiceError(404, 'ORDER_ITEM_NOT_FOUND', '找不到可访问的订单项。')
    }
    const snapshot = await trx.selectFrom('order_item_purchase_snapshots').selectAll()
      .where('order_item_id', '=', orderItemId).executeTakeFirst()
    if (!snapshot) {
      return {
        state: 'legacy', orderItemId, templateVersionId: null, normalizationVersion: null,
        contentIdentity: null, values: null, attachments: [],
      }
    }
    const rows = await trx.selectFrom('order_item_purchase_attachments').selectAll()
      .where('order_item_id', '=', orderItemId).orderBy('ordinal').execute()
    const attachments = rows.map(row => ({
      attachmentId: row.source_attachment_id,
      fieldId: row.field_id,
      byteSize: row.byte_size,
      sha256: row.sha256,
    }))
    if (snapshot.template_version_id === null) {
      return {
        state: 'none', orderItemId, templateVersionId: null, normalizationVersion: null,
        contentIdentity: snapshot.content_identity, values: null, attachments,
      }
    }
    if (!snapshot.normalization_version || !snapshot.encryption_key_id || !snapshot.encrypted_values
      || !snapshot.values_nonce || !snapshot.values_auth_tag) {
      throw new PurchaseDraftServiceError(503, 'PURCHASE_ORDER_SNAPSHOT_INVALID', '成交资料暂时无法读取。')
    }
    const values = decryptPurchaseOrderValues(config, orderItemId, {
      keyId: snapshot.encryption_key_id,
      ciphertext: snapshot.encrypted_values,
      nonce: snapshot.values_nonce,
      authTag: snapshot.values_auth_tag,
    })
    return {
      state: 'filled', orderItemId, templateVersionId: snapshot.template_version_id,
      normalizationVersion: snapshot.normalization_version,
      contentIdentity: snapshot.content_identity, values, attachments,
    }
  })
}

export async function readOwnedOrderPurchaseAttachment(
  db: Kysely<Database>,
  storage: PurchaseOrderAttachmentStorage,
  owner: PurchaseDraftOwner,
  orderItemId: string,
  sourceAttachmentId: string,
): Promise<{ bytes: Buffer; mimeType: 'image/webp'; byteSize: number; sha256: string }> {
  const object = await db.transaction().execute(async trx => {
    if (!await ownedOrderItem(trx, owner, orderItemId)) {
      throw new PurchaseDraftServiceError(404, 'ORDER_ATTACHMENT_NOT_FOUND', '找不到可访问的成交图片。')
    }
    const row = await trx.selectFrom('order_item_purchase_attachments as reference')
      .innerJoin('purchase_order_attachment_objects as object', 'object.id', 'reference.archive_object_id')
      .select(['object.id', 'object.storage_key', 'object.byte_size', 'object.sha256', 'object.status'])
      .where('reference.order_item_id', '=', orderItemId)
      .where('reference.source_attachment_id', '=', sourceAttachmentId)
      .executeTakeFirst()
    if (!row || row.status !== 'retained') {
      throw new PurchaseDraftServiceError(404, 'ORDER_ATTACHMENT_NOT_FOUND', '找不到可访问的成交图片。')
    }
    return row
  })
  const bytes = await storage.readVerified(object.id, object.storage_key, object.byte_size, object.sha256)
  return { bytes, mimeType: 'image/webp', byteSize: object.byte_size, sha256: object.sha256 }
}

export async function reconcilePurchaseOrderAttachments(
  db: Kysely<Database>,
  storage: PurchaseOrderAttachmentStorage,
  options: { repair: boolean; now?: Date; graceHours?: number; batchSize?: number },
): Promise<{ prepared: number; deleting: number; missingRetained: number; orphanFiles: number; removedFiles: number }> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - Math.max(24, options.graceHours ?? 24) * 60 * 60 * 1000)
  const batchSize = Math.min(500, Math.max(1, options.batchSize ?? 100))
  let removedFiles = 0
  if (options.repair) {
    await db.transaction().execute(async trx => {
      const candidates = await trx.selectFrom('purchase_order_attachment_objects').select(['id'])
        .where('status', '=', 'prepared').where('created_at', '<=', cutoff)
        .orderBy('created_at').orderBy('id').limit(batchSize)
        .forUpdate().skipLocked().execute()
      for (const candidate of candidates) {
        const bound = await trx.selectFrom('order_item_purchase_attachments').select('archive_object_id')
          .where('archive_object_id', '=', candidate.id).executeTakeFirst()
        if (!bound) {
          await trx.updateTable('purchase_order_attachment_objects').set({
            status: 'deleting', updated_at: now,
          }).where('id', '=', candidate.id).where('status', '=', 'prepared').execute()
        }
      }
    })
    const deleting = await db.selectFrom('purchase_order_attachment_objects').selectAll()
      .where('status', '=', 'deleting').orderBy('created_at').orderBy('id').limit(batchSize).execute()
    for (const object of deleting) {
      try {
        // The object must already be committed as deleting before any unlink.
        await storage.remove(object.id, object.storage_key)
        const deleted = await db.deleteFrom('purchase_order_attachment_objects')
          .where('id', '=', object.id).where('status', '=', 'deleting').executeTakeFirst()
        if (Number(deleted.numDeletedRows) > 0) removedFiles += 1
      } catch {
        // Preserve the row so a later repair can retry.
      }
    }
  }
  const objects = await db.selectFrom('purchase_order_attachment_objects')
    .select(['id', 'storage_key', 'status']).execute()
  const rowsByKey = new Map(objects.map(object => [object.storage_key, object]))
  const files = await storage.scanFiles()
  const present = new Set(files.filter(file => file.location === 'object').map(file => file.storageKey))
  const missingRetained = objects.filter(object => object.status === 'retained' && !present.has(object.storage_key)).length
  let orphanFiles = 0
  for (const file of files) {
    const registered = file.location === 'object'
      ? rowsByKey.has(file.storageKey)
      : objects.some(object => object.id === file.id && object.status === 'prepared')
    if (!registered && file.modifiedAt <= cutoff) {
      orphanFiles += 1
      if (options.repair) {
        try { await storage.removeScannedFile(file.path); removedFiles += 1 } catch { /* retry later */ }
      }
    }
  }
  return {
    prepared: objects.filter(object => object.status === 'prepared').length,
    deleting: objects.filter(object => object.status === 'deleting').length,
    missingRetained, orphanFiles, removedFiles,
  }
}

export function isPurchaseOrderAttachmentError(error: unknown): error is PurchaseAttachmentError {
  return error instanceof PurchaseAttachmentError
}
