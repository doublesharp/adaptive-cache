import { describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'

describe('Redis initialization cleanup', () => {
  it.each([false, true])('disconnects only owned Redis clients when backend initialization throws: %s', (injected) => {
    const failure = new Error('Lua command initialization failed')
    const client = {
      defineCommand: vi.fn(() => {
        throw failure
      }),
      disconnect: vi.fn(),
    }
    vi.spyOn(RedisAdaptiveCacheBackend, 'createClient').mockReturnValue(client as any)
    try {
      expect(() => new AdaptiveCache({ logLevel: 'silent' }, injected ? (client as any) : undefined)).toThrow(failure)
      expect(client.disconnect).toHaveBeenCalledTimes(injected ? 0 : 1)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
