local dataKey = KEYS[1]
local metaKey = KEYS[2]
local hash = ARGV[1]
local data = ARGV[2]
local initialTTL = tonumber(ARGV[3])
local maxTTL = tonumber(ARGV[4])
local ttlScaling = tonumber(ARGV[5])
local metaTTL = tonumber(ARGV[6])

-- Gets all fields from a hash as a dictionary
local hgetall = function (key)
    local bulk = redis.call('HGETALL', key)
    local result = {}
    local nextkey
    for i, v in ipairs(bulk) do
        if i % 2 == 1 then
            nextkey = v
        else
            result[nextkey] = v
        end
    end
    return result
end

-- Fetch metadata
local metaData = hgetall(metaKey)

-- Initialize values
local dataTTL = tonumber(metaData.dataTTL) or initialTTL
local isChanged = next(metaData) == nil or metaData.hash ~= hash
local now = isChanged and tonumber(redis.call('TIME')[1]) or nil
local lastChanged = isChanged and now or tonumber(metaData.lastChanged) or 0
local changeCount = tonumber(metaData.changeCount or "0")

if not isChanged then
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
    -- Update change count
    changeCount = changeCount + 1
    -- Reset TTL to initial on change to adapt quickly
    dataTTL = initialTTL
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
redis.call('SET', dataKey, data, 'EX', dataTTL)

-- Return TTL used
return {'CACHED', dataTTL, lastChanged, changeCount, hash, isChanged and 1 or 0}
