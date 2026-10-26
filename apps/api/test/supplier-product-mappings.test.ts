import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { previewSupplierProductMapping, validateSupplierProductMapping, type PurchaseFormDefinition, type SupplierMappingRules } from '@aikayun/contracts'

function fixture() {
  const [textId, digitsId, textareaId, selectId, selectA, selectB, cascadeId, rootOptionId, childOptionId, expandedId, imageId] = Array.from({ length: 11 }, () => randomUUID())
  const definition: PurchaseFormDefinition = { fields: [
    { id: textId!, meaningKey: 'account_name', type: 'text', label: '账号', required: true },
    { id: digitsId!, meaningKey: 'card_number', type: 'digits', label: '卡号', required: true },
    { id: textareaId!, meaningKey: 'note', type: 'textarea', label: '备注', required: false },
    { id: selectId!, meaningKey: 'channel', type: 'select', label: '渠道', required: true, options: [
      { id: selectA!, meaningKey: 'primary', label: '主渠道' }, { id: selectB!, meaningKey: 'backup', label: '备用渠道' },
    ] },
    { id: cascadeId!, meaningKey: 'region', type: 'cascade', label: '地区', required: true, options: [{
      id: rootOptionId!, meaningKey: 'north', label: '北区', expandedFields: [
        { id: expandedId!, meaningKey: 'branch_code', type: 'text', label: '分区码', required: true },
      ], children: [{ id: childOptionId!, meaningKey: 'city_a', label: '城市 A' }],
    }] },
    { id: imageId!, meaningKey: 'proof', type: 'image', label: '凭证', required: false, maxCount: 2 },
  ] }
  const upstream = [
    { type: 0, title: '账号', placeholder: '', required: true, regex: '^[A-Z]+$', options: [] },
    { type: 13, title: '卡号', placeholder: '', required: true, regex: '', options: [] },
    { type: 15, title: '备注', placeholder: '', required: false, regex: '', options: [] },
    { type: 14, title: '渠道', placeholder: '', required: true, regex: '', options: [
      { name: '默认渠道', value: 'MAIN', children: [], expand: [] },
      { name: '备用渠道', value: 'backup-02', children: [], expand: [] },
    ] },
    { type: 16, title: '地区', placeholder: '', required: true, regex: '', options: [{
      name: '北区', value: 'NORTH', children: [{ name: '城市 A', value: 'CITY-A', children: [], expand: [] }], expand: [
        { type: 0, title: '分区码', placeholder: '', required: true, regex: '', options: [] },
      ],
    }] },
    { type: 1, title: '图片凭证', placeholder: '', required: false, regex: '', options: [] },
  ]
  const field = (index: number, id: string, meaningKey: string, options: SupplierMappingRules['fields'][number]['options'] = []) => ({
    localFieldId: id, localMeaningKey: meaningKey, upstreamPath: [{ kind: 'field' as const, index }], options,
  })
  const rules: SupplierMappingRules = { version: 1, fields: [
    field(0, textId!, 'account_name'), field(1, digitsId!, 'card_number'), field(2, textareaId!, 'note'),
    field(3, selectId!, 'channel', [
      { localOptionId: selectA!, localMeaningKey: 'primary', upstreamPath: [{ kind: 'field', index: 3 }, { kind: 'option', index: 0 }] },
      { localOptionId: selectB!, localMeaningKey: 'backup', upstreamPath: [{ kind: 'field', index: 3 }, { kind: 'option', index: 1 }] },
    ]),
    field(4, cascadeId!, 'region', [
      { localOptionId: rootOptionId!, localMeaningKey: 'north', upstreamPath: [{ kind: 'field', index: 4 }, { kind: 'option', index: 0 }] },
      { localOptionId: childOptionId!, localMeaningKey: 'city_a', upstreamPath: [{ kind: 'field', index: 4 }, { kind: 'option', index: 0 }, { kind: 'child', index: 0 }] },
    ]),
    { localFieldId: expandedId!, localMeaningKey: 'branch_code', upstreamPath: [
      { kind: 'field', index: 4 }, { kind: 'option', index: 0 }, { kind: 'expand', index: 0 },
    ], options: [] },
    field(5, imageId!, 'proof'),
  ] }
  return { definition, upstream, rules, ids: { textId, digitsId, textareaId, selectId, selectA, selectB, cascadeId, rootOptionId, childOptionId, expandedId, imageId } }
}

