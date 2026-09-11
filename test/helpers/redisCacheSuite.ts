import type Redis from 'ioredis'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, beforeEach, vi } from 'vitest'

type RedisCacheSuite = { cacheModule: typeof import('../../src'); redisClient: Redis }

// Register inside a suite so each file starts and stops its own Redis instance.
export const registerRedisCacheSuite = (onReady: (suite: RedisCacheSuite) => void) => {
  let cacheModule: RedisCacheSuite['cacheModule']
  let redisClient: Redis
  let container: StartedTestContainer

  beforeAll(async () => {
    // Start Redis container
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()

    const host = container.getHost()
    const port = container.getMappedPort(6379)

    process.env.REDIS_HOST = host
    process.env.REDIS_PORT = port.toString()

    // Import the module after setting env vars
    cacheModule = await import('../../src/index')
    redisClient = cacheModule.redis
    onReady({ cacheModule, redisClient })
  })

  afterAll(async () => {
    if (redisClient) {
      await redisClient.quit()
    }
    if (container) {
      await container.stop()
    }
  })

  beforeEach(async () => {
    await redisClient.flushall()
    vi.restoreAllMocks()
  })
}

export const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 2000) => {
  const start = Date.now()
  let lastError: unknown

  while (Date.now() - start < timeoutMs) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  throw lastError
}
