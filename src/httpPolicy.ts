import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { ReadableStream as WebReadableStream } from 'node:stream/web'
import { getAdaptiveCacheKey } from './utils'

export type HttpRequestLike = {
  method?: string
  headers?: Record<string, unknown>
  get?: (name: string) => unknown
  header?: (name: string) => unknown
}

export type HttpResponseLike = {
  statusCode: number
  getHeader?: (name: string) => unknown
  getHeaders?: () => Record<string, unknown>
}

export const snapshotHttpResponse = (response: HttpResponseLike) => {
  const headers = Object.entries(response.getHeaders?.() || {}).reduce<Record<string, unknown>>(
    (normalized, [name, value]) => {
      normalized[normalizeHeaderName(name)] = Array.isArray(value) ? [...value] : value
      return normalized
    },
    Object.create(null),
  )
  return {
    statusCode: response.statusCode,
    headers,
    getHeader: (name: string) => headers[normalizeHeaderName(name)],
  }
}

export const normalizeHttpBody = (body: unknown): any =>
  ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : body

export const isCacheableHttpBody = (body: unknown): boolean => {
  if (body instanceof Readable || body instanceof WebReadableStream) return false
  if (body === null || body === undefined || typeof body === 'string' || typeof body === 'boolean') return true
  if (typeof body === 'number') return Number.isFinite(body)
  if (ArrayBuffer.isView(body)) return true
  if (Array.isArray(body)) return body.every(isCacheableHttpBody)
  if (typeof body !== 'object' || Object.getPrototypeOf(body) !== Object.prototype) return false
  return Object.values(body).every(isCacheableHttpBody)
}

export type HttpPolicyOptions<Req extends HttpRequestLike = HttpRequestLike> = {
  key?: (req: Req) => string
  varyBy?: string[] | ((req: Req) => unknown)
  shouldCache?: (req: Req, response?: HttpResponseLike) => boolean
  cacheAuthenticated?: boolean
  cacheCookies?: boolean
  negativeTTL?: number
}

const normalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (!value || typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) return value.toString('base64')

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((normalized, key) => {
      normalized[key] = normalizeValue((value as Record<string, unknown>)[key])
      return normalized
    }, Object.create(null))
}

const digest = (value: unknown) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeValue(value)) ?? 'undefined')
    .digest('hex')

export const normalizeHeaderName = (name: string) => name.trim().toLowerCase()

export const getRequestHeader = (req: HttpRequestLike, name: string): unknown => {
  const normalized = normalizeHeaderName(name)
  const fromHeaders = req.headers?.[normalized]
  if (fromHeaders !== undefined) return fromHeaders
  return req.get?.(normalized) ?? req.header?.(normalized)
}

export const getResponseHeader = (response: HttpResponseLike, name: string): unknown =>
  response.getHeader?.(normalizeHeaderName(name))

export const getDeclaredVaryHeaders = (varyBy: unknown) =>
  Array.isArray(varyBy) ? [...new Set(varyBy.map(normalizeHeaderName).filter(Boolean))].sort() : []

const hasCallerOwnedIsolation = <Req extends HttpRequestLike>(
  options: HttpPolicyOptions<Req>,
  sensitiveHeader: string,
) => {
  if (typeof options.key === 'function' || typeof options.varyBy === 'function') return true
  return getDeclaredVaryHeaders(options.varyBy).includes(sensitiveHeader)
}

export const isRequestCacheable = <Req extends HttpRequestLike>(req: Req, options: HttpPolicyOptions<Req>) => {
  if (req.method && req.method.toUpperCase() !== 'GET') return false
  if (getRequestHeader(req, 'range') !== undefined || getRequestHeader(req, 'if-range') !== undefined) return false

  const authorization = getRequestHeader(req, 'authorization')
  if (
    authorization !== undefined &&
    (!options.cacheAuthenticated || !hasCallerOwnedIsolation(options, 'authorization'))
  ) {
    return false
  }

  const cookie = getRequestHeader(req, 'cookie')
  if (cookie !== undefined && (!options.cacheCookies || !hasCallerOwnedIsolation(options, 'cookie'))) {
    return false
  }

  return options.shouldCache?.(req) !== false
}

const cacheControlDisallowsStorage = (value: unknown) => {
  const values = Array.isArray(value) ? value : [value]
  return values.some((header) =>
    String(header ?? '')
      .split(',')
      .some((directive) => {
        const name = directive.trim().split('=', 1)[0].toLowerCase()
        return name === 'private' || name === 'no-store'
      }),
  )
}

const parseVary = (value: unknown) => {
  const values = Array.isArray(value) ? value : [value]
  return values
    .flatMap((header) => String(header ?? '').split(','))
    .map(normalizeHeaderName)
    .filter(Boolean)
}

export const boundedNegativeTTL = (negativeTTL: number | undefined, maxTTL: number) => {
  if (typeof negativeTTL !== 'number' || !Number.isFinite(negativeTTL) || negativeTTL <= 0) return undefined
  return Math.min(negativeTTL, maxTTL)
}

export const isResponseCacheable = <Req extends HttpRequestLike>(
  req: Req,
  response: HttpResponseLike,
  options: HttpPolicyOptions<Req>,
) => {
  const negative = response.statusCode === 404 && boundedNegativeTTL(options.negativeTTL, Number.MAX_SAFE_INTEGER)
  if (response.statusCode === 206) return false
  if (!((response.statusCode >= 200 && response.statusCode < 300) || negative)) return false
  if (cacheControlDisallowsStorage(getResponseHeader(response, 'cache-control'))) return false
  if (getResponseHeader(response, 'set-cookie') !== undefined) return false

  const declared = new Set(getDeclaredVaryHeaders(options.varyBy))
  const varied = parseVary(getResponseHeader(response, 'vary'))
  if (varied.includes('*') || varied.some((name) => !declared.has(name))) return false

  return options.shouldCache?.(req, response) !== false
}

export const buildHttpCacheKey = <Req extends HttpRequestLike>(input: {
  req: Req
  requestPath: string
  query: unknown
  cachePrefix: string
  ignoreQueryParams?: string[]
  key?: (req: Req) => string
  varyBy?: string[] | ((req: Req) => unknown)
}) => {
  const customKey = input.key?.(input.req)
  if (input.key && (typeof customKey !== 'string' || customKey.trim().length === 0)) return undefined
  const requestPath = input.key ? `/custom/${digest(String(customKey))}` : input.requestPath
  const base = getAdaptiveCacheKey(
    requestPath,
    input.key ? {} : input.query,
    input.cachePrefix,
    input.ignoreQueryParams,
    input.key
      ? undefined
      : String(getRequestHeader(input.req, 'host') ?? getRequestHeader(input.req, ':authority') ?? ''),
  )

  if (!input.varyBy) return base
  const variation = Array.isArray(input.varyBy)
    ? getDeclaredVaryHeaders(input.varyBy).map((name) => [name, getRequestHeader(input.req, name)])
    : input.varyBy(input.req)
  return `${base}vary:${digest(variation)}:`
}
