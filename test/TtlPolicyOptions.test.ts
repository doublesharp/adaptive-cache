import { afterEach, describe, expect, it } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import type { AdaptiveCacheBackend, AdaptiveCacheBackendUpdateInput, AdaptiveCacheOptions } from '../src/types'

const caches: AdaptiveCache[] = []
afterEach(async () => {
  await Promise.all(caches.splice(0).map((cache) => cache.close()))
})
const recorder = (supportsTtlPolicies?: boolean) => {
  const writes: AdaptiveCacheBackendUpdateInput[] = []
  const backend: AdaptiveCacheBackend = {
    name: 'custom',
    supportsTtlPolicies,
    fetch: async () => null,
    update: async (input) => {
      writes.push(input)
      return ['CACHED', input.initialTTL]
    },
    clear: async () => {},
    invalidateTags: async () => [],
    shouldRefresh: async () => ['UPDATE', 'owner'],
    releaseLock: async () => ['UPDATED'],
  }
  return { backend, writes }
}

describe('TTL policy configuration', () => {
  it.each([
    null,
    'ewma',
    { type: 'unknown' },
    { type: 'aimd', increaseSeconds: null },
    { type: 'aimd', decreaseFactor: null },
    { type: 'ewma', halfLifeSeconds: null },
    { type: 'ewma', targetChangeProbability: null },
    { type: 'aimd', increaseSeconds: 0 },
    { type: 'aimd', increaseSeconds: Infinity },
    { type: 'aimd', decreaseFactor: 0 },
    { type: 'aimd', decreaseFactor: 1 },
    { type: 'aimd', decreaseFactor: NaN },
    { type: 'ewma', halfLifeSeconds: 0 },
    { type: 'ewma', halfLifeSeconds: Infinity },
    { type: 'ewma', targetChangeProbability: 0 },
    { type: 'ewma', targetChangeProbability: 1 },
    { type: 'ewma', targetChangeProbability: NaN },
  ])('rejects invalid policy %j at construction', (ttlPolicy) => {
    expect(() => new AdaptiveCache({ backend: 'clustered-lru', ttlPolicy } as AdaptiveCacheOptions)).toThrow(
      /ttlPolicy/,
    )
  })

  it.each([
    { initialTTL: 5, ttlPolicy: { type: 'ewma', targetChangeProbability: Number.MIN_VALUE } },
    { initialTTL: Number.MIN_VALUE, ttlPolicy: { type: 'ewma' } },
  ])('rejects an unrepresentable initial EWMA rate %j', (options) => {
    const { backend, writes } = recorder(true)
    expect(() => new AdaptiveCache({ backend, ...options } as AdaptiveCacheOptions)).toThrow(/EWMA rate/)
    expect(writes).toHaveLength(0)
  })

  it('rejects an unrepresentable EWMA rate caused by a per-write cap before updating the backend', async () => {
    const { backend, writes } = recorder(true)
    const cache = new AdaptiveCache({ backend, ttlPolicy: { type: 'ewma' }, logLevel: 'silent' })
    caches.push(cache)
    await expect(cache.set('value', 1, { maxTTL: Number.MIN_VALUE })).rejects.toThrow(/EWMA rate/)
    expect(writes).toHaveLength(0)
  })

  it.each(['aimd', 'ewma'] as const)('rejects %s on custom backends that do not declare support', (type) => {
    const { backend } = recorder()
    expect(() => new AdaptiveCache({ backend, ttlPolicy: { type } })).toThrow(/TTL polic/)
  })

  it('retains default adaptive behavior for existing custom backends', async () => {
    const { backend, writes } = recorder()
    for (const options of [{}, { ttlPolicy: { type: 'adaptive' as const } }]) {
      const cache = new AdaptiveCache({ backend, ...options })
      caches.push(cache)
      await cache.set('value', 1)
    }
    expect(writes).toHaveLength(2)
    expect(writes[0]).toEqual(writes[1])
    expect(writes[0].ttlPolicy).toBeUndefined()
  })

  it.each([
    [{ type: 'aimd' }, { type: 'aimd', increaseSeconds: 5, decreaseFactor: 0.5 }],
    [{ type: 'ewma' }, { type: 'ewma', halfLifeSeconds: 300, targetChangeProbability: 0.1 }],
    [
      { type: 'aimd', increaseSeconds: 3, decreaseFactor: 0.25 },
      { type: 'aimd', increaseSeconds: 3, decreaseFactor: 0.25 },
    ],
    [
      { type: 'ewma', halfLifeSeconds: 60, targetChangeProbability: 0.2 },
      { type: 'ewma', halfLifeSeconds: 60, targetChangeProbability: 0.2 },
    ],
  ])('passes normalized policy %j to capable backends', async (ttlPolicy, expected) => {
    const { backend, writes } = recorder(true)
    const cache = new AdaptiveCache({ backend, ttlPolicy } as AdaptiveCacheOptions)
    caches.push(cache)
    await cache.set('value', 1, { maxTTL: 2 })
    expect(writes[0]).toMatchObject({ ttlPolicy: expected, initialTTL: 2, maxTTL: 2 })
  })
})
