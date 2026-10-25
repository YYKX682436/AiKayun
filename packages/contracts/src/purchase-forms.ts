import { Type, type Static } from 'typebox'

export const PURCHASE_FORM_NORMALIZATION_VERSION = 1 as const

export const PURCHASE_FORM_LIMITS = {
  definitionBytes: 48 * 1024,
  requestBytes: 64 * 1024,
  topLevelFields: 30,
  totalFields: 60,
  optionChildren: 20,
  optionNodes: 200,
  optionDepth: 5,
  labelCharacters: 120,
  meaningKeyCharacters: 64,
  placeholderCharacters: 180,
  helpCharacters: 240,
  answerCharactersPerField: 4_000,
  answerCharactersTotal: 16_000,
  attachmentsPerDraft: 10,
  attachmentBytes: 5 * 1024 * 1024,
  attachmentBytesPerDraft: 20 * 1024 * 1024,
  attachmentsPerOwner: 100,
  attachmentBytesPerOwner: 100 * 1024 * 1024,
  attachmentPixels: 16_000_000,
} as const

const IdentitySchema = Type.String({ format: 'uuid' })
const MeaningKeySchema = Type.String({
  minLength: 1,
  maxLength: PURCHASE_FORM_LIMITS.meaningKeyCharacters,
  pattern: '^[a-z][a-z0-9_]*$',
})

export const PurchaseFormLeafFieldSchema = Type.Union([
  Type.Object({
    id: IdentitySchema,
    meaningKey: MeaningKeySchema,
    type: Type.Literal('text'),
    label: Type.String({ minLength: 1, maxLength: PURCHASE_FORM_LIMITS.labelCharacters }),
    required: Type.Boolean(),
    placeholder: Type.Optional(Type.String({ maxLength: PURCHASE_FORM_LIMITS.placeholderCharacters })),
    helpText: Type.Optional(Type.String({ maxLength: PURCHASE_FORM_LIMITS.helpCharacters })),
    maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: PURCHASE_FORM_LIMITS.answerCharactersPerField })),
  }, { additionalProperties: false }),
  Type.Object({
    id: IdentitySchema,
    meaningKey: MeaningKeySchema,
    type: Type.Literal('textarea'),
    label: Type.String({ minLength: 1, maxLength: PURCHASE_FORM_LIMITS.labelCharacters }),
    required: Type.Boolean(),
    placeholder: Type.Optional(Type.String({ maxLength: PURCHASE_FORM_LIMITS.placeholderCharacters })),
    helpText: Type.Optional(Type.String({ maxLength: PURCHASE_FORM_LIMITS.helpCharacters })),
    maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: PURCHASE_FORM_LIMITS.answerCharactersPerField })),
  }, { additionalProperties: false }),
  Type.Object({
    id: IdentitySchema,
    meaningKey: MeaningKeySchema,
    type: Type.Literal('digits'),
    label: Type.String({ minLength: 1, maxLength: PURCHASE_FORM_LIMITS.labelCharacters }),
    required: Type.Boolean(),
    placeholder: Type.Optional(Type.String({ maxLength: PURCHASE_FORM_LIMITS.placeholderCharacters })),
    helpText: Type.Optional(Type.String({ maxLength: PURCHASE_FORM_LIMITS.helpCharacters })),
    maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: PURCHASE_FORM_LIMITS.answerCharactersPerField })),
  }, { additionalProperties: false }),
  Type.Object({
    id: IdentitySchema,
    meaningKey: MeaningKeySchema,
    type: Type.Literal('select'),
    label: Type.String({ minLength: 1, maxLength: PURCHASE_FORM_LIMITS.labelCharacters }),
    required: Type.Boolean(),
    helpText: Type.Optional(Type.String({ maxLength: PURCHASE_FORM_LIMITS.helpCharacters })),
    options: Type.Array(Type.Object({
      id: IdentitySchema,
      meaningKey: MeaningKeySchema,
      label: Type.String({ minLength: 1, maxLength: PURCHASE_FORM_LIMITS.labelCharacters }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: PURCHASE_FORM_LIMITS.optionChildren }),
  }, { additionalProperties: false }),
  Type.Object({
    id: IdentitySchema,
    meaningKey: MeaningKeySchema,
    type: Type.Literal('image'),
    label: Type.String({ minLength: 1, maxLength: PURCHASE_FORM_LIMITS.labelCharacters }),
    required: Type.Boolean(),
    helpText: Type.Optional(Type.String({ maxLength: PURCHASE_FORM_LIMITS.helpCharacters })),
    maxCount: Type.Integer({ minimum: 1, maximum: 3 }),
  }, { additionalProperties: false }),
])

export const PurchaseFormCascadeOptionSchema = Type.Object({
  id: IdentitySchema,
  meaningKey: MeaningKeySchema,
  label: Type.String({ minLength: 1, maxLength: PURCHASE_FORM_LIMITS.labelCharacters }),
  children: Type.Optional(Type.Array(Type.Unknown(), { maxItems: PURCHASE_FORM_LIMITS.optionChildren })),
  expandedFields: Type.Optional(Type.Array(PurchaseFormLeafFieldSchema, { maxItems: PURCHASE_FORM_LIMITS.totalFields })),
}, { additionalProperties: false })

