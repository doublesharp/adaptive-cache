import { URL } from 'node:url'

type PipelineCommand = () => void

interface StoredValue {
  value: string
  expiresAt?: number
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

export class FakeRedis {
  public status = 'ready'
  public options = { host: 'fake', port: 6379 }
  public events = new Map<string, Array<(...args: any[]) => void>>()
  public stores = {
    values: new Map<string, StoredValue>(),
    hashes: new Map<string, Record<string, string>>(),
    sets: new Map<string, Set<string>>(),
  }
  public published: Array<{ channel: string; payload: string }> = []
  public subscribedChannels: string[] = []
  public failUpdate = false
  public failFetch = false
  public failPublish = false
  public failSubscribe = false
  public failDuplicate = false
  public defineCommandCalls: string[] = []
  public quitCalls = 0

  constructor(stores?: FakeRedis['stores'] | Record<string, unknown> | string, options?: Record<string, unknown>) {
    if (typeof stores === 'string') {
      const url = new URL(stores)
      this.options = {
        host: url.hostname,
        port: url.port ? Number(url.port) : 6379,
        ...(options || {}),
      } as typeof this.options
      return
    }

    if (stores && stores.values instanceof Map && stores.hashes instanceof Map && stores.sets instanceof Map) {
      this.stores = stores as FakeRedis['stores']
    } else if (stores) {
      this.options = { ...this.options, ...stores }
    }
  }

  defineCommand(name: string) {
    this.defineCommandCalls.push(name)
  }

  on(event: string, handler: (...args: any[]) => void) {
    const handlers = this.events.get(event) || []
    handlers.push(handler)
    this.events.set(event, handlers)
    return this
  }

  emit(event: string, ...args: any[]) {
    for (const handler of this.events.get(event) || []) handler(...args)
  }

  duplicate() {
    if (this.failDuplicate) throw new Error('duplicate failed')
    const duplicate = new FakeRedis(this.stores)
    duplicate.failSubscribe = this.failSubscribe
    duplicate.failPublish = this.failPublish
    return duplicate
  }

  async subscribe(channel: string) {
    if (this.failSubscribe) throw new Error('subscribe failed')
    this.subscribedChannels.push(channel)
    return 1
  }

  async publish(channel: string, payload: string) {
    if (this.failPublish) throw new Error('publish failed')
    this.published.push({ channel, payload })
    return 1
  }

  async get(key: string) {
    const entry = this.stores.values.get(key)
    if (!entry) return null
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.stores.values.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string | number, mode?: string, ttl?: number) {
    const entry: StoredValue = { value: String(value) }
    if (mode === 'EX' && typeof ttl === 'number') entry.expiresAt = Date.now() + ttl * 1000
    if (mode === 'PX' && typeof ttl === 'number') entry.expiresAt = Date.now() + ttl
    this.stores.values.set(key, entry)
    return 'OK'
  }

  async del(...keys: string[]) {
    let deleted = 0
    for (const key of keys) {
      if (this.stores.values.delete(key)) deleted += 1
      if (this.stores.hashes.delete(key)) deleted += 1
      if (this.stores.sets.delete(key)) deleted += 1
    }
    return deleted
  }

  async exists(key: string) {
    return this.stores.values.has(key) || this.stores.hashes.has(key) || this.stores.sets.has(key) ? 1 : 0
  }

  async hgetall(key: string) {
    return this.stores.hashes.get(key) || {}
  }

  async smembers(key: string) {
    return Array.from(this.stores.sets.get(key) || [])
  }

  async flushall() {
    this.stores.values.clear()
    this.stores.hashes.clear()
    this.stores.sets.clear()
  }

  async quit() {
    this.quitCalls += 1
    return 'OK'
  }

