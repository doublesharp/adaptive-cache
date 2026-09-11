import { describe, expect, it, vi } from 'vitest'
import { registerRedisCacheSuite } from './helpers/redisCacheSuite'

let cacheModule: typeof import('../src')

describe('AdaptiveCache Class & Utils', () => {
  registerRedisCacheSuite((suite) => {
    cacheModule = suite.cacheModule
  })

  describe('Cleanup', () => {
    it('should quit the client', async () => {
      const cache = new cacheModule.AdaptiveCache()
      const quitSpy = vi.spyOn(cache.client, 'quit')
      await cache.quit()
      expect(quitSpy).toHaveBeenCalled()
    })
  })

  describe('AdaptiveCache Class Internals', () => {
    it.each([
      { name: 'configured', options: { initialTTL: 200, maxTTL: 100 }, expected: 100 },
      { name: 'calculated', options: { initialTTL: 200, maxTTL: () => 12 }, expected: 12 },
      { name: 'default', options: { initialTTL: 1000 }, expected: 900 },
    ])('caps actual stored TTL at the $name maximum', async ({ options, expected }) => {
      const cache = new cacheModule.AdaptiveCache(options)
      try {
        const key = `max-ttl-${expected}`
        const result = await cache.set(key, { a: 1 })
        expect(result[1]).toBe(expected)
        const ttl = await cache.client.ttl(key + 'data')
        expect(ttl).toBeGreaterThan(expected - 2)
        expect(ttl).toBeLessThanOrEqual(expected)
        expect((await cache.get(key))?.data).toEqual({ a: 1 })
      } finally {
        await cache.close()
      }
    })

    it('should round-trip strings and buffers without JSON parse failures', async () => {
      const cache = new cacheModule.AdaptiveCache({ initialTTL: 10 })

      await cache.set('plain-string-key', 'plain text')
      expect((await cache.get('plain-string-key'))?.data).toBe('plain text')

      await cache.set('buffer-key', Buffer.from('buffer text'))
      expect(Buffer.isBuffer((await cache.get('buffer-key'))?.data)).toBe(true)
      expect((await cache.get('buffer-key'))?.data.toString('utf8')).toBe('buffer text')

      await cache.set('empty-buffer-key', Buffer.alloc(0))
      expect((await cache.get('empty-buffer-key'))?.data.length).toBe(0)

      await cache.set('undefined-key', undefined)
      const undefinedHit = await cache.get('undefined-key')
      expect(undefinedHit).not.toBeNull()
      expect(undefinedHit.data).toBeUndefined()
    })

    it('should use instance lockExpirationSeconds if not provided in shouldRefresh', async () => {
      const cache = new cacheModule.AdaptiveCache({ lockExpirationSeconds: 50 })
      const spy = vi.spyOn(cache.client, 'shouldRefreshCache')
      await cache.shouldRefresh('key', 10)
      // Check if lockExpiration (5th arg) is 50 * 1000
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        50000, // lockExpiration
        expect.any(String),
        expect.any(Number),
      )
    })

    it('should use static default lockExpirationSeconds if neither provided', async () => {
      const cache = new cacheModule.AdaptiveCache({})
      const spy = vi.spyOn(cache.client, 'shouldRefreshCache')
      // Ensure static default is 60
      cacheModule.AdaptiveCache.setDefaultLockExpirationSeconds(60)

      await cache.shouldRefresh('key-default', 10)
      // Check if lockExpiration (5th arg) is 60 * 1000
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        60000, // lockExpiration
        expect.any(String),
        expect.any(Number),
      )
    })

    it('should use provided lockExpirationSeconds argument', async () => {
      const cache = new cacheModule.AdaptiveCache({})
      const spy = vi.spyOn(cache.client, 'shouldRefreshCache')

      await cache.shouldRefresh('key-arg', 10, false, 99)
      // Check if lockExpiration (5th arg) is 99 * 1000
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        99000, // lockExpiration
        expect.any(String),
        expect.any(Number),
      )
    })
  })

  describe('Configuration & Environment', () => {
    it('should use REDIS_URL if provided', () => {
      vi.stubEnv('REDIS_URL', 'redis://localhost:6379')
      // We need to unset REDIS_HOST/PORT to ensure it takes the URL path if logic dictates,
      // but the code says: if (redisURL) new Redis(redisURL) else ...
      // So just setting REDIS_URL is enough.

      const cache = new cacheModule.AdaptiveCache()
      // ioredis parses the URL.
      expect(cache.client.options.host).toBe('localhost')
      expect(cache.client.options.port).toBe(6379)

      vi.unstubAllEnvs()
      cache.quit()
    })

    it('should only use TLS options for TLS URLs and verify certificates by default', () => {
      vi.stubEnv('REDIS_URL', 'redis://localhost:6379')

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.tls).toBeUndefined()

      vi.unstubAllEnvs()
      cache.quit()

      vi.stubEnv('REDIS_TLS_URL', 'rediss://localhost:6379')
      const tlsCache = new cacheModule.AdaptiveCache()
      expect(tlsCache.client.options.tls).toEqual({ rejectUnauthorized: true })

      vi.unstubAllEnvs()
      tlsCache.quit()
    })

    it('should allow explicitly insecure Redis TLS', () => {
      vi.stubEnv('REDIS_TLS_URL', 'rediss://localhost:6379')
      vi.stubEnv('REDIS_INSECURE_TLS', 'true')

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.tls).toEqual({ rejectUnauthorized: false })

      vi.unstubAllEnvs()
      cache.quit()
    })

    it('should default to port 6379 if REDIS_PORT is missing', () => {
      // Ensure REDIS_URL is not set
      vi.stubEnv('REDIS_URL', '')
      vi.stubEnv('REDIS_TLS_URL', '')
      vi.stubEnv('REDIS_HOST', 'localhost')
      // stubEnv with undefined or empty string might not remove it from process.env if it was there?
      // vi.stubEnv sets the value.
      // The code checks: process.env.REDIS_PORT ? parseInt(...) : 6379
      // So if I set it to empty string, parseInt('') is NaN.
      // Wait, parseInt('') is NaN. NaN is falsy? No.
      // If I set it to undefined? vi.stubEnv value must be string.

      // I'll manually delete it and restore it.
      const originalPort = process.env.REDIS_PORT
      delete process.env.REDIS_PORT

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.port).toBe(6379)

      process.env.REDIS_PORT = originalPort
      cache.quit()
    })

    it('should use REDIS_PORT if provided', () => {
      // Ensure URL is not set so we fall through to the host/port logic
      vi.stubEnv('REDIS_URL', '')
      vi.stubEnv('REDIS_TLS_URL', '')

      vi.stubEnv('REDIS_HOST', 'localhost')
      vi.stubEnv('REDIS_PORT', '6380')

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.port).toBe(6380)

      vi.unstubAllEnvs()
      cache.quit()
    })

    it('should default to localhost if REDIS_HOST is missing', () => {
      vi.stubEnv('REDIS_URL', '')
      delete process.env.REDIS_HOST

      const cache = new cacheModule.AdaptiveCache()
      expect(cache.client.options.host).toBe('localhost')

      cache.quit()
    })
  })
})
