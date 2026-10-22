import { fetchLruMany, lruFetchResult } from './lruRead'
import {
  type LruEnvelope,
  METADATA_SIZE_OVERHEAD_BYTES,
  toFiniteNumber,
  calculateNextMetadata,
  metadataFromEnvelope,
  createEnvelope,
  estimateEnvelopeSize,
} from './lruEnvelope'
import { Logger } from '../lib/logger'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import {
  AdaptiveCacheBackend,
  AdaptiveCacheEvent,
  AdaptiveCacheBackendFetchInput,
  AdaptiveCacheBackendUpdateInput,
  AdaptiveCacheFetchResult,
  AdaptiveCacheLruOptions,
  AdaptiveCacheMetadata,
  AdaptiveCacheUpdateResult,
  ShouldRefreshCacheEXISTS,
  ShouldRefreshCacheUPDATE,
  ShouldRefreshCacheUPDATING,
  UpdateCacheAndReleaseLockLOCK_MISMATCH,
  UpdateCacheAndReleaseLockUPDATED,
} from '../types'

const DEFAULT_LRU_MAX_SIZE_BYTES = 64 * 1024 * 1024

type ClusteredCache = {
  mGet(keys: string[], opts?: { bypassL1?: boolean }): Promise<Map<string, any>>
  get(key: string, opts?: Record<string, unknown>): Promise<any>
  set(key: string, value: any, opts?: { ttl?: number; size?: number; updateL1?: boolean }): Promise<boolean>
  setIfAbsent(key: string, value: any, opts?: { ttl?: number; size?: number }): Promise<boolean>
  delete(key: string): Promise<boolean>
  getRemainingTTL(key: string): Promise<number>
  clear(): Promise<void>
  destroy?(): Promise<boolean>
  healthCheck?(): Promise<void>
  stats?(): Promise<{ evictions: number }>
  localStats?(): unknown
  clearLocal?(): void
  withoutLocal?(): ClusteredCache
}

// Expiry belongs to each member; refreshing one member never renews another.
const liveTagMembers = async (cache: ClusteredCache, key: string) => {
  const value = (await cache.get(key, { bypassL1: true })) as string[] | Record<string, number> | undefined
  const legacyExpiresAt = Array.isArray(value) ? Date.now() + Math.max(0, await cache.getRemainingTTL(key)) : 0
  const now = Date.now()
  const members = Array.isArray(value)
    ? value.map((member) => [member, legacyExpiresAt] as const)
    : Object.entries(value || {})
  return Object.fromEntries(members.filter(([, expiresAt]) => expiresAt > now))
}

const mutationQueues = new Map<string, Promise<unknown>>()

const requireOptional = createRequire(__filename)

export class ClusteredLruAdaptiveCacheBackend implements AdaptiveCacheBackend {
  public static loadModule = () => requireOptional('@0xdoublesharp/lru-cache-clustered')

  public readonly name = 'clustered-lru' as const
  public readonly supportsTtlPolicies = true
  private readonly logger: Logger
  private readonly options: AdaptiveCacheLruOptions
  private readonly maxSizeBytes: number
  private readonly maxEntrySizeBytes: number
  private cachePromise?: Promise<ClusteredCache>
  private cache?: ClusteredCache
  private closed = false
  private listeners = new Set<(event: AdaptiveCacheEvent) => void>()
  private lastEvictions = 0

