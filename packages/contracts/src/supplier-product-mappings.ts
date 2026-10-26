import { Type, type Static } from 'typebox'
import { PurchaseFormDefinitionSchema, type PurchaseFormDefinition, type PurchaseFormField, type PurchaseFormLeafField } from './purchase-forms.js'
import { normalizePurchaseFormAnswers, validatePurchaseFormDefinition } from './purchase-forms.js'
import { SupplierReadSourceSchema, type SupplierCatalogProduct } from './supplier-catalog.js'

export const SUPPLIER_MAPPING_RULES_VERSION = 1 as const
export const SUPPLIER_MAPPING_STRUCTURE_VERSION = 1 as const

// Mapping responses embed the upstream field tree alongside frozen local form
// definitions. Give this recursive schema its own reference namespace so
// Fastify's serializer cannot confuse the supplier and local "Field" refs.
const SupplierMappingPurchaseFieldsSchema = Type.Cyclic({
  SupplierMappingPurchaseField: Type.Object({
    type: Type.Union([Type.Integer(), Type.Null()]),
    title: Type.Union([Type.String({ maxLength: 20000 }), Type.Null()]),
    placeholder: Type.Union([Type.String({ maxLength: 20000 }), Type.Null()]),
    required: Type.Union([Type.Boolean(), Type.Null()]),
    regex: Type.Union([Type.String({ maxLength: 20000 }), Type.Null()]),
    options: Type.Array(Type.Ref('SupplierMappingPurchaseOption'), { maxItems: 500 }),
  }, { additionalProperties: false }),
  SupplierMappingPurchaseOption: Type.Object({
    name: Type.String({ maxLength: 2000 }),
    value: Type.String({ maxLength: 2000 }),
    children: Type.Array(Type.Ref('SupplierMappingPurchaseOption'), { maxItems: 500 }),
    expand: Type.Array(Type.Ref('SupplierMappingPurchaseField'), { maxItems: 50 }),
  }, { additionalProperties: false }),
  SupplierMappingPurchaseFields: Type.Array(Type.Ref('SupplierMappingPurchaseField'), { maxItems: 50 }),
}, 'SupplierMappingPurchaseFields')

const Uuid = Type.String({ format: 'uuid' })
const Fingerprint = Type.String({ pattern: '^[a-f0-9]{64}$' })
const UpstreamProductId = Type.String({ minLength: 1, maxLength: 32, pattern: '^[0-9]{1,16}$' })
const UpstreamSkuCode = Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])
const MappingStatus = Type.Union([Type.Literal('draft'), Type.Literal('reviewed'), Type.Literal('stale')])

export const SupplierMappingPathSegmentSchema = Type.Object({
  kind: Type.Union([Type.Literal('field'), Type.Literal('option'), Type.Literal('child'), Type.Literal('expand')]),
  index: Type.Integer({ minimum: 0, maximum: 499 }),
}, { additionalProperties: false })
export const SupplierMappingPathSchema = Type.Array(SupplierMappingPathSegmentSchema, { minItems: 0, maxItems: 16 })

export const SupplierMappingOptionRuleSchema = Type.Object({
  localOptionId: Uuid,
  localMeaningKey: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_]*$' }),
  upstreamPath: SupplierMappingPathSchema,
}, { additionalProperties: false })

export const SupplierMappingFieldRuleSchema = Type.Object({
  localFieldId: Uuid,
  localMeaningKey: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_]*$' }),
  upstreamPath: SupplierMappingPathSchema,
  options: Type.Array(SupplierMappingOptionRuleSchema, { maxItems: 200 }),
}, { additionalProperties: false })

export const SupplierMappingRulesSchema = Type.Object({
  version: Type.Literal(SUPPLIER_MAPPING_RULES_VERSION),
  fields: Type.Array(SupplierMappingFieldRuleSchema, { maxItems: 60 }),
}, { additionalProperties: false })

const MappingTargetSchema = Type.Object({
  productId: Uuid,
  skuId: Uuid,
  observationId: Uuid,
  templateVersionId: Uuid,
  rules: SupplierMappingRulesSchema,
}, { additionalProperties: false })
export const SupplierProductMappingObserveBodySchema = Type.Object({
  connectionId: Uuid,
  expectedConfigurationVersionId: Uuid,
  upstreamProductId: UpstreamProductId,
  upstreamSkuType: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
  upstreamSkuCode: UpstreamSkuCode,
}, { additionalProperties: false })

export const SupplierProductMappingCreateBodySchema = MappingTargetSchema
export const SupplierProductMappingUpdateBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  productId: Uuid,
  skuId: Uuid,
  observationId: Uuid,
  templateVersionId: Uuid,
  rules: SupplierMappingRulesSchema,
}, { additionalProperties: false })
export const SupplierProductMappingRevisionBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })
export const SupplierProductMappingRestoreBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  versionId: Uuid,
}, { additionalProperties: false })
export const SupplierProductMappingIdParamsSchema = Type.Object({ id: Uuid }, { additionalProperties: false })
export const SupplierProductMappingHistoryQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false })

