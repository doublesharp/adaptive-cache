import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ioredis', async () => {
  const { FakeRedis } = await import('./helpers/FakeRedis')
  return { default: FakeRedis }
})

describe('singleton and index exports with mocked Redis', () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('should lazily create and reuse the default cache instance', async () => {
    const { getDefaultCache, redis } = await import('../src')

    const first = getDefaultCache()
    const second = getDefaultCache()

    expect(first).toBe(second)
    expect(redis.status).toBe('ready')
    expect(await redis.set('proxy-key', JSON.stringify({ hit: true }))).toBe('OK')
    expect(await redis.get('proxy-key')).toBe(JSON.stringify({ hit: true }))
    first.client.emit('error', new Error('connection noise'))
  })

  it('cacheResult should return cached values, cache misses, and skip null results', async () => {
    const { cacheResult, redis } = await import('../src')
    const callback = vi.fn(async () => ({ value: 1 }))

    const first = await cacheResult('cache-result-key', 30, callback)
    const second = await cacheResult('cache-result-key', 30, callback)

    expect(first).toEqual({ value: 1 })
    expect(second).toEqual({ value: 1 })
    expect(callback).toHaveBeenCalledTimes(1)

    await redis.set('cache-result-hit', JSON.stringify({ cached: true }))
    expect(await cacheResult('cache-result-hit', 30, async () => ({ cached: false }))).toEqual({ cached: true })

    const nullCallback = vi.fn(async () => null)
    expect(await cacheResult('cache-result-null', 30, nullCallback)).toBeNull()
    expect(await redis.get('cache-result-null')).toBeNull()
  })

  it('module lock helpers should delegate to the default cache', async () => {
    const {
      releaseCacheRefreshLock,
      setDefaultLockExpirationSeconds,
      shouldRefreshCache,
      AdaptiveCache,
      adaptiveExpressCache,
      adaptiveFastifyCache,
      cache,
      clearAdaptiveCache,
    } = await import('../src')

    setDefaultLockExpirationSeconds(5)
    expect(AdaptiveCache.DEFAULT_LOCK_EXPIRATION_SECONDS).toBe(5)

    const refresh = await shouldRefreshCache('index-lock-key', 10)
    expect(refresh[0]).toBe('UPDATE')
    expect(await releaseCacheRefreshLock('index-lock-key', refresh[1] as string)).toEqual(['UPDATED'])

    expect(adaptiveExpressCache).toBeDefined()
    expect(adaptiveFastifyCache).toBeDefined()
    expect(clearAdaptiveCache).toBeDefined()
    expect(cache('1 second')).toEqual({ initialTTL: 1 })
  })

  it('middleware helpers should share the mocked Redis client when Redis backends are requested', async () => {
    const { adaptiveExpressCache, adaptiveFastifyCache, clearAdaptiveCache, redis } = await import('../src')

    expect(adaptiveExpressCache({ backend: 'redis' })).toBeDefined()
    expect(adaptiveFastifyCache({ backend: 'redis' })).toBeDefined()

    await redis.set('adaptive:/default-clear:data', JSON.stringify({ ok: true }))
    await clearAdaptiveCache('/default-clear', {})
    await clearAdaptiveCache('/redis-clear', {}, 'adaptive:', { backend: 'redis' })
  })

  it('Redis client creation should honor URL, TLS, host, and port environment options', async () => {
    const { RedisAdaptiveCacheBackend } = await import('../src/backends/RedisAdaptiveCacheBackend')
    const { Logger } = await import('../src/lib/logger')
    const logger = new Logger('silent')

    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REDIS_TLS_URL', 'rediss://cache.example.test')
    const tlsClient = RedisAdaptiveCacheBackend.createClient(logger) as any
    tlsClient.emit('error', new Error('tls client noise'))
    await tlsClient.quit()

    vi.unstubAllEnvs()
    vi.stubEnv('REDIS_HOST', 'redis.example.test')
    vi.stubEnv('REDIS_PORT', '6380')
    const hostPortClient = RedisAdaptiveCacheBackend.createClient(logger) as any
    hostPortClient.emit('error', new Error('host client noise'))
    await hostPortClient.quit()
  })
})
