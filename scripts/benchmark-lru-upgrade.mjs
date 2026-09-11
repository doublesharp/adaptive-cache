import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
// Usage: node --expose-gc scripts/benchmark-lru-upgrade.mjs /absolute/package/root
// The root contains dist/index.js and its own node_modules dependency selection.
const cluster = require('node:cluster')
const assert = require('node:assert/strict')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const root = path.resolve(process.argv[2] || '.')
const { AdaptiveCache } = require(path.join(root, 'dist/index.js'))
const { LRUCacheClustered } = require(path.join(root, 'node_modules/@0xdoublesharp/lru-cache-clustered'))
const version = require(path.join(root, 'node_modules/@0xdoublesharp/lru-cache-clustered/package.json')).version
const keys = Number(process.env.BENCH_KEYS || 300)
const reads = Number(process.env.BENCH_READS || 3000)
const batches = Number(process.env.BENCH_BATCHES || 100)
const modes = (process.env.BENCH_MODES || 'primary,worker,worker-l1').split(',')
const body = 'x'.repeat(2048)
let sent = 0
let forceBackpressure = false
if (cluster.isWorker) {
  const send = process.send.bind(process)
  process.send = (message, ...args) => {
    if (message?.source && message?.id) sent++
    const result = send(message, ...args)
    return forceBackpressure && message?.source && message?.id ? false : result
  }
}
const options = (namespace, localL1) => ({
  backend: 'clustered-lru',
  keyPrefix: namespace + ':',
  compress: false,
  initialTTL: 300,
  maxTTL: 600,
  logLevel: 'silent',
  lru: {
    namespace,
    maxSizeBytes: 32 * 1024 * 1024,
    localL1: localL1 ? { enabled: true, experimental: true, max: 2000, ttl: 60000, updateAgeOnGet: true } : false,
  },
})
const key = (namespace, i) => `${namespace}:${i}`
async function measure(count, operation) {
  const latencies = []
  const before = sent
  const start = performance.now()
  for (let i = 0; i < count; i++) {
    const at = performance.now()
    await operation(i)
    latencies.push(performance.now() - at)
  }
  const ms = performance.now() - start
  latencies.sort((a, b) => a - b)
  return {
    opsPerSecond: (count * 1000) / ms,
    p95Ms: latencies[Math.ceil(count * 0.95) - 1],
    ipcPerOperation: (sent - before) / count,
  }
}
async function benchmark(cache, namespace) {
  const check = async (i) => {
    const hit = await cache.get(key(namespace, i % keys))
    assert.equal(hit?.data.id, i % keys)
    assert.equal(hit.data.body, body)
  }
  // Warm JIT/runtime without populating the measured keys in the worker's L1.
  for (let i = 0; i < 200; i++) await cache.get(key(namespace, 'missing'))
  const cold = await measure(keys, check)
  const hot = await measure(reads, check)
  const batch = await measure(batches, async (i) => {
    const requested = Array.from({ length: 32 }, (_, j) => key(namespace, (i * 32 + j) % keys))
    const hits = await cache.getMany(requested)
    for (const k of requested) assert.equal(hits.get(k)?.data.id, Number(k.split(':').at(-1)))
  })
  const writes = await measure(100, async (i) => {
    const result = await cache.set(key(namespace, i), { id: i, body })
    assert.equal(result[0], 'CACHED')
  })
  return { cold, hot, batch, writes }
}
async function workerMain() {
  const namespace = process.env.BENCH_NAMESPACE
  const cache = new AdaptiveCache(options(namespace, process.env.BENCH_L1 === '1'))
  process.on('message', async (message) => {
    if (message?.kind !== 'benchmark') return
    try {
      let value
      if (message.action === 'run') value = await benchmark(cache, namespace)
      if (message.action === 'read') {
        const hits = await cache.getMany([key(namespace, 'retained'), key(namespace, 'never-stored')])
        assert.equal(hits.get(key(namespace, 'never-stored')), null)
        value = hits.get(key(namespace, 'retained'))?.data ?? null
      }
      if (message.action === 'backpressure') {
        const before = sent
        forceBackpressure = true
        try {
          assert.equal((await cache.get(key(namespace, 'pressure')))?.data, 'value')
          value = { passed: true, requests: sent - before }
        } catch (error) {
          value = { passed: false, error: error.message, requests: sent - before }
        } finally {
          forceBackpressure = false
        }
        assert.ok(value.requests > 0)
      }
      if (message.action === 'close') await cache.close()
      process.send({ kind: 'result', id: message.id, value })
    } catch (error) {
      process.send({ kind: 'result', id: message.id, error: error.stack })
    }
  })
  process.send({ kind: 'ready' })
}
async function primaryMain() {
  LRUCacheClustered.bootstrap()
  const rows = []
  for (const mode of modes) {
    const namespace = `bench-${process.pid}-${mode}`
    const cache = new AdaptiveCache(options(namespace, false))
    let worker
    try {
      for (let i = 0; i < keys; i++) await cache.set(key(namespace, i), { id: i, body })
      if (mode === 'primary') rows.push({ mode, ...(await benchmark(cache, namespace)) })
      else {
        worker = cluster.fork({ BENCH_NAMESPACE: namespace, BENCH_L1: mode === 'worker-l1' ? '1' : '0' })
        await new Promise((resolve, reject) => {
          worker.on('message', (m) => {
            if (m?.kind === 'ready') resolve()
          })
          worker.once('error', reject)
        })
        let id = 0
        const call = (action) =>
          new Promise((resolve, reject) => {
            const current = ++id
            const listener = (m) => {
              if (m?.kind !== 'result' || m.id !== current) return
              worker.off('message', listener)
              m.error ? reject(new Error(m.error)) : resolve(m.value)
            }
            worker.on('message', listener)
            worker.send({ kind: 'benchmark', id: current, action })
          })
        const result = await call('run')
        await cache.set(key(namespace, 'retained'), 'before', { tags: ['shared'] })
        assert.equal(await call('read'), 'before')
        await cache.set(key(namespace, 'retained'), 'after', { tags: ['shared'] })
        // Broadcast invalidation is eventual; verify the same retained worker cache converges.
        let observed
        for (let i = 0; i < 50; i++) {
          observed = await call('read')
          if (observed === 'after') break
          await delay(10)
        }
        assert.equal(observed, 'after')
        await cache.invalidateTags(['shared'])
        assert.equal(await call('read'), null)
        await cache.set(key(namespace, 'retained'), 'namespace')
        assert.equal(await call('read'), 'namespace')
        await cache.invalidateNamespace()
        assert.equal(await call('read'), null)
        await cache.set(key(namespace, 'pressure'), 'value')
        const backpressure = await call('backpressure')
        rows.push({
          mode,
          ...result,
          retainedInvalidation: true,
          batchInvalidation: true,
          tagInvalidation: true,
          backpressure,
        })
        await call('close')
      }
    } finally {
      if (worker) {
        const exited = new Promise((resolve) => worker.once('exit', resolve))
        worker.disconnect()
        await exited
      }
      await cache.close()
    }
  }
  console.log(JSON.stringify({ version, node: process.version, keys, reads, batches, rows }))
}
;(cluster.isPrimary ? primaryMain() : workerMain()).catch((error) => {
  console.error(error)
  process.exit(1)
})
