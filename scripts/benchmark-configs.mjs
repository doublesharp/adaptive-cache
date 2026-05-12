import os from 'node:os'
import { performance } from 'node:perf_hooks'
import Redis from 'ioredis'
import { AdaptiveCache } from '../dist/index.mjs'

const keys = Number(process.env.BENCH_KEYS || 500)
const reads = Number(process.env.BENCH_READS || 10_000)
const payloadBytes = Number(process.env.BENCH_PAYLOAD_BYTES || 2048)
const concurrency = Number(process.env.BENCH_CONCURRENCY || 32)
const redisHost = process.env.REDIS_HOST || '127.0.0.1'
const redisPort = Number(process.env.REDIS_PORT || 6379)
const runId = `bench:${Date.now()}:${Math.random().toString(36).slice(2)}`

const redisOptions = {
  host: redisHost,
  port: redisPort,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: null,
  commandTimeout: 2000,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)
  return sorted[index]
}

const summarize = (durations, totalMs) => {
  const sorted = [...durations].sort((a, b) => a - b)
  const count = durations.length
  const sum = durations.reduce((acc, value) => acc + value, 0)
  return {
    count,
    totalMs,
    opsPerSecond: count / (totalMs / 1000),
    avgMs: sum / count,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
  }
}

const formatNumber = (value, digits = 2) =>
  new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value)

const formatOps = (value) =>
  new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(value)

const makePayload = (index) => {
  const base = {
    id: index,
    stable: true,
    nested: {
      createdAt: '2026-05-12T00:00:00.000Z',
      labels: ['adaptive-cache', 'benchmark', 'payload'],
    },
  }
  const baseLength = Buffer.byteLength(JSON.stringify(base), 'utf8')
  return {
    ...base,
    body: 'x'.repeat(Math.max(0, payloadBytes - baseLength)),
  }
}

const payloads = Array.from({ length: keys }, (_, index) => makePayload(index))
const keyFor = (prefix, index) => `${prefix}:key:${index % keys}:`

const createRedis = async () => {
  const client = new Redis(redisOptions)
  client.on('error', () => undefined)
  await client.connect()
  return client
}

const safeQuitRedis = async (client) => {
  if (client.status === 'end') return
  if (client.status === 'ready') {
    try {
      await client.quit()
      return
    } catch (_err) {
      client.disconnect()
      return
    }
  }
  client.disconnect()
}

const deletePrefix = async (client, prefix) => {
  let cursor = '0'
  do {
    const [nextCursor, matchedKeys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', '1000')
    cursor = nextCursor
    if (matchedKeys.length > 0) {
      await client.del(...matchedKeys)
    }
  } while (cursor !== '0')
}

const measureSequential = async (count, fn) => {
  const durations = []
  const totalStart = performance.now()
  for (let index = 0; index < count; index += 1) {
    const start = performance.now()
    await fn(index)
    durations.push(performance.now() - start)
  }
  return summarize(durations, performance.now() - totalStart)
}

const measureConcurrent = async (count, workerCount, fn) => {
  const durations = []
  let next = 0
  const totalStart = performance.now()

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < count) {
        const index = next
        next += 1
        const start = performance.now()
        await fn(index)
        durations.push(performance.now() - start)
      }
    }),
  )

  return summarize(durations, performance.now() - totalStart)
}

const assertHit = (result, label) => {
  if (!result || !result.data || result.data.stable !== true) {
    throw new Error(`${label} did not return the expected cached payload`)
  }
}

const createCache = async (scenario) => {
  const clients = []
  let client
  if (scenario.usesRedis) {
    client = await createRedis()
    clients.push(client)
  }

  const cache = new AdaptiveCache(
    {
      backend: scenario.backend,
      keyPrefix: scenario.prefix,
      redisPrefix: scenario.prefix,
      initialTTL: 30,
      maxTTL: 600,
      ttlScaling: 2,
      includeDebugHeaders: true,
      compress: true,
      logLevel: 'silent',
      lru: scenario.lru,
    },
    client,
  )

  return {
    cache,
    client,
    cleanup: async () => {
      try {
        await cache.quit?.()
      } catch (_err) {
        // Some benchmark Redis clients disable offline queues to fail fast; if an
        // internal duplicate subscriber is already disconnected, quit can throw.
      }
      await Promise.all(clients.map((redisClient) => safeQuitRedis(redisClient)))
    },
  }
}

