import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'

const logger = new Logger('silent')

describe('clustered LRU lifecycle cleanup', () => {
  it('preserves initialization errors when no clustered cache was allocated', async () => {
    const cause = new Error('module unavailable')
    vi.spyOn(ClusteredLruAdaptiveCacheBackend, 'loadModule').mockImplementation(() => {
      throw cause
    })
    const cache = new AdaptiveCache({ backend: 'clustered-lru', logLevel: 'silent' })
    try {
      const failure = await cache.get('item').catch((error: Error) => error)
      expect(failure).toMatchObject({ cause })
      await expect(cache.close()).rejects.toBe(failure)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('does not initialize a clustered backend after it has been closed', async () => {
    const load = vi.spyOn(ClusteredLruAdaptiveCacheBackend, 'loadModule')
    const backend = new ClusteredLruAdaptiveCacheBackend(undefined, logger)
    try {
      await backend.quit()
      await expect(backend.captureWriteToken('helper:')).rejects.toThrow('closed')
      expect(load).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('closes an allocated clustered cache after its initial health check rejects', async () => {
    const peer = ClusteredLruAdaptiveCacheBackend.loadModule()
    const namespace = randomUUID()
    const failure = new Error('health check failed')
    const destroy = vi.fn()
    class UnhealthyCache extends peer.LRUCacheClustered {
      async healthCheck() {
        throw failure
      }
      async destroy() {
        destroy()
        return super.destroy()
      }
    }
    vi.spyOn(ClusteredLruAdaptiveCacheBackend, 'loadModule').mockReturnValue({ LRUCacheClustered: UnhealthyCache })
    const cache = new AdaptiveCache({ backend: 'clustered-lru', lru: { namespace }, logLevel: 'silent' })
    try {
      await expect(cache.get('item')).rejects.toBe(failure)
      expect(peer.LRUCacheClustered.getAllCaches().has(namespace)).toBe(true)
      await expect(cache.close()).resolves.toBeUndefined()
      expect(destroy).toHaveBeenCalledTimes(1)
      expect(peer.LRUCacheClustered.getAllCaches().has(namespace)).toBe(false)
    } finally {
      vi.restoreAllMocks()
      // Remove the namespace even when running this regression against broken code.
      peer.LRUCacheClustered.getAllCaches().delete(namespace)
    }
  })

  it('tears down a stalled clustered initialization at the close deadline and prevents late resurrection', async () => {
    const peer = ClusteredLruAdaptiveCacheBackend.loadModule()
    const namespace = randomUUID()
    let finishHealthCheck!: () => void
    class SlowCache extends peer.LRUCacheClustered {
      healthCheck() {
        return new Promise<void>((resolve) => {
          finishHealthCheck = resolve
        })
      }
    }
    vi.spyOn(ClusteredLruAdaptiveCacheBackend, 'loadModule').mockReturnValue({ LRUCacheClustered: SlowCache })
    const cache = new AdaptiveCache({ backend: 'clustered-lru', lru: { namespace }, logLevel: 'silent' })
    const reading = cache.get('item').catch((error: Error) => error)
    try {
      await expect(cache.close({ timeoutMs: 10 })).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(peer.LRUCacheClustered.getAllCaches().has(namespace)).toBe(false)
      finishHealthCheck()
      expect(await reading).toMatchObject({ message: expect.stringContaining('closed') })
      expect(peer.LRUCacheClustered.getAllCaches().has(namespace)).toBe(false)
    } finally {
      finishHealthCheck()
      await reading
      vi.restoreAllMocks()
      peer.LRUCacheClustered.getAllCaches().delete(namespace)
    }
  })
})