export const SupplierProductMappingObservationSchema = Type.Object({
  id: Uuid,
  source: SupplierReadSourceSchema,
  upstreamProductId: UpstreamProductId,
  upstreamProductName: Type.String({ minLength: 1, maxLength: 500 }),
  goodsType: Type.Integer(),
  status: Type.Integer(),
  skuType: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
  skuCode: UpstreamSkuCode,
  combination: Type.Array(Type.Object({ title: Type.String(), value: Type.String() }, { additionalProperties: false }), { maxItems: 30 }),
  structureSnapshot: Type.Object({
    version: Type.Literal(SUPPLIER_MAPPING_STRUCTURE_VERSION),
    product: Type.Object({
      goodsId: UpstreamProductId,
      goodsType: Type.Integer(),
      status: Type.Integer(),
      skuType: Type.Union([Type.Integer(), Type.Null()]),
      skuCode: UpstreamSkuCode,
      combination: Type.Array(Type.Object({ title: Type.String(), value: Type.String() }, { additionalProperties: false }), { maxItems: 30 }),
    }, { additionalProperties: false }),
    purchaseFields: Type.Union([SupplierMappingPurchaseFieldsSchema, Type.Null()]),
  }, { additionalProperties: false }),
  structureFingerprint: Fingerprint,
  observedAt: Type.String({ format: 'date-time' }),
  expiresAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

const TemplateVersionRefSchema = Type.Object({
  id: Uuid,
  templateId: Uuid,
  name: Type.String(),
  versionNumber: Type.Integer({ minimum: 1 }),
  sha256: Fingerprint,
  normalizationVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const SupplierMappingCatalogSkuSchema = Type.Object({
  productId: Uuid,
  productName: Type.String(),
  productStatus: Type.String(),
  productRevision: Type.Integer({ minimum: 1 }),
  skuId: Uuid,
  skuCode: Type.String(),
  skuEnabled: Type.Boolean(),
  skuRetiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  appliedTemplateVersion: Type.Union([TemplateVersionRefSchema, Type.Null()]),
  mapping: Type.Union([Type.Object({
    id: Uuid,
    status: MappingStatus,
    revision: Type.Integer({ minimum: 1 }),
    connectionId: Uuid,
    configurationVersionId: Uuid,
    upstreamProductId: UpstreamProductId,
    upstreamSkuType: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
    upstreamSkuCode: UpstreamSkuCode,
    templateVersionId: Uuid,
    updatedAt: Type.String({ format: 'date-time' }),
  }, { additionalProperties: false }), Type.Null()]),
}, { additionalProperties: false })
export const SupplierMappingCatalogSchema = Type.Object({
  items: Type.Array(SupplierMappingCatalogSkuSchema, { maxItems: 5000 }),
  purchaseFormsStatus: Type.Union([Type.Literal('preparing'), Type.Literal('active'), Type.Literal('paused')]),
}, { additionalProperties: false })

export const SupplierProductMappingIssueSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 64 }),
  localFieldId: Type.Union([Uuid, Type.Null()]),
  localOptionId: Type.Union([Uuid, Type.Null()]),
  upstreamPath: Type.Union([SupplierMappingPathSchema, Type.Null()]),
  blocking: Type.Boolean(),
}, { additionalProperties: false })

const StructureSnapshotSchema = Type.Object({
  version: Type.Literal(SUPPLIER_MAPPING_STRUCTURE_VERSION),
  product: Type.Object({
    goodsId: UpstreamProductId,
    goodsType: Type.Integer(),
    status: Type.Integer(),
    skuType: Type.Union([Type.Integer(), Type.Null()]),
    skuCode: UpstreamSkuCode,
    combination: Type.Array(Type.Object({ title: Type.String(), value: Type.String() }, { additionalProperties: false }), { maxItems: 30 }),
  }, { additionalProperties: false }),
  purchaseFields: Type.Union([SupplierMappingPurchaseFieldsSchema, Type.Null()]),
}, { additionalProperties: false })

