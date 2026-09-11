import { normalizeTtlPolicy } from './ttlPolicy'
import type { AdaptiveCacheTtlPolicy, AdaptiveCacheTtlPolicyState } from './types'

// Redis cjson stores 14 significant digits. Ignore representational noise at
// integer boundaries for EWMA, with tolerance capped far below one second.
const roundedTTL = (value: number, initialTTL: number, maxTTL: number, ewma = false) => {
  const bounded = Math.max(initialTTL, Math.min(maxTTL, value))
  const tolerance = ewma ? Math.min(1e-7, Math.abs(bounded) * 1e-12) : 0
  return Math.max(initialTTL, Math.min(maxTTL, Math.ceil(bounded - tolerance)))
}

export function calculatePolicyTTL(
  previousTTL: number,
  previousState: AdaptiveCacheTtlPolicyState | undefined,
  changed: boolean,
  hash: string,
  initialTTL: number,
  maxTTL: number,
  policy: AdaptiveCacheTtlPolicy,
  nowMs: number,
): { dataTTL: number; ttlPolicyState?: AdaptiveCacheTtlPolicyState } {
  const normalized = normalizeTtlPolicy(policy)
  if (normalized.type === 'adaptive') return { dataTTL: initialTTL }
  const signature = JSON.stringify(normalized)
  const mass = normalized.type === 'ewma' ? -Math.log1p(-normalized.targetChangeProbability) : 0
  if (!previousState || previousState.signature !== signature) {
    return {
      dataTTL: initialTTL,
      ttlPolicyState: { signature, observedAt: nowMs, observedHash: hash, changeRate: mass / initialTTL },
    }
  }
  if (normalized.type === 'aimd') {
    const target = changed ? previousTTL * normalized.decreaseFactor : previousTTL + normalized.increaseSeconds
    return { dataTTL: roundedTTL(target, initialTTL, maxTTL), ttlPolicyState: previousState }
  }
  const elapsedSeconds = (nowMs - previousState.observedAt) / 1000
  if (elapsedSeconds <= 0) {
    return { dataTTL: Math.max(initialTTL, Math.min(maxTTL, previousTTL)), ttlPolicyState: previousState }
  }
  const alpha = -Math.expm1((-Math.LN2 * elapsedSeconds) / normalized.halfLifeSeconds)
  const sampleRate = previousState.observedHash !== hash ? 1 / elapsedSeconds : 0
  const changeRate = (1 - alpha) * previousState.changeRate + alpha * sampleRate
  const target = changeRate > 0 ? mass / changeRate : maxTTL
  return {
    dataTTL: roundedTTL(target, initialTTL, maxTTL, true),
    ttlPolicyState: { signature, observedAt: nowMs, observedHash: hash, changeRate },
  }
}