export const PurchaseFormFieldSchema = Type.Union([
  PurchaseFormLeafFieldSchema,
  Type.Object({
    id: IdentitySchema,
    meaningKey: MeaningKeySchema,
    type: Type.Literal('cascade'),
    label: Type.String({ minLength: 1, maxLength: PURCHASE_FORM_LIMITS.labelCharacters }),
    required: Type.Boolean(),
    helpText: Type.Optional(Type.String({ maxLength: PURCHASE_FORM_LIMITS.helpCharacters })),
    options: Type.Array(PurchaseFormCascadeOptionSchema, { minItems: 1, maxItems: PURCHASE_FORM_LIMITS.optionChildren }),
  }, { additionalProperties: false }),
])

// Cascades are checked iteratively by validatePurchaseFormDefinition. Nested
// children stay non-recursive here so hostile depth is rejected by the bounded
// validator before framework recursion can overflow the stack.
export const PurchaseFormDefinitionSchema = Type.Object({
  fields: Type.Array(PurchaseFormFieldSchema, { maxItems: PURCHASE_FORM_LIMITS.topLevelFields }),
}, { additionalProperties: false })

export const PurchaseTemplateIdParamsSchema = Type.Object({ id: IdentitySchema }, { additionalProperties: false })
export const PurchaseTemplateVersionParamsSchema = Type.Object({ id: IdentitySchema, versionId: IdentitySchema }, { additionalProperties: false })
export const PurchaseTemplateListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false })
export const PurchaseTemplateVersionsQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false })

export const PurchaseTemplateCreateBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  definition: PurchaseFormDefinitionSchema,
}, { additionalProperties: false })

export const PurchaseTemplateUpdateBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  definition: PurchaseFormDefinitionSchema,
}, { additionalProperties: false })

export const PurchaseTemplateFreezeBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const ProductPurchaseFormAssignmentBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  mode: Type.Union([Type.Literal('not_configured'), Type.Literal('none'), Type.Literal('template')]),
  templateVersionId: Type.Optional(IdentitySchema),
}, { additionalProperties: false })

export const SkuPurchaseFormAssignmentBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  mode: Type.Union([Type.Literal('product_default'), Type.Literal('none'), Type.Literal('template')]),
  templateVersionId: Type.Optional(IdentitySchema),
}, { additionalProperties: false })

export const ProductPurchaseFormParamsSchema = Type.Object({ id: IdentitySchema }, { additionalProperties: false })
export const SkuPurchaseFormParamsSchema = Type.Object({ id: IdentitySchema, variantId: IdentitySchema }, { additionalProperties: false })

