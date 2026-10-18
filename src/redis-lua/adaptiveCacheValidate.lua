-- Linearize L1 validation against writes and invalidations in one command.
local dataKey = KEYS[1]
if ARGV[3] == '' or redis.call('GET', dataKey .. ':revision') ~= ARGV[3] then return 0 end
local data = redis.call('GET', dataKey)
local marker = '@ac-redis:1:'
if not data or string.sub(data, 1, #marker) ~= marker then return 0 end
local envelope = cjson.decode(string.sub(data, #marker + 1))
-- Legacy writers may overwrite a payload while leaving its old revision key.
if envelope.revision ~= ARGV[3] then return 0 end
local legacy = redis.call('GET', '__adaptive:legacy-barrier')
local barrier = redis.call('GET', ARGV[1] .. '__adaptive:barrier')
local generation = redis.call('GET', ARGV[1] .. '__adaptive:namespace')
if not legacy or not barrier or not generation or ARGV[2] ~= legacy .. ':' .. barrier .. ':' .. generation then return 0 end
if envelope.prefix ~= ARGV[1] or envelope.namespace ~= generation then return 0 end
for key, epoch in pairs(envelope.epochs) do
  if redis.call('GET', key) ~= epoch then return 0 end
end
local clock = redis.call('TIME')
local nowMs = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if envelope.freshUntil <= nowMs then return 0 end
return 1
