import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify, { FastifyReply, FastifyRequest } from 'fastify'
import { setImmediate } from 'node:timers/promises'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { controlledCache } from './helpers/httpFixtures'
import { gate } from './helpers/coreCache'
import { encodeHttpResponse } from '../src/httpResponse'
import { getAdaptiveCacheKey } from '../src/utils'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Fastify final response policy and transformations', () => {
  it('propagates a synchronous send failure once without publishing the candidate', async () => {
    const { cache, backend } = controlledCache()
    const app = Fastify()
    const failure = new Error('transport rejected candidate')
    const observed: unknown[] = []
    let calls = 0
    app.addHook('onRequest', async (_req, reply) => {
      const send = reply.send
      reply.send = function (payload) {
        if (payload === 'candidate') throw failure
        return send.call(this, payload)
      }
    })
    const plugin = adaptiveFastifyCache({
      cache,
      loader: async () => {
        calls++
        return 'candidate'
      },
    })
    await app.register(plugin)
    app.setErrorHandler((error, _req, reply) => {
      observed.push(error)
      reply.code(500).send('failed')
    })
    app.get('/data', async () => 'unused')
    try {
      expect((await app.inject('/data')).payload).toBe('failed')
      await plugin.flush()
      expect(observed).toEqual([failure])
      expect(observed[0]).toBe(failure)
      expect(calls).toBe(1)
      expect(backend.updateInputs).toHaveLength(0)
    } finally {
      await app.close()
      await cache.close()
    }
  })

  for (const mode of ['handler', 'loader'] as const) {
    it.each([
      ['cache-control', 'private'],
      ['cache-control', 'no-store'],
      ['set-cookie', 'session=private'],
      ['vary', 'x-user'],
    ])(`${mode} checks late %s=%s before storing`, async (name, value) => {
      const { cache, backend } = controlledCache()
      const app = Fastify()
      let calls = 0
      const load = async (req: { headers?: Record<string, unknown> }) => {
        calls++
        return { user: req.headers?.['x-user'] }
      }
      const plugin = adaptiveFastifyCache({ cache, ...(mode === 'loader' ? { loader: load } : {}) })
      await app.register(plugin)
      app.addHook('onSend', async (_req, reply, payload) => {
        reply.header(name, value)
        return payload
      })
      app.get('/data', load)
      try {
        const first = await app.inject({ url: '/data', headers: { 'x-user': 'alice' } })
        await plugin.flush()
        const second = await app.inject({ url: '/data', headers: { 'x-user': 'bob' } })
        await plugin.flush()
        expect(first.json()).toEqual({ user: 'alice' })
        expect(second.json()).toEqual({ user: 'bob' })
        expect(calls).toBe(2)
        expect(backend.updateInputs).toHaveLength(0)
      } finally {
        await app.close()
        await cache.close()
      }
    })
  }

  it.each(['before', 'after'] as const)(
    'applies an onSend hook registered %s the adapter exactly once',
    async (order) => {
      const { cache } = controlledCache()
      const app = Fastify()
      let calls = 0
      const transform = async (_req: unknown, _reply: unknown, payload: unknown) => payload + ':sent'
      if (order === 'before') app.addHook('onSend', transform)
      const plugin = adaptiveFastifyCache({ cache })
      await app.register(plugin)
      if (order === 'after') app.addHook('onSend', transform)
      app.get('/data', async () => {
        calls++
        return 'body'
      })
      try {
        const first = await app.inject('/data')
        await plugin.flush()
        const second = await app.inject('/data')
        expect([first.payload, second.payload]).toEqual(['body:sent', 'body:sent'])
        expect(second.headers['x-cache']).toBe('HIT')
        expect(calls).toBe(1)
      } finally {
        await app.close()
        await cache.close()
      }
    },
  )

  it.each([
    ['cache-control', 'private'],
    ['set-cookie', 'session=alice'],
    ['vary', 'x-user'],
  ])('does not publish a candidate before an origin-only late %s verdict', async (name, value) => {
    const { cache, backend } = controlledCache()
    const app = Fastify()
    const entered = gate(),
      release = gate(),
      joined = gate()
    let calls = 0,
      waits = 0
    const getOrSet = cache.getOrSet.bind(cache)
    vi.spyOn(cache, 'getOrSet').mockImplementation((...args) => {
      const pending = getOrSet(...args)
      if (++waits === 2) joined.resolve()
      return pending
    })
    const plugin = adaptiveFastifyCache({
      cache,
      loader: async (req) => ({ user: req.headers?.['x-user'], call: ++calls }),
    })
    await app.register(plugin)
    // A later plugin can append route hooks after any adapter onSend finalizer.
    app.addHook('onRoute', (route) => {
      const hooks = route.onSend ? (Array.isArray(route.onSend) ? route.onSend : [route.onSend]) : []
      route.onSend = [
        ...hooks,
        async (req: FastifyRequest, reply: FastifyReply, payload: any) => {
          if (req.headers['x-user'] === 'alice') {
            entered.resolve()
            await release.promise
            reply.header(name, value)
          }
          return payload
        },
      ]
    })
    app.get('/data', async () => 'unused')
    try {
      const first = app.inject({ url: '/data', headers: { 'x-user': 'alice' } })
      await entered.promise
      let completed = false
      const second = app.inject({ url: '/data', headers: { 'x-user': 'bob' } }).then((r) => {
        completed = true
        return r
      })
      await joined.promise
      await setImmediate()
      expect(completed).toBe(false)
      expect(backend.updateInputs).toHaveLength(0)
      release.resolve()
      expect((await first).json()).toEqual({ user: 'alice', call: 1 })
      expect((await second).json()).toEqual({ user: 'bob', call: 2 })
      await plugin.flush()
      expect(backend.updateInputs).toHaveLength(0)
    } finally {
      release.resolve()
      await app.close()
      await cache.close()
    }
  })

  it('refreshes stale data in the foreground when new body-dependent policy forbids storage', async () => {
    const { cache, backend } = controlledCache()
    const key = getAdaptiveCacheKey('/data', {}, 'adaptive:', undefined, 'localhost:80')
    await cache.set(key, encodeHttpResponse('public', 200, undefined))
    backend.staleKeys.add(key)
    const writesBefore = backend.updateInputs.length
    const app = Fastify()
    const entered = gate(),
      release = gate()
    const plugin = adaptiveFastifyCache({
      cache,
      staleWhileRevalidate: 30,
      loader: async () => {
        entered.resolve()
        await release.promise
        return 'secret'
      },
    })
    await app.register(plugin)
    app.addHook('onSend', async (_req, reply, payload) => {
      if (payload === 'secret') reply.header('Cache-Control', 'private')
      return payload
    })
    app.get('/data', async () => 'unused')
    try {
      let completed = false
      const response = app.inject('/data').then((r) => {
        completed = true
        return r
      })
      await entered.promise
      await setImmediate()
      expect(completed).toBe(false)
      release.resolve()
      expect((await response).payload).toBe('secret')
      await plugin.flush()
      expect(backend.updateInputs).toHaveLength(writesBefore)
    } finally {
      release.resolve()
      await app.close()
      await cache.close()
    }
  })

  it('does not share a source whose origin expires before its body can pass privacy hooks', async () => {
    const { cache, backend } = controlledCache()
    const app = Fastify()
    const entered = gate(),
      release = gate(),
      joined = gate()
    let calls = 0,
      waits = 0
    const getOrSet = cache.getOrSet.bind(cache)
    vi.spyOn(cache, 'getOrSet').mockImplementation((...args) => {
      const pending = getOrSet(...args)
      if (++waits === 2) joined.resolve()
      return pending
    })
    const plugin = adaptiveFastifyCache({
      cache,
      loadTimeoutMs: 100,
      loader: async (req) => {
        calls++
        entered.resolve()
        await release.promise
        return String(req.headers?.['x-user'])
      },
    })
    await app.register(plugin)
    app.addHook('onSend', async (req, reply, payload) => {
      if (req.headers['x-user'] === 'alice' && payload === 'alice') reply.header('Cache-Control', 'private')
      return payload
    })
    app.get('/data', async () => 'unused')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const first = app.inject({ url: '/data', headers: { 'x-user': 'alice' } })
      await entered.promise
      await vi.advanceTimersByTimeAsync(50)
      const second = app.inject({ url: '/data', headers: { 'x-user': 'bob' } })
      await joined.promise
      await setImmediate()
      await vi.advanceTimersByTimeAsync(50)
      expect((await first).statusCode).toBe(500)
      release.resolve()
      expect((await second).payload).toBe('bob')
      await plugin.flush()
      expect(calls).toBe(2)
      expect(backend.updateInputs).toHaveLength(0)
    } finally {
      release.resolve()
      vi.useRealTimers()
      await app.close()
      await cache.close()
    }
  })

  it.each(['hook-error', 'invalidation'] as const)('rejects publication after %s during send', async (failure) => {
    const { cache, backend } = controlledCache()
    const app = Fastify()
    const entered = gate(),
      release = gate()
    const plugin = adaptiveFastifyCache({ cache, loader: async () => 'candidate' })
    await app.register(plugin)
    app.addHook('onSend', async (_req, _reply, payload) => {
      if (payload === 'candidate') {
        entered.resolve()
        await release.promise
        if (failure === 'hook-error') throw new Error('send failed')
      }
      return payload
    })
    app.get('/data', async () => 'unused')
    try {
      const response = app.inject('/data')
      await entered.promise
      if (failure === 'invalidation') await plugin.clear({ url: '/data', query: {}, headers: { host: 'localhost:80' } })
      release.resolve()
      expect((await response).statusCode).toBe(failure === 'hook-error' ? 500 : 200)
      await plugin.flush()
      expect(backend.entries.size).toBe(0)
    } finally {
      release.resolve()
      await app.close()
      await cache.close()
    }
  })
})
