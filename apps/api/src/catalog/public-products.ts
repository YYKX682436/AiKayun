import type { FastifyInstance, FastifyReply } from 'fastify'
import { sql, type Kysely } from 'kysely'
import {
  ApiErrorSchema,
  ApiSuccessSchemaOf,
  failure,
  ProductIdParamsSchema,
  PublicCategoriesResponseSchema,
  PublicCategoryProductsResponseSchema,
  PublicProductDetailSchema,
  PublicProductListQuerySchema,
  PublicProductPageSchema,
  PublicProductSearchQuerySchema,
  PublicSitemapQuerySchema,
  PublicSitemapResponseSchema,
  success,
} from '@aikayun/contracts'
import type {
  PublicCategoriesResponse,
  PublicCategory,
  PublicCategoryPathItem,
  PublicCategoryProductsResponse,
  PublicInventorySummary,
  PublicProductCard,
  PublicProductDetail,
  PublicProductPage,
  PublicProductSearchQuery,
  PublicSitemapItem,
  PublicSitemapQuery,
  PublicSitemapResponse,
} from '@aikayun/contracts'
import { parseUnitAmount } from '@aikayun/money'
import type { Kysely as KyselyDatabase } from 'kysely'
import type { Database, ProductInventoryMode, ProductType } from '../db/types.js'
import { productMediaUrl } from '../media/queries.js'
import { productRichContentToSafeHtml } from '../media/rich-content.js'

const defaultPageSize = 24

type PublicCategoryRow = {
  id: string
  parent_id: string | null
  name: string
  sort_order: number
  level: number
}

type PublicCategoryRecord = PublicCategory & { path: PublicCategoryPathItem[] }

type PublicCardRow = {
  id: string
  name: string
  description: string
  product_type: ProductType
  min_sale_price: string | null
  max_sale_price: string | null
  public_variant_count: number
  in_stock_variant_count: number
  quantity_variant_count: number
  cover_id: string | null
  cover_width: number | null
  cover_height: number | null
}

type PublicVariantRow = {
  id: string
  sale_price: string
  compare_at_price: string | null
  inventory_mode: ProductInventoryMode | null
  available_quantity: number | null
}

type PublicOptionRow = {
  group_id: string
  group_name: string
  group_sort_order: number
  value_id: string | null
  value_name: string | null
  value_sort_order: number | null
  available: boolean | null
}

type PublicProductQuery = Pick<PublicProductSearchQuery, 'page' | 'pageSize' | 'sort' | 'q' | 'categoryId' | 'productType'>

function formatSalePrice(value: string): string {
  const amount = parseUnitAmount(value)
  if (amount.isNegative() || amount.decimalPlaces() > 2) {
    throw new Error('Stored product sale price violates the public catalog amount contract')
  }
  return amount.toFixed(2)
}

export function variantOptionCombinationValid(alias: string) {
  const id = sql.ref(`${alias}.id`)
  const productId = sql.ref(`${alias}.product_id`)
  return sql`
    (
      SELECT count(*)
      FROM product_variant_option_values AS enabled_relation
      WHERE enabled_relation.product_id = ${productId}
        AND enabled_relation.product_variant_id = ${id}
        AND enabled_relation.option_group_id IN (
          SELECT enabled_group.id FROM product_option_groups AS enabled_group
          WHERE enabled_group.product_id = ${productId} AND enabled_group.enabled
        )
    ) = (
      SELECT count(*) FROM product_option_groups AS required_group
      WHERE required_group.product_id = ${productId} AND required_group.enabled
    )
    AND NOT EXISTS (
      SELECT 1
      FROM product_variant_option_values AS selected
      INNER JOIN product_option_groups AS option_group
        ON option_group.id = selected.option_group_id AND option_group.product_id = selected.product_id
      INNER JOIN product_option_values AS option_value
        ON option_value.id = selected.option_value_id
        AND option_value.option_group_id = selected.option_group_id
        AND option_value.product_id = selected.product_id
      WHERE selected.product_id = ${productId}
        AND selected.product_variant_id = ${id}
        AND (NOT option_group.enabled OR NOT option_value.enabled)
    )
    AND NOT EXISTS (
      SELECT 1 FROM product_option_groups AS required_group
      WHERE required_group.product_id = ${productId} AND required_group.enabled
        AND NOT EXISTS (
          SELECT 1
          FROM product_variant_option_values AS selected
          INNER JOIN product_option_values AS option_value
            ON option_value.id = selected.option_value_id
            AND option_value.option_group_id = selected.option_group_id
            AND option_value.product_id = selected.product_id
          WHERE selected.product_id = ${productId}
            AND selected.product_variant_id = ${id}
            AND selected.option_group_id = required_group.id
            AND option_value.enabled
        )
    )
  `
}

