import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const packageName = '@0xdoublesharp/adaptive-cache'
const target = process.argv[2] || 'core'
const frameworks = {
  express4: 'express@^4.18.2',
  express5: 'express@^5.0.0',
  fastify4: 'fastify@^4.0.0',
  fastify5: 'fastify@^5.0.0',
}
assert(target === 'core' || target === 'all' || target in frameworks, `Unknown compatibility target: ${target}`)
const targets = target === 'all' ? ['core', ...Object.keys(frameworks)] : [target]
const temporary = mkdtempSync(path.join(tmpdir(), 'adaptive-cache-packed-'))
const before = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
const run = (command, args, cwd, options = {}) =>
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    timeout: 180_000,
    ...options,
  })

// These consumers resolve only through the installed tarball's export map.
const common = `
assert.equal(typeof AdaptiveCache, 'function')
const scripts = new Map()
const client = { defineCommand(name, options) { scripts.set(name, options) } }
const redisCache = new AdaptiveCache({ logLevel: 'silent' }, client)
assert.equal(redisCache.client, client)
assert.equal(redisCache.resolveLoadTimeoutMs(), 30000)
assert.equal(redisCache.resolveLoadTimeoutMs({ loadTimeoutMs: 2147483647 }), 2147483647)
assert.throws(() => redisCache.resolveLoadTimeoutMs({ loadTimeoutMs: 2147483648 }), RangeError)
assert.equal(scripts.size, 7)
for (const name of ['adaptiveCacheFetch', 'adaptiveCacheUpdate', 'adaptiveCacheValidate', 'adaptiveCacheCleanup', 'adaptiveCacheInvalidate', 'shouldRefreshCache', 'releaseCacheRefreshLock']) {
  assert.equal(typeof scripts.get(name)?.lua, 'string', name + ' Lua asset missing')
  assert(scripts.get(name).lua.length > 50)
}
await redisCache.close()
`

const backend = `
const values = new Map()
const backend = {
  name: 'custom',
  async captureWriteToken() { return 'token' },
  async fetch(input) { return values.get(input.dataKey) || null },
  async update(input) {
    values.set(input.dataKey, { encodedData: input.encodedData, ttl: 60, layer: 'redis' })
    return ['UPDATED', 60]
  },
  async clear(_key, dataKey) { values.delete(dataKey) },
  async invalidateTags() { return [] },
  async shouldRefresh(_key, _threshold, _now, _force, _expiration, lock) { return ['UPDATE', lock] },
  async releaseLock() { return ['UPDATED'] },
}
const cache = new AdaptiveCache({ backend, keyPrefix: 'packed:', logLevel: 'silent' })
`

const coreTypes = `
import { AdaptiveCache, type AdaptiveCacheBackend, type AdaptiveCacheLoaderContext, type AdaptiveCacheCloseOptions, type AdaptiveCacheLoadOptions } from '${packageName}'
const cache = new AdaptiveCache({ loadTimeoutMs: 30000, closeTimeoutMs: 5000 })
const options: AdaptiveCacheLoadOptions<{ id: number }> = { signal: new AbortController().signal, loadTimeoutMs: 1000 }
const result: Promise<{ id: number }> = cache.getOrSet('typed', async ({ signal }: AdaptiveCacheLoaderContext) => {
  signal.throwIfAborted()
  return { id: 1 }
}, options)
const close: AdaptiveCacheCloseOptions = { timeoutMs: 5000 }
void cache.close(close)
void result
const deadline: number = cache.resolveLoadTimeoutMs({ loadTimeoutMs: 1000 })
void deadline
const quit: NonNullable<AdaptiveCacheBackend['quit']> = async (_preserve, _force) => undefined
void quit
`

const frameworkTypes = (name) =>
  name.startsWith('express')
    ? `
import express, { type Request } from 'express'
import { adaptiveExpressCache } from '${packageName}'
const middleware = adaptiveExpressCache<Request>({ key: (req) => req.path, loader: async (req) => ({ path: req.path }) })
express().use(middleware)
void middleware.clear({} as Request)
`
    : `
import fastify, { type FastifyRequest } from 'fastify'
import { adaptiveFastifyCache } from '${packageName}'
const plugin = adaptiveFastifyCache<FastifyRequest>({ key: (req) => req.url, loader: async (req) => ({ url: req.url }) })
void fastify().register(plugin)
void plugin.clear({} as FastifyRequest)
`

const expressRuntime = `
import express from 'express'
import { request } from 'node:http'
import { once } from 'node:events'
import { AdaptiveCache, adaptiveExpressCache } from '${packageName}'
${backend}
const app = express()
let calls = 0
const middleware = adaptiveExpressCache({ cache, keyPrefix: 'packed:' })
app.get('/item', middleware, (_req, res) => res.json({ calls: ++calls }))
const server = app.listen(0, '127.0.0.1')
try {
  await once(server, 'listening')
  const get = () => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/item', headers: { host: 'shop.example:8080' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }))
    })
    req.on('error', reject)
    req.end()
  })
  assert.deepEqual((await get()).body, { calls: 1 })
  await middleware.flush()
  const hit = await get()
  assert.equal(hit.headers['x-cache'], 'HIT')
  assert.deepEqual(hit.body, { calls: 1 })
  await middleware.clear({ originalUrl: '/item', query: {}, headers: { host: 'shop.example:8080' } })
  assert.deepEqual((await get()).body, { calls: 2 })
  await middleware.flush()
  await middleware.close()
  await cache.set('packed:still-owned', true)
  assert.equal((await cache.get('packed:still-owned')).data, true)
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await cache.close()
}
`

