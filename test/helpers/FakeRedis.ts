import { calculateNextMetadata } from '../../src/backends/lruEnvelope'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'

type PipelineCommand = () => void

interface StoredValue {
  value: string
  expiresAt?: number
}

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

  async setnx(key: string, value: string) {
    if ((await this.get(key)) !== null) return 0
    await this.set(key, value)
    return 1
  }

  async mget(...keys: string[]) {
    return Promise.all(keys.map((key) => this.get(key)))
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

  async adaptiveCacheFetch(dataKey: string, allowStale = '0') {
    if (this.failFetch) throw new Error('fetch failed')
    let data = await this.get(dataKey)
    if (!data) return [null, 0]
    const meta = this.stores.hashes.get(dataKey.replace(/data$/, 'meta')) || {}
    let freshUntil: number | undefined
    if (data.startsWith('@ac-redis:1:')) {
      const envelope = JSON.parse(data.slice('@ac-redis:1:'.length))
      if (envelope.namespace !== (await this.get(envelope.prefix + '__adaptive:namespace'))) return [null, 0]
      for (const [key, epoch] of Object.entries(envelope.epochs)) if ((await this.get(key)) !== epoch) return [null, 0]
      freshUntil = envelope.freshUntil
      data = envelope.data
    }
    const remaining = freshUntil !== undefined ? freshUntil - Date.now() : (await this.ttl(dataKey)) * 1000
    const stale = remaining <= 0
    if (stale && allowStale !== '1') return [null, 0]
    return [
      data,
      Math.max(0, Math.floor(remaining / 1000)),
      meta.dataTTL,
      meta.lastChanged,
      meta.changeCount,
      meta.hash,
      stale ? 1 : 0,
      Math.max(0, -remaining),
    ]
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
    writeToken = '',
    prefix = '',
    key = dataKey.replace(/data$/, ''),
    tagsJSON = '[]',
    staleTTLString = '0',
    jitterFactor = '1',
    lockKey = '',
    lockValue = '',
    uuid = randomUUID(),
    policyJSON = '{"type":"adaptive"}',
  ) {
    if (this.failUpdate) throw new Error('update failed')
    if (lockKey && (await this.get(lockKey)) !== lockValue) return ['INVALIDATED', 0]
    const [legacy, barrier, storedGeneration] = await this.mget(
      '__adaptive:legacy-barrier',
      prefix + '__adaptive:barrier',
      prefix + '__adaptive:namespace',
    )
    if (
      writeToken &&
      (!legacy || !barrier || !storedGeneration || writeToken !== [legacy, barrier, storedGeneration].join(':'))
    )
      return ['INVALIDATED', 0]
    let old = this.stores.hashes.get(dataKey + ':state')
    const previousData = await this.get(dataKey)
    if (!old && previousData?.startsWith('@ac-redis:1:')) {
      const previous = JSON.parse(previousData.slice('@ac-redis:1:'.length))
      old = { prefix: previous.prefix, tags: JSON.stringify(previous.tags), generation: previous.namespace }
    }
    for (const tag of JSON.parse(old?.tags || '[]'))
      this.stores.sets.get((old?.prefix || '') + 'tag:' + tag)?.delete(key)
    const generation = storedGeneration || uuid
    await this.setnx(prefix + '__adaptive:namespace', generation)
    if (old && old.generation !== generation) this.stores.hashes.delete(metaKey)
    const epochs: Record<string, string> = {}
    for (const tag of JSON.parse(tagsJSON)) {
      const epochKey = prefix + '__adaptive:tag-epoch:' + tag
      await this.setnx(epochKey, uuid)
      epochs[epochKey] = (await this.get(epochKey))!
      const epoch = this.stores.values.get(epochKey)!
      epoch.expiresAt = Math.max(
        epoch.expiresAt || 0,
        Date.now() + Math.max(Number(metaTTLString), Number(maxTTLString) + Number(staleTTLString)) * 1000,
      )
      const tagKey = prefix + 'tag:' + tag
      const members = this.stores.sets.get(tagKey) || new Set<string>()
      members.add(key)
      this.stores.sets.set(tagKey, members)
    }

    const initialTTL = Number(initialTTLString)
    const maxTTL = Number(maxTTLString)
    const ttlScaling = Number(ttlScalingString)
    const meta = this.stores.hashes.get(metaKey) || {}
    const calculated = calculateNextMetadata(
      { ...meta, ttlPolicyState: meta.ttlPolicyState ? JSON.parse(meta.ttlPolicyState) : undefined },
      hash,
      initialTTL,
      maxTTL,
      ttlScaling,
      JSON.parse(policyJSON),
      Date.now(),
    )
    let { dataTTL } = calculated
    const { lastChanged, changeCount, changed: isChanged } = calculated
    this.stores.hashes.set(metaKey, {
      hash,
      dataTTL: String(dataTTL),
      lastChanged: String(lastChanged),
      changeCount: String(changeCount),
      ...(calculated.ttlPolicyState ? { ttlPolicyState: JSON.stringify(calculated.ttlPolicyState) } : {}),
    })
    dataTTL = Math.min(dataTTL, maxTTL)
    const freshTTL = dataTTL * Number(jitterFactor)
    this.stores.hashes.set(dataKey + ':state', {
      prefix,
      tags: tagsJSON,
      generation,
      freshUntil: String(Date.now() + freshTTL * 1000),
    })
    await this.set(
      dataKey,
      '@ac-redis:1:' +
        JSON.stringify({
          data,
          prefix,
          namespace: generation,
          freshUntil: Date.now() + freshTTL * 1000,
          epochs,
          tags: JSON.parse(tagsJSON),
        }),
      'PX',
      (freshTTL + Number(staleTTLString)) * 1000,
    )
    await this.set(metaKey + ':ttl-marker', '1', 'EX', Number(metaTTLString))

    return ['CACHED', dataTTL, lastChanged, changeCount, hash, isChanged ? 1 : 0]
  }

  async adaptiveCacheInvalidate(
    legacyKey: string,
    operation: string,
    prefix: string,
    key: string,
    tagsJSON: string,
    barrierUUID = randomUUID(),
    namespaceUUID = randomUUID(),
  ) {
    const barrier = prefix ? prefix + '__adaptive:barrier' : legacyKey
    await this.set(barrier, barrierUUID)
    if (operation === 'namespace') {
      const namespace = prefix + '__adaptive:namespace'
      await this.set(namespace, namespaceUUID)
      return []
    }
    const keys = new Set<string>(operation === 'clear' ? [key] : [])
    const tags: string[] = JSON.parse(tagsJSON)
    for (const tag of tags) await this.del(prefix + '__adaptive:tag-epoch:' + tag)
    for (const tag of tags) for (const member of await this.smembers(prefix + 'tag:' + tag)) keys.add(member)
    for (const member of keys) {
      let state = this.stores.hashes.get(member + 'data:state')
      const data = await this.get(member + 'data')
      if (!state && data?.startsWith('@ac-redis:1:')) {
        const envelope = JSON.parse(data.slice('@ac-redis:1:'.length))
        state = { prefix: envelope.prefix, tags: JSON.stringify(envelope.tags) }
      }
      for (const tag of JSON.parse(state?.tags || '[]'))
        this.stores.sets.get((state?.prefix || '') + 'tag:' + tag)?.delete(member)
      await this.del(member + 'data', member + 'meta', member + 'data:state')
    }
    for (const tag of tags) await this.del(prefix + 'tag:' + tag)
    return [...keys]
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

  async releaseCacheRefreshLock(
    lastUpdateKey: string,
    lockKey: string,
    currentTime: number,
    lockValue: string,
    recordRefresh = 1,
  ) {
    const existingLock = await this.get(lockKey)
    if (!existingLock || existingLock === lockValue) {
      if (recordRefresh !== 0) await this.set(lastUpdateKey, String(currentTime))
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
