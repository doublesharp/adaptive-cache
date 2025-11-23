import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import express from 'express'
import request from 'supertest'
import Redis from 'ioredis'

// We need to delay importing the cache module until Redis is ready and env vars are set
let cacheModule: typeof import('../src')
let redisClient: Redis
let container: StartedTestContainer

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

  beforeEach(async () => {
    await redisClient.flushall()
    vi.restoreAllMocks()
  })

  describe('cache helper (success)', () => {
    it('should cache successful responses', async () => {
      const app = express()
      let callCount = 0

      app.get('/test', cacheModule.adaptiveExpressCache(cacheModule.cache('10 seconds')), (req, res) => {
        callCount++
        res.json({ value: 'success' })
      })

      // First call
      await request(app).get('/test').expect(200)
      expect(callCount).toBe(1)

      // Second call (cached)
      await request(app).get('/test').expect(200)
      expect(callCount).toBe(1)
    })

    it('should not cache error responses', async () => {
      const app = express()
      let callCount = 0

      app.get('/error', cacheModule.adaptiveExpressCache(cacheModule.cache('10 seconds')), (req, res) => {
        callCount++
        res.status(500).json({ error: 'fail' })
      })

      await request(app).get('/error').expect(500)
      expect(callCount).toBe(1)

      await request(app).get('/error').expect(500)
      expect(callCount).toBe(2)
    })
  })

  describe('cache', () => {
    it('should not cache 4xx responses', async () => {
      const app = express()
      let callCount = 0

      app.get('/any', cacheModule.adaptiveExpressCache(cacheModule.cache('10 seconds')), (req, res) => {
        callCount++
        res.status(400).json({ value: 'bad request' })
      })

      await request(app).get('/any').expect(400)
      expect(callCount).toBe(1)

      await request(app).get('/any').expect(400)
      expect(callCount).toBe(2)
    })

    it('should fallback to default duration for invalid types', async () => {
      const app = express()
      // @ts-ignore
      app.get('/invalid-duration', cacheModule.adaptiveExpressCache(cacheModule.cache(true)), (req, res) => {
        res.json({ ok: true })
      })
      await request(app).get('/invalid-duration').expect(200)
    })
  })

  describe('adaptiveExpressCache', () => {
    it('should cache and return headers', async () => {
      const app = express()
      let callCount = 0

      app.get('/adaptive', cacheModule.adaptiveExpressCache({ initialTTL: 10 }), (req, res) => {
        callCount++
        res.json({ foo: 'bar' })
      })

      // First request (MISS)
      const res1 = await request(app).get('/adaptive').expect(200)
      expect(res1.headers['x-cache']).toBe('MISS')
      expect(callCount).toBe(1)
      expect(res1.body).toEqual({ foo: 'bar' })

      // Wait a bit for async cache set (it's fire and forget in the middleware)
      await new Promise((r) => setTimeout(r, 100))

      // Second request (HIT)
      const res2 = await request(app).get('/adaptive').expect(200)
      expect(res2.headers['x-cache']).toBe('HIT')
      expect(res2.headers['x-cache-ttl']).toBeDefined()
      expect(callCount).toBe(1)
      expect(res2.body).toEqual({ foo: 'bar' })
    })

    it('should support debug headers', async () => {
      const app = express()
      app.get('/debug', cacheModule.adaptiveExpressCache({ includeDebugHeaders: true }), (req, res) => {
        res.json({ debug: true })
      })

      await request(app).get('/debug')
      await new Promise((r) => setTimeout(r, 100))

      const res2 = await request(app).get('/debug')
      expect(res2.headers['x-cache-data-ttl']).toBeDefined()
      expect(res2.headers['x-cache-last-modified']).toBeDefined()
      expect(res2.headers['x-cache-refreshed']).toBeDefined()
    })

    it('should force refresh via query param', async () => {
      const app = express()
      let callCount = 0
      app.get('/refresh', cacheModule.adaptiveExpressCache(), (req, res) => {
        callCount++
        res.json({ count: callCount })
      })

      await request(app).get('/refresh')
      await new Promise((r) => setTimeout(r, 100))

      // Normal hit
      await request(app).get('/refresh')
      expect(callCount).toBe(1)

      // Force refresh
      const res3 = await request(app).get('/refresh?refresh=true')
      expect(res3.headers['x-cache']).toBe('BYPASS')
      expect(callCount).toBe(2)
    })

    it('should handle maxTTL as a function', async () => {
      const app = express()
      app.get(
        '/maxttl',
        cacheModule.adaptiveExpressCache({
          maxTTL: (body) => {
            const data = typeof body === 'string' ? JSON.parse(body) : body
            return data.ttl
          },
        }),
        (req, res) => {
          res.json({ ttl: 20 })
        },
      )

      await request(app).get('/maxttl')
      await new Promise((r) => setTimeout(r, 100))
    })

    it('should compress data by default', async () => {
      const app = express()
      app.get('/compress', cacheModule.adaptiveExpressCache({ compress: true }), (req, res) => {
        res.json({ large: 'data'.repeat(100) })
      })

      await request(app).get('/compress')
      await new Promise((r) => setTimeout(r, 100))

      const res2 = await request(app).get('/compress')
      expect(res2.body.large).toBe('data'.repeat(100))
    })

    it('should handle compression disabled', async () => {
      const app = express()
      app.get('/no-compress', cacheModule.adaptiveExpressCache({ compress: false }), (req, res) => {
        res.json({ data: 'raw' })
      })

      await request(app).get('/no-compress')
      await new Promise((r) => setTimeout(r, 100))

      const res2 = await request(app).get('/no-compress')
      expect(res2.body.data).toBe('raw')
    })

    it('should handle redis errors gracefully', async () => {
      const app = express()
      // Mock adaptiveCacheFetch to throw
      vi.spyOn(cacheModule.getDefaultCache().client, 'adaptiveCacheFetch').mockRejectedValueOnce(
        new Error('Redis connection failed'),
      )

      let callCount = 0
      app.get('/redis-error', cacheModule.adaptiveExpressCache(), (req, res) => {
        callCount++
        res.json({ ok: true })
      })

      // Should proceed to handler
      await request(app).get('/redis-error').expect(200)
      expect(callCount).toBe(1)
    })

    it('should handle corrupted cache data', async () => {
      const app = express()
      // Mock adaptiveCacheFetch to return corrupted data
      vi.spyOn(cacheModule.getDefaultCache().client, 'adaptiveCacheFetch').mockResolvedValue(['not-gzipped-json', 10])

      let callCount = 0
      app.get('/corrupt', cacheModule.adaptiveExpressCache(), (req, res) => {
        callCount++
        res.json({ ok: true })
      })

      // Should fall back to handler and set X-Cache: RETRY
      const res = await request(app).get('/corrupt').expect(200)
      expect(res.headers['x-cache']).toBe('RETRY')
      expect(callCount).toBe(1)
    })

    it('should handle cache update failure', async () => {
      const { Logger } = await import('../src/lib/logger')
      const errorSpy = vi.spyOn(Logger.prototype, 'error')

      const app = express()
      // Mock adaptiveCacheUpdate to throw
      vi.spyOn(cacheModule.getDefaultCache().client, 'adaptiveCacheUpdate').mockRejectedValue(
        new Error('Update failed'),
      )

      app.get('/update-fail', cacheModule.adaptiveExpressCache(), (req, res) => {
        res.json({ ok: true })
      })

      // Should still return 200
      await request(app).get('/update-fail').expect(200)
      // We can't easily check if it logged error, but coverage should be hit
      // Wait for async update
      await new Promise((r) => setTimeout(r, 100))

      expect(errorSpy).toHaveBeenCalledWith('Cache update failed:', expect.any(Error))
    })

    it('should respect includeHeaders: false', async () => {
      const app = express()
      app.get('/no-headers', cacheModule.adaptiveExpressCache({ includeHeaders: false }), (req, res) => {
        res.json({ ok: true })
      })
      const res = await request(app).get('/no-headers').expect(200)
      expect(res.headers['x-cache']).toBeUndefined()
    })

    it('should handle missing metadata with debug headers', async () => {
      const app = express()
      app.get('/debug-missing', cacheModule.adaptiveExpressCache({ includeDebugHeaders: true }), (req, res) => {
        res.json({ debug: true })
      })

      // Populate cache
      await request(app).get('/debug-missing')
      await new Promise((r) => setTimeout(r, 100))

      // Manually delete meta key
      // We need to find the key. Since we flushall before each test, it should be the only ones.
      const keys = await redisClient.keys('adaptive:*:meta')
      if (keys.length > 0) {
        await redisClient.del(...keys)
      }

      const res2 = await request(app).get('/debug-missing')
      expect(res2.headers['x-cache']).toBe('HIT')
      expect(res2.headers['x-cache-data-ttl']).toBeUndefined()
    })

    it('should handle missing lastChanged in metadata', async () => {
      const app = express()
      app.get('/missing-last-changed', cacheModule.adaptiveExpressCache({ includeDebugHeaders: true }), (req, res) => {
        res.json({ ok: true })
      })

      // Populate cache
      await request(app).get('/missing-last-changed')
      await new Promise((r) => setTimeout(r, 100))

      // Manually modify metadata to remove lastChanged
      const keys = await redisClient.keys('adaptive:*:meta')
      if (keys.length > 0) {
        await redisClient.hdel(keys[0], 'lastChanged')
      }

      const res = await request(app).get('/missing-last-changed')
      expect(res.headers['x-cache-last-modified']).toBe('unknown')
    })

    it('should use default maxTTL if function returns undefined', async () => {
      const { Logger } = await import('../src/lib/logger')
      const debugSpy = vi.spyOn(Logger.prototype, 'debug')

      const app = express()
      app.get(
        '/maxttl-default',
        cacheModule.adaptiveExpressCache({
          maxTTL: () => undefined,
          logLevel: 'debug',
        }),
        (req, res) => {
          res.json({ ok: true })
        },
      )
      await request(app).get('/maxttl-default').expect(200)

      expect(debugSpy).toHaveBeenCalledWith('Overriding maxTTL:', 900)
    })

    it('should respect includeHeaders: false on HIT', async () => {
      const app = express()
      app.get('/no-headers-hit', cacheModule.adaptiveExpressCache({ includeHeaders: false }), (req, res) => {
        res.json({ ok: true })
      })
      // Miss
      await request(app).get('/no-headers-hit')
      await new Promise((r) => setTimeout(r, 100))
      // Hit
      const res = await request(app).get('/no-headers-hit').expect(200)
      expect(res.headers['x-cache']).toBeUndefined()
    })

    it('should handle object body in res.send', async () => {
      const app = express()
      app.get('/obj-send', cacheModule.adaptiveExpressCache(), (req, res) => {
        res.send({ data: 'obj' })
      })

      await request(app).get('/obj-send').expect(200)
    })

    it('should handle errors during cache hit response', async () => {
      const app = express()
      app.get('/hit-error', cacheModule.adaptiveExpressCache(), (req, res) => {
        res.json({ ok: true })
      })

      // Populate cache
      await request(app).get('/hit-error')
      await new Promise((r) => setTimeout(r, 100))

      const app2 = express()
      app2.use((req, res, next) => {
        const originalSend = res.send
        res.send = function (body: any) {
          if (req.headers['x-trigger-error']) {
            throw new Error('Send failed')
          }
          return originalSend.call(res, body)
        } as any
        next()
      })

      app2.get('/hit-error-2', cacheModule.adaptiveExpressCache(), (req, res) => {
        res.json({ ok: true })
      })

      // Populate
      await request(app2).get('/hit-error-2')
      await new Promise((r) => setTimeout(r, 100))

      // Trigger error
      const res = await request(app2).get('/hit-error-2').set('X-Trigger-Error', 'true')
      expect(res.headers['x-cache']).toBe('RETRY')
    })
  })

  describe('clearAdaptiveCache', () => {
    it('should clear the cache', async () => {
      const app = express()
      let callCount = 0
      app.get('/clear', cacheModule.adaptiveExpressCache(), (req, res) => {
        callCount++
        res.json({ val: 1 })
      })

      await request(app).get('/clear')
      await new Promise((r) => setTimeout(r, 100))

      await request(app).get('/clear')
      expect(callCount).toBe(1)

      await cacheModule.clearAdaptiveCache('/clear', {}, 'adaptive:')

      await request(app).get('/clear')
      expect(callCount).toBe(2)
    })
  })

  describe('Cache Tags Middleware', () => {
    it('should apply static tags from options', async () => {
      const app = express()
      app.get('/static-tags', cacheModule.adaptiveExpressCache({ tags: ['static-tag'] }), (req, res) => {
        res.json({ ok: true })
      })

      await request(app).get('/static-tags').expect(200)
      await new Promise((r) => setTimeout(r, 100))

      // Check redis for tag
      // The key is constructed in middleware: adaptive:/static-tags:hash:
      // We need to find the key or check the tag set directly
      const members = await redisClient.smembers('adaptive:tag:static-tag')
      expect(members.length).toBe(1)
      expect(members[0]).toContain('/static-tags')
    })

    it('should apply dynamic tags from function', async () => {
      const app = express()
      app.get(
        '/dynamic-tags/:id',
        cacheModule.adaptiveExpressCache({
          tags: (req) => [`user:${req.params.id}`],
        }),
        (req, res) => {
          res.json({ ok: true })
        },
      )

      await request(app).get('/dynamic-tags/123').expect(200)
      await new Promise((r) => setTimeout(r, 100))

      const members = await redisClient.smembers('adaptive:tag:user:123')
      expect(members.length).toBe(1)
    })

    it('should handle invalid tags type gracefully', async () => {
      const app = express()
      // @ts-ignore
      app.get(
        '/invalid-tags',
        // @ts-ignore invalid array arg
        cacheModule.adaptiveExpressCache({ tags: 'not-an-array-or-function' }),
        (req, res) => {
          res.json({ ok: true })
        },
      )

      await request(app).get('/invalid-tags').expect(200)
    })
  })

  it('should handle tags as a function', async () => {
    const app = express()

    app.get(
      '/tags-fn',
      cacheModule.adaptiveExpressCache({
        tags: (req) => {
          return ['express-dynamic-tag']
        },
      }),
      (req, res) => {
        res.json({ ok: true })
      },
    )

    await request(app).get('/tags-fn')
    await new Promise((r) => setTimeout(r, 100))

    const members = await redisClient.smembers('adaptive:tag:express-dynamic-tag')
    expect(members.length).toBe(1)
  })

  it('should use default cache time when not provided', async () => {
    const app = express()

    // Call without arguments to trigger default parameter
    app.get('/default-cache', cacheModule.adaptiveExpressCache(cacheModule.cache()), (req, res) => {
      res.json({ ok: true })
    })

    app.get('/default-cache-success', cacheModule.adaptiveExpressCache(cacheModule.cache()), (req, res) => {
      res.json({ ok: true })
    })

    await request(app).get('/default-cache').expect(200)
    await request(app).get('/default-cache-success').expect(200)
  })
})
