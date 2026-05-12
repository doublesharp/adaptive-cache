local dataKey = KEYS[1]
local metaKey = string.gsub(dataKey, 'data$', 'meta')

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

-- try to fetch the data
local data = redis.call('GET', dataKey)
-- if we don't have data, return nil
if not data then
    return {nil, 0}
end

-- if we do have data get the TTL and return both
local ttl = redis.call('TTL', dataKey)
local metaData = hgetall(metaKey)

return {
    data,
    ttl,
    metaData.dataTTL or false,
    metaData.lastChanged or false,
    metaData.changeCount or false,
    metaData.hash or false
}
