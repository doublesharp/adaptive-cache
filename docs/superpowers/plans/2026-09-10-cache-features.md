# Adaptive cache features implementation plan

> For agentic workers: use subagent-driven-development with focused reviews and regression-first implementation.

**Goal:** Implement every feature accepted from the feature-gap review, preserving the preceding fixes.

**Architecture:** AdaptiveCache owns loaders, payload codecs, events, typed and bulk APIs. Backends own fresh/stale retention, write-token fencing, namespace/tag invalidation and layer attribution. Shared HTTP policy helpers support Express and Fastify with explicit cache ownership and loader-based stale refresh.

**Tech stack:** TypeScript 6, Node 22+, Redis Lua, clustered LRU, Express/Fastify, Vitest.

## Global constraints

- Preserve existing uncommitted fixes and tests. No push, publish, or unrelated dependency changes.
- Keep the seven-day package release delay with no exclusions.
- Use real behavior assertions, controlled race barriers, and real Redis integration; no always-passing coverage filler.
- No weakening coverage thresholds to hide missing tests. Report meaningful coverage limitations if necessary.
- Preserve existing public APIs; new custom-backend methods are optional and required capabilities fail explicitly when requested.
- Each agent owns its files; coordinate shared type changes with the root agent.
- Claude Fable 5.1 receives one bounded read-only sanity check, with a second call only if a material issue requires it.

## Shared backend contract

Add optional methods on AdaptiveCacheBackend:

```ts
captureWriteToken?(redisPrefix: string): Promise<string>
invalidateNamespace?(redisPrefix: string): Promise<void>
```

Add optional fields to AdaptiveCacheBackendUpdateInput: `writeToken?: string`, `staleTTL?: number` (seconds beyond fresh TTL), `ttlJitter?: number` (fraction 0..1; shorten physical fresh TTL, never extend maxTTL).

Add optional `allowStale?: boolean` to fetch input. Fetch result may include `stale?: boolean`, `staleAge?: number` (seconds), `layer?: 'l1' | 'redis' | 'lru'`. Keep `ttl` as remaining fresh seconds, 0 when stale. Normal reads never return stale data.

A rejected fenced write returns `['INVALIDATED', 0]`. Capture tokens before loader work and asynchronous encoding. Clear/tag/namespace invalidation advances a write barrier so earlier work cannot repopulate invalidated data. Namespace invalidation also makes existing namespace entries unreadable. Redis check-and-write is atomic. Custom backends lacking captureWriteToken must fail explicitly for fenced loader operations. Do not silently claim distributed guarantees absent in clustered LRU's public API.

## Task 1: Backend retention and invalidation

Owned files: src/backends/_, src/redis-lua/_, test/BackendFeatures.test.ts, test/helpers/FakeRedis.ts (only if needed).

- [x] Reproduce writes crossing clear/tag/namespace invalidation with controlled barriers and real Redis scripts.
- [x] Implement fresh/stale retention, per-read freshness filtering, and layer attribution.
- [x] Implement write-token barriers and namespace invalidation; preserve targeted clear/tag behavior and clean obsolete tag memberships on retag/clear.
- [x] Propagate fencing through L1; never publish/hydrate rejected writes. Validate generation changes on hot reads where needed for the stated guarantee.
- [x] Test namespaces, disjoint tags, retagging, stale bounds, real Redis, and cache-layer misses/hits.

## Task 2: Core loader, typed API, codec, metrics

Owned files: src/AdaptiveCache.ts, src/CacheLoader.ts, src/payload.ts, and the test/CoreLoader, CorePayload, and CoreObservability suites. Do not edit types.ts or middleware without coordination.

Public API additions:

```ts
get<T = any>(key: string, options?: { allowStale?: boolean }): Promise<AdaptiveCacheHit<T> | null>
getOrSet<T>(key: string, loader: () => Promise<T>, options?: AdaptiveCacheLoadOptions<T>): Promise<T>
getMany<T = any>(keys: string[]): Promise<Map<string, AdaptiveCacheHit<T> | null>>
setMany(entries: Array<{ key: string; data: unknown; options?: AdaptiveCacheSetOptions }>): Promise<void>
clearMany(keys: string[]): Promise<void>
invalidateNamespace(): Promise<void>
getStats(): AdaptiveCacheStats
onEvent(listener: (event: AdaptiveCacheEvent) => void): () => void
close(): Promise<void>
```

