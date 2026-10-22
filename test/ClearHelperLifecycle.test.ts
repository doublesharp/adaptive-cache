import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { clearAdaptiveCache } from '../src/AdaptiveExpressCache'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'

const logger = new Logger('silent')

describe('temporary clear helper cleanup', () => {
  it.each([false, true])('preserves a failed clear when cleanup also fails: %s', async (clearFails) => {
    const source = new Error('clear failed')
    const cleanup = new Error('shutdown failed')
    const clear = vi.spyOn(ClusteredLruAdaptiveCacheBackend.prototype, 'clear')
    if (clearFails) clear.mockRejectedValue(source)
    else clear.mockResolvedValue(undefined)
    vi.spyOn(AdaptiveCache.prototype, 'quit').mockRejectedValue(cleanup)
    try {
      await expect(clearAdaptiveCache('/item', {}, 'helper:', { backend: 'clustered-lru' })).rejects.toBe(
        clearFails ? source : cleanup,
      )
    } finally {
      vi.restoreAllMocks()
    }
  })

  it.each([false, true])(
    'detaches a temporary helper observer without closing a borrowed backend: %s',
    async (fail) => {
      const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: randomUUID() }, logger)
      const failure = new Error('clear failed')
      const quit = vi.spyOn(backend, 'quit')
      const flush = vi.fn(() => new Promise<void>(() => {}))
      Object.assign(backend, { flush })
      const events = vi.fn()
      if (fail) vi.spyOn(backend, 'clear').mockRejectedValue(failure)
      try {
        const clearing = clearAdaptiveCache('/item', {}, 'helper:', { backend, onEvent: events })
        if (fail) await expect(clearing).rejects.toBe(failure)
        else {
          await clearing
          expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'invalidate', reason: 'clear' }))
        }
        expect((backend as any).listeners.size).toBe(0)
        expect(quit).not.toHaveBeenCalled()
        expect(flush).not.toHaveBeenCalled()
        expect(await backend.captureWriteToken('helper:')).toBeTypeOf('string')
      } finally {
        vi.restoreAllMocks()
        await backend.quit()
      }
    },
  )
})
