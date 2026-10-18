import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import Fastify from 'fastify'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { adaptiveExpressCache, type ExpressRequestLike } from '../src/AdaptiveExpressCache'
import { adaptiveFastifyCache, type FastifyRequestLike } from '../src/AdaptiveFastifyCache'
import type { HttpPolicyOptions } from '../src/httpPolicy'
import type {
  AdaptiveCacheBackend,
  AdaptiveCacheBackendFetchInput,
  AdaptiveCacheBackendUpdateInput,
  AdaptiveCacheFetchResult,
  AdaptiveCacheOptions,
} from '../src/types'

class FencedBackend implements AdaptiveCacheBackend {
  readonly name = 'custom' as const
  readonly entries = new Map<string, AdaptiveCacheFetchResult>()
  generation = 0
  quitCalls = 0
  async captureWriteToken() {
    return String(this.generation)
  }
  async fetch(input: AdaptiveCacheBackendFetchInput) {
    return this.entries.get(input.key) || null
  }
  async update(input: AdaptiveCacheBackendUpdateInput) {
    if (input.writeToken !== undefined && input.writeToken !== String(this.generation))
      return ['INVALIDATED', 0] as const
    this.entries.set(input.key, { encodedData: input.encodedData, ttl: input.maxTTL })
    return ['CACHED', input.maxTTL] as const
  }
  async clear(key: string) {
    this.generation++
    this.entries.delete(key)
  }
  async invalidateTags() {
    return []
  }
  async shouldRefresh() {
    return ['UPDATE', 'lock'] as const
  }
  async releaseLock() {
    return ['UPDATED'] as const
  }
  async flush() {}
  async quit() {
    this.quitCalls++
  }
}

type RequestLike = ExpressRequestLike | FastifyRequestLike
type Options = AdaptiveCacheOptions &
  HttpPolicyOptions<RequestLike> & {
    cache?: AdaptiveCache
    loader?: (req: RequestLike) => Promise<unknown>
  }
type Handler = (headers: Record<string, unknown>) => Promise<{
  status?: number
  headers?: Record<string, string>
  body: string
}>
const clearRequest = (headers: Record<string, string> = {}, query: Record<string, string> = {}) => ({
  method: 'DELETE',
  originalUrl: '/resource?ignored=url',
  url: '/resource?ignored=url',
  query,
  headers: { host: 'localhost:80', ...headers },
})

const createApp = async (framework: 'Express' | 'Fastify', options: Options, handler: Handler) => {
  if (framework === 'Express') {
    const adapter = adaptiveExpressCache(options)
    const app = express()
    app.get('/resource', adapter, async (req, res) => {
      const response = await handler(req.headers)
      for (const [name, value] of Object.entries(response.headers || {})) res.set(name, value)
      res.status(response.status || 200).send(response.body)
    })
    return {
      adapter,
      send: async (url = '/resource', headers: Record<string, string> = {}) => {
        const response = await request(app).get(url).set('Host', 'localhost:80').set(headers)
        return { status: response.status, body: response.text, headers: response.headers }
      },
      close: () => adapter.close(),
    }
  }
  const adapter = adaptiveFastifyCache(options)
  const app = Fastify()
  await app.register(adapter)
  app.get('/resource', async (req, reply) => {
    const response = await handler(req.headers)
    for (const [name, value] of Object.entries(response.headers || {})) reply.header(name, value)
    return reply.code(response.status || 200).send(response.body)
  })
  return {
    adapter,
    send: async (url = '/resource', headers: Record<string, string> = {}) => {
      const response = await app.inject({ url, headers: { host: 'localhost:80', ...headers } })
      return { status: response.statusCode, body: response.body, headers: response.headers }
    },
    close: () => app.close(),
  }
}

