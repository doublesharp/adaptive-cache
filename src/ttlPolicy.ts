import type { AdaptiveCacheTtlPolicy } from './types'

const positive = (name: string, value: number) => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`ttlPolicy.${name} must be a positive finite number`)
  return value
}
const fraction = (name: string, value: number) => {
  positive(name, value)
  if (value >= 1) throw new RangeError(`ttlPolicy.${name} must be less than 1`)
  return value
}

export function normalizeTtlPolicy(policy?: AdaptiveCacheTtlPolicy): Required<AdaptiveCacheTtlPolicy> {
  if (policy === undefined) return { type: 'adaptive' }
  if (!policy || typeof policy !== 'object') throw new TypeError('ttlPolicy must be a policy object')
  switch (policy.type) {
    case 'adaptive':
      return { type: 'adaptive' }
    case 'aimd':
      return {
        type: 'aimd',
        increaseSeconds: positive('increaseSeconds', policy.increaseSeconds === undefined ? 5 : policy.increaseSeconds),
        decreaseFactor: fraction('decreaseFactor', policy.decreaseFactor === undefined ? 0.5 : policy.decreaseFactor),
      }
    case 'ewma':
      return {
        type: 'ewma',
        halfLifeSeconds: positive(
          'halfLifeSeconds',
          policy.halfLifeSeconds === undefined ? 300 : policy.halfLifeSeconds,
        ),
        targetChangeProbability: fraction(
          'targetChangeProbability',
          policy.targetChangeProbability === undefined ? 0.1 : policy.targetChangeProbability,
        ),
      }
    default:
      throw new TypeError('ttlPolicy.type must be adaptive, aimd, or ewma')
  }
}

export function validateTtlPolicySeed(policy: Required<AdaptiveCacheTtlPolicy>, initialTTL: number): void {
  if (policy.type !== 'ewma') return
  const rate = -Math.log1p(-policy.targetChangeProbability) / initialTTL
  if (!Number.isFinite(rate) || rate <= 0)
    throw new RangeError('ttlPolicy and initialTTL must produce a finite positive EWMA rate')
}
