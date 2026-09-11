import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { Readable } from 'node:stream'
import { ReadableStream } from 'node:stream/web'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { encodeHttpResponse } from '../src/httpResponse'
import { getAdaptiveCacheKey } from '../src/utils'
import {
  ControlledBackend,
  controlledCache,
  queueStaleThenUnsafeResponse,
  queueStaleThenLegacyResponse,
} from './helpers/httpFixtures'

describe('Fastify HTTP loaders', () => {
  it('bypasses a Fastify loader when its custom authentication key is empty', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    let loaderCalls = 0
    const plugin = adaptiveFastifyCache({
      cache,
      cacheAuthenticated: true,
      includeHeaders: false,
      key: () => '',
      loader: async () => ({ loader: ++loaderCalls }),
    })
    await fastify.register(plugin)
    fastify.get('/missing-key', async () => ({ handler: true }))

    const first = await fastify.inject({ url: '/missing-key', headers: { authorization: 'Bearer one' } })
    const second = await fastify.inject({ url: '/missing-key', headers: { authorization: 'Bearer two' } })

    expect(first.json()).toEqual({ loader: 1 })
    expect(second.json()).toEqual({ loader: 2 })
    expect(first.headers['x-cache']).toBeUndefined()
    expect(second.headers['x-cache']).toBeUndefined()
    expect(backend.entries.size).toBe(0)
    await fastify.close()
  })

  it('serves an owned Fastify loader after its cache has closed', async () => {
    const backend = new ControlledBackend()
    const fastify = Fastify()
    let loaderCalls = 0
    const plugin = adaptiveFastifyCache({
      backend,
      compress: false,
      loader: async () => ({ loader: ++loaderCalls }),
    })
    await fastify.register(plugin)
    fastify.get('/closed-loader', async () => ({ handler: true }))
    await plugin.close()

    const first = await fastify.inject('/closed-loader')
    const second = await fastify.inject('/closed-loader')

    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ loader: 1 })
    expect(second.json()).toEqual({ loader: 2 })
    expect(first.headers['x-cache']).toBe('BYPASS')
    expect(backend.updatedKeys).toHaveLength(0)
    await fastify.close()
  })

  it('does not store loader results when an earlier hook sets Set-Cookie', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    let loaderCalls = 0
    fastify.addHook('onRequest', async (_req, reply) => {
      reply.header('Set-Cookie', 'session=secret')
    })
    const plugin = adaptiveFastifyCache({
      cache,
      loader: async () => ({ call: ++loaderCalls }),
    })
    await fastify.register(plugin)
    fastify.get('/loader-cookie', async () => ({ handler: true }))

    await fastify.inject('/loader-cookie')
    await plugin.flush()
    await fastify.inject('/loader-cookie')

    expect(loaderCalls).toBe(2)
    expect(backend.entries.size).toBe(0)
    await fastify.close()
  })

  it('uses raw Fastify loader data for dynamic maxTTL', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    const plugin = adaptiveFastifyCache({
      cache,
      maxTTL: (body) => body.ttl,
      loader: async () => ({ ttl: 23, value: 'raw' }),
    })
    await fastify.register(plugin)
    fastify.get('/loader-ttl', async () => ({ handler: true }))

    await fastify.inject('/loader-ttl')
    await plugin.flush()

    expect([...backend.entries.values()][0].ttl).toBe(23)
    await fastify.close()
  })

  it('applies fixed TTL and array tags to forced Fastify loader refreshes', async () => {
    const { backend, cache } = controlledCache()
    const key = getAdaptiveCacheKey('/forced-loader', {}, 'adaptive:')
    await cache.set(key, encodeHttpResponse({ source: 'old' }, 200))
    const fastify = Fastify()
    const plugin = adaptiveFastifyCache({
      cache,
      forceRefresh: true,
      maxTTL: 12,
      tags: ['forced'],
      loader: async () => ({ source: 'new' }),
    })
    await fastify.register(plugin)
    fastify.get('/forced-loader', async () => ({ source: 'route' }))

    const response = await fastify.inject('/forced-loader')

    expect(response.json()).toEqual({ source: 'new' })
    expect(response.headers['x-cache']).toBe('BYPASS')
    expect(backend.updateInputs.at(-1)?.maxTTL).toBe(12)
    expect(backend.updateInputs.at(-1)?.tags).toEqual(['forced'])
    await fastify.close()
  })

  it('serves Fastify loader hits without headers after a fallback TTL and function tags write', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    let loaderCalls = 0
    const plugin = adaptiveFastifyCache({
      cache,
      includeHeaders: false,
      maxTTL: () => Number.NaN,
      tags: () => ['dynamic'],
      loader: async () => ({ call: ++loaderCalls }),
    })
    await fastify.register(plugin)
    fastify.get('/quiet-loader', async () => ({ source: 'route' }))

    await fastify.inject('/quiet-loader')
    const hit = await fastify.inject('/quiet-loader')

    expect(hit.json()).toEqual({ call: 1 })
    expect(hit.headers['x-cache']).toBeUndefined()
    expect(loaderCalls).toBe(1)
    expect(backend.updateInputs.at(-1)?.maxTTL).toBe(60)
    expect(backend.updateInputs.at(-1)?.tags).toEqual(['dynamic'])
    await fastify.close()
  })

  it('preserves an injected cache TTL cap for Fastify handlers and loaders', async () => {
    const backend = new ControlledBackend()
    const cache = new AdaptiveCache({ backend, compress: false, initialTTL: 2, maxTTL: 2 })
    const fastify = Fastify()
    const handlerPlugin = adaptiveFastifyCache({ cache })
    const loaderPlugin = adaptiveFastifyCache({ cache, loader: async () => ({ source: 'loader' }) })
    await fastify.register(handlerPlugin, { prefix: '/handler' })
    await fastify.register(loaderPlugin, { prefix: '/loader' })
    fastify.get('/handler/cap', async () => ({ source: 'handler' }))
    fastify.get('/loader/cap', async () => ({ source: 'route' }))

    await fastify.inject('/handler/cap')
    await handlerPlugin.flush()
    await fastify.inject('/loader/cap')

    expect(backend.updateInputs.at(-2)?.maxTTL).toBe(2)
    expect(backend.updateInputs.at(-1)?.maxTTL).toBe(2)
    await fastify.close()
  })

  it('rejects an unsafe stale Fastify loader entry before regeneration', async () => {
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
    const plugin = adaptiveFastifyCache({
      cache,
      staleWhileRevalidate: 30,
      loader: async () => ({ source: `loader-${++loaderCalls}` }),
    })
    const fastify = Fastify()
    await fastify.register(plugin)
    fastify.get('/loader-policy', async () => ({ handler: true }))

    const response = await fastify.inject('/loader-policy')

    expect(response.json()).toEqual({ source: 'loader-1' })
    expect(loaderCalls).toBe(1)
    await fastify.close()
  })

  it('rejects a newly raced private Fastify loader entry before serving it', async () => {
    const { backend, cache } = controlledCache()
    await queueStaleThenUnsafeResponse(backend, cache, '/loader-policy-race')
    let loaderCalls = 0
    const plugin = adaptiveFastifyCache({
      cache,
      staleWhileRevalidate: 30,
      loader: async () => ({ source: `loader-${++loaderCalls}` }),
    })
    const fastify = Fastify()
    await fastify.register(plugin)
    fastify.get('/loader-policy-race', async () => ({ handler: true }))

    const response = await fastify.inject('/loader-policy-race')

    expect(response.json()).toEqual({ source: 'loader-1' })
    expect(loaderCalls).toBe(1)
    expect(backend.entries.size).toBe(0)
    await fastify.close()
  })

  it('serves fresh and raced legacy Fastify loader entries with the existing status', async () => {
    const direct = controlledCache()
    const directKey = getAdaptiveCacheKey('/legacy-loader-hit', {}, 'adaptive:')
    await direct.cache.set(directKey, { source: 'legacy-hit' })
    const directApp = Fastify()
    const directPlugin = adaptiveFastifyCache({
      cache: direct.cache,
      loader: async () => ({ source: 'loader' }),
    })
    await directApp.register(directPlugin)
    directApp.get('/legacy-loader-hit', async () => ({ source: 'route' }))

    const directResponse = await directApp.inject('/legacy-loader-hit')

    const raced = controlledCache()
    await queueStaleThenLegacyResponse(raced.backend, raced.cache, '/legacy-loader-race')
    const racedApp = Fastify()
    const racedPlugin = adaptiveFastifyCache({
      cache: raced.cache,
      staleWhileRevalidate: 30,
      loader: async () => ({ source: 'loader' }),
    })
    await racedApp.register(racedPlugin)
    racedApp.get('/legacy-loader-race', async () => ({ source: 'route' }))

    const racedResponse = await racedApp.inject('/legacy-loader-race')

    expect(directResponse.statusCode).toBe(200)
    expect(directResponse.json()).toEqual({ source: 'legacy-hit' })
    expect(directResponse.headers['x-cache']).toBe('HIT')
    expect(racedResponse.statusCode).toBe(200)
    expect(racedResponse.json()).toEqual({ source: 'legacy-racer' })
    await directApp.close()
    await racedApp.close()
  })

  it('streams Fastify loader results without storing a serialized stream object', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    let loaderCalls = 0
    const plugin = adaptiveFastifyCache({
      cache,
      loader: async () => {
        loaderCalls += 1
        return Readable.from(['hello'])
      },
    })
    await fastify.register(plugin)
    fastify.get('/loader-stream', async () => 'handler')

    const first = await fastify.inject('/loader-stream')
    const second = await fastify.inject('/loader-stream')

    expect(first.payload).toBe('hello')
    expect(second.payload).toBe('hello')
    expect(loaderCalls).toBe(2)
    expect(backend.entries.size).toBe(0)
    await fastify.close()
  })

  it('does not cache WHATWG stream loader results', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    let loaderCalls = 0
    const plugin = adaptiveFastifyCache({
      cache,
      loader: async () => {
        loaderCalls += 1
        return new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('web-stream'))
            controller.close()
          },
        })
      },
    })
    await fastify.register(plugin)
    fastify.get('/loader-web-stream', async () => 'handler')

    const first = await fastify.inject('/loader-web-stream')
    const second = await fastify.inject('/loader-web-stream')

    expect(first.payload).toBe('web-stream')
    expect(second.payload).toBe('web-stream')
    expect(loaderCalls).toBe(2)
    expect(backend.entries.size).toBe(0)
    await fastify.close()
  })

  it('keeps regenerated Fastify metadata separate from a stale response being served', async () => {
    const { backend, cache } = controlledCache()
    const key = getAdaptiveCacheKey('/loader-metadata', {}, 'adaptive:')
    await cache.set(key, encodeHttpResponse({ source: 'old' }, 202, 'application/json', { 'content-language': 'old' }))
    backend.staleKeys.add(key)
    let releaseRefresh!: () => void
    const barrier = new Promise<void>((resolve) => (releaseRefresh = resolve))
    const plugin = adaptiveFastifyCache({
      cache,
      staleWhileRevalidate: 30,
      loader: async () => {
        await barrier
        return { source: 'new' }
      },
    })
    const fastify = Fastify()
    await fastify.register(plugin)
    fastify.get('/loader-metadata', async () => 'handler')

    const stale = await fastify.inject('/loader-metadata')
    releaseRefresh()
    await plugin.flush()
    const refreshed = await fastify.inject('/loader-metadata')

    expect(stale.statusCode).toBe(202)
    expect(stale.headers['content-language']).toBe('old')
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.headers['content-language']).toBeUndefined()
    expect(refreshed.json()).toEqual({ source: 'new' })
    await fastify.close()
  })

  it('does not retain stale data beyond a Fastify loader negativeTTL', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    fastify.addHook('onRequest', async (_req, reply) => {
      reply.statusCode = 404
    })
    const plugin = adaptiveFastifyCache({
      cache,
      negativeTTL: 1,
      staleWhileRevalidate: 60,
      loader: async () => ({ missing: true }),
    })
    await fastify.register(plugin)
    fastify.get('/loader-negative', async () => 'handler')

    await fastify.inject('/loader-negative')
    await plugin.flush()

    expect(backend.updateInputs.at(-1)?.maxTTL).toBe(1)
    expect(backend.updateInputs.at(-1)?.staleTTL).toBe(0)
    await fastify.close()
  })

  it('propagates Fastify loader errors without invoking the route handler', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    let handlerCalls = 0
    const plugin = adaptiveFastifyCache({
      cache,
      loader: async () => {
        throw new Error('loader failed')
      },
    })
    await fastify.register(plugin)
    fastify.get('/loader-error', async () => ({ handler: ++handlerCalls }))

    const response = await fastify.inject('/loader-error')

    expect(response.statusCode).toBe(500)
    expect(response.headers['x-cache']).toBe('RETRY')
    expect(handlerCalls).toBe(0)
    expect(backend.entries.size).toBe(0)
    await fastify.close()
  })

  it('runs a Fastify loader directly for bypassed requests without storing results', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    let loaderCalls = 0
    let handlerCalls = 0
    const plugin = adaptiveFastifyCache({ cache, loader: async () => ({ loader: ++loaderCalls }) })
    await fastify.register(plugin)
    fastify.get('/bypass-loader', async () => ({ handler: ++handlerCalls }))

    const first = await fastify.inject({ url: '/bypass-loader', headers: { authorization: 'Bearer secret' } })
    const second = await fastify.inject({ url: '/bypass-loader', headers: { authorization: 'Bearer secret' } })

    expect(first.json()).toEqual({ loader: 1 })
    expect(second.json()).toEqual({ loader: 2 })
    expect(first.headers['x-cache']).toBe('BYPASS')
    expect(handlerCalls).toBe(0)
    expect(backend.entries.size).toBe(0)
    await fastify.close()
  })
})
