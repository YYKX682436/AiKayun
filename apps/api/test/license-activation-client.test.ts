import { describe, expect, it } from 'vitest'
import {
  assertActivationEvidenceFresh,
  LicenseActivationClientError,
} from '../src/licensing/license-activation-client.js'

describe('activation pre-send evidence lifetime', () => {
  const trustedTime = 2_000_000_000
  const nonce = Buffer.alloc(32, 7).toString('base64url')
  const challenge = {
    clientNonce: nonce,
    serverNonce: Buffer.alloc(32, 8).toString('base64url'),
    issuedAt: trustedTime - 10,
    expiresAt: trustedTime + 290,
  }

  it('accepts a fresh Challenge and 60-second HTTP signature together', () => {
    expect(() => assertActivationEvidenceFresh(challenge, trustedTime, trustedTime - 5)).not.toThrow()
  })

  it('stops when the signed Challenge reaches its exclusive expiry', () => {
    expect(() => assertActivationEvidenceFresh({ ...challenge, expiresAt: trustedTime }, trustedTime))
      .toThrowError(expect.objectContaining({ code: 'activation_challenge_expired' }))
  })

  it('stops when the persisted HTTP signature reaches its exclusive expiry', () => {
    expect(() => assertActivationEvidenceFresh(challenge, trustedTime, trustedTime - 60))
      .toThrowError(expect.objectContaining({ code: 'activation_signature_expired' }))
  })

  it('rejects non-canonical challenge nonce evidence', () => {
    expect(() => assertActivationEvidenceFresh({ ...challenge, serverNonce: 'bad' }, trustedTime))
      .toThrowError(LicenseActivationClientError)
  })
})
