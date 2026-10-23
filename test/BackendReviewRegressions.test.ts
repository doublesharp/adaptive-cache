import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import type { AdaptiveCacheBackendUpdateInput, AdaptiveCacheTtlPolicy } from '../src/types'
import { FakeRedis } from './helpers/FakeRedis'

const logger = new Logger('silent')
const input = (key = 'review:item:'): AdaptiveCacheBackendUpdateInput => ({
  key,
  dataKey: key + 'data',
  metaKey: key + 'meta',
  redisPrefix: 'review:',
  encodedData: 'value',
  responseHash: 'hash',
  initialTTL: 5,
  maxTTL: 100,
  ttlScaling: 2,
  metaTTL: 60,
  tags: [],
})
const fetchInput = (value = input()) => ({ ...value, includeDebugHeaders: true })

describe('clustered LRU review regressions', () => {
  it('clears retained metadata when a tagged payload was evicted before invalidation', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: randomUUID() }, logger)
    try {
      const value = { ...input('review:evicted:'), tags: ['red'] }
      const survivor = { ...input('review:retained:'), tags: ['blue'] }
      await backend.update(value)
      await backend.update(value)
      await backend.update(survivor)
      const cache = await (backend as any).getCache()
      // The payload can leave the LRU before its separately retained metadata
      // and tag membership do, for example under capacity pressure.
      await cache.delete(value.dataKey)
      expect(await cache.get(value.metaKey)).toBeDefined()
      expect(await backend.invalidateTags(['red'], value.redisPrefix)).toEqual([value.key])
      expect(await cache.get(value.metaKey)).toBeUndefined()
      expect(await cache.get('review:tag:red')).toBeUndefined()
      expect((await backend.fetch(fetchInput(survivor)))?.encodedData).toBe('value')
      const recreated = await backend.update(value)
      expect(recreated[1]).toBe(5)
      expect(recreated[3]).toBe(1)
    } finally {
      await backend.quit()
    }
  })

  it('bounds tag-index writes for 1000 live entries and preserves unrelated and retagged members', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: randomUUID() }, logger)
    try {
      const cache = await (backend as any).getCache()
      const keys = Array.from({ length: 1000 }, (_, index) => `review:member:${index}:`)
      for (const key of keys) {
        await backend.update({ ...input(key), initialTTL: 60, tags: ['red', 'green', 'shared'] })
      }
      const survivor = { ...input('review:survivor:'), tags: ['shared'] }
      const retagged = { ...input('review:retagged:'), tags: ['blue'] }
      await backend.update(survivor)
      await backend.update({ ...retagged, tags: ['red'] })
      await backend.update(retagged)
      const members = await cache.get('review:tag:red', { bypassL1: true })
      // Model obsolete membership from another worker's earlier write.
      await cache.set(
        'review:tag:red',
        { ...members, [retagged.key]: Date.now() + 60000 },
        { ttl: 60000, size: 100000 },
      )
      const survivorIndex = await cache.get('review:tag:shared', { bypassL1: true })
      const set = cache.set.bind(cache)
      const indexWrites: Array<{ key: string; members: number }> = []
      const spy = vi.spyOn(cache, 'set').mockImplementation(async (key: string, value: any, options: any) => {
        if (key.startsWith('review:tag:')) indexWrites.push({ key, members: Object.keys(value).length })
        return set(key, value, options)
      })
      try {
        expect(new Set(await backend.invalidateTags(['red', 'green', 'red'], 'review:'))).toEqual(new Set(keys))
        expect(await cache.get('review:tag:red', { bypassL1: true })).toBeUndefined()
        expect(await cache.get('review:tag:green', { bypassL1: true })).toBeUndefined()
        expect(await cache.get('review:tag:shared', { bypassL1: true })).toEqual({
          [survivor.key]: survivorIndex[survivor.key],
        })
        expect(Object.keys(await cache.get('review:tag:blue', { bypassL1: true }))).toEqual([retagged.key])
        expect((await backend.fetch(fetchInput(survivor)))?.encodedData).toBe('value')
        expect((await backend.fetch(fetchInput(retagged)))?.encodedData).toBe('value')
        for (const key of keys) {
          expect(await cache.get(key + 'data', { bypassL1: true })).toBeUndefined()
          expect(await cache.get(key + 'meta', { bypassL1: true })).toBeUndefined()
        }
        expect(indexWrites.filter(({ key }) => key === 'review:tag:red')).toHaveLength(0)
        expect(indexWrites.filter(({ key }) => key === 'review:tag:green')).toHaveLength(0)
        expect(indexWrites.filter(({ key }) => key === 'review:tag:shared')).toHaveLength(1)
        expect(indexWrites.reduce((total, write) => total + write.members, 0)).toBe(1)
      } finally {
        spy.mockRestore()
      }
    } finally {
      await backend.quit()
    }
  })

  it('keeps concurrent writes in the namespace mutation queue during batched tag invalidation', async () => {
    const namespace = randomUUID()
    const invalidator = new ClusteredLruAdaptiveCacheBackend({ namespace }, logger)
    const writer = new ClusteredLruAdaptiveCacheBackend({ namespace }, logger)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const paused = new Promise<void>((resolve) => {
      entered = resolve
    })
    const value = { ...input(), tags: ['red', 'shared'] }
    const cache = await (invalidator as any).getCache()
    await invalidator.update(value)
    const remove = cache.delete.bind(cache)
    const spy = vi.spyOn(cache, 'delete').mockImplementation(async (key: string) => {
      if (key === value.dataKey) {
        entered()
        await gate
      }
      return remove(key)
    })
    let invalidating: Promise<string[]> | undefined
    let updating: ReturnType<typeof writer.update> | undefined
    try {
      invalidating = invalidator.invalidateTags(['red'], value.redisPrefix)
      await paused
      let finished = false
      updating = writer.update({ ...value, encodedData: 'new', tags: ['shared'] }).then((result) => {
        finished = true
        return result
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(finished).toBe(false)
      release()
      expect(await invalidating).toEqual([value.key])
      await updating
      expect((await writer.fetch(fetchInput(value)))?.encodedData).toBe('new')
      expect(Object.keys(await cache.get('review:tag:shared', { bypassL1: true }))).toEqual([value.key])
    } finally {
      release()
      await Promise.allSettled([invalidating, updating])
      spy.mockRestore()
      await writer.quit(true)
      await invalidator.quit()
    }
  })
})

