import crypto from 'node:crypto'
import { setImmediate } from 'node:timers'
import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { decodeHttpResponse, encodeHttpResponse } from '../src/httpResponse'
import { Logger } from '../src/lib/logger'
import { gate, registerCoreCacheFixture } from './helpers/coreCache'

const { create } = registerCoreCacheFixture()

describe('asynchronous observers', () => {
  it('contains async observer rejection without producing an unhandled rejection', async () => {
    const cache = create({
      onEvent: async () => {
        throw new Error('async observer failed')
      },
    })
    await cache.set('observed', 1)
    expect((await cache.get('observed'))?.data).toBe(1)
    await new Promise((resolve) => setImmediate(resolve))
  })
})

describe('set encoding invalidation fences', () => {
  it.each([false, true])('captures a write barrier before encoding with async=%s', async (asyncCompression) => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const cache = create({ backend, compression: { async: asyncCompression } })
    const started = gate(),
      release = gate()
    const capture = backend.captureWriteToken.bind(backend)
    vi.spyOn(backend, 'captureWriteToken').mockImplementation(async (prefix) => {
      const token = await capture(prefix)
      started.resolve()
      await release.promise
      return token
    })
    const pending = cache.set('encode-race', 'payload'.repeat(10000))
    await started.promise
    await cache.clear('encode-race')
    release.resolve()
    expect(await pending).toEqual(['INVALIDATED', 0])
    expect(await cache.get('encode-race')).toBeNull()
  })
})

describe('observable failure and policy behavior', () => {
  it('reports backend eviction counts when real capacity pressure evicts data', async () => {
    const cache = create({
      compress: false,
      lru: { namespace: crypto.randomUUID(), maxSizeBytes: 4096, maxEntrySizeBytes: 4096 },
    })
    const events: number[] = []
    cache.onEvent((event) => {
      if (event.type === 'eviction') events.push(event.count ?? 0)
    })
    for (let i = 0; i < 5; i++) await cache.set('capacity-' + i, 'x'.repeat(1500))
    expect(await cache.get('capacity-0')).toBeNull()
    expect(events.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0)
    expect(cache.getStats().counters.eviction).toBe(events.reduce((sum, count) => sum + count, 0))
  })

  it('reports malformed stored payloads as errors instead of returning corrupt data', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const cache = create({ backend })
    await backend.update({
      key: 'bad',
      dataKey: 'baddata',
      metaKey: 'badmeta',
      redisPrefix: 'adaptive:',
      encodedData: 'adaptive-cache:v2:gzip:not-gzip',
      responseHash: 'bad',
      initialTTL: 10,
      maxTTL: 10,
      ttlScaling: 2,
      metaTTL: 10,
      tags: [],
    })
    await expect(cache.get('bad')).rejects.toThrow()
    expect(cache.getStats().counters.error).toBe(1)
    expect(cache.getStats().counters.hit).toBe(0)
    expect(() => cache.client).toThrow('not using a Redis-backed backend')
  })

  it('rejects unsupported async encoding before attempting an unfenced write', async () => {
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const cache = create({
      compression: { async: true },
      backend: {
        name: 'custom',
        fetch: lru.fetch.bind(lru),
        update: lru.update.bind(lru),
        clear: lru.clear.bind(lru),
        invalidateTags: lru.invalidateTags.bind(lru),
        shouldRefresh: lru.shouldRefresh.bind(lru),
        releaseLock: lru.releaseLock.bind(lru),
        quit: lru.quit.bind(lru),
      },
    })
    expect(cache.supportsWriteFencing()).toBe(false)
    await expect(cache.captureWriteToken()).rejects.toThrow('captureWriteToken')
    await expect(cache.set('unsafe', 'value')).rejects.toThrow('asynchronous encoding')
    expect(await cache.get('unsafe')).toBeNull()
  })

  it('does not run a loader if a value arrives between its miss and lock acquisition', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const cache = create({ backend })
    const started = gate(),
      release = gate()
    const acquire = backend.shouldRefresh.bind(backend)
    vi.spyOn(backend, 'shouldRefresh').mockImplementation(async (...args) => {
      started.resolve()
      await release.promise
      return acquire(...args)
    })
    let calls = 0
    const loading = cache.getOrSet('arrived', async () => {
      calls++
      return 'redundant'
    })
    await started.promise
    await cache.set('arrived', 'another writer')
    release.resolve()
    expect(await loading).toBe('another writer')
    expect(calls).toBe(0)
  })

  it('retries a failed SWR refresh without dropping the bounded stale value', async () => {
    const cache = create({ staleWhileRevalidate: 10 })
    await cache.set('swr-retry', 'old')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    expect(
      await cache.getOrSet('swr-retry', async () => {
        throw new Error('offline')
      }),
    ).toBe('old')
    await cache.flush()
    expect(cache.getStats().counters.error).toBe(1)
    expect(await cache.getOrSet('swr-retry', async () => 'recovered')).toBe('old')
    await cache.flush()
    expect((await cache.get('swr-retry'))?.data).toBe('recovered')
  })

  it('classifies application-level negative results with an independent TTL cap', async () => {
    const cache = create({ initialTTL: 20 })
    const missing = { status: 404, message: 'missing' }
    const options = { isNegative: (data: typeof missing) => data.status === 404, negativeTTL: 1 }
    expect(await cache.getOrSet('status-negative', async () => missing, options)).toEqual(missing)
    expect((await cache.get('status-negative'))?.ttl).toBeLessThanOrEqual(1)
    expect(
      await cache.getOrSet('status-negative', async () => ({ status: 200, message: 'unexpected' }), options),
    ).toEqual(missing)
  })
})

