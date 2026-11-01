import { describe, expect, it } from 'vitest'
import { renewalDueAt, renewalRetryAt } from '../src/licensing/license-renewal-worker.js'

describe('license renewal scheduling', () => {
  it('uses stable jitter within ten percent of the signed interval and never exceeds lease expiry', () => {
    const issuedAt = 1_000_000
    const renewAfter = issuedAt + 6 * 60 * 60_000
    for (let i = 0; i < 100; i++) {
      const input = { issuedAt, renewAfter, expiresAt: renewAfter + 10 * 60_000, credentialId: `lease-${i}` }
      const due = renewalDueAt(input)
      expect(due).toBe(renewalDueAt(input))
      expect(due).toBeGreaterThanOrEqual(renewAfter - 36 * 60_000)
      expect(due).toBeLessThanOrEqual(input.expiresAt - 60_000)
    }
  })

  it('reserves one poll interval near expiry and schedules a very short lease at issuance', () => {
    const issuedAt = 1_000_000
    const nearExpiry = { issuedAt, renewAfter: issuedAt + 6 * 60 * 60_000,
      expiresAt: issuedAt + 6 * 60 * 60_000, credentialId: 'near-expiry' }
    expect(renewalDueAt(nearExpiry)).toBeLessThanOrEqual(nearExpiry.expiresAt - 60_000)
    const shortLease = { issuedAt, renewAfter: issuedAt + 10_000,
      expiresAt: issuedAt + 10_000, credentialId: 'short' }
    expect(renewalDueAt(shortLease)).toBe(issuedAt)
  })

  it('uses bounded, stable, jittered retry delays from persisted attempt time', () => {
    for (let attempt = 1; attempt <= 30; attempt++) {
      const actual = renewalRetryAt(1000, attempt, 'operation') - 1000
      const base = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(attempt - 1, 6))
      expect(actual).toBeGreaterThanOrEqual(base * 0.9 - 1)
      expect(actual).toBeLessThanOrEqual(base * 1.1 + 1)
      expect(renewalRetryAt(1000, attempt, 'operation')).toBe(1000 + actual)
    }
  })
})
