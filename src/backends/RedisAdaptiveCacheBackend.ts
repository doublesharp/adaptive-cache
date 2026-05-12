import Redis from 'ioredis'
import fs from 'node:fs'
import path from 'node:path'
import { Logger } from '../lib/logger'
import {
  AdaptiveCacheBackend,
  AdaptiveCacheBackendFetchInput,
  AdaptiveCacheBackendUpdateInput,
  AdaptiveCacheFetchResult,
  AdaptiveCacheMetadata,
  AdaptiveCacheUpdateResult,
} from '../types'

const asMetadataValue = (value: string | number | false | null | undefined) => {
  if (value === false || value === null || typeof value === 'undefined') return undefined
  return value
}

const metadataFromTuple = (
  dataTTL?: string | number | false | null,
  lastChanged?: string | number | false | null,
  changeCount?: string | number | false | null,
  hash?: string | false | null,
): AdaptiveCacheMetadata | undefined => {
  const metadata: AdaptiveCacheMetadata = {}
  const normalizedDataTTL = asMetadataValue(dataTTL)
  const normalizedLastChanged = asMetadataValue(lastChanged)
  const normalizedChangeCount = asMetadataValue(changeCount)
  const normalizedHash = asMetadataValue(hash)

  if (typeof normalizedDataTTL !== 'undefined') metadata.dataTTL = normalizedDataTTL
  if (typeof normalizedLastChanged !== 'undefined') metadata.lastChanged = normalizedLastChanged
  if (typeof normalizedChangeCount !== 'undefined') metadata.changeCount = normalizedChangeCount
  if (typeof normalizedHash === 'string') metadata.hash = normalizedHash

  return Object.keys(metadata).length > 0 ? metadata : undefined
}

export class RedisAdaptiveCacheBackend implements AdaptiveCacheBackend {
  public readonly name = 'redis' as const
  public readonly client: Redis
  private readonly logger: Logger
  private readonly ownsClient: boolean

  constructor(client: Redis, logger: Logger, ownsClient = false) {
    this.client = client
    this.logger = logger
    this.ownsClient = ownsClient
    this.defineLuaScripts()
  }

  public static createClient(logger: Logger) {
    const redisURL = process.env.REDIS_TLS_URL || process.env.REDIS_URL
    const redisParams = process.env.NODE_ENV === 'production' ? { tls: { rejectUnauthorized: false } } : {}

    const client = redisURL
      ? new Redis(redisURL, redisParams)
      : new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
        })

    client.on('error', (err) => {
      logger.error('Redis client error:', err)
    })

    return client
  }

  private defineLuaScripts() {
    const luaPathCandidates = [path.resolve(__dirname, './redis-lua'), path.resolve(__dirname, '../redis-lua')]
    const luaPath = luaPathCandidates.find((candidate) => fs.existsSync(candidate)) || luaPathCandidates[0]

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

  public async fetch(input: AdaptiveCacheBackendFetchInput): Promise<AdaptiveCacheFetchResult | null> {
    const [cachedData, remainingTTL, dataTTL, lastChanged, changeCount, hash] = await this.client.adaptiveCacheFetch(
      input.dataKey,
    )

    if (!cachedData) {
      return null
    }

    let metadata = metadataFromTuple(dataTTL, lastChanged, changeCount, hash)

    if (input.includeDebugHeaders && !metadata) {
      const metaData = await this.client.hgetall(input.metaKey)
      if (Object.keys(metaData).length > 0) {
        metadata = {
          dataTTL: metaData.dataTTL,
          lastChanged: metaData.lastChanged,
          changeCount: metaData.changeCount,
          hash: metaData.hash,
        }
      }
    }

    return {
      encodedData: cachedData,
      ttl: remainingTTL,
      metadata,
    }
  }

  public async update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult> {
    const result = await this.client.adaptiveCacheUpdate(
      input.dataKey,
      input.metaKey,
      input.responseHash,
      input.encodedData,
      input.initialTTL.toString(),
      input.maxTTL.toString(),
      input.ttlScaling.toString(),
      input.metaTTL.toString(),
    )

    if (input.tags.length > 0) {
      const pipeline = this.client.pipeline()
      input.tags.forEach((tag) => {
        const tagKey = input.redisPrefix + 'tag:' + tag
        pipeline.sadd(tagKey, input.key)
      })
      await pipeline.exec()
    }

    return result
  }

  public async clear(_key: string, dataKey: string) {
    await this.client.del(dataKey)
  }

  public async invalidateTags(tags: string[], redisPrefix: string) {
    const invalidatedKeys: string[] = []

    for (const tag of tags) {
      const tagKey = redisPrefix + 'tag:' + tag
      const keys = await this.client.smembers(tagKey)
      invalidatedKeys.push(...keys)

      if (keys.length > 0) {
        const pipeline = this.client.pipeline()
        keys.forEach((key) => {
          pipeline.del(key + 'data')
        })
        pipeline.del(tagKey)
        await pipeline.exec()
      } else {
        await this.client.del(tagKey)
      }
    }

    return invalidatedKeys
  }

  public async shouldRefresh(
    lastUpdateKey: string,
    refreshThreshold: number,
    currentTime: number,
    force: boolean,
    lockExpirationSeconds: number,
    lockValue: string,
  ) {
    const lockKey = lastUpdateKey + '-lock'
    const lockExpiration = lockExpirationSeconds * 1000

    return this.client.shouldRefreshCache(
      lastUpdateKey,
      lockKey,
      currentTime,
      refreshThreshold,
      lockExpiration,
      lockValue,
      force ? 1 : 0,
    )
  }

  public async releaseLock(lastUpdateKey: string, currentTime: number, lockValue: string) {
    const lockKey = lastUpdateKey + '-lock'
    return this.client.releaseCacheRefreshLock(lastUpdateKey, lockKey, currentTime, lockValue)
  }

  public async quit() {
    if (this.ownsClient) {
      return this.client.quit()
    }
    return undefined
  }
}
