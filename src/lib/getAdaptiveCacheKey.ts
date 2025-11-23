import crypto from 'node:crypto';

export const getAdaptiveCacheKey = (requestPath: string, querystring: any, redisPrefix: string) => {
  const baseKey = requestPath + ':'; // Remove query params from cache key
  const queryKey = crypto.createHash('sha256').update(JSON.stringify(querystring)).digest('hex') + ':';
  return redisPrefix + baseKey + queryKey;
};
