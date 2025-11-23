# @doublesharp/adaptive-cache

A smart, adaptive caching middleware for Express and Redis. It automatically adjusts Cache-Control Time-To-Live (TTL) based on content stability.

If your API data changes infrequently, the cache duration extends to save resources. If data changes often, the cache duration stays short to ensure freshness.

## Features

- **Adaptive TTL**: Automatically increases cache duration for stable content and shortens cache time for volatile content.
- **Content-Aware**: Uses SHA-256 hashing to detect content changes.
- **Compression**: Automatically compresses cached data using Gzip to save Redis memory.
- **Race-Condition Proof**: Uses atomic Lua scripts for cache updates and fetches.
- **Dynamic Configuration**: Supports dynamic `maxTTL` based on response body content.
- **Debug Friendly**: Optional headers to inspect cache state and stability metrics.

## Installation

```bash
pnpm add @doublesharp/adaptive-cache
```

## How it Works

1.  **Request**: When a request comes in, the middleware checks Redis.
2.  **Hit**: If data is found, it is decompressed and returned immediately (`X-Cache: HIT`).
3.  **Miss**: If not found, the request proceeds to your handler (`X-Cache: MISS`).
4.  **Adaptive Update**:
    - When your handler sends a response, the middleware intercepts it.
    - It calculates a hash of the response body.
    - **Stable Content**: If the hash matches the previous version, the TTL is increased (multiplied) up to `maxTTL`.
    - **Volatile Content**: If the hash has changed, a "change count" is incremented. This "volatility score" dampens future TTL growth, keeping the cache short for unstable data.

## Usage

### Express Middleware

```typescript
import { adaptiveCache } from '@doublesharp/adaptive-cache'
import express from 'express'

const app = express()

// Basic usage
app.get('/api/summary', adaptiveCache(), (req, res) => {
  // ... expensive calculation
  res.json({ ... })
})

// Advanced configuration
app.get('/api/volatile-data', adaptiveCache({
  initialTTL: 10,          // Start with 10s cache
  maxTTL: 3600,            // Grow up to 1 hour if stable
  ttlScaling: 1.5,      // Grow by 50% on each stable hit
  includeDebugHeaders: true
}), (req, res) => {
  res.json({ ... })
})
```

### Dynamic MaxTTL

You can define `maxTTL` as a function to set limits based on the actual data returned.

````typescript
# @doublesharp/adaptive-cache

A smart, adaptive caching middleware for Express, Fastify, and Redis. It automatically adjusts Redis TTL (time-to-live) for cached items based on content stability — it does not automatically set HTTP `Cache-Control` headers unless you choose to set them yourself.

If your API data changes infrequently, the cache duration extends to save resources. If data changes often, the cache duration stays short to ensure freshness.

**Features**

- **Adaptive TTL**: Increases cache duration for stable content and shortens cache time for volatile content, using per-item metadata stored in Redis.
- **Content-Aware**: Uses SHA-256 hashing to detect content changes.
- **Compression**: Gzips cached data to save Redis memory and encodes it as base64 for safe storage.
- **Atomic updates**: Uses Lua scripts for atomic fetch/update and refresh-locks to avoid races.
- **Dynamic Configuration**: `maxTTL` can be a function that returns a TTL based on the response body.
- **Debug Friendly**: Optional headers to inspect cache state and stability metrics.

## Installation

```bash
pnpm add @doublesharp/adaptive-cache
````

## How it Works

1. **Request**: Middleware computes a cache key (path + hashed query params) and checks Redis.
2. **Hit**: If data is found and not bypassed, the middleware decodes base64 and gunzips the payload and returns it immediately with `X-Cache: HIT`.
3. **Miss**: If not found (or bypassed), the request proceeds to your handler and returns `X-Cache: MISS` (or `BYPASS` when forced).
4. **Adaptive Update**: After your handler returns a successful response, the middleware hashes the response body and calls a Lua script:
   - If the hash matches the stored hash, the TTL grows by a factor derived from `ttlScaling` (damped by a volatility score) up to `maxTTL`.
   - If the hash changed, the change count is incremented and TTL is reset to `initialTTL`.

Note: the TTL growth uses a damped increase (the implementation multiplies by `ttlScaling-1` then applies a decay factor based on the `changeCount`) — see the code for the exact formula.

## Usage

### Express Middleware

```typescript
import { adaptiveCache } from '@doublesharp/adaptive-cache'
import express from 'express'

const app = express()

// Basic usage
app.get('/api/summary', adaptiveCache(), (req, res) => {
  // ... expensive calculation
  res.json({
    /* ... */
  })
})

