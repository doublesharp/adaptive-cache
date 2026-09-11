import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import { AdaptiveCache } from '../src'

let container: StartedTestContainer
let redis: Redis
beforeAll(async () => {
  container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
  redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
})
afterAll(async () => {
  await redis?.quit()
  await container?.stop()
})
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const prefix = (name: string) => `feature-integration:${name}:`

describe('integrated loader and backend contracts', () => {
  it.each(['redis', 'l1-redis'] as const)(
    '%s prevents a delayed loader from repopulating a cleared key',
    async (backend) => {
      const keyPrefix = prefix(backend)
      const key = keyPrefix + 'item'
      const writer = new AdaptiveCache({ backend, keyPrefix, logLevel: 'silent', lru: { namespace: keyPrefix } }, redis)
      const invalidator = new AdaptiveCache({ backend: 'redis', keyPrefix, logLevel: 'silent' }, redis)
      const started = gate()
      const finish = gate()
      let calls = 0
      try {
        const loading = writer.getOrSet(key, async () => {
          calls++
          started.resolve()
          await finish.promise
          return { version: 1 }
        })
        await started.promise
        await invalidator.clear(key)
        finish.resolve()
        expect(await loading).toEqual({ version: 1 })
        await writer.flush()
        expect(await writer.get(key)).toBeNull()
        expect(
          await writer.getOrSet(key, async () => {
            calls++
            return { version: 2 }
          }),
        ).toEqual({ version: 2 })
        expect(calls).toBe(2)
      } finally {
        finish.resolve()
        await writer.close()
        await invalidator.close()
      }
    },
  )

  it('deduplicates concurrent loaders across independent Redis clients', async () => {
    const peer = redis.duplicate()
    const keyPrefix = prefix('distributed')
    const first = new AdaptiveCache({ keyPrefix, logLevel: 'silent' }, redis)
    const second = new AdaptiveCache({ keyPrefix, logLevel: 'silent' }, peer)
    let calls = 0
    const started = gate()
    const finish = gate()
    const load = async () => {
      calls++
      started.resolve()
      await finish.promise
      return 'shared'
    }
    try {
      const one = first.getOrSet('key', load)
      await started.promise
      const two = second.getOrSet('key', load)
      finish.resolve()
      expect(await Promise.all([one, two])).toEqual(['shared', 'shared'])
      expect(calls).toBe(1)
    } finally {
      finish.resolve()
      await first.close()
      await second.close()
      await peer.quit()
    }
  })

  it('namespace invalidation does not affect another namespace', async () => {
    const a = new AdaptiveCache({ keyPrefix: prefix('ns-a'), logLevel: 'silent' }, redis)
    const b = new AdaptiveCache({ keyPrefix: prefix('ns-b'), logLevel: 'silent' }, redis)
    try {
      await a.set('a-entry', 'a')
      await b.set('b-entry', 'b')
      await a.invalidateNamespace()
      expect(await a.get('a-entry')).toBeNull()
      expect((await b.get('b-entry'))?.data).toBe('b')
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('updates tag membership when a cached value is retagged', async () => {
    const cache = new AdaptiveCache({ keyPrefix: prefix('retag'), logLevel: 'silent' }, redis)
    try {
      await cache.set('retagged', 'v1', { tags: ['old'] })
      await cache.set('retagged', 'v2', { tags: ['new'] })
      await cache.invalidateTags(['old'])
      expect((await cache.get('retagged'))?.data).toBe('v2')
      await cache.invalidateTags(['new'])
      expect(await cache.get('retagged')).toBeNull()
    } finally {
      await cache.close()
    }
  })
})
