import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import express from 'express'
import request from 'supertest'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers'
import { ReadableStream } from 'node:stream/web'
import { adaptiveExpressCache, AdaptiveExpressCacheOptions } from '../src/AdaptiveExpressCache'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { controlledCache } from './helpers/httpFixtures'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const setup = async (framework: 'express' | 'fastify', options: AdaptiveExpressCacheOptions) => {
  const errors: unknown[] = []
  if (framework === 'express') {
    const app = express()
    const adapter = adaptiveExpressCache(options)
    app.get('/data', adapter)
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      errors.push(error)
      res.status(500).send('failed')
    })
    return {
      adapter,
      errors,
      get: (headers: Record<string, string> = {}) =>
        request(app)
          .get('/data')
          .set('Host', 'localhost')
          .set(headers)
          .then((result) => ({ status: result.status, body: result.text, headers: result.headers })),
      close: async () => {},
    }
  }
  const app = Fastify()
  const adapter = adaptiveFastifyCache(options)
  await app.register(adapter)
  app.get('/data', async () => 'route')
  app.setErrorHandler((error, _req, reply) => {
    errors.push(error)
    reply.code(500).send('failed')
  })
  return {
    adapter,
    errors,
    get: (headers: Record<string, string> = {}) =>
      app
        .inject({ url: '/data', headers })
        .then((result) => ({ status: result.statusCode, body: result.payload, headers: result.headers })),
    close: () => app.close(),
  }
}

