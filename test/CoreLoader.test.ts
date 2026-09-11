import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { gate, registerCoreCacheFixture } from './helpers/coreCache'

const { create } = registerCoreCacheFixture()

describe('core loader features', () => {
  it('coalesces 100 simultaneous misses and retries after a rejected loader', async () => {
    const cache = create()
    const started = gate(),
      release = gate()
    let calls = 0
    const requests = Array.from({ length: 100 }, () =>
      cache.getOrSet('same', async () => {
        calls++
        started.resolve()
        await release.promise
        return { value: 42 }
      }),
    )
    await started.promise
    expect(calls).toBe(1)
    release.resolve()
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 100 }, () => ({ value: 42 })))
    await expect(
      cache.getOrSet('failure', async () => {
        throw new Error('loader failed')
      }),
    ).rejects.toThrow('loader failed')
    expect(await cache.getOrSet('failure', async () => 'recovered')).toBe('recovered')
  })

  it('never repopulates data when a loader crosses namespace invalidation', async () => {
    const cache = create()
    const started = gate(),
      release = gate()
    const loading = cache.getOrSet('race', async () => {
      started.resolve()
      await release.promise
      return 'old'
    })
    await started.promise
    await cache.invalidateNamespace()
    release.resolve()
    expect(await loading).toBe('old')
    expect(await cache.get('race')).toBeNull()
  })

  it('returns SWR immediately and flush waits for its refresh', async () => {
    const cache = create({ staleWhileRevalidate: 10 })
    await cache.getOrSet('stale', async () => 'old')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 3000)
    expect(await cache.get('stale')).toBeNull()
    const started = gate(),
      release = gate()
    expect(
      await cache.getOrSet('stale', async () => {
        started.resolve()
        await release.promise
        return 'new'
      }),
    ).toBe('old')
    await started.promise
    let flushed = false
    const flush = cache.flush().then(() => {
      flushed = true
    })
    await Promise.resolve()
    expect(flushed).toBe(false)
    release.resolve()
    await flush
    expect((await cache.get('stale'))?.data).toBe('new')
  })

  it('enforces SIE at failure time independently from SWR', async () => {
    const cache = create({ staleWhileRevalidate: 1, staleIfError: 5 })
    await cache.getOrSet('stale', async () => 'old')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 4000)
    expect(
      await cache.getOrSet('stale', async () => {
        throw new Error('offline')
      }),
    ).toBe('old')
    await expect(
      cache.getOrSet('stale', async () => {
        clock.mockReturnValue(now + 8000)
        throw new Error('expired while loading')
      }),
    ).rejects.toThrow('expired while loading')
  })

  it('negative caching is opt in and has a hard TTL', async () => {
    const cache = create()
    let calls = 0
    const loader = async () => {
      calls++
      return null
    }
    await cache.getOrSet('absent', loader)
    await cache.getOrSet('absent', loader)
    expect(calls).toBe(2)
    await cache.getOrSet('negative', loader, { negativeTTL: 1 })
    await cache.getOrSet('negative', loader, { negativeTTL: 1 })
    expect(calls).toBe(3)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1500)
    await cache.getOrSet('negative', loader, { negativeTTL: 1 })
    expect(calls).toBe(4)
  })
})

