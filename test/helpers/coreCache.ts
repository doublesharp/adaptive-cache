import crypto from 'node:crypto'
import { afterEach, vi } from 'vitest'
import { AdaptiveCache } from '../../src/AdaptiveCache'
import type { AdaptiveCacheOptions } from '../../src/types'

// Each test file owns its cache registry and cleanup hook.
export const registerCoreCacheFixture = () => {
  const caches: AdaptiveCache[] = []
  const create = (options: AdaptiveCacheOptions = {}) => {
    const cache = new AdaptiveCache({
      backend: 'clustered-lru',
      logLevel: 'silent',
      initialTTL: 2,
      lru: { namespace: crypto.randomUUID(), maxSizeBytes: 1024 * 1024 },
      ...options,
    })
    caches.push(cache)
    return cache
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(caches.splice(0).map((cache) => cache.quit()))
  })

  return { caches, create }
}

export const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
