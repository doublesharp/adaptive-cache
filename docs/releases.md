# Release history and process

The [changelog](../CHANGELOG.md) is the version-by-version record. The [README](../README.md) and [feature guide](cache-features.md) describe version 0.1.1.

## Version 0.1.1

Version 0.1.1 optimizes clustered-LRU bulk reads. LRU-backed modes require the optional peer `@0xdoublesharp/lru-cache-clustered@^2.1.1`; Redis-only users do not need it. Existing `getMany()` callers use the optimized path automatically on clustered LRU. Redis and L1 Redis retain their existing read behavior. There is no additional wire-format migration from 0.1.0. Empty `getMany()` calls now reject after closure. See the [release notes](../CHANGELOG.md#011---2026-09-11) and [verification report](batched-reads-0.1.1.md).

## Version 0.1.0

Version 0.1.0 includes changes after `v0.0.6`. The minor version marks the new loader and policy APIs, Redis wire-format change, and stricter HTTP caching defaults. See the [release notes](../CHANGELOG.md#010---2026-09-10) and [verification report](features-verification-2026-09-10.md).

## Historical sources

Git history records six prior package versions. Versions 0.0.1 through 0.0.4 have version commits but no local release tags. Versions 0.0.5 and 0.0.6 have tags. Dates below are UTC commit dates, not npm publication timestamps.

| Version | Date       | Source revision                                                                                            | Scope                                                                  |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0.0.1   | 2025-11-23 | [`a4a3261`](https://github.com/doublesharp/adaptive-cache/commit/a4a3261e7209c80967097f9485bb2bc585cac008) | Initial repository and package.                                        |
| 0.0.2   | 2025-11-23 | [`98c7f11`](https://github.com/doublesharp/adaptive-cache/commit/98c7f112394a711e373f3ed5b58c65821c488294) | Diff after 0.0.1.                                                      |
| 0.0.3   | 2025-11-23 | [`9a60da6`](https://github.com/doublesharp/adaptive-cache/commit/9a60da6980fa9c6cf010c42555bf58281f02e850) | Diff after 0.0.2, including export changes.                            |
| 0.0.4   | 2025-11-23 | [`f28211e`](https://github.com/doublesharp/adaptive-cache/commit/f28211e770fd9f4c6484c0a2c39bf1cf81a47cea) | Package version bump only.                                             |
| 0.0.5   | 2026-05-12 | [`v0.0.5`](https://github.com/doublesharp/adaptive-cache/tree/v0.0.5), `5b92262`                           | Changes after 0.0.4 through the tag; package version set in `35cfe63`. |
| 0.0.6   | 2026-05-15 | [`v0.0.6`](https://github.com/doublesharp/adaptive-cache/tree/v0.0.6), `1adee3a`                           | Changes after v0.0.5, including the intervening README badge cleanup.  |

The 0.0.6 commit changed the existing 0.0.5 changelog heading and expanded its contents instead of retaining both entries. The reconstructed changelog separates the changes using the tagged diffs. It does not infer additional npm releases from commit messages.

## Upgrading from 0.0.6

These steps apply when moving from 0.0.6 to 0.1.0 or 0.1.1.

1. Select a new namespace, such as `catalog:v2:`, for a rollout that overlaps older readers. Set middleware `keyPrefix` and the injected cache's `keyPrefix` consistently. Direct API keys are complete strings, so update their prefixes too. For LRU-backed deployments, use a distinct `lru.namespace` to isolate old and new processes.
2. Let old entries expire under their original prefixes. New Redis envelopes are unreadable by old code. New readers can read legacy entries, but legacy entries do not gain the new invalidation guarantees. Selective compression also writes a new codec marker; legacy compressed entries still require their matching `compress` setting.
3. Review routes that previously cached non-GET, authenticated, cookie-bearing, private, or partial responses. Range and If-Range requests and `206` responses bypass storage. They now bypass caching by default. Enable authenticated/cookie caching only with a key or variation that actually isolates the caller. Declare response `Vary` headers using `varyBy`, including `Accept-Encoding` when HTTP compression adds it.
4. Use an explicit `loader(request)` for middleware stale refresh. Normal response interception cannot safely rerun a completed route handler. Keep loaders consistent for a given key; the first caller controls shared work within an instance.
5. Allow for a Redis validation round trip on every L1 hit. Choose Redis-backed modes for atomic lease and write fencing. Clustered LRU has weaker cross-worker write/release guarantees. Bulk methods are not transactions.
6. Stop accepting requests before shutdown and call the adapter's `close()` or the direct cache's `close()`. Fastify closes owned adapter caches through `onClose`. Injected caches and Redis clients remain caller-owned.
7. For custom backends, implement and enforce `captureWriteToken` before using `getOrSet`. Implement `invalidateNamespace` to support namespace invalidation. `supportsWriteFencing()` checks method availability, not the backend's consistency guarantees.

`getOrSet` defaults to not storing `null` or `undefined`; set `negativeTTL` to cache missing values briefly. This loader policy does not remove direct `set()` support for those values. Negative results have no stale retention. A caller awaiting a loader may receive its result after invalidation, but an obsolete write token prevents Redis from retaining it.

New TTL policies are opt-in. Existing configurations retain the adaptive algorithm. Custom backends must implement and declare `supportsTtlPolicies` before selecting AIMD or EWMA. See [TTL policies](ttl-policies.md).

The `metaTTL` option accepts positive integer seconds. Fractional values now throw during construction instead of failing after a partial Redis write. Use adapter `.clear(request)` when invalidating custom or varied response keys.

## Preparing a release

1. Review changes since the last tag and keep user-visible additions, fixes, dependency changes, and migration notes under Unreleased throughout development.
2. Install using the configured pnpm version and `pnpm install --frozen-lockfile`. Dependency updates must honor `minimumReleaseAge: 10080` and peer compatibility. Do not add release-age exclusions. The policy governs this repository's resolution; consumers resolve package ranges under their own package-manager policy.
3. Choose the next version based on compatibility impact, update `package.json`, and move the completed Unreleased notes into a new dated section. Retain all historical sections. Add an Unreleased section when development resumes. Update README examples, the feature guide, and these upgrade instructions together.
4. Run `pnpm run quality`, exercise the full suite on supported Node versions, and inspect `npm pack --dry-run`. The suite requires Docker for Redis/Testcontainers tests. Inspect that the archive includes the built entry points, Lua scripts, README, changelog, license, and linked documentation.
5. Record verification against the actual release candidate. Coverage measures exercised code, not correctness; retain the concurrency, invalidation, HTTP, and stored-TTL regression checks.
6. Commit the release candidate and create a matching `v<version>` tag when ready to publish. Pushing a matching tag triggers [the npm publishing workflow](../.github/workflows/publish.yml), which checks the package version, installs, runs quality/tests, inspects the package, and publishes with provenance. It does not generate changelog entries or GitHub release notes.
