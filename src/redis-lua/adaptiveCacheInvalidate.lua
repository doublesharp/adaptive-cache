-- All mutation and index cleanup is atomic with the write barrier.
local prefix = ARGV[2]
local barrier = prefix ~= '' and prefix .. '__adaptive:barrier' or KEYS[1]
redis.call('SET', barrier, ARGV[5])
local function remove(key)
  local stateKey = key .. 'data:state'
  local old = redis.call('HMGET', stateKey, 'prefix', 'tags')
  if not old[1] then
    local data = redis.call('GET', key .. 'data')
    local marker = '@ac-redis:1:'
    if data and string.sub(data, 1, #marker) == marker then
      local envelope = cjson.decode(string.sub(data, #marker + 1))
      old = {envelope.prefix, cjson.encode(envelope.tags)}
    end
  end
  if old[1] and old[2] then
    for _, tag in ipairs(cjson.decode(old[2])) do
      redis.call('SREM', old[1] .. 'tag:' .. tag, key)
    end
  end
  redis.call('DEL', key .. 'data', key .. 'meta', stateKey)
end
if ARGV[1] == 'namespace' then
  redis.call('SET', prefix .. '__adaptive:namespace', ARGV[6])
  return {}
end
if ARGV[1] == 'clear' then
  remove(ARGV[3])
  return {ARGV[3]}
end
local keys = {}
local seen = {}
for _, tag in ipairs(cjson.decode(ARGV[4])) do
  redis.call('DEL', prefix .. '__adaptive:tag-epoch:' .. tag)
  for _, key in ipairs(redis.call('SMEMBERS', prefix .. 'tag:' .. tag)) do
    if not seen[key] then
      seen[key] = true
      table.insert(keys, key)
      remove(key)
    end
  end
  redis.call('DEL', prefix .. 'tag:' .. tag)
end
return keys
