import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { adaptiveExpressCache, adaptiveFastifyCache, clearAdaptiveCache, AdaptiveCacheOptions } from '../src'

const namespace = (name: string) => `adaptive-cache-middleware-${name}-${Date.now()}-${Math.random()}`

const lruOptions = (name: string): AdaptiveCacheOptions => ({
  backend: 'clustered-lru',
  includeDebugHeaders: true,
  initialTTL: 3,
  maxTTL: 30,
  lru: {
    namespace: namespace(name),
    maxSizeBytes: 1024 * 1024,
  },
})

const callExpress = async (
  middleware: ReturnType<typeof adaptiveExpressCache>,
  handler: (req: any, res: any) => void,
  url: string,
  query: Record<string, string> = {},
) => {
  const headers: Record<string, string> = {}
  const req = { originalUrl: url, query }
  const res = {
    statusCode: 200,
    body: undefined as any,
    set: (key: string, value: string) => {
      headers[key.toLowerCase()] = value
    },
    send(body: any) {
      this.body = body
      return this
    },
    json(body: any) {
      return this.send(body)
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
  }

  await middleware(req as any, res as any, () => handler(req, res))
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { headers, body: res.body, statusCode: res.statusCode }
}

describe('Express clustered LRU middleware', () => {
  it('should miss, write to LRU, hit, force bypass, and clear without Redis', async () => {
    const options = lruOptions('express')
    options.lockExpirationSeconds = 9
    const middleware = adaptiveExpressCache(options)
    let calls = 0

    const handler = (_req: any, res: any) => {
      calls += 1
      res.json({ calls })
    }

    const miss = await callExpress(middleware, handler, '/items?q=1', { q: '1' })
    expect(miss.headers['x-cache']).toBe('MISS')
    expect(miss.body).toEqual({ calls: 1 })

    const hit = await callExpress(middleware, handler, '/items?q=1', { q: '1' })
    expect(hit.headers['x-cache']).toBe('HIT')
    expect(hit.headers['x-cache-data-ttl']).toBeDefined()
    expect(hit.body).toEqual({ calls: 1 })

    const bypass = await callExpress(middleware, handler, '/items?q=1&refresh=true', { q: '1', refresh: 'true' })
    expect(bypass.headers['x-cache']).toBe('BYPASS')
    expect(bypass.body).toEqual({ calls: 2 })

    await clearAdaptiveCache('/items', { q: '1' }, 'adaptive:', options)

    const afterClear = await callExpress(middleware, handler, '/items?q=1', { q: '1' })
    expect(afterClear.headers['x-cache']).toBe('MISS')
    expect(afterClear.body).toEqual({ calls: 3 })
  })

  it('should not cache errors and should support dynamic maxTTL and no headers', async () => {
    const options = lruOptions('express-dynamic')
    const dynamic = adaptiveExpressCache({
      ...options,
      includeHeaders: false,
      maxTTL: (body) => (typeof body === 'string' && body.includes('stable') ? 20 : undefined),
      tags: (req) => [`query:${req.query.id}`],
    })
    const error = adaptiveExpressCache(options)
    const stringResponse = adaptiveExpressCache({
      ...lruOptions('express-string'),
      maxTTL: (body) => (typeof body === 'string' && body.includes('stable') ? 20 : undefined),
      tags: ['static-tag'],
    })
    let calls = 0

    const dynamicHandler = (req: any, res: any) => {
      calls += 1
      res.json({ id: req.query.id, value: 'stable', calls })
    }
    const errorHandler = (_req: any, res: any) => {
      res.status(500).json({ error: true })
    }
    const stringHandler = (_req: any, res: any) => {
      res.send(JSON.stringify('stable'))
    }

    const first = await callExpress(dynamic, dynamicHandler, '/dynamic?id=1', { id: '1' })
    expect(first.headers['x-cache']).toBeUndefined()
    expect(first.body.calls).toBe(1)

    const second = await callExpress(dynamic, dynamicHandler, '/dynamic?id=1', { id: '1' })
    expect(second.body.calls).toBe(1)

    await callExpress(error, errorHandler, '/error')
    const secondError = await callExpress(error, errorHandler, '/error')
    expect(secondError.statusCode).toBe(500)
    expect(secondError.headers['x-cache']).toBe('MISS')

    const stringFirst = await callExpress(stringResponse, stringHandler, '/string')
    expect(stringFirst.headers['x-cache']).toBe('MISS')
    const stringSecond = await callExpress(stringResponse, stringHandler, '/string')
    expect(stringSecond.headers['x-cache']).toBe('HIT')
    expect(stringSecond.body).toBe('stable')
  })

  it('should continue on backend fetch failures and retry when cached response send fails', async () => {
    const failingFetch = adaptiveExpressCache({
      backend: {
        name: 'custom',
        fetch: async () => {
          throw new Error('fetch failed')
        },
        update: async () => ['CACHED', 1],
        clear: async () => undefined,
        invalidateTags: async () => [],
        shouldRefresh: async () => ['UPDATE', 'lock'],
        releaseLock: async () => ['UPDATED'],
      },
    })

    const failedFetch = await callExpress(failingFetch, (_req, res) => res.json({ from: 'handler' }), '/fetch-failure')
    expect(failedFetch.headers['x-cache']).toBe('RETRY')
    expect(failedFetch.body).toEqual({ from: 'handler' })

    const cachedHit = adaptiveExpressCache({
      backend: {
        name: 'custom',
        fetch: async () => ({
          encodedData: JSON.stringify({ cached: true }),
          ttl: 10,
          metadata: { dataTTL: 10, lastChanged: 1, changeCount: 1 },
        }),
        update: async () => ['CACHED', 1],
        clear: async () => undefined,
        invalidateTags: async () => [],
        shouldRefresh: async () => ['UPDATE', 'lock'],
        releaseLock: async () => ['UPDATED'],
      },
      compress: false,
      includeDebugHeaders: true,
    })
    const headers: Record<string, string> = {}
    let throws = true
    const res = {
      statusCode: 200,
      body: undefined as any,
      set: (key: string, value: string) => {
        headers[key.toLowerCase()] = value
      },
      send(body: any) {
        if (throws) {
          throws = false
          throw new Error('send failed')
        }
        this.body = body
        return this
      },
      json(body: any) {
        return this.send(body)
      },
    }

    await cachedHit({ originalUrl: '/cached', query: {} } as any, res as any, () => {
      res.json({ retried: true })
    })

    expect(headers['x-cache']).toBe('RETRY')
    expect(res.body).toEqual({ retried: true })
  })

  it('should handle cache hits with no metadata and unknown last modified metadata', async () => {
    const noMetadata = adaptiveExpressCache({
      backend: {
        name: 'custom',
        fetch: async () => ({
          encodedData: JSON.stringify({ cached: 'no-metadata' }),
          ttl: 10,
        }),
        update: async () => ['CACHED', 1],
        clear: async () => undefined,
        invalidateTags: async () => [],
        shouldRefresh: async () => ['UPDATE', 'lock'],
        releaseLock: async () => ['UPDATED'],
      },
      compress: false,
      includeDebugHeaders: true,
    })
    const noMetadataResponse = await callExpress(noMetadata, (_req, res) => res.json({ from: 'handler' }), '/hit')

    expect(noMetadataResponse.headers['x-cache']).toBe('HIT')
    expect(noMetadataResponse.headers['x-cache-data-ttl']).toBeUndefined()
    expect(noMetadataResponse.body).toEqual({ cached: 'no-metadata' })

    const unknownLastModified = adaptiveExpressCache({
      backend: {
        name: 'custom',
        fetch: async () => ({
          encodedData: JSON.stringify({ cached: 'unknown-last-modified' }),
          ttl: 10,
          metadata: { dataTTL: 10, changeCount: 1 },
        }),
        update: async () => ['CACHED', 1],
        clear: async () => undefined,
        invalidateTags: async () => [],
        shouldRefresh: async () => ['UPDATE', 'lock'],
        releaseLock: async () => ['UPDATED'],
      },
      compress: false,
      includeDebugHeaders: true,
    })
    const unknownResponse = await callExpress(
      unknownLastModified,
      (_req, res) => res.json({ from: 'handler' }),
      '/hit-unknown',
    )

    expect(unknownResponse.headers['x-cache-last-modified']).toBe('unknown')
    expect(unknownResponse.body).toEqual({ cached: 'unknown-last-modified' })
  })

  it('should log async update failures after successful responses', async () => {
    const middleware = adaptiveExpressCache({
      backend: {
        name: 'custom',
        fetch: async () => null,
        update: async () => {
          throw new Error('update failed')
        },
        clear: async () => undefined,
        invalidateTags: async () => [],
        shouldRefresh: async () => ['UPDATE', 'lock'],
        releaseLock: async () => ['UPDATED'],
      },
    })

    const response = await callExpress(middleware, (_req, res) => res.json({ ok: true }), '/update-failure')

    expect(response.headers['x-cache']).toBe('MISS')
    expect(response.body).toEqual({ ok: true })
  })

  it('should ignore unsupported truthy tag values at runtime', async () => {
    const middleware = adaptiveExpressCache({
      ...lruOptions('express-invalid-tags'),
      tags: 'invalid-tags' as any,
    })

    const response = await callExpress(middleware, (_req, res) => res.json({ ok: true }), '/invalid-tags')

    expect(response.headers['x-cache']).toBe('MISS')
    expect(response.body).toEqual({ ok: true })
  })
})

describe('Fastify clustered LRU middleware', () => {
  it('should miss, write to LRU, hit, and force bypass without Redis', async () => {
    const fastify = Fastify()
    let calls = 0

    await fastify.register(adaptiveFastifyCache({ ...lruOptions('fastify'), lockExpirationSeconds: 9 }))
    fastify.get('/items', async () => {
      calls += 1
      return { calls }
    })

    const miss = await fastify.inject({ method: 'GET', url: '/items?q=1' })
    expect(miss.headers['x-cache']).toBe('MISS')
    expect(miss.json()).toEqual({ calls: 1 })

    const hit = await fastify.inject({ method: 'GET', url: '/items?q=1' })
    expect(hit.headers['x-cache']).toBe('HIT')
    expect(hit.headers['x-cache-data-ttl']).toBeDefined()
    expect(hit.json()).toEqual({ calls: 1 })

    const bypass = await fastify.inject({ method: 'GET', url: '/items?q=1&refresh=true' })
    expect(bypass.headers['x-cache']).toBe('BYPASS')
    expect(bypass.json()).toEqual({ calls: 2 })

    await fastify.close()
  })

  it('should support dynamic maxTTL, tags, disabled headers, and non-success responses', async () => {
    const fastify = Fastify()
    let calls = 0

    await fastify.register(
      adaptiveFastifyCache({
        ...lruOptions('fastify-dynamic'),
        includeHeaders: false,
        maxTTL: (body) => (body && body.value === 'stable' ? 20 : undefined),
        tags: (req) => [`query:${(req.query as any).id}`],
      }),
    )
    fastify.get('/dynamic', async (req) => {
      calls += 1
      return { id: (req.query as any).id, value: 'stable', calls }
    })
    fastify.get('/error', async (_req, reply) => {
      reply.status(500)
      return { error: true }
    })

    const first = await fastify.inject({ method: 'GET', url: '/dynamic?id=1' })
    expect(first.headers['x-cache']).toBeUndefined()
    expect(first.json().calls).toBe(1)

    const second = await fastify.inject({ method: 'GET', url: '/dynamic?id=1' })
    expect(second.json().calls).toBe(1)

    await fastify.inject({ method: 'GET', url: '/error' })
    const secondError = await fastify.inject({ method: 'GET', url: '/error' })
    expect(secondError.statusCode).toBe(500)

    await fastify.close()

    const fastifyStatic = Fastify()
    await fastifyStatic.register(
      adaptiveFastifyCache({
        ...lruOptions('fastify-string'),
        maxTTL: () => undefined,
        tags: ['static-tag'],
      }),
    )
    fastifyStatic.get('/string', async () => '"stable"')

    const stringResponse = await fastifyStatic.inject({ method: 'GET', url: '/string' })
    expect(stringResponse.statusCode).toBe(200)

    await fastifyStatic.close()
  })

  it('should continue on fetch failures and log async update failures', async () => {
    const fastify = Fastify()

    await fastify.register(
      adaptiveFastifyCache({
        backend: {
          name: 'custom',
          fetch: async () => {
            throw new Error('fetch failed')
          },
          update: async () => {
            throw new Error('update failed')
          },
          clear: async () => undefined,
          invalidateTags: async () => [],
          shouldRefresh: async () => ['UPDATE', 'lock'],
          releaseLock: async () => ['UPDATED'],
        },
      }),
    )
    fastify.get('/failure', async () => ({ ok: true }))

    const response = await fastify.inject({ method: 'GET', url: '/failure' })

    expect(response.headers['x-cache']).toBe('RETRY')
    expect(response.json()).toEqual({ ok: true })

    await fastify.close()
  })

  it('should handle cache hits without metadata and with unknown last modified metadata', async () => {
    const noMetadata = Fastify()
    await noMetadata.register(
      adaptiveFastifyCache({
        backend: {
          name: 'custom',
          fetch: async () => ({
            encodedData: JSON.stringify({ cached: 'no-metadata' }),
            ttl: 10,
          }),
          update: async () => ['CACHED', 1],
          clear: async () => undefined,
          invalidateTags: async () => [],
          shouldRefresh: async () => ['UPDATE', 'lock'],
          releaseLock: async () => ['UPDATED'],
        },
        compress: false,
        includeDebugHeaders: true,
      }),
    )
    noMetadata.get('/hit', async () => ({ from: 'handler' }))

    const noMetadataResponse = await noMetadata.inject({ method: 'GET', url: '/hit' })
    expect(noMetadataResponse.headers['x-cache']).toBe('HIT')
    expect(noMetadataResponse.headers['x-cache-data-ttl']).toBeUndefined()
    expect(noMetadataResponse.json()).toEqual({ cached: 'no-metadata' })
    await noMetadata.close()

    const unknownLastModified = Fastify()
    await unknownLastModified.register(
      adaptiveFastifyCache({
        backend: {
          name: 'custom',
          fetch: async () => ({
            encodedData: JSON.stringify({ cached: 'unknown-last-modified' }),
            ttl: 10,
            metadata: { dataTTL: 10, changeCount: 1 },
          }),
          update: async () => ['CACHED', 1],
          clear: async () => undefined,
          invalidateTags: async () => [],
          shouldRefresh: async () => ['UPDATE', 'lock'],
          releaseLock: async () => ['UPDATED'],
        },
        compress: false,
        includeDebugHeaders: true,
      }),
    )
    unknownLastModified.get('/hit', async () => ({ from: 'handler' }))

    const unknownResponse = await unknownLastModified.inject({ method: 'GET', url: '/hit' })
    expect(unknownResponse.headers['x-cache-last-modified']).toBe('unknown')
    expect(unknownResponse.json()).toEqual({ cached: 'unknown-last-modified' })
    await unknownLastModified.close()
  })

  it('should ignore unsupported truthy tag values at runtime', async () => {
    const fastify = Fastify()
    await fastify.register(
      adaptiveFastifyCache({
        ...lruOptions('fastify-invalid-tags'),
        tags: 'invalid-tags' as any,
      }),
    )
    fastify.get('/invalid-tags', async () => ({ ok: true }))

    const response = await fastify.inject({ method: 'GET', url: '/invalid-tags' })

    expect(response.headers['x-cache']).toBe('MISS')
    expect(response.json()).toEqual({ ok: true })

    await fastify.close()
  })
})
