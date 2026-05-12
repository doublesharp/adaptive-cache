import 'ioredis'

export type RedisStatusEXISTS = 'EXISTS'
export type RedisStatusUPDATING = 'UPDATING'
export type RedisStatusUPDATE = 'UPDATE'

export type RedisStatusUPDATED = 'UPDATED'
export type RedisStatusLOCK_MISMATCH = 'LOCK_MISMATCH'

export type ShouldRefreshCacheEXISTS = [status: RedisStatusEXISTS, ttl: number]
export type ShouldRefreshCacheUPDATING = [status: RedisStatusUPDATING, otherLock: string]
export type ShouldRefreshCacheUPDATE = [status: RedisStatusUPDATE, lockValue: string]

export type UpdateCacheAndReleaseLockUPDATED = [status: RedisStatusUPDATED]
export type UpdateCacheAndReleaseLockLOCK_MISMATCH = [status: RedisStatusLOCK_MISMATCH, otherLock: string]

declare module 'ioredis' {
  interface Redis {
    adaptiveCacheFetch(
      dataKey: string,
    ): Promise<
      [
        data: string | null,
        ttl: number,
        dataTTL?: string | number | false,
        lastChanged?: string | number | false,
        changeCount?: string | number | false,
        hash?: string | false,
      ]
    >
    adaptiveCacheUpdate(
      dataKey: string,
      metaKey: string,
      hash: string,
      data: string,
      initialTTL: string,
      maxTTL: string,
      ttlScaling: string,
      metaTTL: string,
    ): Promise<
      [
        status: string | false,
        dataTTL: number,
        lastChanged?: string | number | false,
        changeCount?: string | number | false,
        hash?: string | false,
        changed?: number | false,
      ]
    >
    shouldRefreshCache(
      lastUpdateKey: string,
      lockKey: string,
      currentTime: number,
      refreshThreshold: number,
      lockExpiration: number,
      lockValue: string,
      force: number,
    ): Promise<ShouldRefreshCacheEXISTS | ShouldRefreshCacheUPDATING | ShouldRefreshCacheUPDATE>
    releaseCacheRefreshLock(
      lastUpdateKey: string,
      lockKey: string,
      currentTime: number,
      lockValue: string,
    ): Promise<UpdateCacheAndReleaseLockUPDATED | UpdateCacheAndReleaseLockLOCK_MISMATCH>
  }
}

export type AdaptiveCacheBackendName = 'redis' | 'l1-redis' | 'clustered-lru'

export interface AdaptiveCacheMetadata {
  dataTTL?: string | number
  lastChanged?: string | number
  changeCount?: string | number
  hash?: string
  changed?: boolean
}

export interface AdaptiveCacheFetchResult {
  encodedData: string
  ttl: number
  metadata?: AdaptiveCacheMetadata
}

export type AdaptiveCacheUpdateResult = [
  status: string | false,
  dataTTL: number,
  lastChanged?: string | number | false,
  changeCount?: string | number | false,
  hash?: string | false,
  changed?: number | false,
]

export interface AdaptiveCacheBackendSetOptions {
  maxTTL?: number
  tags?: string[]
}

export interface AdaptiveCacheBackendFetchInput {
  key: string
  dataKey: string
  metaKey: string
  redisPrefix: string
  includeDebugHeaders: boolean
}

export interface AdaptiveCacheBackendUpdateInput {
  key: string
  dataKey: string
  metaKey: string
  redisPrefix: string
  encodedData: string
  responseHash: string
  initialTTL: number
  maxTTL: number
  ttlScaling: number
  metaTTL: number
  tags: string[]
}

export interface AdaptiveCacheBackend {
  readonly name: AdaptiveCacheBackendName | 'custom'
  fetch(input: AdaptiveCacheBackendFetchInput): Promise<AdaptiveCacheFetchResult | null>
  update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult>
  clear(key: string, dataKey: string): Promise<void>
  invalidateTags(tags: string[], redisPrefix: string): Promise<string[]>
  shouldRefresh(
    lastUpdateKey: string,
    refreshThreshold: number,
    currentTime: number,
    force: boolean,
    lockExpirationSeconds: number,
    lockValue: string,
  ): Promise<ShouldRefreshCacheEXISTS | ShouldRefreshCacheUPDATING | ShouldRefreshCacheUPDATE>
  releaseLock(
    lastUpdateKey: string,
    currentTime: number,
    lockValue: string,
  ): Promise<UpdateCacheAndReleaseLockUPDATED | UpdateCacheAndReleaseLockLOCK_MISMATCH>
  quit?(): Promise<unknown>
}

export interface AdaptiveCacheLruLocalL1Options {
  enabled?: boolean
  experimental?: boolean
  max?: number
  maxSize?: number
  ttl?: number
  updateAgeOnGet?: boolean
  allowStale?: boolean
  invalidation?: 'broadcast' | 'ttl-only'
  methods?: {
    get?: boolean
    has?: boolean
    fetch?: boolean
    memoize?: boolean
  }
}

export interface AdaptiveCacheLruOptions {
  namespace?: string
  maxSizeBytes?: number
  maxEntrySizeBytes?: number
  timeout?: number
  failsafe?: 'resolve' | 'reject'
  localL1?: boolean | AdaptiveCacheLruLocalL1Options
}

export interface AdaptiveCacheOptions {
  initialTTL?: number // Initial TTL for data in seconds
  maxTTL?: number | ((data: any) => number | undefined) // Maximum TTL for data in seconds or function that returns TTL
  ttlScaling?: number // Factor to multiply TTL on unchanged content
  redisPrefix?: string // Prefix for Redis keys
  keyPrefix?: string // Alias for redisPrefix that also applies to non-Redis backends
  includeHeaders?: boolean // Whether to include cache status header
  includeDebugHeaders?: boolean // Whether to include metadata headers
  forceRefresh?: boolean // Force refresh the cache but maintain TTL
  lockExpirationSeconds?: number // Lock expiration in seconds for shouldRefreshCache (default 60)
  metaTTL?: number // Fixed TTL for metadata storage (in seconds)
  compress?: boolean // Compress the cached data, default: true
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent' // Logging level
  backend?: AdaptiveCacheBackendName | AdaptiveCacheBackend
  lru?: AdaptiveCacheLruOptions
}
