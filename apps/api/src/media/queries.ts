import type { Kysely } from 'kysely'
import type {
  ProductGalleryImage,
  ProductMediaMetadata,
  ProductMediaVariant,
  ProductMediaVariantMetadata,
} from '@aikayun/contracts'
import type { Database, ProductMediaVariantName } from '../db/types.js'
import { CatalogError } from '../catalog/errors.js'

export function productMediaUrl(mediaId: string, variant: ProductMediaVariantName): string {
  return `/api/v1/media/${mediaId}/${variant}.webp`
}

function variantOrder(variant: ProductMediaVariantName): number {
  return variant === 'thumbnail' ? 0 : variant === 'card' ? 1 : 2
}

export async function loadProductMediaMetadata(
  db: Kysely<Database>,
  mediaId: string,
): Promise<ProductMediaMetadata | undefined> {
  const media = await db.selectFrom('product_media').selectAll().where('id', '=', mediaId).executeTakeFirst()
  if (!media) return undefined
  const variants = await db.selectFrom('product_media_variants').selectAll()
    .where('media_id', '=', mediaId).execute()
  if (variants.length !== 3) throw new Error('Persisted media is missing one or more required image variants')
  variants.sort((left, right) => variantOrder(left.variant) - variantOrder(right.variant))
  return {
    id: media.id,
    createdAt: media.created_at.toISOString(),
    variants: variants.map((variant): ProductMediaVariantMetadata => ({
      variant: variant.variant as ProductMediaVariant,
      url: productMediaUrl(media.id, variant.variant),
      contentType: 'image/webp',
      width: variant.width,
      height: variant.height,
      sizeBytes: variant.size_bytes,
      sha256: variant.sha256.trim(),
      processingVersion: variant.processing_version,
    })),
  }
}

export async function loadProductGallery(
  db: Kysely<Database>,
  productId: string,
): Promise<ProductGalleryImage[]> {
  const rows = await db.selectFrom('product_media_references as reference')
    .innerJoin('product_media as media', 'media.id', 'reference.media_id')
    .select(['media.id as id', 'media.created_at', 'reference.sort_order'])
    .where('reference.product_id', '=', productId)
    .where('reference.source', '=', 'gallery')
    .orderBy('reference.sort_order').orderBy('media.id')
    .execute()
  if (rows.length > 20) throw new Error('Persisted product gallery exceeds its database-enforced limit')
  if (rows.length === 0) return []

  const mediaIds = rows.map((row) => row.id)
  const variants = await db.selectFrom('product_media_variants').select(['media_id', 'variant', 'width', 'height'])
    .where('media_id', 'in', mediaIds).execute()
  const variantsByMedia = new Map<string, Map<ProductMediaVariantName, { width: number; height: number }>>()
  for (const variant of variants) {
    const found = variantsByMedia.get(variant.media_id) ?? new Map<ProductMediaVariantName, { width: number; height: number }>()
    found.set(variant.variant, { width: variant.width, height: variant.height })
    variantsByMedia.set(variant.media_id, found)
  }
  for (const id of mediaIds) {
    if (variantsByMedia.get(id)?.size !== 3) {
      throw new CatalogError(503, 'MEDIA_VARIANT_UNAVAILABLE', 'A product image is not fully available')
    }
  }

  return rows.map((row, index) => ({
    id: row.id,
    sortOrder: row.sort_order ?? index,
    width: variantsByMedia.get(row.id)!.get('detail')!.width,
    height: variantsByMedia.get(row.id)!.get('detail')!.height,
    thumbnailUrl: productMediaUrl(row.id, 'thumbnail'),
    cardUrl: productMediaUrl(row.id, 'card'),
    detailUrl: productMediaUrl(row.id, 'detail'),
    createdAt: row.created_at.toISOString(),
  }))
}
