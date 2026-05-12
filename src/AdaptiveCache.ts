import Redis from 'ioredis'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { Logger } from './lib/logger'
import { ClusteredLruAdaptiveCacheBackend } from './backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from './backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from './backends/RedisAdaptiveCacheBackend'
import { AdaptiveCacheBackend, AdaptiveCacheOptions } from './types'

const DEFAULT_MAX_TTL = 60 * 15 // 15 minutes

export class AdaptiveCache {
  public static DEFAULT_LOCK_EXPIRATION_SECONDS = 60

  public static setDefaultLockExpirationSeconds(secs: number) {
    AdaptiveCache.DEFAULT_LOCK_EXPIRATION_SECONDS = secs
  }

  public logger: Logger
  private options: AdaptiveCacheOptions
  private backend: AdaptiveCacheBackend
  private redisClient?: Redis

  constructor(options: AdaptiveCacheOptions = {}, client?: Redis) {
    this.options = options
    this.logger = new Logger(options.logLevel || 'info')
    this.backend = this.createBackend(options, client)
  }

  public get client(): Redis {
    if (!this.redisClient) {
      throw new Error('This AdaptiveCache instance is not using a Redis-backed backend.')
    }
    return this.redisClient
  }

  private createBackend(options: AdaptiveCacheOptions, client?: Redis): AdaptiveCacheBackend {
    if (options.backend && typeof options.backend === 'object') {
      this.redisClient = client
      return options.backend
    }

    const backendName = options.backend || 'redis'

    if (backendName === 'clustered-lru') {
      return new ClusteredLruAdaptiveCacheBackend(options.lru, this.logger)
    }

    const ownsClient = !client
    this.redisClient = client || RedisAdaptiveCacheBackend.createClient(this.logger)
    const redisBackend = new RedisAdaptiveCacheBackend(this.redisClient, this.logger, ownsClient)

    if (backendName === 'l1-redis') {
      return new L1RedisAdaptiveCacheBackend(
        redisBackend,
        new ClusteredLruAdaptiveCacheBackend(options.lru, this.logger),
        this.getKeyPrefix(),
        this.logger,
      )
    }

    return redisBackend
  }

  private getKeyPrefix() {
    return this.options.keyPrefix || this.options.redisPrefix || 'adaptive:'
  }

  public async get(key: string) {
    const dataKey = key + 'data'
    const metaKey = key + 'meta'
    const { compress = true, includeDebugHeaders = false } = this.options

    const result = await this.backend.fetch({
      key,
      dataKey,
      metaKey,
      redisPrefix: this.getKeyPrefix(),
      includeDebugHeaders,
    })

    if (!result) {
      return null
    }

    let cacheResult: any = {
      ttl: result.ttl,
      data: null,
    }

    try {
      const rawData = compress
        ? zlib.gunzipSync(Buffer.from(result.encodedData, 'base64')).toString('utf-8')
        : result.encodedData
      cacheResult.data = JSON.parse(rawData)
    } catch (err) {
      this.logger.warn('adaptiveCache failed to fetch data:', err)
      throw err
    }

    if (includeDebugHeaders && result.metadata) {
      cacheResult.metadata = {
        dataTTL: result.metadata.dataTTL,
        lastChanged: result.metadata.lastChanged,
        changeCount: result.metadata.changeCount,
      }
    }

    return cacheResult
  }

  public async set(key: string, data: any, options: { maxTTL?: number; tags?: string[] } = {}) {
    const dataKey = key + 'data'
    const metaKey = key + 'meta'

    const { initialTTL = 5, ttlScaling = 2, metaTTL = 60 * 60 * 24 * 7, compress = true } = this.options

    let maxTTL = options.maxTTL || (typeof this.options.maxTTL === 'number' ? this.options.maxTTL : DEFAULT_MAX_TTL)

    // If global maxTTL is a function, the caller should have resolved it,
    // or we can't resolve it here without the data context if it wasn't passed.
    // For standalone set, we assume maxTTL is resolved or we use default.

    const responseData = typeof data === 'string' ? data : JSON.stringify(data)
    const responseHash = crypto.createHash('sha256').update(responseData).digest('hex')

    const cacheData = compress ? zlib.gzipSync(Buffer.from(responseData)).toString('base64') : responseData

    try {
      const result = await this.backend.update({
        key,
        dataKey,
        metaKey,
        redisPrefix: this.getKeyPrefix(),
        encodedData: cacheData,
        responseHash,
        initialTTL,
        maxTTL,
        ttlScaling,
        metaTTL,
        tags: options.tags || [],
      })

      this.logger.debug('adaptiveCache:', this.backend.name, metaKey, result)
      return result
    } catch (err) {
      this.logger.error('Cache operation failed:', err)
      throw err
    }
  }

  public async invalidateTags(tags: string[]) {
    await this.backend.invalidateTags(tags, this.getKeyPrefix())
  }

  public async clear(key: string) {
    const dataKey = key + 'data'
    await this.backend.clear(key, dataKey)
  }

  public async shouldRefresh(
    lastUpdateKey: string,
    refreshThreshold: number,
    force = false,
    lockExpirationSeconds?: number,
  ) {
    const currentTime = Math.floor(Date.now() / 1000)
    const effectiveLockSeconds =
      typeof lockExpirationSeconds === 'number'
        ? lockExpirationSeconds
        : this.options.lockExpirationSeconds || AdaptiveCache.DEFAULT_LOCK_EXPIRATION_SECONDS
    const lockValue = Math.random().toString(36).substring(7)
    this.logger.info('shouldRefreshCache lockValue', lockValue)

    const result = await this.backend.shouldRefresh(
      lastUpdateKey,
      refreshThreshold,
      currentTime,
      force,
      effectiveLockSeconds,
      lockValue,
    )

    return result
  }

  public async releaseLock(lastUpdateKey: string, lockValue: string) {
    const currentTime = Math.floor(Date.now() / 1000)
    return this.backend.releaseLock(lastUpdateKey, currentTime, lockValue)
  }

  public quit() {
    return this.backend.quit?.()
  }
}
