import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'

// We need to delay importing the cache module until Redis is ready and env vars are set
let cacheModule: typeof import('../src')
let redisClient: Redis
let container: StartedTestContainer

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 2000) => {
  const start = Date.now()
  let lastError: unknown

  while (Date.now() - start < timeoutMs) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  throw lastError
}

describe('AdaptiveCache Class & Utils', () => {
  beforeAll(async () => {
    // Start Redis container
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()

    const host = container.getHost()
    const port = container.getMappedPort(6379)

    process.env.REDIS_HOST = host
    process.env.REDIS_PORT = port.toString()

    // Import the module after setting env vars
    cacheModule = await import('../src/index')
    redisClient = cacheModule.redis
  })

  afterAll(async () => {
    if (redisClient) {
      await redisClient.quit()
    }
    if (container) {
      await container.stop()
    }
  })

  beforeEach(async () => {
    await redisClient.flushall()
    vi.restoreAllMocks()
  })

  it('should export redis client', () => {
    expect(cacheModule.redis).toBeDefined()
  })

  describe('cacheResult', () => {
    it('should cache function results', async () => {
      let callCount = 0
      const expensiveFn = async () => {
        callCount++
        return { data: 'expensive' }
      }

      const key = 'test-key'
      const result1 = await cacheModule.cacheResult(key, 10, expensiveFn)
      expect(result1).toEqual({ data: 'expensive' })
      expect(callCount).toBe(1)

      const result2 = await cacheModule.cacheResult(key, 10, expensiveFn)
      expect(result2).toEqual({ data: 'expensive' })
      expect(callCount).toBe(1)
    })

    it('should not cache null results', async () => {
      let callCount = 0
      const nullFn = async () => {
        callCount++
        return null
      }

      const key = 'null-key'
      const result1 = await cacheModule.cacheResult(key, 10, nullFn)
      expect(result1).toBeNull()
      expect(callCount).toBe(1)

      const result2 = await cacheModule.cacheResult(key, 10, nullFn)
      expect(result2).toBeNull()
      expect(callCount).toBe(2)
    })

    it('should cache falsy non-null results', async () => {
      let callCount = 0
      const falseFn = async () => {
        callCount++
        return false
      }

      const key = 'false-key'
      const result1 = await cacheModule.cacheResult(key, 10, falseFn)
      const result2 = await cacheModule.cacheResult(key, 10, falseFn)

      expect(result1).toBe(false)
      expect(result2).toBe(false)
      expect(callCount).toBe(1)
    })

    it('should hit cache in cacheResult', async () => {
      const key = 'hit-test'
      await redisClient.set(key, JSON.stringify({ hit: true }))

      const result = await cacheModule.cacheResult(key, 10, async () => ({ hit: false }))
      expect(result).toEqual({ hit: true })
    })
  })

  describe('Lua Scripts', () => {
    it('adaptive cache lua scripts should preserve old tuple fields and include metadata', async () => {
      const cache = new cacheModule.AdaptiveCache({ initialTTL: 10, includeDebugHeaders: true })

      await cache.set('lua-tuple-key', { a: 1 })

      const fetchTuple = await redisClient.adaptiveCacheFetch('lua-tuple-keydata')
      expect(fetchTuple[0]).toEqual(expect.any(String))
      expect(fetchTuple[1]).toEqual(expect.any(Number))
      expect(fetchTuple[2]).toBeDefined()
      expect(fetchTuple[3]).toBeDefined()
      expect(fetchTuple[4]).toBeDefined()
      expect(fetchTuple[5]).toEqual(expect.any(String))

      const updateTuple = await redisClient.adaptiveCacheUpdate(
        'lua-direct-keydata',
        'lua-direct-keymeta',
        'hash-1',
        JSON.stringify({ ok: true }),
        '5',
        '30',
        '2',
        '60',
      )

      expect(updateTuple[0]).toBe('CACHED')
      expect(updateTuple[1]).toEqual(expect.any(Number))
      expect(updateTuple[2]).toBeDefined()
      expect(updateTuple[3]).toBeDefined()
      expect(updateTuple[4]).toBe('hash-1')
      expect(updateTuple[5]).toBe(1)
    })

    it('shouldRefreshCache should manage locks', async () => {
      const lastUpdateKey = 'test-update-key'
      const refreshThreshold = 10

      // First call, should refresh
      const [shouldRefresh, lockVal] = await cacheModule.shouldRefreshCache(lastUpdateKey, refreshThreshold)
      expect(shouldRefresh).toBe('UPDATE')
      expect(lockVal).toBeDefined()

      // Second call immediately, should be UPDATING (locked)
      const [shouldRefresh2] = await cacheModule.shouldRefreshCache(lastUpdateKey, refreshThreshold)
      expect(shouldRefresh2).toBe('UPDATING')

      // Release lock
      await cacheModule.releaseCacheRefreshLock(lastUpdateKey, lockVal as string)

      // Should be able to update again (or EXISTS if within threshold, but here we didn't update the timestamp)
      // Actually `releaseCacheRefreshLock` updates the timestamp to NOW.
      // So if we check again, it should be EXISTS (valid cache)
      const [shouldRefresh3] = await cacheModule.shouldRefreshCache(lastUpdateKey, refreshThreshold)
      expect(shouldRefresh3).toBe('EXISTS')
    })

    it('shouldRefreshCache should handle force option', async () => {
      const lastUpdateKey = 'force-key'
      const [shouldRefresh] = await cacheModule.shouldRefreshCache(lastUpdateKey, 10, true)
      expect(shouldRefresh).toBe('UPDATE')
    })

    it('should apply global lockExpiration default', async () => {
      // set a global lock expiration default and ensure shouldRefreshCache still works
      await cacheModule.setDefaultLockExpirationSeconds(30)
      const lastUpdateKey = 'global-lock-key'
      const [shouldRefresh] = await cacheModule.shouldRefreshCache(lastUpdateKey, 10)
      expect(shouldRefresh).toBe('UPDATE')
    })

    it('should set default lock expiration from options', async () => {
      const spy = vi.spyOn(cacheModule.AdaptiveCache, 'setDefaultLockExpirationSeconds')
      cacheModule.adaptiveExpressCache({ lockExpirationSeconds: 123 })
      expect(spy).toHaveBeenCalledWith(123)
    })
  })

  describe('Cleanup', () => {
    it('should quit the client', async () => {
      const cache = new cacheModule.AdaptiveCache()
      const quitSpy = vi.spyOn(cache.client, 'quit')
      await cache.quit()
      expect(quitSpy).toHaveBeenCalled()
    })
  })

  describe('AdaptiveCache Class Internals', () => {
    it('should use instance maxTTL if not provided in set options', async () => {
      const cache = new cacheModule.AdaptiveCache({ maxTTL: 100 })
      const spy = vi.spyOn(cache.client, 'adaptiveCacheUpdate')
      await cache.set('test-key', { a: 1 })
      // Check if maxTTL (6th arg) is 100
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        '100', // maxTTL
        expect.any(String),
        expect.any(String),
      )
    })

    it('should resolve instance maxTTL functions in direct set calls', async () => {
      const cache = new cacheModule.AdaptiveCache({ maxTTL: (data) => (data.kind === 'short' ? 12 : undefined) })
      const spy = vi.spyOn(cache.client, 'adaptiveCacheUpdate')
      await cache.set('test-key-fn-ttl', { kind: 'short' })

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        '12',
        expect.any(String),
        expect.any(String),
      )
    })

    it('should use default maxTTL if neither provided', async () => {
      const cache = new cacheModule.AdaptiveCache({})
      const spy = vi.spyOn(cache.client, 'adaptiveCacheUpdate')
      await cache.set('test-key-2', { a: 1 })
      // Check if maxTTL is default (900)
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        '900', // DEFAULT_MAX_TTL
        expect.any(String),
        expect.any(String),
      )
    })

    it('should round-trip strings and buffers without JSON parse failures', async () => {
      const cache = new cacheModule.AdaptiveCache({ initialTTL: 10 })

      await cache.set('plain-string-key', 'plain text')
      expect((await cache.get('plain-string-key'))?.data).toBe('plain text')

      await cache.set('buffer-key', Buffer.from('buffer text'))
      expect(Buffer.isBuffer((await cache.get('buffer-key'))?.data)).toBe(true)
      expect((await cache.get('buffer-key'))?.data.toString('utf8')).toBe('buffer text')

      await cache.set('empty-buffer-key', Buffer.alloc(0))
      expect((await cache.get('empty-buffer-key'))?.data.length).toBe(0)

      await cache.set('undefined-key', undefined)
      expect((await cache.get('undefined-key'))?.data).toBeUndefined()
    })

    it('should use instance lockExpirationSeconds if not provided in shouldRefresh', async () => {
      const cache = new cacheModule.AdaptiveCache({ lockExpirationSeconds: 50 })
      const spy = vi.spyOn(cache.client, 'shouldRefreshCache')
      await cache.shouldRefresh('key', 10)
      // Check if lockExpiration (5th arg) is 50 * 1000
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        50000, // lockExpiration
        expect.any(String),
        expect.any(Number),
      )
    })

    it('should use static default lockExpirationSeconds if neither provided', async () => {
      const cache = new cacheModule.AdaptiveCache({})
      const spy = vi.spyOn(cache.client, 'shouldRefreshCache')
      // Ensure static default is 60
      cacheModule.AdaptiveCache.setDefaultLockExpirationSeconds(60)

      await cache.shouldRefresh('key-default', 10)
      // Check if lockExpiration (5th arg) is 60 * 1000
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        60000, // lockExpiration
        expect.any(String),
        expect.any(Number),
      )
    })

    it('should use provided lockExpirationSeconds argument', async () => {
      const cache = new cacheModule.AdaptiveCache({})
      const spy = vi.spyOn(cache.client, 'shouldRefreshCache')

      await cache.shouldRefresh('key-arg', 10, false, 99)
      // Check if lockExpiration (5th arg) is 99 * 1000
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        99000, // lockExpiration
        expect.any(String),
        expect.any(Number),
      )
    })
  })

  describe('Singleton Proxy', () => {
    it('should proxy properties', () => {
      // Access a property that is not a function to cover the getter branch
      expect(cacheModule.redis.status).toBeDefined()
    })

    it('should access non-function properties on redis client', () => {
      // ioredis client has properties like 'status', 'options'
      const status = cacheModule.redis.status
      expect(status).toBeDefined()
    })
  })

  describe('Module Exports', () => {
    it('should export all required members', () => {
      expect(cacheModule.AdaptiveCache).toBeDefined()
      expect(cacheModule.getDefaultCache).toBeDefined()
      expect(cacheModule.redis).toBeDefined()
      expect(cacheModule.adaptiveExpressCache).toBeDefined()
      expect(cacheModule.clearAdaptiveCache).toBeDefined()
      expect(cacheModule.adaptiveFastifyCache).toBeDefined()
      expect(cacheModule.cacheResult).toBeDefined()
      expect(cacheModule.setDefaultLockExpirationSeconds).toBeDefined()
      expect(cacheModule.shouldRefreshCache).toBeDefined()
      expect(cacheModule.releaseCacheRefreshLock).toBeDefined()
    })

    it('shouldRefreshCache should call internal instance', async () => {
      const spy = vi.spyOn(cacheModule.getDefaultCache(), 'shouldRefresh')
      await cacheModule.shouldRefreshCache('key', 10)
      expect(spy).toHaveBeenCalled()
    })

    it('releaseCacheRefreshLock should call internal instance', async () => {
      const spy = vi.spyOn(cacheModule.getDefaultCache(), 'releaseLock')
      await cacheModule.releaseCacheRefreshLock('key', 'lock')
      expect(spy).toHaveBeenCalled()
    })

    it('should call setDefaultLockExpirationSeconds', () => {
      const spy = vi.spyOn(cacheModule.AdaptiveCache, 'setDefaultLockExpirationSeconds')
      cacheModule.setDefaultLockExpirationSeconds(100)
      expect(spy).toHaveBeenCalledWith(100)
    })
  })

  describe('AdaptiveCache Static', () => {
    it('should use static default lock expiration', () => {
      // Just accessing the static property to ensure coverage
      const val = cacheModule.AdaptiveCache.DEFAULT_LOCK_EXPIRATION_SECONDS
      expect(val).toBeDefined()
    })
  })

  describe('Configuration & Environment', () => {
    it('should use REDIS_URL if provided', () => {
      vi.stubEnv('REDIS_URL', 'redis://localhost:6379')
      // We need to unset REDIS_HOST/PORT to ensure it takes the URL path if logic dictates,
      // but the code says: if (redisURL) new Redis(redisURL) else ...
      // So just setting REDIS_URL is enough.

      const cache = new cacheModule.AdaptiveCache()
      // ioredis parses the URL.
      expect(cache.client.options.host).toBe('localhost')
      expect(cache.client.options.port).toBe(6379)

      vi.unstubAllEnvs()
      cache.quit()
    })

    it('should only use TLS options for TLS URLs and verify certificates by default', () => {
      vi.stubEnv('REDIS_URL', 'redis://localhost:6379')

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.tls).toBeUndefined()

      vi.unstubAllEnvs()
      cache.quit()

      vi.stubEnv('REDIS_TLS_URL', 'rediss://localhost:6379')
      const tlsCache = new cacheModule.AdaptiveCache()
      expect(tlsCache.client.options.tls).toEqual({ rejectUnauthorized: true })

      vi.unstubAllEnvs()
      tlsCache.quit()
    })

    it('should allow explicitly insecure Redis TLS', () => {
      vi.stubEnv('REDIS_TLS_URL', 'rediss://localhost:6379')
      vi.stubEnv('REDIS_INSECURE_TLS', 'true')

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.tls).toEqual({ rejectUnauthorized: false })

      vi.unstubAllEnvs()
      cache.quit()
    })

    it('should default to port 6379 if REDIS_PORT is missing', () => {
      // Ensure REDIS_URL is not set
      vi.stubEnv('REDIS_URL', '')
      vi.stubEnv('REDIS_TLS_URL', '')
      vi.stubEnv('REDIS_HOST', 'localhost')
      // stubEnv with undefined or empty string might not remove it from process.env if it was there?
      // vi.stubEnv sets the value.
      // The code checks: process.env.REDIS_PORT ? parseInt(...) : 6379
      // So if I set it to empty string, parseInt('') is NaN.
      // Wait, parseInt('') is NaN. NaN is falsy? No.
      // If I set it to undefined? vi.stubEnv value must be string.

      // I'll manually delete it and restore it.
      const originalPort = process.env.REDIS_PORT
      delete process.env.REDIS_PORT

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.port).toBe(6379)

      process.env.REDIS_PORT = originalPort
      cache.quit()
    })

    it('should use REDIS_PORT if provided', () => {
      // Ensure URL is not set so we fall through to the host/port logic
      vi.stubEnv('REDIS_URL', '')
      vi.stubEnv('REDIS_TLS_URL', '')

      vi.stubEnv('REDIS_HOST', 'localhost')
      vi.stubEnv('REDIS_PORT', '6380')

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.port).toBe(6380)

      vi.unstubAllEnvs()
      cache.quit()
    })

    it('should default to localhost if REDIS_HOST is missing', () => {
      vi.stubEnv('REDIS_URL', '')
      delete process.env.REDIS_HOST

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.host).toBe('localhost')

      cache.quit()
    })
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
