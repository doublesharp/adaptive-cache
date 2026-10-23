import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import Fastify from 'fastify'
import { adaptiveExpressCache } from '../src/AdaptiveExpressCache'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { controlledCache } from './helpers/httpFixtures'

describe('HTTP representation safety', () => {
  it('inspects typed-array bounds without invoking an inherited length getter', async () => {
    const { cache } = controlledCache()
    const app = Fastify()
    let lengthReads = 0
    let calls = 0
    class Bytes extends Uint8Array {
      get length() {
        lengthReads++
        this[0] = 88
        return super.length
      }
    }
    const adapter = adaptiveFastifyCache({ cache })
    await app.register(adapter)
    app.get('/data', async () => {
      calls++
      return new Bytes(Buffer.from('public'))
    })
    try {
      expect((await app.inject('/data')).payload).toBe('public')
      await adapter.flush()
      const hit = await app.inject('/data')
      expect(hit.payload).toBe('public')
      expect(hit.headers['x-cache']).toBe('HIT')
      expect(calls).toBe(1)
      expect(lengthReads).toBe(0)
    } finally {
      await app.close()
      await cache.close()
    }
  })

  for (const mode of ['handler', 'loader'] as const) {
    it.each([
      'undefined',
      'negative zero',
      'sparse array',
      'shared reference',
      'readonly',
      'nonconfigurable',
      'nonextensible',
      'readonly length',
    ] as const)(`${mode} preserves %s semantics used by redaction hooks`, async (kind) => {
      const { cache, backend } = controlledCache()
      const app = Fastify()
      const value = { public: 'visible', password: 'secret' }
      let body: any = { ...value }
      let redact: (payload: any) => boolean
      if (kind === 'undefined') {
        body.marker = undefined
        redact = (payload) => Object.hasOwn(payload, 'marker')
      } else if (kind === 'negative zero') {
        body.marker = -0
        redact = (payload) => Object.is(payload.marker, -0)
      } else if (kind === 'sparse array') {
        body = [value]
        body.length = 2
        redact = (payload) => !(1 in payload)
      } else if (kind === 'shared reference') {
        body = { first: value, second: value }
        redact = (payload) => payload.first === payload.second
      } else if (kind === 'readonly') {
        Object.defineProperty(body, 'marker', { value: true, enumerable: true })
        redact = (payload) => Object.getOwnPropertyDescriptor(payload, 'marker')?.writable === false
      } else if (kind === 'nonconfigurable') {
        Object.defineProperty(body, 'marker', { value: true, enumerable: true, writable: true })
        redact = (payload) => Object.getOwnPropertyDescriptor(payload, 'marker')?.configurable === false
      } else if (kind === 'nonextensible') {
        Object.preventExtensions(body)
        redact = (payload) => !Object.isExtensible(payload)
      } else {
        body = [value]
        Object.defineProperty(body, 'length', { writable: false })
        redact = (payload) => Object.getOwnPropertyDescriptor(payload, 'length')?.writable === false
      }
      let calls = 0
      const load = async () => {
        calls++
        return body
      }
      const adapter = adaptiveFastifyCache({ cache, ...(mode === 'loader' ? { loader: load } : {}) })
      await app.register(adapter)
      app.addHook('preSerialization', async (_req, _reply, payload: any) =>
        redact(payload) ? { public: 'visible' } : payload,
      )
      app.get('/data', load)
      try {
        expect((await app.inject('/data')).json()).toEqual({ public: 'visible' })
        await adapter.flush()
        expect((await app.inject('/data')).json()).toEqual({ public: 'visible' })
        expect(calls).toBe(2)
        expect(backend.updateInputs).toHaveLength(0)
      } finally {
        await app.close()
        await cache.close()
      }
    })
  }

  for (const mode of ['express-loader', 'fastify-loader', 'fastify-handler'] as const) {
    it.each(['buffer', 'typed array', 'data view'] as const)(`${mode} preserves nested %s redaction`, async (kind) => {
      const { cache, backend } = controlledCache()
      const bytes = Buffer.from('secret')
      const credential =
        kind === 'buffer' ? bytes : kind === 'typed array' ? new Uint8Array(bytes) : new DataView(bytes.buffer)
      Object.defineProperty(credential, 'toJSON', { value: () => '[redacted]' })
      let calls = 0
      const load = async () => {
        calls++
        return { credential }
      }
      let get: () => Promise<unknown>
      let close = async () => {}
      let flush: () => Promise<void>
      if (mode === 'express-loader') {
        const app = express()
        const adapter = adaptiveExpressCache({ cache, loader: load })
        app.get('/data', adapter)
        get = () =>
          request(app)
            .get('/data')
            .set('Host', 'localhost')
            .then((r) => r.body)
        flush = adapter.flush
      } else {
        const app = Fastify()
        const adapter = adaptiveFastifyCache({ cache, ...(mode === 'fastify-loader' ? { loader: load } : {}) })
        await app.register(adapter)
        app.get('/data', load)
        get = () => app.inject('/data').then((r) => r.json())
        close = () => app.close()
        flush = adapter.flush
      }
      try {
        expect(await get()).toEqual({ credential: '[redacted]' })
        await flush()
        expect(await get()).toEqual({ credential: '[redacted]' })
        expect(calls).toBe(2)
        expect(backend.updateInputs).toHaveLength(0)
      } finally {
        await close()
        await cache.close()
      }
    })
  }

  for (const mode of ['handler', 'loader'] as const) {
    it.each(['own', 'symbol', 'inherited', 'non-index number'] as const)(
      `${mode} preserves %s binary metadata used by send hooks`,
      async (kind) => {
        const { cache, backend } = controlledCache()
        const app = Fastify()
        const marker =
          kind === 'symbol' ? Symbol('redact') : kind === 'non-index number' ? '9007199254740993' : 'redact'
        const body = Buffer.from('secret')
        if (kind === 'inherited')
          Object.setPrototypeOf(body, Object.create(Buffer.prototype, { [marker]: { value: true } }))
        else Object.defineProperty(body, marker, { value: true })
        let calls = 0
        const load = async () => {
          calls++
          return body
        }
        const adapter = adaptiveFastifyCache({ cache, ...(mode === 'loader' ? { loader: load } : {}) })
        await app.register(adapter)
        app.addHook('onSend', async (_req, _reply, payload: any) => (payload[marker] ? '[redacted]' : payload))
        app.get('/data', load)
        try {
          expect((await app.inject('/data')).payload).toBe('[redacted]')
          await adapter.flush()
          expect((await app.inject('/data')).payload).toBe('[redacted]')
          expect(calls).toBe(2)
          expect(backend.updateInputs).toHaveLength(0)
        } finally {
          await app.close()
          await cache.close()
        }
      },
    )
  }

  it.each(['hidden', 'symbol', 'array metadata', 'array non-index number'] as const)(
    'preserves %s used by response redaction hooks',
    async (kind) => {
      const { cache, backend } = controlledCache()
      const app = Fastify()
      const marker = kind === 'symbol' ? Symbol('redact') : kind === 'array non-index number' ? '4294967295' : 'redact'
      const value = { public: 'visible', password: 'secret' }
      const body: any = kind.startsWith('array') ? [value] : value
      Object.defineProperty(body, marker, {
        value: true,
        enumerable: kind !== 'hidden',
        writable: true,
        configurable: true,
      })
      let calls = 0
      const adapter = adaptiveFastifyCache({
        cache,
        loader: async () => {
          calls++
          return body
        },
      })
      await app.register(adapter)
      app.addHook('preSerialization', async (_req, _reply, payload: any) =>
        payload[marker] ? { public: value.public } : payload,
      )
      app.get('/data', async () => 'unused')
      try {
        expect((await app.inject('/data')).json()).toEqual({ public: 'visible' })
        await adapter.flush()
        expect((await app.inject('/data')).json()).toEqual({ public: 'visible' })
        expect(calls).toBe(2)
        expect(backend.updateInputs).toHaveLength(0)
      } finally {
        await app.close()
        await cache.close()
      }
    },
  )

  it.each(['express-loader', 'fastify-loader', 'fastify-handler'] as const)(
    '%s preserves non-enumerable toJSON redaction and bypasses storage',
    async (mode) => {
      const { cache, backend } = controlledCache()
      let calls = 0
      const load = async () => {
        calls++
        const value = { public: 'visible', password: 'secret' }
        Object.defineProperty(value, 'toJSON', { value: () => ({ public: value.public }) })
        return value
      }
      let get: () => Promise<unknown>
      let close = async () => {}
      let flush: () => Promise<void>
      if (mode === 'express-loader') {
        const app = express()
        const adapter = adaptiveExpressCache({ cache, loader: load })
        app.get('/data', adapter)
        get = () =>
          request(app)
            .get('/data')
            .set('Host', 'localhost')
            .then((r) => r.body)
        flush = adapter.flush
      } else {
        const app = Fastify()
        const adapter = adaptiveFastifyCache({ cache, ...(mode === 'fastify-loader' ? { loader: load } : {}) })
        await app.register(adapter)
        app.get('/data', load)
        get = () => app.inject('/data').then((r) => r.json())
        close = () => app.close()
        flush = adapter.flush
      }
      try {
        expect(await get()).toEqual({ public: 'visible' })
        await flush()
        expect(await get()).toEqual({ public: 'visible' })
        await flush()
        expect(calls).toBe(2)
        expect(backend.updateInputs).toHaveLength(0)
      } finally {
        await close()
        await cache.close()
      }
    },
  )

  it.each(['handler', 'loader'] as const)('%s does not inspect or cache bodies with getters', async (mode) => {
    const { cache, backend } = controlledCache()
    const app = Fastify()
    let calls = 0
    const reads: number[] = []
    const load = async () => {
      const index = calls++
      reads[index] = 0
      return {
        get value() {
          return ++reads[index] === 2 ? 'secret' : 'public'
        },
      }
    }
    const adapter = adaptiveFastifyCache({ cache, ...(mode === 'loader' ? { loader: load } : {}) })
    await app.register(adapter)
    app.addHook('onSend', async (_req, reply, payload) => {
      if (String(payload).includes('secret')) reply.header('Cache-Control', 'private')
      return payload
    })
    app.get('/data', load)
    try {
      expect((await app.inject('/data')).json()).toEqual({ value: 'public' })
      await adapter.flush()
      expect((await app.inject('/data')).json()).toEqual({ value: 'public' })
      await adapter.flush()
      expect(calls).toBe(2)
      expect(reads).toEqual([1, 1])
      expect(backend.updateInputs).toHaveLength(0)
    } finally {
      await app.close()
      await cache.close()
    }
  })

  it('preserves a handler-installed serializer on every response', async () => {
    const { cache, backend } = controlledCache()
    const app = Fastify()
    const adapter = adaptiveFastifyCache({ cache })
    let calls = 0
    await app.register(adapter)
    app.get('/data', async (_req, reply) => {
      calls++
      reply.type('application/json').serializer((value) => JSON.stringify({ public: value.public }))
      return { public: 'visible', password: 'secret' }
    })
    try {
      expect((await app.inject('/data')).json()).toEqual({ public: 'visible' })
      await adapter.flush()
      expect((await app.inject('/data')).json()).toEqual({ public: 'visible' })
      await adapter.flush()
      expect(calls).toBe(2)
      expect(backend.updateInputs).toHaveLength(0)
    } finally {
      await app.close()
      await cache.close()
    }
  })

  it.each(['circular', 'deep', 'proxy'] as const)(
    'lets preSerialization handle a %s body without cache inspection throwing',
    async (kind) => {
      const { cache, backend } = controlledCache()
      const app = Fastify()
      const adapter = adaptiveFastifyCache({ cache })
      await app.register(adapter)
      let body: any = {}
      if (kind === 'circular') body.self = body
      if (kind === 'deep') for (let depth = 0; depth < 15000; depth++) body = { nested: body }
      if (kind === 'proxy')
        body = new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('Cannot enumerate transport')
            },
          },
        )
      app.addHook('preSerialization', async (_req, _reply, payload: any) => {
        expect(payload).toBe(body)
        return { ok: true }
      })
      app.get('/data', async () => body)
      try {
        const response = await app.inject('/data')
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ ok: true })
        await adapter.flush()
        expect(backend.updateInputs).toHaveLength(0)
      } finally {
        await app.close()
        await cache.close()
      }
    },
  )
})
