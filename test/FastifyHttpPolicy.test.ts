import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { encodeHttpResponse } from '../src/httpResponse'
import { getAdaptiveCacheKey } from '../src/utils'
import { ControlledBackend, controlledCache } from './helpers/httpFixtures'

describe('Fastify HTTP policy and lifecycle', () => {
  it('partitions by declared request headers and replays identity headers', async () => {
    const { cache } = controlledCache()
    const fastify = Fastify()
    let calls = 0
    const plugin = adaptiveFastifyCache({ cache, varyBy: ['X-Tenant'] })
    await fastify.register(plugin)
    fastify.get('/tenant', async (_req, reply) => {
      calls += 1
      reply.header('Vary', 'X-Tenant').header('Content-Language', 'en')
      return { calls }
    })

    await fastify.inject({ url: '/tenant', headers: { 'x-tenant': 'one' } })
    await plugin.flush()
    await fastify.inject({ url: '/tenant', headers: { 'x-tenant': 'two' } })
    await plugin.flush()
    const hit = await fastify.inject({ url: '/tenant', headers: { 'x-tenant': 'one' } })

    expect(calls).toBe(2)
    expect(hit.headers['x-cache']).toBe('HIT')
    expect(hit.headers.vary).toBe('X-Tenant')
    expect(hit.headers['content-language']).toBe('en')
    await fastify.close()
  })

  it('bypasses cookie requests unless an isolated cookie key is configured', async () => {
    const bypassCache = controlledCache()
    const isolatedCache = controlledCache()
    const bypassApp = Fastify()
    let bypassCalls = 0
    await bypassApp.register(adaptiveFastifyCache({ cache: bypassCache.cache }))
    bypassApp.get('/item', async () => ({ call: ++bypassCalls }))

    const bypass = await bypassApp.inject({ url: '/item', headers: { cookie: 'session=one' } })
    await bypassApp.inject({ url: '/item', headers: { cookie: 'session=one' } })

    const isolatedApp = Fastify()
    let isolatedCalls = 0
    const isolated = adaptiveFastifyCache({
      cache: isolatedCache.cache,
      keyPrefix: 'cookie:',
      cacheCookies: true,
      varyBy: ['cookie'],
    })
    await isolatedApp.register(isolated)
    isolatedApp.get('/item', async () => ({ call: ++isolatedCalls }))
    await isolatedApp.inject({ url: '/item', headers: { cookie: 'session=one' } })
    await isolated.flush()
    const hit = await isolatedApp.inject({ url: '/item', headers: { cookie: 'session=one' } })

    expect(bypass.headers['x-cache']).toBe('BYPASS')
    expect(bypassCalls).toBe(2)
    expect(isolatedCalls).toBe(1)
    expect(hit.headers['x-cache']).toBe('HIT')
    await bypassApp.close()
    await isolatedApp.close()
  })

  it('does not cache private responses or responses with undeclared Vary', async () => {
    const { cache } = controlledCache()
    const fastify = Fastify()
    let privateCalls = 0
    let varyCalls = 0
    const plugin = adaptiveFastifyCache({ cache, varyBy: ['accept-language'] })
    await fastify.register(plugin)
    fastify.get('/private', async (_req, reply) => {
      reply.header('Cache-Control', 'private')
      return { call: ++privateCalls }
    })
    fastify.get('/vary', async (_req, reply) => {
      reply.header('Vary', 'X-Tenant')
      return { call: ++varyCalls }
    })

    await fastify.inject('/private')
    await fastify.inject('/private')
    await fastify.inject('/vary')
    await fastify.inject('/vary')

    expect(privateCalls).toBe(2)
    expect(varyCalls).toBe(2)
    await fastify.close()
  })

  it('caches Fastify 404 responses only when negativeTTL is enabled', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    let calls = 0
    const plugin = adaptiveFastifyCache({ cache, negativeTTL: 12, maxTTL: 10 })
    await fastify.register(plugin)
    fastify.get('/missing', async (_req, reply) => {
      reply.statusCode = 404
      return { call: ++calls }
    })

    await fastify.inject('/missing')
    await plugin.flush()
    const hit = await fastify.inject('/missing')

    expect(hit.statusCode).toBe(404)
    expect(hit.headers['x-cache']).toBe('HIT')
    expect(calls).toBe(1)
    expect([...backend.entries.values()][0].ttl).toBe(10)
    await fastify.close()
  })

  it('closes only plugin-owned cache state from Fastify onClose', async () => {
    const injected = controlledCache()
    const ownedBackend = new ControlledBackend()
    const fastify = Fastify()
    const injectedPlugin = adaptiveFastifyCache({ cache: injected.cache })
    const ownedPlugin = adaptiveFastifyCache({ backend: ownedBackend, compress: false })
    await fastify.register(injectedPlugin, { prefix: '/injected' })
    await fastify.register(ownedPlugin, { prefix: '/owned' })
    fastify.get('/injected/item', async () => ({ ok: true }))
    fastify.get('/owned/item', async () => ({ ok: true }))

    await fastify.close()

    expect(injected.backend.quitCalls).toBe(0)
    expect(ownedBackend.quitCalls).toBe(1)
    expect(injectedPlugin.cache).toBe(injected.cache)
  })

  it('rejects a private Fastify cache entry when response policy changes', async () => {
    const { cache } = controlledCache()
    const key = getAdaptiveCacheKey('/changed-response-policy', {}, 'adaptive:')
    await cache.set(key, encodeHttpResponse({ source: 'cached' }, 200, undefined, { 'cache-control': 'private' }))
    const fastify = Fastify()
    const plugin = adaptiveFastifyCache({ cache })
    await fastify.register(plugin)
    fastify.get('/changed-response-policy', async () => ({ source: 'handler' }))

    const response = await fastify.inject('/changed-response-policy')

    expect(response.json()).toEqual({ source: 'handler' })
    expect(response.headers['x-cache']).toBe('MISS')
    await fastify.close()
  })

  it('fails open when a Fastify request-policy callback throws', async () => {
    const { cache } = controlledCache()
    const fastify = Fastify()
    const plugin = adaptiveFastifyCache({
      cache,
      shouldCache: () => {
        throw new Error('policy failed')
      },
    })
    await fastify.register(plugin)
    fastify.get('/policy-error', async () => ({ handler: true }))

    const response = await fastify.inject('/policy-error')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ handler: true })
    expect(response.headers['x-cache']).toBe('RETRY')
    await fastify.close()
  })

  it('preserves a Fastify handler response when its response-policy callback throws', async () => {
    const { backend, cache } = controlledCache()
    const fastify = Fastify()
    const plugin = adaptiveFastifyCache({
      cache,
      shouldCache: (_req, response) => {
        if (response) throw new Error('response policy failed')
        return true
      },
    })
    await fastify.register(plugin)
    fastify.get('/response-policy-error', async () => ({ handler: true }))

    const response = await fastify.inject('/response-policy-error')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ handler: true })
    expect(backend.entries.size).toBe(0)
    await fastify.close()
  })

  it('serves Fastify handlers but skips writes when fencing capture fails', async () => {
    const { backend, cache } = controlledCache()
    backend.captureError = new Error('token transport failed')
    const fastify = Fastify()
    let calls = 0
    const plugin = adaptiveFastifyCache({ cache })
    await fastify.register(plugin)
    fastify.get('/token-error', async () => ({ call: ++calls }))

    await fastify.inject('/token-error')
    await fastify.inject('/token-error')

    expect(calls).toBe(2)
    expect(backend.entries.size).toBe(0)
    await fastify.close()
  })

  it('caches ordinary Fastify responses with an unfenced custom backend', async () => {
    const { backend, cache } = controlledCache()
    Object.defineProperty(backend, 'captureWriteToken', { value: undefined })
    const fastify = Fastify()
    let calls = 0
    const plugin = adaptiveFastifyCache({ cache })
    await fastify.register(plugin)
    fastify.get('/unfenced-backend', async () => ({ call: ++calls }))

    const first = await fastify.inject('/unfenced-backend')
    await plugin.flush()
    const second = await fastify.inject('/unfenced-backend')

    expect(first.statusCode).toBe(200)
    expect(first.headers['x-cache']).toBe('MISS')
    expect(second.headers['x-cache']).toBe('HIT')
    expect(second.json()).toEqual({ call: 1 })
    expect(calls).toBe(1)
    await fastify.close()
  })
})
