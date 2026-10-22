// fast-check reports the seed, shrink path, and minimal counterexample on failure.
export const fuzzParameters = {
  numRuns: Number(process.env.FUZZ_RUNS ?? 100),
  ...(process.env.FUZZ_SEED === undefined ? {} : { seed: Number(process.env.FUZZ_SEED) }),
  ...(process.env.FUZZ_PATH === undefined ? {} : { path: process.env.FUZZ_PATH }),
}

export const fuzzTimeoutMs = Math.max(30000, fuzzParameters.numRuns * 100)
