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

interface ClientState {
  pendingUpdates: Set<Promise<void>>
  hydrations: Set<Promise<unknown>>
  generation: number
}

// Middleware and temporary invalidators share the same caller-owned client.
const clientStates = new WeakMap<Redis, ClientState>()

export class L1RedisAdaptiveCacheBackend implements AdaptiveCacheBackend {
  public readonly name = 'l1-redis' as const
  public readonly supportsTtlPolicies = true
  public readonly client: Redis
  private readonly redis: RedisAdaptiveCacheBackend
  private readonly lru: ClusteredLruAdaptiveCacheBackend
  private readonly logger: Logger
  private readonly writeMode: 'async' | 'await-redis'
  private readonly state: ClientState
  private readonly sourceId = Math.random().toString(36).slice(2)
  private readonly channel: string
  private readonly redisPrefix: string
  private subscriber?: Redis
  private subscriberReady?: Promise<void>

  constructor(
    redis: RedisAdaptiveCacheBackend,
    lru: ClusteredLruAdaptiveCacheBackend,
    redisPrefix: string,
    logger: Logger,
    writeMode: 'async' | 'await-redis' = 'async',
  ) {
    this.redisPrefix = redisPrefix
    this.redis = redis
    this.client = redis.client
    let state = clientStates.get(this.client)
    if (!state) {
      state = { pendingUpdates: new Set(), hydrations: new Set(), generation: 0 }
      clientStates.set(this.client, state)
    }
    this.state = state
    this.lru = lru
    this.logger = logger
    this.writeMode = writeMode
    this.channel = redisPrefix + 'l1:invalidate'
    this.subscribeInvalidations()
  }

  public async fetch(input: AdaptiveCacheBackendFetchInput) {
    const token = await this.redis.captureWriteToken(input.redisPrefix)
    const l1Result = await this.lru.fetch(input)
    if (l1Result && l1Result.writeToken === token) return { ...l1Result, layer: 'l1' as const }
    if (l1Result) await this.lru.deleteKeys([input.key])

    await this.subscriberReady
    const generation = this.state.generation
    const redisResult = await this.redis.fetch(input)
    if (redisResult && redisResult.ttl > 0 && generation === this.state.generation) {
      const hydration = this.lru.hydrateFromFetch(input, redisResult, token)
      this.state.hydrations.add(hydration)
      try {
        await hydration
      } catch (err) {
        this.logger.warn('Failed to hydrate clustered LRU from Redis:', err)
      } finally {
        this.state.hydrations.delete(hydration)
      }
    }

    return redisResult
  }

  public async update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult> {
    const token = input.writeToken || (await this.redis.captureWriteToken(input.redisPrefix))
    // Explicitly fenced writes cannot be visible before Redis accepts them.
    const optimistic = this.writeMode === 'async' && (!input.writeToken || input.allowOptimistic) && !input.lockKey
    if (optimistic) {
      await this.lru.storeConservative({ ...input, writeToken: token })
    }

    const redisUpdate = this.redis
      .update({ ...input, writeToken: token })
      .then<AdaptiveCacheUpdateResult>(async (result) => {
        if (result[0] === 'INVALIDATED') return result
        if (token !== (await this.redis.captureWriteToken(input.redisPrefix))) return ['INVALIDATED', 0]
        // Use the remaining Redis lifetime: hydration latency and jitter must not extend freshness.
        const current = await this.redis.fetch({ ...input, includeDebugHeaders: true })
        if (current && current.ttl > 0 && current.encodedData === input.encodedData) {
          await this.lru.hydrateFromFetch({ ...input, includeDebugHeaders: true }, current, token)
        }
        if (!current || current.ttl <= 0) await this.lru.deleteKeys([input.key])
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
    this.state.pendingUpdates.add(trackedUpdate)
    trackedUpdate.then(() => this.state.pendingUpdates.delete(trackedUpdate))

    if (!optimistic) {
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

  public captureWriteToken(redisPrefix: string) {
    return this.redis.captureWriteToken(redisPrefix)
  }

  public onEvent(listener: Parameters<ClusteredLruAdaptiveCacheBackend['onEvent']>[0]) {
    return this.lru.onEvent(listener)
  }

  public async invalidateNamespace(redisPrefix: string) {
    this.state.generation++
    await this.redis.invalidateNamespace(redisPrefix)
    await this.lru.invalidateNamespace(redisPrefix)
  }

  public async clear(key: string, dataKey: string, metaKey: string, redisPrefix = this.redisPrefix) {
    this.state.generation++
    await this.flush()
    await this.redis.clear(key, dataKey, metaKey, redisPrefix)
    this.state.generation++
    await Promise.allSettled([...this.state.hydrations])
    await this.lru.clear(key, dataKey, metaKey, redisPrefix)
    await this.publishInvalidation([key])
  }

  public async invalidateTags(tags: string[], redisPrefix: string) {
    this.state.generation++
    await this.flush()
    const redisKeys = await this.redis.invalidateTags(tags, redisPrefix)
    this.state.generation++
    await Promise.allSettled([...this.state.hydrations])
    const lruKeys = await this.lru.invalidateTags(tags, redisPrefix)
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

  public releaseLock(lastUpdateKey: string, currentTime: number, lockValue: string, recordRefresh = true) {
    return this.redis.releaseLock(lastUpdateKey, currentTime, lockValue, recordRefresh)
  }

  public async quit(preserveSharedCache = false) {
    await this.flush()

    if (this.subscriber) {
      await this.subscriber.quit()
      this.subscriber = undefined
    }

    await this.lru.quit?.(preserveSharedCache)
    await this.redis.quit?.()
  }

  public async flush() {
    await Promise.allSettled(Array.from(this.state.pendingUpdates))
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

    if (
      !message ||
      typeof message !== 'object' ||
      message.source === this.sourceId ||
      !Array.isArray(message.keys) ||
      !message.keys.every((key) => typeof key === 'string')
    ) {
      return
    }

    this.state.generation++
    Promise.allSettled([...this.state.hydrations])
      .then(() => this.lru.deleteKeys(message.keys))
      .catch((err) => {
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
