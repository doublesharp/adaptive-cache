local lastUpdateKey = KEYS[1]  -- Key storing last update timestamp
local lockKey = KEYS[2]  -- Key storing the lock
local currentTime = tonumber(ARGV[1])  -- Current timestamp
local lockValue = ARGV[2]  -- The unique lock value expected

-- Get the current lock value
local existingLock = redis.call("GET", lockKey)

-- If the lock value matches, update the timestamp and delete the lock
if not existingLock or existingLock == lockValue then
    redis.call("SET", lastUpdateKey, currentTime)
    redis.call("DEL", lockKey)
    return {"UPDATED"}
else
    return {"LOCK_MISMATCH", existingLock}
end
