# Feature implementation verification

Verification recorded on 2026-09-10 for version 0.1.0. See the [changelog](../CHANGELOG.md#010---2026-09-10) and [release/upgrade guide](releases.md).

The implementation adds opt-in AIMD and EWMA TTL policies, coalesced loaders, typed and bulk APIs, independent stale windows, negative caching, configurable fingerprints, selective compression, events, lifecycle draining, HTTP identity and response policy, and stronger invalidation. API examples and compatibility limits are in [the feature guide](cache-features.md).

Three implementation agents owned the core, backends, and HTTP adapters. Integration review exercised actual Redis Lua, LRU operations, and Express/Fastify requests. Regressions cover expired loader leases, writes crossing invalidation, missed L1 notifications, evicted Redis control keys, retagging after state eviction, unsafe response caching, negative stale retention, and streamed bodies. Existing TTL tests now check stored lifetimes rather than argument lists. A failed filesystem mock is restored even when its assertion fails.

## Final checks

- `pnpm run quality` passes: lint, TypeScript, 417 tests in 32 files, coverage, and CJS/ESM/declaration builds.
- The full 417-test suite also passes under Node 22.19.0.
- Coverage is 100% for statements, branches, functions, and lines, with the original thresholds and no new coverage exclusions.
- Both built module formats pass smoke tests on Node 24.16.0 and Node 22.19.0, including 100 concurrent loader callers, asynchronous compression, typed/bulk reads, namespace invalidation, metrics, and AIMD/EWMA policies.
- A strict TypeScript consumer fixture compiles against the generated declarations with actual Express and Fastify registration, typed loaders, TTL policy exports, and request-aware clearing. The fixture is retained in `test/types/consumer.ts`; `pnpm run quality` compiles it against the generated declarations.
- The frozen lockfile installs without changes. Package dry-run assembly succeeds. No skipped/todo tests, unconditional boolean assertions, or coverage-ignore directives were introduced.

## Version 0.1.0 checks

Release regressions cover partial-response cache poisoning in both request orderings, loader execution after a request-policy exception, rejection of fractional metadata TTLs, preservation of loader results/errors when lock cleanup fails, and lock-operation shutdown draining. Both adapters now expose request-aware clearing, with tests for custom keys, header and callback variations, ignored query parameters, injected ownership, invalid keys, closure, and in-flight write fencing. The 27 added cases were exercised against the prior behavior before the fixes.

Loader coordination moved into `src/CacheLoader.ts`; LRU envelope calculations moved into `src/backends/lruEnvelope.ts`. The largest production module is 498 lines. The former 967-line core suite, 791-line backend suite, and 1,455-line HTTP suite are split by responsibility with explicit fixture registration. All original test bodies and assertions were preserved; the split was checked against the original declarations and test names. The largest resulting test file is 569 lines.

After setting the package version to 0.1.0, the frozen offline install, complete quality gate, and full Node 22 suite were rerun successfully. Both runtime suites still passed all 417 tests; the quality run retained 100% coverage and rebuilt both module formats and declarations. CJS/ESM smoke checks passed on Node 24.16.0 and Node 22.19.0. A strict consumer fixture also verifies `.clear(request)` against built declarations with actual Express and Fastify request types. Documentation formatting, local links, and release anchors were checked. The seven-day release-age policy is unchanged.

The TTL policy tests compare deterministic trajectories in real Redis Lua and clustered LRU, retaining production code while substituting only the Redis clock in the fixture. They cover policy resets, backward/equal timestamps, tiny probabilities, integer rounding, fractional caps, and L1 authority. Independent review identified AIMD rounding errors and unrepresentable EWMA seed rates; failing regressions now verify those fixes. The new policies return fractional Redis TTLs without truncation. A generated-declaration consumer check caught and fixed Express 5 array-valued route parameter compatibility.

## Independent sanity check

One read-only Claude Code invocation used `claude-fable-5-1`; it completed successfully with repository access, 25 turns, and a reported cost of $4.88. No second Claude consultation was launched. A separate code-review agent checked the later core/lifecycle changes and module extractions without actionable findings. The reviewer identified permanent loader timestamp keys, invalid custom-key collapse, middleware shutdown behavior, redundant SWR contention polling, and HTTP buffer compression detection. These findings guided additional regression tests and fixes. It also flagged the intentional L1 Redis round trip and conservative namespace-wide fencing; those tradeoffs remain documented, and rejected writes are observable through events. The review found no proven fencing or lock data-correctness defect in the snapshot it read.

## Performance sample

The repository benchmark ran against isolated local Redis on an Apple M2 Max, Node 24.16.0, with 100 keys, 2 KiB payloads, 2,000 reads per test, and 16 concurrent workers. This is a single machine sample, not a throughput guarantee or a comparison with the previous release.

| Backend                | Sequential hot reads/s | Concurrent hot reads/s |
| ---------------------- | ---------------------: | ---------------------: |
| Redis                  |                  5,107 |                 32,142 |
| L1 Redis               |                  5,413 |                 36,829 |
| L1 Redis with local L1 |                  5,658 |                 38,732 |
| Clustered LRU          |                 74,944 |                 67,715 |

Redis validation adds a round trip to L1 hits. These measurements include that cost. Cold Redis-to-L1 hydration averaged 0.386 ms; the following hot L1 read averaged 0.187 ms. Clustered LRU provides different consistency guarantees and should not be treated as an interchangeable distributed backend.

## Release constraints

The seven-day package release delay remains enabled without exclusions. New Redis envelopes require a new key prefix when deploying alongside older readers. Strict distributed lease and write checks require Redis; the clustered LRU dependency lacks atomic cross-worker compare-and-store.
