import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import Redis from 'ioredis'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { fuzzParameters, fuzzTimeoutMs } from './helpers/fuzz'

const keys = ['fuzz:a:', 'fuzz:b:', 'fuzz:雪:', 'fuzz:__proto__:'] as const
const tags = ['one', 'two', '雪', '__proto__'] as const
const key = fc.constantFrom(...keys)
const tagList = fc.uniqueArray(fc.constantFrom(...tags), { maxLength: tags.length })
const value = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.record({ name: fc.string({ maxLength: 20 }), scores: fc.array(fc.integer(), { maxLength: 6 }) }),
  fc.uint8Array({ maxLength: 40 }).map((bytes) => Buffer.from(bytes)),
)
const operation = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('set'), key, value, tags: tagList }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('get'), key }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('clear'), key }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('tags'), tags: tagList }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('namespace') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('fenced-write'), key, value }) },
)

describe('cache state invariants', () => {
  let container: StartedTestContainer
  let redis: Redis
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
    await redis.ping()
  })
  afterAll(async () => {
    try {
      await redis?.quit()
    } finally {
      redis?.disconnect()
      await container?.stop()
    }
  })

  it.each(['redis', 'l1-redis', 'clustered-lru'] as const)(
    '%s matches a reference model through arbitrary writes and invalidations',
    async (backend) => {
      await fc.assert(
        fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 40 }), async (operations) => {
          // This container belongs to this file; each generated scenario starts empty.
          await redis.flushall()
          const cache = new AdaptiveCache(
            {
              backend,
              keyPrefix: 'fuzz:',
              initialTTL: 60,
              maxTTL: 60,
              compress: false,
              logLevel: 'silent',
              l1Redis: { writeMode: 'await-redis' },
              lru: { namespace: randomUUID(), maxSizeBytes: 1024 * 1024 },
            },
            backend === 'clustered-lru' ? undefined : redis,
          )
          const model = new Map<string, { value: unknown; tags: string[] }>()
          try {
            for (const operation of operations) {
              switch (operation.kind) {
                case 'set':
                  await cache.set(operation.key, operation.value, { tags: operation.tags })
                  model.set(operation.key, { value: operation.value, tags: operation.tags })
                  break
                case 'get':
                  expect((await cache.get(operation.key))?.data).toEqual(model.get(operation.key)?.value)
                  break
                case 'clear':
                  await cache.clear(operation.key)
                  model.delete(operation.key)
                  break
                case 'tags':
                  await cache.invalidateTags(operation.tags)
                  for (const [key, entry] of model) {
                    if (entry.tags.some((tag) => operation.tags.some((candidate) => candidate === tag)))
                      model.delete(key)
                  }
                  break
                case 'namespace':
                  await cache.invalidateNamespace()
                  model.clear()
                  break
                case 'fenced-write': {
                  const token = await cache.captureWriteToken()
                  await cache.clear(operation.key)
                  model.delete(operation.key)
                  expect((await cache.set(operation.key, operation.value, { writeToken: token }))[0]).toBe(
                    'INVALIDATED',
                  )
                  break
                }
              }
              // Check every key after every operation, including keys it should leave alone.
              // Batch the invariant snapshot; generated get operations still exercise get().
              const snapshot = await cache.getMany([...keys])
              expect([...snapshot.keys()]).toEqual(keys)
              for (const key of keys) {
                const actual = snapshot.get(key)
                if (model.has(key)) expect(actual?.data).toEqual(model.get(key)!.value)
                else expect(actual).toBeNull()
              }
            }
            await Promise.all([cache.close(), cache.quit(), cache.close()])
            await expect(cache.get(keys[0])).rejects.toThrow('closed')
            await expect(cache.set(keys[0], 'late')).rejects.toThrow('closed')
            expect(await redis.ping()).toBe('PONG')
          } finally {
            await cache.close()
          }
        }),
        fuzzParameters,
      )
    },
    fuzzTimeoutMs,
  )
})
