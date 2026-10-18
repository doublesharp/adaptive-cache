import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { adaptiveExpressCache } from '../src/AdaptiveExpressCache'
import { encodeHttpResponse } from '../src/httpResponse'
import { getAdaptiveCacheKey as baseAdaptiveCacheKey } from '../src/utils'
import {
  ControlledBackend,
  controlledCache,
  queueStaleThenUnsafeResponse,
  queueStaleThenLegacyResponse,
} from './helpers/httpFixtures'

const getAdaptiveCacheKey = (...args: Parameters<typeof baseAdaptiveCacheKey>) =>
  baseAdaptiveCacheKey(args[0], args[1], args[2], args[3], 'localhost:80')

describe('Express HTTP loaders', () => {
  it('serves stale loader data while explicit regeneration runs', async () => {
    const { backend, cache } = controlledCache()
    let loaderCalls = 0
    let releaseRefresh!: () => void
    let refreshStarted!: () => void
    const refreshHasStarted = new Promise<void>((resolve) => (refreshStarted = resolve))
    const refreshBarrier = new Promise<void>((resolve) => (releaseRefresh = resolve))
    const middleware = adaptiveExpressCache({
      cache,
      staleWhileRevalidate: 30,
      loader: async () => {
        loaderCalls += 1
        if (loaderCalls === 2) {
          refreshStarted()
          await refreshBarrier
        }
        return { version: loaderCalls }
      },
    })
    const app = express()
    let handlerCalls = 0
    app.get('/loader', middleware, (_req, res) => res.json({ handler: ++handlerCalls }))

    const first = await request(app).get('/loader').set('Host', 'localhost:80')
    await middleware.flush()
    backend.staleKeys.add([...backend.entries.keys()][0])
    const stale = await request(app).get('/loader').set('Host', 'localhost:80')
    await refreshHasStarted

    expect(first.body).toEqual({ version: 1 })
    expect(stale.body).toEqual({ version: 1 })
    expect(handlerCalls).toBe(0)
    expect(loaderCalls).toBe(2)

    releaseRefresh()
    await middleware.flush()
    const refreshed = await request(app).get('/loader').set('Host', 'localhost:80')
    expect(refreshed.body).toEqual({ version: 2 })
  })

  it('does not store loader results when response headers set Set-Cookie', async () => {
    const { backend, cache } = controlledCache()
    const app = express()
    let loaderCalls = 0
    app.use((_req, res, next) => {
      res.cookie('session', 'secret')
      next()
    })
    const middleware = adaptiveExpressCache({
      cache,
      loader: async () => ({ call: ++loaderCalls }),
    })
    app.get('/loader-cookie', middleware)

    await request(app).get('/loader-cookie').set('Host', 'localhost:80')
    await middleware.flush()
    await request(app).get('/loader-cookie').set('Host', 'localhost:80')

    expect(loaderCalls).toBe(2)
    expect(backend.entries.size).toBe(0)
  })

  it('resolves loader maxTTL callbacks against the raw payload', async () => {
    const { backend, cache } = controlledCache()
    const app = express()
    const middleware = adaptiveExpressCache({
      cache,
      maxTTL: (body) => body.ttl,
      loader: async () => ({ ttl: 17, value: 'raw' }),
    })
    app.get('/loader-ttl', middleware)

    await request(app).get('/loader-ttl').set('Host', 'localhost:80')
    await middleware.flush()

    expect([...backend.entries.values()][0].ttl).toBe(17)
  })

  it('preserves an injected cache TTL cap for Express handlers and loaders', async () => {
    const backend = new ControlledBackend()
    const cache = new AdaptiveCache({ backend, compress: false, initialTTL: 2, maxTTL: 2 })
    const app = express()
    const handlerMiddleware = adaptiveExpressCache({ cache })
    const loaderMiddleware = adaptiveExpressCache({ cache, loader: async () => ({ source: 'loader' }) })
    app.get('/injected-handler-cap', handlerMiddleware, (_req, res) => res.json({ source: 'handler' }))
    app.get('/injected-loader-cap', loaderMiddleware)

    await request(app).get('/injected-handler-cap').set('Host', 'localhost:80')
    await handlerMiddleware.flush()
    await request(app).get('/injected-loader-cap').set('Host', 'localhost:80')

    expect(backend.updateInputs.at(-2)?.maxTTL).toBe(2)
    expect(backend.updateInputs.at(-1)?.maxTTL).toBe(2)
  })

  it('applies fixed TTL and array tags to forced Express loader refreshes', async () => {
    const { backend, cache } = controlledCache()
    const key = getAdaptiveCacheKey('/forced-loader', {}, 'adaptive:')
    await cache.set(key, encodeHttpResponse({ source: 'old' }, 200))
    const middleware = adaptiveExpressCache({
      cache,
      forceRefresh: true,
      maxTTL: 12,
      tags: ['forced'],
      loader: async () => ({ source: 'new' }),
    })
    const app = express()
    app.get('/forced-loader', middleware)

    const response = await request(app).get('/forced-loader').set('Host', 'localhost:80')

    expect(response.body).toEqual({ source: 'new' })
    expect(response.headers['x-cache']).toBe('BYPASS')
    expect(backend.updateInputs.at(-1)?.maxTTL).toBe(12)
    expect(backend.updateInputs.at(-1)?.tags).toEqual(['forced'])
  })

  it('serves Express loader hits without headers after a fallback TTL and function tags write', async () => {
    const { backend, cache } = controlledCache()
    let loaderCalls = 0
    const middleware = adaptiveExpressCache({
      cache,
      includeHeaders: false,
      maxTTL: () => Number.NaN,
      tags: () => ['dynamic'],
      loader: async () => ({ call: ++loaderCalls }),
    })
    const app = express()
    app.get('/quiet-loader', middleware)

    await request(app).get('/quiet-loader').set('Host', 'localhost:80')
    const hit = await request(app).get('/quiet-loader').set('Host', 'localhost:80')

    expect(hit.body).toEqual({ call: 1 })
    expect(hit.headers['x-cache']).toBeUndefined()
    expect(loaderCalls).toBe(1)
    expect(backend.updateInputs.at(-1)?.maxTTL).toBe(60)
    expect(backend.updateInputs.at(-1)?.tags).toEqual(['dynamic'])
  })

  it('rejects an unsafe stale loader entry before regeneration', async () => {
    const { backend, cache } = controlledCache()
    const key = getAdaptiveCacheKey('/loader-policy', {}, 'adaptive:')
    await cache.set(
      key,
      encodeHttpResponse({ source: 'private' }, 200, 'application/json', {
        'cache-control': 'private',
      }),
    )
    backend.staleKeys.add(key)
    let loaderCalls = 0
    const middleware = adaptiveExpressCache({
      cache,
      staleWhileRevalidate: 30,
      loader: async () => ({ source: `loader-${++loaderCalls}` }),
    })
    const app = express()
    app.get('/loader-policy', middleware)

    const response = await request(app).get('/loader-policy').set('Host', 'localhost:80')

    expect(response.body).toEqual({ source: 'loader-1' })
    expect(loaderCalls).toBe(1)
  })

  it('rejects a newly raced private loader entry before serving it', async () => {
    const { backend, cache } = controlledCache()
    await queueStaleThenUnsafeResponse(backend, cache, '/loader-policy-race')
    let loaderCalls = 0
    const middleware = adaptiveExpressCache({
      cache,
      staleWhileRevalidate: 30,
      loader: async () => ({ source: `loader-${++loaderCalls}` }),
    })
    const app = express()
    app.get('/loader-policy-race', middleware)

    const response = await request(app).get('/loader-policy-race').set('Host', 'localhost:80')

    expect(response.body).toEqual({ source: 'loader-1' })
    expect(loaderCalls).toBe(1)
    expect(backend.entries.size).toBe(0)
  })

  it('serves a legacy Express value that races a stale loader read', async () => {
    const { backend, cache } = controlledCache()
    await queueStaleThenLegacyResponse(backend, cache, '/legacy-loader-race')
    const middleware = adaptiveExpressCache({
      cache,
      staleWhileRevalidate: 30,
      loader: async () => ({ source: 'loader' }),
    })
    const app = express()
    app.get('/legacy-loader-race', middleware)

    const response = await request(app).get('/legacy-loader-race').set('Host', 'localhost:80')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ source: 'legacy-racer' })
  })

  it('serves a fresh legacy Express loader entry with the existing response status', async () => {
    const { cache } = controlledCache()
    const key = getAdaptiveCacheKey('/legacy-loader-hit', {}, 'adaptive:')
    await cache.set(key, { source: 'legacy-hit' })
    const middleware = adaptiveExpressCache({ cache, loader: async () => ({ source: 'loader' }) })
    const app = express()
    app.get('/legacy-loader-hit', middleware)

    const response = await request(app).get('/legacy-loader-hit').set('Host', 'localhost:80')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ source: 'legacy-hit' })
    expect(response.headers['x-cache']).toBe('HIT')
  })

  it('keeps regenerated Express metadata separate from a stale response being served', async () => {
    const { backend, cache } = controlledCache()
    const key = getAdaptiveCacheKey('/loader-metadata', {}, 'adaptive:')
    await cache.set(key, encodeHttpResponse({ source: 'old' }, 202, 'application/json', { 'content-language': 'old' }))
    backend.staleKeys.add(key)
    let refreshStarted!: () => void
    let releaseRefresh!: () => void
    const started = new Promise<void>((resolve) => (refreshStarted = resolve))
    const barrier = new Promise<void>((resolve) => (releaseRefresh = resolve))
    const middleware = adaptiveExpressCache({
      cache,
      staleWhileRevalidate: 30,
      loader: async () => {
        refreshStarted()
        await barrier
        return { source: 'new' }
      },
    })
    const app = express()
    app.get('/loader-metadata', middleware)

    const stale = await request(app).get('/loader-metadata').set('Host', 'localhost:80')
    await started
    releaseRefresh()
    await middleware.flush()
    const refreshed = await request(app).get('/loader-metadata').set('Host', 'localhost:80')

    expect(stale.status).toBe(202)
    expect(stale.headers['content-language']).toBe('old')
    expect(refreshed.status).toBe(200)
    expect(refreshed.headers['content-language']).toBeUndefined()
    expect(refreshed.body).toEqual({ source: 'new' })
  })

  it('does not retain stale data beyond an Express loader negativeTTL', async () => {
    const { backend, cache } = controlledCache()
    const app = express()
    app.use((_req, res, next) => {
      res.status(404)
      next()
    })
    const middleware = adaptiveExpressCache({
      cache,
      negativeTTL: 1,
      staleWhileRevalidate: 60,
      loader: async () => ({ missing: true }),
    })
    app.get('/loader-negative', middleware)

    await request(app).get('/loader-negative').set('Host', 'localhost:80')
    await middleware.flush()

    expect(backend.updateInputs.at(-1)?.maxTTL).toBe(1)
    expect(backend.updateInputs.at(-1)?.staleTTL).toBe(0)
  })

  it('runs a loader without storage when its backend cannot fence the load', async () => {
    const { backend, cache } = controlledCache()
    Object.defineProperty(backend, 'captureWriteToken', { value: undefined })
    const middleware = adaptiveExpressCache({ cache, loader: async () => ({ unsafe: true }) })
    const app = express()
    let handlerCalls = 0
    app.get('/unsupported-loader', middleware, (_req, res) => res.json({ handler: ++handlerCalls }))

    const response = await request(app).get('/unsupported-loader').set('Host', 'localhost:80')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ unsafe: true })
    expect(handlerCalls).toBe(0)
    expect(backend.entries.size).toBe(0)
  })

  it('forwards Express loader errors without replaying the route handler', async () => {
    const { backend, cache } = controlledCache()
    const middleware = adaptiveExpressCache({
      cache,
      loader: async () => {
        throw new Error('loader failed')
      },
    })
    const app = express()
    let handlerCalls = 0
    app.get('/loader-error', middleware, (_req, res) => res.json({ handler: ++handlerCalls }))

    const response = await request(app).get('/loader-error').set('Host', 'localhost:80')

    expect(response.status).toBe(500)
    expect(response.headers['x-cache']).toBe('MISS')
    expect(handlerCalls).toBe(0)
    expect(backend.entries.size).toBe(0)
  })

  it('runs an Express loader directly for a bypassed request without storing it', async () => {
    const { backend, cache } = controlledCache()
    let loaderCalls = 0
    let handlerCalls = 0
    const middleware = adaptiveExpressCache({ cache, loader: async () => ({ loader: ++loaderCalls }) })
    const app = express()
    app.get('/bypass-loader', middleware, (_req, res) => res.json({ handler: ++handlerCalls }))

    const first = await request(app)
      .get('/bypass-loader')
      .set('Host', 'localhost:80')
      .set('Authorization', 'Bearer secret')
    const second = await request(app)
      .get('/bypass-loader')
      .set('Host', 'localhost:80')
      .set('Authorization', 'Bearer secret')

    expect(first.body).toEqual({ loader: 1 })
    expect(second.body).toEqual({ loader: 2 })
    expect(first.headers['x-cache']).toBe('BYPASS')
    expect(handlerCalls).toBe(0)
    expect(backend.entries.size).toBe(0)
  })

  it('forwards loader errors from bypassed Express requests', async () => {
    const { backend, cache } = controlledCache()
    const middleware = adaptiveExpressCache({
      cache,
      loader: async () => {
        throw new Error('bypassed loader failed')
      },
    })
    const app = express()
    let handlerCalls = 0
    app.get('/bypass-loader-error', middleware, (_req, res) => res.json({ handler: ++handlerCalls }))

    const response = await request(app)
      .get('/bypass-loader-error')
      .set('Host', 'localhost:80')
      .set('Authorization', 'Bearer secret')

    expect(response.status).toBe(500)
    expect(response.headers['x-cache']).toBe('BYPASS')
    expect(handlerCalls).toBe(0)
    expect(backend.entries.size).toBe(0)
  })

  it('serves an owned Express loader after its cache has closed', async () => {
    const backend = new ControlledBackend()
    let loaderCalls = 0
    const middleware = adaptiveExpressCache({
      backend,
      compress: false,
      loader: async () => ({ loader: ++loaderCalls }),
    })
    const app = express()
    app.get('/closed-loader', middleware)
    await middleware.close()

    const first = await request(app).get('/closed-loader').set('Host', 'localhost:80')
    const second = await request(app).get('/closed-loader').set('Host', 'localhost:80')

    expect(first.status).toBe(200)
    expect(first.body).toEqual({ loader: 1 })
    expect(second.body).toEqual({ loader: 2 })
    expect(first.headers['x-cache']).toBe('BYPASS')
    expect(backend.updatedKeys).toHaveLength(0)
  })
})
