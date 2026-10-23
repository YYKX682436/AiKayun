import { describe, expect, it, vi } from 'vitest'
import { readConfig } from '../src/config.js'
import { isPublicAddress, resolvePinnedAddress } from '../src/commerce/http-json-v1.js'

describe('⑤-5 supplier network boundary', () => {
  it('rejects internal, mapped, translated, benchmark and documentation IPv4/IPv6 addresses', () => {
    for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.255.255.254', '169.254.169.254',
      '172.16.0.1', '192.168.1.1', '198.18.0.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
      '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', 'fc00::1', 'fd12::1', 'fe80::1',
      'ff02::1', '2001:db8::1', '2001:2::1', '2002:7f00:1::', '3fff::1', '3fff:fff:ffff::1', '5f00::1']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('bounds DNS resolution and checks every answer on every subsequent request', async () => {
    const config = readConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000' })
    vi.useFakeTimers()
    try {
      const lookup = resolvePinnedAddress(new URL('https://supplier.example'), config, async () => new Promise(() => {}))
      const rejected = expect(lookup).rejects.toMatchObject({ classification: 'transport_unknown', code: 'supplier_dns_timeout' })
      await vi.advanceTimersByTimeAsync(8000)
      await rejected
    } finally { vi.useRealTimers() }
    let calls = 0
    const resolve = async () => ++calls === 1 ? [{ address: '8.8.8.8', family: 4 as const }]
      : [{ address: '8.8.8.8', family: 4 as const }, { address: '::ffff:127.0.0.1', family: 6 as const }]
    expect(await resolvePinnedAddress(new URL('https://supplier.example'), config, resolve)).toMatchObject({ address: '8.8.8.8' })
    await expect(resolvePinnedAddress(new URL('https://supplier.example'), config, resolve)).rejects.toMatchObject({ code: 'supplier_address_not_public' })
    expect(calls).toBe(2)
  })
})
