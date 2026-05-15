import Redis from 'ioredis'
import { Logger } from '../lib/logger'
import {
  AdaptiveCacheBackend,
  AdaptiveCacheBackendFetchInput,
  AdaptiveCacheBackendUpdateInput,
  AdaptiveCacheUpdateResult,
} from '../types'
import { ClusteredLruAdaptiveCacheBackend } from './ClusteredLruAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from './RedisAdaptiveCacheBackend'

interface InvalidationMessage {
  source: string
  keys: string[]
}

export class L1RedisAdaptiveCacheBackend implements AdaptiveCacheBackend {
  public readonly name = 'l1-redis' as const
  public readonly client: Redis
  private readonly redis: RedisAdaptiveCacheBackend
  private readonly lru: ClusteredLruAdaptiveCacheBackend
  private readonly logger: Logger
  private readonly writeMode: 'async' | 'await-redis'
  private readonly pendingUpdates = new Set<Promise<void>>()
  private readonly sourceId = Math.random().toString(36).slice(2)
  private readonly channel: string
  private subscriber?: Redis
  private subscriberReady?: Promise<void>

  constructor(
    redis: RedisAdaptiveCacheBackend,
    lru: ClusteredLruAdaptiveCacheBackend,
    redisPrefix: string,
    logger: Logger,
    writeMode: 'async' | 'await-redis' = 'async',
  ) {
    this.redis = redis
    this.client = redis.client
    this.lru = lru
    this.logger = logger
    this.writeMode = writeMode
    this.channel = redisPrefix + 'l1:invalidate'
    this.subscribeInvalidations()
  }

  public async fetch(input: AdaptiveCacheBackendFetchInput) {
    const l1Result = await this.lru.fetch(input)
    if (l1Result) return l1Result

    const redisResult = await this.redis.fetch(input)
    if (redisResult) {
      try {
        await this.subscriberReady
        await this.lru.hydrateFromFetch(input, redisResult)
      } catch (err) {
        this.logger.warn('Failed to hydrate clustered LRU from Redis:', err)
      }
    }

    return redisResult
  }

  public async update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult> {
    await this.lru.storeConservative(input)

    const redisUpdate = this.redis.update(input).then<AdaptiveCacheUpdateResult>(async (result) => {
      await this.lru.hydrateFromUpdate(input, result)
      const changed = result[5] === 1
      if (changed) {
        await this.publishInvalidation([input.key])
      }
      return result
    })

    const trackedUpdate = redisUpdate.then(
      () => undefined,
      () => undefined,
    )
    this.pendingUpdates.add(trackedUpdate)
    trackedUpdate.then(() => this.pendingUpdates.delete(trackedUpdate))

    if (this.writeMode === 'await-redis') {
      return redisUpdate.catch((err) => {
        this.logger.error('Redis adaptive cache update failed after L1 write:', err)
        throw err
      })
    }

    redisUpdate.catch((err) => {
      this.logger.error('Redis adaptive cache update failed after L1 write:', err)
    })

    return ['CACHED', input.initialTTL, Math.floor(Date.now() / 1000), 0, input.responseHash, 1]
  }

  public async clear(key: string, dataKey: string, metaKey: string) {
    await this.lru.clear(key, dataKey, metaKey)
    await this.redis.clear(key, dataKey, metaKey)
    await this.publishInvalidation([key])
  }

  public async invalidateTags(tags: string[], redisPrefix: string) {
    const lruKeys = await this.lru.invalidateTags(tags, redisPrefix)
    const redisKeys = await this.redis.invalidateTags(tags, redisPrefix)
    const keys = Array.from(new Set([...lruKeys, ...redisKeys]))

    if (keys.length > 0) {
      await this.lru.deleteKeys(keys)
      await this.publishInvalidation(keys)
    }

    return keys
  }

  public shouldRefresh(
    lastUpdateKey: string,
    refreshThreshold: number,
    currentTime: number,
    force: boolean,
    lockExpirationSeconds: number,
    lockValue: string,
  ) {
    return this.redis.shouldRefresh(
      lastUpdateKey,
      refreshThreshold,
      currentTime,
      force,
      lockExpirationSeconds,
      lockValue,
    )
  }

  public releaseLock(lastUpdateKey: string, currentTime: number, lockValue: string) {
    return this.redis.releaseLock(lastUpdateKey, currentTime, lockValue)
  }

  public async quit() {
    await this.flush()

    if (this.subscriber) {
      await this.subscriber.quit()
      this.subscriber = undefined
    }

    await this.lru.quit?.()
    await this.redis.quit?.()
  }

  public async flush() {
    await Promise.allSettled(Array.from(this.pendingUpdates))
  }

  private subscribeInvalidations() {
    try {
      this.subscriber = this.client.duplicate()
      this.subscriber.on('message', (_channel, payload) => {
        this.handleInvalidation(payload)
      })
      this.subscriber.on('error', (err) => {
        this.logger.warn('Redis L1 invalidation subscriber error:', err)
      })
      this.subscriberReady = this.subscriber
        .subscribe(this.channel)
        .then(() => undefined)
        .catch((err) => {
          this.logger.warn('Failed to subscribe to Redis L1 invalidations:', err)
        })
    } catch (err) {
      this.logger.warn('Failed to start Redis L1 invalidation subscriber:', err)
    }
  }

  private handleInvalidation(payload: string) {
    let message: InvalidationMessage
    try {
      message = JSON.parse(payload)
    } catch (err) {
      this.logger.warn('Invalid Redis L1 invalidation message:', err)
      return
    }

    if (message.source === this.sourceId || !Array.isArray(message.keys)) {
      return
    }

    this.lru.deleteKeys(message.keys).catch((err) => {
      this.logger.warn('Failed to apply Redis L1 invalidation:', err)
    })
  }

  private async publishInvalidation(keys: string[]) {
    if (keys.length === 0) return

    const message: InvalidationMessage = {
      source: this.sourceId,
      keys,
    }

    try {
      await this.client.publish(this.channel, JSON.stringify(message))
    } catch (err) {
      this.logger.warn('Failed to publish Redis L1 invalidation:', err)
    }
  }
}