export const PurchaseTemplateSummarySchema = Type.Object({
  id: IdentitySchema,
  name: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  latestVersionNumber: Type.Integer({ minimum: 0 }),
  fieldCount: Type.Integer({ minimum: 0 }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const PurchaseTemplateVersionSchema = Type.Object({
  id: IdentitySchema,
  templateId: IdentitySchema,
  versionNumber: Type.Integer({ minimum: 1 }),
  name: Type.String(),
  definition: PurchaseFormDefinitionSchema,
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const PurchaseTemplateDetailSchema = Type.Object({
  template: PurchaseTemplateSummarySchema,
  definition: PurchaseFormDefinitionSchema,
  latestVersion: Type.Union([PurchaseTemplateVersionSchema, Type.Null()]),
}, { additionalProperties: false })

export const PurchaseTemplateListSchema = Type.Object({
  items: Type.Array(PurchaseTemplateSummarySchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
}, { additionalProperties: false })

export const PurchaseTemplateVersionsSchema = Type.Object({
  items: Type.Array(Type.Omit(PurchaseTemplateVersionSchema, ['definition', 'sha256'])),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
}, { additionalProperties: false })

export const PurchaseFormAssignmentVersionSchema = Type.Object({
  id: IdentitySchema,
  templateId: IdentitySchema,
  templateName: Type.String(),
  versionNumber: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const ProductPurchaseFormAssignmentSchema = Type.Object({
  productId: IdentitySchema,
  productRevision: Type.Integer({ minimum: 1 }),
  mode: Type.Union([Type.Literal('not_configured'), Type.Literal('none'), Type.Literal('template')]),
  templateVersion: Type.Union([PurchaseFormAssignmentVersionSchema, Type.Null()]),
  appliedMode: Type.Union([Type.Literal('none'), Type.Literal('template'), Type.Null()]),
  appliedTemplateVersion: Type.Union([PurchaseFormAssignmentVersionSchema, Type.Null()]),
  pendingApply: Type.Boolean(),
}, { additionalProperties: false })

export const SkuPurchaseFormAssignmentSchema = Type.Object({
  productId: IdentitySchema,
  variantId: IdentitySchema,
  productRevision: Type.Integer({ minimum: 1 }),
  mode: Type.Union([Type.Literal('product_default'), Type.Literal('none'), Type.Literal('template')]),
  templateVersion: Type.Union([PurchaseFormAssignmentVersionSchema, Type.Null()]),
  productDefault: ProductPurchaseFormAssignmentSchema,
  appliedMode: Type.Union([Type.Literal('inherit'), Type.Literal('none'), Type.Literal('template'), Type.Null()]),
  appliedTemplateVersion: Type.Union([PurchaseFormAssignmentVersionSchema, Type.Null()]),
  pendingApply: Type.Boolean(),
}, { additionalProperties: false })

export const PurchaseFormsStatusSchema = Type.Union([
  Type.Literal('preparing'), Type.Literal('active'), Type.Literal('paused'),
])
export const PurchaseFormsLifecycleSchema = Type.Object({
  status: PurchaseFormsStatusSchema,
  impactHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  productCount: Type.Integer({ minimum: 0 }),
  skuCount: Type.Integer({ minimum: 0 }),
  skuWithTemplateCount: Type.Integer({ minimum: 0 }),
  templateVersionCount: Type.Integer({ minimum: 0 }),
  invalidTemplateVersionCount: Type.Integer({ minimum: 0 }),
  manualHandlingSkuCount: Type.Integer({ minimum: 0 }),
  automaticFulfillmentSkuCount: Type.Integer({ minimum: 0 }),
  pendingProductApplyCount: Type.Integer({ minimum: 0 }),
  pendingSkuApplyCount: Type.Integer({ minimum: 0 }),
  readyToActivate: Type.Boolean(),
}, { additionalProperties: false })
export const PurchaseFormsTransitionBodySchema = Type.Object({
  expectedStatus: PurchaseFormsStatusSchema,
  nextStatus: Type.Union([Type.Literal('active'), Type.Literal('paused')]),
  expectedImpactHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
}, { additionalProperties: false })
export const ProductPurchaseFormApplyBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  expectedMode: Type.Union([Type.Literal('not_configured'), Type.Literal('none'), Type.Literal('template')]),
  expectedTemplateVersionId: Type.Union([IdentitySchema, Type.Null()]),
}, { additionalProperties: false })
export const SkuPurchaseFormApplyBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  expectedMode: Type.Union([Type.Literal('product_default'), Type.Literal('none'), Type.Literal('template')]),
  expectedTemplateVersionId: Type.Union([IdentitySchema, Type.Null()]),
}, { additionalProperties: false })

export const StorefrontPurchaseFormSchema = Type.Object({
  skuId: IdentitySchema,
  status: PurchaseFormsStatusSchema,
  required: Type.Boolean(),
  templateVersionId: Type.Union([IdentitySchema, Type.Null()]),
  templateName: Type.Union([Type.String(), Type.Null()]),
  versionNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  definition: Type.Union([PurchaseFormDefinitionSchema, Type.Null()]),
}, { additionalProperties: false })
export const PurchaseDraftCreateBodySchema = Type.Object({ skuId: IdentitySchema }, { additionalProperties: false })
export const PurchaseDraftAttachmentSchema = Type.Object({
  id: IdentitySchema,
  fieldId: IdentitySchema,
  mimeType: Type.Literal('image/webp'),
  byteSize: Type.Integer({ minimum: 1, maximum: PURCHASE_FORM_LIMITS.attachmentBytes }),
  width: Type.Integer({ minimum: 1, maximum: 8192 }),
  height: Type.Integer({ minimum: 1, maximum: 8192 }),
  replacesAttachmentId: Type.Optional(IdentitySchema),
  url: Type.String({ minLength: 1, maxLength: 2048 }),
}, { additionalProperties: false })
export const PurchaseDraftSchema = Type.Object({
  id: IdentitySchema,
  skuId: IdentitySchema,
  templateVersionId: IdentitySchema,
  revision: Type.Integer({ minimum: 1 }),
  normalizationVersion: Type.Integer({ minimum: 1 }),
  expiresAt: Type.String({ format: 'date-time' }),
  values: Type.Record(IdentitySchema, Type.Unknown()),
  attachments: Type.Array(PurchaseDraftAttachmentSchema, { maxItems: PURCHASE_FORM_LIMITS.attachmentsPerDraft }),
  templateChanged: Type.Boolean(),
}, { additionalProperties: false })
export const PurchaseDraftValidationBodySchema = Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })
export const PurchaseDraftValidationSchema = Type.Object({
  complete: Type.Boolean(),
  incompleteFieldIds: Type.Array(IdentitySchema, { maxItems: PURCHASE_FORM_LIMITS.totalFields }),
}, { additionalProperties: false })
export const PurchaseDraftDeleteBodySchema = Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })
export const PurchaseDraftAttachmentUploadSchema = Type.Object({
  attachmentId: IdentitySchema,
  fieldId: IdentitySchema,
  mimeType: Type.Literal('image/webp'),
  byteSize: Type.Integer({ minimum: 1, maximum: PURCHASE_FORM_LIMITS.attachmentBytes }),
  width: Type.Integer({ minimum: 1, maximum: 8192 }),
  height: Type.Integer({ minimum: 1, maximum: 8192 }),
}, { additionalProperties: false })

export const PurchaseTemplateMutationSchema = Type.Object({
  template: PurchaseTemplateSummarySchema,
  definition: PurchaseFormDefinitionSchema,
}, { additionalProperties: false })

export const PurchaseDraftSaveBodySchema = Type.Object({
  skuId: IdentitySchema,
  expectedRevision: Type.Integer({ minimum: 1 }),
  values: Type.Record(Type.String({ format: 'uuid' }), Type.Unknown()),
  replacements: Type.Optional(Type.Array(Type.Object({
    oldAttachmentId: IdentitySchema,
    newAttachmentId: IdentitySchema,
  }, { additionalProperties: false }), { maxItems: PURCHASE_FORM_LIMITS.attachmentsPerDraft })),
}, { additionalProperties: false })

