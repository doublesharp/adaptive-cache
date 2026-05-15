import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { AdaptiveCache } from '../src'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { FakeRedis } from './helpers/FakeRedis'

const namespace = (name: string) => `adaptive-cache-backend-${name}-${Date.now()}-${Math.random()}`

const logger = () => new Logger('silent')

describe('RedisAdaptiveCacheBackend', () => {
  it('should fetch, update, tag, clear, invalidate, and coordinate locks through Redis commands', async () => {
    const redis = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    const update = await backend.update({
      key: 'redis-key',
      dataKey: 'redis-keydata',
      metaKey: 'redis-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-a',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: ['tag-a'],
    })

    expect(update[0]).toBe('CACHED')
    expect(update[4]).toBe('hash-a')
    expect(await redis.smembers('adaptive:tag:tag-a')).toEqual(['redis-key'])

    const hit = await backend.fetch({
      key: 'redis-key',
      dataKey: 'redis-keydata',
      metaKey: 'redis-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(hit?.encodedData).toBe(JSON.stringify({ ok: true }))
    expect(hit?.metadata?.hash).toBe('hash-a')

    const miss = await backend.fetch({
      key: 'missing',
      dataKey: 'missingdata',
      metaKey: 'missingmeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(miss).toBeNull()

    const refresh = await backend.shouldRefresh('last-update', 10, 100, false, 1, 'lock-a')
    expect(refresh[0]).toBe('UPDATE')
    const updating = await backend.shouldRefresh('last-update', 10, 100, false, 1, 'lock-b')
    expect(updating[0]).toBe('UPDATING')
    expect(await backend.releaseLock('last-update', 100, 'lock-a')).toEqual(['UPDATED'])
    expect((await backend.shouldRefresh('last-update', 10, 101, false, 1, 'lock-c'))[0]).toBe('EXISTS')
    expect((await backend.shouldRefresh('last-update', 10, 101, true, 1, 'lock-d'))[0]).toBe('UPDATE')

    const invalidated = await backend.invalidateTags(['tag-a'], 'adaptive:')
    expect(invalidated).toEqual(['redis-key'])
    expect(await redis.hgetall('redis-keymeta')).toEqual({})
    expect(await redis.exists('adaptive:tag:tag-a')).toBe(0)
    expect(await backend.invalidateTags(['missing-tag'], 'adaptive:')).toEqual([])
    expect(
      await backend.fetch({
        key: 'redis-key',
        dataKey: 'redis-keydata',
        metaKey: 'redis-keymeta',
        redisPrefix: 'adaptive:',
        includeDebugHeaders: true,
      }),
    ).toBeNull()

    await redis.adaptiveCacheUpdate(
      'redis-keydata',
      'redis-keymeta',
      'hash-b',
      JSON.stringify({ ok: false }),
      '5',
      '60',
      '2',
      '100',
    )
    await backend.clear('redis-key', 'redis-keydata', 'redis-keymeta')
    expect(await redis.get('redis-keydata')).toBeNull()
    expect(await redis.hgetall('redis-keymeta')).toEqual({})
    await backend.quit()
    expect(redis.quitCalls).toBe(0)
  })

  it('should define Lua commands when they are missing on the client', () => {
    const client = {
      defineCommand: vi.fn(),
    }

    new RedisAdaptiveCacheBackend(client as any, logger())

    expect(client.defineCommand).toHaveBeenCalledTimes(4)
  })

  it('should fall back to the first Lua path candidate when no Lua path exists', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('-- mocked lua')
    const client = {
      defineCommand: vi.fn(),
    }

    new RedisAdaptiveCacheBackend(client as any, logger())

    expect(client.defineCommand).toHaveBeenCalledTimes(4)
    expect(readSpy).toHaveBeenCalled()

    readSpy.mockRestore()
    existsSpy.mockRestore()
  })

  it('should fall back to hgetall metadata when fetch tuple has only old fields', async () => {
    const redis = new FakeRedis()
    await redis.set('old-keydata', 'raw', 'EX', 30)
    redis.stores.hashes.set('old-keymeta', {
      hash: 'old-hash',
      dataTTL: '30',
      lastChanged: '123',
      changeCount: '2',
    })
    redis.adaptiveCacheFetch = vi.fn(async () => ['raw', 30]) as any
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    const hit = await backend.fetch({
      key: 'old-key',
      dataKey: 'old-keydata',
      metaKey: 'old-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })

    expect(hit?.metadata).toEqual({
      hash: 'old-hash',
      dataTTL: '30',
      lastChanged: '123',
      changeCount: '2',
    })
  })

  it('should leave metadata empty when old fetch tuples have no metadata hash', async () => {
    const redis = new FakeRedis()
    await redis.set('old-empty-keydata', 'raw', 'EX', 30)
    redis.adaptiveCacheFetch = vi.fn(async () => ['raw', 30, null, null, null, null]) as any
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    const hit = await backend.fetch({
      key: 'old-empty-key',
      dataKey: 'old-empty-keydata',
      metaKey: 'old-empty-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })

    expect(hit?.metadata).toBeUndefined()
  })

  it('should quit owned Redis clients', async () => {
    const redis = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger(), true)

    await backend.quit()

    expect(redis.quitCalls).toBe(1)
  })
})

describe('ClusteredLruAdaptiveCacheBackend edge cases', () => {
  it('should use safe defaults and pass through v2.1 local L1 options', async () => {
    const originalLoader = ClusteredLruAdaptiveCacheBackend.loadModule
    const constructorOptions: any[] = []
    const instances: any[] = []

    class FakeClusteredCache {
      static bootstrap = vi.fn()

      constructor(options: any) {
        constructorOptions.push(options)
        instances.push(this)
      }

      async healthCheck() {
        return undefined
      }

      async get() {
        return undefined
      }

      async set() {
        return true
      }

      async delete() {
        return true
      }

      async destroy() {
        return true
      }
    }

    ClusteredLruAdaptiveCacheBackend.loadModule = () => ({ LRUCacheForClustersAsPromised: FakeClusteredCache })

    const defaultBackend = new ClusteredLruAdaptiveCacheBackend(undefined, logger())
    await defaultBackend.fetch({
      key: 'default-key',
      dataKey: 'default-keydata',
      metaKey: 'default-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })

    const localL1 = { enabled: true, maxSize: 1024, invalidation: 'broadcast' as const }
    const localBackend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: 'v21-local', maxSizeBytes: 2048, maxEntrySizeBytes: 512, failsafe: 'resolve', localL1 },
      logger(),
    )
    await (localBackend as any).getCache()

    expect(constructorOptions[0]).toMatchObject({
      namespace: 'adaptive-cache',
      maxSize: 64 * 1024 * 1024,
      maxEntrySize: Math.floor(64 * 1024 * 1024 * 0.1),
      failsafe: 'reject',
    })
    expect(constructorOptions[0]).not.toHaveProperty('localL1')
    expect(constructorOptions[1]).toMatchObject({
      namespace: 'v21-local',
      maxSize: 2048,
      maxEntrySize: 512,
      failsafe: 'resolve',
      localL1,
    })
    expect(FakeClusteredCache.bootstrap).toHaveBeenCalled()

    await defaultBackend.quit()
    expect(instances[0].destroy).toBeDefined()

    ClusteredLruAdaptiveCacheBackend.loadModule = originalLoader
  })

  it('should coordinate refresh locks in standalone mode', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('locks'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )

    const update = await backend.shouldRefresh('lru-last-update', 10, 100, false, 1, 'lock-a')
    expect(update[0]).toBe('UPDATE')

    const updating = await backend.shouldRefresh('lru-last-update', 10, 100, false, 1, 'lock-b')
    expect(updating).toEqual(['UPDATING', 'lock-a'])

    expect(await backend.releaseLock('lru-last-update', 100, 'lock-a')).toEqual(['UPDATED'])
    expect((await backend.shouldRefresh('lru-last-update', 10, 101, false, 1, 'lock-c'))[0]).toBe('EXISTS')
    expect((await backend.shouldRefresh('lru-last-update', 10, 101, true, 1, 'lock-d'))[0]).toBe('UPDATE')
    expect(await backend.releaseLock('lru-last-update', 101, 'wrong-lock')).toEqual(['LOCK_MISMATCH', 'lock-d'])
  })

  it('should cap TTL at maxTTL', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('ttl-cap'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const input = {
      key: 'cap-key',
      dataKey: 'cap-keydata',
      metaKey: 'cap-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-cap',
      initialTTL: 2,
      maxTTL: 2,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    }

    await backend.update(input)
    const second = await backend.update(input)

    expect(second[1]).toBe(2)
  })

  it('should hydrate without metadata, fall back to update hashes, and handle missing tag sets', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('hydrate-fallbacks'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const fetchInput = {
      key: 'hydrate-key',
      dataKey: 'hydrate-keydata',
      metaKey: 'hydrate-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    }
    const updateInput = {
      ...fetchInput,
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'fallback-hash',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    }

    await backend.hydrateFromFetch(fetchInput, {
      encodedData: JSON.stringify({ ok: true }),
      ttl: 0,
    })
    expect((await backend.fetch(fetchInput))?.metadata?.hash).toBe('')

    await backend.hydrateFromUpdate(updateInput, ['CACHED', false, false, false, false] as any)
    expect((await backend.fetch(fetchInput))?.metadata?.hash).toBe('fallback-hash')
    expect(await backend.invalidateTags(['missing-tag'], 'adaptive:')).toEqual([])
  })

  it('should no-op quit before clustered LRU initialization', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('quit-before-init') }, logger())

    await expect(backend.quit()).resolves.toBeUndefined()
  })

  it('should throw a useful error when the optional LRU package cannot be loaded or has no export', async () => {
    const originalLoader = ClusteredLruAdaptiveCacheBackend.loadModule
    ClusteredLruAdaptiveCacheBackend.loadModule = () => {
      throw new Error('missing package')
    }
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('missing') }, logger())

    await expect((backend as any).getCache()).rejects.toThrow('@0xdoublesharp/lru-cache-clustered')

    ClusteredLruAdaptiveCacheBackend.loadModule = () => ({})
    const backendWithoutExport = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('bad-export') }, logger())
    await expect((backendWithoutExport as any).getCache()).rejects.toThrow('Could not find LRUCacheClustered')

    ClusteredLruAdaptiveCacheBackend.loadModule = originalLoader
  })
})

