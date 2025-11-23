local dataKey = KEYS[1]

-- try to fetch the data
local data = redis.call('GET', dataKey)
-- if we don't have data, return nil
if not data then
    return {nil, 0}
end

-- if we do have data get the TTL and return both
local ttl = redis.call('TTL', dataKey)
return {data, ttl}

