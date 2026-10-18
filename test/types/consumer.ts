import express, { type Request } from 'express'
import fastify, { type FastifyRequest } from 'fastify'
import {
  AdaptiveCache,
  adaptiveExpressCache,
  adaptiveFastifyCache,
  type AdaptiveCacheTtlPolicy,
  type AdaptiveCacheTtlPolicyState,
} from '../../dist/index.js'
const policy: AdaptiveCacheTtlPolicy = { type: 'ewma', halfLifeSeconds: 30, targetChangeProbability: 0.1 }
const cache = new AdaptiveCache({ backend: 'clustered-lru', ttlPolicy: policy })
const value: Promise<{ id: number }> = cache.getOrSet('item', async () => ({ id: 1 }))
void value
const expressMiddleware = adaptiveExpressCache({
  backend: 'clustered-lru',
  ttlPolicy: { type: 'aimd', increaseSeconds: 2 },
})
express().use(expressMiddleware)
void expressMiddleware.clear({} as Request)
const plugin = adaptiveFastifyCache({ backend: 'clustered-lru', ttlPolicy: policy })
void fastify().register(plugin)
void plugin.clear({} as FastifyRequest)
const state: AdaptiveCacheTtlPolicyState = {
  signature: 'policy',
  observedAt: 1000,
  observedHash: 'hash',
  changeRate: 0.1,
}
void state

const typedExpress = adaptiveExpressCache<Request & { tenant: string }>({
  backend: 'clustered-lru',
  key: (req) => req.tenant,
  loader: async (req) => ({ id: req.params.id, tenant: req.tenant }),
})
express().use(typedExpress)
const typedFastify = adaptiveFastifyCache<FastifyRequest<{ Params: { id: string } }> & { tenant: string }>({
  backend: 'clustered-lru',
  key: (req) => req.tenant,
  loader: async (req) => ({ id: req.params.id, tenant: req.tenant }),
})
void fastify().register(typedFastify)