function publicVariantEligibility(alias: string) {
  const enabled = sql.ref(`${alias}.enabled`)
  const retiredAt = sql.ref(`${alias}.retired_at`)
  return sql`
    AND ${enabled} = TRUE
    AND ${retiredAt} IS NULL
    AND ${variantOptionCombinationValid(alias)}
  `
}

async function loadVisibleCategories(db: KyselyDatabase<Database>): Promise<PublicCategoryRecord[]> {
  const rows = await sql<PublicCategoryRow>`
    WITH RECURSIVE visible_categories AS (
      SELECT category.id, category.parent_id, category.name, category.sort_order, 0::integer AS level
      FROM product_categories AS category
      WHERE category.parent_id IS NULL AND category.is_visible
      UNION ALL
      SELECT child.id, child.parent_id, child.name, child.sort_order, parent.level + 1
      FROM product_categories AS child
      INNER JOIN visible_categories AS parent ON parent.id = child.parent_id
      WHERE child.is_visible AND parent.level < 3
    )
    SELECT id, parent_id, name, sort_order, level
    FROM visible_categories
  `.execute(db)

  const rowsById = new Map(rows.rows.map((row) => [row.id, row]))
  const categoryById = new Map<string, PublicCategoryRecord>()
  for (const row of [...rows.rows].sort((left, right) => left.level - right.level || left.sort_order - right.sort_order || left.id.localeCompare(right.id))) {
    const parent = row.parent_id ? categoryById.get(row.parent_id) : undefined
    const path = [...(parent?.path ?? []), { id: row.id, name: row.name }]
    categoryById.set(row.id, {
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      sortOrder: row.sort_order,
      level: row.level,
      path,
    })
  }

  const childrenByParent = new Map<string | null, PublicCategoryRecord[]>()
  for (const row of rows.rows) {
    const list = childrenByParent.get(row.parent_id) ?? []
    const category = categoryById.get(row.id)
    if (category) list.push(category)
    childrenByParent.set(row.parent_id, list)
  }
  const flattened: PublicCategoryRecord[] = []
  const visit = (parentId: string | null) => {
    const children = (childrenByParent.get(parentId) ?? []).sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    for (const child of children) {
      flattened.push(child)
      visit(child.id)
    }
  }
  visit(null)
  // A malformed tree must fail closed instead of accidentally returning a partial hierarchy.
  if (flattened.length !== rowsById.size) throw new Error('The public category tree could not be assembled safely')
  return flattened
}