describe('supplier product mapping structural rules and safe preview', () => {
  it('maps text, digits, textarea, select, cascade, expand and image without converting customer data or executing regex', () => {
    const value = fixture()
    const checked = validateSupplierProductMapping(value.definition, value.upstream, value.rules)
    expect(checked.valid).toBe(true)
    const preview = previewSupplierProductMapping({ definition: value.definition, upstreamFields: value.upstream, rules: value.rules })
    expect(preview).toMatchObject({ kind: 'internal_mapping_preview', executedUpstreamCode: false, usedCustomerData: false })
    expect(preview.output.fields.find(row => row.localFieldId === value.ids.digitsId)?.value).toBe('00001234567890')
    expect(preview.output.fields.find(row => row.localFieldId === value.ids.textId)?.value).toBe('  Sample-account_name  ')
    expect(preview.output.fields.find(row => row.localFieldId === value.ids.selectId)?.value).toBe('MAIN')
    expect(preview.output.fields.find(row => row.localFieldId === value.ids.cascadeId)?.value).toEqual(['NORTH', 'CITY-A'])
    expect(preview.output.fields.find(row => row.localFieldId === value.ids.imageId)?.imageSources?.[0]?.localObjectRef).toMatch(/^synthetic:/u)
    expect(JSON.stringify(preview)).not.toContain('^[A-Z]+$')
  })

  it('blocks ambiguous duplicate fields and raw option values, unknown types, and unreported required semantics', () => {
    const value = fixture()
    const duplicateField = { ...value.upstream[0]!, title: value.upstream[3]!.title, type: 0 }
    const sameNamed = validateSupplierProductMapping(value.definition, [...value.upstream, duplicateField], value.rules)
    expect(sameNamed.issues.some(issue => issue.code === 'UPSTREAM_FIELD_TITLE_DUPLICATE')).toBe(true)
    const structurallyAmbiguous = validateSupplierProductMapping(value.definition, [...value.upstream, { ...value.upstream[0]! }], value.rules)
    expect(structurallyAmbiguous.issues.some(issue => issue.code === 'UPSTREAM_FIELD_DUPLICATE_AMBIGUOUS' && issue.blocking)).toBe(true)
    const duplicateValues = structuredClone(value.upstream)
    duplicateValues[3]!.options[1]!.value = duplicateValues[3]!.options[0]!.value
    expect(validateSupplierProductMapping(value.definition, duplicateValues, value.rules).issues)
      .toContainEqual(expect.objectContaining({ code: 'UPSTREAM_OPTION_VALUE_DUPLICATE', blocking: true }))
    const unknownType = structuredClone(value.upstream)
    unknownType[0]!.type = 99
    expect(validateSupplierProductMapping(value.definition, unknownType, value.rules).issues)
      .toContainEqual(expect.objectContaining({ code: 'UPSTREAM_FIELD_TYPE_UNKNOWN', blocking: true }))
    const unknownRequired = structuredClone(value.upstream)
    unknownRequired[0]!.required = null
    expect(validateSupplierProductMapping(value.definition, unknownRequired, value.rules).issues)
      .toContainEqual(expect.objectContaining({ code: 'UPSTREAM_REQUIRED_SEMANTICS_UNKNOWN', blocking: true }))
  })

  it('rejects missing required fields and cross-branch cascade paths while allowing incomplete draft rules to be represented', () => {
    const value = fixture()
    const missingRequired = validateSupplierProductMapping(value.definition, value.upstream, {
      version: 1, fields: value.rules.fields.filter(rule => rule.localFieldId !== value.ids.textId),
    })
    expect(missingRequired.issues).toContainEqual(expect.objectContaining({ code: 'UPSTREAM_REQUIRED_FIELD_UNMAPPED', blocking: true }))
    const changed = structuredClone(value.rules)
    const cascade = changed.fields.find(rule => rule.localFieldId === value.ids.cascadeId)!
    cascade.options[1]!.upstreamPath = [{ kind: 'field', index: 4 }, { kind: 'option', index: 0 }]
    expect(validateSupplierProductMapping(value.definition, value.upstream, changed).issues)
      .toContainEqual(expect.objectContaining({ code: 'CASCADE_OPTION_SOURCE_MISMATCH', blocking: true }))
    const blank = structuredClone(value.rules)
    blank.fields[0]!.upstreamPath = []
    expect(validateSupplierProductMapping(value.definition, value.upstream, blank).valid).toBe(false)
  })

  it('binds every expanded local field to its exact mapped branch even when the upstream field is optional', () => {
    const value = fixture()
    const ids = { alternateBranch: randomUUID(), optionalExtension: randomUUID() }
    const cascade = value.definition.fields.find(field => field.type === 'cascade')!
    if (cascade.type !== 'cascade') throw new Error('fixture cascade missing')
    cascade.options[0]!.expandedFields!.push({ id: ids.optionalExtension, meaningKey: 'branch_note', type: 'text', label: '分支备注', required: false })
    cascade.options.push({ id: ids.alternateBranch, meaningKey: 'south', label: '南区', expandedFields: [], children: [] })
    value.upstream[4]!.options[0]!.expand.push({ type: 0, title: '分支备注', placeholder: '', required: false, regex: '', options: [] })
    value.upstream[4]!.options.push({ name: '南区', value: 'SOUTH', children: [], expand: [
      { type: 0, title: '分支备注', placeholder: '', required: false, regex: '', options: [] },
    ] })
    const changed = structuredClone(value.rules)
    const parentRule = changed.fields.find(rule => rule.localFieldId === value.ids.cascadeId)!
    parentRule.options.push({ localOptionId: ids.alternateBranch, localMeaningKey: 'south', upstreamPath: [
      { kind: 'field', index: 4 }, { kind: 'option', index: 1 },
    ] })
    changed.fields.push({ localFieldId: ids.optionalExtension, localMeaningKey: 'branch_note', upstreamPath: [
      { kind: 'field', index: 4 }, { kind: 'option', index: 1 }, { kind: 'expand', index: 0 },
    ], options: [] })

    const crossBranch = validateSupplierProductMapping(value.definition, value.upstream, changed)
    expect(crossBranch.issues).toContainEqual(expect.objectContaining({ code: 'UPSTREAM_FIELD_CONDITIONAL_SOURCE_MISMATCH',
      localFieldId: ids.optionalExtension, blocking: true }))

    const topLevelToConditional = structuredClone(changed)
    topLevelToConditional.fields.find(rule => rule.localFieldId === value.ids.textId)!.upstreamPath = [
      { kind: 'field', index: 4 }, { kind: 'option', index: 1 }, { kind: 'expand', index: 0 },
    ]
    expect(validateSupplierProductMapping(value.definition, value.upstream, topLevelToConditional).issues)
      .toContainEqual(expect.objectContaining({ code: 'UPSTREAM_FIELD_CONDITIONAL_SOURCE_MISMATCH', localFieldId: value.ids.textId, blocking: true }))

    const unrelatedTopLevel = structuredClone(changed)
    unrelatedTopLevel.fields.find(rule => rule.localFieldId === ids.optionalExtension)!.upstreamPath = [{ kind: 'field', index: 0 }]
    expect(validateSupplierProductMapping(value.definition, value.upstream, unrelatedTopLevel).issues)
      .toContainEqual(expect.objectContaining({ code: 'UPSTREAM_FIELD_CONDITIONAL_SOURCE_MISMATCH', localFieldId: ids.optionalExtension, blocking: true }))

    const sameBranch = structuredClone(changed)
    sameBranch.fields.find(rule => rule.localFieldId === ids.optionalExtension)!.upstreamPath = [
      { kind: 'field', index: 4 }, { kind: 'option', index: 0 }, { kind: 'expand', index: 1 },
    ]
    expect(validateSupplierProductMapping(value.definition, value.upstream, sameBranch).issues)
      .not.toContainEqual(expect.objectContaining({ code: 'UPSTREAM_FIELD_CONDITIONAL_SOURCE_MISMATCH', localFieldId: ids.optionalExtension }))
  })

  it('blocks distinct local fields and options that reuse one resolved upstream identity', () => {
    const value = fixture()
    const extraTextId = randomUUID()
    value.definition.fields.push({ id: extraTextId, meaningKey: 'alternate_account', type: 'text', label: '备用账号', required: true })
    const duplicateTextField = validateSupplierProductMapping(value.definition, value.upstream, {
      ...structuredClone(value.rules), fields: [...structuredClone(value.rules).fields,
        { localFieldId: extraTextId, localMeaningKey: 'alternate_account', upstreamPath: [{ kind: 'field', index: 0 }], options: [] }],
    })
    expect(duplicateTextField.issues).toContainEqual(expect.objectContaining({ code: 'UPSTREAM_FIELD_TARGET_REUSED',
      localFieldId: extraTextId, upstreamPath: [{ kind: 'field', index: 0 }], blocking: true }))

    const duplicateSelectOption = structuredClone(value.rules)
    duplicateSelectOption.fields.find(rule => rule.localFieldId === value.ids.selectId)!.options[1]!.upstreamPath = [
      { kind: 'field', index: 3 }, { kind: 'option', index: 0 },
    ]
    expect(validateSupplierProductMapping(value.definition, value.upstream, duplicateSelectOption).issues)
      .toContainEqual(expect.objectContaining({ code: 'UPSTREAM_OPTION_TARGET_REUSED', localFieldId: value.ids.selectId,
        localOptionId: value.ids.selectB, blocking: true }))
    expect(previewSupplierProductMapping({ definition: value.definition, upstreamFields: value.upstream, rules: duplicateSelectOption }).issues)
      .toContainEqual(expect.objectContaining({ code: 'UPSTREAM_OPTION_TARGET_REUSED', blocking: true }))

    const extraChildId = randomUUID()
    const cascade = value.definition.fields.find(field => field.type === 'cascade')!
    if (cascade.type !== 'cascade') throw new Error('fixture cascade missing')
    cascade.options[0]!.children!.push({ id: extraChildId, meaningKey: 'city_b', label: '城市 B' })
    const duplicateCascadeOption = structuredClone(value.rules)
    duplicateCascadeOption.fields.find(rule => rule.localFieldId === value.ids.cascadeId)!.options.push({
      localOptionId: extraChildId, localMeaningKey: 'city_b', upstreamPath: [
        { kind: 'field', index: 4 }, { kind: 'option', index: 0 }, { kind: 'child', index: 0 },
      ],
    })
    expect(validateSupplierProductMapping(value.definition, value.upstream, duplicateCascadeOption).issues)
      .toContainEqual(expect.objectContaining({ code: 'UPSTREAM_OPTION_TARGET_REUSED', localFieldId: value.ids.cascadeId,
        localOptionId: extraChildId, blocking: true }))
  })

  it('allows equal raw option values when they belong to different upstream parent paths', () => {
    const value = fixture()
    const alternateRootId = randomUUID()
    const alternateChildId = randomUUID()
    const cascade = value.definition.fields.find(field => field.type === 'cascade')!
    if (cascade.type !== 'cascade') throw new Error('fixture cascade missing')
    cascade.options.push({ id: alternateRootId, meaningKey: 'south', label: '南区', expandedFields: [], children: [
      { id: alternateChildId, meaningKey: 'other_city', label: '另一城市' },
    ] })
    value.upstream[4]!.options.push({ name: '南区', value: 'SOUTH', expand: [], children: [
      { name: '另一城市', value: 'CITY-A', expand: [], children: [] },
    ] })
    const rules = structuredClone(value.rules)
    rules.fields.find(rule => rule.localFieldId === value.ids.cascadeId)!.options.push(
      { localOptionId: alternateRootId, localMeaningKey: 'south', upstreamPath: [{ kind: 'field', index: 4 }, { kind: 'option', index: 1 }] },
      { localOptionId: alternateChildId, localMeaningKey: 'other_city', upstreamPath: [{ kind: 'field', index: 4 }, { kind: 'option', index: 1 }, { kind: 'child', index: 0 }] },
    )
    const checked = validateSupplierProductMapping(value.definition, value.upstream, rules)
    expect(checked.issues).not.toContainEqual(expect.objectContaining({ code: 'UPSTREAM_OPTION_TARGET_REUSED', blocking: true }))
    expect(checked.valid).toBe(true)
  })
})
