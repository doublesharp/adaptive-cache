import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import Fastify from 'fastify'
import { adaptiveExpressCache } from '../src/AdaptiveExpressCache'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { controlledCache } from './helpers/httpFixtures'

describe('HTTP cache-control storage and reuse', () => {
  for (const framework of ['express', 'fastify'] as const) {
    for (const mode of ['handler', 'loader'] as const) {
      it.each(['request no-store', 'request no-cache', 'response no-cache'])(
        `${framework} ${mode} honors %s on cold and warm requests`,
        async (restriction) => {
          const { cache, backend } = controlledCache()
          let calls = 0
          const load = async () => String(++calls)
          const options = { cache, ...(mode === 'loader' ? { loader: load } : {}) }
          let get: (directive?: string) => Promise<string>
          let close = async () => {}
          let flush: () => Promise<void>
          if (framework === 'express') {
            const app = express()
            const adapter = adaptiveExpressCache(options)
            if (restriction === 'response no-cache')
              app.use((_req, res, next) => {
                res.set('Cache-Control', 'no-cache')
                next()
              })
            app.get('/data', adapter, async (_req, res) => res.send(await load()))
            get = (directive) => {
              const pending = request(app).get('/data').set('Host', 'localhost')
              if (directive) pending.set('Cache-Control', directive)
              return pending.then((response) => response.text)
            }
            flush = adapter.flush
          } else {
            const app = Fastify()
            const adapter = adaptiveFastifyCache(options)
            await app.register(adapter)
            if (restriction === 'response no-cache')
              app.addHook('onSend', async (_req, reply, payload) => {
                reply.header('Cache-Control', 'no-cache')
                return payload
              })
            app.get('/data', load)
            get = (directive) =>
              app
                .inject({ url: '/data', headers: directive ? { 'cache-control': directive } : {} })
                .then((response) => response.payload)
            close = () => app.close()
            flush = adapter.flush
          }
          try {
            const directive = restriction.startsWith('request ') ? restriction.slice('request '.length) : undefined
            expect(await get(directive)).toBe('1')
            await flush()
            expect(backend.updateInputs).toHaveLength(0)
            expect(await get()).toBe('2')
            await flush()
            expect(await get(directive)).toBe('3')
            await flush()
            if (directive) {
              expect(await get()).toBe('2')
              expect(calls).toBe(3)
              expect(backend.updateInputs).toHaveLength(1)
            } else {
              expect(await get()).toBe('4')
              expect(calls).toBe(4)
              expect(backend.updateInputs).toHaveLength(0)
            }
          } finally {
            await close()
            await cache.close()
          }
        },
      )
    }
  }
})
