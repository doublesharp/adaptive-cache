import { encodeHttpResponse, decodeHttpResponse, CachedHttpHeaders } from './httpResponse'
import {
  boundedNegativeTTL,
  buildHttpCacheKey,
  HttpPolicyOptions,
  HttpResponseLike,
  isCacheableHttpBody,
  isRequestCacheable,
  isResponseCacheable,
  snapshotHttpResponse,
} from './httpPolicy'
import { AdaptiveCache } from './AdaptiveCache'
import { getDefaultCache } from './singleton'
import { AdaptiveCacheLoadOptions, AdaptiveCacheOptions } from './types'

export type FastifyRequestLike = {
  method?: string
  url: string
  query: any
  headers?: Record<string, unknown>
  get?: (name: string) => unknown
  header?: (name: string) => unknown
}

export type FastifyReplyLike = HttpResponseLike & {
  header: (name: string, value: any) => FastifyReplyLike
  getHeaders?: () => Record<string, unknown>
  send: (payload?: any) => any
}

type FastifyInstanceLike = {
  addHook: (name: 'onRequest' | 'onSend' | 'onClose', handler: (...args: any[]) => unknown) => unknown
}

export type AdaptiveFastifyCacheOptions = AdaptiveCacheOptions &
  HttpPolicyOptions<FastifyRequestLike> & {
    cache?: AdaptiveCache
    tags?: string[] | ((req: FastifyRequestLike) => string[])
    loader?: (req: FastifyRequestLike) => Promise<unknown>
  }

export type AdaptiveFastifyCachePlugin = ((instance: FastifyInstanceLike) => Promise<void>) & {
  cache: AdaptiveCache
  clear: (req: FastifyRequestLike) => Promise<void>
  flush: () => Promise<void>
  close: () => Promise<void>
}

const shouldShareDefaultRedisClient = (options: AdaptiveCacheOptions) =>
  !options.backend || options.backend === 'redis' || options.backend === 'l1-redis'

const setCachedHeaders = (reply: FastifyReplyLike, headers?: CachedHttpHeaders) => {
  for (const [name, value] of Object.entries(headers || {})) reply.header(name, value)
}

const cachedResponseView = (response: ReturnType<typeof decodeHttpResponse>): HttpResponseLike => ({
  statusCode: response.statusCode || 200,
  getHeader: (name) => response.headers?.[name.toLowerCase()],
})

const captureWriteToken = async (cache: AdaptiveCache): Promise<{ token?: string; writable: boolean }> => {
  if (!cache.supportsWriteFencing()) return { writable: true }
  try {
    return { token: await cache.captureWriteToken(), writable: true }
  } catch (error) {
    cache.logger.warn('adaptiveCache failed to capture write token:', error)
    return { writable: false }
  }
}

const asFastifyPlugin = (plugin: AdaptiveFastifyCachePlugin) =>
  Object.assign(plugin, {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'adaptive-fastify-cache',
    [Symbol.for('plugin-meta')]: { name: 'adaptive-fastify-cache' },
  })

