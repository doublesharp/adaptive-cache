import { AdaptiveCache } from '../../src/AdaptiveCache'
import { encodeHttpResponse } from '../../src/httpResponse'
import { getAdaptiveCacheKey as baseAdaptiveCacheKey } from '../../src/utils'
import type {
  AdaptiveCacheBackend,
  AdaptiveCacheBackendFetchInput,
  AdaptiveCacheBackendUpdateInput,
  AdaptiveCacheFetchResult,
  AdaptiveCacheUpdateResult,
  ShouldRefreshCacheUPDATE,
  UpdateCacheAndReleaseLockUPDATED,
} from '../../src/types'

const getAdaptiveCacheKey = (...args: Parameters<typeof baseAdaptiveCacheKey>) =>
  baseAdaptiveCacheKey(args[0], args[1], args[2], args[3], 'localhost:80')

export class ControlledBackend implements AdaptiveCacheBackend {
  readonly name = 'custom' as const
  readonly entries = new Map<string, AdaptiveCacheFetchResult>()
  readonly staleKeys = new Set<string>()
  readonly updatedKeys: string[] = []
  readonly updateInputs: AdaptiveCacheBackendUpdateInput[] = []
  readonly fetchQueue: AdaptiveCacheFetchResult[] = []
  flushCalls = 0
  quitCalls = 0
  generation = 0
  captureError?: Error

  async captureWriteToken() {
    if (this.captureError) throw this.captureError
    return String(this.generation)
  }

  async fetch(input: AdaptiveCacheBackendFetchInput) {
    if (this.fetchQueue.length > 0) return this.fetchQueue.shift() as AdaptiveCacheFetchResult
    const entry = this.entries.get(input.key)
    if (!entry) return null
    if (!this.staleKeys.has(input.key)) return entry
    if (!input.allowStale) return null
    return { ...entry, ttl: 0, stale: true, staleAge: 1 }
  }

  async update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult> {
    this.updateInputs.push({ ...input })
    if (input.writeToken !== undefined && input.writeToken !== String(this.generation)) {
      return ['INVALIDATED', 0] as const
    }
    this.entries.set(input.key, {
      encodedData: input.encodedData,
      ttl: input.maxTTL,
      metadata: { dataTTL: input.maxTTL },
    })
    this.staleKeys.delete(input.key)
    this.updatedKeys.push(input.key)
    return ['CACHED', input.maxTTL] as [string, number]
  }

  async clear(key: string) {
    this.generation += 1
    this.entries.delete(key)
  }

  async invalidateTags() {
    this.generation += 1
    this.entries.clear()
    return []
  }

  async shouldRefresh(): Promise<ShouldRefreshCacheUPDATE> {
    return ['UPDATE', 'lock'] as const
  }

  async releaseLock(): Promise<UpdateCacheAndReleaseLockUPDATED> {
    return ['UPDATED'] as const
  }

  async flush() {
    this.flushCalls += 1
  }

  async quit() {
    this.quitCalls += 1
  }
}

export const controlledCache = () => {
  const backend = new ControlledBackend()
  const cache = new AdaptiveCache({ backend, compress: false, initialTTL: 30, maxTTL: 60 })
  return { backend, cache }
}

export const queueStaleThenUnsafeResponse = async (
  backend: ControlledBackend,
  cache: AdaptiveCache,
  requestPath: string,
) => {
  const key = getAdaptiveCacheKey(requestPath, {}, 'adaptive:')
  await cache.set(key, encodeHttpResponse({ source: 'safe-stale' }, 200, undefined))
  const safe = backend.entries.get(key) as AdaptiveCacheFetchResult
  await cache.set(key, encodeHttpResponse({ source: 'private-racer' }, 200, undefined, { 'cache-control': 'private' }))
  const unsafe = backend.entries.get(key) as AdaptiveCacheFetchResult
  backend.fetchQueue.push({ ...safe, ttl: 0, stale: true, staleAge: 1 }, unsafe)
}

export const queueStaleThenLegacyResponse = async (
  backend: ControlledBackend,
  cache: AdaptiveCache,
  requestPath: string,
) => {
  const key = getAdaptiveCacheKey(requestPath, {}, 'adaptive:')
  await cache.set(key, encodeHttpResponse({ source: 'safe-stale' }, 200, undefined))
  const safe = backend.entries.get(key) as AdaptiveCacheFetchResult
  backend.fetchQueue.push(
    { ...safe, ttl: 0, stale: true, staleAge: 1 },
    { ...safe, encodedData: JSON.stringify({ source: 'legacy-racer' }), ttl: 30 },
  )
}