describe('loader failure and lifecycle boundaries', () => {
  it('bounds lock contention without taking over the current owner', async () => {
    const cache = create({ lockWaitTimeoutMs: 5 })
    const held = await cache.shouldRefresh('adaptive:loader:busy', 0)
    expect(held[0]).toBe('UPDATE')
    await expect(cache.getOrSet('busy', async () => 'unexpected')).rejects.toThrow('Timed out')
    expect(await cache.get('busy')).toBeNull()
    if (held[0] === 'UPDATE') await cache.releaseLock('adaptive:loader:busy', held[1])
    expect(await cache.getOrSet('busy', async () => 'retry')).toBe('retry')
    expect(cache.getStats().counters['lock-contention']).toBe(1)
  })

  it('close drains an active read before destroying its backend', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const cache = create({ backend })
    await cache.set('read', 'value')
    const started = gate(),
      release = gate()
    const fetch = backend.fetch.bind(backend)
    vi.spyOn(backend, 'fetch').mockImplementation(async (input) => {
      started.resolve()
      await release.promise
      return fetch(input)
    })
    const reading = cache.get('read')
    await started.promise
    let closed = false
    const closing = cache.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve()
    expect((await reading)?.data).toBe('value')
    await closing
    expect(closed).toBe(true)
  })

  it('explicit force refresh coalesces calls while ignoring a fresh hit', async () => {
    const cache = create()
    await cache.set('force', 'old')
    const started = gate(),
      release = gate()
    let calls = 0
    const loader = async () => {
      calls++
      started.resolve()
      await release.promise
      return 'new'
    }
    const one = cache.getOrSet('force', loader, { forceRefresh: true })
    const two = cache.getOrSet('force', loader, { forceRefresh: true })
    await started.promise
    expect(calls).toBe(1)
    release.resolve()
    expect(await Promise.all([one, two])).toEqual(['new', 'new'])
  })

  it('does not use stale fallback after invalidation while the loader fails', async () => {
    const cache = create({ staleIfError: 10 })
    await cache.set('invalidate-error', 'old')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    await expect(
      cache.getOrSet('invalidate-error', async () => {
        await cache.clear('invalidate-error')
        throw new Error('failed')
      }),
    ).rejects.toThrow('failed')
  })

  it('custom backends lacking fencing keep basic reads and writes but reject loader work', async () => {
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const cache = create({
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
    await cache.set('basic', 'supported')
    expect((await cache.get('basic'))?.data).toBe('supported')
    let calls = 0
    await expect(
      cache.getOrSet('missing', async () => {
        calls++
        return 'not run'
      }),
    ).rejects.toThrow('captureWriteToken')
    expect(calls).toBe(0)
    await expect(cache.invalidateNamespace()).rejects.toThrow('namespace invalidation')
  })
})

describe('expired loader leases', () => {
  it('does not overwrite a successor after the old loader lease expires', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const first = create({ backend, lockExpirationSeconds: 1 })
    const second = create({ backend, lockExpirationSeconds: 1 })
    const started = gate(),
      release = gate()
    const old = first.getOrSet('lease', async () => {
      started.resolve()
      await release.promise
      return 'old'
    })
    await started.promise
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(await second.getOrSet('lease', async () => 'successor')).toBe('successor')
    release.resolve()
    expect(await old).toBe('old')
    expect((await second.get('lease'))?.data).toBe('successor')
  })
})

describe('negative TTL caps', () => {
  it('never lets negativeTTL extend a constructor maximum TTL', async () => {
    const cache = create({ initialTTL: 10, maxTTL: 1, negativeTTL: 10 })
    await cache.getOrSet('negative-cap', async () => null)
    expect((await cache.get('negative-cap'))?.ttl).toBeLessThanOrEqual(1)
  })
})

describe('loader storage policy', () => {
  it('returns the loader result without caching when its policy vetoes storage', async () => {
    const cache = create()
    expect(cache.supportsWriteFencing()).toBe(true)
    expect(
      await cache.getOrSet('no-store', async () => ({ private: true }), { shouldStore: (data) => !data.private }),
    ).toEqual({ private: true })
    expect(await cache.get('no-store')).toBeNull()
  })
})

describe('loader result TTL policy', () => {
  it('resolves load TTL from the completed result and falls back to constructor policy when undefined', async () => {
    const cache = create({ initialTTL: 20, maxTTL: () => 7 })
    const data = await cache.getOrSet('result-ttl', async () => ({ freshness: 3 }), {
      maxTTL: (value) => value.freshness,
    })
    expect(data).toEqual({ freshness: 3 })
    expect((await cache.get('result-ttl'))?.ttl).toBe(3)
    await cache.getOrSet('fallback-ttl', async () => ({ freshness: undefined }), { maxTTL: (value) => value.freshness })
    expect((await cache.get('fallback-ttl'))?.ttl).toBe(7)
  })
})
