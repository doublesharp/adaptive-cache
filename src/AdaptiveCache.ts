import Redis from 'ioredis'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { Logger } from './lib/logger'
import { AdaptiveCacheOptions } from './types'

const DEFAULT_MAX_TTL = 60 * 15 // 15 minutes

export class AdaptiveCache {
  public static DEFAULT_LOCK_EXPIRATION_SECONDS = 60

  public static setDefaultLockExpirationSeconds(secs: number) {
    AdaptiveCache.DEFAULT_LOCK_EXPIRATION_SECONDS = secs
  }

  public client: Redis
  public logger: Logger
  private options: AdaptiveCacheOptions

  constructor(options: AdaptiveCacheOptions = {}, client?: Redis) {
    this.options = options
    this.logger = new Logger(options.logLevel || 'info')

    if (client) {
      this.client = client
    } else {
      const redisURL = process.env.REDIS_TLS_URL || process.env.REDIS_URL
      const redisParams = process.env.NODE_ENV === 'production' ? { tls: { rejectUnauthorized: false } } : {}

      this.client = redisURL
        ? new Redis(redisURL, redisParams)
        : new Redis({
            host: process.env.REDIS_HOST || 'localhost',
            port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
          })
    }

    this.defineLuaScripts()

    // Handle Redis connection errors to prevent unhandled error events
    // Only attach if we created the client, or if it's a new client instance
    if (!client) {
      this.client.on('error', (err) => {
        this.logger.error('Redis client error:', err)
      })
    }
  }

  private defineLuaScripts() {
    // We need to handle the path correctly. Assuming this file is in src/
    const luaPath = path.resolve(__dirname, './redis-lua')

    const scripts = {
      adaptiveCacheFetch: { numberOfKeys: 1, file: 'adaptiveCacheFetch.lua' },
      adaptiveCacheUpdate: { numberOfKeys: 2, file: 'adaptiveCacheUpdate.lua' },
      shouldRefreshCache: { numberOfKeys: 2, file: 'shouldRefreshCache.lua' },
      releaseCacheRefreshLock: { numberOfKeys: 2, file: 'releaseCacheRefreshLock.lua' },
    }

    for (const [name, config] of Object.entries(scripts)) {
      if (!(this.client as any)[name]) {
        this.client.defineCommand(name, {
          numberOfKeys: config.numberOfKeys,
          lua: fs.readFileSync(path.join(luaPath, config.file), 'utf8'),
        })
      }
    }
  }

  public async get(key: string) {
    const dataKey = key + 'data'
    const metaKey = key + 'meta'
    const { compress = true, includeDebugHeaders = false } = this.options

    const [cachedData, remainingTTL] = await this.client.adaptiveCacheFetch(dataKey)

    if (!cachedData) {
      return null
    }

    let result: any = {
      ttl: remainingTTL,
      data: null,
    }

    try {
      const rawData = compress ? zlib.gunzipSync(Buffer.from(cachedData, 'base64')).toString('utf-8') : cachedData
      result.data = JSON.parse(rawData)
    } catch (err) {
      this.logger.warn('adaptiveCache failed to fetch data:', err)
      throw err
    }

    if (includeDebugHeaders) {
      const metaData = await this.client.hgetall(metaKey)
      if (Object.keys(metaData).length > 0) {
        result.metadata = {
          dataTTL: metaData.dataTTL,
          lastChanged: metaData.lastChanged,
          changeCount: metaData.changeCount,
        }
      }
    }

    return result
  }

  public async set(key: string, data: any, options: { maxTTL?: number; tags?: string[] } = {}) {
    const dataKey = key + 'data'
    const metaKey = key + 'meta'

    const {
      initialTTL = 5,
      ttlScaling = 2,
      metaTTL = 60 * 60 * 24 * 7,
      compress = true,
      redisPrefix = 'adaptive:',
    } = this.options

    let maxTTL = options.maxTTL || (typeof this.options.maxTTL === 'number' ? this.options.maxTTL : DEFAULT_MAX_TTL)

    // If global maxTTL is a function, the caller should have resolved it,
    // or we can't resolve it here without the data context if it wasn't passed.
    // For standalone set, we assume maxTTL is resolved or we use default.

    const responseData = typeof data === 'string' ? data : JSON.stringify(data)
    const responseHash = crypto.createHash('sha256').update(responseData).digest('hex')

    const cacheData = compress ? zlib.gzipSync(Buffer.from(responseData)).toString('base64') : responseData

    try {
      const result = await this.client.adaptiveCacheUpdate(
        dataKey,
        metaKey,
        responseHash,
        cacheData,
        initialTTL.toString(),
        maxTTL.toString(),
        ttlScaling.toString(),
        metaTTL.toString(),
      )

      if (options.tags && options.tags.length > 0) {
        const pipeline = this.client.pipeline()
        options.tags.forEach((tag) => {
          const tagKey = redisPrefix + 'tag:' + tag
          pipeline.sadd(tagKey, key)
        })
        await pipeline.exec()
      }

      this.logger.debug('redis.adaptiveCache:', metaKey, result)
      return result
    } catch (err) {
      this.logger.error('Cache operation failed:', err)
      throw err
    }
  }

  public async invalidateTags(tags: string[]) {
    const { redisPrefix = 'adaptive:' } = this.options

    for (const tag of tags) {
      const tagKey = redisPrefix + 'tag:' + tag
      const keys = await this.client.smembers(tagKey)

      if (keys.length > 0) {
        const pipeline = this.client.pipeline()
        keys.forEach((key) => {
          const dataKey = key + 'data'
          pipeline.del(dataKey)
        })
        pipeline.del(tagKey)
        await pipeline.exec()
      } else {
        await this.client.del(tagKey)
      }
    }
  }

  public async clear(key: string) {
    const dataKey = key + 'data'
    await this.client.del(dataKey)
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
    const lockExpiration = effectiveLockSeconds * 1000

    const lockKey = lastUpdateKey + '-lock'
    const lockValue = Math.random().toString(36).substring(7)
    this.logger.info('shouldRefreshCache lockValue', lockValue)

    const result = await this.client.shouldRefreshCache(
      lastUpdateKey,
      lockKey,
      currentTime,
      refreshThreshold,
      lockExpiration,
      lockValue,
      force ? 1 : 0,
    )

    return result
  }

  public async releaseLock(lastUpdateKey: string, lockValue: string) {
    const currentTime = Math.floor(Date.now() / 1000)
    const lockKey = lastUpdateKey + '-lock'
    return this.client.releaseCacheRefreshLock(lastUpdateKey, lockKey, currentTime, lockValue)
  }

  public quit() {
    return this.client.quit()
  }
}
