import type Redis from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import { registerRedisCacheSuite, waitFor } from './helpers/redisCacheSuite'

let cacheModule: typeof import('../src')
let redisClient: Redis

describe('AdaptiveCache Class & Utils', () => {
  registerRedisCacheSuite((suite) => {
    cacheModule = suite.cacheModule
    redisClient = suite.redisClient
  })

  describe('L1 Redis backend', () => {
    it('should write L1 immediately and reconcile Redis asynchronously', async () => {
      const cache = new cacheModule.AdaptiveCache(
        {
          backend: 'l1-redis',
          initialTTL: 2,
          maxTTL: 20,
          includeDebugHeaders: true,
          lru: {
            namespace: 'adaptive-cache-test-l1-write',
            maxSizeBytes: 1024 * 1024,
          },
        },
        cacheModule.getDefaultCache().client,
      )

      await cache.set('l1-write-key', { val: 1 })

      const immediate = await cache.get('l1-write-key')
      expect(immediate?.data).toEqual({ val: 1 })
      expect(Number(immediate?.metadata.dataTTL)).toBe(2)

      await waitFor(async () => {
        const meta = await redisClient.hgetall('l1-write-keymeta')
        expect(meta.hash).toBeTruthy()
      })

      await cache.quit()
    })

    it('should hydrate L1 after a Redis fallback hit', async () => {
      const redisOnly = new cacheModule.AdaptiveCache({ initialTTL: 10 }, cacheModule.getDefaultCache().client)
      await redisOnly.set('l1-hydrate-key', { val: 1 })

      const cache = new cacheModule.AdaptiveCache(
        {
          backend: 'l1-redis',
          initialTTL: 10,
          lru: {
            namespace: 'adaptive-cache-test-l1-hydrate',
            maxSizeBytes: 1024 * 1024,
          },
        },
        cacheModule.getDefaultCache().client,
      )

      const first = await cache.get('l1-hydrate-key')
      expect(first?.data).toEqual({ val: 1 })

      const fetchSpy = vi.spyOn(cache.client, 'adaptiveCacheFetch')
      const second = await cache.get('l1-hydrate-key')

      expect(second?.data).toEqual({ val: 1 })
      expect(fetchSpy).not.toHaveBeenCalled()

      await cache.quit()
    })

    it('should keep short-lived L1 data when async Redis update fails', async () => {
      const cache = new cacheModule.AdaptiveCache(
        {
          backend: 'l1-redis',
          initialTTL: 2,
          lru: {
            namespace: 'adaptive-cache-test-l1-redis-fail',
            maxSizeBytes: 1024 * 1024,
          },
        },
        cacheModule.getDefaultCache().client,
      )
      vi.spyOn(cache.client, 'adaptiveCacheUpdate').mockRejectedValueOnce(new Error('redis update failed'))

      await cache.set('l1-redis-fail-key', { val: 1 })

      const result = await cache.get('l1-redis-fail-key')
      expect(result?.data).toEqual({ val: 1 })

      await cache.quit()
    })

    it('should publish invalidations across L1 namespaces', async () => {
      const cacheA = new cacheModule.AdaptiveCache(
        {
          backend: 'l1-redis',
          initialTTL: 10,
          lru: {
            namespace: 'adaptive-cache-test-l1-pub-a',
            maxSizeBytes: 1024 * 1024,
          },
        },
        cacheModule.getDefaultCache().client,
      )
      const cacheB = new cacheModule.AdaptiveCache(
        {
          backend: 'l1-redis',
          initialTTL: 10,
          lru: {
            namespace: 'adaptive-cache-test-l1-pub-b',
            maxSizeBytes: 1024 * 1024,
          },
        },
        cacheModule.getDefaultCache().client,
      )

      await cacheA.set('l1-pub-key', { val: 1 })
      await waitFor(async () => {
        const meta = await redisClient.hgetall('l1-pub-keymeta')
        expect(meta.hash).toBeTruthy()
      })

      expect((await cacheB.get('l1-pub-key'))?.data).toEqual({ val: 1 })
      await cacheA.clear('l1-pub-key')

      await waitFor(async () => {
        expect(await cacheB.get('l1-pub-key')).toBeNull()
      })

      await cacheA.quit()
      await cacheB.quit()
    })
  })

  describe('Cache Tags', () => {
    it('should set tags and invalidate them', async () => {
      const cache = new cacheModule.AdaptiveCache()
      const key1 = 'tag-test-1'
      const key2 = 'tag-test-2'
      const tag = 'my-tag'

      await cache.set(key1, { val: 1 }, { tags: [tag] })
      await cache.set(key2, { val: 2 }, { tags: [tag] })

      // Verify keys exist
      const res1 = await cache.get(key1)
      const res2 = await cache.get(key2)
      expect(res1).not.toBeNull()
      expect(res2).not.toBeNull()

      // Verify tag set exists in Redis
      const tagKey = 'adaptive:tag:' + tag
      const members = await redisClient.smembers(tagKey)
      expect(members).toContain(key1)
      expect(members).toContain(key2)
      expect(await redisClient.ttl(tagKey)).toBeGreaterThan(0)

      // Invalidate tag
      await cache.invalidateTags([tag])

      // Verify keys are gone
      const res1After = await cache.get(key1)
      const res2After = await cache.get(key2)
      expect(res1After).toBeNull()
      expect(res2After).toBeNull()
      expect(await redisClient.hgetall(key1 + 'meta')).toEqual({})
      expect(await redisClient.hgetall(key2 + 'meta')).toEqual({})

      // Verify tag set is gone
      const membersAfter = await redisClient.smembers(tagKey)
      expect(membersAfter.length).toBe(0)
    })

    it('should handle multiple tags', async () => {
      const cache = new cacheModule.AdaptiveCache()
      const key = 'multi-tag-key'
      await cache.set(key, { val: 1 }, { tags: ['tag1', 'tag2'] })

      const members1 = await redisClient.smembers('adaptive:tag:tag1')
      const members2 = await redisClient.smembers('adaptive:tag:tag2')
      expect(members1).toContain(key)
      expect(members2).toContain(key)

      await cache.invalidateTags(['tag1'])
      const res = await cache.get(key)
      expect(res).toBeNull()
    })

    it('should handle invalidating non-existent tags', async () => {
      const cache = new cacheModule.AdaptiveCache()
      const tag = 'non-existent-tag'

      // Ensure tag is empty
      await redisClient.del('adaptive:tag:' + tag)

      await cache.invalidateTags([tag])

      // Should not throw and should have tried to delete the tag key
      const exists = await redisClient.exists('adaptive:tag:' + tag)
      expect(exists).toBe(0)
    })

    it('should handle set error', async () => {
      const { Logger } = await import('../src/lib/logger')
      const errorSpy = vi.spyOn(Logger.prototype, 'error')

      const cache = new cacheModule.AdaptiveCache()
      // Mock adaptiveCacheUpdate to throw
      vi.spyOn(cache.client, 'adaptiveCacheUpdate').mockRejectedValue(new Error('Set failed'))

      await expect(cache.set('fail-key', { a: 1 })).rejects.toThrow('Set failed')
      expect(errorSpy).toHaveBeenCalled()
    })
  })
})
