# @0xdoublesharp/adaptive-cache

[![npm version](https://img.shields.io/npm/v/@0xdoublesharp/adaptive-cache.svg)](https://www.npmjs.com/package/@0xdoublesharp/adaptive-cache)
[![npm downloads](https://img.shields.io/npm/dm/@0xdoublesharp/adaptive-cache.svg)](https://www.npmjs.com/package/@0xdoublesharp/adaptive-cache)
[![source version](https://img.shields.io/github/package-json/v/doublesharp/adaptive-cache?label=source)](https://github.com/doublesharp/adaptive-cache/blob/main/package.json)
[![CI](https://github.com/doublesharp/adaptive-cache/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/doublesharp/adaptive-cache/actions/workflows/ci.yml)
[![Quality](https://github.com/doublesharp/adaptive-cache/actions/workflows/quality.yml/badge.svg?branch=main)](https://github.com/doublesharp/adaptive-cache/actions/workflows/quality.yml)
[![Coverage](https://github.com/doublesharp/adaptive-cache/actions/workflows/coverage.yml/badge.svg?branch=main)](https://github.com/doublesharp/adaptive-cache/actions/workflows/coverage.yml)
[![Test Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](https://github.com/doublesharp/adaptive-cache/actions/workflows/coverage.yml)
[![Publish](https://github.com/doublesharp/adaptive-cache/actions/workflows/publish.yml/badge.svg)](https://github.com/doublesharp/adaptive-cache/actions/workflows/publish.yml)
[![license](https://img.shields.io/github/license/doublesharp/adaptive-cache.svg)](https://github.com/doublesharp/adaptive-cache/blob/main/LICENSE)

Adaptive server-side caching for Redis, Express, Fastify, and Node clusters.

The default backend keeps Redis as the authoritative cache and adaptive TTL engine. Redis Lua scripts perform the atomic fetch, update, tag, and refresh-lock operations. For lower latency hot reads, the cache can also run with a bounded clustered LRU cache in front of Redis, or as a standalone clustered LRU backend when Redis is not available.

The package does not set HTTP `Cache-Control` headers. It caches server responses and adds diagnostic `X-Cache-*` headers unless disabled.

## Features

- Adaptive TTLs: stable responses live longer; changed responses reset to a short TTL.
- Redis Lua core: atomic Redis fetch/update/lock behavior remains the default and authoritative path.
- Bounded L1 cache: optional `@0xdoublesharp/lru-cache-clustered` hot cache for fast reads with memory limits.
- Async L1 + Redis mode: write L1 immediately, run Redis Lua asynchronously, then reconcile L1 from Redis metadata.
- Standalone clustered LRU mode: volatile no-Redis backend for single-host or single-primary Node cluster deployments.
- Content hashing: SHA-256 response hashes detect changes without comparing payload bodies.
- Compression: gzip + base64 payload storage by default.
- Tags and explicit clears: invalidate by cache key or tag.
- Refresh locks: avoid duplicate expensive refreshes.
- Express and Fastify integrations.
- Direct `AdaptiveCache` API for non-middleware usage.

## Installation

Redis-only usage:

```bash
pnpm add @0xdoublesharp/adaptive-cache
```

Express or Fastify users should also install the framework they use:

```bash
pnpm add express
pnpm add fastify fastify-plugin
```

LRU-backed modes require optional peer dependencies:

```bash
pnpm add @0xdoublesharp/lru-cache-clustered@^2.1.0 lru-cache@^11
```

Redis-only users do not need the LRU packages at runtime.

## Backend Modes

| Backend         | Redis required | Best for                                | Behavior                                                           |
| --------------- | -------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `redis`         | Yes            | Default production mode                 | Redis Lua stores data, metadata, tags, and locks.                  |
| `l1-redis`      | Yes            | Production hot paths                    | Clustered LRU serves hot reads; Redis Lua remains authoritative.   |
| `clustered-lru` | No             | Single-server or one-host Node clusters | Volatile bounded cache with adaptive TTL logic in process/cluster. |
| custom backend  | Depends        | Advanced integrations                   | Provide the `AdaptiveCacheBackend` interface.                      |

### `redis`

This is the default. It uses Redis Lua scripts for:

- Fetching cached data and metadata.
- Updating cached data and adaptive metadata atomically.
- Refresh locks.
- Tag invalidation.

```typescript
import { adaptiveExpressCache } from '@0xdoublesharp/adaptive-cache'

app.get('/api/summary', adaptiveExpressCache(), handler)
```

### `l1-redis`

Use this when Redis exists but hot reads should be served from a bounded local/clustered LRU cache.

```typescript
import { adaptiveExpressCache } from '@0xdoublesharp/adaptive-cache'

app.get(
  '/api/summary',
  adaptiveExpressCache({
    backend: 'l1-redis',
    initialTTL: 5,
    maxTTL: 900,
    lru: {
      namespace: 'api-cache',
      maxSizeBytes: 64 * 1024 * 1024,
      maxEntrySizeBytes: 6 * 1024 * 1024,
    },
  }),
  handler,
)
```

Read path:

1. Check clustered LRU first.
2. On L1 hit, return immediately.
3. On L1 miss, fetch from Redis Lua.
4. On Redis hit, hydrate L1 with Redis remaining TTL and metadata.
5. On Redis miss, continue to the handler.

Write path:

1. Encode/compress once and hash the response.
2. Store in L1 immediately with `initialTTL`.
3. Run Redis Lua update asynchronously.
4. When Redis returns, reconcile L1 with Redis' authoritative adaptive TTL and metadata.
5. If Redis update fails, keep the short-lived L1 entry and log the failure.

Invalidation:

- Explicit clears remove L1 first, then Redis, then publish an invalidation message.
- Tag invalidation removes matching L1 entries and Redis entries.
- Redis update publishes L1 invalidation only when content changed.
- Other server-local L1 caches subscribe to Redis invalidation messages and delete stale keys.

Locks:

- `l1-redis` uses Redis Lua locks as the distributed lock authority.

### `clustered-lru`

Use this when Redis is not available and a volatile bounded backend is still useful.

```typescript
import { adaptiveFastifyCache } from '@0xdoublesharp/adaptive-cache'

await fastify.register(
  adaptiveFastifyCache({
    backend: 'clustered-lru',
    initialTTL: 5,
    maxTTL: 300,
    lru: {
      namespace: 'api-cache',
      maxSizeBytes: 64 * 1024 * 1024,
    },
  }),
)
```

This mode keeps adaptive metadata in clustered LRU envelopes. It is fast and memory-bounded, but it is not cross-host durable. Treat it as process/host-local cache state.

Locks:

- `clustered-lru` uses LRU lock keys scoped to the local Node cluster primary.

## LRU Memory Limits

`l1-redis` and `clustered-lru` store an envelope in clustered LRU:

- Encoded payload.
- Response hash.
- Adaptive metadata: `dataTTL`, `lastChanged`, `changeCount`.
- Created/updated timestamps.
- Expiration timestamp.
- Tags.

Defaults:

| Option                  | Default               | Description                                          |
| ----------------------- | --------------------- | ---------------------------------------------------- |
| `lru.maxSizeBytes`      | `64 * 1024 * 1024`    | Total LRU size budget.                               |
| `lru.maxEntrySizeBytes` | 10% of `maxSizeBytes` | Entries larger than this are skipped for L1 storage. |
| `lru.timeout`           | package default       | Clustered LRU operation timeout.                     |
| `lru.failsafe`          | `'reject'`            | Clustered LRU failure behavior.                      |
| `lru.namespace`         | `'adaptive-cache'`    | Shared cache namespace.                              |

Entry size is estimated as encoded payload bytes plus tag metadata and a small fixed metadata overhead. TTLs passed to clustered LRU are milliseconds; adaptive cache options use seconds.

## LRU Cache Clustered v2.1 Local L1

The `lru.localL1` option is passed through to `@0xdoublesharp/lru-cache-clustered` v2.1.0+ for per-worker local L1 caching.

```typescript
adaptiveExpressCache({
  backend: 'l1-redis',
  lru: {
    namespace: 'api-cache',
    maxSizeBytes: 64 * 1024 * 1024,
    localL1: {
      enabled: true,
      experimental: true,
      ttl: 2_000,
      maxSize: 4 * 1024 * 1024,
      invalidation: 'broadcast',
      methods: {
        get: true,
        has: true,
        fetch: true,
        memoize: true,
      },
    },
  },
})
```

You can also pass `localL1: true` when using `@0xdoublesharp/lru-cache-clustered` v2.1.0 or newer.

## Express Usage

```typescript
import express from 'express'
import { adaptiveExpressCache } from '@0xdoublesharp/adaptive-cache'

const app = express()

app.get(
  '/api/items',
  adaptiveExpressCache({
    initialTTL: 10,
    maxTTL: 3600,
    ttlScaling: 1.5,
    includeDebugHeaders: true,
  }),
  async (_req, res) => {
    const items = await loadItems()
    res.json(items)
  },
)
```

### Dynamic `maxTTL`

`maxTTL` can be a function. Middleware resolves it after your handler returns.

```typescript
app.get(
  '/api/items/:id',
  adaptiveExpressCache({
    initialTTL: 60,
    maxTTL: (data) => (data.status === 'ended' ? 86400 : 300),
  }),
  async (req, res) => {
    res.json(await loadItem(req.params.id))
  },
)
```

### Tags

Tags can be static or request-derived.

```typescript
app.get(
  '/api/users/:id',
  adaptiveExpressCache({
    tags: (req) => [`user:${req.params.id}`, 'users'],
  }),
  async (req, res) => {
    res.json(await loadUser(req.params.id))
  },
)
```

Clear by tag:

```typescript
import { getDefaultCache } from '@0xdoublesharp/adaptive-cache'

await getDefaultCache().invalidateTags(['users'])
```

Clear one computed middleware key:

```typescript
import { clearAdaptiveCache } from '@0xdoublesharp/adaptive-cache'

await clearAdaptiveCache('/api/users/123', {}, 'adaptive:')
```

For non-default backends, pass backend options to `clearAdaptiveCache`:

```typescript
await clearAdaptiveCache('/api/users/123', {}, 'adaptive:', {
  backend: 'clustered-lru',
  lru: { namespace: 'api-cache' },
})
```

## Fastify Usage

```typescript
import Fastify from 'fastify'
import { adaptiveFastifyCache } from '@0xdoublesharp/adaptive-cache'

const fastify = Fastify()

await fastify.register(
  adaptiveFastifyCache({
    backend: 'l1-redis',
    initialTTL: 10,
    maxTTL: 3600,
    ttlScaling: 1.5,
    includeDebugHeaders: true,
    lru: {
      namespace: 'fastify-api',
      maxSizeBytes: 64 * 1024 * 1024,
    },
  }),
)

fastify.get('/api/summary', async () => {
  return await loadSummary()
})
```

## Direct API

Use `AdaptiveCache` outside Express/Fastify.

```typescript
import { AdaptiveCache } from '@0xdoublesharp/adaptive-cache'

const cache = new AdaptiveCache({
  backend: 'l1-redis',
  includeDebugHeaders: true,
  lru: { namespace: 'jobs' },
})

await cache.set('job:summary', { total: 42 }, { tags: ['jobs'] })

const hit = await cache.get('job:summary')
if (hit) {
  console.log(hit.data, hit.ttl, hit.metadata)
}
```

### Generic Function Caching

`cacheResult` is a simple Redis helper for non-adaptive function results. It uses the default Redis client directly and does not use the adaptive backend layer.

```typescript
import { cacheResult } from '@0xdoublesharp/adaptive-cache'

const data = await cacheResult('expensive-report', 60, async () => {
  return await buildReport()
})
```

### Refresh Locks

Use refresh locks to prevent many workers from refreshing the same expensive resource at once.

```typescript
import { releaseCacheRefreshLock, shouldRefreshCache } from '@0xdoublesharp/adaptive-cache'

const result = await shouldRefreshCache('report:last-update', 60)

if (result[0] === 'UPDATE') {
  const lockValue = result[1]
  try {
    await rebuildReport()
  } finally {
    await releaseCacheRefreshLock('report:last-update', lockValue)
  }
}
```

`lockExpirationSeconds` defaults to `60`. You can set a process-wide default:

```typescript
import { setDefaultLockExpirationSeconds } from '@0xdoublesharp/adaptive-cache'

setDefaultLockExpirationSeconds(120)
```

Or pass a per-call value:

```typescript
await shouldRefreshCache('report:last-update', 60, false, 120)
```

## Configuration

| Option                  | Type                                                               | Default       | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------- |
| `initialTTL`            | `number`                                                           | `5`           | Starting cache duration in seconds.                                                   |
| `maxTTL`                | `number \| (data) => number \| undefined`                          | `900`         | Maximum data TTL in seconds. Middleware can resolve it from response data.            |
| `ttlScaling`            | `number`                                                           | `2`           | Factor used to grow TTL when content is unchanged. Growth is damped by `changeCount`. |
| `redisPrefix`           | `string`                                                           | `'adaptive:'` | Prefix for Redis keys and invalidation channels.                                      |
| `keyPrefix`             | `string`                                                           | unset         | Clearer alias for `redisPrefix`; applies to Redis and non-Redis backends.             |
| `includeHeaders`        | `boolean`                                                          | `true`        | Add `X-Cache` and `X-Cache-TTL`.                                                      |
| `includeDebugHeaders`   | `boolean`                                                          | `false`       | Add adaptive metadata headers.                                                        |
| `forceRefresh`          | `boolean`                                                          | `false`       | Bypass existing cache reads and refresh after the handler response.                   |
| `lockExpirationSeconds` | `number`                                                           | `60`          | Refresh lock expiration in seconds.                                                   |
| `metaTTL`               | `number`                                                           | `604800`      | Metadata/tag TTL in seconds.                                                          |
| `compress`              | `boolean`                                                          | `true`        | Gzip payloads and store them as base64.                                               |
| `logLevel`              | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'`               | `'info'`      | Logger verbosity.                                                                     |
| `backend`               | `'redis' \| 'l1-redis' \| 'clustered-lru' \| AdaptiveCacheBackend` | `'redis'`     | Cache backend.                                                                        |
| `lru`                   | `AdaptiveCacheLruOptions`                                          | unset         | LRU options for `l1-redis` and `clustered-lru`.                                       |

## Headers

| Header                  | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `X-Cache: HIT`          | Cached response returned.                                              |
| `X-Cache: MISS`         | No cache entry; handler ran.                                           |
| `X-Cache: BYPASS`       | Cache read skipped because `forceRefresh` or `?refresh=true` was used. |
| `X-Cache: RETRY`        | Cache read/decode failed; handler ran without failing the request.     |
| `X-Cache-TTL`           | Remaining data TTL in seconds.                                         |
| `X-Cache-Data-TTL`      | Debug: adaptive TTL assigned to the data version.                      |
| `X-Cache-Last-Modified` | Debug: Unix timestamp when content last changed, or `unknown`.         |
| `X-Cache-Refreshed`     | Debug: content change count.                                           |

## Redis Keys and Lua Metadata

Given an adaptive key, this package uses:

- `${key}data`: encoded payload.
- `${key}meta`: adaptive metadata hash.
- `${redisPrefix}tag:${tag}`: Redis set of keys for tag invalidation.
- `${redisPrefix}l1:invalidate`: Redis Pub/Sub channel for L1 invalidations.
- `${lastUpdateKey}-lock`: refresh lock key.

Lua fetch returns:

```text
[data, remainingTTL, dataTTL, lastChanged, changeCount, hash]
```

Lua update returns:

```text
['CACHED', dataTTL, lastChanged, changeCount, hash, changedFlag]
```

The original leading tuple fields are preserved for compatibility. New metadata fields are appended so L1 caches can hydrate from Redis without extra round trips.

## Adaptive TTL Formula

On changed content:

- `changeCount += 1`
- `dataTTL = initialTTL`
- `lastChanged = now`

On unchanged content:

- If `dataTTL >= maxTTL`, keep `maxTTL`.
- Otherwise compute a damped increase:

```text
decayFactor = 1.0 - min(0.9, changeCount * 0.01)
increaseFactor = max(0, ttlScaling - 1)
increase = ceil(floor(dataTTL * increaseFactor) * decayFactor)
dataTTL = max(initialTTL, min(dataTTL + increase, maxTTL))
```

## Environment Variables

| Variable        | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `REDIS_TLS_URL` | Preferred Redis TLS connection string.                            |
| `REDIS_URL`     | Redis connection string. Used when `REDIS_TLS_URL` is not set.    |
| `REDIS_HOST`    | Redis host fallback. Defaults to `localhost`.                     |
| `REDIS_PORT`    | Redis port fallback. Defaults to `6379`.                          |
| `CACHE_TIME`    | Default duration string for `cache()`, for example `"5 seconds"`. |

In `NODE_ENV=production`, Redis URL clients are created with TLS options.

## Custom Backends

Advanced users can provide a backend object instead of a backend name.

```typescript
import type { AdaptiveCacheBackend } from '@0xdoublesharp/adaptive-cache'

const backend: AdaptiveCacheBackend = {
  name: 'custom',
  async fetch(input) {
    return null
  },
  async update(input) {
    return ['CACHED', input.initialTTL]
  },
  async clear(key, dataKey) {},
  async invalidateTags(tags, redisPrefix) {
    return []
  },
  async shouldRefresh(lastUpdateKey, refreshThreshold, currentTime, force, lockExpirationSeconds, lockValue) {
    return ['UPDATE', lockValue]
  },
  async releaseLock(lastUpdateKey, currentTime, lockValue) {
    return ['UPDATED']
  },
}
```

## Operational Notes

- Redis is the durable, cross-host authority in `redis` and `l1-redis` modes.
- `clustered-lru` is volatile and local to the host/Node cluster.
- L1 entries are intentionally short-lived until Redis Lua returns the authoritative adaptive TTL.
- Oversized entries are skipped for L1 storage rather than risking unbounded server memory growth.
- `l1-redis` invalidation uses Redis Pub/Sub, so processes must share the same Redis and prefix to invalidate each other.
- `redisPrefix` still works; prefer `keyPrefix` for new code when you want a backend-neutral name.

## Development

```bash
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run test:coverage
pnpm run quality
pnpm run build
pnpm run bench:configs
```

`pnpm run test` runs the full suite, including Redis/Testcontainers integration tests.

`pnpm run test:coverage` runs the deterministic source coverage suite and currently verifies:

```text
Statements : 100%
Branches   : 100%
Functions  : 100%
Lines      : 100%
```

`pnpm run quality` runs lint, typecheck, coverage, and build.

`pnpm run bench:configs` compares `redis`, `l1-redis`, and `clustered-lru` behavior against a local Redis using unique benchmark key prefixes. It does not call `FLUSHALL`.

## License

MIT. See `package.json` for package metadata.
