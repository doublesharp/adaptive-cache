import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { GenericContainer } from 'testcontainers'
import zlib from 'node:zlib'
import { adaptiveExpressCache, clearAdaptiveCache } from '../src/AdaptiveExpressCache'
import { encodeHttpResponse } from '../src/httpResponse'
import { getDefaultCache } from '../src/singleton'
import { getAdaptiveCacheKey as baseAdaptiveCacheKey } from '../src/utils'
import { ControlledBackend, controlledCache } from './helpers/httpFixtures'

const getAdaptiveCacheKey = (...args: Parameters<typeof baseAdaptiveCacheKey>) =>
  baseAdaptiveCacheKey(args[0], args[1], args[2], args[3], 'localhost:80')

describe('Express HTTP policy and lifecycle', () => {
  it('partitions a namespaced custom key by normalized declared headers', async () => {
    const { backend, cache } = controlledCache()
    const app = express()
    let calls = 0
    const middleware = adaptiveExpressCache({
      cache,
      keyPrefix: 'http:',
      key: (req) => req.params?.id || '',
      varyBy: ['X-Tenant', 'accept-language'],
    })

    app.get('/users/:id', middleware, (req, res) => {
      calls += 1
      res.set('Vary', 'Accept-Language, X-Tenant').json({ calls, id: req.params.id })
    })

    await request(app).get('/users/7').set('Host', 'localhost:80').set('X-Tenant', 'a').set('Accept-Language', 'en')
    await middleware.flush()
    await request(app).get('/users/7').set('Host', 'localhost:80').set('X-Tenant', 'b').set('Accept-Language', 'en')
    await middleware.flush()
    await request(app).get('/users/7').set('Host', 'localhost:80').set('X-Tenant', 'a').set('Accept-Language', 'fr')
    await middleware.flush()
    const hit = await request(app)
      .get('/users/7')
      .set('Host', 'localhost:80')
      .set('X-Tenant', 'a')
      .set('Accept-Language', 'en')

    expect(calls).toBe(3)
    expect(hit.headers['x-cache']).toBe('HIT')
    expect(hit.headers.vary).toBe('Accept-Language, X-Tenant')
    expect([...backend.entries.keys()]).toHaveLength(3)
    expect([...backend.entries.keys()].every((key) => key.startsWith('http:'))).toBe(true)
  })

  it('bypasses authenticated requests unless caller-owned isolation is configured', async () => {
    const { cache } = controlledCache()
    const app = express()
    let defaultCalls = 0
    let isolatedCalls = 0

    app.get('/default', adaptiveExpressCache({ cache }), (_req, res) => res.json({ call: ++defaultCalls }))
    const isolated = adaptiveExpressCache({
      cache,
      keyPrefix: 'auth:',
      cacheAuthenticated: true,
      key: (req) => String(req.headers.authorization),
    })
    app.get('/isolated', isolated, (_req, res) => res.json({ call: ++isolatedCalls }))

    const firstDefault = await request(app)
      .get('/default')
      .set('Host', 'localhost:80')
      .set('Authorization', 'Bearer one')
    const secondDefault = await request(app)
      .get('/default')
      .set('Host', 'localhost:80')
      .set('Authorization', 'Bearer one')
    await request(app).get('/isolated').set('Host', 'localhost:80').set('Authorization', 'Bearer one')
    await isolated.flush()
    const isolatedHit = await request(app)
      .get('/isolated')
      .set('Host', 'localhost:80')
      .set('Authorization', 'Bearer one')

    expect(firstDefault.headers['x-cache']).toBe('BYPASS')
    expect(secondDefault.headers['x-cache']).toBe('BYPASS')
    expect(defaultCalls).toBe(2)
    expect(isolatedHit.headers['x-cache']).toBe('HIT')
    expect(isolatedCalls).toBe(1)
  })

  it('bypasses authenticated Express requests when a custom key is missing', async () => {
    const { backend, cache } = controlledCache()
    const app = express()
    let calls = 0
    const middleware = adaptiveExpressCache({
      cache,
      cacheAuthenticated: true,
      includeHeaders: false,
      key: () => undefined as unknown as string,
    })
    app.get('/missing-key', middleware, (_req, res) => res.json({ call: ++calls }))

    const first = await request(app).get('/missing-key').set('Host', 'localhost:80').set('Authorization', 'Bearer one')
    const second = await request(app).get('/missing-key').set('Host', 'localhost:80').set('Authorization', 'Bearer two')

    expect(first.body).toEqual({ call: 1 })
    expect(second.body).toEqual({ call: 2 })
    expect(first.headers['x-cache']).toBeUndefined()
    expect(second.headers['x-cache']).toBeUndefined()
    expect(backend.entries.size).toBe(0)
  })

  it('applies shouldCache to both request reads and completed response writes', async () => {
    const { cache } = controlledCache()
    const app = express()
    let calls = 0
    const middleware = adaptiveExpressCache({
      cache,
      shouldCache: (req, response) => req.query.cache !== 'no' && response?.getHeader?.('x-skip-cache') !== 'yes',
    })
    app.get('/policy', middleware, (req, res) => {
      calls += 1
      if (req.query.response === 'skip') res.set('X-Skip-Cache', 'yes')
      res.json({ calls })
    })

    await request(app).get('/policy?cache=no').set('Host', 'localhost:80')
    await request(app).get('/policy?cache=no').set('Host', 'localhost:80')
    await request(app).get('/policy?response=skip').set('Host', 'localhost:80')
    await middleware.flush()
    await request(app).get('/policy?response=skip').set('Host', 'localhost:80')

    expect(calls).toBe(4)
  })

  it.each([
    ['Cache-Control: no-store', (res: express.Response) => res.set('Cache-Control', 'public, no-store')],
    ['Cache-Control: private', (res: express.Response) => res.set('Cache-Control', 'private, max-age=60')],
    ['Set-Cookie', (res: express.Response) => res.cookie('session', 'secret')],
    ['undeclared Vary', (res: express.Response) => res.set('Vary', 'X-Tenant')],
    ['Vary star', (res: express.Response) => res.set('Vary', '*')],
  ])('does not store responses with %s', async (_label, setUnsafeHeader) => {
    const { cache } = controlledCache()
    const app = express()
    let calls = 0
    const middleware = adaptiveExpressCache({ cache, varyBy: ['accept-language'] })
    app.get('/unsafe', middleware, (_req, res) => {
      calls += 1
      setUnsafeHeader(res).send(String(calls))
    })

    await request(app).get('/unsafe').set('Host', 'localhost:80')
    await middleware.flush()
    const second = await request(app).get('/unsafe').set('Host', 'localhost:80')

    expect(calls).toBe(2)
    expect(second.headers['x-cache']).toBe('MISS')
  })

  it('caches 404 responses only with a bounded negativeTTL', async () => {
    const without = controlledCache()
    const withNegative = controlledCache()
    const app = express()
    let withoutCalls = 0
    let withCalls = 0
    const normal = adaptiveExpressCache({ cache: without.cache })
    const negative = adaptiveExpressCache({ cache: withNegative.cache, negativeTTL: 20, maxTTL: 10 })
    app.get('/without', normal, (_req, res) => res.status(404).json({ call: ++withoutCalls }))
    app.get('/with', negative, (_req, res) => res.status(404).json({ call: ++withCalls }))

    await request(app).get('/without').set('Host', 'localhost:80')
    await normal.flush()
    await request(app).get('/without').set('Host', 'localhost:80')
    await request(app).get('/with').set('Host', 'localhost:80')
    await negative.flush()
    const hit = await request(app).get('/with').set('Host', 'localhost:80')

    expect(withoutCalls).toBe(2)
    expect(withCalls).toBe(1)
    expect(hit.status).toBe(404)
    expect(hit.headers['x-cache']).toBe('HIT')
    expect([...withNegative.backend.entries.values()][0].ttl).toBe(10)
  })

  it('rejects a private Express cache entry when response policy changes', async () => {
    const { cache } = controlledCache()
    const key = getAdaptiveCacheKey('/changed-response-policy', {}, 'adaptive:')
    await cache.set(key, encodeHttpResponse({ source: 'cached' }, 200, undefined, { 'cache-control': 'private' }))
    const middleware = adaptiveExpressCache({ cache })
    const app = express()
    app.get('/changed-response-policy', middleware, (_req, res) => res.json({ source: 'handler' }))

    const response = await request(app).get('/changed-response-policy').set('Host', 'localhost:80')

    expect(response.body).toEqual({ source: 'handler' })
    expect(response.headers['x-cache']).toBe('MISS')
  })

  it('exposes lifecycle helpers without closing an injected cache', async () => {
    const injected = controlledCache()
    const middleware = adaptiveExpressCache({ cache: injected.cache })

    expect(middleware.cache).toBe(injected.cache)
    await middleware.flush()
    await middleware.close()
    expect(injected.backend.flushCalls).toBe(1)
    expect(injected.backend.quitCalls).toBe(0)
  })

  it('serves the handler but skips writes when fencing capture fails', async () => {
    const { backend, cache } = controlledCache()
    backend.captureError = new Error('token transport failed')
    const middleware = adaptiveExpressCache({ cache })
    const app = express()
    let calls = 0
    app.get('/token-error', middleware, (_req, res) => res.json({ call: ++calls }))

    await request(app).get('/token-error').set('Host', 'localhost:80')
    await request(app).get('/token-error').set('Host', 'localhost:80')

    expect(calls).toBe(2)
    expect(backend.entries.size).toBe(0)
  })

  it('fails open when an Express request-policy callback throws', async () => {
    const { cache } = controlledCache()
    const middleware = adaptiveExpressCache({
      cache,
      shouldCache: () => {
        throw new Error('policy failed')
      },
    })
    const app = express()
    app.get('/policy-error', middleware, (_req, res) => res.json({ handler: true }))

    const response = await request(app).get('/policy-error').set('Host', 'localhost:80')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ handler: true })
    expect(response.headers['x-cache']).toBe('RETRY')
  })

  it('preserves an Express handler response when its response-policy callback throws', async () => {
    const { backend, cache } = controlledCache()
    const middleware = adaptiveExpressCache({
      cache,
      shouldCache: (_req, response) => {
        if (response) throw new Error('response policy failed')
        return true
      },
    })
    const app = express()
    let errorCalls = 0
    app.get('/response-policy-error', middleware, (_req, res) => res.json({ handler: true }))
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      errorCalls += 1
      if (!res.headersSent) res.status(500).json({ failed: true })
    })

    const response = await request(app).get('/response-policy-error').set('Host', 'localhost:80')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ handler: true })
    expect(errorCalls).toBe(0)
    expect(backend.entries.size).toBe(0)
  })

  it('closes an Express-owned custom backend once', async () => {
    const backend = new ControlledBackend()
    const middleware = adaptiveExpressCache({ backend, compress: false })

    await middleware.close()
    await middleware.close()

    expect(backend.quitCalls).toBe(1)
  })

  it('fences a delayed custom-prefix handler write across clearAdaptiveCache', async () => {
    const container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    const previousHost = process.env.REDIS_HOST
    const previousPort = process.env.REDIS_PORT
    process.env.REDIS_HOST = container.getHost()
    process.env.REDIS_PORT = String(container.getMappedPort(6379))

    const middleware = adaptiveExpressCache({ keyPrefix: 'custom:', compress: false })
    const app = express()
    let calls = 0
    let handlerStarted!: () => void
    let releaseHandler!: () => void
    const started = new Promise<void>((resolve) => (handlerStarted = resolve))
    const barrier = new Promise<void>((resolve) => (releaseHandler = resolve))
    app.get('/fenced', middleware, async (_req, res) => {
      calls += 1
      if (calls === 1) {
        handlerStarted()
        await barrier
      }
      res.json({ calls })
    })

    try {
      const firstRequest = request(app)
        .get('/fenced')
        .then((response) => response)
      await started
      await clearAdaptiveCache('/fenced', {}, 'custom:', {}, 'localhost:80')
      releaseHandler()
      await firstRequest
      await middleware.flush()
      const afterClear = await request(app).get('/fenced').set('Host', 'localhost:80')

      expect(calls).toBe(2)
      expect(afterClear.headers['x-cache']).toBe('MISS')
    } finally {
      releaseHandler()
      await middleware.close()
      await getDefaultCache().close()
      await container.stop()
      if (previousHost === undefined) delete process.env.REDIS_HOST
      else process.env.REDIS_HOST = previousHost
      if (previousPort === undefined) delete process.env.REDIS_PORT
      else process.env.REDIS_PORT = previousPort
    }
  })

  it('does not replay a transport Content-Encoding over an unencoded Express body', async () => {
    const { cache } = controlledCache()
    const app = express()
    app.use((req, res, next) => {
      const originalEnd = res.end
      res.end = function (chunk?: any, encoding?: any, callback?: any) {
        if (chunk && req.headers['accept-encoding']?.includes('gzip') && !res.getHeader('content-encoding')) {
          res.setHeader('Content-Encoding', 'gzip')
          res.setHeader('Vary', 'Accept-Encoding')
          res.removeHeader('Content-Length')
          chunk = zlib.gzipSync(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
        }
        return originalEnd.call(this, chunk, encoding, callback)
      }
      next()
    })
    const middleware = adaptiveExpressCache({ cache, varyBy: ['accept-encoding'] })
    let calls = 0
    app.get('/compressed', middleware, (_req, res) => res.type('text/plain').send(`body-${++calls}`))

    const first = await request(app).get('/compressed').set('Host', 'localhost:80').set('Accept-Encoding', 'gzip')
    await middleware.flush()
    const hit = await request(app).get('/compressed').set('Host', 'localhost:80').set('Accept-Encoding', 'gzip')

    expect(first.text).toBe('body-1')
    expect(hit.text).toBe('body-1')
    expect(calls).toBe(1)
  })

  it('preserves an explicitly precompressed Express response encoding', async () => {
    const { cache } = controlledCache()
    const app = express()
    app.use((req, res, next) => {
      const originalEnd = res.end
      res.end = function (chunk?: any, encoding?: any, callback?: any) {
        if (chunk && req.headers['accept-encoding']?.includes('gzip') && !res.getHeader('content-encoding')) {
          res.setHeader('Content-Encoding', 'gzip')
          res.removeHeader('Content-Length')
          chunk = zlib.gzipSync(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
        }
        return originalEnd.call(this, chunk, encoding, callback)
      }
      next()
    })
    const middleware = adaptiveExpressCache({ cache, varyBy: ['accept-encoding'] })
    let calls = 0
    app.get('/precompressed', middleware, (_req, res) => {
      calls += 1
      res
        .set('Content-Encoding', 'gzip')
        .type('text/plain')
        .send(zlib.gzipSync(Buffer.from('precompressed')))
    })

    const first = await request(app).get('/precompressed').set('Host', 'localhost:80').set('Accept-Encoding', 'gzip')
    await middleware.flush()
    const hit = await request(app).get('/precompressed').set('Host', 'localhost:80').set('Accept-Encoding', 'gzip')

    expect(first.text).toBe('precompressed')
    expect(hit.text).toBe('precompressed')
    expect(hit.headers['content-encoding']).toBe('gzip')
    expect(calls).toBe(1)
  })
})