export const SupplierProductMappingSchema = Type.Object({
  id: Uuid,
  productId: Uuid,
  skuId: Uuid,
  revision: Type.Integer({ minimum: 1 }),
  status: MappingStatus,
  connectionId: Uuid,
  connectionName: Type.String(),
  configurationVersionId: Uuid,
  configurationVersionNumber: Type.Integer({ minimum: 1 }),
  upstreamProductId: UpstreamProductId,
  upstreamProductName: Type.String(),
  upstreamSkuType: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
  upstreamSkuCode: UpstreamSkuCode,
  upstreamCombination: Type.Array(Type.Object({ title: Type.String(), value: Type.String() }, { additionalProperties: false }), { maxItems: 30 }),
  structureSnapshot: StructureSnapshotSchema,
  structureFingerprint: Fingerprint,
  observedAt: Type.String({ format: 'date-time' }),
  templateVersion: TemplateVersionRefSchema,
  templateDefinition: PurchaseFormDefinitionSchema,
  rules: SupplierMappingRulesSchema,
  rulesSha256: Fingerprint,
  reviewedVersionId: Type.Union([Uuid, Type.Null()]),
  issues: Type.Array(SupplierProductMappingIssueSchema, { maxItems: 500 }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })

export const SupplierProductMappingVersionSchema = Type.Object({
  id: Uuid,
  mappingId: Uuid,
  versionNumber: Type.Integer({ minimum: 1 }),
  productId: Uuid,
  skuId: Uuid,
  connectionId: Uuid,
  configurationVersionId: Uuid,
  configurationVersionNumber: Type.Integer({ minimum: 1 }),
  upstreamProductId: UpstreamProductId,
  upstreamProductName: Type.String(),
  upstreamSkuType: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
  upstreamSkuCode: UpstreamSkuCode,
  upstreamCombination: Type.Array(Type.Object({ title: Type.String(), value: Type.String() }, { additionalProperties: false }), { maxItems: 30 }),
  structureSnapshot: StructureSnapshotSchema,
  structureFingerprint: Fingerprint,
  observedAt: Type.String({ format: 'date-time' }),
  templateVersion: TemplateVersionRefSchema,
  templateDefinition: PurchaseFormDefinitionSchema,
  rules: SupplierMappingRulesSchema,
  rulesSha256: Fingerprint,
  administratorId: Uuid,
  reviewedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
const SupplierProductMappingRefreshObservationSchema = Type.Object({
  id: Uuid,
  source: SupplierReadSourceSchema,
  upstreamProductId: UpstreamProductId,
  upstreamProductName: Type.String({ minLength: 1, maxLength: 500 }),
  goodsType: Type.Integer(),
  status: Type.Integer(),
  skuType: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
  skuCode: UpstreamSkuCode,
  combination: Type.Array(Type.Object({ title: Type.String(), value: Type.String() }, { additionalProperties: false }), { maxItems: 30 }),
  structureFingerprint: Fingerprint,
  observedAt: Type.String({ format: 'date-time' }),
  expiresAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export const SupplierProductMappingHistorySchema = Type.Object({
  items: Type.Array(SupplierProductMappingVersionSchema, { maxItems: 100 }),
  events: Type.Array(Type.Object({
    id: Uuid,
    operation: Type.Union([Type.Literal('created'), Type.Literal('draft_saved'), Type.Literal('reviewed'), Type.Literal('marked_stale'), Type.Literal('restored')]),
    administratorId: Uuid,
    mappingVersionId: Type.Union([Uuid, Type.Null()]),
    revision: Type.Integer({ minimum: 1 }),
    summary: Type.Record(Type.String({ maxLength: 64 }), Type.Unknown()),
    createdAt: Type.String({ format: 'date-time' }),
  }, { additionalProperties: false }), { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
}, { additionalProperties: false })

export const SupplierProductMappingListSchema = Type.Object({
  items: Type.Array(SupplierProductMappingSchema, { maxItems: 5000 }),
}, { additionalProperties: false })
export const SupplierProductMappingReviewOutcomeSchema = Type.Object({
  reviewed: Type.Boolean(),
  mapping: SupplierProductMappingSchema,
  issues: Type.Array(SupplierProductMappingIssueSchema, { maxItems: 500 }),
}, { additionalProperties: false })
export const SupplierProductMappingRefreshOutcomeSchema = Type.Object({
  mapping: SupplierProductMappingSchema,
  observation: Type.Union([SupplierProductMappingRefreshObservationSchema, Type.Null()]),
  issues: Type.Array(SupplierProductMappingIssueSchema, { maxItems: 100 }),
  structureChanged: Type.Boolean(),
  configurationChanged: Type.Boolean(),
  templateChanged: Type.Boolean(),
  identityChanged: Type.Boolean(),
}, { additionalProperties: false })

export const SupplierProductMappingPreviewSchema = Type.Object({
  kind: Type.Literal('internal_mapping_preview'),
  executedUpstreamCode: Type.Literal(false),
  usedCustomerData: Type.Literal(false),
  output: Type.Object({
    fields: Type.Array(Type.Object({
      localFieldId: Uuid,
      localMeaningKey: Type.String(),
      upstreamPath: SupplierMappingPathSchema,
      value: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
      imageSources: Type.Optional(Type.Array(Type.Object({
        localObjectRef: Type.String(),
      }, { additionalProperties: false }))),
    }, { additionalProperties: false }), { maxItems: 60 }),
  }, { additionalProperties: false }),
  issues: Type.Array(SupplierProductMappingIssueSchema, { maxItems: 500 }),
  notices: Type.Array(Type.String({ maxLength: 120 }), { maxItems: 20 }),
}, { additionalProperties: false })

export type SupplierMappingStatus = Static<typeof MappingStatus>
export type SupplierMappingPathSegment = Static<typeof SupplierMappingPathSegmentSchema>
export type SupplierMappingPath = Static<typeof SupplierMappingPathSchema>
export type SupplierMappingOptionRule = Static<typeof SupplierMappingOptionRuleSchema>
export type SupplierMappingFieldRule = Static<typeof SupplierMappingFieldRuleSchema>
export type SupplierMappingRules = Static<typeof SupplierMappingRulesSchema>
export type SupplierProductMappingCreateBody = Static<typeof SupplierProductMappingCreateBodySchema>
export type SupplierProductMappingUpdateBody = Static<typeof SupplierProductMappingUpdateBodySchema>
export type SupplierProductMappingObserveBody = Static<typeof SupplierProductMappingObserveBodySchema>
export type SupplierProductMappingObservation = Static<typeof SupplierProductMappingObservationSchema>
export type SupplierProductMappingRefreshObservation = Static<typeof SupplierProductMappingRefreshObservationSchema>
export type SupplierProductMappingRevisionBody = Static<typeof SupplierProductMappingRevisionBodySchema>
export type SupplierProductMappingRestoreBody = Static<typeof SupplierProductMappingRestoreBodySchema>
export type SupplierMappingCatalogSku = Static<typeof SupplierMappingCatalogSkuSchema>
export type SupplierProductMapping = Static<typeof SupplierProductMappingSchema>
export type SupplierProductMappingVersion = Static<typeof SupplierProductMappingVersionSchema>
export type SupplierProductMappingIssue = Static<typeof SupplierProductMappingIssueSchema>
export type SupplierProductMappingPreview = Static<typeof SupplierProductMappingPreviewSchema>
export type SupplierProductMappingHistory = Static<typeof SupplierProductMappingHistorySchema>
export type SupplierProductMappingList = Static<typeof SupplierProductMappingListSchema>
export type SupplierProductMappingReviewOutcome = Static<typeof SupplierProductMappingReviewOutcomeSchema>
export type SupplierProductMappingRefreshOutcome = Static<typeof SupplierProductMappingRefreshOutcomeSchema>
export type SupplierProductMappingStructureSnapshot = Static<typeof StructureSnapshotSchema>

type MappingUpstreamOption = { name: string; value: string; children: MappingUpstreamOption[]; expand: MappingUpstreamField[] }
type MappingUpstreamField = { type: number | null; title: string | null; placeholder: string | null; required: boolean | null; regex: string | null; options: MappingUpstreamOption[] }
type LocalFieldRef = { field: PurchaseFormField; parentOptionId: string | null }
type LocalOptionRef = { optionId: string; meaningKey: string; parentFieldId: string; parentOptionId: string | null }
type ResolvedUpstream = { kind: 'field'; field: MappingUpstreamField } | { kind: 'option'; option: MappingUpstreamOption }

export function canonicalSupplierMappingJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') {
      const row = input as Record<string, unknown>
      return Object.fromEntries(Object.keys(row).sort().map(key => [key, normalize(row[key])]))
    }
    return input
  }
  return JSON.stringify(normalize(value))
}

export function supplierProductStructureSnapshot(product: SupplierCatalogProduct, skuCode: string | null): SupplierProductMappingStructureSnapshot {
  const combination = product.variants.find(variant => variant.upstreamSku === skuCode)?.combination ?? []
  return {
    version: SUPPLIER_MAPPING_STRUCTURE_VERSION,
    product: { goodsId: product.upstreamProductId, goodsType: product.goodsType, status: product.status,
      skuType: product.skuType, skuCode, combination: combination.map(item => ({ title: item.title, value: item.value })) },
    purchaseFields: product.purchaseFields === null ? null : cloneSupplierFields(product.purchaseFields),
  }
}

function cloneSupplierFields(fields: MappingUpstreamField[]): MappingUpstreamField[] {
  return fields.map(field => ({ type: field.type, title: field.title, placeholder: field.placeholder,
    required: field.required, regex: field.regex, options: field.options.map(cloneSupplierOption) }))
}
function cloneSupplierOption(option: MappingUpstreamOption): MappingUpstreamOption {
  return { name: option.name, value: option.value,
    children: option.children.map(cloneSupplierOption), expand: cloneSupplierFields(option.expand) }
}

function flattenLocalDefinition(definition: PurchaseFormDefinition): { fields: LocalFieldRef[]; options: LocalOptionRef[] } {
  const fields: LocalFieldRef[] = []
  const options: LocalOptionRef[] = []
  const visitField = (field: PurchaseFormField, parentOptionId: string | null) => {
    fields.push({ field, parentOptionId })
    if (field.type !== 'cascade') return
    const visitOption = (option: (typeof field.options)[number], parent: string | null) => {
      options.push({ optionId: option.id.toLowerCase(), meaningKey: option.meaningKey, parentFieldId: field.id.toLowerCase(), parentOptionId: parent })
      for (const expanded of option.expandedFields ?? []) fields.push({ field: expanded, parentOptionId: option.id.toLowerCase() })
      for (const child of option.children ?? []) visitOption(child, option.id.toLowerCase())
    }
    for (const option of field.options) visitOption(option, null)
  }
  for (const field of definition.fields) visitField(field, null)
  return { fields, options }
}

function localOptionsFor(field: PurchaseFormField): LocalOptionRef[] {
  const result: LocalOptionRef[] = []
  if (field.type === 'select') {
    for (const option of field.options) result.push({ optionId: option.id.toLowerCase(), meaningKey: option.meaningKey,
      parentFieldId: field.id.toLowerCase(), parentOptionId: null })
  } else if (field.type === 'cascade') {
    const visit = (option: (typeof field.options)[number], parentOptionId: string | null) => {
      result.push({ optionId: option.id.toLowerCase(), meaningKey: option.meaningKey,
        parentFieldId: field.id.toLowerCase(), parentOptionId })
      for (const child of option.children ?? []) visit(child, option.id.toLowerCase())
    }
    for (const option of field.options) visit(option, null)
  }
  return result
}

export function resolveSupplierMappingPath(fields: MappingUpstreamField[], path: SupplierMappingPath): ResolvedUpstream | null {
  let currentField: MappingUpstreamField | null = null
  let currentOption: MappingUpstreamOption | null = null
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!
    if (segment.kind === 'field') {
      if (index !== 0 || currentField || currentOption) return null
      currentField = fields[segment.index] ?? null
      if (!currentField) return null
    } else if (segment.kind === 'option') {
      if (!currentField || currentOption) return null
      currentOption = currentField.options[segment.index] ?? null
      if (!currentOption) return null
    } else if (segment.kind === 'child') {
      currentOption = getChildOption(currentOption, segment.index)
      if (!currentOption) return null
    } else {
      currentField = getExpandedField(currentOption, segment.index)
      currentOption = null
      if (!currentField) return null
    }
  }
  if (currentField && !currentOption) return { kind: 'field', field: currentField }
  if (currentOption) return { kind: 'option', option: currentOption }
  return null
}

function getChildOption(option: MappingUpstreamOption | null, index: number): MappingUpstreamOption | null {
  return option?.children[index] ?? null
}
function getExpandedField(option: MappingUpstreamOption | null, index: number): MappingUpstreamField | null {
  return option?.expand[index] ?? null
}

function sourceFieldPath(path: SupplierMappingPath): boolean {
  return path.at(-1)?.kind === 'field' || path.at(-1)?.kind === 'expand'
}

function sourceOptionParentPath(path: SupplierMappingPath): SupplierMappingPath | null {
  const last = path.at(-1)
  if (!last || (last.kind !== 'option' && last.kind !== 'child')) return null
  return path.slice(0, -1) as SupplierMappingPath
}

function isCompatible(localType: PurchaseFormField['type'], upstreamType: number | null): boolean {
  switch (localType) {
    case 'text': return upstreamType === 0
    case 'digits': return upstreamType === 13
    case 'textarea': return upstreamType === 15
    case 'select': return upstreamType === 14
    case 'cascade': return upstreamType === 16
    case 'image': return upstreamType === 1
  }
}

function pushIssue(issues: SupplierProductMappingIssue[], code: string, options: {
  localFieldId?: string | null; localOptionId?: string | null; upstreamPath?: SupplierMappingPath | null; blocking?: boolean
} = {}): void {
  issues.push({ code, localFieldId: options.localFieldId?.toLowerCase() ?? null,
    localOptionId: options.localOptionId?.toLowerCase() ?? null,
    upstreamPath: options.upstreamPath ?? null, blocking: options.blocking ?? true })
}

function fieldSignature(field: MappingUpstreamField): string {
  return canonicalSupplierMappingJson(field)
}

function inspectUpstreamFields(fields: MappingUpstreamField[], prefix: SupplierMappingPath, issues: SupplierProductMappingIssue[]): void {
  const titleGroups = new Map<string, Array<{ field: MappingUpstreamField; path: SupplierMappingPath }>>()
  const exactGroups = new Map<string, SupplierMappingPath[]>()
  for (const [index, field] of fields.entries()) {
    const path = [...prefix, ...(prefix.length ? [{ kind: 'expand' as const, index }] : [{ kind: 'field' as const, index }])] as SupplierMappingPath
    if (field.type === null || ![0, 1, 13, 14, 15, 16].includes(field.type)) {
      pushIssue(issues, 'UPSTREAM_FIELD_TYPE_UNKNOWN', { upstreamPath: path })
    }
    if (field.required === null) pushIssue(issues, 'UPSTREAM_REQUIRED_SEMANTICS_UNKNOWN', { upstreamPath: path })
    const title = field.title ?? ''
    const titleKey = title.normalize('NFC').toLocaleLowerCase('und')
    titleGroups.set(titleKey, [...(titleGroups.get(titleKey) ?? []), { field, path }])
    const signature = fieldSignature(field)
    exactGroups.set(signature, [...(exactGroups.get(signature) ?? []), path])
    if ([0, 1, 13, 15].includes(field.type ?? -1) && field.options.length) {
      pushIssue(issues, 'UPSTREAM_FIELD_OPTIONS_UNVERIFIED', { upstreamPath: path })
    }
    if (field.type === 14) {
      if (!field.options.length) pushIssue(issues, 'UPSTREAM_SELECT_OPTIONS_MISSING', { upstreamPath: path })
      inspectOptionSiblings(field.options, path, issues, true)
    } else if (field.type === 16) {
      if (!field.options.length) pushIssue(issues, 'UPSTREAM_CASCADE_OPTIONS_MISSING', { upstreamPath: path })
      inspectOptionSiblings(field.options, path, issues, true)
    } else if (field.options.some(option => option.children.length || option.expand.length)) {
      pushIssue(issues, 'UPSTREAM_BRANCH_SEMANTICS_UNVERIFIED', { upstreamPath: path })
    }
  }
  for (const [_title, group] of titleGroups) {
    if (group.length > 1) {
      const blocking = new Set(group.map(item => fieldSignature(item.field))).size === 1
      for (const item of group) pushIssue(issues, blocking ? 'UPSTREAM_FIELD_DUPLICATE_AMBIGUOUS' : 'UPSTREAM_FIELD_TITLE_DUPLICATE', {
        upstreamPath: item.path, blocking,
      })
    }
  }
  for (const paths of exactGroups.values()) {
    if (paths.length > 1) for (const path of paths) pushIssue(issues, 'UPSTREAM_FIELD_DUPLICATE_AMBIGUOUS', { upstreamPath: path })
  }
}

function inspectOptionSiblings(options: MappingUpstreamOption[], parentPath: SupplierMappingPath, issues: SupplierProductMappingIssue[], top = false): void {
  const values = new Map<string, number[]>()
  for (const [index, option] of options.entries()) values.set(option.value, [...(values.get(option.value) ?? []), index])
  for (const [_value, indexes] of values) {
    if (indexes.length > 1) for (const index of indexes) {
      const path = [...parentPath, { kind: top ? 'option' as const : 'child' as const, index }] as SupplierMappingPath
      pushIssue(issues, 'UPSTREAM_OPTION_VALUE_DUPLICATE', { upstreamPath: path })
    }
  }
  for (const [index, option] of options.entries()) {
    const optionPath = [...parentPath, { kind: top ? 'option' as const : 'child' as const, index }] as SupplierMappingPath
    inspectUpstreamFields(option.expand, optionPath, issues)
    inspectOptionSiblings(option.children, optionPath, issues)
  }
}

export function validateSupplierProductMapping(
  definitionValue: unknown,
  upstreamFields: MappingUpstreamField[] | null,
  rulesValue: unknown,
): { valid: boolean; issues: SupplierProductMappingIssue[]; rules: SupplierMappingRules | null } {
  const issues: SupplierProductMappingIssue[] = []
  const definitionResult = validatePurchaseFormDefinition(definitionValue)
  if (!definitionResult.ok) {
    pushIssue(issues, 'LOCAL_TEMPLATE_INVALID')
    return { valid: false, issues, rules: null }
  }
  const definition = definitionResult.value
  if (upstreamFields === null) {
    pushIssue(issues, 'UPSTREAM_PURCHASE_FIELDS_MISSING')
    return { valid: false, issues, rules: null }
  }
  if (!Array.isArray(rulesValue) && (!rulesValue || typeof rulesValue !== 'object')) {
    pushIssue(issues, 'MAPPING_RULES_INVALID')
    return { valid: false, issues, rules: null }
  }
  const candidate = rulesValue as { version?: unknown; fields?: unknown }
  if (candidate.version !== SUPPLIER_MAPPING_RULES_VERSION || !Array.isArray(candidate.fields)) {
    pushIssue(issues, 'MAPPING_RULES_INVALID')
    return { valid: false, issues, rules: null }
  }
  const rules = rulesValue as SupplierMappingRules
  inspectUpstreamFields(upstreamFields, [], issues)

  const local = flattenLocalDefinition(definition)
  const localById = new Map(local.fields.map(item => [item.field.id.toLowerCase(), item]))
  const localOptionById = new Map(local.options.map(item => [item.optionId, item]))
  const fieldRules = new Map<string, SupplierMappingFieldRule[]>()
  const resolvedFieldTargets = new Map<string, Array<{ localFieldId: string; upstreamPath: SupplierMappingPath }>>()
  for (const rule of rules.fields) fieldRules.set(rule.localFieldId.toLowerCase(), [...(fieldRules.get(rule.localFieldId.toLowerCase()) ?? []), rule])
  for (const [fieldId, sameIdRules] of fieldRules) {
    const localRef = localById.get(fieldId)
    if (!localRef) { pushIssue(issues, 'LOCAL_FIELD_UNKNOWN', { localFieldId: fieldId }); continue }
    if (sameIdRules.length !== 1) { pushIssue(issues, 'LOCAL_FIELD_MAPPING_DUPLICATE', { localFieldId: fieldId }); continue }
    const rule = sameIdRules[0]!
    if (rule.localMeaningKey !== localRef.field.meaningKey) pushIssue(issues, 'LOCAL_FIELD_MEANING_KEY_CHANGED', { localFieldId: fieldId })
    if (!sourceFieldPath(rule.upstreamPath)) { pushIssue(issues, 'UPSTREAM_FIELD_LOCATOR_INVALID', { localFieldId: fieldId, upstreamPath: rule.upstreamPath }); continue }
    const resolved = resolveSupplierMappingPath(upstreamFields, rule.upstreamPath)
    if (!resolved || resolved.kind !== 'field') { pushIssue(issues, 'UPSTREAM_FIELD_LOCATOR_MISSING', { localFieldId: fieldId, upstreamPath: rule.upstreamPath }); continue }
    const upstreamField = resolved.field
    const fieldTargetKey = canonicalSupplierMappingJson(rule.upstreamPath)
    resolvedFieldTargets.set(fieldTargetKey, [...(resolvedFieldTargets.get(fieldTargetKey) ?? []), { localFieldId: fieldId, upstreamPath: rule.upstreamPath }])
    if (!isCompatible(localRef.field.type, upstreamField.type)) {
      pushIssue(issues, upstreamField.type === null || ![0, 1, 13, 14, 15, 16].includes(upstreamField.type) ? 'UPSTREAM_FIELD_TYPE_UNKNOWN' : 'FIELD_TYPE_INCOMPATIBLE', {
        localFieldId: fieldId, upstreamPath: rule.upstreamPath,
      })
    }
    if (upstreamField.required === null) pushIssue(issues, 'UPSTREAM_REQUIRED_SEMANTICS_UNKNOWN', { localFieldId: fieldId, upstreamPath: rule.upstreamPath })
    const localBranchId = localRef.parentOptionId
    const sourceParentOptionPath = rule.upstreamPath.at(-1)?.kind === 'expand'
      ? rule.upstreamPath.slice(0, -1) as SupplierMappingPath : null
    if (Boolean(localBranchId) !== Boolean(sourceParentOptionPath)) {
      pushIssue(issues, 'UPSTREAM_FIELD_CONDITIONAL_SOURCE_MISMATCH', { localFieldId: fieldId, upstreamPath: rule.upstreamPath })
    } else if (localBranchId) {
      const parentOption = localOptionById.get(localBranchId)
      const parentFieldRules = parentOption ? fieldRules.get(parentOption.parentFieldId) : null
      const parentFieldRule = parentFieldRules?.length === 1 ? parentFieldRules[0] : null
      const parentOptionRule = parentFieldRule?.options.find(option => option.localOptionId.toLowerCase() === localBranchId)
      if (!parentOptionRule || canonicalSupplierMappingJson(parentOptionRule.upstreamPath) !== canonicalSupplierMappingJson(sourceParentOptionPath)) {
        pushIssue(issues, 'UPSTREAM_FIELD_CONDITIONAL_SOURCE_MISMATCH', { localFieldId: fieldId, upstreamPath: rule.upstreamPath })
      }
    }
    if (upstreamField.required === true) {
      if (!localRef.field.required) pushIssue(issues, 'LOCAL_REQUIREDNESS_TOO_WEAK', { localFieldId: fieldId, upstreamPath: rule.upstreamPath })
    }

    const localOptions = localOptionsFor(localRef.field)
    const optionRules = new Map<string, SupplierMappingOptionRule[]>()
    const resolvedOptionTargets = new Map<string, Array<{ localOptionId: string; upstreamPath: SupplierMappingPath }>>()
    for (const optionRule of rule.options) optionRules.set(optionRule.localOptionId.toLowerCase(), [...(optionRules.get(optionRule.localOptionId.toLowerCase()) ?? []), optionRule])
    if (localRef.field.type === 'select' || localRef.field.type === 'cascade') {
      for (const option of localOptions) {
        const matches = optionRules.get(option.optionId) ?? []
        if (matches.length !== 1) { pushIssue(issues, matches.length ? 'LOCAL_OPTION_MAPPING_DUPLICATE' : 'LOCAL_OPTION_UNMAPPED', { localFieldId: fieldId, localOptionId: option.optionId }); continue }
        const optionRule = matches[0]!
        if (optionRule.localMeaningKey !== option.meaningKey) pushIssue(issues, 'LOCAL_OPTION_MEANING_KEY_CHANGED', { localFieldId: fieldId, localOptionId: option.optionId })
        if (sourceFieldPath(optionRule.upstreamPath)) { pushIssue(issues, 'UPSTREAM_OPTION_LOCATOR_INVALID', { localFieldId: fieldId, localOptionId: option.optionId, upstreamPath: optionRule.upstreamPath }); continue }
        const source = resolveSupplierMappingPath(upstreamFields, optionRule.upstreamPath)
        if (!source || source.kind !== 'option') { pushIssue(issues, 'UPSTREAM_OPTION_LOCATOR_MISSING', { localFieldId: fieldId, localOptionId: option.optionId, upstreamPath: optionRule.upstreamPath }); continue }
        const optionTargetKey = canonicalSupplierMappingJson(optionRule.upstreamPath)
        resolvedOptionTargets.set(optionTargetKey, [...(resolvedOptionTargets.get(optionTargetKey) ?? []), {
          localOptionId: option.optionId, upstreamPath: optionRule.upstreamPath,
        }])
        const parent = sourceOptionParentPath(optionRule.upstreamPath)
        if (parent === null) { pushIssue(issues, 'UPSTREAM_OPTION_LOCATOR_INVALID', { localFieldId: fieldId, localOptionId: option.optionId, upstreamPath: optionRule.upstreamPath }); continue }
        if (localRef.field.type === 'select') {
          if (upstreamField.type !== 14 || canonicalSupplierMappingJson(parent) !== canonicalSupplierMappingJson(rule.upstreamPath)) {
            pushIssue(issues, 'SELECT_OPTION_SOURCE_MISMATCH', { localFieldId: fieldId, localOptionId: option.optionId, upstreamPath: optionRule.upstreamPath })
          }
        } else {
          const parentOptionId = option.parentOptionId
          const parentRule = parentOptionId ? optionRules.get(parentOptionId)?.[0] : null
          const expectedParent = parentRule?.upstreamPath ?? rule.upstreamPath
          if (upstreamField.type !== 16 || canonicalSupplierMappingJson(parent) !== canonicalSupplierMappingJson(expectedParent)) {
            pushIssue(issues, 'CASCADE_OPTION_SOURCE_MISMATCH', { localFieldId: fieldId, localOptionId: option.optionId, upstreamPath: optionRule.upstreamPath })
          }
        }
      }
      const currentLocalOptionIds = new Set(localOptions.map(option => option.optionId))
      for (const [optionId] of optionRules) if (!currentLocalOptionIds.has(optionId)) {
        pushIssue(issues, 'LOCAL_OPTION_UNKNOWN', { localFieldId: fieldId, localOptionId: optionId })
      }
      for (const owners of resolvedOptionTargets.values()) if (owners.length > 1) {
        for (const owner of owners) pushIssue(issues, 'UPSTREAM_OPTION_TARGET_REUSED', {
          localFieldId: fieldId, localOptionId: owner.localOptionId, upstreamPath: owner.upstreamPath,
        })
      }
    } else if (rule.options.length) {
      pushIssue(issues, 'UNEXPECTED_OPTION_MAPPINGS', { localFieldId: fieldId, upstreamPath: rule.upstreamPath })
    }

    if (localRef.field.type === 'image') {
      pushIssue(issues, 'IMAGE_ENCODING_UNVERIFIED', { localFieldId: fieldId, upstreamPath: rule.upstreamPath, blocking: false })
    }
  }
  for (const localRef of local.fields) if (!fieldRules.has(localRef.field.id.toLowerCase())) {
    pushIssue(issues, 'LOCAL_FIELD_UNMAPPED', { localFieldId: localRef.field.id })
  }
  for (const owners of resolvedFieldTargets.values()) if (owners.length > 1) {
    for (const owner of owners) pushIssue(issues, 'UPSTREAM_FIELD_TARGET_REUSED', {
      localFieldId: owner.localFieldId, upstreamPath: owner.upstreamPath,
    })
  }

  // Every required upstream field must have a direct, unconditional local source.
  const mappedUpstreamPaths = new Set(rules.fields.map(rule => canonicalSupplierMappingJson(rule.upstreamPath)))
  const mappedUpstreamOptions = new Set(rules.fields.flatMap(rule => rule.options.map(option => canonicalSupplierMappingJson(option.upstreamPath))))
  const visitRequired = (fields: MappingUpstreamField[], prefix: SupplierMappingPath) => {
    for (const [index, field] of fields.entries()) {
      const path = [...prefix, ...(prefix.length ? [{ kind: 'expand' as const, index }] : [{ kind: 'field' as const, index }])] as SupplierMappingPath
      if (field.required === true && !mappedUpstreamPaths.has(canonicalSupplierMappingJson(path))) {
        pushIssue(issues, 'UPSTREAM_REQUIRED_FIELD_UNMAPPED', { upstreamPath: path })
      }
      for (const [optionIndex, option] of field.options.entries()) {
        const optionPath = [...path, { kind: 'option' as const, index: optionIndex }] as SupplierMappingPath
        if (mappedUpstreamOptions.has(canonicalSupplierMappingJson(optionPath))) {
          visitRequired(option.expand, optionPath)
          visitChildren(option.children, optionPath)
        }
      }
    }
  }
  const visitChildren = (options: MappingUpstreamOption[], parentPath: SupplierMappingPath) => {
    for (const [optionIndex, option] of options.entries()) {
      const optionPath = [...parentPath, { kind: 'child' as const, index: optionIndex }] as SupplierMappingPath
      if (mappedUpstreamOptions.has(canonicalSupplierMappingJson(optionPath))) {
        visitRequired(option.expand, optionPath)
        visitChildren(option.children, optionPath)
      }
    }
  }
  visitRequired(upstreamFields, [])

  const deduplicated = [...new Map(issues.map(issue => [canonicalSupplierMappingJson(issue), issue])).values()]
  return { valid: !deduplicated.some(issue => issue.blocking), issues: deduplicated, rules }
}

function syntheticUuid(value: string): string {
  const hex = value.replace(/[^a-f0-9]/giu, '').toLowerCase().padEnd(32, '0').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = '8'
  const raw = hex.join('')
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

function syntheticValues(definition: PurchaseFormDefinition): { values: Record<string, unknown>; attachmentIds: Set<string>; attachmentFieldIds: Map<string, string> } {
  const values: Record<string, unknown> = {}
  const attachmentIds = new Set<string>()
  const attachmentFieldIds = new Map<string, string>()
  const sampleLeaf = (field: PurchaseFormLeafField): unknown => {
    if (field.type === 'text') return `  Sample-${field.meaningKey}  `
    if (field.type === 'textarea') return `Sample ${field.meaningKey}\nsecond line`
    if (field.type === 'digits') return '00001234567890'
    if (field.type === 'select') return field.options[0]?.id ?? ''
    const id = syntheticUuid(field.id)
    attachmentIds.add(id)
    attachmentFieldIds.set(id, field.id.toLowerCase())
    return [id]
  }
  for (const field of definition.fields) {
    if (field.type !== 'cascade') { values[field.id] = sampleLeaf(field); continue }
    const path: string[] = []
    const expanded: Record<string, unknown> = {}
    let options = field.options
    while (options.length) {
      const option = options[0]!
      path.push(option.id)
      for (const expandedField of option.expandedFields ?? []) expanded[expandedField.id] = sampleLeaf(expandedField)
      options = option.children ?? []
    }
    values[field.id] = { path, expanded }
  }
  return { values, attachmentIds, attachmentFieldIds }
}

export function previewSupplierProductMapping(options: {
  definition: unknown
  upstreamFields: MappingUpstreamField[] | null
  rules: unknown
}): SupplierProductMappingPreview {
  const validated = validateSupplierProductMapping(options.definition, options.upstreamFields, options.rules)
  const issues = [...validated.issues]
  const definitionResult = validatePurchaseFormDefinition(options.definition)
  if (!definitionResult.ok || !validated.rules || !options.upstreamFields) {
    return { kind: 'internal_mapping_preview', executedUpstreamCode: false, usedCustomerData: false,
      output: { fields: [] }, issues, notices: ['预览只处理本地合成样例；未运行上游 regex、HTML、JavaScript 或表达式。'] }
  }
  const definition = definitionResult.value
  const sample = syntheticValues(definition)
  const normalized = normalizePurchaseFormAnswers(definition, sample.values, {
    requireComplete: true, attachmentIds: sample.attachmentIds, attachmentFieldIds: sample.attachmentFieldIds,
  })
  if (!normalized.ok || normalized.incompleteFieldIds.length) {
    for (const incomplete of normalized.ok ? normalized.incompleteFieldIds : normalized.issues.map(issue => issue.fieldId).filter((id): id is string => Boolean(id))) {
      pushIssue(issues, 'SYNTHETIC_PREVIEW_INPUT_INVALID', { localFieldId: incomplete })
    }
  }
  const values = normalized.ok ? normalized.value : {}
  const ruleByFieldId = new Map(validated.rules.fields.map(rule => [rule.localFieldId.toLowerCase(), rule]))
  const optionRule = (rule: SupplierMappingFieldRule, localOptionId: string) => rule.options.find(item => item.localOptionId.toLowerCase() === localOptionId.toLowerCase())
  const output: SupplierProductMappingPreview['output']['fields'] = []
  const appendField = (field: PurchaseFormField, value: unknown) => {
    const rule = ruleByFieldId.get(field.id.toLowerCase())
    if (!rule || value === undefined) return
    if (field.type === 'image') {
      const ids = Array.isArray(value) ? value : []
      output.push({ localFieldId: field.id, localMeaningKey: field.meaningKey, upstreamPath: rule.upstreamPath,
        imageSources: ids.map(localObjectRef => ({ localObjectRef: `synthetic:${String(localObjectRef)}` })) })
      return
    }
    if (field.type === 'select') {
      const selected = typeof value === 'string' ? value : ''
      const mapped = optionRule(rule, selected)
      const resolved = mapped && resolveSupplierMappingPath(options.upstreamFields!, mapped.upstreamPath)
      if (!resolved || resolved.kind !== 'option') pushIssue(issues, 'PREVIEW_OPTION_UNRESOLVED', { localFieldId: field.id, localOptionId: selected })
      else output.push({ localFieldId: field.id, localMeaningKey: field.meaningKey, upstreamPath: rule.upstreamPath, value: resolved.option.value })
      return
    }
    if (field.type === 'cascade') {
      const candidate = value as { path?: unknown[]; expanded?: Record<string, unknown> }
      const sourcePath: string[] = []
      for (const localOptionId of candidate.path ?? []) {
        const mapped = optionRule(rule, String(localOptionId))
        const resolved = mapped && resolveSupplierMappingPath(options.upstreamFields!, mapped.upstreamPath)
        if (!resolved || resolved.kind !== 'option') { pushIssue(issues, 'PREVIEW_OPTION_UNRESOLVED', { localFieldId: field.id, localOptionId: String(localOptionId) }); continue }
        sourcePath.push(resolved.option.value)
      }
      output.push({ localFieldId: field.id, localMeaningKey: field.meaningKey, upstreamPath: rule.upstreamPath, value: sourcePath })
      const local = flattenLocalDefinition(definition)
      const expandedValues = candidate.expanded ?? {}
      for (const localRef of local.fields.filter(item => item.parentOptionId && Object.hasOwn(expandedValues, item.field.id.toLowerCase()))) {
        const expandedValue = expandedValues[localRef.field.id.toLowerCase()]
        appendField(localRef.field, expandedValue)
      }
      return
    }
    if (typeof value === 'string') output.push({ localFieldId: field.id, localMeaningKey: field.meaningKey, upstreamPath: rule.upstreamPath, value })
  }
  for (const field of definition.fields) appendField(field, values[field.id.toLowerCase()])
  return { kind: 'internal_mapping_preview', executedUpstreamCode: false, usedCustomerData: false,
    output: { fields: output }, issues, notices: [
      '预览只使用合成样例；输出是内部映射中间表示，不是供应商购买请求。',
      '未运行上游 regex、HTML、JavaScript 或表达式。',
      ...(definition.fields.some(field => field.type === 'image') ? ['图片仅显示本地对象来源引用；数量规则与上游编码未验证。'] : []),
    ] }
}
