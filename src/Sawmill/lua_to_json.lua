-- Sawmill/lua_to_json.lua

-- Usage: lua54 lua_to_json.lua <path-to-saved-vars.lua> <GlobalName>

if not arg[1] or not arg[2] then
    io.stderr:write("Usage: lua_to_json.lua <file> <global)\\n")
    os.exit(1)
end

local filePath = arg[1]
local globalName = arg[2]


local chunk, err = loadfile(filePath)
if not chunk then
    io.stderr:write("loadfile failed: " .. tostring(err) .. "\n")
    os.exit(1)
end
local ok, runErr = pcall(chunk)
if not ok then
    io.stderr:write("execution failed: " .. tostring(runErr) .. "\n")
    os.exit(1)
end

local data = _G[globalName]
if data == nil then
    io.stderr:write("global '" .. globalName .. "' not found in " .. filePath .. "\n")
    os.exit(1)
end

local function escape(s)
    s = s:gsub('\\', '\\\\')
    s = s:gsub('"', '\\"')
    s = s:gsub('\n', '\\n')
    s = s:gsub('\r', '\\r')
    s = s:gsub('\t', '\\t')
    s = s:gsub('[%z\1-\31]', function(c) return string.format('\\u%04x', string.byte(c)) end)
    return '"' .. s .. '"'
end

local function isArray(t)
    local n = 0
    for k, _ in pairs(t) do
        n = n + 1
        if type(k) ~= "number" or k % 1 ~= 0 or k < 1 then return false end
    end
    for i = 1, n do if t[i] == nil then return false end end
    return true, n
end

local encode
encode = function(v, depth)
    depth = depth or 0
    if depth > 32 then return '"<depth>"' end
    local t = type(v)
    if t == "nil" then return "null" end
    if t == "boolean" then return tostring(v) end
    if t == "number" then
        if v ~= v then return "null" end
        if v == math.huge or v == -math.huge then return "null" end
        return tostring(v)
    end
    if t == "string" then return escape(v) end
    if t == "table" then
        local arr, n = isArray(v)
        if arr then
            local parts = {}
            for i = 1, n do parts[i] = encode(v[i], depth + 1) end
            return "[" .. table.concat(parts, ",") .. "]"
        else
            local parts = {}
            for k, vv in pairs(v) do
                parts[#parts+1] = escape(tostring(k)) .. ":" .. encode(vv, depth + 1)
            end
            return "{" .. table.concat(parts, ",") .. "}"
        end
    end
    return '"<' .. t .. '>"'
end

io.write(encode(data))
