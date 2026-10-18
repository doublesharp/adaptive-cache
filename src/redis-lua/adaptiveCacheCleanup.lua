-- Caller supplies at most 100 detached members per invocation.
-- Missing snapshots are incomplete cleanup, never an empty successful batch.
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local prefix = ARGV[1]
local tag = ARGV[2]
local members = cjson.decode(ARGV[3])
local epochKey = prefix .. '__adaptive:tag-epoch:' .. tag
local epoch = redis.call('GET', epochKey)
for _, key in ipairs(members) do
  local dataKey = key .. 'data'
  local data = redis.call('GET', dataKey)
  local remove = true
  local old = redis.call('HMGET', dataKey .. ':state', 'prefix', 'tags')
  local marker = '@ac-redis:1:'
  if data and string.sub(data, 1, #marker) == marker then
    local envelope = cjson.decode(string.sub(data, #marker + 1))
    old = {envelope.prefix, cjson.encode(envelope.tags)}
    -- A rewrite which removed this tag or joined its new epoch survives.
    remove = envelope.epochs[epochKey] ~= nil and envelope.epochs[epochKey] ~= epoch
  elseif old[2] then
    remove = false
    for _, oldTag in ipairs(cjson.decode(old[2])) do if oldTag == tag then remove = true end end
  end
  if remove then
    if old[1] and old[2] then
      for _, oldTag in ipairs(cjson.decode(old[2])) do
        redis.call('SREM', old[1] .. 'tag:' .. oldTag, key)
        redis.call('ZREM', old[1] .. '__adaptive:tag-index:' .. oldTag, key)
      end
    end
    redis.call('DEL', dataKey, key .. 'meta', dataKey .. ':state', dataKey .. ':revision')
  end
end
if ARGV[4] == 'zset' then return redis.call('ZREM', KEYS[1], unpack(members))
else return redis.call('SREM', KEYS[1], unpack(members)) end
