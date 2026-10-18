import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'

const logger = new Logger('silent')
const input = (key = 'r:item:') => ({
  key,
  dataKey: key + 'data',
  metaKey: key + 'meta',
  redisPrefix: 'r:',
  encodedData: 'old',
  responseHash: 'same',
  initialTTL: 10,
  maxTTL: 10,
  ttlScaling: 2,
  metaTTL: 60,
  tags: ['red'],
})
const fetchInput = () => ({ ...input(), includeDebugHeaders: true })

describe('Redis durable revisions and bounded tag indexes', () => {
  let container: StartedTestContainer
  let client: Redis
  let redis: RedisAdaptiveCacheBackend
  const backends: L1RedisAdaptiveCacheBackend[] = []
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
    redis = new RedisAdaptiveCacheBackend(client, logger)
  })
  beforeEach(async () => {
    await client.flushall()
  })
  afterAll(async () => {
    for (const backend of backends) await backend.quit()
    await client?.quit()
    await container?.stop()
  })
  const l1 = () => {
    const backend = new L1RedisAdaptiveCacheBackend(
      redis,
      new ClusteredLruAdaptiveCacheBackend({ namespace: 'revision-' + Math.random() }, logger),
      'r:',
      logger,
      'await-redis',
    )
    backends.push(backend)
    return backend
  }

  it.each(['l1', 'redis', 'ignored-field'])('observes %s payload writes when publication is dropped', async (kind) => {
    const reader = l1()
    const writer = l1()
    const publish = vi.spyOn(client, 'publish').mockRejectedValue(new Error('lost publication'))
    try {
      await writer.update(input())
      expect((await reader.fetch(fetchInput()))?.encodedData).toBe('old')
      expect((await reader.fetch(fetchInput()))?.layer).toBe('l1')
      const update = { ...input(), encodedData: 'new', responseHash: kind === 'ignored-field' ? 'same' : 'new-hash' }
      await (kind === 'redis' ? redis : writer).update(update)
      expect((await reader.fetch(fetchInput()))?.encodedData).toBe('new')
    } finally {
      publish.mockRestore()
    }
  })

  it.each(['raw', 'envelope'])('does not trust revisions left behind by a legacy %s writer', async (kind) => {
    const reader = l1()
    await reader.update(input())
    const current = JSON.parse((await client.get(input().dataKey))!.slice('@ac-redis:1:'.length))
    delete current.revision
    current.data = 'legacy-current'
    await client.set(
      input().dataKey,
      kind === 'raw' ? 'legacy-current' : '@ac-redis:1:' + JSON.stringify(current),
      'EX',
      10,
    )
    expect((await reader.fetch(fetchInput()))?.encodedData).toBe('legacy-current')
    expect((await reader.fetch(fetchInput()))?.layer).toBe('redis')
  })

  it('does not trust an L1 entry whose durable revision has disappeared', async () => {
    const reader = l1()
    await reader.update(input())
    await client.del(input().dataKey + ':revision')
    expect((await reader.fetch(fetchInput()))?.layer).toBe('redis')
    expect((await reader.fetch(fetchInput()))?.layer).toBe('redis')
  })

  it('prunes naturally expired tag members while a tag remains continuously active', async () => {
    await redis.update({ ...input('r:expired:'), initialTTL: 0.01, maxTTL: 0.01 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await redis.update(input())
    expect(await client.zrange('r:__adaptive:tag-index:red', 0, -1)).toEqual([input().key])
  })

  it.each(['red', 'blue'])(
    'detaches a large index before bounded cleanup and preserves a concurrent %s rewrite',
    async (tag) => {
      const pipeline = client.pipeline()
      for (let index = 0; index < 240; index++)
        pipeline.zadd('r:__adaptive:tag-index:red', Date.now() + 60000, 'r:old:' + index + ':')
      await pipeline.exec()
      await redis.update(input())
      const command = (client as any).adaptiveCacheCleanup
      const batches: number[] = []
      ;(client as any).adaptiveCacheCleanup = async (...args: string[]) => {
        batches.push(JSON.parse(args[3]).length)
        if (batches.length === 1) {
          expect(await client.exists('r:__adaptive:tag-index:red')).toBe(0)
          expect(await redis.fetch(fetchInput())).toBeNull()
          await redis.update({ ...input(), encodedData: 'survivor', tags: [tag] })
        }
        return command.apply(client, args)
      }
      try {
        expect((await redis.invalidateTags(['red'], 'r:')).length).toBe(241)
        expect(batches.length).toBeGreaterThan(1)
        expect(Math.max(...batches)).toBeLessThanOrEqual(100)
        expect((await redis.fetch(fetchInput()))?.encodedData).toBe('survivor')
      } finally {
        ;(client as any).adaptiveCacheCleanup = command
      }
    },
  )

  it('renews active snapshots while a legacy cleanup batch is stalled past its lifetime', async () => {
    const pipeline = client.pipeline()
    for (let index = 0; index < 300; index++) {
      const key = 'r:legacy:' + index + ':'
      pipeline.set(key + 'data', 'legacy', 'EX', 300)
      pipeline.sadd('r:tag:red', key)
    }
    await pipeline.exec()
    const cleanup = (client as any).adaptiveCacheCleanup.bind(client)
    let batches = 0
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    ;(client as any).adaptiveCacheCleanup = async (...args: string[]) => {
      if (++batches === 1) {
        // Cross a real Redis lifetime without adding a minute to every test run.
        await client.pexpire(args[0], 30)
        await vi.advanceTimersByTimeAsync(10000)
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return cleanup(...args)
    }
    try {
      expect((await redis.invalidateTags(['red'], 'r:')).length).toBe(300)
      expect(await client.keys('r:legacy:*:data')).toEqual([])
      expect(batches).toBeGreaterThan(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      ;(client as any).adaptiveCacheCleanup = cleanup
    }
  })

  it.each([1, 300])('rejects failed snapshot renewal and clears the active timer for %s members', async (count) => {
    const pipeline = client.pipeline()
    for (let index = 0; index < count; index++) {
      const key = 'r:renewal:' + index + ':'
      pipeline.set(key + 'data', 'legacy', 'EX', 300)
      pipeline.sadd('r:tag:red', key)
    }
    await pipeline.exec()
    const cleanup = (client as any).adaptiveCacheCleanup.bind(client)
    const renew = vi.spyOn(client, 'pexpire').mockRejectedValue(new Error('lease connection failed'))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    ;(client as any).adaptiveCacheCleanup = async (...args: string[]) => {
      await vi.advanceTimersByTimeAsync(10000)
      return cleanup(...args)
    }
    try {
      await expect(redis.invalidateTags(['red'], 'r:')).rejects.toThrow('snapshot renewal failed')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      renew.mockRestore()
      vi.useRealTimers()
      ;(client as any).adaptiveCacheCleanup = cleanup
    }
  })

  it.each(['before-read', 'before-batch'])(
    'rejects incomplete cleanup if a detached snapshot disappears %s',
    async (stage) => {
      await client.set('r:legacy:data', 'legacy', 'EX', 300)
      await client.sadd('r:tag:red', 'r:legacy:')
      const invalidate = (client as any).adaptiveCacheInvalidate.bind(client)
      const cleanup = (client as any).adaptiveCacheCleanup.bind(client)
      ;(client as any).adaptiveCacheInvalidate = async (...args: string[]) => {
        const detached = await invalidate(...args)
        if (stage === 'before-read') await client.del(detached[1])
        return detached
      }
      ;(client as any).adaptiveCacheCleanup = async (...args: string[]) => {
        if (stage === 'before-batch') await client.del(args[0])
        return cleanup(...args)
      }
      try {
        await expect(redis.invalidateTags(['red'], 'r:')).rejects.toThrow('incomplete')
      } finally {
        ;(client as any).adaptiveCacheInvalidate = invalidate
        ;(client as any).adaptiveCacheCleanup = cleanup
      }
    },
  )

  it('invalidates and overwrites legacy set indexes without WRONGTYPE', async () => {
    await client.set('r:legacy:data', 'legacy')
    await client.sadd('r:tag:red', 'r:legacy:')
    await redis.update(input())
    expect(new Set(await redis.invalidateTags(['red'], 'r:'))).toEqual(new Set(['r:legacy:', input().key]))
    expect(await client.get('r:legacy:data')).toBeNull()
    await client.sadd('r:tag:red', input().key)
    await redis.update({ ...input(), tags: ['blue'] })
    expect((await redis.fetch(fetchInput()))?.encodedData).toBe('old')
    expect(await redis.invalidateTags(['red'], 'r:')).toEqual([input().key])
    expect((await redis.fetch(fetchInput()))?.encodedData).toBe('old')
  })

  it('fails closed when Redis loses the tag epoch independently of the revision', async () => {
    const reader = l1()
    await reader.update(input())
    await client.del('r:__adaptive:tag-epoch:red')
    expect(await reader.fetch(fetchInput())).toBeNull()
  })

  it('does not extend freshness while durable validation is delayed', async () => {
    const reader = l1()
    await reader.update(input())
    const actual = redis.validateRevision.bind(redis)
    const clock = vi.spyOn(Date, 'now')
    const validate = vi.spyOn(redis, 'validateRevision').mockImplementationOnce(async (...args) => {
      const valid = await actual(...args)
      clock.mockReturnValue(Date.now() + 20000)
      return valid
    })
    try {
      // The entry may still be served by Redis, whose clock remains authoritative.
      expect((await reader.fetch(fetchInput()))?.layer).toBe('redis')
    } finally {
      clock.mockRestore()
      validate.mockRestore()
    }
  })

  it('force disconnects owned clients and subscribers without draining pending writes', async () => {
    const ownedClient = client.duplicate()
    const owned = new RedisAdaptiveCacheBackend(ownedClient, logger, true)
    const backend = new L1RedisAdaptiveCacheBackend(
      owned,
      new ClusteredLruAdaptiveCacheBackend({ namespace: 'forced-' + Math.random() }, logger),
      'r:',
      logger,
    )
    const subscriber = (backend as any).subscriber as Redis
    ;(backend as any).state.pendingUpdates.add(new Promise(() => {}))
    await (backend.quit as any)(true, true)
    await vi.waitFor(() => {
      expect(ownedClient.status).toBe('end')
      expect(subscriber.status).toBe('end')
    })
    await (redis.quit as any)(true, true)
    expect(client.status).toBe('ready')
  })
})

describe('standalone LRU tag membership retention', () => {
  it('removes expired members even while writes keep the tag index alive', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: 'member-expiry-' + Math.random() }, logger)
    try {
      await backend.update({ ...input('r:expired:'), initialTTL: 0.01, maxTTL: 0.01 })
      await new Promise((resolve) => setTimeout(resolve, 30))
      await backend.update(input())
      expect(await backend.invalidateTags(['red'], 'r:')).toEqual([input().key])
    } finally {
      await backend.quit()
    }
  })
  it('drops oversized tag indexes while epoch fencing still invalidates retained payloads', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: 'bounded-tag-' + Math.random(), maxSizeBytes: 500000, maxEntrySizeBytes: 1100 },
      logger,
    )
    try {
      const cache = await (backend as any).getCache()
      await backend.update(input())
      let dropped = false
      for (let index = 0; index < 100; index++) {
        await backend.update(input('r:member:' + index + ':'))
        if (!(await cache.get('r:tag:red'))) {
          dropped = true
          break
        }
      }
      expect(dropped).toBe(true)
      expect(await backend.fetch(fetchInput())).not.toBeNull()
      expect(await backend.invalidateTags(['red'], 'r:')).toEqual([])
      expect(await backend.fetch(fetchInput())).toBeNull()
    } finally {
      await backend.quit()
    }
  })

  it('migrates legacy array members without renewing their old index lifetime', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: 'legacy-members-' + Math.random() }, logger)
    try {
      const cache = await (backend as any).getCache()
      await cache.set('r:tag:red', ['r:legacy:'], { ttl: 20, size: 600 })
      await backend.update(input())
      await new Promise((resolve) => setTimeout(resolve, 30))
      await backend.update(input('r:other:'))
      expect(await backend.invalidateTags(['red'], 'r:')).toEqual([input().key, 'r:other:'])
    } finally {
      await backend.quit()
    }
  })
})
