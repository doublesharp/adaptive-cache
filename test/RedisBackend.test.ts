import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { FakeRedis } from './helpers/FakeRedis'

const logger = () => new Logger('silent')

describe('RedisAdaptiveCacheBackend', () => {
  it('should fetch, update, tag, clear, invalidate, and coordinate locks through Redis commands', async () => {
    const redis = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    const update = await backend.update({
      key: 'redis-key',
      dataKey: 'redis-keydata',
      metaKey: 'redis-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-a',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: ['tag-a'],
    })

    expect(update[0]).toBe('CACHED')
    expect(update[4]).toBe('hash-a')
    expect(await redis.smembers('adaptive:tag:tag-a')).toEqual(['redis-key'])

    const hit = await backend.fetch({
      key: 'redis-key',
      dataKey: 'redis-keydata',
      metaKey: 'redis-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(hit?.encodedData).toBe(JSON.stringify({ ok: true }))
    expect(hit?.metadata?.hash).toBe('hash-a')

    const miss = await backend.fetch({
      key: 'missing',
      dataKey: 'missingdata',
      metaKey: 'missingmeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(miss).toBeNull()

    const refresh = await backend.shouldRefresh('last-update', 10, 100, false, 1, 'lock-a')
    expect(refresh[0]).toBe('UPDATE')
    const updating = await backend.shouldRefresh('last-update', 10, 100, false, 1, 'lock-b')
    expect(updating[0]).toBe('UPDATING')
    expect(await backend.releaseLock('last-update', 100, 'lock-a')).toEqual(['UPDATED'])
    expect((await backend.shouldRefresh('last-update', 10, 101, false, 1, 'lock-c'))[0]).toBe('EXISTS')
    expect((await backend.shouldRefresh('last-update', 10, 101, true, 1, 'lock-d'))[0]).toBe('UPDATE')

    const invalidated = await backend.invalidateTags(['tag-a'], 'adaptive:')
    expect(invalidated).toEqual(['redis-key'])
    expect(await redis.hgetall('redis-keymeta')).toEqual({})
    expect(await redis.exists('adaptive:tag:tag-a')).toBe(0)
    expect(await backend.invalidateTags(['missing-tag'], 'adaptive:')).toEqual([])
    expect(
      await backend.fetch({
        key: 'redis-key',
        dataKey: 'redis-keydata',
        metaKey: 'redis-keymeta',
        redisPrefix: 'adaptive:',
        includeDebugHeaders: true,
      }),
    ).toBeNull()

    await redis.adaptiveCacheUpdate(
      'redis-keydata',
      'redis-keymeta',
      'hash-b',
      JSON.stringify({ ok: false }),
      '5',
      '60',
      '2',
      '100',
    )
    await backend.clear('redis-key', 'redis-keydata', 'redis-keymeta')
    expect(await redis.get('redis-keydata')).toBeNull()
    expect(await redis.hgetall('redis-keymeta')).toEqual({})
    await backend.quit()
    expect(redis.quitCalls).toBe(0)
  })

  it('should define Lua commands when they are missing on the client', () => {
    const client = {
      defineCommand: vi.fn(),
    }

    new RedisAdaptiveCacheBackend(client as any, logger())

    expect(client.defineCommand.mock.calls.map(([name]) => name)).toEqual([
      'adaptiveCacheFetch',
      'adaptiveCacheUpdate',
      'shouldRefreshCache',
      'releaseCacheRefreshLock',
      'adaptiveCacheInvalidate',
    ])
  })

  it('should fall back to the first Lua path candidate when no Lua path exists', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('-- mocked lua')
    const client = {
      defineCommand: vi.fn(),
    }

    try {
      new RedisAdaptiveCacheBackend(client as any, logger())
      expect(readSpy.mock.calls.map(([file]) => String(file).split('/').at(-1))).toEqual([
        'adaptiveCacheFetch.lua',
        'adaptiveCacheUpdate.lua',
        'shouldRefreshCache.lua',
        'releaseCacheRefreshLock.lua',
        'adaptiveCacheInvalidate.lua',
      ])
      expect(client.defineCommand).toHaveBeenCalledWith('adaptiveCacheInvalidate', {
        numberOfKeys: 1,
        lua: '-- mocked lua',
      })
    } finally {
      readSpy.mockRestore()
      existsSpy.mockRestore()
    }
  })

  it('should fall back to hgetall metadata when fetch tuple has only old fields', async () => {
    const redis = new FakeRedis()
    await redis.set('old-keydata', 'raw', 'EX', 30)
    redis.stores.hashes.set('old-keymeta', {
      hash: 'old-hash',
      dataTTL: '30',
      lastChanged: '123',
      changeCount: '2',
    })
    redis.adaptiveCacheFetch = vi.fn(async () => ['raw', 30]) as any
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    const hit = await backend.fetch({
      key: 'old-key',
      dataKey: 'old-keydata',
      metaKey: 'old-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })

    expect(hit?.metadata).toEqual({
      hash: 'old-hash',
      dataTTL: '30',
      lastChanged: '123',
      changeCount: '2',
    })
  })

  it('should leave metadata empty when old fetch tuples have no metadata hash', async () => {
    const redis = new FakeRedis()
    await redis.set('old-empty-keydata', 'raw', 'EX', 30)
    redis.adaptiveCacheFetch = vi.fn(async () => ['raw', 30, null, null, null, null]) as any
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    const hit = await backend.fetch({
      key: 'old-empty-key',
      dataKey: 'old-empty-keydata',
      metaKey: 'old-empty-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })

    expect(hit?.metadata).toBeUndefined()
  })

  it('should quit owned Redis clients', async () => {
    const redis = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger(), true)

    await backend.quit()

    expect(redis.quitCalls).toBe(1)
  })
})
