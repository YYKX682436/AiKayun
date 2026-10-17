import {
  ProductRichContentValidationError,
  validateProductRichContent as validateSharedProductRichContent,
} from '@aikayun/contracts'
import type { ValidatedProductRichContent } from '@aikayun/contracts'
import { CatalogError } from '../catalog/errors.js'

export {
  EMPTY_PRODUCT_RICH_CONTENT,
  MAX_RICH_CONTENT_BYTES,
  MAX_RICH_CONTENT_DEPTH,
  MAX_RICH_CONTENT_IMAGES,
  MAX_RICH_CONTENT_NODES,
  MAX_RICH_CONTENT_TEXT,
  productRichContentToSafeHtml,
} from '@aikayun/contracts'
export type { ValidatedProductRichContent } from '@aikayun/contracts'

/** Maps the shared contract validator into the API's standard error envelope. */
export function validateProductRichContent(value: unknown): ValidatedProductRichContent {
  try {
    return validateSharedProductRichContent(value)
  } catch (error) {
    if (error instanceof ProductRichContentValidationError) {
      throw new CatalogError(400, 'INVALID_PRODUCT_RICH_CONTENT', error.message)
    }
    throw error
  }
}
