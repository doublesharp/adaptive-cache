import { describe, expect, it, vi } from 'vitest'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'

const namespace = (name: string) => `adaptive-cache-backend-${name}-${Date.now()}-${Math.random()}`

const logger = () => new Logger('silent')

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
