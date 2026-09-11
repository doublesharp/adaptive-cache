import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import * as payload from '../src/payload'
import type { AdaptiveCacheBackend, AdaptiveCacheBackendFetchInput, AdaptiveCacheFetchResult } from '../src/types'

const caches: AdaptiveCache[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(caches.splice(0).map((cache) => cache.close()))
})
const gate = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const result = (value: unknown): AdaptiveCacheFetchResult => ({
  encodedData: JSON.stringify(value),
  ttl: 10,
  layer: 'lru',
})
const custom = (
  fetchMany?: (inputs: AdaptiveCacheBackendFetchInput[]) => Promise<(AdaptiveCacheFetchResult | null)[]>,
) => {
  const backend: AdaptiveCacheBackend = {
    name: 'custom',
    fetch: vi.fn(async () => result('fallback')),
    fetchMany,
    update: async () => ['CACHED', 10],
    clear: async () => {},
    invalidateTags: async () => [],
    shouldRefresh: async () => ['UPDATE', 'owner'],
    releaseLock: async () => ['UPDATED'],
    quit: vi.fn(async () => {}),
  }
  return backend
}
const create = (backend: AdaptiveCacheBackend, extra = {}) => {
  const cache = new AdaptiveCache({ backend, compress: false, logLevel: 'silent', ...extra })
  caches.push(cache)
  return cache
}
const input = (key: string, allowStale = false): AdaptiveCacheBackendFetchInput => ({
  key,
  dataKey: key + 'data',
  metaKey: key + 'meta',
  redisPrefix: 'batch:',
  includeDebugHeaders: true,
  allowStale,
})
const lru = (extra = {}) => {
  const backend = new ClusteredLruAdaptiveCacheBackend(
    { namespace: `batch-${crypto.randomUUID()}` },
    new Logger('silent'),
  )
  const cache = create(backend, { keyPrefix: 'batch:', ...extra })
  return { backend, cache }
}