const fastifyRuntime = `
import fastify from 'fastify'
import { AdaptiveCache, adaptiveFastifyCache } from '${packageName}'
${backend}
const app = fastify()
const plugin = adaptiveFastifyCache({ cache, keyPrefix: 'packed:' })
let calls = 0
let outside = 0
app.get('/before', async () => ({ calls: ++outside }))
await app.register(plugin, { prefix: '/scoped' })
app.get('/outside', async () => ({ calls: ++outside }))
app.get('/scoped/item', { preHandler: async (req, reply) => {
  if (req.headers['x-deny']) return reply.code(401).send({ denied: true })
} }, async () => ({ calls: ++calls }))
try {
  const get = (url = '/scoped/item', headers = {}) => app.inject({ url, headers: { host: 'shop.example:8080', ...headers } })
  assert.deepEqual((await get()).json(), { calls: 1 })
  await plugin.flush()
  const hit = await get()
  assert.equal(hit.headers['x-cache'], 'HIT')
  assert.deepEqual(hit.json(), { calls: 1 })
  assert.equal((await get('/scoped/item', { 'x-deny': 'yes' })).statusCode, 401)
  await plugin.clear({ url: '/scoped/item', query: {}, headers: { host: 'shop.example:8080' } })
  assert.deepEqual((await get()).json(), { calls: 2 })
  await plugin.flush()
  for (const route of ['/outside', '/before']) {
    const first = (await get(route)).json().calls
    const second = (await get(route)).json().calls
    assert.equal(second, first + 1)
  }
} finally {
  await app.close()
  await cache.set('packed:still-owned', true)
  assert.equal((await cache.get('packed:still-owned')).data, true)
  await cache.close()
}
`

try {
  const packed = JSON.parse(
    run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root, {
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  )
  assert.equal(packed.length, 1)
  console.log(`Tarball ${packed[0].filename}: shasum ${packed[0].shasum}`)
  const tarball = path.join(temporary, packed[0].filename)
  const expectedLua = [
    'adaptiveCacheFetch',
    'adaptiveCacheUpdate',
    'adaptiveCacheValidate',
    'adaptiveCacheCleanup',
    'adaptiveCacheInvalidate',
    'shouldRefreshCache',
    'releaseCacheRefreshLock',
  ]
  for (const script of expectedLua)
    assert(packed[0].files.some(({ path: file }) => file === `dist/redis-lua/${script}.lua`))

  for (const name of targets) {
    const directory = mkdtempSync(path.join(temporary, `${name}-`))
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: `packed-${name}`, version: '1.0.0', private: true }),
    )
    const packages = [tarball, '@types/node@^22']
    if (name !== 'core') packages.push(frameworks[name])
    if (name.startsWith('express')) packages.push(`@types/express@^${name === 'express4' ? 4 : 5}`)
    // npm's --before applies the same seven-day age floor as repository resolution.
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', '--before', before, ...packages],
      directory,
    )
    const consumerRequire = createRequire(path.join(directory, 'package.json'))
    for (const peer of ['express', 'fastify', 'lru-cache', '@0xdoublesharp/lru-cache-clustered']) {
      if (name.startsWith(peer)) continue
      assert.throws(
        () => consumerRequire.resolve(peer),
        { code: 'MODULE_NOT_FOUND' },
        `${peer} must be absent in ${name}`,
      )
    }
    const manifest = JSON.parse(
      readFileSync(consumerRequire.resolve(`${packageName}`).replace(/dist[/\\]index\.js$/, 'package.json'), 'utf8'),
    )
    assert.equal(manifest.name, packageName)
    if (name === 'core') {
      run(
        process.execPath,
        [
          '-e',
          `const assert = require('node:assert/strict'); const { AdaptiveCache } = require('${packageName}'); (async () => { ${common} })().catch(error => { console.error(error); process.exitCode = 1 })`,
        ],
        directory,
      )
      run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import assert from 'node:assert/strict'; import { AdaptiveCache } from '${packageName}'; ${common}`,
        ],
        directory,
      )
    } else {
      writeFileSync(
        path.join(directory, 'runtime.mjs'),
        `import assert from 'node:assert/strict'\n${name.startsWith('express') ? expressRuntime : fastifyRuntime}`,
      )
      run(process.execPath, ['runtime.mjs'], directory)
    }
    for (const extension of ['mts', 'cts']) {
      const fixture = path.join(directory, `consumer.${extension}`)
      writeFileSync(fixture, coreTypes + (name === 'core' ? '' : frameworkTypes(name)))
      run(
        process.execPath,
        [
          require.resolve('typescript/bin/tsc'),
          '--ignoreConfig',
          '--noEmit',
          '--strict',
          '--target',
          'es2022',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--esModuleInterop',
          fixture,
        ],
        directory,
      )
    }
    const frameworkVersion =
      name === 'core'
        ? ''
        : ` ${consumerRequire(name.startsWith('express') ? 'express/package.json' : 'fastify/package.json').version}`
    console.log(
      `Packed ${name}${frameworkVersion} consumer passed on ${process.version}: runtime, CJS/ESM declarations, optional-peer isolation`,
    )
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