for (const framework of ['Express', 'Fastify'] as const) {
  describe(`${framework} release HTTP regressions`, () => {
    it.each(['range', 'if-range'])('bypasses %s before and after a full response is cached', async (header) => {
      const backend = new FencedBackend()
      let calls = 0
      const app = await createApp(framework, { backend, compress: false }, async (headers) => {
        calls++
        return headers[header]
          ? { status: 206, headers: { 'Content-Range': 'bytes 0-2/10' }, body: 'abc' }
          : { body: 'abcdefghij' }
      })
      try {
        const partial = await app.send('/resource', { [header]: header === 'range' ? 'bytes=0-2' : '"version"' })
        await app.adapter.flush()
        expect(partial.status).toBe(206)
        expect(partial.headers['x-cache']).toBe('BYPASS')
        expect(backend.entries.size).toBe(0)
        expect((await app.send()).body).toBe('abcdefghij')
        await app.adapter.flush()
        expect((await app.send()).headers['x-cache']).toBe('HIT')
        const afterHit = await app.send('/resource', { [header]: 'bytes=0-2' })
        expect(afterHit.status).toBe(206)
        expect(afterHit.body).toBe('abc')
        expect(afterHit.headers['content-range']).toBe('bytes 0-2/10')
        expect(calls).toBe(3)
        expect((await app.send()).body).toBe('abcdefghij')
      } finally {
        await app.close()
      }
    })

    it('never stores a 206 response even without a Range request', async () => {
      const backend = new FencedBackend()
      let calls = 0
      const app = await createApp(framework, { backend, compress: false }, async () => ({
        status: 206,
        body: String(++calls),
      }))
      try {
        expect((await app.send()).body).toBe('1')
        await app.adapter.flush()
        expect((await app.send()).body).toBe('2')
        await app.adapter.flush()
        expect(backend.entries.size).toBe(0)
      } finally {
        await app.close()
      }
    })

    it.each([true, false])(
      'runs its loader after request-policy failure with includeHeaders=%s',
      async (includeHeaders) => {
        const backend = new FencedBackend()
        let loads = 0
        let handlers = 0
        const app = await createApp(
          framework,
          {
            backend,
            compress: false,
            includeHeaders,
            shouldCache: () => {
              throw new Error('policy failed')
            },
            loader: async () => `loaded-${++loads}`,
          },
          async () => ({ body: `handler-${++handlers}` }),
        )
        try {
          const first = await app.send()
          expect(first.status).toBe(200)
          expect(first.body).toBe('loaded-1')
          expect(first.headers['x-cache']).toBe('RETRY')
          expect((await app.send()).body).toBe('loaded-2')
          expect(handlers).toBe(0)
          await app.adapter.flush()
          expect(backend.entries.size).toBe(0)
        } finally {
          await app.close()
        }
      },
    )

    it.each(['custom', 'headers', 'callback'] as const)(
      'clears only the selected %s identity using an injected cache',
      async (identity) => {
        const backend = new FencedBackend()
        const cache = new AdaptiveCache({ backend, compress: false })
        const options: Options = {
          cache,
          redisPrefix: 'legacy:',
          keyPrefix: identity === 'headers' ? undefined : 'selected:',
          ignoreQueryParams: ['tracking'],
          key: identity === 'custom' ? () => 'shared-resource' : undefined,
          varyBy: identity === 'callback' ? (req) => req.headers?.['x-tenant'] : ['x-tenant'],
        }
        let calls = 0
        const app = await createApp(framework, options, async () => ({ body: String(++calls) }))
        try {
          expect((await app.send('/resource?q=value&tracking=one', { 'x-tenant': 'a' })).body).toBe('1')
          await app.adapter.flush()
          expect((await app.send('/resource?q=value&tracking=two', { 'x-tenant': 'b' })).body).toBe('2')
          await app.adapter.flush()
          await app.adapter.close()
          expect(backend.quitCalls).toBe(0)
          const req = clearRequest(
            { 'x-tenant': 'a', authorization: 'mutation-caller' },
            { q: 'value', tracking: 'other' },
          )
          if (identity === 'custom') {
            req.originalUrl = '/alias'
            req.url = '/alias'
            req.query.q = 'changed'
          }
          await app.adapter.clear(req)
          expect(backend.entries.size).toBe(1)
          expect((await app.send('/resource?q=value&tracking=three', { 'x-tenant': 'b' })).body).toBe('2')
          expect((await app.send('/resource?q=value&tracking=four', { 'x-tenant': 'a' })).body).toBe('3')
          expect(
            [...backend.entries.keys()].every((key) =>
              key.startsWith(identity === 'headers' ? 'legacy:' : 'selected:'),
            ),
          ).toBe(true)
        } finally {
          await app.close()
          await cache.close()
        }
      },
    )

    it('rejects invalid custom identities and clears after owned closure explicitly', async () => {
      const backend = new FencedBackend()
      const app = await createApp(framework, { backend, key: () => '  ' }, async () => ({ body: 'unused' }))
      try {
        await expect(app.adapter.clear(clearRequest())).rejects.toThrow('non-empty string')
        expect(backend.generation).toBe(0)
        await app.adapter.close()
        await expect(app.adapter.clear(clearRequest())).rejects.toThrow('closed')
      } finally {
        await app.close()
      }
    })

    it('fences a handler that was already running when its request identity was cleared', async () => {
      const backend = new FencedBackend()
      const cache = new AdaptiveCache({ backend, compress: false })
      let started!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      let calls = 0
      const app = await createApp(
        framework,
        { cache, keyPrefix: 'fenced:', key: () => 'item', varyBy: ['x-tenant'] },
        async () => {
          calls++
          if (calls === 1) {
            started()
            await barrier
          }
          return { body: String(calls) }
        },
      )
      try {
        const first = app.send('/resource', { 'x-tenant': 'a' })
        await entered
        await app.adapter.clear(clearRequest({ 'x-tenant': 'a' }))
        release()
        await first
        await app.adapter.flush()
        expect(backend.entries.size).toBe(0)
        const afterClear = await app.send('/resource', { 'x-tenant': 'a' })
        expect(afterClear.headers['x-cache']).toBe('MISS')
        expect(afterClear.body).toBe('2')
      } finally {
        release()
        await app.close()
        await cache.close()
      }
    })
  })
}
