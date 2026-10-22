/* global require */
const fs = require('node:fs')
const net = require('node:net')
const { once } = require('node:events')
const ts = require('typescript')

// Load current source in a real Node process without relying on a previous build.
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  })
  module._compile(outputText, filename)
}

const Redis = require('ioredis')
const { AdaptiveCache } = require('../../src/AdaptiveCache.ts')
const { RedisAdaptiveCacheBackend } = require('../../src/backends/RedisAdaptiveCacheBackend.ts')

async function main() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

  // Keep the client cache-owned while making QUIT reject immediately during retries.
  RedisAdaptiveCacheBackend.createClient = () => {
    const client = new Redis({ host: '127.0.0.1', port, enableOfflineQueue: false, retryStrategy: () => 20 })
    client.on('error', () => {})
    return client
  }
  const cache = new AdaptiveCache({ backend: process.argv[2], logLevel: 'silent', closeTimeoutMs: 1000 })
  const [error] = await once(cache.client, 'error')
  if (error.code !== 'ECONNREFUSED') throw error
  console.log('Redis refused connection')
  try {
    await cache.close()
    throw new Error('Expected graceful shutdown to reject')
  } catch (error) {
    if (!error.message.includes('enableOfflineQueue')) throw error
    console.log('Shutdown rejected')
  }
  // No process.exit(): leaked sockets or reconnect timers must fail the parent timeout.
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
