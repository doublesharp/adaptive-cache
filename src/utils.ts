import crypto from 'node:crypto'
import { AdaptiveCacheOptions } from './types'

const cacheTime = process.env.CACHE_TIME || '5 seconds'

export const parseDuration = (duration: string | number): number => {
  if (typeof duration === 'number') return duration
  if (typeof duration === 'string') {
    const parts = duration.split(' ')
    const val = parseInt(parts[0])
    if (isNaN(val)) return 5
    const unit = parts[1]
    if (!unit) return val
    if (unit.startsWith('second')) return val
    if (unit.startsWith('minute')) return val * 60
    if (unit.startsWith('hour')) return val * 3600
    if (unit.startsWith('day')) return val * 86400
  }
  return 5
}

export const cache = (time: string | number = cacheTime): AdaptiveCacheOptions => {
  return { initialTTL: parseDuration(time) }
}

export const getAdaptiveCacheKey = (requestPath: string, querystring: any, redisPrefix: string) => {
  const baseKey = requestPath + ':' // Remove query params from cache key
  const queryKey = crypto.createHash('sha256').update(JSON.stringify(querystring)).digest('hex') + ':'
  return redisPrefix + baseKey + queryKey
}
