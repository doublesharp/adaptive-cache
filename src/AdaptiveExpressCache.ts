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
import { getAdaptiveCacheKey } from './utils'
import { AdaptiveCacheLoadOptions, AdaptiveCacheOptions } from './types'

export type ExpressRequestLike = {
  method?: string
  originalUrl: string
  query: any
  params?: Record<string, string>
  headers?: Record<string, unknown>
  get?: (name: string) => unknown
  header?: (name: string) => unknown
}

export type ExpressResponseLike = HttpResponseLike & {
  getHeaders?: () => Record<string, unknown>
  send: (body: any) => any
  set: (field: string, value: any) => any
}

type ExpressNextFunctionLike = (err?: unknown) => void

export type AdaptiveExpressCacheOptions = AdaptiveCacheOptions &
  HttpPolicyOptions<ExpressRequestLike> & {
    cache?: AdaptiveCache
    tags?: string[] | ((req: ExpressRequestLike) => string[])
    loader?: (req: ExpressRequestLike) => Promise<unknown>
  }

export type AdaptiveExpressCacheMiddleware = ((
  req: ExpressRequestLike,
  res: ExpressResponseLike,
  next: ExpressNextFunctionLike,
) => Promise<unknown>) & {
  cache: AdaptiveCache
  clear: (req: ExpressRequestLike) => Promise<void>
  flush: () => Promise<void>
  close: () => Promise<void>
}

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

