# Changelog

Notable changes by version. See [release history and process](docs/releases.md) for historical source revisions and upgrade instructions.

## 0.1.0 - 2026-09-10

This version adds loader and cache-policy APIs and changes the Redis format and HTTP caching defaults. Review the upgrade notes before deploying.

### Added

- Opt-in AIMD and time-aware EWMA TTL policies across Redis, L1 Redis, and clustered LRU, with validated settings, persisted learning state, and TTL caps. The existing adaptive policy remains the default.
- `getOrSet<T>` with per-instance request coalescing, Redis loader locks, bounded lock waits, and explicit force refresh.
- Independent stale-while-revalidate and stale-if-error windows, explicit stale reads, and short negative caching for missing values. HTTP 404 caching is opt-in.
- Typed hits and bulk `getMany`, `setMany`, and `clearMany` helpers.
- Namespace invalidation, write tokens, and Redis atomic checks that reject writes after invalidation or loader lease loss.
- Configurable content fingerprints and dotted `ignoreFields` paths, preserving the full cached payload.
- Selective compression with a byte threshold, asynchronous gzip, compressed-buffer detection, and an only-if-smaller policy. New codec markers identify how entries should be decoded.
- TTL jitter, per-instance statistics, cache events, serving-layer metrics, and LRU eviction reporting.
- `close()` and middleware `.cache`, `.flush()`, and `.close()` handles, with caller ownership preserved for injected caches and Redis clients.
- Express and Fastify custom keys, declared header variations, cache predicates, injected cache instances, and explicit loader routes for stale refresh.
- Request-aware `.clear(request)` on Express middleware and Fastify plugins, using the configured custom key, header variations, query rules, and cache namespace.
- A seven-day minimum package release age in `pnpm-workspace.yaml`, without exclusions.

### Changed

