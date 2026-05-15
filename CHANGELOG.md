# Changelog

All notable changes to this project will be documented in this file.

## 0.0.6 - 2026-05-15

### Added

- Added adaptive backend support with built-in `redis`, `l1-redis`, and `clustered-lru` modes.
- Added `AdaptiveCacheBackend` support for custom backend implementations.
- Added bounded clustered LRU support through optional peer dependencies:
  - `@0xdoublesharp/lru-cache-clustered`
  - `lru-cache`
- Added `l1-redis` mode, which serves hot reads from clustered LRU while keeping Redis Lua as the authoritative adaptive TTL engine.
- Added standalone `clustered-lru` mode for no-Redis, single-host, or one-primary Node cluster deployments.
- Added L1 envelopes with encoded payload, response hash, adaptive metadata, timestamps, expiration, and tags.
- Added LRU memory-safety options:
  - `lru.namespace`
  - `lru.maxSizeBytes`
  - `lru.maxEntrySizeBytes`
  - `lru.timeout`
  - `lru.failsafe`
  - `lru.localL1`
- Added `keyPrefix` as a backend-neutral alias for `redisPrefix`.
- Added `ignoreQueryParams`, defaulting to `['refresh']`, so middleware control parameters do not fragment cache keys.
- Added versioned payload envelopes for JSON values, strings, buffers, and `undefined`.
- Added `l1Redis.writeMode` with `async` and `await-redis` modes.
- Added `AdaptiveCache.flush()` for waiting on pending backend work, including async L1 Redis reconciliation.
- Added pass-through support for `@0xdoublesharp/lru-cache-clustered` v2.1 local L1 options via `lru.localL1`.
- Added L1 Redis Pub/Sub invalidation so separate server-local L1 caches can clear stale keys.
- Added full coverage for backend behavior, middleware behavior, singleton exports, LRU edge cases, Redis-free paths, and Redis/Testcontainers integration paths.
- Added end-to-end tests proving Redis Lua adaptive TTL behavior, Express middleware cache flows, L1 Redis hot reads and peer invalidation, and standalone clustered LRU behavior.
- Added `pnpm run bench:configs` to compare `redis`, `l1-redis`, and `clustered-lru` performance against local Redis.
- Added GitHub Actions workflows for CI, quality checks, coverage publishing, and npm OIDC trusted publishing.
- Added npm, CI, quality, coverage, publish, and license badges to the README.
- Added ESLint flat config and a `pnpm run quality` script covering lint, typecheck, coverage, and build.
- Added package publish metadata, package file allowlist, and MIT license file for npm releases.

### Changed

- Redis remains the default backend and continues to use Lua scripts for atomic adaptive fetches, updates, tags, and refresh locks.
- Extended Redis Lua fetch return tuples to include adaptive metadata for L1 hydration:
  - `dataTTL`
  - `lastChanged`
  - `changeCount`
  - `hash`
- Extended Redis Lua update return tuples to include:
  - `hash`
  - `changedFlag`
- Preserved existing leading Lua tuple fields for compatibility with current callers.
- Middleware now avoids creating or sharing the default Redis singleton when `backend: 'clustered-lru'` is used.
- `l1-redis` writes L1 immediately with a conservative TTL, then asynchronously reconciles L1 from Redis Lua results.
- The package now declares Node.js `>=22`, matching the clustered LRU dependency and CI matrix.
- Updated the optional `@0xdoublesharp/lru-cache-clustered` peer/dev dependency to `^2.1.0` after verifying the published npm package metadata.
- `clearAdaptiveCache` can now receive backend options so non-default backends can clear the matching cache.
- Updated README documentation for backend modes, L1 memory limits, v2.1 local L1 options, Redis Lua metadata, headers, configuration, testing, and operational notes.
- Updated the coverage script to run the full test suite under coverage.

### Fixed

- Fixed missing Redis metadata handling so Lua/RESP null values do not produce `"null"` debug headers.
- Fixed L1 Redis hydration race by waiting for invalidation subscription readiness before hydrating L1 from Redis fallback hits.
- Fixed refresh lock handling so lock expiration is passed to Redis Lua in milliseconds from second-based public options.
- Fixed refresh bypass requests so `?refresh=true` updates the normal cache key instead of a separate refresh-specific key.
- Fixed plain string and Buffer payload round trips.
- Fixed Redis TLS defaults so TLS is only enabled for TLS URLs and certificate verification stays on unless explicitly disabled.
- Fixed clustered LRU shutdown so initialized LRU backends call the underlying `destroy()` hook.

### Testing

- `pnpm run test` passes with 164 tests across 10 files.
- `pnpm run test:coverage` reports 100% statements, branches, functions, and lines.
- `pnpm run typecheck` passes.
- `pnpm run build` passes.
- Built CJS and ESM entry points were smoke-tested with the standalone clustered LRU backend.

### Notes

- `@0xdoublesharp/lru-cache-clustered` and `lru-cache` are optional peer dependencies. Redis-only users do not need them at runtime.
- `clustered-lru` is volatile and local to a host or Node cluster. Use `l1-redis` when Redis is available and cross-host correctness matters.