// Advanced configuration
app.get(
  '/api/volatile-data',
  adaptiveCache({
    initialTTL: 10, // Start with 10s cache
    maxTTL: 3600, // Grow up to 1 hour if stable
    ttlScaling: 1.5, // Grow by 50% on each stable hit (subject to damping)
    includeDebugHeaders: true,
  }),
  (req, res) => {
    res.json({
      /* ... */
    })
  },
)
```

### Fastify Plugin

```typescript
import { adaptiveFastifyCache } from '@doublesharp/adaptive-cache'
import Fastify from 'fastify'

const fastify = Fastify()

// Register the plugin
fastify.register(adaptiveFastifyCache({
  initialTTL: 10,
  maxTTL: 3600,
  ttlScaling: 1.5
}))

fastify.get('/api/summary', async (req, reply) => {
  // ... expensive calculation
  return { ... }
})
```

### Dynamic MaxTTL

You can define `maxTTL` as a function to set limits based on the actual data returned.

```typescript
app.get(
  '/api/items/:id',
  adaptiveCache({
    initialTTL: 60,
    // If item is "ended", cache for a long time, else return shorter TTL
    maxTTL: (data) => (data.status === 'ended' ? 86400 : 300),
  }),
  (req, res) => {
    // ...
  },
)
```

### Standalone Usage

You can use the helper to cache generic async function results.

```typescript
import { cacheResult } from '@doublesharp/adaptive-cache'

const data = await cacheResult('my-unique-key', 60, async () => {
  // Fetch data from DB or external API
  return await db.query(...)
})
```

## Configuration

| Option                | Type                 | Default       | Description                                                                                 |
| --------------------- | -------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `initialTTL`          | `number`             | `5`           | Starting cache duration in seconds.                                                         |
| `maxTTL`              | `number \| function` | `900`         | Maximum cache duration in seconds. Can be a static number or a function `(data) => number`. |
| `ttlScaling`          | `number`             | `2`           | Factor used to grow TTL when content is stable (growth is damped by volatility).            |
| `redisPrefix`         | `string`             | `'adaptive:'` | Prefix for all Redis keys.                                                                  |
| `includeHeaders`      | `boolean`            | `true`        | Add `X-Cache` and `X-Cache-TTL` headers.                                                    |
| `includeDebugHeaders` | `boolean`            | `false`       | Add `X-Cache-Data-TTL`, `X-Cache-Last-Modified`, `X-Cache-Refreshed` headers.               |
| `forceRefresh`        | `boolean`            | `false`       | Ignore existing cache and force a refresh (useful for dev/testing).                         |
| `compress`            | `boolean`            | `true`        | Gzip compress data in Redis (stored as base64).                                             |
| `metaTTL`             | `number`             | `604800`      | (7 days) How long to keep metadata (volatility stats) after last access.                    |

## Environment Variables

- `REDIS_URL` or `REDIS_TLS_URL`: Connection string for Redis.
- `REDIS_HOST` / `REDIS_PORT`: Fallback if URL is not provided.
- `CACHE_TIME`: Default time string (e.g. `"5 minutes"`) for simple `cache()` helpers.

## Headers (what they mean)

- `X-Cache`: `HIT` | `MISS` | `BYPASS` (forced refresh) | `RETRY` (fallback when Redis read/decompress failed).
- `X-Cache-TTL`: Remaining seconds for the cached data (from Redis `TTL`).
- `X-Cache-Data-TTL`: (Debug) TTL assigned to the current data version (from metadata).
- `X-Cache-Last-Modified`: (Debug) Timestamp of last detected content change (or `unknown`).
- `X-Cache-Refreshed`: (Debug) Number of times content has changed (volatility score / change count).

## Implementation notes & caveats

- Stored payloads are gzipped and then base64-encoded before writing to Redis. When `compress: true` the middleware decodes base64 and gunzips the stored value on read.
- The TTL growth algorithm applies a damping factor based on the `changeCount` metadata; it is not a raw exponential multiplier in all cases — check `src/redis-lua/adaptiveCacheUpdate.lua` for the exact math.
- Lock expiration units: the `shouldRefreshCache` Lua script uses Redis `PX` (milliseconds) when setting the lock. The code currently passes a `lockExpiration` numeric value (default `60`) from `src/index.ts`. Because `PX` expects milliseconds, passing `60` sets a 60ms lock. If you intend a 60-second lock, multiply by `1000` when calling `shouldRefreshCache` (or update the code to pass milliseconds).

## Publishing notes

- The published tarball should normally include `dist/` and `README.md`. Build artifacts like `coverage/` are included by default unless you add them to `.npmignore` or explicitly control files with the `files` field in `package.json`. Consider excluding `coverage/` from the package to reduce size.

## License & attribution

See `package.json` for package name and author information.
