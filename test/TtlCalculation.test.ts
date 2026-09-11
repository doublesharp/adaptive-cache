import { describe, expect, it } from 'vitest'
import { calculateNextMetadata } from '../src/backends/lruEnvelope'
import type { AdaptiveCacheMetadata, AdaptiveCacheTtlPolicy } from '../src/types'

const next = (
  previous: AdaptiveCacheMetadata | undefined,
  hash: string,
  policy?: AdaptiveCacheTtlPolicy,
  now = 1000,
  max = 100,
  initial = 5,
) => ({ ...calculateNextMetadata(previous, hash, initial, max, 2, policy, now), hash })

describe('TTL policy calculations', () => {
  it('preserves the default adaptive trajectory and legacy metadata history', () => {
    let metadata: AdaptiveCacheMetadata | undefined
    const values = ['a', 'a', 'a', 'b', 'b'].map((hash) => {
      metadata = next(metadata, hash)
      return metadata.dataTTL
    })
    expect(values).toEqual([5, 10, 20, 5, 10])
    expect(next({ hash: 'x', dataTTL: '10', changeCount: '90', lastChanged: '7' }, 'x').dataTTL).toBe(11)
    expect(next({ hash: 'x', dataTTL: 200 }, 'x').dataTTL).toBe(100)
    expect(next(undefined, 'x').ttlPolicyState).toBeUndefined()
  })

  it('uses additive growth and multiplicative decrease independently of historical churn', () => {
    const policy = { type: 'aimd', increaseSeconds: 3, decreaseFactor: 0.5 } as const
    let metadata: AdaptiveCacheMetadata | undefined
    const values = ['a', 'a', 'a', 'b', 'c'].map((hash) => {
      metadata = next(metadata, hash, policy)
      return metadata.dataTTL
    })
    expect(values).toEqual([5, 8, 11, 6, 5])
    expect(next({ ...metadata, changeCount: 999 }, 'c', policy).dataTTL).toBe(8)
    expect(next(metadata, 'c', policy, 1000, 6).dataTTL).toBe(6)
  })

  it('rounds a new policy TTL upward before enforcing fractional caps', () => {
    const first = next(undefined, 'a', { type: 'aimd' })
    expect(next(first, 'a', { type: 'aimd' }, 2000, 7.5).dataTTL).toBe(7.5)
    const fractional = { type: 'aimd', increaseSeconds: 0.2, decreaseFactor: 0.8 } as const
    expect(next(next(undefined, 'a', fractional), 'a', fractional).dataTTL).toBe(6)
  })

  it('rounds AIMD increases exactly without an EWMA tolerance', () => {
    const tiny = { type: 'aimd', increaseSeconds: 1e-12 } as const
    expect(next(next(undefined, 'a', tiny), 'a', tiny).dataTTL).toBe(6)
    const huge = { ...next(undefined, 'a', { type: 'aimd' }), dataTTL: 1e13 }
    expect(next(huge, 'a', { type: 'aimd' }, 1000, 1e14).dataTTL).toBe(1e13 + 5)
  })

  it('never subtracts a whole second when rounding a large EWMA estimate', () => {
    const policy = { type: 'ewma', halfLifeSeconds: 10, targetChangeProbability: 0.1 } as const
    const seeded = next(undefined, 'a', policy)
    const highTTL = 1e13
    const previous = {
      ...seeded,
      ttlPolicyState: { ...seeded.ttlPolicyState!, changeRate: -Math.log1p(-0.1) / (highTTL / 2) },
    }
    expect(next(previous, 'a', policy, 11000, 1e14).dataTTL).toBe(highTTL)
  })

  it('updates EWMA from elapsed observation time and the changed sample', () => {
    const policy = { type: 'ewma', halfLifeSeconds: 10, targetChangeProbability: 0.1 } as const
    const seeded = next(undefined, 'a', policy)
    const rate = -Math.log(0.9) / 5
    expect(seeded.dataTTL).toBe(5)
    expect(seeded.ttlPolicyState?.changeRate).toBeCloseTo(rate, 12)
    const unchanged = next(seeded, 'a', policy, 11000)
    expect(unchanged.ttlPolicyState?.changeRate).toBeCloseTo(rate / 2, 12)
    expect(unchanged.dataTTL).toBe(10)
    const changed = next(unchanged, 'b', policy, 21000)
    expect(changed.ttlPolicyState?.changeRate).toBeCloseTo(rate / 4 + 0.05, 12)
    expect(changed.dataTTL).toBe(5)
    expect(changed.changeCount).toBe(2)
    expect(changed.lastChanged).toBe(21)
  })

  it('ignores zero and backward EWMA intervals while retaining observability and caps', () => {
    const policy = { type: 'ewma' } as const
    const prior = { ...next(undefined, 'a', policy, 2000), dataTTL: 17 }
    for (const now of [2000, 1000]) {
      const result = next(prior, 'b', policy, now)
      expect(result.dataTTL).toBe(17)
      expect(result.ttlPolicyState).toEqual(prior.ttlPolicyState)
      expect(result.changed).toBe(true)
    }
    expect(next(prior, 'a', policy, 2000, 9).dataTTL).toBe(9)
  })

  it('retains same-clock changes for a later sample and handles tiny probabilities', () => {
    const policy = { type: 'ewma', halfLifeSeconds: 10, targetChangeProbability: 1e-20 } as const
    const seeded = next(undefined, 'a', policy)
    expect(seeded.ttlPolicyState?.changeRate).toBeGreaterThan(0)
    const skipped = next(seeded, 'b', policy)
    expect(skipped.ttlPolicyState?.observedHash).toBe('a')
    expect(next(skipped, 'b', policy, 11000).ttlPolicyState?.changeRate).toBeCloseTo(0.05, 12)
    const huge = { type: 'aimd', increaseSeconds: Number.MAX_VALUE } as const
    const first = next(undefined, 'a', huge)
    expect(next({ ...first, dataTTL: Number.MAX_VALUE }, 'a', huge).dataTTL).toBe(100)
  })

  it('bounds EWMA zero rates and resets missing or changed policy state', () => {
    const policy = { type: 'ewma', halfLifeSeconds: 10, targetChangeProbability: 0.1 } as const
    const seeded = next(undefined, 'a', policy)
    const zero = { ...seeded, ttlPolicyState: { ...seeded.ttlPolicyState!, changeRate: 0 } }
    expect(next(zero, 'a', policy, 11000).dataTTL).toBe(100)
    expect(next(zero, 'a', { ...policy, halfLifeSeconds: 20 }, 11000).dataTTL).toBe(5)
    expect(next({ hash: 'a', dataTTL: 90 }, 'a', policy).dataTTL).toBe(5)
    const aimd = next(undefined, 'a', { type: 'aimd' })
    expect(next({ ...aimd, dataTTL: 90 }, 'a').dataTTL).toBe(5)
    expect(next({ ...aimd, dataTTL: 90 }, 'a', { type: 'aimd', increaseSeconds: 6 }).dataTTL).toBe(5)
  })
})