export const adaptiveFastifyCache = (options: AdaptiveFastifyCacheOptions = {}): AdaptiveFastifyCachePlugin => {
  const {
    redisPrefix = 'adaptive:',
    keyPrefix,
    includeHeaders = true,
    forceRefresh = false,
    tags,
    ignoreQueryParams,
    loader,
  } = options
  const cachePrefix = keyPrefix || redisPrefix
  const owned = !options.cache
  const cacheInstance =
    options.cache ||
    new AdaptiveCache(options, shouldShareDefaultRedisClient(options) ? getDefaultCache().client : undefined)
  const requestCacheKey = (req: FastifyRequestLike) =>
    buildHttpCacheKey({
      req,
      requestPath: req.url.split('?')[0],
      query: req.query,
      cachePrefix,
      ignoreQueryParams,
      key: options.key,
      varyBy: options.varyBy,
    })
  const pendingWrites = new Set<Promise<unknown>>()
  const cacheHits = new WeakSet<FastifyRequestLike>()
  const bypassed = new WeakSet<FastifyRequestLike>()
  const loaderResponses = new WeakSet<FastifyRequestLike>()
  const cacheKeys = new WeakMap<FastifyRequestLike, string>()
  const writeTokens = new WeakMap<FastifyRequestLike, string>()
  let closed = false

  if (typeof options.lockExpirationSeconds === 'number') {
    AdaptiveCache.setDefaultLockExpirationSeconds(options.lockExpirationSeconds)
  }

  const trackWrite = (promise: Promise<unknown>) => {
    pendingWrites.add(promise)
    const forget = () => pendingWrites.delete(promise)
    void promise.then(forget, forget)
    return promise
  }

  const clear = async (req: FastifyRequestLike): Promise<void> => {
    if (owned && closed) throw new Error('HTTP cache adapter is closed')
    const key = requestCacheKey(req)
    if (!key) throw new TypeError('Custom cache key must be a non-empty string')
    await cacheInstance.clear(key)
  }

  const flush = async () => {
    await Promise.allSettled([...pendingWrites])
    await cacheInstance.flush()
  }

  const close = async () => {
    if (!owned || closed) return
    closed = true
    await Promise.allSettled([...pendingWrites])
    await cacheInstance.close()
  }

  const responseCacheable = (req: FastifyRequestLike, response: HttpResponseLike) => {
    try {
      return isResponseCacheable(req, response, options)
    } catch (error) {
      cacheInstance.logger.warn('adaptiveCache response policy failed:', error)
      return false
    }
  }

  const serveBypass = async (
    req: FastifyRequestLike,
    reply: FastifyReplyLike,
    diagnostic: 'BYPASS' | 'RETRY' = 'BYPASS',
  ) => {
    bypassed.add(req)
    if (includeHeaders || diagnostic === 'RETRY') reply.header('X-Cache', diagnostic)
    if (loader) {
      loaderResponses.add(req)
      return reply.send(await loader(req))
    }
  }

  const plugin = async (instance: FastifyInstanceLike) => {
    instance.addHook('onRequest', async (req: FastifyRequestLike, reply: FastifyReplyLike) => {
      if (req.method && req.method.toUpperCase() !== 'GET') return
      if (owned && closed) return serveBypass(req, reply)

      let requestEligible: boolean
      try {
        requestEligible = isRequestCacheable(req, options)
      } catch (error) {
        cacheInstance.logger.warn('adaptiveCache request policy failed:', error)
        return serveBypass(req, reply, 'RETRY')
      }

      if (!requestEligible) {
        return serveBypass(req, reply)
      }

      const overrideCache = req.query?.refresh === 'true' || forceRefresh

      try {
        const adaptiveCacheKey = requestCacheKey(req)
        if (!adaptiveCacheKey) return serveBypass(req, reply)
        cacheKeys.set(req, adaptiveCacheKey)

        if (loader) {
          loaderResponses.add(req)
          let existing = overrideCache ? null : await cacheInstance.get(adaptiveCacheKey, { allowStale: true })
          if (existing) {
            const cached = decodeHttpResponse(existing.data)
            if (!responseCacheable(req, cachedResponseView(cached))) {
              await cacheInstance.clear(adaptiveCacheKey)
              existing = null
            } else if (!existing.stale) {
              if (includeHeaders) {
                reply.header('X-Cache', 'HIT')
                reply.header('X-Cache-TTL', existing.ttl.toString())
              }
              if (cached.statusCode) reply.statusCode = cached.statusCode
              setCachedHeaders(reply, cached.headers)
              return reply.send(cached.body)
            }
          }

          if (includeHeaders) reply.header('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
          let loadedThisRequest = false
          let loaderStoreAllowed = true
          let loaderBodyCacheable = true
          const loaderResponse = snapshotHttpResponse(reply)
          const loadOptions: AdaptiveCacheLoadOptions<unknown> = {
            maxTTL: (data) => {
              const response = decodeHttpResponse(data)
              const value = cacheInstance.resolveMaxTTL(response.body, { maxTTL: options.maxTTL })
              return response.statusCode === 404 ? boundedNegativeTTL(options.negativeTTL, value) : value
            },
            tags: Array.isArray(tags) ? tags : typeof tags === 'function' ? tags(req) : [],
            staleWhileRevalidate: options.staleWhileRevalidate,
            staleIfError: options.staleIfError,
            negativeTTL: options.negativeTTL,
            isNegative: (data) => decodeHttpResponse(data).statusCode === 404,
            forceRefresh: overrideCache,
            lockWaitTimeoutMs: options.lockWaitTimeoutMs,
            shouldStore: (data: unknown) =>
              loaderBodyCacheable &&
              loaderStoreAllowed &&
              responseCacheable(req, cachedResponseView(decodeHttpResponse(data))),
          }
          const value = await cacheInstance.getOrSet(
            adaptiveCacheKey,
            async () => {
              const body = await loader(req)
              loadedThisRequest = true
              loaderBodyCacheable = isCacheableHttpBody(body)
              loaderStoreAllowed = responseCacheable(req, loaderResponse)
              return encodeHttpResponse(
                body,
                loaderResponse.statusCode,
                loaderResponse.getHeader('content-type'),
                loaderResponse.headers,
              )
            },
            loadOptions,
          )
          const response = decodeHttpResponse(value)
          if (!responseCacheable(req, cachedResponseView(response)) && !loadedThisRequest) {
            await cacheInstance.clear(adaptiveCacheKey)
            return reply.send(await loader(req))
          }
          if (response.statusCode) reply.statusCode = response.statusCode
          setCachedHeaders(reply, response.headers)
          return reply.send(response.body)
        }

        const result = await cacheInstance.get(adaptiveCacheKey)
        if (result && !overrideCache) {
          const response = decodeHttpResponse(result.data)
          if (responseCacheable(req, cachedResponseView(response))) {
            if (includeHeaders) {
              reply.header('X-Cache', 'HIT')
              reply.header('X-Cache-TTL', result.ttl.toString())
            }
            if (result.metadata) {
              reply.header('X-Cache-Data-TTL', result.metadata.dataTTL)
              reply.header('X-Cache-Last-Modified', result.metadata.lastChanged || 'unknown')
              reply.header('X-Cache-Refreshed', result.metadata.changeCount)
            }
            if (response.statusCode) reply.statusCode = response.statusCode
            setCachedHeaders(reply, response.headers)
            cacheHits.add(req)
            return reply.send(response.body)
          }
        }

        if (includeHeaders) reply.header('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
        const writeFence = await captureWriteToken(cacheInstance)
        if (!writeFence.writable) {
          bypassed.add(req)
          return
        }
        if (writeFence.token !== undefined) writeTokens.set(req, writeFence.token)
      } catch (error) {
        cacheInstance.logger.warn('adaptiveCache failed to fetch data:', error)
        reply.header('X-Cache', 'RETRY')
        bypassed.add(req)
        if (loader) throw error
      }
    })

    instance.addHook('onSend', async (req: FastifyRequestLike, reply: FastifyReplyLike, payload: any) => {
      if (req.method && req.method.toUpperCase() !== 'GET') return
      if (cacheHits.has(req) || bypassed.has(req) || loaderResponses.has(req)) return
      if (payload !== null && typeof payload !== 'string' && !Buffer.isBuffer(payload)) return
      const adaptiveCacheKey = cacheKeys.get(req)
      if (!adaptiveCacheKey || !responseCacheable(req, reply)) return

      const response = encodeHttpResponse(
        payload,
        reply.statusCode,
        reply.getHeader?.('content-type'),
        reply.getHeaders?.(),
      )
      const update = async () => {
        let body = payload
        if (typeof payload === 'string') {
          try {
            body = JSON.parse(payload)
          } catch {
            // Plain text stays plain text for dynamic TTL callbacks.
          }
        }
        let currentMaxTTL = cacheInstance.resolveMaxTTL(body, { maxTTL: options.maxTTL })
        if (typeof options.maxTTL === 'function') cacheInstance.logger.debug('Overriding maxTTL:', currentMaxTTL)
        if (reply.statusCode === 404) {
          currentMaxTTL = boundedNegativeTTL(options.negativeTTL, currentMaxTTL) as number
        }
        const requestTags = Array.isArray(tags) ? tags : typeof tags === 'function' ? tags(req) : []
        await cacheInstance.set(adaptiveCacheKey, response, {
          maxTTL: currentMaxTTL,
          tags: requestTags,
          writeToken: writeTokens.get(req),
        })
      }
      trackWrite(update().catch((error) => cacheInstance.logger.error('Cache update failed:', error)))
    })

    instance.addHook('onClose', close)
  }

  return asFastifyPlugin(Object.assign(plugin, { cache: cacheInstance, clear, flush, close }))
}