  pipeline() {
    const commands: PipelineCommand[] = []
    return {
      sadd: (key: string, value: string) => {
        commands.push(() => {
          const set = this.stores.sets.get(key) || new Set<string>()
          set.add(value)
          this.stores.sets.set(key, set)
        })
        return this
      },
      expire: (key: string, ttl: number) => {
        commands.push(() => {
          const value = this.stores.values.get(key)
          if (value) value.expiresAt = Date.now() + ttl * 1000
        })
        return this
      },
      del: (...keys: string[]) => {
        commands.push(() => {
          for (const key of keys) {
            this.stores.values.delete(key)
            this.stores.hashes.delete(key)
            this.stores.sets.delete(key)
          }
        })
        return this
      },
      exec: async () => {
        commands.forEach((command) => command())
        return commands.map(() => [null, 'OK'])
      },
    }
  }

  async adaptiveCacheFetch(dataKey: string) {
    if (this.failFetch) throw new Error('fetch failed')
    const data = await this.get(dataKey)
    if (!data) return [null, 0]
    const meta = this.stores.hashes.get(dataKey.replace(/data$/, 'meta')) || {}
    return [data, await this.ttl(dataKey), meta.dataTTL, meta.lastChanged, meta.changeCount, meta.hash]
  }

  async adaptiveCacheUpdate(
    dataKey: string,
    metaKey: string,
    hash: string,
    data: string,
    initialTTLString: string,
    maxTTLString: string,
    ttlScalingString: string,
    metaTTLString: string,
  ) {
    if (this.failUpdate) throw new Error('update failed')

    const initialTTL = Number(initialTTLString)
    const maxTTL = Number(maxTTLString)
    const ttlScaling = Number(ttlScalingString)
    const meta = this.stores.hashes.get(metaKey) || {}
    let dataTTL = Number(meta.dataTTL) || initialTTL
    const isChanged = Object.keys(meta).length === 0 || meta.hash !== hash
    let lastChanged = isChanged ? nowSeconds() : Number(meta.lastChanged) || 0
    let changeCount = Number(meta.changeCount || '0')

    if (!isChanged) {
      if (dataTTL >= maxTTL) {
        dataTTL = maxTTL
      } else {
        const decayFactor = 1.0 - Math.min(0.9, changeCount * 0.01)
        const increaseFactor = Math.max(0, ttlScaling - 1)
        const increase = Math.ceil(Math.floor(dataTTL * increaseFactor) * decayFactor)
        dataTTL = Math.max(initialTTL, Math.min(dataTTL + increase, maxTTL))
      }
    } else {
      changeCount += 1
      dataTTL = initialTTL
      lastChanged = nowSeconds()
    }

    this.stores.hashes.set(metaKey, {
      hash,
      dataTTL: String(dataTTL),
      lastChanged: String(lastChanged),
      changeCount: String(changeCount),
    })
    await this.set(dataKey, data, 'EX', dataTTL)
    await this.set(metaKey + ':ttl-marker', '1', 'EX', Number(metaTTLString))

    return ['CACHED', dataTTL, lastChanged, changeCount, hash, isChanged ? 1 : 0]
  }

  async shouldRefreshCache(
    lastUpdateKey: string,
    lockKey: string,
    currentTime: number,
    refreshThreshold: number,
    lockExpiration: number,
    lockValue: string,
    force: number,
  ) {
    const lastUpdate = force === 1 ? -1 : Number((await this.get(lastUpdateKey)) || '0')
    if (force !== 1 && currentTime - lastUpdate < refreshThreshold) {
      return ['EXISTS', refreshThreshold - (currentTime - lastUpdate)]
    }

    const existingLock = await this.get(lockKey)
    if (force !== 1 && existingLock && existingLock !== lockValue) {
      return ['UPDATING', existingLock]
    }

    await this.set(lockKey, lockValue, 'PX', lockExpiration)
    return ['UPDATE', lockValue, lastUpdate]
  }

  async releaseCacheRefreshLock(lastUpdateKey: string, lockKey: string, currentTime: number, lockValue: string) {
    const existingLock = await this.get(lockKey)
    if (!existingLock || existingLock === lockValue) {
      await this.set(lastUpdateKey, String(currentTime))
      await this.del(lockKey)
      return ['UPDATED']
    }
    return ['LOCK_MISMATCH', existingLock]
  }

  private async ttl(key: string) {
    const entry = this.stores.values.get(key)
    if (!entry) return -2
    if (!entry.expiresAt) return -1
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000))
  }
}
