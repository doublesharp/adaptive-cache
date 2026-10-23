import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import Fastify from 'fastify'
import { setImmediate, setTimeout as realTimeout } from 'node:timers/promises'
import { adaptiveExpressCache } from '../src/AdaptiveExpressCache'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { controlledCache } from './helpers/httpFixtures'
import { gate } from './helpers/coreCache'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('HTTP review regressions', () => {
  for (const framework of ['express', 'fastify'] as const) {
    it(`${framework} keeps cookie-setting loader responses private to each concurrent request`, async () => {
      const { cache, backend } = controlledCache()
      const entered = gate(),
        release = gate()
      let requests = 0,
        calls = 0
      const loader = async (req: { headers?: Record<string, unknown> }) => {
        calls++
        await release.promise
        return { user: req.headers?.['x-user'] }
      }
      let get: (user: string) => Promise<unknown>
      let close = async () => {}
      if (framework === 'express') {
        const app = express()
        app.use((req, res, next) => {
          res.set('Set-Cookie', `session=${req.headers['x-user']}`)
          if (++requests === 2) entered.resolve()
          next()
        })
        app.get('/data', adaptiveExpressCache({ cache, loader }))
        get = (user) =>
          request(app)
            .get('/data')
            .set('Host', 'localhost')
            .set('x-user', user)
            .then((r) => r.body)
      } else {
        const app = Fastify()
        app.addHook('onRequest', async (req, reply) => {
          reply.header('Set-Cookie', `session=${req.headers['x-user']}`)
          if (++requests === 2) entered.resolve()
        })
        await app.register(adaptiveFastifyCache({ cache, loader }))
        app.get('/data', async () => 'unused')
        get = (user) => app.inject({ url: '/data', headers: { 'x-user': user } }).then((r) => r.json())
        close = () => app.close()
      }
      try {
        const first = get('alice'),
          second = get('bob')
        await entered.promise
        await setImmediate()
        release.resolve()
        expect(await Promise.all([first, second])).toEqual([{ user: 'alice' }, { user: 'bob' }])
        expect(calls).toBe(2)
        expect(backend.updateInputs).toHaveLength(0)
      } finally {
        release.resolve()
        await close()
        await cache.close()
      }
    })

    for (const stage of ['fetch', 'captureWriteToken'] as const) {
      it(`${framework} falls through when ordinary middleware stalls at ${stage}`, async () => {
        const { cache, backend } = controlledCache()
        const entered = gate(),
          release = gate()
        const original = backend[stage].bind(backend)
        vi.spyOn(backend, stage).mockImplementation(async (...args: any[]) => {
          entered.resolve()
          await release.promise
          return (original as (...args: any[]) => any)(...args)
        })
        let calls = 0
        let get: () => Promise<{ status: number; body: string }>
        let close = async () => {}
        if (framework === 'express') {
          const app = express()
          app.get('/data', adaptiveExpressCache({ cache, loadTimeoutMs: 20 }), (_req, res) => {
            calls++
            res.send('available')
          })
          get = () =>
            request(app)
              .get('/data')
              .set('Host', 'localhost')
              .then((r) => ({ status: r.status, body: r.text }))
        } else {
          const app = Fastify()
          await app.register(adaptiveFastifyCache({ cache, loadTimeoutMs: 20 }))
          app.get('/data', async () => {
            calls++
            return 'available'
          })
          get = () => app.inject('/data').then((r) => ({ status: r.statusCode, body: r.payload }))
          close = () => app.close()
        }
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        const response = get()
        try {
          await entered.promise
          await vi.advanceTimersByTimeAsync(20)
          const result = await Promise.race([response, realTimeout(250).then(() => 'unbounded')])
          release.resolve()
          await response
          expect(result).toEqual({ status: 200, body: 'available' })
          expect(calls).toBe(1)
          expect(backend.updateInputs).toHaveLength(0)
        } finally {
          release.resolve()
          vi.useRealTimers()
          await close()
          await cache.close()
        }
      })
    }
  }

  it('gives coalesced Fastify responses independent mutable JSON bodies', async () => {
    const { cache } = controlledCache()
    const app = Fastify()
    const release = gate(),
      started = gate()
    let calls = 0
    const bodies: unknown[] = []
    await app.register(
      adaptiveFastifyCache({
        cache,
        loader: async () => {
          calls++
          started.resolve()
          await release.promise
          return { nested: { user: 'none' } }
        },
      }),
    )
    app.addHook('preSerialization', async (req, _reply, payload) => {
      bodies.push(payload)
      expect((payload as { nested: { user: unknown } }).nested.user).toBe('none')
      ;(payload as { nested: { user: unknown } }).nested.user = req.headers['x-user']
      await setImmediate()
      return payload
    })
    app.get('/data', async () => 'unused')
    try {
      const first = app.inject({ url: '/data', headers: { 'x-user': 'alice' } })
      const second = app.inject({ url: '/data', headers: { 'x-user': 'bob' } })
      await started.promise
      await setImmediate()
      release.resolve()
      const results = await Promise.all([first, second])
      expect(results.map((r) => r.json())).toEqual([{ nested: { user: 'alice' } }, { nested: { user: 'bob' } }])
      expect(calls).toBe(1)
      expect(bodies[0]).not.toBe(bodies[1])
    } finally {
      release.resolve()
      await app.close()
      await cache.close()
    }
  })
})