  public onEvent(listener: (event: AdaptiveCacheEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async reportEvictions(cache: ClusteredCache) {
    if (this.listeners.size === 0 || !cache.stats) return
    const count = (await cache.stats()).evictions
    const delta = Math.max(0, count - this.lastEvictions)
    this.lastEvictions = count
    if (delta)
      for (const listener of this.listeners) {
        try {
          listener({ type: 'eviction', timestamp: Date.now(), backend: this.name, layer: 'lru', count: delta })
        } catch {
          /* observers cannot break cache writes */
        }
      }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const namespace = this.options.namespace || 'adaptive-cache'
    const previous = mutationQueues.get(namespace) || Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    mutationQueues.set(namespace, current)
    void current
      .finally(() => {
        if (mutationQueues.get(namespace) === current) mutationQueues.delete(namespace)
      })
      .catch(() => undefined)
    return current
  }

  private async generation(key: string) {
    const cache = await this.getCache()
    let value = (await cache.get(key, { bypassL1: true })) as string | undefined
    if (!value) {
      await cache.setIfAbsent(key, randomUUID(), { size: 64 })
      value = (await cache.get(key, { bypassL1: true })) as string | undefined
    }
    if (!value) throw new Error('Clustered LRU cannot retain invalidation barrier')
    return value
  }

  public async captureWriteToken(redisPrefix: string) {
    return (
      (await this.generation('__adaptive:legacy-barrier')) +
      ':' +
      (await this.generation(redisPrefix + '__adaptive:barrier'))
    )
  }

  private async advanceBarrier(redisPrefix?: string) {
    const cache = await this.getCache()
    await cache.set(
      redisPrefix === undefined ? '__adaptive:legacy-barrier' : redisPrefix + '__adaptive:barrier',
      randomUUID(),
      { size: 64, updateL1: true },
    )
  }

  public async invalidateNamespace(redisPrefix: string) {
    return this.serialize(async () => {
      await this.advanceBarrier(redisPrefix)
      const cache = await this.getCache()
      await cache.set(redisPrefix + '__adaptive:namespace', randomUUID(), { size: 64, updateL1: true })
    })
  }

  constructor(options: AdaptiveCacheLruOptions | undefined, logger: Logger) {
    this.options = options || {}
    this.logger = logger
    this.maxSizeBytes = this.options.maxSizeBytes || DEFAULT_LRU_MAX_SIZE_BYTES
    this.maxEntrySizeBytes = this.options.maxEntrySizeBytes || Math.floor(this.maxSizeBytes * 0.1)
  }

  public async fetch(
    input: AdaptiveCacheBackendFetchInput,
  ): Promise<(AdaptiveCacheFetchResult & { writeToken?: string; revision?: string; freshUntil?: number }) | null> {
    const cache = await this.getCache()
    const envelope = (await cache.get(input.dataKey)) as LruEnvelope | undefined
    if (!envelope || envelope.expiresAt <= Date.now()) return null
    if (
      envelope.namespaceGeneration &&
      envelope.namespaceGeneration !== (await this.generation(input.redisPrefix + '__adaptive:namespace'))
    )
      return null
    for (const [key, epoch] of Object.entries(envelope.epochs || {})) {
      if (epoch !== (await this.generation(key))) return null
    }
    return lruFetchResult(envelope, input)
  }

  public async fetchMany(inputs: AdaptiveCacheBackendFetchInput[]) {
    return fetchLruMany(await this.getCache(), inputs)
  }

  public async update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult> {
    return this.serialize(async () => {
      // Read epochs before checking the loader's barrier. An invalidation after this
      // check leaves the old envelope unreadable even if its store arrives late.
      const epochKeys = [
        input.redisPrefix + '__adaptive:namespace',
        input.dataKey + ':epoch',
        ...input.tags.map((tag) => input.redisPrefix + '__adaptive:tag-epoch:' + tag),
      ]
      const epochs = Object.fromEntries(
        await Promise.all(epochKeys.map(async (key) => [key, await this.generation(key)])),
      )
      if (input.writeToken && input.writeToken !== (await this.captureWriteToken(input.redisPrefix)))
        return ['INVALIDATED', 0]
      const cache = await this.getCache()
      if (input.lockKey && (await cache.get(input.lockKey, { bypassL1: true })) !== input.lockValue)
        return ['INVALIDATED', 0]
      const previous = (await cache.get(input.metaKey, { bypassL1: true })) as AdaptiveCacheMetadata | undefined
      const next = calculateNextMetadata(
        previous,
        input.responseHash,
        input.initialTTL,
        input.maxTTL,
        input.ttlScaling,
        input.ttlPolicy,
        Date.now(),
        epochs[input.redisPrefix + '__adaptive:namespace'],
      )

      const envelope = createEnvelope(input, {
        ...next,
        namespaceGeneration: epochs[input.redisPrefix + '__adaptive:namespace'],
        hash: input.responseHash,
      })

      envelope.epochs = epochs
      await this.removeTags(input.key, input.dataKey)
      await cache.set(input.metaKey, metadataFromEnvelope(envelope), {
        ttl: input.metaTTL * 1000,
        size: METADATA_SIZE_OVERHEAD_BYTES,
        updateL1: true,
      })
      await this.storeEnvelope(input.dataKey, envelope)
      await this.storeTags(input.redisPrefix, input.key, input.tags, envelope.expiresAt)

      return ['CACHED', next.dataTTL, next.lastChanged, next.changeCount, input.responseHash, next.changed ? 1 : 0]
    })
  }

  public async storeConservative(input: AdaptiveCacheBackendUpdateInput) {
    const envelope = createEnvelope(input, {
      dataTTL: input.initialTTL,
      lastChanged: Math.floor(Date.now() / 1000),
      changeCount: 0,
      hash: input.responseHash,
    })
    envelope.namespaceGeneration = await this.generation(input.redisPrefix + '__adaptive:namespace')
    await this.storeEnvelope(input.dataKey, envelope)
    await this.storeTags(input.redisPrefix, input.key, input.tags, envelope.expiresAt)
  }

  public async hydrateFromFetch(
    input: AdaptiveCacheBackendFetchInput,
    result: AdaptiveCacheFetchResult & { revision?: string; freshUntil?: number },
    writeToken?: string,
  ) {
    const dataTTL = Math.max(0, result.ttl)
    const expiresAt = result.freshUntil ?? Date.now() + dataTTL * 1000
    if (expiresAt <= Date.now()) return
    const metadata = result.metadata || {}
    const envelope: LruEnvelope = {
      encodedData: result.encodedData,
      revision: result.revision,
      writeToken,
      hash: typeof metadata.hash === 'string' ? metadata.hash : '',
      dataTTL: toFiniteNumber(metadata.dataTTL, dataTTL),
      lastChanged: toFiniteNumber(metadata.lastChanged, 0),
      changeCount: toFiniteNumber(metadata.changeCount, 0),
      tags: [],
      prefix: input.redisPrefix,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt,
    }

    await this.storeEnvelope(input.dataKey, envelope)
  }

  public async hydrateFromUpdate(input: AdaptiveCacheBackendUpdateInput, result: AdaptiveCacheUpdateResult) {
    const [, dataTTL, lastChanged, changeCount, hash] = result
    const effectiveTTL = Math.max(1, toFiniteNumber(dataTTL, input.initialTTL))
    const envelope = createEnvelope(input, {
      dataTTL: effectiveTTL,
      lastChanged: toFiniteNumber(lastChanged, Math.floor(Date.now() / 1000)),
      changeCount: toFiniteNumber(changeCount, 0),
      hash: typeof hash === 'string' ? hash : input.responseHash,
    })
    if (result[0] === 'INVALIDATED') return
    envelope.namespaceGeneration = await this.generation(input.redisPrefix + '__adaptive:namespace')
    await this.storeEnvelope(input.dataKey, envelope)
    await this.storeTags(input.redisPrefix, input.key, input.tags, envelope.expiresAt)
  }

  private async removeTags(key: string, dataKey: string) {
    const cache = await this.getCache()
    const old = (await cache.get(dataKey, { bypassL1: true })) as LruEnvelope | undefined
    if (!old) return
    for (const tag of old.tags) {
      const tagKey = this.tagKey(old.prefix, tag)
      const next = await liveTagMembers(cache, tagKey)
      delete next[key]
      if (!Object.keys(next).length) await cache.delete(tagKey)
      else
        await cache.set(tagKey, next, {
          ttl: Math.max(1, await cache.getRemainingTTL(tagKey)),
          size: Buffer.byteLength(JSON.stringify(next)) + METADATA_SIZE_OVERHEAD_BYTES,
          updateL1: true,
        })
    }
  }

  public async clear(key: string, dataKey: string, metaKey: string, redisPrefix?: string) {
    return this.serialize(async () => {
      await this.advanceBarrier(redisPrefix)
      const cache = await this.getCache()
      await cache.set(dataKey + ':epoch', randomUUID(), { size: 64, updateL1: true })
      await this.removeTags(key, dataKey)
      await Promise.all([cache.delete(dataKey), cache.delete(metaKey)])
    })
  }

  public async invalidateTags(tags: string[], redisPrefix: string) {
    return this.serialize(async () => {
      await this.advanceBarrier(redisPrefix)
      const cache = await this.getCache()
      const invalidatedKeys = new Set<string>()
      for (const tag of tags) {
        await cache.set(redisPrefix + '__adaptive:tag-epoch:' + tag, randomUUID(), { size: 64, updateL1: true })
        const tagKey = this.tagKey(redisPrefix, tag)
        const members = await liveTagMembers(cache, tagKey)
        for (const key of Object.keys(members)) {
          const envelope = (await cache.get(key + 'data', { bypassL1: true })) as LruEnvelope | undefined
          // An expired or overwritten entry must not be invalidated by obsolete membership.
          if (envelope && !envelope.tags.includes(tag)) continue
          invalidatedKeys.add(key)
          await this.removeTags(key, key + 'data')
          await Promise.all([cache.delete(key + 'data'), cache.delete(key + 'meta')])
        }
        await cache.delete(tagKey)
      }
      return [...invalidatedKeys]
    })
  }

  public async deleteKeys(keys: string[]) {
    const cache = await this.getCache()
    await Promise.all(keys.flatMap((key) => [cache.delete(key + 'data'), cache.delete(key + 'meta')]))
  }

  public async shouldRefresh(
    lastUpdateKey: string,
    refreshThreshold: number,
    currentTime: number,
    force: boolean,
    lockExpirationSeconds: number,
    lockValue: string,
  ): Promise<ShouldRefreshCacheEXISTS | ShouldRefreshCacheUPDATING | ShouldRefreshCacheUPDATE> {
    const cache = await this.getCache()
    const lockKey = lastUpdateKey + '-lock'

    if (!force) {
      const lastUpdate = toFiniteNumber(await cache.get(lastUpdateKey, { bypassL1: true }), 0)
      if (currentTime - lastUpdate < refreshThreshold) {
        return ['EXISTS', refreshThreshold - (currentTime - lastUpdate)]
      }

      while (
        !(await cache.setIfAbsent(lockKey, lockValue, {
          ttl: lockExpirationSeconds * 1000,
          size: Buffer.byteLength(lockValue),
        }))
      ) {
        const existingLock = (await cache.get(lockKey, { bypassL1: true })) as string | undefined
        if (existingLock) return ['UPDATING', existingLock]
        // The owner released or expired after our claim failed. Try again.
      }
    } else {
      await cache.set(lockKey, lockValue, {
        ttl: lockExpirationSeconds * 1000,
        size: Buffer.byteLength(lockValue),
        updateL1: true,
      })
    }

    return ['UPDATE', lockValue]
  }

  public async releaseLock(
    lastUpdateKey: string,
    currentTime: number,
    lockValue: string,
    recordRefresh = true,
  ): Promise<UpdateCacheAndReleaseLockUPDATED | UpdateCacheAndReleaseLockLOCK_MISMATCH> {
    const cache = await this.getCache()
    const lockKey = lastUpdateKey + '-lock'
    const existingLock = (await cache.get(lockKey, { bypassL1: true })) as string | undefined

    if (!existingLock || existingLock === lockValue) {
      if (recordRefresh) {
        await cache.set(lastUpdateKey, currentTime, {
          ttl: 60 * 60 * 24 * 7 * 1000,
          size: 16,
          updateL1: true,
        })
      }
      await cache.delete(lockKey)
      return ['UPDATED']
    }

    return ['LOCK_MISMATCH', existingLock]
  }

  public async quit(preserveSharedCache = false) {
    this.closed = true
    if (!this.cachePromise) return undefined
    // Initialization may reject or stall after allocating the cache and its subscriptions.
    let cache = this.cache
    if (!cache) cache = await this.cachePromise
    if (preserveSharedCache) {
      cache.clearLocal?.()
      return undefined
    }
    return cache.destroy?.()
  }

  private async getCache() {
    if (this.closed) throw new Error('Clustered LRU backend is closed')
    if (!this.cachePromise) {
      this.cachePromise = this.createCache()
    }
    const cache = await this.cachePromise
    if (this.closed) throw new Error('Clustered LRU backend is closed')
    return cache
  }

  private async createCache(): Promise<ClusteredCache> {
    let mod: any
    try {
      mod = ClusteredLruAdaptiveCacheBackend.loadModule()
    } catch (err) {
      const error = new Error(
        'The clustered LRU backend requires optional peer dependency @0xdoublesharp/lru-cache-clustered and lru-cache.',
      )
      const errorWithCause = error as Error & { cause?: unknown }
      errorWithCause.cause = err
      throw error
    }

    const LRUCacheClustered = mod.LRUCacheClustered || mod.LRUCacheForClustersAsPromised || mod.default
    if (!LRUCacheClustered) {
      throw new Error('Could not find LRUCacheClustered export from @0xdoublesharp/lru-cache-clustered.')
    }

    LRUCacheClustered.bootstrap?.()

    const cache = new LRUCacheClustered({
      namespace: this.options.namespace || 'adaptive-cache',
      maxSize: this.maxSizeBytes,
      maxEntrySize: this.maxEntrySizeBytes,
      timeout: this.options.timeout,
      failsafe: this.options.failsafe || 'reject',
      ...(typeof this.options.localL1 !== 'undefined' ? { localL1: this.options.localL1 } : {}),
    }) as ClusteredCache
    this.cache = cache

    await cache.healthCheck?.()
    return cache
  }

  private async storeEnvelope(
    dataKey: string,
    envelope: LruEnvelope,
    ttlSeconds = (envelope.expiresAt - Date.now()) / 1000,
  ) {
    const size = estimateEnvelopeSize(envelope)
    if (size > this.maxEntrySizeBytes) {
      this.logger.debug('Skipping clustered LRU entry because it exceeds maxEntrySizeBytes:', dataKey, size)
      const cache = await this.getCache()
      await cache.delete(dataKey)
      return false
    }

    const cache = await this.getCache()
    const stored = await cache.set(dataKey, envelope, {
      ttl: Math.max(1, ttlSeconds * 1000),
      size,
      updateL1: true,
    })
    await this.reportEvictions(cache)
    return stored
  }

  private async storeTags(redisPrefix: string, key: string, tags: string[], expiresAt: number) {
    if (tags.length === 0) return

    const cache = await this.getCache()
    await Promise.all(
      tags.map(async (tag) => {
        const tagKey = this.tagKey(redisPrefix, tag)
        const next = { ...(await liveTagMembers(cache, tagKey)), [key]: expiresAt }
        const size = Buffer.byteLength(JSON.stringify(next), 'utf8') + METADATA_SIZE_OVERHEAD_BYTES
        // Oversized indexes may be evicted; epoch fencing still invalidates payloads.
        if (size > this.maxEntrySizeBytes) {
          await cache.delete(tagKey)
          return
        }
        await cache.set(tagKey, next, {
          ttl: Math.max(1, Object.values(next).reduce((maximum, expiry) => Math.max(maximum, expiry), 0) - Date.now()),
          size,
          updateL1: true,
        })
      }),
    )
  }

  private tagKey(redisPrefix: string, tag: string) {
    return redisPrefix + 'tag:' + tag
  }
}