describe('real Redis review contracts', () => {
  let container: StartedTestContainer
  let client: Redis
  let redis: RedisAdaptiveCacheBackend
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379), maxRetriesPerRequest: null })
    redis = new RedisAdaptiveCacheBackend(client, logger)
  })
  beforeEach(async () => {
    await client.flushall()
  })
  afterAll(async () => {
    await client?.quit()
    await container?.stop()
  })

  it('reads healthy Redis while its invalidation subscription remains stalled', async () => {
    await redis.update(input())
    const subscriber = client.duplicate({ lazyConnect: true })
    let finishSubscription!: (count: number) => void
    const subscription = vi.spyOn(subscriber, 'subscribe').mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finishSubscription = resolve
        }),
    )
    const duplicate = vi.spyOn(client, 'duplicate').mockReturnValue(subscriber)
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: randomUUID() }, logger)
    const backend = new L1RedisAdaptiveCacheBackend(redis, lru, 'review:', logger)
    let pending: ReturnType<typeof backend.fetch> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      expect(subscription).toHaveBeenCalledWith('review:l1:invalidate')
      expect((await redis.fetch(fetchInput()))?.encodedData).toBe('value')
      pending = backend.fetch(fetchInput())
      const result = await Promise.race([
        pending,
        new Promise<'subscriber blocked read'>((resolve) => {
          timer = setTimeout(() => resolve('subscriber blocked read'), 500)
        }),
      ])
      expect(result).toMatchObject({ encodedData: 'value', layer: 'redis' })
      expect(subscriber.status).not.toBe('ready')
      expect((await backend.fetch(fetchInput()))?.layer).toBe('l1')
      // Revisions must still reject an old L1 value without any pub/sub connection.
      await redis.update({ ...input(), encodedData: 'new', responseHash: 'new' })
      expect((await backend.fetch(fetchInput()))?.encodedData).toBe('new')
    } finally {
      clearTimeout(timer)
      finishSubscription(1)
      await pending?.catch(() => undefined)
      await backend.quit(false, true)
      subscription.mockRestore()
      duplicate.mockRestore()
    }
  })

  it.each<AdaptiveCacheTtlPolicy>([{ type: 'adaptive' }, { type: 'aimd' }, { type: 'ewma' }])(
    'matches FakeRedis history reset after natural metaTTL expiry for $type',
    async (ttlPolicy) => {
      const fakeClient = new FakeRedis()
      const fake = new RedisAdaptiveCacheBackend(fakeClient as any, logger)
      const value = { ...input(), ttlPolicy, metaTTL: 1 }
      const unread = { ...input('review:unread:'), ttlPolicy, metaTTL: 1 }
      for (const backend of [redis, fake]) {
        expect((await backend.update(value))[1]).toBe(5)
        await backend.update(value)
        await backend.update(unread)
        await backend.update(unread)
      }
      await new Promise((resolve) => setTimeout(resolve, 1100))
      for (const connection of [client, fakeClient]) expect(await connection.hgetall(value.metaKey)).toEqual({})
      for (const backend of [redis, fake]) {
        expect((await backend.fetch(fetchInput(value)))?.encodedData).toBe('value')
        for (const entry of [value, unread]) {
          const result = await backend.update(entry)
          expect(result[1]).toBe(5)
          expect(result[3]).toBe(1)
        }
      }
    },
  )

  it.each(['pexpire', 'pipeline expire'] as const)('matches FakeRedis %s for every stored type', async (mode) => {
    const fake = new FakeRedis()
    const keys = ['expiry:string', 'expiry:hash', 'expiry:set', 'expiry:sorted-set']
    await client.set(keys[0], 'value')
    await fake.set(keys[0], 'value')
    await client.hset(keys[1], 'field', 'value')
    fake.stores.hashes.set(keys[1], { field: 'value' })
    await client.sadd(keys[2], 'member')
    fake.stores.sets.set(keys[2], new Set(['member']))
    await client.zadd(keys[3], 1, 'member')
    fake.stores.sortedSets.set(keys[3], new Map([['member', 1]]))
    for (const connection of [client, fake]) {
      expect(await connection.exists(keys[1])).toBe(1)
      for (const key of keys) {
        if (mode === 'pexpire') expect(await connection.pexpire(key, 30)).toBe(1)
        else {
          const pipeline = connection.pipeline()
          pipeline.expire(key, 1)
          await pipeline.exec()
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, mode === 'pexpire' ? 60 : 1100))
    for (const connection of [client, fake.duplicate()]) {
      expect(await connection.get(keys[0])).toBeNull()
      expect(await connection.hgetall(keys[1])).toEqual({})
      expect(await connection.smembers(keys[2])).toEqual([])
      expect(await connection.zrange(keys[3], 0, -1)).toEqual([])
      for (const key of keys) expect(await connection.exists(key)).toBe(0)
      expect(await connection.pexpire('expiry:missing', 30)).toBe(0)
    }
  })

  it('expires FakeRedis state hashes and tag indexes at their natural retention deadline', async () => {
    const fakeClient = new FakeRedis()
    const fake = new RedisAdaptiveCacheBackend(fakeClient as any, logger)
    const value = { ...input(), initialTTL: 0.02, maxTTL: 0.02, metaTTL: 1, tags: ['red'] }
    for (const backend of [redis, fake]) await backend.update(value)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    for (const connection of [client, fakeClient]) {
      for (const key of [
        value.dataKey,
        value.metaKey,
        value.dataKey + ':state',
        value.dataKey + ':revision',
        'review:__adaptive:tag-index:red',
        'review:__adaptive:tag-epoch:red',
      ]) {
        expect(await connection.exists(key)).toBe(0)
      }
    }
  })
})
