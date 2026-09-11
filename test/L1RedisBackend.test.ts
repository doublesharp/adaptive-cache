import { describe, expect, it, vi } from 'vitest'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { FakeRedis } from './helpers/FakeRedis'

const namespace = (name: string) => `adaptive-cache-backend-${name}-${Date.now()}-${Math.random()}`

const logger = () => new Logger('silent')

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
      writeToken: await redisBackend.captureWriteToken('adaptive:'),
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
