import { describe, expect, it } from 'vitest'
import { isUpgradeProbeOnly } from '../src/ops/upgrade-probe.js'

describe('upgrade probe mode', () => {
  it('disables background workers only for the explicit true value', () => {
    expect(isUpgradeProbeOnly('true')).toBe(true)
    expect(isUpgradeProbeOnly('false')).toBe(false)
  })

  it('fails closed for unsupported values', () => {
    expect(() => isUpgradeProbeOnly('yes')).toThrow('AIKAYUN_UPGRADE_PROBE_ONLY must be true or false')
    expect(() => isUpgradeProbeOnly('')).toThrow('AIKAYUN_UPGRADE_PROBE_ONLY must be true or false')
  })
})
