import { normalizeTtlPolicy } from '../ttlPolicy'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
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

interface RedisFeatureCommands {
  adaptiveCacheFetch(
    dataKey: string,
    allowStale: string,
  ): Promise<
    [
      string | null | false,
      number,
      string | number | false,
      string | number | false,
      string | number | false,
      string | false,
      number?,
      number?,
    ]
  >
  adaptiveCacheUpdate(...args: string[]): Promise<AdaptiveCacheUpdateResult>
  adaptiveCacheInvalidate(...args: string[]): Promise<string[]>
}

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

const shouldUseTls = (redisURL: string | undefined) =>
  Boolean(process.env.REDIS_TLS_URL) || Boolean(redisURL?.startsWith('rediss://'))

const shouldRejectUnauthorizedTls = () =>
  process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false' && process.env.REDIS_INSECURE_TLS !== 'true'

export class RedisAdaptiveCacheBackend implements AdaptiveCacheBackend {
  public readonly name = 'redis' as const
  public readonly supportsTtlPolicies = true
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
    const redisParams = shouldUseTls(redisURL) ? { tls: { rejectUnauthorized: shouldRejectUnauthorizedTls() } } : {}

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
      adaptiveCacheInvalidate: { numberOfKeys: 1, file: 'adaptiveCacheInvalidate.lua' },
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
    const [cachedData, remainingTTL, dataTTL, lastChanged, changeCount, hash, stale, staleAge] = await (
      this.client as any
    ).adaptiveCacheFetch(input.dataKey, input.allowStale ? '1' : '0')

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
      stale: stale === 1,
      staleAge: Number(staleAge || 0) / 1000,
      layer: 'redis',
    }
  }

  public async update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult> {
    const result = await (this.client as unknown as RedisFeatureCommands).adaptiveCacheUpdate(
      input.dataKey,
      input.metaKey,
      input.responseHash,
      input.encodedData,
      input.initialTTL.toString(),
      input.maxTTL.toString(),
      input.ttlScaling.toString(),
      input.metaTTL.toString(),
      input.writeToken || '',
      input.redisPrefix,
      input.key,
      JSON.stringify(input.tags),
      String(input.staleTTL || 0),
      String(1 - Math.random() * (input.ttlJitter || 0)),
      input.lockKey || '',
      input.lockValue || '',
      randomUUID(),
      JSON.stringify(normalizeTtlPolicy(input.ttlPolicy)),
    )

    result[1] = Number(result[1])
    return result
  }

  public async captureWriteToken(redisPrefix: string) {
    const keys = ['__adaptive:legacy-barrier', redisPrefix + '__adaptive:barrier', redisPrefix + '__adaptive:namespace']
    for (let attempt = 0; attempt < 3; attempt++) {
      const values = await this.client.mget(...keys)
      if (values.every((value) => value !== null)) return values.join(':')
      await Promise.all(
        keys.map((key, index) => (values[index] === null ? this.client.setnx(key, randomUUID()) : undefined)),
      )
    }
    throw new Error('Redis cannot retain invalidation barriers')
  }

  public async clear(key: string, _dataKey: string, _metaKey: string, redisPrefix?: string) {
    await (this.client as unknown as RedisFeatureCommands).adaptiveCacheInvalidate(
      '__adaptive:legacy-barrier',
      'clear',
      redisPrefix || '',
      key,
      '[]',
      randomUUID(),
      randomUUID(),
    )
  }

  public async invalidateNamespace(redisPrefix: string) {
    await (this.client as unknown as RedisFeatureCommands).adaptiveCacheInvalidate(
      '__adaptive:legacy-barrier',
      'namespace',
      redisPrefix,
      '',
      '[]',
      randomUUID(),
      randomUUID(),
    )
  }

  public async invalidateTags(tags: string[], redisPrefix: string): Promise<string[]> {
    return (this.client as unknown as RedisFeatureCommands).adaptiveCacheInvalidate(
      '__adaptive:legacy-barrier',
      'tags',
      redisPrefix,
      '',
      JSON.stringify(tags),
      randomUUID(),
      randomUUID(),
    )
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

  public async releaseLock(lastUpdateKey: string, currentTime: number, lockValue: string, recordRefresh = true) {
    const lockKey = lastUpdateKey + '-lock'
    return this.client.releaseCacheRefreshLock(lastUpdateKey, lockKey, currentTime, lockValue, recordRefresh ? 1 : 0)
  }

  public async quit() {
    if (this.ownsClient) {
      return this.client.quit()
    }
    return undefined
  }
}