describe('L1RedisAdaptiveCacheBackend', () => {
  it('should read through Redis, hydrate L1, write conservatively, reconcile asynchronously, and invalidate', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())

    await redisBackend.update({
      key: 'l1-key',
      dataKey: 'l1-keydata',
      metaKey: 'l1-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ from: 'redis' }),
      responseHash: 'hash-redis',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    })

    const first = await backend.fetch({
      key: 'l1-key',
      dataKey: 'l1-keydata',
      metaKey: 'l1-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(first?.metadata?.hash).toBe('hash-redis')

    redis.failFetch = true
    const second = await backend.fetch({
      key: 'l1-key',
      dataKey: 'l1-keydata',
      metaKey: 'l1-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(second?.encodedData).toBe(JSON.stringify({ from: 'redis' }))
    redis.failFetch = false

    const updateInput = {
      key: 'l1-key',
      dataKey: 'l1-keydata',
      metaKey: 'l1-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ from: 'l1' }),
      responseHash: 'hash-l1',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: ['l1-tag'],
    }
    expect((await backend.update(updateInput))[1]).toBe(3)

    await vi.waitFor(async () => {
      expect((await redis.hgetall('l1-keymeta')).hash).toBe('hash-l1')
    })

    expect(await backend.invalidateTags(['l1-tag'], 'adaptive:')).toEqual(['l1-key'])
    expect(redis.published.length).toBeGreaterThan(0)

    await backend.clear('l1-key', 'l1-keydata', 'l1-keymeta')
    await backend.quit()
  })

  it('should keep conservative L1 data when Redis async update fails', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-fail'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    redis.failUpdate = true

    await backend.update({
      key: 'fail-key',
      dataKey: 'fail-keydata',
      metaKey: 'fail-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-fail',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    })

    const hit = await backend.fetch({
      key: 'fail-key',
      dataKey: 'fail-keydata',
      metaKey: 'fail-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(hit?.metadata?.hash).toBe('hash-fail')

    await backend.quit()
  })

  it('should support awaiting Redis writes and flushing async writes', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-await'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const awaitBackend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger(), 'await-redis')
    const input = {
      key: 'await-key',
      dataKey: 'await-keydata',
      metaKey: 'await-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'await-hash',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    }

    expect((await awaitBackend.update(input))[4]).toBe('await-hash')
    expect((await redis.hgetall('await-keymeta')).hash).toBe('await-hash')
    await awaitBackend.flush()
    await awaitBackend.quit()
  })

  it('should reject awaited Redis writes when Redis update fails', async () => {
    const redis = new FakeRedis()
    redis.failUpdate = true
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-await-fail'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger(), 'await-redis')

    await expect(
      backend.update({
        key: 'await-fail-key',
        dataKey: 'await-fail-keydata',
        metaKey: 'await-fail-keymeta',
        redisPrefix: 'adaptive:',
        encodedData: JSON.stringify({ ok: true }),
        responseHash: 'await-fail-hash',
        initialTTL: 3,
        maxTTL: 60,
        ttlScaling: 2,
        metaTTL: 100,
        tags: [],
      }),
    ).rejects.toThrow('update failed')

    await backend.quit()
  })

  it('should tolerate subscriber and publish failures', async () => {
    const redis = new FakeRedis()
    redis.failSubscribe = true
    redis.failPublish = true
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-pub-fail'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())

    await (backend as any).publishInvalidation([])
    await backend.clear('key', 'keydata', 'keymeta')
    await vi.waitFor(() => expect((backend as any).subscriber.subscribedChannels).toEqual([]))
    await backend.quit()

    redis.failDuplicate = true
    const backendWithDuplicateFailure = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    await backendWithDuplicateFailure.quit()
  })

  it('should skip publish when Redis reports unchanged data and when tags resolve to no keys', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-unchanged'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const input = {
      key: 'stable-key',
      dataKey: 'stable-keydata',
      metaKey: 'stable-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ stable: true }),
      responseHash: 'stable-hash',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    }

    await redisBackend.update(input)
    redis.published = []
    await backend.update(input)
    await vi.waitFor(async () => {
      expect((await redis.hgetall('stable-keymeta')).dataTTL).toBe('6')
    })

    expect(redis.published).toEqual([])
    expect(await backend.invalidateTags(['missing-tag'], 'adaptive:')).toEqual([])

    await backend.quit()
  })

  it('should tolerate Redis hit hydration failures and delegate locks to Redis', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-hydrate-fail'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())

    await redisBackend.update({
      key: 'hydrate-fail-key',
      dataKey: 'hydrate-fail-keydata',
      metaKey: 'hydrate-fail-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-hydrate-fail',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    })
    ;(backend as any).lru.hydrateFromFetch = vi.fn(async () => {
      throw new Error('hydrate failed')
    })

    const hit = await backend.fetch({
      key: 'hydrate-fail-key',
      dataKey: 'hydrate-fail-keydata',
      metaKey: 'hydrate-fail-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(hit?.metadata?.hash).toBe('hash-hydrate-fail')

    const refresh = await backend.shouldRefresh('l1-lock-key', 10, 100, false, 1, 'lock-a')
    expect(refresh[0]).toBe('UPDATE')
    expect(await backend.releaseLock('l1-lock-key', 100, refresh[1] as string)).toEqual(['UPDATED'])

    await backend.quit()
  })

  it('should apply external invalidation messages and ignore invalid/self messages', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-message'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())

    await lru.storeConservative({
      key: 'message-key',
      dataKey: 'message-keydata',
      metaKey: 'message-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-message',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    })

    expect(
      await backend.fetch({
        key: 'message-key',
        dataKey: 'message-keydata',
        metaKey: 'message-keymeta',
        redisPrefix: 'adaptive:',
        includeDebugHeaders: true,
      }),
    ).not.toBeNull()
    ;(backend as any).handleInvalidation('not-json')
    ;(backend as any).handleInvalidation(JSON.stringify({ source: (backend as any).sourceId, keys: ['message-key'] }))
    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['message-key'] }))

    await vi.waitFor(async () => {
      expect(
        await backend.fetch({
          key: 'message-key',
          dataKey: 'message-keydata',
          metaKey: 'message-keymeta',
          redisPrefix: 'adaptive:',
          includeDebugHeaders: true,
        }),
      ).toBeNull()
    })

    await backend.quit()
  })

  it('should handle subscriber events and failed invalidation handlers', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-subscriber-events'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const subscriber = (backend as any).subscriber as FakeRedis

    subscriber.emit('error', new Error('subscriber error'))
    subscriber.emit('message', 'adaptive:l1:invalidate', JSON.stringify({ source: 'external', keys: [] }))
    ;(backend as any).lru.deleteKeys = vi.fn(async () => {
      throw new Error('delete failed')
    })
    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['key'] }))

    await vi.waitFor(() => {
      expect((backend as any).lru.deleteKeys).toHaveBeenCalledWith(['key'])
    })

    await backend.quit()
  })
})

