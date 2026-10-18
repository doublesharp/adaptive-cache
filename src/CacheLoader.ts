import { performance } from 'node:perf_hooks'
import type {
  AdaptiveCacheBackend,
  AdaptiveCacheOptions,
  AdaptiveCacheSetOptions,
  AdaptiveCacheHit,
  AdaptiveCacheLoadOptions,
  AdaptiveCacheLoaderContext,
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
    signal?: AbortSignal,
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
interface SharedLoad {
  promise: Promise<LoadResult<any>>
  controller: AbortController
  users: number
}

// Race every awaited stage, including non-cooperative custom backends, without
// leaving a rejection unobserved if the detached operation later fails.
const waitFor = <T>(work: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    if (signal.aborted) return aborted()
    signal.addEventListener('abort', aborted, { once: true })
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return work()
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted))
  })

// Each caller owns its wait deadline. The shared loader lives while at least one
// foreground caller or detached SWR refresh still has an interest in the result.
export class CacheLoader {
  private readonly loads = new Map<string, SharedLoad>()
  private readonly callers = new Set<AbortController>()

  constructor(private readonly cache: LoaderCache) {}

  public abort(reason: unknown): void {
    for (const caller of this.callers) caller.abort(reason)
    for (const load of this.loads.values()) load.controller.abort(reason)
  }

