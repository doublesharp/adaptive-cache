import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import { AdaptiveCache } from './AdaptiveCache'
import { getDefaultCache } from './singleton'
import { getAdaptiveCacheKey } from './utils'
import { AdaptiveCacheOptions } from './types'

const DEFAULT_MAX_TTL = 60 * 15 // 15 minutes

const shouldShareDefaultRedisClient = (options: AdaptiveCacheOptions) =>
  !options.backend || options.backend === 'redis' || options.backend === 'l1-redis'

export const adaptiveFastifyCache = (
  options: AdaptiveCacheOptions & { tags?: string[] | ((req: FastifyRequest) => string[]) } = {},
) => {
  const { redisPrefix = 'adaptive:', keyPrefix, includeHeaders = true, forceRefresh = false, tags } = options
  const cachePrefix = keyPrefix || redisPrefix

  let { maxTTL = DEFAULT_MAX_TTL } = options

  const cacheInstance = new AdaptiveCache(
    options,
    shouldShareDefaultRedisClient(options) ? getDefaultCache().client : undefined,
  )

  if (typeof options.lockExpirationSeconds === 'number') {
    AdaptiveCache.setDefaultLockExpirationSeconds(options.lockExpirationSeconds)
  }

  const plugin = async (instance: FastifyInstance) => {
    instance.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const overrideCache = (req.query as any).refresh === 'true' || forceRefresh

      try {
        const urlPath = req.url.split('?')[0]
        const adaptiveCacheKey = getAdaptiveCacheKey(urlPath, req.query, cachePrefix)

        const result = await cacheInstance.get(adaptiveCacheKey)

        if (result && result.data && !overrideCache) {
          if (includeHeaders) {
            reply.header('X-Cache', 'HIT')
            reply.header('X-Cache-TTL', result.ttl.toString())
          }
          if (result.metadata) {
            reply.header('X-Cache-Data-TTL', result.metadata.dataTTL)
            reply.header('X-Cache-Last-Modified', result.metadata.lastChanged || 'unknown')
            reply.header('X-Cache-Refreshed', result.metadata.changeCount)
          }

          return reply.send(result.data)
        } else if (includeHeaders) {
          reply.header('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
        }
      } catch (err) {
        cacheInstance.logger.warn('adaptiveCache failed to fetch data:', err)
        reply.header('X-Cache', 'RETRY')
      }
    })

    instance.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: any) => {
      if (reply.statusCode >= 200 && reply.statusCode < 300) {
        const cacheHeader = reply.getHeader('X-Cache')
        if (cacheHeader === 'HIT') return

        const urlPath = req.url.split('?')[0]
        const adaptiveCacheKey = getAdaptiveCacheKey(urlPath, req.query, cachePrefix)

        let currentMaxTTL = maxTTL
        let body = payload

        // Try to parse JSON if maxTTL is a function
        if (typeof payload === 'string' && typeof maxTTL === 'function') {
          try {
            body = JSON.parse(payload)
          } catch {
            // ignore
          }
        }

        if (typeof maxTTL === 'function') {
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

          await cacheInstance.set(adaptiveCacheKey, payload, {
            maxTTL: currentMaxTTL as number,
            tags: requestTags,
          })
        }

        updateCache().catch((err) => {
          cacheInstance.logger.error('Cache update failed:', err)
        })
      }
    })
  }

  return fp(plugin, {
    name: 'adaptive-fastify-cache',
  })
}
