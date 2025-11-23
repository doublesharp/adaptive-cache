import Redis from 'ioredis'
import { AdaptiveCache } from './AdaptiveCache'

// We keep a default instance for backward compatibility and ease of use
let defaultCacheInstance: AdaptiveCache | null = null

export const getDefaultCache = () => {
  if (!defaultCacheInstance) {
    defaultCacheInstance = new AdaptiveCache()
  }
  return defaultCacheInstance
}

// Expose the underlying redis client for backward compatibility
// Note: This will initialize the default cache if accessed
export const redis = new Proxy({} as Redis, {
  get: (_target, prop) => {
    const client = getDefaultCache().client
    const value = (client as any)[prop]
    if (typeof value === 'function') {
      return value.bind(client)
    }
    return value
  },
})