const seedCache = async (cache, prefix) => {
  for (let index = 0; index < keys; index += 1) {
    await cache.set(keyFor(prefix, index), payloads[index])
  }
}

const benchmarkScenario = async (scenario) => {
  const redisCleanup = await createRedis()
  await deletePrefix(redisCleanup, scenario.prefix)
  await safeQuitRedis(redisCleanup)

  const { cache, client, cleanup } = await createCache(scenario)
  const memoryBefore = process.memoryUsage().heapUsed

  try {
    const set = await measureSequential(keys, async (index) => {
      await cache.set(keyFor(scenario.prefix, index), payloads[index])
    })

    if (scenario.usesRedis) {
      await sleep(250)
    }

    for (let index = 0; index < Math.min(keys, 100); index += 1) {
      assertHit(await cache.get(keyFor(scenario.prefix, index)), scenario.name)
    }

    const hotSequential = await measureSequential(reads, async (index) => {
      assertHit(await cache.get(keyFor(scenario.prefix, index)), scenario.name)
    })

    const hotConcurrent = await measureConcurrent(reads, concurrency, async (index) => {
      assertHit(await cache.get(keyFor(scenario.prefix, index)), scenario.name)
    })

    global.gc?.()
    const memoryAfter = process.memoryUsage().heapUsed

    if (client) {
      await deletePrefix(client, scenario.prefix)
    }

    return {
      name: scenario.name,
      set,
      hotSequential,
      hotConcurrent,
      heapDeltaBytes: memoryAfter - memoryBefore,
    }
  } finally {
    await cleanup()
  }
}

const benchmarkL1Hydration = async () => {
  const prefix = `${runId}:hydrate`
  const seedClient = await createRedis()
  const readClient = await createRedis()
  await deletePrefix(seedClient, prefix)

  const redisCache = new AdaptiveCache(
    {
      backend: 'redis',
      keyPrefix: prefix,
      redisPrefix: prefix,
      initialTTL: 30,
      maxTTL: 600,
      includeDebugHeaders: true,
      compress: true,
      logLevel: 'silent',
    },
    seedClient,
  )

  const l1Cache = new AdaptiveCache(
    {
      backend: 'l1-redis',
      keyPrefix: prefix,
      redisPrefix: prefix,
      initialTTL: 30,
      maxTTL: 600,
      includeDebugHeaders: true,
      compress: true,
      logLevel: 'silent',
      lru: {
        namespace: `${runId}:hydrate:l1`,
        maxSizeBytes: 64 * 1024 * 1024,
      },
    },
    readClient,
  )

  try {
    await seedCache(redisCache, prefix)

    const firstReadHydrate = await measureSequential(keys, async (index) => {
      assertHit(await l1Cache.get(keyFor(prefix, index)), 'l1-redis cold hydrate')
    })

    const secondReadHot = await measureSequential(reads, async (index) => {
      assertHit(await l1Cache.get(keyFor(prefix, index)), 'l1-redis post-hydrate hot')
    })

    await deletePrefix(seedClient, prefix)

    return {
      firstReadHydrate,
      secondReadHot,
    }
  } finally {
    try {
      await l1Cache.quit?.()
    } catch (_err) {
      // See cleanup note above for disconnected duplicate subscribers.
    }
    try {
      await redisCache.quit?.()
    } catch (_err) {
      // The caller-owned Redis client is closed below.
    }
    await safeQuitRedis(readClient)
    await safeQuitRedis(seedClient)
  }
}

const printMetricTable = (title, rows, accessor) => {
  console.log(`\n${title}`)
  console.log('| configuration | ops/s | avg ms | p50 ms | p95 ms | p99 ms |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const row of rows) {
    if (row.skipped) {
      console.log(`| ${row.name} (${row.skipped}) | skipped | skipped | skipped | skipped | skipped |`)
      continue
    }
    const stats = accessor(row)
    console.log(
      `| ${row.name} | ${formatOps(stats.opsPerSecond)} | ${formatNumber(stats.avgMs, 4)} | ${formatNumber(
        stats.p50Ms,
        4,
      )} | ${formatNumber(stats.p95Ms, 4)} | ${formatNumber(stats.p99Ms, 4)} |`,
    )
  }
}