describe('batched public reads', () => {
  it('uses one batch while preserving ordered duplicate results, hit shape, decoding, and per-key events', async () => {
    const fetchMany = vi.fn(async () => [result({ id: 1 }), null, result({ id: 3 }), result(false)])
    const backend = custom(fetchMany)
    const cache = create(backend)
    const events: string[] = []
    cache.onEvent((event) => events.push(`${event.type}:${event.key}`))
    const values = await cache.getMany(['a', 'missing', 'a', 'false'])
    expect(fetchMany).toHaveBeenCalledTimes(1)
    expect(backend.fetch).not.toHaveBeenCalled()
    expect([...values.keys()]).toEqual(['a', 'missing', 'false'])
    expect(values.get('a')).toEqual({ data: { id: 3 }, ttl: 10 })
    expect(values.get('a')?.layer).toBe('lru')
    expect(values.get('missing')).toBeNull()
    expect(values.get('false')?.data).toBe(false)
    expect(events.sort()).toEqual(['hit:a', 'hit:a', 'hit:false', 'miss:missing'])
    expect(cache.getStats().hitsByLayer.lru).toBe(3)
  })

  it('snapshots caller keys and drains a pending batch on close', async () => {
    const pending = gate<(AdaptiveCacheFetchResult | null)[]>()
    const fetchMany = vi.fn(() => pending.promise)
    const backend = custom(fetchMany)
    const cache = create(backend)
    const keys = ['a', 'b']
    const reading = cache.getMany(keys)
    keys.splice(0, 2, 'changed')
    const closing = cache.close()
    await Promise.resolve()
    expect(fetchMany.mock.calls[0][0].map((value) => value.key)).toEqual(['a', 'b'])
    expect(backend.quit).not.toHaveBeenCalled()
    pending.resolve([result('a'), result('b')])
    expect([...(await reading).keys()]).toEqual(['a', 'b'])
    await closing
    expect(backend.quit).toHaveBeenCalledOnce()
    await expect(cache.getMany([])).rejects.toThrow('closed')
  })

  it.each(['throw', 'short'] as const)('emits per-key errors when a batch is %s', async (mode) => {
    const fetchMany = vi.fn(() => {
      if (mode === 'throw') throw new Error('batch failure')
      return Promise.resolve([result('a')])
    })
    const backend = custom(fetchMany)
    const cache = create(backend)
    const events: string[] = []
    cache.onEvent((event) => events.push(`${event.type}:${event.key}`))
    await expect(cache.getMany(['a', 'b', 'a'])).rejects.toThrow(mode === 'throw' ? 'batch failure' : 'length')
    expect(events.sort()).toEqual(['error:a', 'error:a', 'error:b'])
    expect(backend.fetch).not.toHaveBeenCalled()
  })

  it('keeps sibling decodes tracked after an early decode error', async () => {
    const pending = gate<unknown>()
    vi.spyOn(payload, 'decode').mockImplementation((value) =>
      value === 'slow' ? pending.promise : Promise.reject(new Error('decode failure')),
    )
    const backend = custom(async () => [
      { ...result('bad'), encodedData: 'bad' },
      { ...result('slow'), encodedData: 'slow' },
    ])
    const cache = create(backend)
    await expect(cache.getMany(['bad', 'slow'])).rejects.toThrow('decode failure')
    const closing = cache.close()
    await Promise.resolve()
    expect(backend.quit).not.toHaveBeenCalled()
    pending.resolve('decoded')
    await closing
    expect(backend.quit).toHaveBeenCalledOnce()
    expect(cache.getStats().counters.error).toBe(1)
    expect(cache.getStats().counters.hit).toBe(1)
  })

  it('keeps existing backends working and performs no work for an empty batch', async () => {
    const backend = custom()
    const cache = create(backend)
    expect(await cache.getMany([])).toEqual(new Map())
    expect(backend.fetch).not.toHaveBeenCalled()
    expect((await cache.getMany(['a', 'b'])).get('b')?.data).toBe('fallback')
    expect(backend.fetch).toHaveBeenCalledTimes(2)
    const capable = custom(vi.fn(async () => []))
    const second = create(capable)
    expect(await second.getMany([])).toEqual(new Map())
    expect(capable.fetchMany).not.toHaveBeenCalled()
  })
})

