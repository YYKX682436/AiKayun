import { describe, expect, it, vi } from 'vitest'
import { boundedCachedRead } from '../src/operations/risk.js'

describe('operations polling bounds', () => {
  it('coalesces concurrent callers and briefly caches successful results', async () => {
    let complete!: (value: number) => void
    const load = vi.fn(() => new Promise<number>(resolve => { complete = resolve }))
    const read = boundedCachedRead(load)
    const one = read()
    const two = read()
    expect(load).toHaveBeenCalledTimes(1)
    complete(7)
    expect(await Promise.all([one, two])).toEqual([7, 7])
    expect(await read()).toBe(7)
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('returns a timeout without starting duplicate stuck reads and retries after failure', async () => {
    vi.useFakeTimers()
    try {
      let fail!: (error: Error) => void
      const load = vi.fn(() => new Promise<number>((_, reject) => { fail = reject }))
      const read = boundedCachedRead(load, 30_000, 100)
      const first = read()
      const rejected = expect(first).rejects.toThrow('operations_timeout')
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      const second = read()
      const rejectedAgain = expect(second).rejects.toThrow('operations_timeout')
      await vi.advanceTimersByTimeAsync(100)
      await rejectedAgain
      expect(load).toHaveBeenCalledTimes(1)
      fail(new Error('unavailable'))
      await vi.advanceTimersByTimeAsync(0)
      const third = read()
      expect(load).toHaveBeenCalledTimes(2)
      fail(new Error('unavailable'))
      await expect(third).rejects.toThrow('unavailable')
    } finally { vi.useRealTimers() }
  })
})
