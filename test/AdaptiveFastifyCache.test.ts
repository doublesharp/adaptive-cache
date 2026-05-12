import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import Fastify from 'fastify'
import Redis from 'ioredis'

let cacheModule: typeof import('../src')
let redisClient: Redis
let container: StartedTestContainer

describe('Adaptive Fastify Cache', () => {
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()

    const host = container.getHost()
    const port = container.getMappedPort(6379)

    process.env.REDIS_HOST = host
    process.env.REDIS_PORT = port.toString()

    cacheModule = await import('../src/index')
    redisClient = cacheModule.redis
  })

  afterAll(async () => {
    if (redisClient) await redisClient.quit()
    if (container) await container.stop()
  })

  beforeEach(async () => {
    await redisClient.flushall()
    vi.restoreAllMocks()
  })

  it('should cache successful responses', async () => {
    const fastify = Fastify()
    let callCount = 0

    fastify.register(cacheModule.adaptiveFastifyCache(cacheModule.cache('10 seconds')))

    fastify.get('/test', async () => {
      callCount++
      return { value: 'success' }
    })

    const res1 = await fastify.inject({ method: 'GET', url: '/test' })
    expect(res1.statusCode).toBe(200)
    expect(callCount).toBe(1)
    expect(res1.headers['x-cache']).toBe('MISS')

    // Wait for async cache
    await new Promise((r) => setTimeout(r, 100))

    const res2 = await fastify.inject({ method: 'GET', url: '/test' })
    expect(res2.statusCode).toBe(200)
    expect(callCount).toBe(1)
    expect(res2.headers['x-cache']).toBe('HIT')
    expect(JSON.parse(res2.payload)).toEqual({ value: 'success' })
  })

  it('should support tags', async () => {
    const fastify = Fastify()
    fastify.register(cacheModule.adaptiveFastifyCache({ tags: ['fastify-tag'] }))

    fastify.get('/tags', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/tags' })
    await new Promise((r) => setTimeout(r, 100))

    const members = await redisClient.smembers('adaptive:tag:fastify-tag')
    expect(members.length).toBe(1)
  })

  it('should handle query parameters correctly', async () => {
    const fastify = Fastify()
    let callCount = 0

    fastify.register(cacheModule.adaptiveFastifyCache())

    fastify.get('/query', async (req) => {
      callCount++
      return { q: (req.query as any).q }
    })

    await fastify.inject({ method: 'GET', url: '/query?q=1' })
    await new Promise((r) => setTimeout(r, 50))

    await fastify.inject({ method: 'GET', url: '/query?q=1' })
    expect(callCount).toBe(1)

    await fastify.inject({ method: 'GET', url: '/query?q=2' })
    expect(callCount).toBe(2)
  })

  it('should force refresh via query param', async () => {
    const fastify = Fastify()
    let callCount = 0

    fastify.register(cacheModule.adaptiveFastifyCache())

    fastify.get('/refresh', async () => {
      callCount++
      return { count: callCount }
    })

    await fastify.inject({ method: 'GET', url: '/refresh' })
    await new Promise((r) => setTimeout(r, 50))

    const res = await fastify.inject({ method: 'GET', url: '/refresh?refresh=true' })
    expect(res.headers['x-cache']).toBe('BYPASS')
    expect(callCount).toBe(2)
  })

  it('should handle maxTTL as a function and parse JSON payload', async () => {
    const fastify = Fastify()
    fastify.register(
      cacheModule.adaptiveFastifyCache({
        maxTTL: (body) => {
          return body.ttl
        },
      }),
    )

    fastify.get('/maxttl', async () => {
      return { ttl: 20 }
    })

    await fastify.inject({ method: 'GET', url: '/maxttl' })
    await new Promise((r) => setTimeout(r, 100))
    // We can't easily verify the TTL set in Redis without checking the key, but this covers the code path
  })

  it('should use default maxTTL if function returns undefined', async () => {
    const { Logger } = await import('../src/lib/logger')
    const debugSpy = vi.spyOn(Logger.prototype, 'debug')

    const fastify = Fastify()
    fastify.register(
      cacheModule.adaptiveFastifyCache({
        maxTTL: () => undefined,
        logLevel: 'debug',
      }),
    )

    fastify.get('/maxttl-default', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/maxttl-default' })
    await new Promise((r) => setTimeout(r, 100))

    expect(debugSpy).toHaveBeenCalledWith('Overriding maxTTL:', 900)
  })

  it('should handle cache update failure', async () => {
    const { Logger } = await import('../src/lib/logger')
    const errorSpy = vi.spyOn(Logger.prototype, 'error')

    const fastify = Fastify()
    // Mock adaptiveCacheUpdate to throw
    vi.spyOn(cacheModule.getDefaultCache().client, 'adaptiveCacheUpdate').mockRejectedValue(new Error('Update failed'))

    fastify.register(cacheModule.adaptiveFastifyCache())

    fastify.get('/update-fail', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/update-fail' })
    await new Promise((r) => setTimeout(r, 100))

    expect(errorSpy).toHaveBeenCalledWith('Cache update failed:', expect.any(Error))
  })

  it('should handle cache fetch failure', async () => {
    const { Logger } = await import('../src/lib/logger')
    const warnSpy = vi.spyOn(Logger.prototype, 'warn')

    const fastify = Fastify()
    // Mock get to throw
    vi.spyOn(cacheModule.AdaptiveCache.prototype, 'get').mockRejectedValue(new Error('Get failed'))

    fastify.register(cacheModule.adaptiveFastifyCache())

    fastify.get('/fetch-fail', async () => {
      return { ok: true }
    })

    const res = await fastify.inject({ method: 'GET', url: '/fetch-fail' })
    expect(res.headers['x-cache']).toBe('RETRY')
    expect(warnSpy).toHaveBeenCalledWith('adaptiveCache failed to fetch data:', expect.any(Error))
  })

  it('should respect includeHeaders: false', async () => {
    const fastify = Fastify()
    fastify.register(cacheModule.adaptiveFastifyCache({ includeHeaders: false }))

    fastify.get('/no-headers', async () => {
      return { ok: true }
    })

    const res = await fastify.inject({ method: 'GET', url: '/no-headers' })
    expect(res.headers['x-cache']).toBeUndefined()
  })

  it('should set default lock expiration', async () => {
    const spy = vi.spyOn(cacheModule.AdaptiveCache, 'setDefaultLockExpirationSeconds')
    const fastify = Fastify()
    fastify.register(cacheModule.adaptiveFastifyCache({ lockExpirationSeconds: 99 }))
    expect(spy).toHaveBeenCalledWith(99)
  })

  it('should handle maxTTL as a function returning a value', async () => {
    const { Logger } = await import('../src/lib/logger')
    const debugSpy = vi.spyOn(Logger.prototype, 'debug')

    const fastify = Fastify()
    fastify.register(
      cacheModule.adaptiveFastifyCache({
        maxTTL: (_body) => {
          return 123 // Return a specific TTL
        },
        logLevel: 'debug',
      }),
    )

    fastify.get('/maxttl-fn', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/maxttl-fn' })
    await new Promise((r) => setTimeout(r, 100))

    expect(debugSpy).toHaveBeenCalledWith('Overriding maxTTL:', 123)
  })

  it('should handle tags as a function', async () => {
    const fastify = Fastify()
    fastify.register(
      cacheModule.adaptiveFastifyCache({
        tags: (_req) => {
          return ['dynamic-tag']
        },
      }),
    )

    fastify.get('/tags-fn', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/tags-fn' })
    await new Promise((r) => setTimeout(r, 100))

    const members = await redisClient.smembers('adaptive:tag:dynamic-tag')
    expect(members.length).toBe(1)
  })

  it('should handle invalid JSON payload when maxTTL is a function', async () => {
    const fastify = Fastify()
    fastify.register(
      cacheModule.adaptiveFastifyCache({
        maxTTL: () => 100,
      }),
    )

    fastify.get('/invalid-json', async (req, reply) => {
      reply.header('Content-Type', 'text/plain')
      return 'invalid-json-string'
    })

    await fastify.inject({ method: 'GET', url: '/invalid-json' })
    await new Promise((r) => setTimeout(r, 100))
  })

  it('should not cache non-success responses (status >= 300)', async () => {
    const fastify = Fastify()
    fastify.register(cacheModule.adaptiveFastifyCache())

    const spy = vi.spyOn(cacheModule.AdaptiveCache.prototype, 'set')

    fastify.get('/error', async (req, reply) => {
      reply.code(500)
      return { error: true }
    })

    await fastify.inject({ method: 'GET', url: '/error' })

    expect(spy).not.toHaveBeenCalled()
  })

  it('should handle JSON parse error in onSend when maxTTL is function', async () => {
    const fastify = Fastify()
    fastify.register(
      cacheModule.adaptiveFastifyCache({
        maxTTL: () => 100,
      }),
    )

    fastify.get('/bad-json', async (req, reply) => {
      reply.header('content-type', 'application/json')
      return '{"invalid": json'
    })

    await fastify.inject({ method: 'GET', url: '/bad-json' })
  })

  it('should handle onRequest failure (get throws)', async () => {
    const fastify = Fastify()
    fastify.register(cacheModule.adaptiveFastifyCache())

    // Mock get to throw
    vi.spyOn(cacheModule.AdaptiveCache.prototype, 'get').mockRejectedValue(new Error('Get failed'))

    const res = await fastify.inject({ method: 'GET', url: '/fail' })
    expect(res.headers['x-cache']).toBe('RETRY')
  })

  it('should include debug headers when configured', async () => {
    const fastify = Fastify()
    fastify.register(cacheModule.adaptiveFastifyCache({ includeDebugHeaders: true }))

    fastify.get('/debug', async () => {
      return { ok: true }
    })

    // First request (MISS)
    await fastify.inject({ method: 'GET', url: '/debug' })

    // Wait for cache
    await new Promise((r) => setTimeout(r, 100))

    // Second request (HIT)
    const res = await fastify.inject({ method: 'GET', url: '/debug' })

    expect(res.headers['x-cache']).toBe('HIT')
    expect(res.headers['x-cache-data-ttl']).toBeDefined()
    expect(res.headers['x-cache-last-modified']).toBeDefined()
    expect(res.headers['x-cache-refreshed']).toBeDefined()
  })

  it('should respect includeHeaders: false on HIT', async () => {
    const fastify = Fastify()
    fastify.register(cacheModule.adaptiveFastifyCache({ includeHeaders: false }))

    fastify.get('/no-headers-hit', async () => {
      return { ok: true }
    })

    // First request
    await fastify.inject({ method: 'GET', url: '/no-headers-hit' })

    // Wait
    await new Promise((r) => setTimeout(r, 100))

    // Second request (HIT)
    const res = await fastify.inject({ method: 'GET', url: '/no-headers-hit' })

    expect(res.headers['x-cache']).toBeUndefined()
    expect(JSON.parse(res.payload)).toEqual({ ok: true })
  })

  it('should handle missing lastChanged in metadata', async () => {
    const fastify = Fastify()
    fastify.register(cacheModule.adaptiveFastifyCache({ includeDebugHeaders: true }))

    // Mock get to return metadata without lastChanged
    vi.spyOn(cacheModule.AdaptiveCache.prototype, 'get').mockResolvedValue({
      ttl: 100,
      data: { ok: true },
      metadata: {
        dataTTL: 100,
        changeCount: 1,
        // lastChanged missing
      } as any,
    })

    fastify.get('/missing-meta', async () => {
      return { ok: true }
    })

    const res = await fastify.inject({ method: 'GET', url: '/missing-meta' })

    expect(res.headers['x-cache-last-modified']).toBe('unknown')
  })

  it('should handle invalid tags type', async () => {
    const fastify = Fastify()
    // @ts-expect-error invalid tags type
    fastify.register(cacheModule.adaptiveFastifyCache({ tags: 'invalid' }))

    fastify.get('/invalid-tags', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/invalid-tags' })
  })
})