const setCachedHeaders = (res: ExpressResponseLike, headers?: CachedHttpHeaders) => {
  for (const [name, value] of Object.entries(headers || {})) res.set(name, value)
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

export const adaptiveExpressCache = (options: AdaptiveExpressCacheOptions = {}): AdaptiveExpressCacheMiddleware => {
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
  const requestCacheKey = (req: ExpressRequestLike) =>
    buildHttpCacheKey({
      req,
      requestPath: req.originalUrl.split('?')[0],
      query: req.query,
      cachePrefix,
      ignoreQueryParams,
      key: options.key,
      varyBy: options.varyBy,
    })
  const pendingWrites = new Set<Promise<unknown>>()
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

  const clear = async (req: ExpressRequestLike): Promise<void> => {
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

  const responseCacheable = (req: ExpressRequestLike, response: HttpResponseLike) => {
    try {
      return isResponseCacheable(req, response, options)
    } catch (error) {
      cacheInstance.logger.error('adaptiveCache response policy failed:', error)
      return false
    }
  }

  const serveBypass = async (
    req: ExpressRequestLike,
    res: ExpressResponseLike,
    next: ExpressNextFunctionLike,
    diagnostic: 'BYPASS' | 'RETRY' = 'BYPASS',
  ) => {
    if (includeHeaders || diagnostic === 'RETRY') res.set('X-Cache', diagnostic)
    if (!loader) return next()
    try {
      return res.send(await loader(req))
    } catch (error) {
      return next(error)
    }
  }

  const middleware = async (req: ExpressRequestLike, res: ExpressResponseLike, next: ExpressNextFunctionLike) => {
    if (req.method && req.method.toUpperCase() !== 'GET') return next()
    if (owned && closed) return serveBypass(req, res, next)

    let requestEligible: boolean
    try {
      requestEligible = isRequestCacheable(req, options)
    } catch (error) {
      cacheInstance.logger.error('adaptiveCache request policy failed:', error)
      return serveBypass(req, res, next, 'RETRY')
    }
    if (!requestEligible) {
      return serveBypass(req, res, next)
    }

    const overrideCache = req.query?.refresh === 'true' || forceRefresh
    const originalSend = res.send

    try {
      const adaptiveCacheKey = requestCacheKey(req)
      if (!adaptiveCacheKey) return serveBypass(req, res, next)

      if (loader) {
        let existing = overrideCache ? null : await cacheInstance.get(adaptiveCacheKey, { allowStale: true })
        if (existing) {
          const cached = decodeHttpResponse(existing.data)
          if (!responseCacheable(req, cachedResponseView(cached))) {
            await cacheInstance.clear(adaptiveCacheKey)
            existing = null
          } else if (!existing.stale) {
            if (includeHeaders) {
              res.set('X-Cache', 'HIT')
              res.set('X-Cache-TTL', existing.ttl.toString())
            }
            if (cached.statusCode) res.statusCode = cached.statusCode
            setCachedHeaders(res, cached.headers)
            return res.send(cached.body)
          }
        }

        if (includeHeaders) res.set('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
        let loadedThisRequest = false
        let loaderStoreAllowed = true
        let loaderBodyCacheable = true
        const loaderResponse = snapshotHttpResponse(res)
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
          return res.send(await loader(req))
        }
        if (response.statusCode) res.statusCode = response.statusCode
        setCachedHeaders(res, response.headers)
        return res.send(response.body)
      }

      const result = await cacheInstance.get(adaptiveCacheKey)
      let hitFailed = false
      if (result && !overrideCache) {
        try {
          const response = decodeHttpResponse(result.data)
          if (responseCacheable(req, cachedResponseView(response))) {
            if (includeHeaders) {
              res.set('X-Cache', 'HIT')
              res.set('X-Cache-TTL', result.ttl.toString())
            }
            if (result.metadata) {
              res.set('X-Cache-Data-TTL', result.metadata.dataTTL)
              res.set('X-Cache-Last-Modified', result.metadata.lastChanged || 'unknown')
              res.set('X-Cache-Refreshed', result.metadata.changeCount)
            }
            if (response.statusCode) res.statusCode = response.statusCode
            setCachedHeaders(res, response.headers)
            return res.send(response.body)
          }
        } catch (error) {
          cacheInstance.logger.warn('adaptiveCache failed to fetch data:', error)
          res.set('X-Cache', 'RETRY')
          hitFailed = true
        }
      }

      if (includeHeaders && !hitFailed) res.set('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
      const writeFence = await captureWriteToken(cacheInstance)
      if (!writeFence.writable) return next()

      res.send = function (body: any) {
        res.send = originalSend
        const originalContentEncoding = res.getHeader?.('content-encoding')
        const sent = originalSend.call(res, body)
        if (!responseCacheable(req, res)) return sent

        const responseHeaders = { ...res.getHeaders?.() }
        for (const name of Object.keys(responseHeaders)) {
          if (name.toLowerCase() === 'content-encoding') delete responseHeaders[name]
        }
        if (originalContentEncoding !== undefined) responseHeaders['content-encoding'] = originalContentEncoding
        const response = encodeHttpResponse(body, res.statusCode, res.getHeader?.('content-type'), responseHeaders)
        const update = async () => {
          let currentMaxTTL = cacheInstance.resolveMaxTTL(parseJsonBody(body), { maxTTL: options.maxTTL })
          if (typeof options.maxTTL === 'function') cacheInstance.logger.debug('Overriding maxTTL:', currentMaxTTL)
          if (res.statusCode === 404) {
            currentMaxTTL = boundedNegativeTTL(options.negativeTTL, currentMaxTTL) as number
          }
          const requestTags = Array.isArray(tags) ? tags : typeof tags === 'function' ? tags(req) : []
          await cacheInstance.set(adaptiveCacheKey, response, {
            maxTTL: currentMaxTTL,
            tags: requestTags,
            writeToken: writeFence.token,
          })
        }
        trackWrite(update().catch((error) => cacheInstance.logger.error('Cache update failed:', error)))
        return sent
      }

      return next()
    } catch (error) {
      cacheInstance.logger.error('adaptiveCache failed:', error)
      res.set('X-Cache', 'RETRY')
      return next(loader ? error : undefined)
    }
  }

  return Object.assign(middleware, { cache: cacheInstance, clear, flush, close })
}

export const clearAdaptiveCache = async (
  requestPath: string,
  querystring: any,
  redisPrefix = 'adaptive:',
  options: AdaptiveCacheOptions = {},
) => {
  const cachePrefix = options.keyPrefix || redisPrefix
  const adaptiveCacheKey = getAdaptiveCacheKey(requestPath, querystring, cachePrefix, options.ignoreQueryParams)
  const needsScopedWrapper = Boolean(options.backend) || cachePrefix !== 'adaptive:'
  const cache = needsScopedWrapper
    ? new AdaptiveCache(
        {
          ...options,
          keyPrefix: cachePrefix,
          redisPrefix: cachePrefix,
          lru: { ...options.lru, localL1: false },
        },
        shouldShareDefaultRedisClient(options) ? getDefaultCache().client : undefined,
      )
    : getDefaultCache()

  try {
    await cache.clear(adaptiveCacheKey)
  } finally {
    if (typeof options.backend === 'string' || (!options.backend && needsScopedWrapper)) await cache.quit(true)
  }
}
