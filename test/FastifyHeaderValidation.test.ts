import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { controlledCache } from './helpers/httpFixtures'

describe('Fastify header-name validation', () => {
  for (const mode of ['handler', 'loader'] as const) {
    it.each([{ enum: ['X-Debug-Override'] }, { const: 'X-Debug-Override' }])(
      `${mode} rejects forbidden header names before cold and warm cache access with %j`,
      async (constraint) => {
        const { cache, backend } = controlledCache()
        const fetch = vi.spyOn(backend, 'fetch')
        const load = vi.fn(async () => ({ value: 'allowed' }))
        const app = Fastify()
        const adapter = adaptiveFastifyCache({ cache, ...(mode === 'loader' ? { loader: load } : {}) })
        await app.register(adapter)
        app.get('/data', { schema: { headers: { type: 'object', propertyNames: { not: constraint } } } }, load)
        const forbidden = () => app.inject({ url: '/data', headers: { 'X-Debug-Override': 'true' } })
        try {
          expect((await forbidden()).statusCode).toBe(400)
          expect(fetch).not.toHaveBeenCalled()
          expect(load).not.toHaveBeenCalled()
          expect(backend.updateInputs).toHaveLength(0)

          expect((await app.inject('/data')).json()).toEqual({ value: 'allowed' })
          await adapter.flush()
          const reads = fetch.mock.calls.length
          expect((await forbidden()).statusCode).toBe(400)
          expect(fetch).toHaveBeenCalledTimes(reads)
          expect(load).toHaveBeenCalledTimes(1)
          expect(backend.updateInputs).toHaveLength(1)

          const hit = await app.inject('/data')
          expect(hit.headers['x-cache']).toBe('HIT')
          expect(hit.json()).toEqual({ value: 'allowed' })
          expect(load).toHaveBeenCalledTimes(1)
        } finally {
          await app.close()
          await cache.close()
        }
      },
    )
  }
})
