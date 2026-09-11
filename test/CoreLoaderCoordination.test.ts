import Redis from 'ioredis'
import crypto from 'node:crypto'
import { setImmediate } from 'node:timers'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import type { AdaptiveCacheOptions } from '../src/types'
import { gate, registerCoreCacheFixture } from './helpers/coreCache'

const { caches, create } = registerCoreCacheFixture()

describe('real Redis loader coordination', () => {
  let container: StartedTestContainer
  let client: Redis
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
  })
  afterAll(async () => {
    await client?.quit()
    await container?.stop()
  })
  const connected = (options: AdaptiveCacheOptions = {}) => {
    const cache = new AdaptiveCache({ logLevel: 'silent', initialTTL: 20, ...options }, client)
    caches.push(cache)
    return cache
  }

  it('shares a loader across independent instances and releases its lock after publication', async () => {
    const first = connected(),
      second = connected()
    const started = gate(),
      release = gate(),
      contended = gate()
    second.onEvent((event) => {
      if (event.type === 'lock-contention') contended.resolve()
    })
    let calls = 0
    const loader = async () => {
      calls++
      started.resolve()
      await release.promise
      return { shared: 1 }
    }
    const owner = first.getOrSet('distributed', loader)
    await started.promise
    const waiter = second.getOrSet('distributed', loader)
    await contended.promise
    expect(calls).toBe(1)
    release.resolve()
    expect(await Promise.all([owner, waiter])).toEqual([{ shared: 1 }, { shared: 1 }])
    expect(calls).toBe(1)
    expect(await client.exists('adaptive:loader:distributed-lock')).toBe(0)
    expect(second.getStats().hitsByLayer.redis).toBeGreaterThan(0)
  })

  it('retries after a failed owner and rejects writes that cross tag invalidation', async () => {
    const first = connected(),
      second = connected()
    await expect(
      first.getOrSet('retry-redis', async () => {
        throw new Error('offline')
      }),
    ).rejects.toThrow('offline')
    expect(await second.getOrSet('retry-redis', async () => 'retry')).toBe('retry')
    const started = gate(),
      release = gate()
    const pending = first.getOrSet(
      'invalidate-redis',
      async () => {
        started.resolve()
        await release.promise
        return 'old'
      },
      { tags: ['inflight'] },
    )
    await started.promise
    await second.invalidateTags(['inflight'])
    release.resolve()
    expect(await pending).toBe('old')
    expect(await first.get('invalidate-redis')).toBeNull()
  })

  it('rejects the result of an expired Redis loader lease after a successor writes', async () => {
    const first = connected({ lockExpirationSeconds: 1 }),
      second = connected({ lockExpirationSeconds: 1 })
    const started = gate(),
      release = gate()
    const old = first.getOrSet('redis-lease', async () => {
      started.resolve()
      await release.promise
      return 'old'
    })
    await started.promise
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(await second.getOrSet('redis-lease', async () => 'successor')).toBe('successor')
    release.resolve()
    expect(await old).toBe('old')
    expect((await second.get('redis-lease'))?.data).toBe('successor')
  })
  it('does not retain loader timestamp markers after success or failure', async () => {
    const cache = connected()
    expect(await cache.getOrSet('marker-success', async () => 'value')).toBe('value')
    await expect(
      cache.getOrSet('marker-failure', async () => {
        throw new Error('failed')
      }),
    ).rejects.toThrow('failed')
    expect(await client.exists('adaptive:loader:marker-success')).toBe(0)
    expect(await client.exists('adaptive:loader:marker-failure')).toBe(0)
  })
})

describe('forced refresh coordination', () => {
  it('waits for a concurrent forced refresh instead of returning its old fresh value', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const first = create({ backend }),
      second = create({ backend })
    await first.set('force-shared', 'old')
    const started = gate(),
      release = gate(),
      contended = gate()
    second.onEvent((event) => {
      if (event.type === 'lock-contention') contended.resolve()
    })
    let calls = 0
    const loader = async () => {
      calls++
      started.resolve()
      await release.promise
      return 'new'
    }
    const owner = first.getOrSet('force-shared', loader, { forceRefresh: true })
    await started.promise
    const waiter = second.getOrSet('force-shared', loader, { forceRefresh: true })
    await contended.promise
    // Let the waiter's already-issued cache read finish while the owner is still gated.
    await new Promise((resolve) => setImmediate(resolve))
    release.resolve()
    expect(await Promise.all([owner, waiter])).toEqual(['new', 'new'])
    expect(calls).toBe(2)
  })
})

