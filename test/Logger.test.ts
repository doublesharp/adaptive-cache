import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Logger } from '../src/lib/logger'
import defaultLogger from '../src/lib/logger'

// Mock debug module
const { mockDebugFn } = vi.hoisted(() => {
  return { mockDebugFn: vi.fn() }
})

vi.mock('debug', () => {
  return {
    default: vi.fn(() => mockDebugFn),
  }
})

describe('Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Constructor', () => {
    it('should default to info level', () => {
      const logger = new Logger()
      // Access private level property for testing
      expect((logger as any).level).toBe(1)
    })

    it('should set level correctly', () => {
      expect((new Logger('debug') as any).level).toBe(0)
      expect((new Logger('info') as any).level).toBe(1)
      expect((new Logger('warn') as any).level).toBe(2)
      expect((new Logger('error') as any).level).toBe(3)
      expect((new Logger('silent') as any).level).toBe(4)
    })
  })

  describe('Logging Methods', () => {
    it('should log info when level is info or lower', () => {
      const logger = new Logger('info')
      logger.info('test message')
      expect(mockDebugFn).toHaveBeenCalledWith('test message')
    })

    it('should not log info when level is higher than info', () => {
      const logger = new Logger('warn')
      logger.info('test message')
      expect(mockDebugFn).not.toHaveBeenCalled()
    })

    it('should log warn when level is warn or lower', () => {
      const logger = new Logger('warn')
      logger.warn('test message')
      expect(mockDebugFn).toHaveBeenCalledWith('test message')
    })

    it('should not log warn when level is higher than warn', () => {
      const logger = new Logger('error')
      logger.warn('test message')
      expect(mockDebugFn).not.toHaveBeenCalled()
    })

    it('should log error when level is error or lower', () => {
      const logger = new Logger('error')
      logger.error('test message')
      expect(mockDebugFn).toHaveBeenCalledWith('test message')
    })

    it('should not log error when level is higher than error', () => {
      const logger = new Logger('silent')
      logger.error('test message')
      expect(mockDebugFn).not.toHaveBeenCalled()
    })

    it('should log debug when level is debug', () => {
      const logger = new Logger('debug')
      logger.debug('test message')
      expect(mockDebugFn).toHaveBeenCalledWith('test message')
    })

    it('should not log debug when level is higher than debug', () => {
      const logger = new Logger('info')
      logger.debug('test message')
      expect(mockDebugFn).not.toHaveBeenCalled()
    })

    it('should pass multiple arguments', () => {
      const logger = new Logger('info')
      logger.info('message', { meta: true }, 123)
      expect(mockDebugFn).toHaveBeenCalledWith('message', { meta: true }, 123)
    })
  })

  describe('Default Export', () => {
    it('should be an instance of Logger', () => {
      expect(defaultLogger).toBeInstanceOf(Logger)
    })

    it('should have default info level', () => {
      expect((defaultLogger as any).level).toBe(1)
    })
  })
})