export const OrderPurchaseAttachmentSchema = Type.Object({
  attachmentId: IdentitySchema,
  fieldId: IdentitySchema,
  byteSize: Type.Integer({ minimum: 1, maximum: PURCHASE_FORM_LIMITS.attachmentBytes }),
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
}, { additionalProperties: false })

const OrderPurchaseSnapshotBase = {
  orderItemId: IdentitySchema,
}

export const OrderPurchaseSnapshotSchema = Type.Union([
  Type.Object({
    ...OrderPurchaseSnapshotBase,
    state: Type.Literal('legacy'),
    templateVersionId: Type.Null(),
    normalizationVersion: Type.Null(),
    contentIdentity: Type.Null(),
    values: Type.Null(),
    attachments: Type.Array(OrderPurchaseAttachmentSchema, { maxItems: 0 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...OrderPurchaseSnapshotBase,
    state: Type.Literal('none'),
    templateVersionId: Type.Null(),
    normalizationVersion: Type.Null(),
    contentIdentity: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    values: Type.Null(),
    attachments: Type.Array(OrderPurchaseAttachmentSchema, { maxItems: 0 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...OrderPurchaseSnapshotBase,
    state: Type.Literal('filled'),
    templateVersionId: IdentitySchema,
    normalizationVersion: Type.Integer({ minimum: 1 }),
    contentIdentity: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    values: Type.Record(Type.String({ format: 'uuid' }), Type.Unknown()),
    attachments: Type.Array(OrderPurchaseAttachmentSchema, { maxItems: PURCHASE_FORM_LIMITS.attachmentsPerDraft }),
  }, { additionalProperties: false }),
])

export const OrderPurchaseDataSchema = Type.Object({
  state: Type.Union([Type.Literal('legacy'), Type.Literal('none'), Type.Literal('filled')]),
  templateVersionId: Type.Union([IdentitySchema, Type.Null()]),
  templateName: Type.Union([Type.String(), Type.Null()]),
  templateVersionNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  definition: Type.Union([PurchaseFormDefinitionSchema, Type.Null()]),
  values: Type.Union([Type.Record(IdentitySchema, Type.Unknown()), Type.Null()]),
  attachments: Type.Array(Type.Object({
    attachmentId: IdentitySchema,
    fieldId: IdentitySchema,
    byteSize: Type.Integer({ minimum: 1, maximum: PURCHASE_FORM_LIMITS.attachmentBytes }),
    sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    url: Type.String({ minLength: 1, maxLength: 2048 }),
  }, { additionalProperties: false }), { maxItems: PURCHASE_FORM_LIMITS.attachmentsPerDraft }),
}, { additionalProperties: false })

export interface PurchaseFormLeafFieldBase {
  id: string
  meaningKey: string
  label: string
  required: boolean
  helpText?: string
}
export type PurchaseFormLeafField = PurchaseFormLeafFieldBase & (
  | { type: 'text' | 'textarea' | 'digits'; placeholder?: string; maxLength?: number }
  | { type: 'select'; options: Array<{ id: string; meaningKey: string; label: string }> }
  | { type: 'image'; maxCount: number }
)
export interface PurchaseFormCascadeOption {
  id: string
  meaningKey: string
  label: string
  children?: PurchaseFormCascadeOption[]
  expandedFields?: PurchaseFormLeafField[]
}
export type PurchaseFormField = PurchaseFormLeafField | (PurchaseFormLeafFieldBase & {
  type: 'cascade'
  options: PurchaseFormCascadeOption[]
})
export interface PurchaseFormDefinition { fields: PurchaseFormField[] }
export type PurchaseFormValues = Record<string, unknown>
export type PurchaseTemplateSummary = Static<typeof PurchaseTemplateSummarySchema>
export type PurchaseTemplateVersion = Static<typeof PurchaseTemplateVersionSchema>
export type PurchaseTemplateCreateBody = Static<typeof PurchaseTemplateCreateBodySchema>
export type PurchaseTemplateUpdateBody = Static<typeof PurchaseTemplateUpdateBodySchema>
export type PurchaseTemplateListQuery = Static<typeof PurchaseTemplateListQuerySchema>
export type PurchaseTemplateVersionsQuery = Static<typeof PurchaseTemplateVersionsQuerySchema>
export type ProductPurchaseFormAssignmentBody = Static<typeof ProductPurchaseFormAssignmentBodySchema>
export type SkuPurchaseFormAssignmentBody = Static<typeof SkuPurchaseFormAssignmentBodySchema>
export type PurchaseFormsLifecycle = Static<typeof PurchaseFormsLifecycleSchema>
export type PurchaseFormsTransitionBody = Static<typeof PurchaseFormsTransitionBodySchema>
export type StorefrontPurchaseForm = Static<typeof StorefrontPurchaseFormSchema>
export type PurchaseDraft = Static<typeof PurchaseDraftSchema>
export type PurchaseDraftCreateBody = Static<typeof PurchaseDraftCreateBodySchema>
export type PurchaseDraftValidation = Static<typeof PurchaseDraftValidationSchema>
export type PurchaseDraftSaveBody = Static<typeof PurchaseDraftSaveBodySchema>
export type OrderPurchaseAttachment = Static<typeof OrderPurchaseAttachmentSchema>
export type OrderPurchaseSnapshot = Static<typeof OrderPurchaseSnapshotSchema>
export type OrderPurchaseData = Static<typeof OrderPurchaseDataSchema>

export type PurchaseFormIssue = { fieldId: string | null; code: string }
export type PurchaseFormValidationResult<T> =
  | { ok: true; value: T; incompleteFieldIds: string[] }
  | { ok: false; issues: PurchaseFormIssue[] }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const meaningKeyPattern = /^[a-z][a-z0-9_]*$/u
const optionTypes = new Set(['text', 'textarea', 'digits', 'select', 'image', 'cascade'])
const leafTypes = new Set(['text', 'textarea', 'digits', 'select', 'image'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function characters(value: string): number { return Array.from(value).length }

function withinStringLimit(value: unknown, maximum: number, minimum = 0): value is string {
  return typeof value === 'string' && characters(value) >= minimum && characters(value) <= maximum
}

function fieldHeader(value: Record<string, unknown>, issues: PurchaseFormIssue[]): boolean {
  let valid = true
  if (typeof value.id !== 'string' || !uuidPattern.test(value.id)) valid = false
  if (typeof value.meaningKey !== 'string' || !meaningKeyPattern.test(value.meaningKey)
    || value.meaningKey.length > PURCHASE_FORM_LIMITS.meaningKeyCharacters) valid = false
  if (typeof value.type !== 'string' || !optionTypes.has(value.type)) valid = false
  if (!withinStringLimit(value.label, PURCHASE_FORM_LIMITS.labelCharacters, 1)) valid = false
  if (typeof value.required !== 'boolean') valid = false
  if (value.placeholder !== undefined && !withinStringLimit(value.placeholder, PURCHASE_FORM_LIMITS.placeholderCharacters)) valid = false
  if (value.helpText !== undefined && !withinStringLimit(value.helpText, PURCHASE_FORM_LIMITS.helpCharacters)) valid = false
  if (!valid) issues.push({ fieldId: typeof value.id === 'string' && uuidPattern.test(value.id) ? value.id : null, code: 'FIELD_DEFINITION_INVALID' })
  return valid
}

function validateLeafField(value: unknown, issues: PurchaseFormIssue[], allIds: Set<string>): value is PurchaseFormLeafField {
  if (!isRecord(value)) {
    issues.push({ fieldId: null, code: 'FIELD_DEFINITION_INVALID' })
    return false
  }
  if (!fieldHeader(value, issues)) return false
  const fieldId = value.id as string
  if (allIds.has(fieldId.toLowerCase())) { issues.push({ fieldId, code: 'DUPLICATE_ID' }); return false }
  allIds.add(fieldId.toLowerCase())
  if (!leafTypes.has(value.type as string)) { issues.push({ fieldId, code: 'FIELD_TYPE_INVALID' }); return false }
  if (['text', 'textarea', 'digits'].includes(value.type as string)) {
    if (Object.keys(value).some(key => !['id', 'meaningKey', 'type', 'label', 'required', 'placeholder', 'helpText', 'maxLength'].includes(key))) {
      issues.push({ fieldId, code: 'FIELD_PROPERTY_INVALID' }); return false
    }
    if (value.maxLength !== undefined && (!Number.isInteger(value.maxLength)
      || (value.maxLength as number) < 1 || (value.maxLength as number) > PURCHASE_FORM_LIMITS.answerCharactersPerField)) {
      issues.push({ fieldId, code: 'FIELD_LIMIT_INVALID' }); return false
    }
    return true
  }
  if (value.type === 'select') {
    if (Object.keys(value).some(key => !['id', 'meaningKey', 'type', 'label', 'required', 'helpText', 'options'].includes(key))) {
      issues.push({ fieldId, code: 'FIELD_PROPERTY_INVALID' }); return false
    }
    if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > PURCHASE_FORM_LIMITS.optionChildren) {
      issues.push({ fieldId, code: 'OPTIONS_LIMIT_INVALID' }); return false
    }
    for (const option of value.options) {
      if (!isRecord(option) || typeof option.id !== 'string' || !uuidPattern.test(option.id)
        || typeof option.meaningKey !== 'string' || !meaningKeyPattern.test(option.meaningKey)
        || option.meaningKey.length > PURCHASE_FORM_LIMITS.meaningKeyCharacters
        || !withinStringLimit(option.label, PURCHASE_FORM_LIMITS.labelCharacters, 1)
        || Object.keys(option).some(key => !['id', 'meaningKey', 'label'].includes(key))) {
        issues.push({ fieldId, code: 'OPTION_DEFINITION_INVALID' }); continue
      }
      if (allIds.has(option.id.toLowerCase())) issues.push({ fieldId, code: 'DUPLICATE_ID' })
      allIds.add(option.id.toLowerCase())
    }
    return true
  }
  if (value.type === 'image') {
    if (Object.keys(value).some(key => !['id', 'meaningKey', 'type', 'label', 'required', 'helpText', 'maxCount'].includes(key))
      || !Number.isInteger(value.maxCount) || (value.maxCount as number) < 1 || (value.maxCount as number) > 3) {
      issues.push({ fieldId, code: 'IMAGE_FIELD_INVALID' }); return false
    }
    return true
  }
  issues.push({ fieldId, code: 'FIELD_TYPE_INVALID' })
  return false
}

export function validatePurchaseFormDefinition(value: unknown): PurchaseFormValidationResult<PurchaseFormDefinition> {
  const issues: PurchaseFormIssue[] = []
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'fields') || !Array.isArray(value.fields)) {
    return { ok: false, issues: [{ fieldId: null, code: 'DEFINITION_SHAPE_INVALID' }] }
  }
  const byteCounter = new TextEncoder()
  const seenObjects = new Set<object>()
  const sizeStack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  // A legal five-level cascade may contain a leaf field and select options at
  // its deepest branch. Keep this generic JSON guard above that known shape;
  // cascade depth, option-node, field, and byte limits remain independently
  // enforced below.
  const maximumJsonDepth = PURCHASE_FORM_LIMITS.optionDepth * 3 + 3
  let definitionBytes = 2
  while (sizeStack.length) {
    const item = sizeStack.pop()!
    if (item.depth > maximumJsonDepth) {
      return { ok: false, issues: [{ fieldId: null, code: 'OPTION_TREE_LIMIT_EXCEEDED' }] }
    }
    if (typeof item.value === 'string') {
      definitionBytes += byteCounter.encode(item.value).byteLength + 2
    } else if (Array.isArray(item.value)) {
      if (seenObjects.has(item.value)) return { ok: false, issues: [{ fieldId: null, code: 'DEFINITION_SHAPE_INVALID' }] }
      seenObjects.add(item.value)
      definitionBytes += 2 + item.value.length
      for (const child of item.value) sizeStack.push({ value: child, depth: item.depth + 1 })
    } else if (isRecord(item.value)) {
      if (seenObjects.has(item.value)) return { ok: false, issues: [{ fieldId: null, code: 'DEFINITION_SHAPE_INVALID' }] }
      seenObjects.add(item.value)
      const keys = Object.keys(item.value)
      definitionBytes += 2 + keys.length
      for (const key of keys) {
        definitionBytes += byteCounter.encode(key).byteLength + 3
        sizeStack.push({ value: item.value[key], depth: item.depth + 1 })
      }
    } else {
      definitionBytes += 8
    }
    if (definitionBytes > PURCHASE_FORM_LIMITS.definitionBytes) {
      return { ok: false, issues: [{ fieldId: null, code: 'DEFINITION_TOO_LARGE' }] }
    }
  }
  let serializedDefinition: string | undefined
  try { serializedDefinition = JSON.stringify(value) } catch {
    return { ok: false, issues: [{ fieldId: null, code: 'DEFINITION_SHAPE_INVALID' }] }
  }
  if (!serializedDefinition || byteCounter.encode(serializedDefinition).byteLength > PURCHASE_FORM_LIMITS.definitionBytes) {
    return { ok: false, issues: [{ fieldId: null, code: 'DEFINITION_TOO_LARGE' }] }
  }
  if (value.fields.length > PURCHASE_FORM_LIMITS.topLevelFields) {
    return { ok: false, issues: [{ fieldId: null, code: 'FIELD_LIMIT_EXCEEDED' }] }
  }
  const allIds = new Set<string>()
  let fieldCount = 0
  let optionCount = 0
  const stack: Array<{ field: unknown; allowCascade: boolean }> =
    value.fields.map(field => ({ field, allowCascade: true }))
  while (stack.length) {
    const row = stack.pop()!
    if (!isRecord(row.field)) {
      issues.push({ fieldId: null, code: 'FIELD_DEFINITION_INVALID' })
      continue
    }
    if (!fieldHeader(row.field, issues)) continue
    fieldCount += 1
    if (fieldCount > PURCHASE_FORM_LIMITS.totalFields) {
      issues.push({ fieldId: row.field.id as string, code: 'FIELD_LIMIT_EXCEEDED' }); break
    }
    if (row.field.type !== 'cascade') {
      validateLeafField(row.field, issues, allIds)
      continue
    }
    const fieldId = row.field.id as string
    if (allIds.has(fieldId.toLowerCase())) issues.push({ fieldId, code: 'DUPLICATE_ID' })
    allIds.add(fieldId.toLowerCase())
    if (!row.allowCascade || Object.keys(row.field).some(key => !['id', 'meaningKey', 'type', 'label', 'required', 'helpText', 'options'].includes(key))) {
      issues.push({ fieldId, code: 'FIELD_PROPERTY_INVALID' }); continue
    }
    if (!Array.isArray(row.field.options) || row.field.options.length < 1 || row.field.options.length > PURCHASE_FORM_LIMITS.optionChildren) {
      issues.push({ fieldId, code: 'OPTIONS_LIMIT_INVALID' }); continue
    }
    const optionStack = row.field.options.map(option => ({ option, depth: 1 }))
    while (optionStack.length) {
      const current = optionStack.pop()!
      optionCount += 1
      const option = current.option
      if (!isRecord(option) || typeof option.id !== 'string' || !uuidPattern.test(option.id)
        || typeof option.meaningKey !== 'string' || !meaningKeyPattern.test(option.meaningKey)
        || option.meaningKey.length > PURCHASE_FORM_LIMITS.meaningKeyCharacters
        || !withinStringLimit(option.label, PURCHASE_FORM_LIMITS.labelCharacters, 1)
        || Object.keys(option).some(key => !['id', 'meaningKey', 'label', 'children', 'expandedFields'].includes(key))) {
        issues.push({ fieldId, code: 'OPTION_DEFINITION_INVALID' }); continue
      }
      if (allIds.has(option.id.toLowerCase())) issues.push({ fieldId, code: 'DUPLICATE_ID' })
      allIds.add(option.id.toLowerCase())
      if (optionCount > PURCHASE_FORM_LIMITS.optionNodes || current.depth > PURCHASE_FORM_LIMITS.optionDepth) {
        issues.push({ fieldId, code: 'OPTION_TREE_LIMIT_EXCEEDED' }); continue
      }
      if (option.expandedFields !== undefined) {
        if (!Array.isArray(option.expandedFields) || option.expandedFields.length > PURCHASE_FORM_LIMITS.totalFields) {
          issues.push({ fieldId, code: 'EXPANDED_FIELDS_INVALID' }); continue
        }
        for (const expandedField of option.expandedFields) {
          if (!validateLeafField(expandedField, issues, allIds)) continue
          fieldCount += 1
          if (fieldCount > PURCHASE_FORM_LIMITS.totalFields) issues.push({ fieldId, code: 'FIELD_LIMIT_EXCEEDED' })
        }
      }
      if (option.children !== undefined) {
        if (!Array.isArray(option.children) || option.children.length > PURCHASE_FORM_LIMITS.optionChildren) {
          issues.push({ fieldId, code: 'OPTION_TREE_LIMIT_EXCEEDED' }); continue
        }
        for (const child of option.children) optionStack.push({ option: child, depth: current.depth + 1 })
      }
    }
  }
  if (issues.length) return { ok: false, issues }
  return { ok: true, value: value as unknown as PurchaseFormDefinition, incompleteFieldIds: [] }
}

export function canonicalPurchaseFormJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPurchaseFormJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPurchaseFormJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function normalizePurchaseFormAnswers(
  definitionValue: unknown,
  candidate: unknown,
  options: {
    requireComplete?: boolean
    attachmentIds?: ReadonlySet<string>
    attachmentFieldIds?: ReadonlyMap<string, string>
  } = {},
): PurchaseFormValidationResult<PurchaseFormValues> {
  const definition = validatePurchaseFormDefinition(definitionValue)
  if (!definition.ok) return definition
  const issues: PurchaseFormIssue[] = []
  const incomplete = new Set<string>()
  if (!isRecord(candidate) || Object.keys(candidate).length > PURCHASE_FORM_LIMITS.totalFields) {
    return { ok: false, issues: [{ fieldId: null, code: 'ANSWERS_SHAPE_INVALID' }] }
  }
  const normalized: Record<string, unknown> = {}
  const rootFieldIds = new Set(definition.value.fields.map(field => field.id.toLowerCase()))
  const candidateKeys = new Set<string>()
  const candidateById = new Map<string, unknown>()
  for (const key of Object.keys(candidate)) {
    const normalizedKey = key.toLowerCase()
    if (candidateKeys.has(normalizedKey)) issues.push({ fieldId: key, code: 'DUPLICATE_FIELD' })
    candidateKeys.add(normalizedKey)
    candidateById.set(normalizedKey, candidate[key])
    if (!uuidPattern.test(key) || !rootFieldIds.has(normalizedKey)) issues.push({ fieldId: uuidPattern.test(key) ? key : null, code: 'UNKNOWN_FIELD' })
  }
  if (issues.length) return { ok: false, issues }
  let answerCharacters = 0
  const usedAttachmentIds = new Set<string>()
  const normalizeLeaf = (field: PurchaseFormLeafField, value: unknown): unknown => {
    if (value === undefined || value === null || value === '') {
      if (field.required && options.requireComplete) incomplete.add(field.id)
      return undefined
    }
    if (field.type === 'text' || field.type === 'textarea') {
      if (typeof value !== 'string') { issues.push({ fieldId: field.id, code: 'VALUE_TYPE_INVALID' }); return undefined }
      const normalizedText = value.replace(/\r\n?/gu, '\n')
      const count = characters(normalizedText)
      if ((field.type === 'text' && normalizedText.includes('\n')) || count > (field.maxLength ?? 1_000)) {
        issues.push({ fieldId: field.id, code: 'VALUE_LENGTH_INVALID' }); return undefined
      }
      answerCharacters += count
      return normalizedText
    }
    if (field.type === 'digits') {
      if (typeof value !== 'string' || (value !== '' && !/^[0-9]+$/u.test(value))
        || value.length > (field.maxLength ?? 128)) {
        issues.push({ fieldId: field.id, code: 'DIGITS_VALUE_INVALID' }); return undefined
      }
      answerCharacters += value.length
      return value
    }
    if (field.type === 'select') {
      if (typeof value !== 'string') { issues.push({ fieldId: field.id, code: 'VALUE_TYPE_INVALID' }); return undefined }
      const option = field.options.find(candidateOption => candidateOption.id.toLowerCase() === value.toLowerCase())
      if (!option) { issues.push({ fieldId: field.id, code: 'OPTION_NOT_ALLOWED' }); return undefined }
      return option.id.toLowerCase()
    }
    if (field.type === 'image') {
      if (!Array.isArray(value) || value.length > field.maxCount || value.length > PURCHASE_FORM_LIMITS.attachmentsPerDraft) {
        issues.push({ fieldId: field.id, code: 'IMAGE_VALUE_INVALID' }); return undefined
      }
      const ids: string[] = []
      for (const attachmentId of value) {
        if (typeof attachmentId !== 'string' || !uuidPattern.test(attachmentId)
          || !options.attachmentIds?.has(attachmentId.toLowerCase())) {
          issues.push({ fieldId: field.id, code: 'ATTACHMENT_NOT_OWNED' }); continue
        }
        if (options.attachmentFieldIds
          && options.attachmentFieldIds.get(attachmentId.toLowerCase()) !== field.id.toLowerCase()) {
          issues.push({ fieldId: field.id, code: 'ATTACHMENT_FIELD_MISMATCH' }); continue
        }
        if (ids.includes(attachmentId.toLowerCase())) { issues.push({ fieldId: field.id, code: 'DUPLICATE_ATTACHMENT' }); continue }
        if (usedAttachmentIds.has(attachmentId.toLowerCase())) { issues.push({ fieldId: field.id, code: 'DUPLICATE_ATTACHMENT' }); continue }
        usedAttachmentIds.add(attachmentId.toLowerCase())
        ids.push(attachmentId.toLowerCase())
      }
      if (!ids.length && field.required && options.requireComplete) incomplete.add(field.id)
      return ids.length ? ids : undefined
    }
    return undefined
  }
  const normalizeExpanded = (expandedFields: PurchaseFormLeafField[], source: Record<string, unknown>, destination: Record<string, unknown>) => {
    const active = new Set(expandedFields.map(field => field.id.toLowerCase()))
    const sourceById = new Map<string, unknown>()
    for (const key of Object.keys(source)) {
      if (!active.has(key.toLowerCase())) issues.push({ fieldId: uuidPattern.test(key) ? key : null, code: 'INACTIVE_BRANCH_VALUE' })
      if (sourceById.has(key.toLowerCase())) issues.push({ fieldId: key, code: 'DUPLICATE_FIELD' })
      sourceById.set(key.toLowerCase(), source[key])
    }
    for (const field of expandedFields) {
      const normalizedValue = normalizeLeaf(field, sourceById.get(field.id.toLowerCase()))
      if (normalizedValue !== undefined) destination[field.id.toLowerCase()] = normalizedValue
    }
  }
  for (const field of definition.value.fields) {
    const sourceValue = candidateById.get(field.id.toLowerCase())
    if (field.type !== 'cascade') {
      const normalizedValue = normalizeLeaf(field, sourceValue)
      if (normalizedValue !== undefined) normalized[field.id.toLowerCase()] = normalizedValue
      continue
    }
    const fieldId = field.id.toLowerCase()
    if (sourceValue === undefined || sourceValue === null || sourceValue === '') {
      if (field.required && options.requireComplete) incomplete.add(field.id)
      continue
    }
    if (!isRecord(sourceValue) || Object.keys(sourceValue).some(key => key !== 'path' && key !== 'expanded')) {
      issues.push({ fieldId: field.id, code: 'CASCADE_VALUE_INVALID' }); continue
    }
    if (!Array.isArray(sourceValue.path) || sourceValue.path.length > PURCHASE_FORM_LIMITS.optionDepth
      || !isRecord(sourceValue.expanded)) {
      issues.push({ fieldId: field.id, code: 'CASCADE_VALUE_INVALID' }); continue
    }
    if (!sourceValue.path.length && Object.keys(sourceValue.expanded).length) {
      issues.push({ fieldId: field.id, code: 'INACTIVE_BRANCH_VALUE' }); continue
    }
    let branches = field.options
    let node: PurchaseFormCascadeOption | undefined
    const path: string[] = []
    const activeExpanded: PurchaseFormLeafField[] = []
    for (const rawId of sourceValue.path) {
      if (typeof rawId !== 'string') { issues.push({ fieldId: field.id, code: 'CASCADE_PATH_INVALID' }); break }
      node = branches.find(option => option.id.toLowerCase() === rawId.toLowerCase())
      if (!node) { issues.push({ fieldId: field.id, code: 'CASCADE_PATH_INVALID' }); break }
      path.push(node.id.toLowerCase())
      activeExpanded.push(...(node.expandedFields ?? []))
      branches = node.children ?? []
    }
    if (issues.some(issue => issue.fieldId === field.id && issue.code === 'CASCADE_PATH_INVALID')) continue
    if (options.requireComplete && ((field.required && !path.length) || Boolean(path.length && node?.children?.length))) {
      incomplete.add(field.id)
    }
    if (sourceValue.path.length && node?.children?.length && sourceValue.path.length >= PURCHASE_FORM_LIMITS.optionDepth) {
      issues.push({ fieldId: field.id, code: 'CASCADE_PATH_INVALID' }); continue
    }
    const expanded: Record<string, unknown> = {}
    normalizeExpanded(activeExpanded, sourceValue.expanded, expanded)
    if (path.length || Object.keys(expanded).length) normalized[fieldId] = { path, expanded }
  }
  if (usedAttachmentIds.size > PURCHASE_FORM_LIMITS.attachmentsPerDraft) {
    issues.push({ fieldId: null, code: 'ATTACHMENT_LIMIT_EXCEEDED' })
  }
  if (answerCharacters > PURCHASE_FORM_LIMITS.answerCharactersTotal) {
    issues.push({ fieldId: null, code: 'ANSWERS_TOO_LARGE' })
  }
  if (issues.length) return { ok: false, issues }
  return { ok: true, value: normalized, incompleteFieldIds: [...incomplete].sort() }
}
