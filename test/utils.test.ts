import { describe, it, expect } from 'vitest'
import { parseDuration, getAdaptiveCacheKey } from '../src/utils'

describe('utils', () => {
  describe('parseDuration', () => {
    it('should return number as is', () => {
      expect(parseDuration(10)).toBe(10)
    })

    it('should parse seconds', () => {
      expect(parseDuration('10 seconds')).toBe(10)
      expect(parseDuration('1 second')).toBe(1)
    })

    it('should parse minutes', () => {
      expect(parseDuration('5 minutes')).toBe(300)
      expect(parseDuration('1 minute')).toBe(60)
    })

    it('should parse hours', () => {
      expect(parseDuration('1 hour')).toBe(3600)
    })

    it('should parse days', () => {
      expect(parseDuration('1 day')).toBe(86400)
    })

    it('should handle no unit', () => {
      expect(parseDuration('100')).toBe(100)
    })

    it('should return default for unknown format', () => {
      expect(parseDuration('invalid')).toBe(5)
    })

    it('should return default for invalid number string without unit', () => {
      expect(parseDuration('invalid')).toBe(5)
    })

    it('should return default for unknown unit', () => {
      expect(parseDuration('1 week')).toBe(5)
    })

    it('should handle invalid types in parseDuration', async () => {
      const { parseDuration } = await import('../src/utils')
      expect(parseDuration(true as any)).toBe(5)
      expect(parseDuration({} as any)).toBe(5)
      expect(parseDuration(null as any)).toBe(5)
      expect(parseDuration(undefined as any)).toBe(5)
    })
  })

  describe('getAdaptiveCacheKey', () => {
    it('should generate key', () => {
      const key = getAdaptiveCacheKey('/path', { q: 1 }, 'prefix:')
      expect(key).toContain('prefix:/path:')
    })
  })
})
