# Loading, freshness, and cache policy

This guide describes version 0.1.0. See the [0.1.0 release notes](../CHANGELOG.md#010---2026-09-10) for the change list and [upgrade instructions](releases.md#upgrading-from-006) for compatibility and rollout steps.

## Load a value once

```typescript
import { AdaptiveCache } from '@0xdoublesharp/adaptive-cache'

const cache = new AdaptiveCache({
  keyPrefix: 'catalog:',
  initialTTL: 10,
  maxTTL: 300,
  staleWhileRevalidate: 30,
  staleIfError: 120,
  ttlJitter: 0.1,
})

const product = await cache.getOrSet('catalog:product:42', () => loadProduct('42'))
const hit = await cache.get<Product>('catalog:product:42')
```

Direct API keys are complete keys, as in earlier releases. `keyPrefix` selects the namespace for tags, invalidation barriers, and loader locks; it does not prepend text to direct API keys. Include your namespace in those keys. Middleware constructs prefixed keys for you.

Concurrent calls on one instance share the loader promise for that key. Redis-backed instances also coordinate through a distributed lock. A waiter has a bounded timeout (`lockWaitTimeoutMs`, default 5000); a loader error is never stored as a cached value. Concurrent callers for the same key should use the same loader and policy. The first caller determines the shared work.

Explicit `forceRefresh` calls bypass fresh hits and stale-while-revalidate. They still share in-flight work on one instance. Across instances, forced refreshes serialize through the lock and each runs its loader, so a failed owner cannot cause a forced waiter to accept the old cached value. The configured stale-if-error fallback still applies if a forced loader fails.

Fresh values return immediately. During `staleWhileRevalidate`, an expired value returns immediately while one background loader refreshes it. During `staleIfError`, a failed foreground refresh may return the previous value. Each window is measured independently from freshness expiry, and fallback is checked again after the loader fails. Neither window extends the other. Ordinary `get()` never returns stale data; use `get(key, { allowStale: true })` to inspect retained entries with `stale` and `staleAge` in seconds.

`getOrSet` accepts per-call overrides for both windows, `maxTTL`, `tags`, `ttlJitter`, `forceRefresh`, and `lockWaitTimeoutMs`. Direct `set()` accepts `staleTTL` to retain data beyond freshness. Jitter is a fraction from 0 to 1 that shortens the fresh TTL; it never increases `maxTTL`.

Loader `maxTTL` can also be a function of the loaded value. `cache.resolveMaxTTL(value, { maxTTL })` resolves an optional override against the instance's configured limit; omitting the second argument uses the instance defaults.

Use `shouldStore(value)` to return a loaded result without caching it when your storage policy rejects it. It controls writes; it does not change whether an existing value is a hit.

## Choose a TTL policy

Use `ttlPolicy: { type: 'aimd' }` for additive growth and proportional decreases, or `ttlPolicy: { type: 'ewma' }` to weight observations by elapsed time. Both are opt-in; the existing adaptive policy remains the default. See [TTL policies](ttl-policies.md) for configuration and limitations.

## Cache negative results briefly

```typescript
const account = await cache.getOrSet('catalog:account:missing', findAccount, {
  negativeTTL: 5,
})
```

For `getOrSet`, `null` and `undefined` are negative results and are not cached by default. Direct `set()` still supports storing those values. Set `negativeTTL` to opt in. Use `isNegative(value)` for a different result representation. Negative entries have no stale retention. Thrown errors remain errors, subject only to the stale-if-error policy for a previously successful value.

## Invalidate without resurrecting old work

```typescript
await cache.clear('catalog:product:42')
await cache.invalidateTags(['category:books'])
await cache.invalidateNamespace()
```

Built-in backends capture write tokens before loaders and asynchronous encoding. Invalidation advances a barrier so work started before invalidation cannot write its old value back. A caller already awaiting a loader can still receive its result; that result is not retained when its token has been invalidated. Retagging removes obsolete memberships, so invalidating an old tag does not remove a newly retagged value.

Namespace invalidation makes the namespace's previous entries unreadable without scanning all payload keys. Physical payloads expire normally. Targeted invalidation can conservatively reject other in-flight writes within the same namespace, while preserving already-cached unrelated entries.

New Redis entries keep freshness and generation information with the payload. Losing a separate control or tag-index key under Redis memory eviction therefore causes a miss instead of reviving invalidated data. Legacy entries remain readable, but their older format does not acquire these guarantees retroactively. Use a new key prefix when rolling out this version alongside older readers; older versions cannot decode the new Redis envelope.

Redis performs token and loader ownership checks atomically with writes. Clustered LRU remains a host-local option: its dependency does not expose a distributed compare-and-write transaction. Use Redis when strict cross-worker or cross-host fencing is required. Custom backends must implement `captureWriteToken` for `getOrSet` and `invalidateNamespace` for namespace invalidation; unsupported operations fail explicitly. `supportsWriteFencing()` reports method availability, not an atomicity guarantee. `captureWriteToken()` and `set(key, value, { writeToken })` also expose fencing for caller-managed work.

## Ignore volatile fields when adapting TTL

```typescript
const cache = new AdaptiveCache({
  ignoreFields: ['generatedAt', 'metadata.requestId'],
  // Or provide fingerprint: (value) => aStringOrBuffer
})
```

These options change the content fingerprint used to grow or reset TTL. They do not strip fields from the stored value. Dotted paths identify fields to ignore. A custom fingerprint takes precedence over `ignoreFields`.

## Selective compression

```typescript
const cache = new AdaptiveCache({
  compression: {
    minBytes: 1024,
    async: true,
    skipCompressed: true,
    onlyIfSmaller: true,
  },
})
```

The byte threshold applies to the serialized payload. Already-compressed buffers are detected for gzip, ZIP, PNG, JPEG, and WebP. `onlyIfSmaller` accounts for base64 storage overhead. Asynchronous gzip keeps compression work off the JavaScript thread. JSON serialization and fingerprinting remain synchronous.

Entries written using `compression` carry a codec marker, so readers can decode them regardless of their compression settings. Existing boolean `compress` behavior remains supported; old entries require the matching legacy setting. `compress: false` disables compression even when selective options are supplied. Buffers, strings, JSON values, and `undefined` retain their types.

## Observe and drain work

```typescript
const unsubscribe = cache.onEvent((event) => {
  recordCacheEvent(event.type, event.layer, event.durationMs)
})
const stats = cache.getStats()
await cache.flush()
unsubscribe()
await cache.close()
```

Events cover hits, misses, stale reads, refreshes, writes, invalidation, lock contention, errors, and LRU evictions. Hits identify the serving layer (`l1`, `redis`, or `lru`). Statistics are per-instance snapshots; observer exceptions cannot break cache operations. `flush()` drains pending work and background writes. `close()` drains and releases owned resources and rejects new operations. An injected Redis client stays caller-owned.

LRU eviction counts include internal metadata and coordination entries reported by the dependency. Fenced writes rejected after invalidation emit an invalidation event with reason `write-rejected`. Loader lock-release failures emit an error event with reason `lock-release`; cleanup does not replace the loader result or its original error. Public lock operations participate in shutdown draining and reject new calls once closing begins.

Bulk helpers return explicit outcomes: `getMany(keys)` returns a `Map` of each key to a typed hit or `null`; `setMany([{ key, data, options }])` and `clearMany(keys)` await all submitted operations. They are concurrent convenience APIs, not multi-key transactions.

## HTTP identity and ownership

Both middleware factories accept an injected `cache`, a custom `key(request)`, declared `varyBy` headers (or a function returning a key dimension), and `shouldCache(request, response?)`. Header dimensions are case-insensitive. Custom keys remain inside the middleware prefix.

```typescript
import { adaptiveExpressCache } from '@0xdoublesharp/adaptive-cache'

const productResponses = adaptiveExpressCache({
  cache,
  keyPrefix: 'catalog:',
  key: (req) => `product:${req.params?.id}`,
  varyBy: ['Accept-Language'],
  loader: (req) => loadProduct(req.params?.id),
  staleWhileRevalidate: 30,
  staleIfError: 120,
})
app.get('/products/:id', productResponses)
```

Keep an injected cache's namespace aligned with the middleware `keyPrefix` when you want `invalidateNamespace()` to target those responses. The injected instance determines backend, codec, and default cache settings; the adapter controls HTTP key construction and policy.

Range and If-Range requests bypass caching, and partial `206` responses are never stored. Authorization and Cookie requests bypass caching by default. Enabling `cacheAuthenticated` or `cacheCookies` requires a key that isolates the relevant user, tenant, or session; the opt-in flag alone does not construct that identity. Responses with `Cache-Control: private` or `no-store`, `Set-Cookie`, `Vary: *`, or undeclared `Vary` headers are not stored. Use explicit header names in `varyBy` when responses advertise `Vary`.

Custom key functions must return a nonempty string. Invalid results bypass caching. If compression middleware adds `Vary: Accept-Encoding`, include `Accept-Encoding` in `varyBy` alongside your other header dimensions; otherwise those responses will not be stored.

Cached responses replay only `Cache-Control`, `Content-Encoding`, `Content-Language`, `Content-Type`, `ETag`, `Last-Modified`, and `Vary`, along with status and body. Arbitrary application headers are not replayed. Node and WHATWG streams bypass storage.

Normal middleware continues to intercept the route handler response. Optional `loader(request)` mode supports safe stale refresh using `getOrSet`; it regenerates values without replaying a handler after its response has been sent. Opt-in `negativeTTL` allows brief caching of normal-handler 404 responses. Other unsuccessful statuses remain uncached.

Middleware exposes `.cache`, `.clear(request)`, `.flush()`, and `.close()`.

```typescript
await productResponses.clear({
  originalUrl: '/products/42',
  query: {},
  params: { id: '42' },
  headers: { 'accept-language': 'en' },
})
```

Pass the identity of the request whose cached response should be removed, including any parameters and headers used by `key` or `varyBy`. Fastify uses `url` instead of `originalUrl`. Clearing one variant leaves other variants intact. Clearing uses the injected cache when present and does not apply GET, authentication, or `shouldCache` eligibility checks, so mutation handlers can invalidate cached GET results. Invalid custom keys and clearing a closed owned adapter reject explicitly. If the key callback throws, the clear rejects rather than silently reporting success.

Request-policy exceptions bypass storage while still running configured loaders. Normal-handler mode continues to the handler. Injected caches remain caller-owned. Fastify closes owned caches through its `onClose` hook. Applications using Express should call the middleware's `close()` during shutdown, after accepting no further requests. Closed adapters bypass caching. Closing an adapter does not close an injected cache; its caller manages that resource.
