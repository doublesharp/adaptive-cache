import { performance } from 'node:perf_hooks'
import type {
  AdaptiveCacheBackend,
  AdaptiveCacheOptions,
  AdaptiveCacheSetOptions,
  AdaptiveCacheHit,
  AdaptiveCacheLoadOptions,
  AdaptiveCacheEvent,
} from './types'

interface LoaderCache {
  options: AdaptiveCacheOptions
  backend: AdaptiveCacheBackend
  getKeyPrefix(): string
  read<T>(key: string, options?: { allowStale?: boolean }): Promise<AdaptiveCacheHit<T> | null>
  write(
    key: string,
    data: unknown,
    options: AdaptiveCacheSetOptions,
    lease: { lockKey: string; lockValue: string },
  ): Promise<unknown>
  resolveMaxTTL(data: unknown, options: Pick<AdaptiveCacheOptions, 'maxTTL'>): number
  acquireRefreshLock(
    lastUpdateKey: string,
    refreshThreshold: number,
    force: boolean,
  ): ReturnType<AdaptiveCacheBackend['shouldRefresh']>
  track<T>(promise: Promise<T>): Promise<T>
  emit(event: Omit<AdaptiveCacheEvent, 'timestamp'> & { timestamp?: number }): void
}

type LoadResult<T> = { data: T; backgroundFallback?: boolean }

// Coordinates loaders and freshness policy. The owning cache tracks all accepted work
// so shutdown can drain it, including background refreshes and their lock cleanup.
export class CacheLoader {
  private readonly loads = new Map<string, Promise<LoadResult<any>>>()

  constructor(private readonly cache: LoaderCache) {}

  public async getOrSet<T>(key: string, loader: () => Promise<T>, options: AdaptiveCacheLoadOptions<T>): Promise<T> {
    const swr = options.staleWhileRevalidate ?? this.cache.options.staleWhileRevalidate ?? 0
    const sie = options.staleIfError ?? this.cache.options.staleIfError ?? 0
    const force = options.forceRefresh ?? this.cache.options.forceRefresh ?? false
    const hit = await this.cache.read<T>(key, { allowStale: swr > 0 || sie > 0 })
    if (hit && !hit.stale && !force) return hit.data
    const backgroundHit = !force && hit?.stale && hit.staleAge !== undefined && hit.staleAge < swr ? hit : undefined
    let loading = this.loads.get(key) as Promise<LoadResult<T>> | undefined
    if (!loading) {
      loading = this.cache.track(
        this.load(
          key,
          loader,
          { ...options, staleTTL: Math.max(options.staleTTL ?? 0, swr, sie) },
          force,
          backgroundHit,
        ),
      )
      this.loads.set(key, loading)
      void loading.then(
        () => this.loads.delete(key),
        () => this.loads.delete(key),
      )
    }
    if (backgroundHit) {
      void loading.catch(() => {
        /* The refresh reports its own error event. */
      })
      return backgroundHit.data
    }
    try {
      const result = await loading
      // A foreground joiner must not inherit another caller's stale eligibility.
      if (result.backgroundFallback) return this.getOrSet(key, loader, options)
      return result.data
    } catch (error) {
      // Re-read at failure time: elapsed loader time and invalidation both constrain fallback.
      if (sie > 0) {
        const fallback = await this.cache.read<T>(key, { allowStale: true })
        if (fallback && (!fallback.stale || (fallback.staleAge !== undefined && fallback.staleAge < sie)))
          return fallback.data
      }
      throw error
    }
  }

  private async load<T>(
    key: string,
    loader: () => Promise<T>,
    options: AdaptiveCacheLoadOptions<T>,
    force: boolean,
    backgroundHit?: AdaptiveCacheHit<T>,
  ): Promise<LoadResult<T>> {
    const started = performance.now()
    const lockKey = this.cache.getKeyPrefix() + 'loader:' + key
    const waitLimit = options.lockWaitTimeoutMs ?? this.cache.options.lockWaitTimeoutMs ?? 5000
    let lock: string | undefined
    let contended = false
    try {
      if (!this.cache.backend.captureWriteToken)
        throw new Error('Backend does not support captureWriteToken required for fenced loading')
      for (;;) {
        const result = await this.cache.acquireRefreshLock(lockKey, 0, false)
        if (result[0] === 'UPDATE') {
          lock = result[1]
          break
        }
        if (!contended) {
          this.cache.emit({ type: 'lock-contention', key })
          contended = true
        }
        if (backgroundHit) return { data: backgroundHit.data, backgroundFallback: true }
        if (!force) {
          const shared = await this.cache.read<T>(key)
          if (shared) return { data: shared.data }
        }
        const remaining = waitLimit - (performance.now() - started)
        if (remaining <= 0) throw new Error(`Timed out waiting for cache loader lock for ${key}`)
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
      }
      // A writer can finish after our initial miss but before we acquire its released lock.
      // Forced callers serialize across instances and each execute their loader.
      if (!force) {
        const shared = await this.cache.read<T>(key)
        if (shared) return { data: shared.data }
      }
      const writeToken = await this.cache.backend.captureWriteToken(this.cache.getKeyPrefix())
      this.cache.emit({ type: 'refresh', key })
      const data = await loader()
      const negative = options.isNegative ? options.isNegative(data) : data === null || data === undefined
      const negativeTTL = options.negativeTTL ?? this.cache.options.negativeTTL ?? 0
      if ((!negative || negativeTTL > 0) && (options.shouldStore?.(data) ?? true)) {
        const maxTTL = this.cache.resolveMaxTTL(data, options)
        await this.cache.write(
          key,
          data,
          {
            ...options,
            writeToken,
            maxTTL: negative ? Math.min(maxTTL, negativeTTL) : maxTTL,
            ...(negative ? { staleTTL: 0 } : {}),
          },
          { lockKey: lockKey + '-lock', lockValue: lock },
        )
        // A distributed waiter must see the authoritative write before the lock is released.
        await this.cache.backend.flush?.()
      }
      return { data }
    } catch (error) {
      this.cache.emit({ type: 'error', key, reason: 'refresh', error, durationMs: performance.now() - started })
      throw error
    } finally {
      if (lock !== undefined) {
        try {
          await this.cache.backend.releaseLock(lockKey, Math.floor(Date.now() / 1000), lock, false)
        } catch (error) {
          // A failed cleanup must not replace the loader's result or original error.
          this.cache.emit({
            type: 'error',
            key,
            reason: 'lock-release',
            error,
            durationMs: performance.now() - started,
          })
        }
      }
    }
  }
}
