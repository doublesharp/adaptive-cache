import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import express from 'express'
import request from 'supertest'
import Redis from 'ioredis'
import { getAdaptiveCacheKey as baseAdaptiveCacheKey } from '../src/utils'

// We need to delay importing the cache module until Redis is ready and env vars are set
let cacheModule: typeof import('../src')
let redisClient: Redis
let container: StartedTestContainer

const adapters: ReturnType<typeof cacheModule.adaptiveExpressCache>[] = []
const makeAdapter = (...args: Parameters<typeof cacheModule.adaptiveExpressCache>) => {
  const adapter = cacheModule.adaptiveExpressCache(...args)
  adapters.push(adapter)
  return adapter
}

const getAdaptiveCacheKey = (...args: Parameters<typeof baseAdaptiveCacheKey>) =>
  baseAdaptiveCacheKey(args[0], args[1], args[2], args[3], 'localhost:80')

describe('Adaptive Express Cache', () => {
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

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close()))
  })

  beforeEach(async () => {
    await redisClient.flushall()
    vi.restoreAllMocks()
  })

  it('gives each owned adapter its own Redis connection and closes it independently', async () => {
    const before = ((await redisClient.client('LIST')) as string).trim().split('\n').length
    const first = makeAdapter()
    const second = makeAdapter()
    await Promise.all([first.cache.client.ping(), second.cache.client.ping()])
    expect(first.cache.client).not.toBe(second.cache.client)
    expect(((await redisClient.client('LIST')) as string).trim().split('\n').length).toBe(before + 2)
    await first.close()
    await vi.waitFor(() => expect(first.cache.client.status).toBe('end'))
    expect(await second.cache.client.ping()).toBe('PONG')
    await second.close()
    await vi.waitFor(() => expect(second.cache.client.status).toBe('end'))
    expect(((await redisClient.client('LIST')) as string).trim().split('\n').length).toBe(before)
  })

  describe('cache helper (success)', () => {
    it('should cache successful responses', async () => {
      const app = express()
      let callCount = 0

      app.get('/test', makeAdapter(cacheModule.cache('10 seconds')), (req, res) => {
        callCount++
        res.json({ value: 'success' })
      })

      // First call
      await request(app).get('/test').set('Host', 'localhost:80').expect(200)
      expect(callCount).toBe(1)

      // Second call (cached)
      await request(app).get('/test').set('Host', 'localhost:80').expect(200)
      expect(callCount).toBe(1)
    })

    it('should not cache error responses', async () => {
      const app = express()
      let callCount = 0

      app.get('/error', makeAdapter(cacheModule.cache('10 seconds')), (req, res) => {
        callCount++
        res.status(500).json({ error: 'fail' })
      })

      await request(app).get('/error').set('Host', 'localhost:80').expect(500)
      expect(callCount).toBe(1)

      await request(app).get('/error').set('Host', 'localhost:80').expect(500)
      expect(callCount).toBe(2)
    })
  })

  describe('cache', () => {
    it('should not cache 4xx responses', async () => {
      const app = express()
      let callCount = 0

      app.get('/any', makeAdapter(cacheModule.cache('10 seconds')), (req, res) => {
        callCount++
        res.status(400).json({ value: 'bad request' })
      })

      await request(app).get('/any').set('Host', 'localhost:80').expect(400)
      expect(callCount).toBe(1)

      await request(app).get('/any').set('Host', 'localhost:80').expect(400)
      expect(callCount).toBe(2)
    })

    it('should fallback to default duration for invalid types', async () => {
      const app = express()
      // @ts-expect-error invalid duration type
      app.get('/invalid-duration', makeAdapter(cacheModule.cache(true)), (req, res) => {
        res.json({ ok: true })
      })
      await request(app).get('/invalid-duration').set('Host', 'localhost:80').expect(200)
      const key = getAdaptiveCacheKey('/invalid-duration', {}, 'adaptive:')
      await vi.waitFor(async () => expect((await redisClient.hgetall(key + 'meta')).dataTTL).toBe('5'))
    })
  })

  describe('adaptiveExpressCache', () => {
    it('should cache and return headers', async () => {
      const app = express()
      let callCount = 0

      app.get('/adaptive', makeAdapter({ initialTTL: 10 }), (req, res) => {
        callCount++
        res.json({ foo: 'bar' })
      })

      // First request (MISS)
      const res1 = await request(app).get('/adaptive').set('Host', 'localhost:80').expect(200)
      expect(res1.headers['x-cache']).toBe('MISS')
      expect(callCount).toBe(1)
      expect(res1.body).toEqual({ foo: 'bar' })

      // Wait a bit for async cache set (it's fire and forget in the middleware)
      await new Promise((r) => setTimeout(r, 100))

      // Second request (HIT)
      const res2 = await request(app).get('/adaptive').set('Host', 'localhost:80').expect(200)
      expect(res2.headers['x-cache']).toBe('HIT')
      expect(res2.headers['x-cache-ttl']).toBeDefined()
      expect(callCount).toBe(1)
      expect(res2.body).toEqual({ foo: 'bar' })
    })

    it('should support debug headers', async () => {
      const app = express()
      app.get('/debug', makeAdapter({ includeDebugHeaders: true }), (req, res) => {
        res.json({ debug: true })
      })

      await request(app).get('/debug').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))

      const res2 = await request(app).get('/debug').set('Host', 'localhost:80')
      expect(res2.headers['x-cache-data-ttl']).toBeDefined()
      expect(res2.headers['x-cache-last-modified']).toBeDefined()
      expect(res2.headers['x-cache-refreshed']).toBeDefined()
    })

    it('should force refresh via query param', async () => {
      const app = express()
      let callCount = 0
      app.get('/refresh', makeAdapter(), (req, res) => {
        callCount++
        res.json({ count: callCount })
      })

      await request(app).get('/refresh').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))

      // Normal hit
      await request(app).get('/refresh').set('Host', 'localhost:80')
      expect(callCount).toBe(1)

      // Force refresh
      const res3 = await request(app).get('/refresh?refresh=true').set('Host', 'localhost:80')
      expect(res3.headers['x-cache']).toBe('BYPASS')
      expect(callCount).toBe(2)

      const res4 = await request(app).get('/refresh').set('Host', 'localhost:80')
      expect(res4.headers['x-cache']).toBe('HIT')
      expect(res4.body).toEqual({ count: 2 })
      expect(callCount).toBe(2)
    })

    it('should cap the actual stored TTL using the response body', async () => {
      const app = express()
      const maxTTL = vi.fn((body) => body.ttl)
      const middleware = makeAdapter({ initialTTL: 30, maxTTL })
      app.get('/maxttl', middleware, (_req, res) => res.json({ ttl: 20 }))
      try {
        await request(app).get('/maxttl').set('Host', 'localhost:80').expect(200)
        await middleware.flush()
        expect(maxTTL).toHaveBeenCalledWith({ ttl: 20 })
        const key = getAdaptiveCacheKey('/maxttl', {}, 'adaptive:')
        const ttl = await redisClient.ttl(key + 'data')
        expect(ttl).toBeGreaterThan(18)
        expect(ttl).toBeLessThanOrEqual(20)
        expect((await request(app).get('/maxttl').set('Host', 'localhost:80')).headers['x-cache']).toBe('HIT')
      } finally {
        await middleware.close()
      }
    })

    it('should serve cached falsy responses as hits', async () => {
      const app = express()
      let callCount = 0

      app.get('/false-response', makeAdapter({ initialTTL: 10 }), (req, res) => {
        callCount++
        res.json(false)
      })

      await request(app).get('/false-response').set('Host', 'localhost:80').expect(200)
      await new Promise((r) => setTimeout(r, 100))

      const res2 = await request(app).get('/false-response').set('Host', 'localhost:80').expect(200)
      expect(res2.headers['x-cache']).toBe('HIT')
      expect(res2.body).toBe(false)
      expect(callCount).toBe(1)
    })

    it('should cache plain text responses', async () => {
      const app = express()
      let callCount = 0

      app.get('/plain-text', makeAdapter({ initialTTL: 10 }), (_req, res) => {
        callCount++
        res.type('text/plain').send('plain text')
      })

      await request(app).get('/plain-text').set('Host', 'localhost:80').expect(200, 'plain text')
      await new Promise((r) => setTimeout(r, 100))

      const res2 = await request(app).get('/plain-text').set('Host', 'localhost:80').expect(200, 'plain text')
      expect(res2.headers['x-cache']).toBe('HIT')
      expect(callCount).toBe(1)
    })

    it('should compress data by default', async () => {
      const app = express()
      app.get('/compress', makeAdapter({ compress: true }), (req, res) => {
        res.json({ large: 'data'.repeat(100) })
      })

      await request(app).get('/compress').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))

      const res2 = await request(app).get('/compress').set('Host', 'localhost:80')
      expect(res2.headers['x-cache']).toBe('HIT')
      expect(res2.body.large).toBe('data'.repeat(100))
    })

    it('should handle compression disabled', async () => {
      const app = express()
      app.get('/no-compress', makeAdapter({ compress: false }), (req, res) => {
        res.json({ data: 'raw' })
      })

      await request(app).get('/no-compress').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))

      const res2 = await request(app).get('/no-compress').set('Host', 'localhost:80')
      expect(res2.headers['x-cache']).toBe('HIT')
      expect(res2.body.data).toBe('raw')
    })

    it('should handle redis errors gracefully', async () => {
      const app = express()
      const adapter = makeAdapter()
      // Mock adaptiveCacheFetch to throw
      vi.spyOn(adapter.cache.client, 'adaptiveCacheFetch').mockRejectedValueOnce(new Error('Redis connection failed'))

      let callCount = 0
      app.get('/redis-error', adapter, (req, res) => {
        callCount++
        res.json({ ok: true })
      })

      // Should proceed to handler
      await request(app).get('/redis-error').set('Host', 'localhost:80').expect(200)
      expect(callCount).toBe(1)
    })

    it('should handle corrupted cache data', async () => {
      const app = express()
      const adapter = makeAdapter()
      // Mock adaptiveCacheFetch to return corrupted data
      vi.spyOn(adapter.cache.client, 'adaptiveCacheFetch').mockResolvedValue(['not-gzipped-json', 10])

      let callCount = 0
      app.get('/corrupt', adapter, (req, res) => {
        callCount++
        res.json({ ok: true })
      })

      // Should fall back to handler and set X-Cache: RETRY
      const res = await request(app).get('/corrupt').set('Host', 'localhost:80').expect(200)
      expect(res.headers['x-cache']).toBe('RETRY')
      expect(callCount).toBe(1)
    })

    it('should handle cache update failure', async () => {
      const { Logger } = await import('../src/lib/logger')
      const errorSpy = vi.spyOn(Logger.prototype, 'error')

      const app = express()
      const adapter = makeAdapter()
      // Mock adaptiveCacheUpdate to throw
      vi.spyOn(adapter.cache.client, 'adaptiveCacheUpdate').mockRejectedValue(new Error('Update failed'))

      app.get('/update-fail', adapter, (req, res) => {
        res.json({ ok: true })
      })

      // Should still return 200
      await request(app).get('/update-fail').set('Host', 'localhost:80').expect(200)
      await new Promise((r) => setTimeout(r, 100))

      expect(errorSpy).toHaveBeenCalledWith('Cache update failed:', expect.any(Error))
    })

    it('should respect includeHeaders: false', async () => {
      const app = express()
      app.get('/no-headers', makeAdapter({ includeHeaders: false }), (req, res) => {
        res.json({ ok: true })
      })
      const res = await request(app).get('/no-headers').set('Host', 'localhost:80').expect(200)
      expect(res.headers['x-cache']).toBeUndefined()
    })

    it('should handle missing metadata with debug headers', async () => {
      const app = express()
      app.get('/debug-missing', makeAdapter({ includeDebugHeaders: true }), (req, res) => {
        res.json({ debug: true })
      })

      // Populate cache
      await request(app).get('/debug-missing').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))

      // Manually delete meta key
      // We need to find the key. Since we flushall before each test, it should be the only ones.
      const keys = await redisClient.keys('adaptive:*:meta')
      if (keys.length > 0) {
        await redisClient.del(...keys)
      }

      const res2 = await request(app).get('/debug-missing').set('Host', 'localhost:80')
      expect(res2.headers['x-cache']).toBe('HIT')
      expect(res2.headers['x-cache-data-ttl']).toBeUndefined()
    })

    it('should handle missing lastChanged in metadata', async () => {
      const app = express()
      app.get('/missing-last-changed', makeAdapter({ includeDebugHeaders: true }), (req, res) => {
        res.json({ ok: true })
      })

      // Populate cache
      await request(app).get('/missing-last-changed').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))

      // Manually modify metadata to remove lastChanged
      const keys = await redisClient.keys('adaptive:*:meta')
      expect(keys).toHaveLength(1)
      await redisClient.hdel(keys[0], 'lastChanged')

      const res = await request(app).get('/missing-last-changed').set('Host', 'localhost:80')
      expect(res.headers['x-cache-last-modified']).toBe('unknown')
    })

    it('should use default maxTTL if function returns undefined', async () => {
      const app = express()
      app.get(
        '/maxttl-default',
        makeAdapter({
          maxTTL: () => undefined,
          initialTTL: 2000,
        }),
        (req, res) => {
          res.json({ ok: true })
        },
      )
      await request(app).get('/maxttl-default').set('Host', 'localhost:80').expect(200)

      const key = getAdaptiveCacheKey('/maxttl-default', {}, 'adaptive:')
      await vi.waitFor(async () => expect((await redisClient.hgetall(key + 'meta')).dataTTL).toBe('900'))
    })

    it('should respect includeHeaders: false on HIT', async () => {
      const app = express()
      let calls = 0
      app.get('/no-headers-hit', makeAdapter({ includeHeaders: false }), (req, res) => {
        calls++
        res.json({ ok: true })
      })
      // Miss
      await request(app).get('/no-headers-hit').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))
      // Hit
      const res = await request(app).get('/no-headers-hit').set('Host', 'localhost:80').expect(200)
      expect(res.headers['x-cache']).toBeUndefined()
      expect(calls).toBe(1)
    })

    it('should handle object body in res.send', async () => {
      const app = express()
      app.get('/obj-send', makeAdapter(), (req, res) => {
        res.send({ data: 'obj' })
      })

      await request(app).get('/obj-send').set('Host', 'localhost:80').expect(200)
      await vi.waitFor(async () => {
        const hit = await request(app).get('/obj-send').set('Host', 'localhost:80')
        expect(hit.headers['x-cache']).toBe('HIT')
        expect(hit.body).toEqual({ data: 'obj' })
      })
    })

    it('should handle errors during cache hit response', async () => {
      const app = express()
      app.get('/hit-error', makeAdapter(), (req, res) => {
        res.json({ ok: true })
      })

      // Populate cache
      await request(app).get('/hit-error').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))

      const app2 = express()
      app2.use((req, res, next) => {
        const originalSend = res.send
        res.send = function (body: any) {
          if (req.headers['x-trigger-error']) {
            delete req.headers['x-trigger-error']
            throw new Error('Send failed')
          }
          return originalSend.call(res, body)
        } as any
        next()
      })

      app2.get('/hit-error-2', makeAdapter(), (req, res) => {
        res.json({ ok: true })
      })

      // Populate
      await request(app2).get('/hit-error-2').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))

      // Trigger error
      const res = await request(app2).get('/hit-error-2').set('Host', 'localhost:80').set('X-Trigger-Error', 'true')
      expect(res.headers['x-cache']).toBe('RETRY')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    })
  })

  describe('clearAdaptiveCache', () => {
    it('should clear the cache', async () => {
      const app = express()
      let callCount = 0
      app.get('/clear', makeAdapter(), (req, res) => {
        callCount++
        res.json({ val: 1 })
      })

      await request(app).get('/clear').set('Host', 'localhost:80')
      await new Promise((r) => setTimeout(r, 100))

      await request(app).get('/clear').set('Host', 'localhost:80')
      expect(callCount).toBe(1)

      await cacheModule.clearAdaptiveCache('/clear', {}, 'adaptive:', {}, 'localhost:80')

      await request(app).get('/clear').set('Host', 'localhost:80')
      expect(callCount).toBe(2)
    })
  })

  describe('Cache Tags Middleware', () => {
    it('should apply static tags from options', async () => {
      const app = express()
      app.get('/static-tags', makeAdapter({ tags: ['static-tag'] }), (req, res) => {
        res.json({ ok: true })
      })

      await request(app).get('/static-tags').set('Host', 'localhost:80').expect(200)
      await new Promise((r) => setTimeout(r, 100))

      // Check redis for tag
      // The key is constructed in middleware: adaptive:/static-tags:hash:
      // We need to find the key or check the tag set directly
      const members = await redisClient.zrange('adaptive:__adaptive:tag-index:static-tag', 0, -1)
      expect(members.length).toBe(1)
      expect(members[0]).toContain('/static-tags')
    })

    it('should apply dynamic tags from function', async () => {
      const app = express()
      app.get(
        '/dynamic-tags/:id',
        makeAdapter({
          tags: (req) => [`user:${req.params.id}`],
        }),
        (req, res) => {
          res.json({ ok: true })
        },
      )

      await request(app).get('/dynamic-tags/123').set('Host', 'localhost:80').expect(200)
      await new Promise((r) => setTimeout(r, 100))

      const members = await redisClient.zrange('adaptive:__adaptive:tag-index:user:123', 0, -1)
      expect(members.length).toBe(1)
    })

    it('should handle invalid tags type gracefully', async () => {
      const app = express()
      app.get(
        '/invalid-tags',
        // @ts-expect-error invalid tags type
        makeAdapter({ tags: 'not-an-array-or-function' }),
        (req, res) => {
          res.json({ ok: true })
        },
      )

      await request(app).get('/invalid-tags').set('Host', 'localhost:80').expect(200)
      await vi.waitFor(async () => {
        const hit = await request(app).get('/invalid-tags').set('Host', 'localhost:80')
        expect(hit.headers['x-cache']).toBe('HIT')
        expect(hit.body).toEqual({ ok: true })
      })
    })
  })

  it('should handle tags as a function', async () => {
    const app = express()

    app.get(
      '/tags-fn',
      makeAdapter({
        tags: (_req) => {
          return ['express-dynamic-tag']
        },
      }),
      (req, res) => {
        res.json({ ok: true })
      },
    )

    await request(app).get('/tags-fn').set('Host', 'localhost:80')
    await new Promise((r) => setTimeout(r, 100))

    const members = await redisClient.zrange('adaptive:__adaptive:tag-index:express-dynamic-tag', 0, -1)
    expect(members.length).toBe(1)
  })

  it('should use default cache time when not provided', async () => {
    const app = express()

    // Call without arguments to trigger default parameter
    app.get('/default-cache', makeAdapter(cacheModule.cache()), (req, res) => {
      res.json({ ok: true })
    })

    app.get('/default-cache-success', makeAdapter(cacheModule.cache()), (req, res) => {
      res.json({ ok: true })
    })

    await request(app).get('/default-cache').set('Host', 'localhost:80').expect(200)
    await request(app).get('/default-cache-success').set('Host', 'localhost:80').expect(200)
    const key = getAdaptiveCacheKey('/default-cache', {}, 'adaptive:')
    await vi.waitFor(async () => expect((await redisClient.hgetall(key + 'meta')).dataTTL).toBe('5'))
  })
})
