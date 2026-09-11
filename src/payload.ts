import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import type { AdaptiveCacheOptions } from './types'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)
const CODEC_PREFIX = 'adaptive-cache:v2:'

export const encodePayload = (data: any): string =>
  JSON.stringify({
    __adaptiveCachePayload: 1,
    type: Buffer.isBuffer(data)
      ? 'buffer'
      : typeof data === 'string'
        ? 'string'
        : typeof data === 'undefined'
          ? 'undefined'
          : 'json',
    value: Buffer.isBuffer(data) ? data.toString('base64') : data,
  })

const decodePayload = (raw: string): any => {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== 'object' || parsed.__adaptiveCachePayload !== 1) return parsed
  if (parsed.type === 'buffer') return Buffer.from(String(parsed.value || ''), 'base64')
  if (parsed.type === 'undefined') return undefined
  return parsed.value
}

const isCompressed = (value: any) => {
  const data =
    value?.__adaptiveCacheHttpResponse === 1 && value.isBuffer === true && typeof value.body === 'string'
      ? Buffer.from(value.body, 'base64')
      : value
  return (
    Buffer.isBuffer(data) &&
    ((data[0] === 0x1f && data[1] === 0x8b) || // gzip
      (data[0] === 0x50 && data[1] === 0x4b) || // ZIP
      (data[0] === 0x89 && data.subarray(1, 4).toString() === 'PNG') ||
      (data[0] === 0xff && data[1] === 0xd8) || // JPEG
      (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'))
  )
}

export async function encode(data: any, options: AdaptiveCacheOptions): Promise<string> {
  const raw = encodePayload(data)
  const settings = options.compression
  if (!settings) return options.compress === false ? raw : zlib.gzipSync(Buffer.from(raw)).toString('base64')
  const bytes = Buffer.from(raw)
  if (
    options.compress === false ||
    bytes.length < (settings.minBytes ?? 0) ||
    (settings.skipCompressed && isCompressed(data))
  ) {
    return CODEC_PREFIX + 'json:' + raw
  }
  const compressed = (settings.async ? await gzip(bytes) : zlib.gzipSync(bytes)).toString('base64')
  return settings.onlyIfSmaller && Buffer.byteLength(compressed) >= bytes.length
    ? CODEC_PREFIX + 'json:' + raw
    : CODEC_PREFIX + 'gzip:' + compressed
}

export async function decode(encoded: string, options: AdaptiveCacheOptions): Promise<any> {
  let raw: string
  if (encoded.startsWith(CODEC_PREFIX + 'json:')) {
    raw = encoded.slice((CODEC_PREFIX + 'json:').length)
  } else if (encoded.startsWith(CODEC_PREFIX + 'gzip:')) {
    const bytes = Buffer.from(encoded.slice((CODEC_PREFIX + 'gzip:').length), 'base64')
    raw = (options.compression?.async ? await gunzip(bytes) : zlib.gunzipSync(bytes)).toString('utf8')
  } else {
    raw = options.compress === false ? encoded : zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')
  }
  return decodePayload(raw)
}

export function fingerprint(data: any, options: AdaptiveCacheOptions): string {
  if (options.fingerprint) return crypto.createHash('sha256').update(options.fingerprint(data)).digest('hex')
  let input = data
  if (options.ignoreFields?.length && data && typeof data === 'object' && !Buffer.isBuffer(data)) {
    input = JSON.parse(JSON.stringify(data))
    for (const path of options.ignoreFields) {
      const fields = path.split('.')
      let cursor = input
      for (const field of fields.slice(0, -1)) {
        if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, field)) {
          cursor = undefined
          break
        }
        cursor = cursor[field]
      }
      if (cursor && typeof cursor === 'object') delete cursor[fields[fields.length - 1]]
    }
  }
  return crypto.createHash('sha256').update(encodePayload(input)).digest('hex')
}
