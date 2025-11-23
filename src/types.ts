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
    adaptiveCacheFetch(dataKey: string): Promise<[string | null, number]>
    adaptiveCacheUpdate(
      dataKey: string,
      metaKey: string,
      hash: string,
      data: string,
      initialTTL: string,
      maxTTL: string,
      ttlScaling: string,
      metaTTL: string,
    ): Promise<[string | false, number]>
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

export interface AdaptiveCacheOptions {
  initialTTL?: number // Initial TTL for data in seconds
  maxTTL?: number | ((data: any) => number | undefined) // Maximum TTL for data in seconds or function that returns TTL
  ttlScaling?: number // Factor to multiply TTL on unchanged content
  redisPrefix?: string // Prefix for Redis keys
  includeHeaders?: boolean // Whether to include cache status header
  includeDebugHeaders?: boolean // Whether to include metadata headers
  forceRefresh?: boolean // Force refresh the cache but maintain TTL
  lockExpirationSeconds?: number // Lock expiration in seconds for shouldRefreshCache (default 60)
  metaTTL?: number // Fixed TTL for metadata storage (in seconds)
  compress?: boolean // Compress the cached data, default: true
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent' // Logging level
}
