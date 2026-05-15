import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import express from 'express'
import Redis from 'ioredis'
import request from 'supertest'

let cacheModule: typeof import('../src')
let redisClient: Redis
let container: StartedTestContainer

const namespace = (name: string) => `e2e:${name}:${Date.now()}:${Math.random().toString(36).slice(2)}:`

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 3000) => {
  const start = Date.now()
  let lastError: unknown

  while (Date.now() - start < timeoutMs) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  throw lastError
}

describe('Adaptive cache end-to-end behavior', () => {
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()

    process.env.REDIS_HOST = container.getHost()
    process.env.REDIS_PORT = container.getMappedPort(6379).toString()

    cacheModule = await import('../src/index')
    redisClient = cacheModule.redis
  })

  afterAll(async () => {
    if (redisClient) {
      await redisClient.quit()
    }
    if (container) {
      await container.stop()
    }
  })

  beforeEach(async () => {
    await redisClient.flushall()
    vi.restoreAllMocks()
  })

  it('proves Redis Lua adapts TTLs, resets changed content, and keeps metadata after data expiry', async () => {
    const keyPrefix = namespace('redis-lua')
    const key = `${keyPrefix}direct`
    const cache = new cacheModule.AdaptiveCache(
      {
        initialTTL: 1,
        maxTTL: 8,
        ttlScaling: 2,
        metaTTL: 60,
        includeDebugHeaders: true,
        keyPrefix,
      },
      redisClient,
    )

    expect((await cache.set(key, { value: 'stable' }))[1]).toBe(1)
    expect((await cache.set(key, { value: 'stable' }))[1]).toBe(2)
    expect((await cache.set(key, { value: 'stable' }))[1]).toBe(4)

    const stableHit = await cache.get(key)
    expect(stableHit?.data).toEqual({ value: 'stable' })
    expect(Number(stableHit?.metadata.dataTTL)).toBe(4)
    expect(Number(stableHit?.metadata.changeCount)).toBe(1)

    const changed = await cache.set(key, { value: 'changed' })
    expect(changed[1]).toBe(1)
    expect(changed[5]).toBe(1)

    const changedHit = await cache.get(key)
    expect(changedHit?.data).toEqual({ value: 'changed' })
    expect(Number(changedHit?.metadata.dataTTL)).toBe(1)
    expect(Number(changedHit?.metadata.changeCount)).toBe(2)

    await new Promise((resolve) => setTimeout(resolve, 1100))

    expect(await cache.get(key)).toBeNull()
    const metadataAfterExpiry = await redisClient.hgetall(`${key}meta`)
    expect(metadataAfterExpiry.hash).toBe(changed[4])
    expect(metadataAfterExpiry.dataTTL).toBe('1')
    expect(metadataAfterExpiry.changeCount).toBe('2')
  })

  it('proves Express Redis middleware handles canonical keys, refresh, tags, and invalidation', async () => {
    const keyPrefix = namespace('express-redis')
    const app = express()
    let callCount = 0

    app.get(
      '/products',
      cacheModule.adaptiveExpressCache({
        keyPrefix,
        initialTTL: 10,
        includeDebugHeaders: true,
        tags: ['catalog'],
      }),
      (req, res) => {
        callCount++
        res.json({
          callCount,
          filter: req.query.filter,
          sort: req.query.sort,
        })
      },
    )

    const first = await request(app).get('/products?sort=asc&filter=all').expect(200)
    expect(first.headers['x-cache']).toBe('MISS')
    expect(first.body).toEqual({ callCount: 1, filter: 'all', sort: 'asc' })

    await waitFor(async () => {
      expect((await redisClient.smembers(`${keyPrefix}tag:catalog`)).length).toBe(1)
    })

    const canonicalHit = await request(app).get('/products?filter=all&sort=asc').expect(200)
    expect(canonicalHit.headers['x-cache']).toBe('HIT')
    expect(canonicalHit.headers['x-cache-data-ttl']).toBeDefined()
    expect(canonicalHit.body.callCount).toBe(1)

    const refreshed = await request(app).get('/products?refresh=true&filter=all&sort=asc').expect(200)
    expect(refreshed.headers['x-cache']).toBe('BYPASS')
    expect(refreshed.body.callCount).toBe(2)

    await waitFor(async () => {
      const postRefreshHit = await request(app).get('/products?sort=asc&filter=all').expect(200)
      expect(postRefreshHit.headers['x-cache']).toBe('HIT')
      expect(postRefreshHit.body.callCount).toBe(2)
    })

    const invalidator = new cacheModule.AdaptiveCache({ keyPrefix }, redisClient)
    await invalidator.invalidateTags(['catalog'])

    const afterInvalidation = await request(app).get('/products?sort=asc&filter=all').expect(200)
    expect(afterInvalidation.headers['x-cache']).toBe('MISS')
    expect(afterInvalidation.body.callCount).toBe(3)
  })

  it('proves l1-redis serves hot L1 reads, flushes Redis writes, and invalidates peer L1 instances', async () => {
    const keyPrefix = namespace('l1-redis')
    const key = `${keyPrefix}shared`
    const createCache = (name: string) =>
      new cacheModule.AdaptiveCache(
        {
          backend: 'l1-redis',
          keyPrefix,
          initialTTL: 5,
          maxTTL: 30,
          includeDebugHeaders: true,
          l1Redis: { writeMode: 'await-redis' },
          lru: {
            namespace: `${keyPrefix}${name}`,
            maxSizeBytes: 1024 * 1024,
            maxEntrySizeBytes: 128 * 1024,
          },
        },
        redisClient,
      )

    const writer = createCache('writer')
    const reader = createCache('reader')

    try {
      await writer.set(key, { version: 1 }, { tags: ['shared-tag'] })
      await writer.flush()

      const redisMetadata = await redisClient.hgetall(`${key}meta`)
      expect(redisMetadata.hash).toBeDefined()

      expect((await reader.get(key))?.data).toEqual({ version: 1 })

      const originalFetch = (reader.client as any).adaptiveCacheFetch
      const fetchSpy = vi.fn(async () => {
        throw new Error('Redis unavailable')
      })
      ;(reader.client as any).adaptiveCacheFetch = fetchSpy
      try {
        const l1Hit = await reader.get(key)
        expect(l1Hit?.data).toEqual({ version: 1 })
        expect(fetchSpy).not.toHaveBeenCalled()
      } finally {
        ;(reader.client as any).adaptiveCacheFetch = originalFetch
      }

      await writer.invalidateTags(['shared-tag'])

      await waitFor(async () => {
        expect(await reader.get(key)).toBeNull()
      })
    } finally {
      await writer.quit()
      await reader.quit()
    }
  })

  it('proves standalone clustered-lru caches without Redis and enforces tag clears and local locks', async () => {
    const keyPrefix = namespace('clustered-lru')
    const cache = new cacheModule.AdaptiveCache({
      backend: 'clustered-lru',
      keyPrefix,
      initialTTL: 5,
      maxTTL: 20,
      includeDebugHeaders: true,
      lru: {
        namespace: keyPrefix,
        maxSizeBytes: 1024 * 1024,
        maxEntrySizeBytes: 128 * 1024,
      },
    })
    const key = `${keyPrefix}standalone`

    try {
      const first = await cache.set(key, 'standalone payload', { tags: ['local-tag'] })
      expect(first[0]).toBe('CACHED')

      const hit = await cache.get(key)
      expect(hit?.data).toBe('standalone payload')
      expect(Number(hit?.metadata.dataTTL)).toBe(5)

      const [updateStatus, lockValue] = await cache.shouldRefresh(`${keyPrefix}refresh`, 60)
      expect(updateStatus).toBe('UPDATE')
      expect((await cache.shouldRefresh(`${keyPrefix}refresh`, 60))[0]).toBe('UPDATING')
      expect(await cache.releaseLock(`${keyPrefix}refresh`, lockValue as string)).toEqual(['UPDATED'])
      expect((await cache.shouldRefresh(`${keyPrefix}refresh`, 60))[0]).toBe('EXISTS')

      await cache.invalidateTags(['local-tag'])
      expect(await cache.get(key)).toBeNull()
    } finally {
      await cache.quit()
    }
  })
})