describe('AdaptiveCache backend integration', () => {
  it('should support custom backends and reject Redis client access for non-Redis backends', async () => {
    const backend = {
      name: 'custom' as const,
      fetch: vi.fn(async () => null),
      update: vi.fn(async () => ['CACHED', 1] as any),
      clear: vi.fn(async () => undefined),
      invalidateTags: vi.fn(async () => []),
      shouldRefresh: vi.fn(async () => ['UPDATE', 'lock'] as any),
      releaseLock: vi.fn(async () => ['UPDATED'] as any),
      flush: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
    }
    const cache = new AdaptiveCache({ backend })

    await cache.set('custom-key', { ok: true })
    expect(await cache.get('custom-key')).toBeNull()
    await cache.invalidateTags(['tag'])
    await cache.clear('custom-key')
    expect((await cache.shouldRefresh('refresh', 1))[0]).toBe('UPDATE')
    expect((await cache.shouldRefresh('refresh-explicit', 1, false, 5))[0]).toBe('UPDATE')
    expect(await cache.releaseLock('refresh', 'lock')).toEqual(['UPDATED'])
    await cache.flush()
    await cache.quit()

    expect(() => cache.client).toThrow('not using a Redis-backed backend')
    expect(backend.update).toHaveBeenCalled()
    expect(backend.flush).toHaveBeenCalled()

    const ttlBackend = {
      ...backend,
      update: vi.fn(async () => ['CACHED', 1] as any),
    }
    const ttlCache = new AdaptiveCache({ backend: ttlBackend, maxTTL: (data) => (data.ok ? 42 : undefined) })
    await ttlCache.set('custom-ttl-key', { ok: true })
    await ttlCache.set('custom-default-ttl-key', { ok: false })
    expect(ttlBackend.update).toHaveBeenCalledWith(expect.objectContaining({ maxTTL: 42 }))
    expect(ttlBackend.update).toHaveBeenCalledWith(expect.objectContaining({ maxTTL: 900 }))
  })

  it('should surface backend fetch decode errors and update errors', async () => {
    const badFetchBackend = {
      name: 'custom' as const,
      fetch: vi.fn(async () => ({ encodedData: 'not-json', ttl: 1 })),
      update: vi.fn(async () => ['CACHED', 1] as any),
      clear: vi.fn(async () => undefined),
      invalidateTags: vi.fn(async () => []),
      shouldRefresh: vi.fn(async () => ['UPDATE', 'lock'] as any),
      releaseLock: vi.fn(async () => ['UPDATED'] as any),
    }
    const badFetchCache = new AdaptiveCache({ backend: badFetchBackend, compress: false })

    await expect(badFetchCache.get('bad-json')).resolves.toEqual({ ttl: 1, data: 'not-json' })

    const badUpdateBackend = {
      ...badFetchBackend,
      fetch: vi.fn(async () => null),
      update: vi.fn(async () => {
        throw new Error('update failed')
      }),
    }
    const badUpdateCache = new AdaptiveCache({ backend: badUpdateBackend })

    await expect(badUpdateCache.set('bad-update', { ok: true })).rejects.toThrow('update failed')
  })

  it('should use fake Redis through AdaptiveCache l1-redis mode', async () => {
    const redis = new FakeRedis()
    const cache = new AdaptiveCache(
      {
        backend: 'l1-redis',
        initialTTL: 2,
        includeDebugHeaders: true,
        lru: { namespace: namespace('adaptive-l1'), maxSizeBytes: 1024 * 1024 },
      },
      redis as any,
    )

    await cache.set('adaptive-l1-key', { ok: true })
    const immediate = await cache.get('adaptive-l1-key')

    expect(immediate?.data).toEqual({ ok: true })
    expect(Number(immediate?.metadata.dataTTL)).toBe(2)
    await cache.quit()
  })
})
