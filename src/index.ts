import {
  AdaptiveCacheBackend,
  AdaptiveCacheBackendName,
  AdaptiveCacheL1RedisOptions,
  AdaptiveCacheLruOptions,
  AdaptiveCacheOptions,
} from './types'
import { AdaptiveCache } from './AdaptiveCache'
import { getDefaultCache, redis } from './singleton'
import { adaptiveExpressCache, clearAdaptiveCache } from './AdaptiveExpressCache'
import { adaptiveFastifyCache } from './AdaptiveFastifyCache'
import { cache } from './utils'

export {
  AdaptiveCacheOptions,
  AdaptiveCacheBackend,
  AdaptiveCacheBackendName,
  AdaptiveCacheL1RedisOptions,
  AdaptiveCacheLruOptions,
  AdaptiveCache,
}
export { getDefaultCache, redis }
export { adaptiveExpressCache, clearAdaptiveCache, adaptiveFastifyCache, cache }

// Util to easily cache functions outside of the controller flow
export const cacheResult = async (key: string, timeInSeconds: number, callback: () => Promise<any>) => {
  const client = getDefaultCache().client
  // try to fetch the data from redis
  let cached = await client.get(key)
  if (cached) {
    // if we get a result parse it and return it
    return JSON.parse(cached)
  }

  // Fetch results from the callback
  const results = await callback()

  if (results === null || typeof results === 'undefined') {
    return null
  }

  await client.set(key, JSON.stringify(results), 'EX', timeInSeconds)

  return results
}

// Module-level configurable defaults
export const setDefaultLockExpirationSeconds = (secs: number) => {
  AdaptiveCache.setDefaultLockExpirationSeconds(secs)
}

export const shouldRefreshCache = async (
  lastUpdateKey: string,
  refreshThreshold: number,
  force = false,
  lockExpirationSeconds?: number,
) => {
  return getDefaultCache().shouldRefresh(lastUpdateKey, refreshThreshold, force, lockExpirationSeconds)
}

export const releaseCacheRefreshLock = async (lastUpdateKey: string, lockValue: string) => {
  return getDefaultCache().releaseLock(lastUpdateKey, lockValue)
}