const main = async () => {
  const redisProbe = await createRedis()
  await redisProbe.ping()
  await safeQuitRedis(redisProbe)

  console.log('# Adaptive cache backend benchmark')
  console.log('')
  console.log(`- host: ${os.hostname()}`)
  console.log(`- platform: ${os.platform()} ${os.release()} ${os.arch()}`)
  console.log(`- cpu: ${os.cpus()[0]?.model || 'unknown'} (${os.cpus().length} logical cores)`)
  console.log(`- node: ${process.version}`)
  console.log(`- redis: ${redisHost}:${redisPort}`)
  console.log(`- keys: ${keys}`)
  console.log(`- reads per read test: ${reads}`)
  console.log(`- concurrent workers: ${concurrency}`)
  console.log(`- target payload bytes before compression: ${payloadBytes}`)
  console.log('')

  const scenarios = [
    {
      name: 'redis',
      backend: 'redis',
      usesRedis: true,
      prefix: `${runId}:redis`,
    },
    {
      name: 'l1-redis',
      backend: 'l1-redis',
      usesRedis: true,
      prefix: `${runId}:l1redis`,
      lru: {
        namespace: `${runId}:l1redis`,
        maxSizeBytes: 64 * 1024 * 1024,
      },
    },
    {
      name: 'l1-redis + localL1',
      backend: 'l1-redis',
      usesRedis: true,
      prefix: `${runId}:l1redis-local`,
      lru: {
        namespace: `${runId}:l1redis-local`,
        maxSizeBytes: 64 * 1024 * 1024,
        localL1: {
          enabled: true,
          experimental: true,
          ttl: 5000,
          maxSize: 8 * 1024 * 1024,
          invalidation: 'broadcast',
        },
      },
      optional: true,
    },
    {
      name: 'clustered-lru',
      backend: 'clustered-lru',
      usesRedis: false,
      prefix: `${runId}:clustered`,
      lru: {
        namespace: `${runId}:clustered`,
        maxSizeBytes: 64 * 1024 * 1024,
      },
    },
  ]

  const rows = []
  for (const scenario of scenarios) {
    try {
      rows.push(await benchmarkScenario(scenario))
    } catch (err) {
      if (!scenario.optional) {
        throw err
      }
      rows.push({
        name: scenario.name,
        skipped: err instanceof Error ? err.message.split('\n')[0] : String(err),
      })
    }
  }

  const hydration = await benchmarkL1Hydration()

  printMetricTable('## Set return latency', rows, (row) => row.set)
  printMetricTable('## Sequential hot read latency', rows, (row) => row.hotSequential)
  printMetricTable('## Concurrent hot read latency', rows, (row) => row.hotConcurrent)

  console.log('\n## L1 Redis cold hydration')
  console.log('| scenario | ops/s | avg ms | p50 ms | p95 ms | p99 ms |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const [label, stats] of [
    ['first read: Redis Lua + L1 hydrate', hydration.firstReadHydrate],
    ['second read: hot L1 after hydrate', hydration.secondReadHot],
  ]) {
    console.log(
      `| ${label} | ${formatOps(stats.opsPerSecond)} | ${formatNumber(stats.avgMs, 4)} | ${formatNumber(
        stats.p50Ms,
        4,
      )} | ${formatNumber(stats.p95Ms, 4)} | ${formatNumber(stats.p99Ms, 4)} |`,
    )
  }

  console.log('\n## Heap delta during scenario')
  console.log('| configuration | heap delta MB |')
  console.log('| --- | ---: |')
  for (const row of rows) {
    if (row.skipped) {
      console.log(`| ${row.name} | skipped |`)
      continue
    }
    console.log(`| ${row.name} | ${formatNumber(row.heapDeltaBytes / 1024 / 1024, 3)} |`)
  }

  console.log('\nNotes:')
  console.log('- Timings are from this Node process on this machine, using single-process benchmark code.')
  console.log(
    '- Redis-backed tests use the configured local Redis and unique benchmark key prefixes; they do not call FLUSHALL.',
  )
  console.log(
    '- l1-redis set timing measures return latency after immediate L1 write; Redis Lua reconciliation runs asynchronously by design.',
  )
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
