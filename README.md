# @0xdoublesharp/adaptive-cache

[![npm version](https://img.shields.io/npm/v/@0xdoublesharp/adaptive-cache.svg)](https://www.npmjs.com/package/@0xdoublesharp/adaptive-cache)
[![npm downloads](https://img.shields.io/npm/dm/@0xdoublesharp/adaptive-cache.svg)](https://npm-stat.com/charts.html?package=%400xdoublesharp%2Fadaptive-cache)
[![CI](https://github.com/doublesharp/adaptive-cache/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/doublesharp/adaptive-cache/actions?query=workflow%3ACI+branch%3Amain)
[![coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fdoublesharp.github.io%2Fadaptive-cache%2Fcoverage-badge.json)](https://doublesharp.github.io/adaptive-cache/coverage/)
[![license](https://img.shields.io/github/license/doublesharp/adaptive-cache.svg)](https://github.com/doublesharp/adaptive-cache/blob/main/LICENSE)

Server-side response caching for APIs that need fast reads without hand-tuning every TTL.

`@0xdoublesharp/adaptive-cache` caches Express, Fastify, and direct `AdaptiveCache` results. It hashes response bodies, tracks whether content changes, and automatically grows TTLs for stable data while resetting TTLs for volatile data.

Redis remains the default authoritative backend through Lua scripts. To keep hot payloads in memory, add a bounded clustered LRU cache in front of Redis. L1 hits still validate invalidation state against Redis. For single-server or one-host Node cluster deployments, the clustered LRU backend can run without Redis.

See [loading, freshness, and cache policy](docs/cache-features.md) for `getOrSet`, stale refresh, negative caching, typed/bulk APIs, write fencing, selective compression, events, and HTTP identity controls.

The feature guide and examples below describe version 0.1.1. See the [0.1.1 release notes](CHANGELOG.md#011---2026-09-11) for batching and dependency fixes, and [0.1.0 release notes](CHANGELOG.md#010---2026-09-10) for new APIs and behavior since 0.0.6; see [release history and upgrade instructions](docs/releases.md) before deploying them.

This package does not generate HTTP `Cache-Control` headers. It honors storage restrictions and replays eligible cached headers. It caches server responses and adds diagnostic `X-Cache-*` headers unless disabled.

## Use It For

| Need                         | What the module does                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| API responses that stabilize | Increases TTL when response hashes stay the same.                                    |
| API responses that change    | Resets TTL when content changes, so volatile data does not stay stale for long.      |
| Cross-host correctness       | Uses Redis Lua as the atomic authority for payloads, metadata, tags, and locks.      |
| Hot payloads in memory       | Keeps hot payloads in bounded L1 memory with a Redis validation round trip.          |
| No-Redis deployments         | Provides a volatile `clustered-lru` backend for single-server or one-host clusters.  |
| Expensive refreshes          | Coalesces `getOrSet` loaders and fences Redis writes after lease loss.               |
| Targeted invalidation        | Invalidates keys, tags, or namespaces and rejects obsolete Redis writes.             |
| Memory safety                | Sets L1 size budgets and skips entries that are too large for the configured budget. |

Use `getOrSet` for expensive work that needs coalescing, stale refresh, or negative caching. Use ordinary middleware when a route only needs response caching. Stale background refresh requires an explicit loader.

## Architecture

![Adaptive Cache architecture](docs/adaptive-cache-architecture.svg)

## Feature Matrix

| Capability                     | `redis` | `l1-redis` | `clustered-lru` |
| ------------------------------ | :-----: | :--------: | :-------------: |
| Adaptive TTL growth/reset      |   Yes   |    Yes     |       Yes       |
| Redis Lua atomic metadata      |   Yes   |    Yes     |       No        |
| Bounded L1 hot reads           |   No    |    Yes     |       Yes       |
| Cross-host cache state         |   Yes   |    Yes     |       No        |
| Tag invalidation               |   Yes   |    Yes     |       Yes       |
| Refresh locks                  |   Yes   |    Yes     |   Host-local    |
| Works without Redis            |   No    |     No     |       Yes       |
| Recommended production default |   Yes   |  Hot APIs  |   Single host   |

All built-in backends support typed/bulk APIs, stale windows, negative caching, selective compression, and events. Redis-backed modes provide atomic loader lease and write-token checks. Clustered LRU provides host-local coordination with weaker write/release guarantees.

## Installation

Requires Node.js 22 or newer.

Redis-only usage:

```bash
pnpm add @0xdoublesharp/adaptive-cache
```

Express or Fastify users should also install the framework they use:

```bash
pnpm add express
pnpm add fastify
```

LRU-backed modes require optional peer dependencies:

```bash
pnpm add @0xdoublesharp/lru-cache-clustered@^2.1.1 lru-cache@^11
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

1. Read Redis invalidation barriers and check clustered LRU.
2. On a valid L1 hit, return the payload without fetching or decoding it from Redis.
3. On L1 miss, fetch from Redis Lua.
4. On Redis hit, hydrate L1 with Redis remaining TTL and metadata.
5. On Redis miss, continue to the handler.

Write path:

1. Encode/compress once and hash the response.
2. Store in L1 immediately with `initialTTL`.
3. Run Redis Lua update asynchronously.
4. When Redis returns, reconcile L1 with Redis' authoritative adaptive TTL and metadata.
5. If Redis update fails, keep the short-lived L1 entry and log the failure.

For shutdown-sensitive workers, use `l1Redis.writeMode: 'await-redis'` to wait for Redis before `set()` resolves, or call `cache.flush()` before process shutdown to wait for pending async Redis writes.

Loader writes, middleware writes, and asynchronous compression wait for Redis to accept their write token. Ordinary synchronous `set()` calls retain the optimistic write path above. Every L1 hit validates its token against Redis, including when a Pub/Sub message was missed. This adds a Redis round trip to hot reads in exchange for stronger invalidation guarantees.

Invalidation:

- Explicit clears drain pending writes on the shared Redis client, delete Redis data, drain active L1 hydrations, remove L1 entries, then publish an invalidation message.
- Reads that overlap an invalidation cannot hydrate an older snapshot back into L1.
- Tag invalidation removes matching L1 entries and Redis entries.
- Redis update publishes L1 invalidation only when content changed.
- Other server-local L1 caches subscribe to Redis invalidation messages and delete stale keys.
- Namespace and write barriers prevent invalidated in-flight work from becoming a later cache hit.

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

This mode keeps adaptive metadata in separate bounded LRU entries for `metaTTL`, so unchanged data can increase its TTL after the payload expires. It is fast and memory-bounded, but it is not cross-host durable. Treat it as process/host-local cache state.

Locks:

- `clustered-lru` acquires locks atomically on the local Node cluster primary. Lock release is best-effort: the dependency has no atomic compare-and-delete operation, so release can race with an expired or force-replaced lock. Use a Redis-backed backend when strict refresh coordination is required.

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

The `lru.localL1` option is passed through to `@0xdoublesharp/lru-cache-clustered` v2.1.1+ for per-worker local L1 caching.

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

You can also pass `localL1: true` when using `@0xdoublesharp/lru-cache-clustered` v2.1.1 or newer.

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

await cache.set('adaptive:job:summary', { total: 42 }, { tags: ['jobs'] })

const hit = await cache.get<{ total: number }>('adaptive:job:summary')
if (hit) {
  console.log(hit.data, hit.ttl, hit.metadata)
}

await cache.flush()
await cache.close()
```

Direct API keys are complete keys. `keyPrefix` selects coordination and invalidation state but does not prepend text to a direct key. Middleware constructs prefixed keys automatically.

Payloads are stored in a versioned envelope so direct API calls can round-trip JSON values, strings, buffers, and `undefined`. Middleware caches eligible successful GET responses with their status, selected headers, and original body. JSON-looking text and binary responses retain their representation on a hit. Other methods and Node/WHATWG streams bypass caching. HTTP 404 responses require an explicit `negativeTTL`. Existing body-only cache entries remain readable until they expire.

### Coalesced loading and stale refresh

```typescript
const cache = new AdaptiveCache({
  keyPrefix: 'catalog:v2:',
  initialTTL: 10,
  maxTTL: 300,
  staleWhileRevalidate: 30,
  staleIfError: 120,
  ttlJitter: 0.1,
  compression: { minBytes: 1024, async: true, skipCompressed: true, onlyIfSmaller: true },
})

const product = await cache.getOrSet('catalog:v2:product:42', () => loadProduct('42'), {
  tags: ['products'],
  negativeTTL: 5,
})
const hits = await cache.getMany(['catalog:v2:product:42', 'catalog:v2:product:43'])
await cache.invalidateTags(['products'])
await cache.invalidateNamespace()
await cache.close()
```

`getMany()` uses batched payload and primary invalidation checks on clustered LRU. Results and events remain per key; the call is not a transaction. See the [batch-read report](docs/batched-reads-0.1.1.md) for measured gains and backend compatibility.

Stale windows are measured independently from freshness expiry. Plain `get()` returns fresh entries only; `get(key, { allowStale: true })` exposes retained stale data. Negative entries have no stale window. See the [feature guide](docs/cache-features.md) for force-refresh behavior, events, fingerprints, bulk operations, and custom backend limits.

### HTTP identity and response policy

Range and If-Range requests bypass caching, and partial `206` responses are not stored. Authorization and Cookie requests bypass caching unless explicitly enabled with a key or variation that isolates the caller. Responses with `Cache-Control: private` or `no-store`, `Set-Cookie`, `Vary: *`, or undeclared `Vary` headers are excluded. Declare `varyBy: ['Accept-Encoding']` when compression middleware adds that response header.

```typescript
const products = adaptiveExpressCache({
  keyPrefix: 'catalog:v2:',
  key: (req) => `product:${req.params?.id}`,
  varyBy: ['Accept-Language'],
  loader: (req) => loadProduct(req.params?.id),
  staleWhileRevalidate: 30,
})
app.get('/products/:id', products)

// During shutdown, after accepting no further requests:
await products.close()
```

Fastify accepts the same policy options and closes owned caches in its `onClose` hook. Both adapters accept `cache` to reuse a caller-owned instance. Keep that instance's namespace aligned with the middleware prefix. Use `products.clear(request)` to invalidate a response using the same custom key and header variations as the adapter. See [HTTP identity and ownership](docs/cache-features.md#http-identity-and-ownership).

### Generic function caching

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
| `metaTTL`               | `number`                                                           | `604800`      | Metadata/tag TTL in positive integer seconds.                                         |
| `compress`              | `boolean`                                                          | `true`        | Gzip payloads and store them as base64.                                               |
| `logLevel`              | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'`               | `'info'`      | Logger verbosity.                                                                     |
| `backend`               | `'redis' \| 'l1-redis' \| 'clustered-lru' \| AdaptiveCacheBackend` | `'redis'`     | Cache backend.                                                                        |
| `lru`                   | `AdaptiveCacheLruOptions`                                          | unset         | LRU options for `l1-redis` and `clustered-lru`.                                       |
| `l1Redis.writeMode`     | `'async' \| 'await-redis'`                                         | `'async'`     | Whether `l1-redis` returns after L1 write or waits for Redis reconciliation.          |
| `ignoreQueryParams`     | `string[]`                                                         | `['refresh']` | Query parameters excluded from middleware cache-key hashes.                           |

Additional options shared by the cache and adapters:

| Option                         | Default | Purpose                                                                                        |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `staleWhileRevalidate`         | `0`     | Seconds after freshness expiry during which a loader can refresh in the background.            |
| `staleIfError`                 | `0`     | Independent seconds after freshness expiry during which a failed loader may return stale data. |
| `negativeTTL`                  | `0`     | Opt-in TTL for null/undefined loader results or normal-handler HTTP 404 responses.             |
| `lockWaitTimeoutMs`            | `5000`  | Maximum loader lock wait in milliseconds.                                                      |
| `ttlJitter`                    | `0`     | Fraction from 0 to 1 by which to randomly shorten freshness.                                   |
| `fingerprint` / `ignoreFields` | unset   | Custom content fingerprint or dotted fields excluded from the hash.                            |
| `compression`                  | unset   | `minBytes`, `async`, `skipCompressed`, and `onlyIfSmaller` selective codec settings.           |
| `onEvent`                      | unset   | Observer for cache activity; also available through `cache.onEvent()`.                         |

HTTP-only options are `cache`, `loader`, `key`, `varyBy`, `shouldCache`, `cacheAuthenticated`, `cacheCookies`, and request-derived `tags`. Defaults bypass authenticated/cookie requests and use path/query keys. See the [feature guide](docs/cache-features.md) for examples and per-call overrides.

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

- `${key}data`: versioned Redis envelope containing encoded payload, freshness, namespace generation, tags, and tag epochs.
- `${key}data:state`: auxiliary freshness and tag membership state.
- `${key}meta`: adaptive metadata hash.
- `${redisPrefix}tag:${tag}`: Redis set of keys for tag invalidation.
- `${redisPrefix}l1:invalidate`: Redis Pub/Sub channel for L1 invalidations.
- `${lastUpdateKey}-lock`: refresh lock key.
- `${redisPrefix}__adaptive:namespace`, `${redisPrefix}__adaptive:barrier`, and `${redisPrefix}__adaptive:tag-epoch:${tag}`: invalidation control keys.
- `__adaptive:legacy-barrier`: shared barrier for clears without namespace information.

Lua fetch returns:

```text
[data, remainingTTL, dataTTL, lastChanged, changeCount, hash, staleFlag, staleAgeMs]
```

Lua update returns:

```text
['CACHED', dataTTL, lastChanged, changeCount, hash, changedFlag]
```

Fetch preserves the original leading fields and appends stale state. The public hit reports `staleAge` in seconds. A rejected write returns `['INVALIDATED', 0]`. These internal Lua results do not imply wire-format compatibility with older readers; see the [upgrade notes](docs/releases.md#upgrading-from-006).

## TTL policies

The default policy preserves the existing TTL growth/reset behavior. Opt into additive increase/multiplicative decrease with `ttlPolicy: { type: 'aimd' }`, or time-aware smoothing with `ttlPolicy: { type: 'ewma' }`. Both are available on all built-in backends. See [TTL policies](docs/ttl-policies.md) for parameters, formulas, and observation limits.

## Default adaptive TTL formula

On changed content:

- `changeCount += 1`
- `dataTTL = min(initialTTL, maxTTL)`
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

After either path, clamp `dataTTL` to `maxTTL`. Optional jitter shortens freshness; stale retention extends physical storage without extending the fresh TTL.

## Environment Variables

| Variable                        | Description                                                       |
| ------------------------------- | ----------------------------------------------------------------- |
| `REDIS_TLS_URL`                 | Preferred Redis TLS connection string.                            |
| `REDIS_URL`                     | Redis connection string. Used when `REDIS_TLS_URL` is not set.    |
| `REDIS_HOST`                    | Redis host fallback. Defaults to `localhost`.                     |
| `REDIS_PORT`                    | Redis port fallback. Defaults to `6379`.                          |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | Set to `false` to disable Redis TLS certificate verification.     |
| `REDIS_INSECURE_TLS`            | Set to `true` to disable Redis TLS certificate verification.      |
| `CACHE_TIME`                    | Default duration string for `cache()`, for example `"5 seconds"`. |

TLS options are applied only for `REDIS_TLS_URL` or `rediss://` URLs. Certificate verification is enabled by default.

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
  async clear(key, dataKey, metaKey) {},
  async invalidateTags(tags, redisPrefix) {
    return []
  },
  async shouldRefresh(lastUpdateKey, refreshThreshold, currentTime, force, lockExpirationSeconds, lockValue) {
    return ['UPDATE', lockValue]
  },
  async releaseLock(lastUpdateKey, currentTime, lockValue) {
    return ['UPDATED']
  },
  async flush() {},
}
```

Custom backends can implement `captureWriteToken`, `invalidateNamespace`, and `onEvent`. `getOrSet` requires write-token support, and `supportsWriteFencing()` reports whether that method exists. It does not certify distributed atomicity: the backend must enforce tokens and leases during writes. A backend without namespace invalidation fails explicitly when that operation is requested.

## Operational Notes

- Redis is the cross-host authority in `redis` and `l1-redis` modes. Persistence depends on the Redis deployment configuration.
- `clustered-lru` is volatile and local to the host/Node cluster.
- L1 entries are intentionally short-lived until Redis Lua returns the authoritative adaptive TTL.
- Oversized entries are skipped for L1 storage rather than risking unbounded server memory growth.
- `l1-redis` invalidation uses Redis Pub/Sub, so processes must share the same Redis and prefix to invalidate each other.
- `?refresh=true` bypasses reads but is ignored when computing the cache key, so refresh requests update the normal key.
- Explicit `clear(key)` removes data, metadata, and auxiliary state and cleans recorded tag memberships. Namespace invalidation advances a generation without scanning payloads; old payloads expire normally.
- Call `cache.flush()` before shutdown if you use default async `l1-redis` writes and need to wait for pending Redis reconciliation.
- `redisPrefix` still works; prefer `keyPrefix` for new code when you want a backend-neutral name.

## Development

Dependency resolution uses a seven-day minimum release age, configured as `minimumReleaseAge: 10080` in `pnpm-workspace.yaml`. Do not add release-age exclusions. Run `pnpm update --latest` to select eligible updates, then check peer compatibility and run the quality gate. The current toolchain keeps TypeScript at 6.0.3 because the installed ESLint parser declares support below 6.1.

Implementation files follow responsibility boundaries: `AdaptiveCache.ts` owns the public API and lifecycle; `CacheLoader.ts` handles coalescing, freshness windows, and loader locks; `payload.ts` handles fingerprints and codecs. TTL policy validation and calculations have dedicated modules. HTTP adapters use shared policy/response helpers, and `backends/lruEnvelope.ts` contains LRU TTL and envelope calculations. Tests are grouped by backend, loader behavior, response policy, and lifecycle, with fixtures under `test/helpers`.

Keep new behavior in the module that owns it. Split files when they accumulate distinct responsibilities, and preserve behavioral tests when moving code.

Every Vitest test must contain an assertion. Prefer stored state and real HTTP responses over log-only or mock-only checks.

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

`pnpm run test:coverage` runs the full suite, including Redis/Testcontainers integration tests, and currently verifies:

```text
Statements : 100%
Branches   : 100%
Functions  : 100%
Lines      : 100%
```

`pnpm run quality` runs lint, typecheck, coverage, build, and built-declaration consumer checks.

`pnpm run bench:lru` measures primary-process and real worker-process clustered LRU operations, with and without local L1. It also checks retained worker invalidation and delivered IPC requests under backpressure. See the [2.1.1 dependency evaluation](docs/lru-cache-clustered-2.1.1.md) for comparison results.

`pnpm run bench:configs` compares `redis`, `l1-redis`, and `clustered-lru` behavior against a local Redis using unique benchmark key prefixes. It does not call `FLUSHALL`.

## Releases and verification

[CHANGELOG.md](CHANGELOG.md) records changes through version 0.1.1. [Release history and process](docs/releases.md) records the source revisions, migration steps, and release checklist. Keep release entries separate when preparing a version; do not replace the preceding entry.

The [2026-09-10 verification report](docs/features-verification-2026-09-10.md) records the feature checks and performance sample. The [earlier audit report](docs/review-2026-09-10.md) documents the preceding bug/test/dependency review and is a historical snapshot.

## License

MIT. See `package.json` for package metadata.
