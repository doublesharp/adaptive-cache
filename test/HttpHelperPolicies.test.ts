import { describe, expect, it } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { ControlledBackend } from './helpers/httpFixtures'

describe('HTTP integration timeout policy', () => {
  it('resolves load deadline overrides, injected cache settings, and the module default', async () => {
    const cache = new AdaptiveCache({ backend: new ControlledBackend(), loadTimeoutMs: 25 })
    expect(cache.resolveLoadTimeoutMs()).toBe(25)
    expect(cache.resolveLoadTimeoutMs({ loadTimeoutMs: 12 })).toBe(12)
    expect(cache.resolveLoadTimeoutMs({ loadTimeoutMs: 0 })).toBe(0)
    expect(() => cache.resolveLoadTimeoutMs({ loadTimeoutMs: -1 })).toThrow(RangeError)
    expect(() => cache.resolveLoadTimeoutMs({ loadTimeoutMs: Number.NaN })).toThrow(RangeError)
    const defaults = new AdaptiveCache({ backend: new ControlledBackend() })
    expect(defaults.resolveLoadTimeoutMs()).toBe(AdaptiveCache.DEFAULT_LOAD_TIMEOUT_MS)
    await Promise.all([cache.close(), defaults.close()])
  })
})
