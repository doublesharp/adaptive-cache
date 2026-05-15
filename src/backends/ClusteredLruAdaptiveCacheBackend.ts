import { Logger } from '../lib/logger'
import { createRequire } from 'node:module'
import {
  AdaptiveCacheBackend,
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
const METADATA_SIZE_OVERHEAD_BYTES = 512

type ClusteredCache = {
  get(key: string, opts?: Record<string, unknown>): Promise<any>
  set(key: string, value: any, opts?: { ttl?: number; size?: number; updateL1?: boolean }): Promise<boolean>
  setIfAbsent(key: string, value: any, opts?: { ttl?: number; size?: number }): Promise<boolean>
  delete(key: string): Promise<boolean>
  getRemainingTTL(key: string): Promise<number>
  clear(): Promise<void>
  destroy?(): Promise<boolean>
  healthCheck?(): Promise<void>
  localStats?(): unknown
  clearLocal?(): void
  withoutLocal?(): ClusteredCache
}

interface LruEnvelope {
  encodedData: string
  hash: string
  dataTTL: number
  lastChanged: number
  changeCount: number
  tags: string[]
  createdAt: number
  updatedAt: number
  expiresAt: number
}

const requireOptional = createRequire(__filename)

const toFiniteNumber = (value: unknown, fallback: number) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

const calculateNextMetadata = (
  previous: LruEnvelope | undefined,
  hash: string,
  initialTTL: number,
  maxTTL: number,
  ttlScaling: number,
) => {
  const isChanged = !previous || previous.hash !== hash
  let dataTTL = previous?.dataTTL || initialTTL
  let lastChanged = previous?.lastChanged || 0
  let changeCount = previous?.changeCount || 0

  if (!isChanged) {
    if (dataTTL >= maxTTL) {
      dataTTL = maxTTL
    } else {
      const decayFactor = 1.0 - Math.min(0.9, changeCount * 0.01)
      const increaseFactor = Math.max(0, ttlScaling - 1)
      const increase = Math.ceil(Math.floor(dataTTL * increaseFactor) * decayFactor)
      dataTTL = Math.max(initialTTL, Math.min(dataTTL + increase, maxTTL))
    }
  } else {
    changeCount += 1
    dataTTL = initialTTL
    lastChanged = Math.floor(Date.now() / 1000)
  }

  return { dataTTL, lastChanged, changeCount, changed: isChanged }
}

export class ClusteredLruAdaptiveCacheBackend implements AdaptiveCacheBackend {
  public static loadModule = () => requireOptional('@0xdoublesharp/lru-cache-clustered')

  public readonly name = 'clustered-lru' as const
  private readonly logger: Logger
  private readonly options: AdaptiveCacheLruOptions
  private readonly maxSizeBytes: number
  private readonly maxEntrySizeBytes: number
  private cachePromise?: Promise<ClusteredCache>

  constructor(options: AdaptiveCacheLruOptions | undefined, logger: Logger) {
    this.options = options || {}
    this.logger = logger
    this.maxSizeBytes = this.options.maxSizeBytes || DEFAULT_LRU_MAX_SIZE_BYTES
    this.maxEntrySizeBytes = this.options.maxEntrySizeBytes || Math.floor(this.maxSizeBytes * 0.1)
  }

  public async fetch(input: AdaptiveCacheBackendFetchInput): Promise<AdaptiveCacheFetchResult | null> {
    const cache = await this.getCache()
    const envelope = (await cache.get(input.dataKey)) as LruEnvelope | undefined
    if (!envelope) return null

    return {
      encodedData: envelope.encodedData,
      ttl: Math.max(0, Math.ceil((envelope.expiresAt - Date.now()) / 1000)),
      metadata: this.metadataFromEnvelope(envelope),
    }
  }

  public async update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult> {
    const cache = await this.getCache()
    const previous = (await cache.get(input.dataKey)) as LruEnvelope | undefined
    const next = calculateNextMetadata(previous, input.responseHash, input.initialTTL, input.maxTTL, input.ttlScaling)

    const envelope = this.createEnvelope(input, {
      dataTTL: next.dataTTL,
      lastChanged: next.lastChanged,
      changeCount: next.changeCount,
      hash: input.responseHash,
    })

    await this.storeEnvelope(input.dataKey, envelope)
    await this.storeTags(input.redisPrefix, input.key, input.tags, input.metaTTL)

    return ['CACHED', next.dataTTL, next.lastChanged, next.changeCount, input.responseHash, next.changed ? 1 : 0]
  }

  public async storeConservative(input: AdaptiveCacheBackendUpdateInput) {
    const envelope = this.createEnvelope(input, {
      dataTTL: input.initialTTL,
      lastChanged: Math.floor(Date.now() / 1000),
      changeCount: 0,
      hash: input.responseHash,
    })
    await this.storeEnvelope(input.dataKey, envelope)
    await this.storeTags(input.redisPrefix, input.key, input.tags, input.metaTTL)
  }

  public async hydrateFromFetch(input: AdaptiveCacheBackendFetchInput, result: AdaptiveCacheFetchResult) {
    const dataTTL = Math.max(1, result.ttl)
    const metadata = result.metadata || {}
    const envelope: LruEnvelope = {
      encodedData: result.encodedData,
      hash: typeof metadata.hash === 'string' ? metadata.hash : '',
      dataTTL: toFiniteNumber(metadata.dataTTL, dataTTL),
      lastChanged: toFiniteNumber(metadata.lastChanged, 0),
      changeCount: toFiniteNumber(metadata.changeCount, 0),
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + dataTTL * 1000,
    }

    await this.storeEnvelope(input.dataKey, envelope, dataTTL)
  }

  public async hydrateFromUpdate(input: AdaptiveCacheBackendUpdateInput, result: AdaptiveCacheUpdateResult) {
    const [, dataTTL, lastChanged, changeCount, hash] = result
    const effectiveTTL = Math.max(1, toFiniteNumber(dataTTL, input.initialTTL))
    const envelope = this.createEnvelope(input, {
      dataTTL: effectiveTTL,
      lastChanged: toFiniteNumber(lastChanged, Math.floor(Date.now() / 1000)),
      changeCount: toFiniteNumber(changeCount, 0),
      hash: typeof hash === 'string' ? hash : input.responseHash,
    })
    await this.storeEnvelope(input.dataKey, envelope, effectiveTTL)
    await this.storeTags(input.redisPrefix, input.key, input.tags, input.metaTTL)
  }

  public async clear(_key: string, dataKey: string, _metaKey: string) {
    const cache = await this.getCache()
    await cache.delete(dataKey)
  }

  public async invalidateTags(tags: string[], redisPrefix: string) {
    const cache = await this.getCache()
    const invalidatedKeys: string[] = []

    for (const tag of tags) {
      const tagKey = this.tagKey(redisPrefix, tag)
      const keys = ((await cache.get(tagKey)) as string[] | undefined) || []
      invalidatedKeys.push(...keys)

      await Promise.all(keys.map((key) => cache.delete(key + 'data')))
      await cache.delete(tagKey)
    }

    return invalidatedKeys
  }

  public async deleteKeys(keys: string[]) {
    const cache = await this.getCache()
    await Promise.all(keys.map((key) => cache.delete(key + 'data')))
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
      const lastUpdate = toFiniteNumber(await cache.get(lastUpdateKey), 0)
      if (currentTime - lastUpdate < refreshThreshold) {
        return ['EXISTS', refreshThreshold - (currentTime - lastUpdate)]
      }

      const existingLock = (await cache.get(lockKey)) as string | undefined
      if (existingLock && existingLock !== lockValue) {
        return ['UPDATING', existingLock]
      }
    }

    await cache.set(lockKey, lockValue, {
      ttl: lockExpirationSeconds * 1000,
      size: Buffer.byteLength(lockValue),
      updateL1: true,
    })

    return ['UPDATE', lockValue]
  }

  public async releaseLock(
    lastUpdateKey: string,
    currentTime: number,
    lockValue: string,
  ): Promise<UpdateCacheAndReleaseLockUPDATED | UpdateCacheAndReleaseLockLOCK_MISMATCH> {
    const cache = await this.getCache()
    const lockKey = lastUpdateKey + '-lock'
    const existingLock = (await cache.get(lockKey)) as string | undefined

    if (!existingLock || existingLock === lockValue) {
      await cache.set(lastUpdateKey, currentTime, {
        ttl: 60 * 60 * 24 * 7 * 1000,
        size: 16,
        updateL1: true,
      })
      await cache.delete(lockKey)
      return ['UPDATED']
    }

    return ['LOCK_MISMATCH', existingLock]
  }

  public async quit() {
    if (!this.cachePromise) return undefined
    const cache = await this.cachePromise
    return cache.destroy?.()
  }

  private async getCache() {
    if (!this.cachePromise) {
      this.cachePromise = this.createCache()
    }
    return this.cachePromise
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

    await cache.healthCheck?.()
    return cache
  }

  private metadataFromEnvelope(envelope: LruEnvelope): AdaptiveCacheMetadata {
    return {
      dataTTL: envelope.dataTTL,
      lastChanged: envelope.lastChanged,
      changeCount: envelope.changeCount,
      hash: envelope.hash,
    }
  }

  private createEnvelope(
    input: AdaptiveCacheBackendUpdateInput,
    metadata: Required<Pick<AdaptiveCacheMetadata, 'dataTTL' | 'lastChanged' | 'changeCount' | 'hash'>>,
  ): LruEnvelope {
    const dataTTL = toFiniteNumber(metadata.dataTTL, input.initialTTL)
    const now = Date.now()

    return {
      encodedData: input.encodedData,
      hash: metadata.hash,
      dataTTL,
      lastChanged: toFiniteNumber(metadata.lastChanged, 0),
      changeCount: toFiniteNumber(metadata.changeCount, 0),
      tags: input.tags,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + dataTTL * 1000,
    }
  }

  private estimateEnvelopeSize(envelope: LruEnvelope) {
    return (
      Buffer.byteLength(envelope.encodedData, 'utf8') +
      Buffer.byteLength(JSON.stringify(envelope.tags), 'utf8') +
      METADATA_SIZE_OVERHEAD_BYTES
    )
  }

  private async storeEnvelope(dataKey: string, envelope: LruEnvelope, ttlSeconds = envelope.dataTTL) {
    const size = this.estimateEnvelopeSize(envelope)
    if (size > this.maxEntrySizeBytes) {
      this.logger.debug('Skipping clustered LRU entry because it exceeds maxEntrySizeBytes:', dataKey, size)
      return false
    }

    const cache = await this.getCache()
    return cache.set(dataKey, envelope, {
      ttl: Math.max(1, ttlSeconds) * 1000,
      size,
      updateL1: true,
    })
  }

  private async storeTags(redisPrefix: string, key: string, tags: string[], metaTTL: number) {
    if (tags.length === 0) return

    const cache = await this.getCache()
    await Promise.all(
      tags.map(async (tag) => {
        const tagKey = this.tagKey(redisPrefix, tag)
        const existing = ((await cache.get(tagKey)) as string[] | undefined) || []
        const next = Array.from(new Set([...existing, key]))
        await cache.set(tagKey, next, {
          ttl: metaTTL * 1000,
          size: Buffer.byteLength(JSON.stringify(next), 'utf8') + METADATA_SIZE_OVERHEAD_BYTES,
          updateL1: true,
        })
      }),
    )
  }

  private tagKey(redisPrefix: string, tag: string) {
    return redisPrefix + 'tag:' + tag
  }
}
