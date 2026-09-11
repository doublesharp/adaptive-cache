local dataKey = KEYS[1]
local metaKey = KEYS[2]
local hash = ARGV[1]
local data = ARGV[2]
local initialTTL = tonumber(ARGV[3])
local maxTTL = tonumber(ARGV[4])
local ttlScaling = tonumber(ARGV[5])
local metaTTL = tonumber(ARGV[6])

if ARGV[13] and ARGV[13] ~= '' and redis.call('GET', ARGV[13]) ~= ARGV[14] then
  return {'INVALIDATED', 0}
end
local prefix = ARGV[8] or ''
local key = ARGV[9] or string.gsub(dataKey, 'data$', '')
local stateKey = dataKey .. ':state'
local legacy = redis.call('GET', '__adaptive:legacy-barrier')
local barrier = redis.call('GET', prefix .. '__adaptive:barrier')
local generation = redis.call('GET', prefix .. '__adaptive:namespace')
if ARGV[7] and ARGV[7] ~= '' then
  if not legacy or not barrier or not generation or ARGV[7] ~= legacy .. ':' .. barrier .. ':' .. generation then
    return {'INVALIDATED', 0}
  end
end
local uuid = ARGV[15] or redis.sha1hex(dataKey .. table.concat(redis.call('TIME'), ':') .. tostring(math.random()))
if not generation then
  generation = uuid
  redis.call('SET', prefix .. '__adaptive:namespace', generation)