  public async getOrSet<T>(
    key: string,
    loader: (context: AdaptiveCacheLoaderContext) => Promise<T>,
    options: AdaptiveCacheLoadOptions<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal!.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    this.callers.add(controller)
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(`Cache loader timed out after ${options.loadTimeoutMs}ms for ${key}`, 'TimeoutError'),
        ),
      options.loadTimeoutMs,
    )
    const dispose = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      this.callers.delete(controller)
    }
    let detached = false
    try {
      const swr = options.staleWhileRevalidate ?? this.cache.options.staleWhileRevalidate ?? 0
      const sie = options.staleIfError ?? this.cache.options.staleIfError ?? 0
      const force = options.forceRefresh ?? this.cache.options.forceRefresh ?? false
      const signal = controller.signal
      const hit = await waitFor(() => this.cache.read<T>(key, { allowStale: swr > 0 || sie > 0 }), signal)
      if (hit && !hit.stale && !force) return hit.data
      const backgroundHit = !force && hit?.stale && hit.staleAge !== undefined && hit.staleAge < swr ? hit : undefined
      const getLoad = () => {
        let loading = this.loads.get(key)
        if (!loading || loading.controller.signal.aborted) {
          const shared = new AbortController()
          loading = { controller: shared, users: 0, promise: undefined! }
          const owned = loading
          loading.promise = this.cache.track(
            this.load(
              key,
              loader,
              { ...options, staleTTL: Math.max(options.staleTTL ?? 0, swr, sie) },
              force,
              shared.signal,
              backgroundHit,
            ),
          )
          this.loads.set(key, loading)
          const remove = () => {
            if (this.loads.get(key) === owned) this.loads.delete(key)
          }
          shared.signal.addEventListener('abort', remove, { once: true })
          void loading.promise.then(remove, remove)
        }
        return loading
      }
      const join = async (loading: SharedLoad): Promise<LoadResult<T>> => {
        loading.users++
        try {
          return await waitFor(() => loading.promise, signal)
        } finally {
          if (--loading.users === 0)
            loading.controller.abort(signal.reason ?? new DOMException('No cache loader callers remain', 'AbortError'))
        }
      }
      if (backgroundHit) {
        detached = true
        void join(getLoad())
          .catch(() => {
            // The refresh reports its own error event.
          })
          .finally(dispose)
        return backgroundHit.data
      }
      try {
        for (;;) {
          const result = await join(getLoad())
          // A foreground joiner must not inherit another caller's stale eligibility.
          if (!result.backgroundFallback) return result.data
          signal.throwIfAborted()
        }
      } catch (error) {
        signal.throwIfAborted()
        // Re-read at failure time, under the caller's remaining deadline.
        if (sie > 0) {
          try {
            const fallback = await waitFor(() => this.cache.read<T>(key, { allowStale: true }), signal)
            if (fallback && (!fallback.stale || (fallback.staleAge !== undefined && fallback.staleAge < sie)))
              return fallback.data
          } catch {
            signal.throwIfAborted()
            // Cache fallback failures must not replace the original source error.
          }
        }
        throw error
      }
    } finally {
      if (!detached) dispose()
    }
  }

  private async load<T>(
    key: string,
    loader: (context: AdaptiveCacheLoaderContext) => Promise<T>,
    options: AdaptiveCacheLoadOptions<T>,
    force: boolean,
    signal: AbortSignal,
    backgroundHit?: AdaptiveCacheHit<T>,
  ): Promise<LoadResult<T>> {
    const started = performance.now()
    const lockKey = this.cache.getKeyPrefix() + 'loader:' + key
    const waitLimit = options.lockWaitTimeoutMs ?? this.cache.options.lockWaitTimeoutMs ?? 5000
    let lock: string | undefined
    let contended = false
    const release = async (value: string) => {
      try {
        await this.cache.backend.releaseLock(lockKey, Math.floor(Date.now() / 1000), value, false)
      } catch (error) {
        this.cache.emit({ type: 'error', key, reason: 'lock-release', error, durationMs: performance.now() - started })
      }
    }
    try {
      if (!this.cache.backend.captureWriteToken)
        throw new Error('Backend does not support captureWriteToken required for fenced loading')
      for (;;) {
        const result = await waitFor(
          () =>
            this.cache.acquireRefreshLock(lockKey, 0, false).then((result) => {
              if (result[0] === 'UPDATE') {
                if (signal.aborted) void release(result[1])
                else lock = result[1]
              }
              return result
            }),
          signal,
        )
        if (result[0] === 'UPDATE') break
        if (!contended) {
          this.cache.emit({ type: 'lock-contention', key })
          contended = true
        }
        if (backgroundHit) return { data: backgroundHit.data, backgroundFallback: true }
        if (!force) {
          const shared = await waitFor(() => this.cache.read<T>(key), signal)
          if (shared) return { data: shared.data }
        }
        const remaining = waitLimit - (performance.now() - started)
        if (remaining <= 0) throw new Error(`Timed out waiting for cache loader lock for ${key}`)
        await waitFor(() => new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining))), signal)
      }
      if (!force) {
        const shared = await waitFor(() => this.cache.read<T>(key), signal)
        if (shared) return { data: shared.data }
      }
      const writeToken = await waitFor(() => this.cache.backend.captureWriteToken!(this.cache.getKeyPrefix()), signal)
      this.cache.emit({ type: 'refresh', key })
      const data = await waitFor(() => loader({ signal }), signal)
      const negative = options.isNegative ? options.isNegative(data) : data === null || data === undefined
      const negativeTTL = options.negativeTTL ?? this.cache.options.negativeTTL ?? 0
      if ((!negative || negativeTTL > 0) && (options.shouldStore?.(data) ?? true)) {
        const maxTTL = this.cache.resolveMaxTTL(data, options)
        await waitFor(
          () =>
            this.cache.write(
              key,
              data,
              {
                ...options,
                writeToken,
                maxTTL: negative ? Math.min(maxTTL, negativeTTL) : maxTTL,
                ...(negative ? { staleTTL: 0 } : {}),
              },
              { lockKey: lockKey + '-lock', lockValue: lock! },
              signal,
            ),
          signal,
        )
        await waitFor(() => this.cache.backend.flush?.(), signal)
      }
      return { data }
    } catch (error) {
      this.cache.emit({ type: 'error', key, reason: 'refresh', error, durationMs: performance.now() - started })
      throw error
    } finally {
      if (lock !== undefined) {
        // Start cleanup even after cancellation. Do not let an unresponsive backend
        // hold the shared loader promise or overwrite its original source error.
        const releasing = release(lock)
        try {
          await waitFor(() => releasing, signal)
        } catch {
          /* Cancellation already reported. */
        }
      }
    }
  }
}