Set options: maxTTL, tags, staleTTL, writeToken. Load options additionally: staleWhileRevalidate (seconds), staleIfError (seconds), negativeTTL (seconds), isNegative(data), forceRefresh, lockWaitTimeoutMs. Add matching constructor defaults for stale windows and negativeTTL. Default negative result means null or undefined; errors are not cached. SWR and SIE have independent hard limits, measured from freshness expiry. Loader identity is per cache/key; concurrent requests share a promise. Redis supports cross-instance loader coordination using refresh locks with bounded wait. Always release on success/error; failed refresh must not create an artificial fresh marker that prevents retry. flush/close wait for background loads and writes.

Events include hit/miss/stale/refresh/write/invalidate/lock-contention/error/eviction with key, backend/layer, duration, TTL or reason where relevant. getStats returns counters by event and hit layer. Observer exceptions must not break caching. LRU eviction events should expose dependency counters or hooks where supported, not invented values.

Compression keeps legacy boolean behavior readable and adds `compression?: { minBytes?: number; async?: boolean; skipCompressed?: boolean; onlyIfSmaller?: boolean }`. New selectively compressed entries must be self-describing, readable regardless of the reader's compression configuration. Fingerprinting adds `fingerprint?: (data: any) => string | Buffer`, `ignoreFields?: string[]` with dotted object paths. Preserve the full original payload; only change detection excludes fields. Add ttlJitter fraction 0..1. Validate numeric settings.

- [x] Red/green tests for 100 concurrent misses, loader rejection/retry, distributed contention, invalidated loaders, stale bounds and refresh errors.
- [x] Implement codec/fingerprints/jitter and test text, buffers, incompressible content, legacy payloads, async compression, and unchanged hashes with changed excluded fields.
- [x] Implement typed/bulk/events/lifecycle APIs with meaningful bounds and shutdown tests.

## Task 3: HTTP policy and ownership

Owned files: src/AdaptiveExpressCache.ts, src/AdaptiveFastifyCache.ts, src/httpResponse.ts, new src/httpPolicy.ts, test/ExpressHttpPolicy.test.ts, test/ExpressHttpLoaders.test.ts, test/FastifyHttpPolicy.test.ts, and test/FastifyHttpLoaders.test.ts.

Both factories accept `cache?: AdaptiveCache`, `key?: (req) => string`, `varyBy?: string[] | ((req) => unknown)`, `shouldCache?: (req, response?) => boolean`, `cacheAuthenticated?: boolean` (default false), `cacheCookies?: boolean` (default false), and `loader?: (req) => Promise<unknown>` for explicit safe background regeneration. Loader-based routes use getOrSet; never replay Express next() or Fastify handlers after sending. Preserve the original middleware mode for normal handler interception. Expose middleware `.cache`, `.flush()`, `.close()`; close only owned caches, and Fastify onClose automatically drains/closes owned state. Injection must not start a default Redis connection.

Bypass Authorization/Cookie requests by default, unless explicitly enabled with caller-owned key isolation. Do not store Cache-Control private/no-store, Set-Cookie, Vary:*, or undeclared Vary fields. Declared varyBy header names partition keys; normalize names. Custom keys remain within the middleware prefix. shouldCache false bypasses reads and writes. Cache policy affects both read and write eligibility. Preserve response headers needed for HTTP identity; do not replay Set-Cookie. Support opt-in negative caching of 404 results with a bounded negativeTTL. Keep only safe methods as default and no stream caching. Cache-Control generation is optional, respecting server-side freshness caps.

- [x] Real Express/Fastify tests for user/tenant/locale partitioning, request and response bypass, Vary, negative caching, injected cache ownership, close/drain, and loader SWR.
- [x] Implement common policy helpers and adapter changes without duplicated policy logic.

## Task 4: Integration and verification (root)

Owned files: src/types.ts, src/index.ts, README.md, integration tests and fixes coordinated with agents.

- [x] Establish shared types, inspect API compatibility and custom-backend fallbacks.
- [x] Review each agent deliverable against its task and inspect cross-feature races.
- [x] Run a bounded Claude Fable 5.1 sanity check on the integrated concurrency/policy/codec design. Verify actionable findings with tests.
- [x] Run lint, typecheck, full Redis/HTTP tests, coverage, builds, Node 22 validation, and CJS/ESM package smoke checks.
- [x] Document every new option/API, safe examples, migrations, and exact backend consistency limits.