describe('final HTTP lifetime regressions', () => {
  for (const framework of ['express', 'fastify'] as const) {
    it(`${framework} lets a later caller succeed after the initiating caller deadline`, async () => {
      const { cache } = controlledCache()
      const entered = deferred()
      const source = deferred()
      const joined = deferred()
      const getOrSet = cache.getOrSet.bind(cache)
      let loads = 0
      vi.spyOn(cache, 'getOrSet').mockImplementation((...args) => {
        const loading = getOrSet(...args)
        if (++loads === 2) joined.resolve()
        return loading
      })
      let calls = 0
      const app = await setup(framework, {
        cache,
        loadTimeoutMs: 180,
        loader: async () => {
          calls++
          entered.resolve()
          await source.promise
          return 'shared source'
        },
      })
      // Keep socket I/O real while advancing only cache deadlines. Waiting for
      // both callers prevents machine load from turning this into two sources.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const first = app.get()
      await entered.promise
      await vi.advanceTimersByTimeAsync(80)
      const second = app.get()
      await joined.promise
      await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(100)
      expect((await first).status).toBe(500)
      source.resolve()
      const later = await second
      await app.close()
      expect(later.status).toBe(200)
      expect(later.body).toBe('shared source')
      expect(app.errors).toHaveLength(1)
      expect(app.errors[0]).toMatchObject({ name: 'TimeoutError' })
      // Fastify must validate the candidate through its origin's final hooks.
      // An expired origin cannot authorize publication to the surviving waiter.
      expect(calls).toBe(framework === 'fastify' ? 2 : 1)
    })
    it(`${framework} preserves the original bypass source exception and diagnostic`, async () => {
      const { cache } = controlledCache()
      const failure = new Error('original bypass failure')
      let calls = 0
      const app = await setup(framework, {
        cache,
        loader: async () => {
          calls++
          throw failure
        },
      })
      const result = await app.get({ authorization: 'private' })
      await app.close()
      expect(result.status).toBe(500)
      expect(result.headers['x-cache']).toBe('BYPASS')
      expect(app.errors).toEqual([failure])
      expect(app.errors[0]).toBe(failure)
      expect(calls).toBe(1)
    })
    for (const bypass of [
      'authorization',
      'cookie',
      'range',
      'if-range',
      'policy',
      'policy-error',
      'key',
      'key-error',
      'closed',
    ] as const) {
      it(`${framework} bounds the ${bypass} bypass and executes its source once`, async () => {
        const { cache, backend } = controlledCache()
        const source = deferred()
        const entered = deferred()
        let calls = 0
        const headers: Record<string, string> = {}
        if (['authorization', 'cookie', 'range', 'if-range'].includes(bypass)) headers[bypass] = 'present'
        const app = await setup(framework, {
          ...(bypass === 'closed' ? { backend, compress: false } : { cache }),
          loadTimeoutMs: 20,
          ...(bypass === 'policy' ? { shouldCache: () => false } : {}),
          ...(bypass === 'policy-error'
            ? {
                shouldCache: () => {
                  throw new Error('policy unavailable')
                },
              }
            : {}),
          ...(bypass === 'key' ? { key: () => '' } : {}),
          ...(bypass === 'key-error'
            ? {
                key: () => {
                  throw new Error('key unavailable')
                },
              }
            : {}),
          loader: async () => {
            calls++
            entered.resolve()
            await source.promise
            return 'source'
          },
        })
        if (bypass === 'closed') await app.adapter.close()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        const response = app.get(headers)
        await entered.promise
        await vi.advanceTimersByTimeAsync(20)
        const result = await response
        source.resolve()
        await app.close()
        expect(result).toMatchObject({ status: 500 })
        expect(app.errors).toHaveLength(1)
        expect(app.errors[0]).toMatchObject({ name: 'TimeoutError' })
        expect(calls).toBe(1)
        expect(backend.entries.size).toBe(0)
      })
    }
  }
  it('gives concurrent Express unsupported class results a per-request source without storage', async () => {
    const { cache, backend } = controlledCache()
    const entered = deferred()
    const source = deferred()
    class Body {
      toJSON() {
        return { value: 'per request' }
      }
    }
    let calls = 0
    const app = await setup('express', {
      cache,
      loader: async () => {
        calls++
        entered.resolve()
        await source.promise
        return new Body()
      },
    })
    const first = app.get()
    const second = app.get()
    await entered.promise
    await new Promise((resolve) => setImmediate(resolve))
    source.resolve()
    const results = await Promise.all([first, second])
    for (const result of results) {
      expect(result.status).toBe(200)
      expect(JSON.parse(result.body)).toEqual({ value: 'per request' })
    }
    expect(calls).toBe(2)
    expect(backend.entries.size).toBe(0)
    expect(backend.updateInputs).toHaveLength(0)
  })
  for (const transport of ['Response', 'Readable', 'ReadableStream'] as const) {
    it(`gives concurrent Fastify ${transport} callers independent consumable bodies without storage`, async () => {
      const { cache, backend } = controlledCache()
      const entered = deferred()
      const source = deferred()
      let calls = 0
      const app = Fastify()
      await app.register(
        adaptiveFastifyCache({
          cache,
          loader: async () => {
            calls++
            entered.resolve()
            await source.promise
            if (transport === 'Response')
              return new globalThis.Response('native bytes', {
                status: 201,
                headers: {
                  'content-type': 'text/plain',
                  'content-language': 'en',
                  'x-source': 'native',
                },
              })
            if (transport === 'Readable') return Readable.from(['native bytes'])
            return new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from('native bytes'))
                controller.close()
              },
            })
          },
        }),
      )
      app.get('/data', async () => 'route')
      const first = app.inject('/data')
      const second = app.inject('/data')
      await entered.promise
      await new Promise((resolve) => setImmediate(resolve))
      source.resolve()
      const results = await Promise.all([first, second])
      await app.close()
      for (const result of results) {
        expect(result.statusCode).toBe(transport === 'Response' ? 201 : 200)
        expect(result.payload).toBe('native bytes')
        if (transport === 'Response') {
          expect(result.headers['content-type']).toBe('text/plain')
          expect(result.headers['content-language']).toBe('en')
          expect(result.headers['x-source']).toBe('native')
        }
      }
      expect(calls).toBe(2)
      expect(backend.entries.size).toBe(0)
      expect(backend.updateInputs).toHaveLength(0)
    })
  }
})
