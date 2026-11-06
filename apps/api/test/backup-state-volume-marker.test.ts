import { describe, expect, it } from 'vitest'
import { isValidStateVolumeMarker } from '../src/backup/state-volume-marker.js'

describe('state volume marker', () => {
  it('accepts the initializer bytes and the prior newline-free form', () => {
    expect(isValidStateVolumeMarker(Buffer.from('aikayun-state-volume-v1\n'))).toBe(true)
    expect(isValidStateVolumeMarker(Buffer.from('aikayun-state-volume-v1'))).toBe(true)
  })

  it('rejects extra bytes and alternate line endings', () => {
    expect(isValidStateVolumeMarker(Buffer.from('aikayun-state-volume-v1\n\n'))).toBe(false)
    expect(isValidStateVolumeMarker(Buffer.from('aikayun-state-volume-v1\r\n'))).toBe(false)
    expect(isValidStateVolumeMarker(Buffer.from('aikayun-state-volume-v2\n'))).toBe(false)
  })
})
