import type { AdaptiveCacheBackendFetchInput, AdaptiveCacheFetchResult } from '../types'
import { type LruEnvelope, metadataFromEnvelope } from './lruEnvelope'

export function lruFetchResult(
  envelope: LruEnvelope,
  input: AdaptiveCacheBackendFetchInput,
): (AdaptiveCacheFetchResult & { writeToken?: string; revision?: string; freshUntil?: number }) | null {
  // Validation can await IPC: check retention again after those reads complete.
  const now = Date.now()
  if (envelope.expiresAt <= now) return null
  const freshUntil = envelope.freshUntil ?? envelope.expiresAt
  const stale = freshUntil <= now
  if (stale && !input.allowStale) return null
  return {
    encodedData: envelope.encodedData,
    writeToken: envelope.writeToken,
    revision: envelope.revision,
    freshUntil,
    ttl: Math.max(0, Math.ceil((freshUntil - now) / 1000)),
    stale,
    staleAge: Math.max(0, (now - freshUntil) / 1000),
    layer: 'lru',
    metadata: metadataFromEnvelope(envelope),
  }
}

export async function fetchLruMany(
  cache: { mGet(keys: string[], opts?: { bypassL1?: boolean }): Promise<Map<string, any>> },
  inputs: AdaptiveCacheBackendFetchInput[],
): Promise<Array<AdaptiveCacheFetchResult | null>> {
  if (!inputs.length) return []
  const envelopes = await cache.mGet([...new Set(inputs.map((input) => input.dataKey))])
  const controls = new Set<string>()
  for (const input of inputs) {
    const envelope = envelopes.get(input.dataKey) as LruEnvelope | undefined
    if (!envelope || envelope.expiresAt <= Date.now()) continue
    if (envelope.namespaceGeneration) controls.add(input.redisPrefix + '__adaptive:namespace')
    for (const key of Object.keys(envelope.epochs || {})) controls.add(key)
  }
  // Payloads may come from worker-local L1. Control values must come from the primary.
  // Missing controls fail closed; a read must not recreate them from cached payloads.
  const epochs = controls.size ? await cache.mGet([...controls], { bypassL1: true }) : new Map<string, string>()
  return inputs.map((input) => {
    const envelope = envelopes.get(input.dataKey) as LruEnvelope | undefined
    if (!envelope) return null
    if (
      envelope.namespaceGeneration &&
      epochs.get(input.redisPrefix + '__adaptive:namespace') !== envelope.namespaceGeneration
    )
      return null
    for (const [key, epoch] of Object.entries(envelope.epochs || {})) {
      if (epochs.get(key) !== epoch) return null
    }
    return lruFetchResult(envelope, input)
  })
}