describe('forced refresh after owner failure', () => {
  it('runs the waiting forced loader even when the failed owner leaves an old fresh value', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const first = create({ backend }),
      second = create({ backend })
    await first.set('force-failed-owner', 'old')
    const started = gate(),
      release = gate(),
      contended = gate()
    second.onEvent((event) => {
      if (event.type === 'lock-contention') contended.resolve()
    })
    const owner = first
      .getOrSet(
        'force-failed-owner',
        async () => {
          started.resolve()
          await release.promise
          throw new Error('owner failed')
        },
        { forceRefresh: true },
      )
      .catch((error: Error) => error.message)
    await started.promise
    let waiterCalls = 0
    const waiter = second.getOrSet(
      'force-failed-owner',
      async () => {
        waiterCalls++
        return 'recovered'
      },
      { forceRefresh: true },
    )
    await contended.promise
    await new Promise((resolve) => setImmediate(resolve))
    release.resolve()
    expect(await owner).toBe('owner failed')
    expect(await waiter).toBe('recovered')
    expect(waiterCalls).toBe(1)
    expect((await second.get('force-failed-owner'))?.data).toBe('recovered')
  })
})

describe('mixed background and foreground stale policies', () => {
  it('does not pass a background stale fallback to a foreground caller that disabled stale serving', async () => {
    const namespace = crypto.randomUUID()
    const ownerBackend = new ClusteredLruAdaptiveCacheBackend({ namespace }, new Logger('silent'))
    const waiterBackend = new ClusteredLruAdaptiveCacheBackend({ namespace }, new Logger('silent'))
    const first = create({ backend: ownerBackend, staleWhileRevalidate: 10 })
    const second = create({ backend: waiterBackend, staleWhileRevalidate: 10 })
    await first.set('mixed-policy', 'old')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    const ownerStarted = gate(),
      releaseOwner = gate(),
      contended = gate(),
      releaseContention = gate()
    const acquire = waiterBackend.shouldRefresh.bind(waiterBackend)
    let attempts = 0
    vi.spyOn(waiterBackend, 'shouldRefresh').mockImplementation(async (...args) => {
      const result = await acquire(...args)
      if (++attempts === 1) {
        contended.resolve()
        await releaseContention.promise
      }
      return result
    })
    expect(
      await first.getOrSet('mixed-policy', async () => {
        ownerStarted.resolve()
        await releaseOwner.promise
        return 'new'
      }),
    ).toBe('old')
    await ownerStarted.promise
    expect(await second.getOrSet('mixed-policy', async () => 'unexpected background')).toBe('old')
    await contended.promise
    let foregroundDone = false
    let foregroundCalls = 0
    const foreground = second
      .getOrSet(
        'mixed-policy',
        async () => {
          foregroundCalls++
          return 'unexpected foreground'
        },
        { staleWhileRevalidate: 0, staleIfError: 0 },
      )
      .then((value) => {
        foregroundDone = true
        return value
      })
    await new Promise((resolve) => setImmediate(resolve))
    releaseContention.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    const completedBeforeOwner = foregroundDone
    releaseOwner.resolve()
    await first.flush()
    expect(await foreground).toBe('new')
    expect(completedBeforeOwner).toBe(false)
    expect(foregroundCalls).toBe(0)
  })
})

describe('publication before loader lock release', () => {
  it('returns a value published during contention while the other owner still holds its lock', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const owner = create({ backend }),
      waiter = create({ backend })
    const lastUpdateKey = 'adaptive:loader:published-while-locked'
    const lock = await owner.shouldRefresh(lastUpdateKey, 0)
    expect(lock[0]).toBe('UPDATE')
    const contended = gate()
    waiter.onEvent((event) => {
      if (event.type === 'lock-contention') contended.resolve()
    })
    let loaderCalls = 0
    const waiting = waiter.getOrSet('published-while-locked', async () => {
      loaderCalls++
      return 'unexpected'
    })
    await contended.promise
    await owner.set('published-while-locked', 'published')
    expect(await waiting).toBe('published')
    expect(loaderCalls).toBe(0)
    if (lock[0] === 'UPDATE') {
      expect(await owner.shouldRefresh(lastUpdateKey, 0)).toEqual(['UPDATING', lock[1]])
      await owner.releaseLock(lastUpdateKey, lock[1])
    }
  })
})
