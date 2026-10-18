import { describe, expect, it } from 'vitest'
import { catalogDatabaseFailure } from '../src/catalog/errors.js'

describe('catalog database error classification', () => {
  it('keeps serialization conflicts recoverable while surfacing deadlocks as server errors', () => {
    expect(catalogDatabaseFailure({ code: '40001' })).toMatchObject({
      status: 409,
      code: 'CATALOG_CONCURRENT_MODIFICATION',
    })
    expect(catalogDatabaseFailure({ code: '40P01' })).toBeUndefined()
  })
})
