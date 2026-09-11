import { describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src'
import { FakeRedis } from './helpers/FakeRedis'

const namespace = (name: string) => `adaptive-cache-backend-${name}-${Date.now()}-${Math.random()}`

describe('AdaptiveCache backend integration', () => {
  it('should support custom backends and reject Redis client access for non-Redis backends', async () => {
    const backend = {
      name: 'custom' as const,
      fetch: vi.fn(async () => null),
      update: vi.fn(async () => ['CACHED', 1] as any),
      clear: vi.fn(async () => undefined),
      invalidateTags: vi.fn(async () => []),
      shouldRefresh: vi.fn(async () => ['UPDATE', 'lock'] as any),
      releaseLock: vi.fn(async () => ['UPDATED'] as any),
      flush: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
    }
    const cache = new AdaptiveCache({ backend })

    await cache.set('custom-key', { ok: true })
    expect(await cache.get('custom-key')).toBeNull()
    await cache.invalidateTags(['tag'])
    await cache.clear('custom-key')
    expect((await cache.shouldRefresh('refresh', 1))[0]).toBe('UPDATE')
    expect((await cache.shouldRefresh('refresh-explicit', 1, false, 5))[0]).toBe('UPDATE')
    expect(await cache.releaseLock('refresh', 'lock')).toEqual(['UPDATED'])
    await cache.flush()
    await cache.quit()

    expect(() => cache.client).toThrow('not using a Redis-backed backend')
    expect(backend.update).toHaveBeenCalled()
    expect(backend.flush).toHaveBeenCalled()

    const ttlBackend = {
      ...backend,
      update: vi.fn(async () => ['CACHED', 1] as any),
    }
    const ttlCache = new AdaptiveCache({ backend: ttlBackend, maxTTL: (data) => (data.ok ? 42 : undefined) })
    await ttlCache.set('custom-ttl-key', { ok: true })
    await ttlCache.set('custom-default-ttl-key', { ok: false })
    expect(ttlBackend.update).toHaveBeenCalledWith(expect.objectContaining({ maxTTL: 42 }))
    expect(ttlBackend.update).toHaveBeenCalledWith(expect.objectContaining({ maxTTL: 900 }))
  })

  it('should surface backend fetch decode errors and update errors', async () => {
    const badFetchBackend = {
      name: 'custom' as const,
      fetch: vi.fn(async () => ({ encodedData: 'not-json', ttl: 1 })),
      update: vi.fn(async () => ['CACHED', 1] as any),
      clear: vi.fn(async () => undefined),
      invalidateTags: vi.fn(async () => []),
      shouldRefresh: vi.fn(async () => ['UPDATE', 'lock'] as any),
      releaseLock: vi.fn(async () => ['UPDATED'] as any),
    }
    const badFetchCache = new AdaptiveCache({ backend: badFetchBackend, compress: false })

    await expect(badFetchCache.get('bad-json')).resolves.toEqual({ ttl: 1, data: 'not-json' })

    const badUpdateBackend = {
      ...badFetchBackend,
      fetch: vi.fn(async () => null),
      update: vi.fn(async () => {
        throw new Error('update failed')
      }),
    }
    const badUpdateCache = new AdaptiveCache({ backend: badUpdateBackend })

    await expect(badUpdateCache.set('bad-update', { ok: true })).rejects.toThrow('update failed')
  })

  it('should use fake Redis through AdaptiveCache l1-redis mode', async () => {
    const redis = new FakeRedis()
    const cache = new AdaptiveCache(
      {
        backend: 'l1-redis',
        initialTTL: 2,
        includeDebugHeaders: true,
        lru: { namespace: namespace('adaptive-l1'), maxSizeBytes: 1024 * 1024 },
      },
      redis as any,
    )

    await cache.set('adaptive-l1-key', { ok: true })
    const immediate = await cache.get('adaptive-l1-key')

    expect(immediate?.data).toEqual({ ok: true })
    expect(Number(immediate?.metadata.dataTTL)).toBe(2)
    await cache.quit()
  })
})