describe('reviewed background and codec guarantees', () => {
  it('ends background lock contention without polling or reporting a timeout after stale was served', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const first = create({ backend, staleWhileRevalidate: 10 })
    const second = create({ backend, staleWhileRevalidate: 10, lockWaitTimeoutMs: 0 })
    await first.set('swr-owner', 'old')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    const started = gate(),
      release = gate()
    expect(
      await first.getOrSet('swr-owner', async () => {
        started.resolve()
        await release.promise
        return 'new'
      }),
    ).toBe('old')
    await started.promise
    let waiterCalls = 0
    expect(
      await second.getOrSet('swr-owner', async () => {
        waiterCalls++
        return 'unexpected'
      }),
    ).toBe('old')
    await second.flush()
    const stats = second.getStats()
    release.resolve()
    await first.flush()
    expect(stats.counters['lock-contention']).toBe(1)
    expect(stats.counters.error).toBe(0)
    expect(waiterCalls).toBe(0)
    expect((await second.get('swr-owner'))?.data).toBe('new')
  })

  it('skips compression of binary HTTP envelopes while preserving their body and metadata', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const cache = create({ backend, compression: { skipCompressed: true, onlyIfSmaller: false } })
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7xsAAAAASUVORK5CYII=',
      'base64',
    )
    for (const [key, body] of [
      ['http-png', png],
      ['http-gzip', zlib.gzipSync('compressed'.repeat(1000))],
    ] as const) {
      const response = encodeHttpResponse(body, 206, 'application/octet-stream', { etag: 'revision' })
      await cache.set(key, response)
      const stored = await backend.fetch({
        key,
        dataKey: key + 'data',
        metaKey: key + 'meta',
        redisPrefix: 'adaptive:',
        includeDebugHeaders: false,
      })
      expect(stored?.encodedData).toMatch(/^adaptive-cache:v2:json:/)
      expect(decodeHttpResponse((await cache.get(key))?.data)).toMatchObject({
        body,
        statusCode: 206,
        headers: { etag: 'revision' },
      })
    }
  })

  it('reports rejected fenced writes distinctly without counting them as stored writes', async () => {
    const cache = create()
    const events: Array<{ type: string; reason?: string }> = []
    cache.onEvent((event) => {
      events.push({ type: event.type, reason: event.reason })
    })
    const writeToken = await cache.captureWriteToken()
    await cache.clear('reject-observed')
    expect(await cache.set('reject-observed', 'old', { writeToken })).toEqual(['INVALIDATED', 0])
    expect(events).toContainEqual({ type: 'invalidate', reason: 'write-rejected' })
    expect(cache.getStats().counters.write).toBe(0)
    expect(await cache.get('reject-observed')).toBeNull()
  })
})