- Middleware caches GET responses only. Authorization and Cookie requests bypass caching by default. Explicit opt-ins also require caller-defined identity isolation.
- Responses with `private`, `no-store`, `Set-Cookie`, `Vary: *`, or undeclared `Vary` headers are excluded from storage. See the [HTTP policy guide](docs/cache-features.md#http-identity-and-ownership).
- Redis stores freshness and generation information with each payload. L1 hits validate against Redis even if a Pub/Sub invalidation was missed; this adds a Redis round trip to hot reads.
- Loader, middleware, and asynchronous compression writes wait for write-token acceptance. Ordinary synchronous L1 `set()` retains its optimistic write path.
- Updated dependencies within the release-age policy, including ioredis 6, Vitest 5, Testcontainers 12, Fastify 5.12, ESLint 10.9, and lru-cache 11.5. Kept TypeScript at 6.0.3 for parser compatibility and removed unused `c8`.
- Split loader coordination and LRU envelope calculations into focused internal modules, and organized large test suites by backend and behavior.
- Replaced weak mock/log assertions with stored-state, real TTL, concurrency, and HTTP regression checks. Tests must contain assertions.

### Fixed

- Express request types accept array-valued route parameters, matching Express 5 and allowing typed calls to `.clear(request)`.
- Range and If-Range requests bypass caching, and partial `206` responses are not stored under full-resource keys.
- Request-policy failures bypass caching while still running configured loaders, avoiding accidental 404 responses on loader-only routes.
- Fractional `metaTTL` values are rejected before backend initialization, preventing partial Redis writes that leave metadata without expiry.
- Loader lock cleanup errors emit a `lock-release` error event without replacing a successful result or the original loader error.
- Public lock operations reject new work after close and participate in shutdown draining; previously accepted loaders can complete their internal lock operations.

- Invalidated or expired-lease loaders cannot repopulate Redis with old results. Evicted control/tag-index keys cause misses instead of reviving invalidated entries.
- Retagging removes obsolete memberships. Tag epochs expire, and loader lock release no longer leaves permanent last-refresh marker keys.
- Stale fallback is checked again when a loader fails. Negative entries have no stale retention. Background refresh contention avoids redundant polling.
- Forced refreshes across instances run their own loaders after acquiring the lock instead of accepting an old fresh hit.
- Middleware preserves response status, headers, JSON-looking text, and binary bodies. Fastify hit detection works with diagnostic headers disabled, and streams bypass storage.
- Express response compression no longer pairs plaintext cached bodies with post-compression headers. Already-compressed HTTP buffers are detected by the compression policy.
- Invalid custom keys bypass caching. Response-policy exceptions do not break successful responses, and background refresh uses a snapshot of response headers.
- Middleware respects an injected cache's TTL limit; initial, adaptive, and negative TTLs respect the effective maximum.
- Clear helpers preserve unrelated LRU entries and resource ownership, respect ignored query parameters and custom prefixes, and retain own `__proto__` query fields in key normalization.
- Clustered LRU retains adaptive metadata after payload expiry, removes old data on oversized replacement, and acquires locks atomically through the cluster primary.
- Observer errors are contained, and closed middleware bypasses caching.

### Upgrade notes

- Use a new key prefix when deploying alongside older readers. The new Redis envelope is not readable by older versions. See [upgrading from 0.0.6](docs/releases.md#upgrading-from-006).
- Strict distributed write and lease guarantees require Redis. Clustered LRU remains host-local and lacks an atomic cross-worker compare-and-store operation.
- Bulk helpers are concurrent convenience APIs, not multi-key transactions. Targeted invalidation can reject unrelated in-flight writes within the same namespace.

## 0.0.6 - 2026-05-15

[Changes since 0.0.5](https://github.com/doublesharp/adaptive-cache/compare/v0.0.5...v0.0.6)

### Added

- Versioned payload envelopes for JSON values, strings, buffers, and `undefined`.
- `ignoreQueryParams`, defaulting to `['refresh']`, with sorted query normalization for middleware keys.
- `l1Redis.writeMode` with `async` and `await-redis` modes, and `AdaptiveCache.flush()` for pending backend work.
- Redis/Testcontainers end-to-end coverage for adaptive TTLs, Express responses, L1 hydration/invalidation, and standalone LRU behavior.

### Changed

- Declared Node.js `>=22` and made Express/Fastify optional peers supporting major versions 4 and 5.
- Removed the runtime dependency on `fastify-plugin` and framework-specific imports from the adapters.
- Coverage now runs the full test suite rather than the selected deterministic files used in 0.0.5.
- Simplified README badges and documented payloads, Redis TLS, lifecycle draining, and write modes.

### Fixed

- Refresh bypass updates the normal cache key instead of a separate refresh-specific key.
- Plain strings and buffers round-trip through the direct API; middleware recognizes falsy cached values.
- `cacheResult` caches `false`, `0`, and empty strings and awaits the Redis write.
- Redis TLS is enabled only for TLS URLs, with certificate verification enabled by default.
- Key/tag clears remove adaptive metadata as well as data; Redis tag sets receive an expiry.
- Initialized clustered LRU backends call the dependency's `destroy()` hook on shutdown.

## 0.0.5 - 2026-05-12

[Changes since 0.0.4](https://github.com/doublesharp/adaptive-cache/compare/f28211e770fd9f4c6484c0a2c39bf1cf81a47cea...v0.0.5)

### Added

- Pluggable `AdaptiveCacheBackend` support with built-in `redis`, `l1-redis`, and standalone `clustered-lru` modes.
- Bounded LRU payload envelopes, memory and entry-size limits, namespace/timeouts/failsafe settings, and optional per-worker local L1 options through `@0xdoublesharp/lru-cache-clustered` 2.1.
- Redis Pub/Sub invalidation for server-local L1 caches and optimistic L1 writes reconciled with Redis adaptive TTL metadata.
- `keyPrefix` as a backend-neutral alias and backend options for `clearAdaptiveCache`.
- Backend, singleton, LRU middleware, and Redis-free tests; configuration benchmarks; ESLint and quality scripts.
- CI, coverage, and npm trusted-publishing workflows, package metadata/file allowlist, MIT license, and an architecture diagram.

### Changed

- Moved Redis behavior into its own backend and appended adaptive metadata to Lua fetch/update tuples for L1 hydration.
- LRU-only middleware no longer creates the default Redis singleton. LRU dependencies are optional peers.
- Refreshed development dependencies and expanded backend/configuration documentation.

### Fixed

- Missing Redis metadata no longer appears as `"null"` in debug headers.
- L1 hydration waits for invalidation subscription readiness.
- Refresh lock expiry converts public seconds to Lua milliseconds.

## 0.0.4 - 2025-11-23

[Version commit](https://github.com/doublesharp/adaptive-cache/commit/f28211e770fd9f4c6484c0a2c39bf1cf81a47cea)

- Package version bump only. No source, test, or dependency changes from 0.0.3.

## 0.0.3 - 2025-11-23

[Changes since 0.0.2](https://github.com/doublesharp/adaptive-cache/compare/98c7f112394a711e373f3ed5b58c65821c488294...9a60da6980fa9c6cf010c42555bf58281f02e850)

### Changed

- Exported the Express factory as `adaptiveExpressCache`, replacing the public `adaptiveCache` alias.
- Changed `cache(duration)` from middleware creation to an options helper returning `{ initialTTL }`, for use as `adaptiveExpressCache(cache('5 seconds'))`.
- Removed the `cacheSuccess` export and duplicate utility files; updated tests for the new API.

## 0.0.2 - 2025-11-23

[Changes since 0.0.1](https://github.com/doublesharp/adaptive-cache/compare/a4a3261e7209c80967097f9485bb2bc585cac008...98c7f112394a711e373f3ed5b58c65821c488294)

- Renamed the internal Express factory to `adaptiveExpressCache`, while retaining `adaptiveCache` as its package export alias.
- Updated the `cache` and `cacheSuccess` wrappers to call the renamed factory and added standalone duration/key utility files.

## 0.0.1 - 2025-11-23

[Initial version commit](https://github.com/doublesharp/adaptive-cache/commit/a4a3261e7209c80967097f9485bb2bc585cac008)

- Initial Redis-backed adaptive cache with response hashing, TTL growth/reset, gzip payloads, tag invalidation, and Lua refresh locks.
- Express and Fastify integrations, shared Redis/cache helpers, fixed-duration `cacheResult`, and diagnostic headers.
- TypeScript declarations, CommonJS/ESM builds, Vitest tests, and a local Redis Compose configuration.
