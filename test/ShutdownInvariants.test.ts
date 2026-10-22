import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { clearAdaptiveCache } from '../src/AdaptiveExpressCache'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { ControlledBackend } from './helpers/httpFixtures'
import { FakeRedis } from './helpers/FakeRedis'
import { fuzzParameters, fuzzTimeoutMs } from './helpers/fuzz'

const failureMode = fc.constantFrom('none', 'throw', 'reject')
const stageMode = fc.constantFrom('none', 'throw', 'reject', 'stall')
const logger = new Logger('silent')

describe('shutdown invariants', () => {
  it(
    'never accumulates helper observers or shuts down a borrowed backend across arbitrary clears',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(failureMode, { minLength: 1, maxLength: 40 }),
          fc.boolean(),
          async (failures, frozen) => {
            const failure = new Error('clear failed')
            class BorrowedBackend extends ControlledBackend {
              #observers = new Set<unknown>()
              #mode = 'none'
              setMode(mode: string) {
                this.#mode = mode
              }
              onEvent(listener: unknown) {
                this.#observers.add(listener)
                return () => {
                  this.#observers.delete(listener)
                }
              }
              observerCount() {
                return this.#observers.size
              }
              clear(_key: string): Promise<void> {
                if (this.#mode === 'throw') throw failure
                if (this.#mode === 'reject') return Promise.reject(failure)
                return Promise.resolve()
              }
            }
            const backend = new BorrowedBackend()
            if (frozen) {
              Object.assign(backend, {
                clear: backend.clear.bind(backend),
                onEvent: backend.onEvent.bind(backend),
                quit: backend.quit.bind(backend),
                flush: backend.flush.bind(backend),
              })
              Object.freeze(backend)
            }
            for (const mode of failures) {
              backend.setMode(mode)
              const outcome = await clearAdaptiveCache('/item', {}, 'fuzz:', { backend, logLevel: 'silent' }).then(
                () => undefined,
                (error) => error,
              )
              expect(outcome).toBe(mode === 'none' ? undefined : failure)
              expect(backend.observerCount()).toBe(0)
              expect(backend.quitCalls).toBe(0)
              expect(backend.flushCalls).toBe(0)
            }
          },
        ),
        { ...fuzzParameters, examples: [[['none'], true]] },
      )
    },
    fuzzTimeoutMs,
  )

  it(
    'attempts every L1 cleanup, preserves the first failure, and respects connection ownership',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            owned: fc.boolean(),
            preserve: fc.boolean(),
            force: fc.boolean(),
            flush: failureMode,
            subscriber: failureMode,
            redis: failureMode,
            lru: failureMode,
          }),
          async (scenario) => {
            const calls: string[] = []
            const failures = {
              flush: new Error('flush'),
              subscriber: new Error('subscriber'),
              redis: new Error('redis'),
              lru: new Error('lru'),
            }
            const attempt = (stage: keyof typeof failures) => {
              calls.push(stage)
              if (scenario[stage] === 'throw') throw failures[stage]
              if (scenario[stage] === 'reject') return Promise.reject(failures[stage])
              return Promise.resolve('OK')
            }
            const redis = new FakeRedis()
            const lru = new ClusteredLruAdaptiveCacheBackend(undefined, logger)
            const backend = new L1RedisAdaptiveCacheBackend(
              new RedisAdaptiveCacheBackend(redis as any, logger, scenario.owned),
              lru,
              'fuzz:',
              logger,
            )
            const subscriber = (backend as any).subscriber as FakeRedis
            redis.quit = () => attempt('redis')
            subscriber.quit = () => attempt('subscriber')
            backend.flush = async () => {
              await attempt('flush')
            }
            const lruQuit = vi.spyOn(lru, 'quit').mockImplementation(async () => {
              await attempt('lru')
            })
            const outcome = await backend.quit(scenario.preserve, scenario.force).then(
              () => undefined,
              (error) => error,
            )
            const expectedStages = scenario.force
              ? ['lru']
              : ['flush', 'subscriber', ...(scenario.owned ? ['redis'] : []), 'lru']
            const firstFailure = expectedStages.find((stage) => scenario[stage as keyof typeof failures] !== 'none')
            expect(calls).toEqual(expectedStages)
            expect(outcome).toBe(firstFailure ? failures[firstFailure as keyof typeof failures] : undefined)
            expect(subscriber.disconnectCalls).toBe(1)
            expect((backend as any).subscriber).toBeUndefined()
            expect(redis.disconnectCalls).toBe(scenario.owned ? 1 : 0)
            expect(lruQuit).toHaveBeenCalledWith(scenario.preserve)
            lruQuit.mockRestore()
          },
        ),
        fuzzParameters,
      )
    },
    fuzzTimeoutMs,
  )

  it(
    'shares close outcomes, forces failed or stalled teardown once, and rejects later work',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            flush: stageMode,
            quit: stageMode,
            forced: stageMode,
            preserve: fc.boolean(),
            callers: fc.integer({ min: 2, max: 8 }),
            delay: fc.integer({ min: 0, max: 2 }),
          }),
          async (scenario) => {
            vi.useFakeTimers()
            try {
              const failures = { flush: new Error('flush'), quit: new Error('quit'), forced: new Error('forced') }
              const calls: Array<{ preserve?: boolean; force?: boolean }> = []
              const stage = (name: keyof typeof failures): Promise<void> => {
                const mode = scenario[name]
                if (mode === 'throw') throw failures[name]
                if (mode === 'reject') return Promise.reject(failures[name])
                if (mode === 'stall') return new Promise(() => {})
                return new Promise((resolve) => setTimeout(resolve, scenario.delay))
              }
              const backend = new ControlledBackend()
              backend.flush = () => stage('flush')
              backend.quit = (preserve?: boolean, force?: boolean) => {
                calls.push({ preserve, force })
                return stage(force ? 'forced' : 'quit')
              }
              const unsubscribe = vi.fn()
              Object.assign(backend, { onEvent: () => unsubscribe })
              const cache = new AdaptiveCache({ backend, closeTimeoutMs: 5, logLevel: 'silent' })
              const closing = cache.quit(scenario.preserve)
              expect(cache.quit(!scenario.preserve)).toBe(closing)
              const outcomes = Promise.all(
                Array.from({ length: scenario.callers }, (_, index) =>
                  (index % 2 ? cache.close() : closing).then(
                    () => undefined,
                    (error) => error,
                  ),
                ),
              )
              await vi.advanceTimersByTimeAsync(20)
              const results = await outcomes
              const failedStage = scenario.flush !== 'none' ? 'flush' : scenario.quit !== 'none' ? 'quit' : undefined
              const failure = failedStage && scenario[failedStage] !== 'stall' ? failures[failedStage] : undefined
              for (const result of results) {
                if (failure) expect(result).toBe(failure)
                else if (failedStage) expect(result).toMatchObject({ name: 'TimeoutError' })
                else expect(result).toBeUndefined()
                expect(result).toBe(results[0])
              }
              expect(calls.filter((call) => !call.force)).toHaveLength(scenario.flush === 'none' ? 1 : 0)
              expect(calls.filter((call) => call.force)).toHaveLength(failedStage ? 1 : 0)
              expect(calls.every((call) => call.preserve === scenario.preserve)).toBe(true)
              expect(unsubscribe).toHaveBeenCalledTimes(1)
              await expect(cache.set('late', 'value')).rejects.toThrow('closed')
              expect(backend.updateInputs).toHaveLength(0)
              expect(vi.getTimerCount()).toBe(0)
            } finally {
              vi.useRealTimers()
            }
          },
        ),
        fuzzParameters,
      )
    },
    fuzzTimeoutMs,
  )
})