end
local old = redis.call('HMGET', stateKey, 'prefix', 'tags', 'generation')
if not old[1] then
  local previousData = redis.call('GET', dataKey)
  local marker = '@ac-redis:1:'
  if previousData and string.sub(previousData, 1, #marker) == marker then
    local previous = cjson.decode(string.sub(previousData, #marker + 1))
    old = {previous.prefix, cjson.encode(previous.tags), previous.namespace}
  end
end
if old[3] and old[3] ~= generation then redis.call('DEL', metaKey) end
if old[1] and old[2] then
  for _, tag in ipairs(cjson.decode(old[2])) do
    redis.call('SREM', old[1] .. 'tag:' .. tag, key)
  end
end

-- Fetch only the fields used for TTL adaptation.
local metaData = redis.call('HMGET', metaKey, 'dataTTL', 'lastChanged', 'changeCount', 'hash', 'ttlPolicyState')
local clock = redis.call('TIME')
local nowMs = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local policy = ARGV[16] and cjson.decode(ARGV[16]) or {type = 'adaptive'}
local policyState = metaData[5] and cjson.decode(metaData[5]) or nil
local nextPolicyState = nil

-- Initialize values
local dataTTL = tonumber(metaData[1]) or initialTTL
local isChanged = metaData[4] ~= hash
local now = isChanged and tonumber(clock[1]) or nil
local lastChanged = isChanged and now or tonumber(metaData[2]) or 0
local changeCount = tonumber(metaData[3] or "0")

if policy.type ~= 'adaptive' then
    local mass = 0
    if policy.type == 'ewma' then
        local p = policy.targetChangeProbability
        -- log(1-p) loses small probabilities to cancellation.
        mass = p < 0.0001 and (p + p^2/2 + p^3/3 + p^4/4 + p^5/5) or -math.log(1-p)
    end
    if not policyState or policyState.signature ~= ARGV[16] then
        dataTTL = initialTTL
        nextPolicyState = {signature = ARGV[16], observedAt = nowMs, observedHash = hash, changeRate = mass / initialTTL}
    else
        nextPolicyState = policyState
        local target = dataTTL
        local shouldRound = true
        if policy.type == 'aimd' then
            target = isChanged and dataTTL * policy.decreaseFactor or dataTTL + policy.increaseSeconds
        else
            local elapsed = (nowMs - policyState.observedAt) / 1000
            if elapsed > 0 then
                local x = math.log(2) * elapsed / policy.halfLifeSeconds
                local alpha = x < 0.0001 and (x - x^2/2 + x^3/6 - x^4/24 + x^5/120) or 1-math.exp(-x)
                local sample = policyState.observedHash ~= hash and 1/elapsed or 0
                local rate = (1-alpha) * policyState.changeRate + alpha * sample
                nextPolicyState = {signature = ARGV[16], observedAt = nowMs, observedHash = hash, changeRate = rate}
                target = rate > 0 and mass/rate or maxTTL
            else
                shouldRound = false
            end
        end
        -- AIMD uses exact ceil; EWMA tolerates only tiny, bounded cjson roundoff.
        target = math.max(initialTTL, math.min(maxTTL, target))
        local tolerance = policy.type == 'ewma' and math.min(0.0000001, math.abs(target) * 1e-12) or 0
        dataTTL = shouldRound and math.ceil(target - tolerance) or target
        dataTTL = math.max(initialTTL, math.min(maxTTL, dataTTL))
    end
elseif policyState then
    -- Switching back to adaptive starts a new history; legacy adaptive metadata has no state.
    dataTTL = initialTTL
elseif not isChanged then
    -- Calculate new TTL
    if dataTTL >= maxTTL then
        dataTTL = maxTTL
    else 
        local decayFactor = 1.0 - math.min(0.9, changeCount * 0.01)
        local increaseFactor = ttlScaling - 1
        if increaseFactor < 0 then increaseFactor = 0 end
        local increase = math.ceil(math.floor(dataTTL * increaseFactor) * decayFactor)
        dataTTL = math.max(initialTTL, math.min(dataTTL + increase, maxTTL))
    end
else
    -- Reset TTL to initial on change to adapt quickly
    dataTTL = initialTTL
end

if isChanged then changeCount = changeCount + 1 end
if nextPolicyState then
    redis.call('HSET', metaKey, 'ttlPolicyState', cjson.encode(nextPolicyState))
else
    redis.call('HDEL', metaKey, 'ttlPolicyState')
end
dataTTL = math.min(dataTTL, maxTTL)
local freshTTL = math.max(0.001, dataTTL * tonumber(ARGV[12] or '1'))
local staleTTL = math.max(0, tonumber(ARGV[11] or '0'))
local retentionMs = math.max(1, math.floor((freshTTL + staleTTL) * 1000))
local tags = ARGV[10] or '[]'
local epochs = {}
redis.call('HSET', stateKey, 'prefix', prefix, 'tags', tags, 'generation', generation, 'freshUntil', nowMs + math.floor(freshTTL * 1000))
redis.call('PEXPIRE', stateKey, math.max(retentionMs, metaTTL * 1000))
for _, tag in ipairs(cjson.decode(tags)) do
  local epochKey = prefix .. '__adaptive:tag-epoch:' .. tag
  local epoch = redis.call('GET', epochKey)
  if not epoch then epoch = uuid; redis.call('SET', epochKey, epoch) end
  epochs[epochKey] = epoch
  redis.call('SADD', prefix .. 'tag:' .. tag, key)
  -- Index lifetime must never be shortened below another member's lifetime.
  local tagTTL = math.max(retentionMs, metaTTL * 1000)
  if redis.call('PTTL', epochKey) < tagTTL then redis.call('PEXPIRE', epochKey, tagTTL) end
  if redis.call('PTTL', prefix .. 'tag:' .. tag) < tagTTL then
    redis.call('PEXPIRE', prefix .. 'tag:' .. tag, tagTTL)
  end
end
-- Store new metadata
redis.call('HSET', metaKey, 
  'hash', hash, 
  'dataTTL', dataTTL, 
  'lastChanged', lastChanged, 
  'changeCount', changeCount)
-- Set expiration for metadata
redis.call('EXPIRE', metaKey, metaTTL)
-- Store actual data with updated TTL
local envelope = {data = data, prefix = prefix, namespace = generation, freshUntil = nowMs + math.floor(freshTTL * 1000), epochs = epochs, tags = cjson.decode(tags)}
redis.call('SET', dataKey, '@ac-redis:1:' .. cjson.encode(envelope), 'PX', retentionMs)

-- RESP numeric replies truncate fractions. Preserve new-policy caps as decimal text.
local resultTTL = policy.type == 'adaptive' and dataTTL or string.format('%.17g', dataTTL)
return {'CACHED', resultTTL, lastChanged, changeCount, hash, isChanged and 1 or 0}
