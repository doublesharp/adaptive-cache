import { AdaptiveCache } from './AdaptiveCache'
import { getDefaultCache } from './singleton'
import { getAdaptiveCacheKey } from './utils'
import { AdaptiveCacheOptions } from './types'

const DEFAULT_MAX_TTL = 60 * 15 // 15 minutes for adaptive cache

type ExpressRequestLike = {
  originalUrl: string
  query: any
  params?: Record<string, string>
}

type ExpressResponseLike = {
  statusCode: number
  send: (body: any) => any
  set: (field: string, value: any) => any
}

type ExpressNextFunctionLike = (err?: unknown) => void

const parseJsonBody = (body: any) => {
  if (typeof body !== 'string') return body

  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

const shouldShareDefaultRedisClient = (options: AdaptiveCacheOptions) =>
  !options.backend || options.backend === 'redis' || options.backend === 'l1-redis'

// Adaptive caching middleware
export const adaptiveExpressCache = (
  options: AdaptiveCacheOptions & {
    tags?: string[] | ((req: ExpressRequestLike) => string[])
  } = {},
) => {
  const {
    redisPrefix = 'adaptive:', // Default prefix
    keyPrefix,
    includeHeaders = true, // Default: include headers
    forceRefresh = false, // Default: use cache if available
    tags,
    ignoreQueryParams,
  } = options
  const cachePrefix = keyPrefix || redisPrefix

  let { maxTTL = DEFAULT_MAX_TTL } = options // Default: 15 minutes

  const cacheInstance = new AdaptiveCache(
    options,
    shouldShareDefaultRedisClient(options) ? getDefaultCache().client : undefined,
  )

  // If middleware option sets lock expiration, apply it as the module default
  if (typeof options.lockExpirationSeconds === 'number') {
    AdaptiveCache.setDefaultLockExpirationSeconds(options.lockExpirationSeconds)
  }

  return async (req: ExpressRequestLike, res: ExpressResponseLike, next: ExpressNextFunctionLike) => {
    // Check for cache override in query parameter
    const overrideCache = req.query.refresh === 'true' || forceRefresh

    const originalSend = res.send

    try {
      const adaptiveCacheKey = getAdaptiveCacheKey(
        req.originalUrl.split('?')[0],
        req.query,
        cachePrefix,
        ignoreQueryParams,
      )

      // First check if we have data
      const result = await cacheInstance.get(adaptiveCacheKey)

      if (result && !overrideCache) {
        try {
          if (includeHeaders) {
            res.set('X-Cache', 'HIT')
            res.set('X-Cache-TTL', result.ttl.toString())
          }

          if (result.metadata) {
            res.set('X-Cache-Data-TTL', result.metadata.dataTTL)
            res.set('X-Cache-Last-Modified', result.metadata.lastChanged || 'unknown')
            res.set('X-Cache-Refreshed', result.metadata.changeCount)
          }

          return res.send(result.data)
        } catch (err) {
          cacheInstance.logger.warn('adaptiveCache failed to fetch data:', err)
          res.set('X-Cache', 'RETRY')
        }
      } else if (includeHeaders) {
        res.set('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
      }

      // Override send to cache the response
      res.send = function (body: any) {
        // Restore original send
        res.send = originalSend

        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let currentMaxTTL = maxTTL
          const bodyForCache = parseJsonBody(body)
          if (typeof maxTTL === 'function') {
            const calculatedTTL = maxTTL(bodyForCache)
            if (typeof calculatedTTL === 'number' && Number.isFinite(calculatedTTL) && calculatedTTL > 0) {
              currentMaxTTL = calculatedTTL
            } else {
              currentMaxTTL = DEFAULT_MAX_TTL
            }
            cacheInstance.logger.debug('Overriding maxTTL:', currentMaxTTL)
          }

          const updateCache = async () => {
            let requestTags: string[] = []
            if (tags) {
              if (Array.isArray(tags)) {
                requestTags = tags
              } else if (typeof tags === 'function') {
                requestTags = tags(req)
              }
            }

            await cacheInstance.set(adaptiveCacheKey, bodyForCache, {
              maxTTL: currentMaxTTL as number,
              tags: requestTags,
            })
          }

          updateCache().catch((err) => cacheInstance.logger.error('Cache update failed:', err))
        }

        return originalSend.call(res, body)
      }

      next()
    } catch (err) {
      cacheInstance.logger.error('adaptiveCache failed:', err)
      res.set('X-Cache', 'RETRY')
      // Continue without caching if Redis fails
      next()
    }
  }
}

// Helper method to manually clear the adaptive cache
export const clearAdaptiveCache = async (
  requestPath: string,
  querystring: any,
  redisPrefix = 'adaptive:',
  options: AdaptiveCacheOptions = {},
) => {
  const cachePrefix = options.keyPrefix || redisPrefix
  const adaptiveCacheKey = getAdaptiveCacheKey(requestPath, querystring, cachePrefix)
  const cache = options.backend
    ? new AdaptiveCache(
        { ...options, redisPrefix: cachePrefix },
        shouldShareDefaultRedisClient(options) ? getDefaultCache().client : undefined,
      )
    : getDefaultCache()

  try {
    await cache.clear(adaptiveCacheKey)
  } finally {
    if (options.backend) {
      await cache.quit()
    }
  }
}
