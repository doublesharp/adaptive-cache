import { NextFunction, Request, Response } from 'express'
import { AdaptiveCache } from './AdaptiveCache'
import { getDefaultCache } from './singleton'
import { parseDuration, getAdaptiveCacheKey } from './utils'
import { AdaptiveCacheOptions } from './types'

const DEFAULT_MAX_TTL = 60 * 15 // 15 minutes for adaptive cache
const cacheTime = process.env.CACHE_TIME || '5 seconds'

export function cacheSuccess(time: string | number = cacheTime) {
  return adaptiveCache({ initialTTL: parseDuration(time) })
}
export function cache(time: string | number = cacheTime) {
  return adaptiveCache({ initialTTL: parseDuration(time) })
}

// Adaptive caching middleware
export const adaptiveCache = (
  options: AdaptiveCacheOptions & {
    tags?: string[] | ((req: Request) => string[])
  } = {},
) => {
  const {
    redisPrefix = 'adaptive:', // Default prefix
    includeHeaders = true, // Default: include headers
    forceRefresh = false, // Default: use cache if available
    tags,
  } = options

  let { maxTTL = DEFAULT_MAX_TTL } = options // Default: 15 minutes

  const cacheInstance = new AdaptiveCache(options, getDefaultCache().client)

  // If middleware option sets lock expiration, apply it as the module default
  if (typeof options.lockExpirationSeconds === 'number') {
    AdaptiveCache.setDefaultLockExpirationSeconds(options.lockExpirationSeconds)
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    // Check for cache override in query parameter
    const overrideCache = req.query.refresh === 'true' || forceRefresh

    const originalSend = res.send

    try {
      const adaptiveCacheKey = getAdaptiveCacheKey(req.originalUrl.split('?')[0], req.query, redisPrefix)

      // First check if we have data
      const result = await cacheInstance.get(adaptiveCacheKey)

      if (result && result.data && !overrideCache) {
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
          if (typeof maxTTL === 'function') {
            // call function to convert to seconds
            const calculatedTTL = maxTTL(body)
            if (calculatedTTL) {
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

            await cacheInstance.set(adaptiveCacheKey, body, {
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
export const clearAdaptiveCache = async (requestPath: string, querystring: any, redisPrefix = 'adaptive:') => {
  const adaptiveCacheKey = getAdaptiveCacheKey(requestPath, querystring, redisPrefix)
  await getDefaultCache().clear(adaptiveCacheKey)
}