describe('clustered LRU batch validation', () => {
  it('batches payloads and distinct primary controls without single-key calls', async () => {
    const { backend, cache } = lru({ includeDebugHeaders: true, compression: { async: true, minBytes: 1 } })
    await cache.set('a', Buffer.from('payload'.repeat(100)), { tags: ['shared'] })
    await cache.set('b', 0, { tags: ['shared'] })
    const raw = await (backend as any).getCache()
    const many = vi.spyOn(raw, 'mGet')
    const single = vi.spyOn(raw, 'get')
    const hits = await cache.getMany(['a', 'b', 'a', 'missing'])
    expect(hits.get('a')?.data).toEqual(Buffer.from('payload'.repeat(100)))
    expect(hits.get('b')?.data).toBe(0)
    expect(hits.get('a')?.metadata?.dataTTL).toBe(5)
    expect(many).toHaveBeenCalledTimes(2)
    expect(single).not.toHaveBeenCalled()
    expect(many.mock.calls[1][1]).toEqual({ bypassL1: true })
    expect(new Set(many.mock.calls[1][0] as string[])).toEqual(
      new Set(['batch:__adaptive:namespace', 'adata:epoch', 'bdata:epoch', 'batch:__adaptive:tag-epoch:shared']),
    )
    expect((many.mock.calls[1][0] as string[]).length).toBe(4)
  })

  it('rejects stale payloads when controls change or disappear between batch phases', async () => {
    const { backend, cache } = lru()
    await cache.set('valid', 1)
    await cache.set('tagged', 2, { tags: ['red'] })
    await cache.set('cleared', 3)
    const raw = await (backend as any).getCache()
    const actual = raw.mGet.bind(raw)
    vi.spyOn(raw, 'mGet').mockImplementation(async (keys, opts) => {
      const values = await actual(keys, opts)
      if (!opts) {
        await raw.delete('batch:__adaptive:tag-epoch:red')
        await raw.set('cleareddata:epoch', 'changed', { size: 64 })
      }
      return values
    })
    const values = await cache.getMany(['valid', 'tagged', 'cleared'])
    expect(values.get('valid')?.data).toBe(1)
    expect(values.get('tagged')).toBeNull()
    expect(values.get('cleared')).toBeNull()
    expect(await raw.get('batch:__adaptive:tag-epoch:red', { bypassL1: true })).toBeUndefined()
  })

  it('rejects cached envelopes after namespace invalidation, including with warm local L1', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: `batch-${crypto.randomUUID()}`, localL1: { enabled: true, experimental: true } },
      new Logger('silent'),
    )
    const cache = create(backend, { keyPrefix: 'batch:', ttlPolicy: { type: 'aimd' } })
    await cache.set('a', 1)
    expect((await cache.getMany(['a'])).get('a')?.data).toBe(1)
    await cache.invalidateNamespace()
    expect((await cache.getMany(['a'])).get('a')).toBeNull()
  })

  it('rechecks retention after control reads and retains stale-window semantics', async () => {
    const { backend, cache } = lru()
    await cache.set('a', 1, { maxTTL: 1, staleTTL: 3 })
    const raw = await (backend as any).getCache()
    const actual = raw.mGet.bind(raw)
    const envelope = await raw.get('adata')
    const now = vi.spyOn(Date, 'now').mockReturnValue(envelope.freshUntil + 1000)
    expect((await backend.fetchMany([input('a')]))[0]).toBeNull()
    expect((await backend.fetchMany([input('a', true)]))[0]).toMatchObject({ stale: true, staleAge: 1, ttl: 0 })
    now.mockReturnValue(envelope.freshUntil - 1)
    vi.spyOn(raw, 'mGet').mockImplementation(async (keys, opts) => {
      const values = await actual(keys, opts)
      if (opts) now.mockReturnValue(envelope.expiresAt + 1)
      return values
    })
    expect((await backend.fetchMany([input('a', true)]))[0]).toBeNull()
  })

  it('rechecks retention for scalar stale reads after primary epoch validation', async () => {
    const { backend, cache } = lru()
    await cache.set('a', 1, { maxTTL: 1, staleTTL: 3 })
    const raw = await (backend as any).getCache()
    const envelope = await raw.get('adata')
    const actual = raw.get.bind(raw)
    const now = vi.spyOn(Date, 'now').mockReturnValue(envelope.freshUntil - 1)
    vi.spyOn(raw, 'get').mockImplementation(async (key, opts) => {
      const value = await actual(key, opts)
      if (opts) now.mockReturnValue(envelope.expiresAt + 1)
      return value
    })
    expect(await cache.get('a', { allowStale: true })).toBeNull()
    expect(cache.getStats().counters.miss).toBe(1)
  })

  it('supports empty/all-miss and legacy envelopes without unnecessary control requests', async () => {
    const { backend } = lru()
    const raw = await (backend as any).getCache()
    const many = vi.spyOn(raw, 'mGet')
    expect(await backend.fetchMany([])).toEqual([])
    expect(many).not.toHaveBeenCalled()
    expect(await backend.fetchMany([input('missing')])).toEqual([null])
    expect(many).toHaveBeenCalledOnce()
    await raw.set(
      'legacydata',
      { encodedData: '1', expiresAt: Date.now() + 10000, dataTTL: 10, lastChanged: 1, changeCount: 1, hash: 'h' },
      { size: 100 },
    )
    expect((await backend.fetchMany([input('legacy')]))[0]).toMatchObject({ encodedData: '1', stale: false })
    expect(many).toHaveBeenCalledTimes(2)
  })
})