function responsePage<T>(items: T[], total: number, page: number, pageSize: number) {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`)
}

function categoryPathIds(categories: PublicCategoryRecord[], categoryId: string): string[] {
  return categories
    .filter((category) => category.path.some((item) => item.id === categoryId))
    .map((category) => category.id)
}

function productWhere(query: PublicProductQuery, categoryIds: string[]) {
  const predicates = [sql`product.status = 'active'`]
  if (query.productType) predicates.push(sql`product.product_type = ${query.productType}`)
  if (query.q !== undefined) {
    const trimmed = query.q.trim()
    if (!trimmed) return { error: true as const, where: sql`WHERE FALSE` }
    const pattern = `%${escapeLike(trimmed)}%`
    predicates.push(sql`(
      product.name ILIKE ${pattern} ESCAPE '\\'
      OR product.description ILIKE ${pattern} ESCAPE '\\'
    )`)
  }
  if (query.categoryId) {
    predicates.push(sql`EXISTS (
      SELECT 1 FROM product_category_assignments AS assignment
      WHERE assignment.product_id = product.id
        AND assignment.category_id = ANY(${categoryIds}::uuid[])
    )`)
  }
  return { error: false as const, where: sql`WHERE ${sql.join(predicates, sql` AND `)}` }
}

async function queryProductPage(
  db: KyselyDatabase<Database>,
  query: PublicProductQuery,
  categoryIds: string[] = [],
): Promise<PublicProductPage> {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? defaultPageSize
  const offset = (page - 1) * pageSize
  const { where } = productWhere(query, categoryIds)
  const totalResult = await sql<{ total: number }>`
    SELECT count(*)::integer AS total FROM products AS product ${where}
  `.execute(db)

  let orderBy = sql`product.created_at DESC, product.id ASC`
  if (query.sort === 'price_asc') orderBy = sql`catalog.min_sale_price ASC NULLS LAST, product.id ASC`
  else if (query.sort === 'price_desc') orderBy = sql`catalog.min_sale_price DESC NULLS LAST, product.id ASC`
  else if (query.sort === 'default' && query.categoryId) {
    orderBy = sql`COALESCE((
      SELECT min(assignment.sort_order)
      FROM product_category_assignments AS assignment
      WHERE assignment.product_id = product.id
        AND assignment.category_id = ANY(${categoryIds}::uuid[])
    ), 2147483647) ASC, product.created_at DESC, product.id ASC`
  }

  const rows = await sql<PublicCardRow>`
    WITH public_variants AS (
      SELECT variant.*
      FROM product_variants AS variant
      WHERE TRUE ${publicVariantEligibility('variant')}
    )
    SELECT
      product.id,
      product.name,
      left(product.description, 280) AS description,
      product.product_type,
      catalog.min_sale_price::text AS min_sale_price,
      catalog.max_sale_price::text AS max_sale_price,
      COALESCE(catalog.public_variant_count, 0)::integer AS public_variant_count,
      COALESCE(catalog.in_stock_variant_count, 0)::integer AS in_stock_variant_count,
      COALESCE(catalog.quantity_variant_count, 0)::integer AS quantity_variant_count,
      cover.media_id AS cover_id,
      cover.width AS cover_width,
      cover.height AS cover_height
    FROM products AS product
    LEFT JOIN LATERAL (
      SELECT
        min(variant.sale_price) AS min_sale_price,
        max(variant.sale_price) AS max_sale_price,
        count(*)::integer AS public_variant_count,
        count(*) FILTER (
          WHERE variant.inventory_mode = 'quantity'
            AND COALESCE(inventory.stocked - inventory.reserved, 0) > 0
        )::integer AS in_stock_variant_count,
        count(*) FILTER (WHERE variant.inventory_mode = 'quantity')::integer AS quantity_variant_count
      FROM public_variants AS variant
      LEFT JOIN product_variant_quantity_inventory AS inventory
        ON inventory.product_id = variant.product_id
        AND inventory.product_variant_id = variant.id
      WHERE variant.product_id = product.id
    ) AS catalog ON TRUE
    LEFT JOIN LATERAL (
      SELECT reference.media_id, image.width, image.height
      FROM product_media_references AS reference
      INNER JOIN product_media_variants AS image
        ON image.media_id = reference.media_id AND image.variant = 'card'
      WHERE reference.product_id = product.id AND reference.source = 'gallery'
      ORDER BY reference.sort_order, reference.media_id
      LIMIT 1
    ) AS cover ON TRUE
    ${where}
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${offset}
  `.execute(db)

  const items: PublicProductCard[] = rows.rows.map((row) => {
    if ((row.min_sale_price === null) !== (row.max_sale_price === null)) {
      throw new Error('Public product list encountered an incomplete price range')
    }
    const priceRange = row.min_sale_price === null || row.max_sale_price === null
      ? null
      : { min: formatSalePrice(row.min_sale_price), max: formatSalePrice(row.max_sale_price), currency: 'CNY' as const }
    const inventoryStatus = row.public_variant_count === 0
      ? 'not_applicable'
      : row.in_stock_variant_count > 0
        ? 'in_stock'
        : row.quantity_variant_count === row.public_variant_count
          ? 'out_of_stock'
          : 'unconfirmed'
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      productType: row.product_type,
      cover: row.cover_id && row.cover_width && row.cover_height
        ? {
            url: productMediaUrl(row.cover_id, 'card'),
            width: row.cover_width,
            height: row.cover_height,
            alt: row.name,
          }
        : null,
      priceRange,
      selectionStatus: row.public_variant_count > 0 ? 'available' : 'none',
      inventoryStatus,
    }
  })
  return responsePage(items, totalResult.rows[0]?.total ?? 0, page, pageSize)
}

async function loadPublicVariants(db: KyselyDatabase<Database>, productId: string) {
  const rows = await sql<PublicVariantRow>`
    SELECT
      variant.id,
      variant.sale_price::text AS sale_price,
      variant.compare_at_price::text AS compare_at_price,
      variant.inventory_mode,
      CASE WHEN variant.inventory_mode = 'quantity'
        THEN COALESCE(inventory.stocked - inventory.reserved, 0)::integer
        ELSE NULL
      END AS available_quantity
    FROM product_variants AS variant
    LEFT JOIN product_variant_quantity_inventory AS inventory
      ON inventory.product_id = variant.product_id
      AND inventory.product_variant_id = variant.id
    WHERE variant.product_id = ${productId}::uuid
      AND TRUE ${publicVariantEligibility('variant')}
    ORDER BY variant.created_at, variant.id
  `.execute(db)

  const ids = rows.rows.map((row) => row.id)
  const optionRows = ids.length === 0 ? [] : await db.selectFrom('product_variant_option_values as relation')
    .innerJoin('product_option_groups as optionGroup', (join) => join
      .onRef('optionGroup.id', '=', 'relation.option_group_id')
      .onRef('optionGroup.product_id', '=', 'relation.product_id'))
    .innerJoin('product_option_values as optionValue', (join) => join
      .onRef('optionValue.id', '=', 'relation.option_value_id')
      .onRef('optionValue.option_group_id', '=', 'relation.option_group_id')
      .onRef('optionValue.product_id', '=', 'relation.product_id'))
    .select([
      'relation.product_variant_id', 'optionGroup.id as group_id', 'optionValue.id as value_id',
      'optionGroup.sort_order as group_sort_order', 'optionGroup.id as group_tie_breaker',
    ])
    .where('relation.product_id', '=', productId)
    .where('relation.product_variant_id', 'in', ids)
    .orderBy('optionGroup.sort_order').orderBy('optionGroup.id').orderBy('optionValue.sort_order').orderBy('optionValue.id')
    .execute()

  const optionsByVariant = new Map<string, Array<{ groupId: string; valueId: string }>>()
  for (const row of optionRows) {
    const options = optionsByVariant.get(row.product_variant_id) ?? []
    options.push({ groupId: row.group_id, valueId: row.value_id })
    optionsByVariant.set(row.product_variant_id, options)
  }

  return rows.rows.map((row) => ({
    skuId: row.id,
    options: optionsByVariant.get(row.id) ?? [],
    salePrice: formatSalePrice(row.sale_price),
    compareAtPrice: row.compare_at_price === null ? null : formatSalePrice(row.compare_at_price),
    inventory: inventorySummary(row.inventory_mode, row.available_quantity),
  }))
}

function inventorySummary(mode: ProductInventoryMode | null, available: number | null): PublicInventorySummary {
  if (mode === 'quantity') return { mode, status: (available ?? 0) > 0 ? 'in_stock' : 'out_of_stock' }
  if (mode === 'resource_pool' || mode === 'external') return { mode, status: 'not_ready' }
  if (mode === 'unlimited') return { mode, status: 'unlimited' }
  return { mode: null, status: 'not_configured' }
}

async function loadPublicOptionGroups(db: KyselyDatabase<Database>, productId: string) {
  const rows = await sql<PublicOptionRow>`
    SELECT
      option_group.id AS group_id,
      option_group.name AS group_name,
      option_group.sort_order AS group_sort_order,
      option_value.id AS value_id,
      option_value.name AS value_name,
      option_value.sort_order AS value_sort_order,
      CASE WHEN option_value.id IS NULL THEN NULL ELSE EXISTS (
        SELECT 1
        FROM product_variant_option_values AS selected
        INNER JOIN product_variants AS variant
          ON variant.id = selected.product_variant_id AND variant.product_id = selected.product_id
        WHERE selected.product_id = option_group.product_id
          AND selected.option_group_id = option_group.id
          AND selected.option_value_id = option_value.id
          AND TRUE ${publicVariantEligibility('variant')}
      ) END AS available
    FROM product_option_groups AS option_group
    LEFT JOIN product_option_values AS option_value
      ON option_value.product_id = option_group.product_id
      AND option_value.option_group_id = option_group.id
      AND option_value.enabled
      AND EXISTS (
        SELECT 1
        FROM product_variant_option_values AS retained
        INNER JOIN product_variants AS existing_variant
          ON existing_variant.id = retained.product_variant_id
          AND existing_variant.product_id = retained.product_id
        WHERE retained.product_id = option_group.product_id
          AND retained.option_group_id = option_group.id
          AND retained.option_value_id = option_value.id
          AND existing_variant.retired_at IS NULL
      )
    WHERE option_group.product_id = ${productId}::uuid AND option_group.enabled
    ORDER BY option_group.sort_order, option_group.id, option_value.sort_order, option_value.id
  `.execute(db)

  const groups = new Map<string, {
    id: string
    name: string
    sortOrder: number
    values: Array<{ id: string; name: string; sortOrder: number; available: boolean }>
  }>()
  for (const row of rows.rows) {
    let group = groups.get(row.group_id)
    if (!group) {
      group = { id: row.group_id, name: row.group_name, sortOrder: row.group_sort_order, values: [] }
      groups.set(group.id, group)
    }
    if (row.value_id && row.value_name !== null && row.value_sort_order !== null) {
      group.values.push({
        id: row.value_id,
        name: row.value_name,
        sortOrder: row.value_sort_order,
        available: row.available ?? false,
      })
    }
  }
  return [...groups.values()]
}

function publicPriceRange(variants: Awaited<ReturnType<typeof loadPublicVariants>>) {
  if (variants.length === 0) return null
  let minimum = parseUnitAmount(variants[0]!.salePrice)
  let maximum = minimum
  for (const variant of variants.slice(1)) {
    const amount = parseUnitAmount(variant.salePrice)
    if (amount.lessThan(minimum)) minimum = amount
    if (amount.greaterThan(maximum)) maximum = amount
  }
  return { min: minimum.toFixed(2), max: maximum.toFixed(2), currency: 'CNY' as const }
}

async function loadPublicProductDetail(
  db: KyselyDatabase<Database>,
  productId: string,
): Promise<PublicProductDetail | undefined> {
  return db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
    const product = await trx.selectFrom('products')
      .select(['id', 'name', 'description', 'product_type', 'rich_content', 'updated_at'])
      .where('id', '=', productId)
      .where('status', '=', 'active')
      .executeTakeFirst()
    if (!product) return undefined

    const [gallery, categories, optionGroups, variants, attributes, visibleCategories] = await Promise.all([
      trx.selectFrom('product_media_references as reference')
        .innerJoin('product_media as media', 'media.id', 'reference.media_id')
        .innerJoin('product_media_variants as image', (join) => join
          .onRef('image.media_id', '=', 'media.id').on('image.variant', '=', 'detail'))
        .select(['media.id', 'image.width', 'image.height', 'reference.sort_order'])
        .where('reference.product_id', '=', productId)
        .where('reference.source', '=', 'gallery')
        .orderBy('reference.sort_order').orderBy('media.id')
        .execute(),
      trx.selectFrom('product_category_assignments as assignment')
        .select(['assignment.category_id', 'assignment.is_primary', 'assignment.sort_order'])
        .where('assignment.product_id', '=', productId)
        .orderBy('assignment.is_primary', 'desc').orderBy('assignment.sort_order').orderBy('assignment.category_id')
        .execute(),
      loadPublicOptionGroups(trx, productId),
      loadPublicVariants(trx, productId),
      trx.selectFrom('product_attributes').select(['id', 'name', 'value', 'sort_order', 'created_at', 'updated_at'])
        .where('product_id', '=', productId).orderBy('sort_order').orderBy('id').execute(),
      loadVisibleCategories(trx),
    ])

    if (gallery.length > 20) throw new Error('The public product gallery exceeds its database-enforced limit')
    const visibleById = new Map(visibleCategories.map((category) => [category.id, category]))
    const publicCategories = categories.flatMap((assignment) => {
      const category = visibleById.get(assignment.category_id)
      return category ? [{
        id: category.id,
        name: category.name,
        path: category.path,
        isPrimary: assignment.is_primary,
        sortOrder: assignment.sort_order,
      }] : []
    })

    return {
      id: product.id,
      name: product.name,
      description: product.description,
      productType: product.product_type,
      priceRange: publicPriceRange(variants),
      selectionStatus: variants.length > 0 ? 'available' : 'none',
      gallery: gallery.map((image) => ({
        url: productMediaUrl(image.id, 'detail'),
      thumbnailUrl: productMediaUrl(image.id, 'thumbnail'),
        width: image.width,
        height: image.height,
        alt: product.name,
      })),
      richContentHtml: productRichContentToSafeHtml(product.rich_content),
      categories: publicCategories,
      optionGroups,
      variants,
      attributes: attributes.map((attribute) => ({ name: attribute.name, value: attribute.value })),
    }
  })
}

async function queryPublicSitemap(
  db: KyselyDatabase<Database>,
  query: PublicSitemapQuery,
): Promise<PublicSitemapResponse> {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 50_000
  const offset = (page - 1) * pageSize
  const count = await sql<{ total: number }>`
    WITH RECURSIVE visible_categories AS (
      SELECT category.id, category.parent_id, 0::integer AS level
      FROM product_categories AS category
      WHERE category.parent_id IS NULL AND category.is_visible
      UNION ALL
      SELECT child.id, child.parent_id, parent.level + 1
      FROM product_categories AS child
      INNER JOIN visible_categories AS parent ON parent.id = child.parent_id
      WHERE child.is_visible AND parent.level < 3
    )
    SELECT (
      (SELECT count(*) FROM products WHERE status = 'active')
      + (SELECT count(*) FROM visible_categories)
    )::integer AS total
  `.execute(db)
  const result = await sql<{
    type: 'product' | 'category'
    id: string
    last_modified: Date
  }>`
    WITH RECURSIVE visible_categories AS (
      SELECT category.id, category.parent_id, category.updated_at, 0::integer AS level
      FROM product_categories AS category
      WHERE category.parent_id IS NULL AND category.is_visible
      UNION ALL
      SELECT child.id, child.parent_id, child.updated_at, parent.level + 1
      FROM product_categories AS child
      INNER JOIN visible_categories AS parent ON parent.id = child.parent_id
      WHERE child.is_visible AND parent.level < 3
    ), public_urls AS (
      SELECT 'product'::text AS type, product.id, product.updated_at AS last_modified
      FROM products AS product WHERE product.status = 'active'
      UNION ALL
      SELECT 'category'::text AS type, category.id, category.updated_at AS last_modified
      FROM visible_categories AS category
    )
    SELECT type, id, last_modified FROM public_urls
    ORDER BY type, id
    LIMIT ${pageSize} OFFSET ${offset}
  `.execute(db)
  const total = count.rows[0]?.total ?? 0
  const items: PublicSitemapItem[] = result.rows.map((row) => ({
    type: row.type,
    id: row.id,
    lastModified: row.last_modified.toISOString(),
  }))
  return { ...responsePage(items, total, page, pageSize), pageSize }
}

function notFound(reply: FastifyReply, requestId: string) {
  return reply.code(404).send(failure('NOT_FOUND', 'The requested public resource does not exist', requestId))
}

function invalidSearch(reply: FastifyReply, requestId: string) {
  return reply.code(400).send(failure('INVALID_SEARCH_QUERY', 'Enter a search term with visible characters', requestId))
}

export function registerPublicProductRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get('/api/v1/public/products', {
    schema: {
      tags: ['public-catalog'],
      summary: 'List currently public products',
      querystring: PublicProductListQuerySchema,
      response: { 200: ApiSuccessSchemaOf(PublicProductPageSchema), 400: ApiErrorSchema, 500: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const query = request.query as PublicProductQuery
    const result = await db.transaction().setIsolationLevel('repeatable read').execute(async (trx) =>
      queryProductPage(trx, query))
    return reply.header('cache-control', 'no-store').send(success(result, request.id))
  })

  app.get('/api/v1/public/categories', {
    schema: {
      tags: ['public-catalog'],
      summary: 'List the visible public category tree',
      response: { 200: ApiSuccessSchemaOf(PublicCategoriesResponseSchema), 500: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const categories = await db.transaction().setIsolationLevel('repeatable read').execute(loadVisibleCategories)
    const response: PublicCategoriesResponse = { categories }
    return reply.header('cache-control', 'no-store').send(success(response, request.id))
  })

  app.get('/api/v1/public/categories/:id/products', {
    schema: {
      tags: ['public-catalog'],
      summary: 'List public products assigned to a visible category or its visible descendants',
      params: ProductIdParamsSchema,
      querystring: PublicProductListQuerySchema,
      response: {
        200: ApiSuccessSchemaOf(PublicCategoryProductsResponseSchema),
        400: ApiErrorSchema, 404: ApiErrorSchema, 500: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = request.query as PublicProductQuery
    const result = await db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
      const categories = await loadVisibleCategories(trx)
      const category = categories.find((item) => item.id === id)
      if (!category) return undefined
      const categoryIds = categoryPathIds(categories, id)
      const products = await queryProductPage(trx, { ...query, categoryId: id }, categoryIds)
      const children = categories.filter((item) => item.parentId === id)
      return {
        category,
        breadcrumbs: category.path,
        children,
        products,
      } satisfies PublicCategoryProductsResponse
    })
    if (!result) return notFound(reply, request.id)
    return reply.header('cache-control', 'no-store').send(success(result, request.id))
  })

  app.get('/api/v1/public/search', {
    schema: {
      tags: ['public-catalog'],
      summary: 'Search currently public products',
      querystring: PublicProductSearchQuerySchema,
      response: {
        200: ApiSuccessSchemaOf(PublicProductPageSchema),
        400: ApiErrorSchema, 404: ApiErrorSchema, 500: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const query = request.query as PublicProductQuery
    if (query.q !== undefined && !query.q.trim()) return invalidSearch(reply, request.id)
    const result = await db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
      if (!query.categoryId) return queryProductPage(trx, query)
      const categories = await loadVisibleCategories(trx)
      const category = categories.find((item) => item.id === query.categoryId)
      if (!category) return undefined
      return queryProductPage(trx, query, categoryPathIds(categories, category.id))
    })
    if (!result) return notFound(reply, request.id)
    return reply.header('cache-control', 'no-store').send(success(result, request.id))
  })

  app.get('/api/v1/public/products/:id', {
    schema: {
      tags: ['public-catalog'],
      summary: 'Read a currently public product by stable ID',
      params: ProductIdParamsSchema,
      response: {
        200: ApiSuccessSchemaOf(PublicProductDetailSchema),
        400: ApiErrorSchema, 404: ApiErrorSchema, 500: ApiErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const product = await loadPublicProductDetail(db, id)
    if (!product) return notFound(reply, request.id)
    return reply.header('cache-control', 'no-store').send(success(product, request.id))
  })

  app.get('/api/v1/public/sitemap', {
    schema: {
      tags: ['public-catalog'],
      summary: 'List only currently public product and visible category sitemap entries',
      querystring: PublicSitemapQuerySchema,
      response: { 200: ApiSuccessSchemaOf(PublicSitemapResponseSchema), 400: ApiErrorSchema, 500: ApiErrorSchema },
    },
  }, async (request, reply) => {
    const query = request.query as PublicSitemapQuery
    const result = await db.transaction().setIsolationLevel('repeatable read').execute((trx) =>
      queryPublicSitemap(trx, query))
    return reply.header('cache-control', 'no-store').send(success(result, request.id))
  })
}
