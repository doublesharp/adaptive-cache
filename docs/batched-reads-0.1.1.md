# Batched reads in 0.1.1

Evaluated on 2026-09-11. Both builds use the published `@0xdoublesharp/lru-cache-clustered@2.1.1` and identical runtime dependencies. The baseline is adaptive-cache `37657ef` with that dependency update; the comparison adds the batch-read implementation in 0.1.1. This isolates the implementation change from the [dependency-only evaluation](lru-cache-clustered-2.1.1.md).

## Implementation

The clustered-LRU backend uses upstream `mGet()` to read distinct payload keys, then reads their distinct namespace, entry, and tag control keys in one batch that bypasses worker L1. Each input is checked against those controls and its expiration before returning a result. Missing or changed controls fail closed. Empty batches and batches containing only misses do not query controls. These two reads are not an atomic transaction; the existing clustered-LRU concurrency limitations still apply.

`getMany()` preserves input order, duplicate-key Map behavior, per-input events, async decoding, metadata, and stale options. Custom backends can optionally implement `fetchMany()` with results aligned to every input occurrence. Existing backends, including Redis and L1-plus-Redis, retain individual-read fallback. Accepted reads remain tracked until decoding finishes so `close()` drains them, even if another batch member fails.

The shared read formatter also fixes a retention race: a scalar or batch read now rejects an envelope that expires while awaiting primary-side control validation, even with `allowStale`. An empty `getMany()` on a closed cache now rejects consistently with other reads.

## Measurements

Apple M2 Max, Node 24.16.0. Seven trials per build alternate execution order in fresh processes. Each trial seeds 300 keys with a 2 KiB string and an ID, disables compression, and measures 300 cold reads, 3,000 warm reads, 1,000 batches of 32 keys, and 100 writes. Worker modes use a real Node cluster worker; local L1 has a 60-second sliding TTL and 2,000-entry limit. Cache retention exceeds the run. Reads assert expected values. Tests and package installation do not run concurrently with timing samples.

The table includes medians and full observed ranges. Batch throughput counts complete 32-key batches per second; other rows count individual operations per second.

| Mode      | Operation |     Before ops/s (range) |      After ops/s (range) |  Change |
| --------- | --------- | -----------------------: | -----------------------: | ------: |
| primary   | cold      | 102,561 (51,724–137,323) |  97,188 (32,516–139,697) |   -5.2% |
| primary   | hot       | 157,670 (46,974–203,765) | 150,407 (78,349–231,799) |   -4.6% |
| primary   | batch     |      5,926 (1,468–8,098) |      6,562 (3,296–9,083) |  +10.7% |
| primary   | writes    |   33,594 (12,251–42,979) |   28,601 (12,284–34,134) |  -14.9% |
| worker    | cold      |      5,939 (1,841–8,781) |      5,989 (1,601–7,278) |   +0.8% |
| worker    | hot       |     8,916 (2,649–12,826) |     8,324 (2,627–10,124) |   -6.6% |
| worker    | batch     |        1,144 (418–1,727) |        1,733 (509–1,974) |  +51.4% |
| worker    | writes    |        2,015 (230–3,296) |        2,214 (385–2,574) |   +9.9% |
| worker-l1 | cold      |        4,872 (802–7,798) |        5,579 (856–6,589) |  +14.5% |
| worker-l1 | hot       |    11,230 (2,520–17,617) |    12,752 (2,978–15,058) |  +13.6% |
| worker-l1 | batch     |        1,684 (676–2,607) |        3,924 (972–4,369) | +133.1% |
| worker-l1 | writes    |        1,592 (815–2,673) |        2,017 (762–2,272) |  +26.7% |

Worker batch throughput increased by 51.4% without L1 and 133.1% with warm L1. Primary-process batches increased by 10.7%. The broad ranges and mixed results on scalar reads and writes show substantial timing noise; these samples do not establish a general improvement for all operations or rule out small performance regressions. Redis throughput was not measured.

Message counts are deterministic for this workload and directly explain the worker batch improvement:

| 32-key batch    | Before worker-to-primary requests | After worker-to-primary requests |
| --------------- | --------------------------------: | -------------------------------: |
| L1 disabled     |                                96 |                                2 |
| Warm L1 enabled |                                64 |                                1 |
| Primary process |                                 0 |                                0 |

These counts exclude response messages. Actual counts depend on cached payloads and whether any control keys require validation. [All 14 timing samples](benchmarks/batched-reads-0.1.1.jsonl) include throughput, p95 latency, and request counts.

## Correctness and package checks

- All 429 tests pass on Node 22.19.0 and Node 24.16.0. The Node 24 quality run passes lint, source type checks, CJS/ESM builds, and built-declaration consumer checks, with 100% statement, branch, function, and line coverage.
- Twelve focused batch/read regressions cover ordering, duplicates, falsy values, empty inputs, custom-backend fallback, batch rejection, malformed result lengths, async decoding and close draining, metadata, stale reads, invalidation, and expiration during control validation.
- The expiration race was reproduced against the baseline build: it incorrectly returned a stale hit after retention elapsed. The updated build returns a miss under the same controlled clock advance.
- Separate final worker checks on both Node versions retain warmed cache instances across primary replacement, tag invalidation, and namespace invalidation and verify `getMany()` results. Delivered requests whose `send()` returns false still complete correctly; the check asserts that actual IPC occurred. The benchmark now runs these checks after its timing phases.
- CJS and ESM runtime smoke checks pass on both Node versions, including coalesced loaders, async codecs, bulk reads, namespace invalidation, metrics, and TTL policies.
- The seven-day dependency release-age policy remains configured at 10,080 minutes. Only the explicitly authorized clustered-cache 2.1.1 update bypassed it during resolution; no persistent exclusion was added.

Coverage alone does not establish correctness. The targeted race and invalidation assertions above check observable outcomes and retain live cache state across mutations.

## Reproduce

Build two separate package roots with the baseline and batch implementation. Both must resolve clustered-cache 2.1.1 and identical other runtime dependencies. Run sequentially and alternate order across trials:

```sh
BENCH_BATCHES=1000 node --expose-gc scripts/benchmark-lru-upgrade.mjs /absolute/path/to/baseline/root
BENCH_BATCHES=1000 node --expose-gc scripts/benchmark-lru-upgrade.mjs /absolute/path/to/batched/root
```

For the current checkout:

```sh
pnpm install --frozen-lockfile
pnpm run quality
BENCH_BATCHES=1000 pnpm run bench:lru
```

The benchmark emits JSON. Inspect every worker row's `retainedInvalidation`, `batchInvalidation`, `tagInvalidation`, and `backpressure.passed` fields as well as timings. Timing samples were captured before the post-measurement checks were expanded to batch and tag invalidation; the separate final worker runs exercise the expanded checks.
