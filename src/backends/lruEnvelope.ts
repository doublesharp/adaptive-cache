import type { AdaptiveCacheMetadata, AdaptiveCacheBackendUpdateInput } from '../types'

export const METADATA_SIZE_OVERHEAD_BYTES = 512

export interface LruEnvelope {
  encodedData: string
  hash: string
  dataTTL: number
  lastChanged: number
  changeCount: number
  tags: string[]
  createdAt: number
  updatedAt: number
  expiresAt: number
  freshUntil?: number
  namespaceGeneration?: string
  prefix: string
  writeToken?: string
  epochs?: Record<string, string>
}

export const toFiniteNumber = (value: unknown, fallback: number) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export const calculateNextMetadata = (
  previous: AdaptiveCacheMetadata | undefined,
  hash: string,
  initialTTL: number,
  maxTTL: number,
  ttlScaling: number,
  nowMs = Date.now(),
) => {
  const isChanged = !previous || previous.hash !== hash
  let dataTTL = toFiniteNumber(previous?.dataTTL, initialTTL)
  let lastChanged = toFiniteNumber(previous?.lastChanged, 0)
  let changeCount = toFiniteNumber(previous?.changeCount, 0)

  if (!isChanged) {
    if (dataTTL >= maxTTL) {
      dataTTL = maxTTL
    } else {
      const decayFactor = 1.0 - Math.min(0.9, changeCount * 0.01)
      const increaseFactor = Math.max(0, ttlScaling - 1)
      const increase = Math.ceil(Math.floor(dataTTL * increaseFactor) * decayFactor)
      dataTTL = Math.max(initialTTL, Math.min(dataTTL + increase, maxTTL))
    }
  } else {
    dataTTL = initialTTL
  }

  if (isChanged) {
    changeCount += 1
    lastChanged = Math.floor(nowMs / 1000)
  }
  return { dataTTL, lastChanged, changeCount, changed: isChanged }
}

export function metadataFromEnvelope(envelope: LruEnvelope): AdaptiveCacheMetadata {
  return {
    dataTTL: envelope.dataTTL,
    lastChanged: envelope.lastChanged,
    changeCount: envelope.changeCount,
    hash: envelope.hash,
  }
}

export function createEnvelope(
  input: AdaptiveCacheBackendUpdateInput,
  metadata: Required<Pick<AdaptiveCacheMetadata, 'dataTTL' | 'lastChanged' | 'changeCount' | 'hash'>>,
): LruEnvelope {
  const dataTTL = Math.min(input.maxTTL, toFiniteNumber(metadata.dataTTL, input.initialTTL))
  const freshTTL = dataTTL * (1 - Math.random() * (input.ttlJitter || 0))
  const now = Date.now()

  return {
    encodedData: input.encodedData,
    writeToken: input.writeToken,
    hash: metadata.hash,
    dataTTL,
    lastChanged: toFiniteNumber(metadata.lastChanged, 0),
    changeCount: toFiniteNumber(metadata.changeCount, 0),
    tags: input.tags,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + (freshTTL + (input.staleTTL || 0)) * 1000,
    freshUntil: now + freshTTL * 1000,
    prefix: input.redisPrefix,
  }
}

export function estimateEnvelopeSize(envelope: LruEnvelope) {
  return (
    Buffer.byteLength(envelope.encodedData, 'utf8') +
    Buffer.byteLength(JSON.stringify(envelope.tags), 'utf8') +
    Buffer.byteLength(JSON.stringify(envelope.epochs || {}), 'utf8') +
    METADATA_SIZE_OVERHEAD_BYTES
  )
}
