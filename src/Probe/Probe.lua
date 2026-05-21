-- Probe/Probe.lua
-- Dev-only API surface verifier and live introspection. See METHODOLOGY.md §3.

ProbeDB = ProbeDB or {}
ProbeDB.runs = ProbeDB.runs or {}
ProbeDB.event_log = ProbeDB.event_log or {}

-- ---------- helpers ----------

local function resolve(dotted)
    local cur = _G
    for part in string.gmatch(dotted, "[^.]+") do
        if type(cur) ~= "table" then return nil end
        cur = cur[part]
    end
    return cur
end

local function typeof(v)
    local t = type(v)
    if t == "table" and getmetatable(v) and getmetatable(v).__index == _G then return "global" end
    return t
end

local function isPrimitive(t)
    return t == "string" or t == "number" or t == "boolean"
end

local function shortStr(v, max)
    max = max or 80
    local s = tostring(v)
    if #s > max then return string.sub(s, 1, max) .. "..." end
    return s
end

-- depth-capped recursive serializer for /probe dump
local function pretty(v, depth, seen)
    depth = depth or 0
    seen = seen or {}
    if depth > 3 then return "<depth>" end
    local t = type(v)
    if t == "string" then return string.format("%q", v) end
    if t == "number" or t == "boolean" or t == "nil" then return tostring(v) end
    if t == "function" then return "<function>" end
    if t == "userdata" then return "<userdata>" end
    if t == "table" then
        if seen[v] then return "<cycle>" end
        seen[v] = true
        local out, n = {}, 0
        for k, vv in pairs(v) do
            n = n + 1
            if n > 20 then out[#out+1] = "..." break end
            out[#out+1] = tostring(k) .. "=" .. pretty(vv, depth+1, seen)
        end
        return "{" .. table.concat(out, ", ") .. "}"
    end
    return tostring(v)
end

local function pcallReturns(fn, args)
    local ok, ret = pcall(function() return { fn(unpack(args or {})) } end)
    if not ok then return false, tostring(ret) end
    return true, ret
end

-- ---------- function target runner ----------

local function probeFunctionTarget(t)
    local result = {
        kind = "function", name = t.name, site = t.site, notes = t.notes,
        argv = t.argv,
    }
    local fn = resolve(t.name)
    local ft = type(fn)
    if ft ~= "function" then
        result.status = "MISSING"
        result.actual_type = ft
        return result
    end
    if t.skip_call then
        result.status = "OK"
        result.skipped = true
        result.return_count = 0
        result.return_types = {}
        result.sample = {}
        return result
    end
    local ok, ret = pcallReturns(fn, t.argv)
    if not ok then
        result.status = "RAISED"
        result.error = ret
        return result
    end
    result.status = "OK"
    result.return_count = #ret
    result.return_types = {}
    result.sample = {}
    for i, v in ipairs(ret) do
        result.return_types[i] = type(v)
        if isPrimitive(type(v)) then
            result.sample[i] = v
        elseif type(v) == "table" then
            -- shallow shape capture
            local keys = {}
            local n = 0
            for k, _ in pairs(v) do
                n = n + 1
                if n > 10 then keys[#keys+1] = "..." break end
                keys[#keys+1] = tostring(k)
            end
            result.sample[i] = "{table: " .. table.concat(keys, ",") .. "}"
        end
    end
    return result
end

-- ---------- event target runner ----------

local eventFrames = {}
local registeredEvents = {}

local function registerEventTarget(t)
    local frame = CreateFrame("Frame")
    eventFrames[t.event] = frame
    local ok = pcall(function() frame:RegisterEvent(t.event) end)
    registeredEvents[t.event] = {
        event = t.event, site = t.site, notes = t.notes,
        registered_ok = ok, fired = false,
    }
    frame:SetScript("OnEvent", function(self, event, ...)
        local entry = registeredEvents[event]
        if not entry or entry.fired then return end
        entry.fired = true
        local argv = {...}
        local types, sample = {}, {}
        for i, v in ipairs(argv) do
            types[i] = type(v)
            if isPrimitive(type(v)) then sample[i] = v end
        end
        entry.argc = #argv
        entry.argv_types = types
        entry.argv_sample = sample
        entry.fired_at = time()
        entry.fired_gt = GetTime()
        ProbeDB.event_log[#ProbeDB.event_log+1] = entry
    end)
end

-- ---------- main run ----------

local function runProbe()
    if not ProbeTargets then
        print("Probe: ProbeTargets is nil — Targets.lua failed to load.")
        return
    end

    local version, build, date, tocversion = GetBuildInfo()
    local meta = {
        t = time(),
        gt = GetTime(),
        version = version, build = build, build_date = date, tocversion = tocversion,
        project_id = WOW_PROJECT_ID,
        locale = GetLocale and GetLocale() or "?",
        addon_version = (C_AddOns and C_AddOns.GetAddOnMetadata and C_AddOns.GetAddOnMetadata("Probe", "Version")) or "?",
    }

    local results = {}
    local counts = { OK = 0, MISSING = 0, RAISED = 0 }
    for _, t in ipairs(ProbeTargets.functions or {}) do
        local r = probeFunctionTarget(t)
        results[#results+1] = r
        counts[r.status] = (counts[r.status] or 0) + 1
    end

    -- Register all event targets (results captured asynchronously into ProbeDB.event_log).
    -- The current run's event registrations are also referenced from registeredEvents
    -- so the report can include "registered, not yet fired" status.
    local event_summary = {}
    for _, t in ipairs(ProbeTargets.events or {}) do
        registerEventTarget(t)
        event_summary[#event_summary+1] = {
            event = t.event, site = t.site, notes = t.notes,
            registered_ok = registeredEvents[t.event] and registeredEvents[t.event].registered_ok,
        }
    end

    local run = {
        meta = meta,
        functions = results,
        function_counts = counts,
        events_registered = event_summary,
    }
    ProbeDB.runs[#ProbeDB.runs+1] = run

    print(string.format("Probe: build %s.%s tocv %d. Functions: %d OK, %d MISSING, %d RAISED. Events registered: %d.",
        version or "?", build or "?", tocversion or -1,
        counts.OK, counts.MISSING, counts.RAISED, #event_summary))
end

-- ---------- slash commands ----------

SLASH_PROBE1 = "/probe"

local function parseArg(s)
    -- Try as Lua expression first (number, true, false, nil, "string", {table}).
    local f = loadstring("return " .. s)
    if f then
        local ok, v = pcall(f)
        if ok then return v end
    end
    return s
end

local function splitArgs(s)
    -- Naive split on whitespace, respecting quotes via load() fallback.
    local out = {}
    for token in string.gmatch(s, "%S+") do out[#out+1] = token end
    return out
end

local handlers = {}

handlers.api = function(args)
    local name = args[1]
    if not name then print("Usage: /probe api <name>") return end
    local v = resolve(name)
    print(string.format("Probe: %s -> %s", name, type(v)))
    if type(v) == "table" then
        local keys = {}
        local n = 0
        for k, _ in pairs(v) do
            n = n + 1
            if n > 30 then keys[#keys+1] = "..." break end
            keys[#keys+1] = tostring(k)
        end
        print("  keys: " .. table.concat(keys, ", "))
    end
end

handlers.call = function(args)
    local name = table.remove(args, 1)
    if not name then print("Usage: /probe call <name> [args...]") return end
    local fn = resolve(name)
    if type(fn) ~= "function" then
        print(string.format("Probe: %s is not callable (%s)", name, type(fn)))
        return
    end
    local parsed = {}
    for i, a in ipairs(args) do parsed[i] = parseArg(a) end
    local ok, ret = pcallReturns(fn, parsed)
    if not ok then
        print(string.format("Probe: %s RAISED: %s", name, ret))
        return
    end
    if #ret == 0 then
        print(string.format("Probe: %s -> (no return)", name))
        return
    end
    for i, v in ipairs(ret) do
        print(string.format("  [%d] %s = %s", i, type(v), shortStr(pretty(v), 200)))
    end
end

handlers.event = function(args)
    local name = args[1]
    if not name then print("Usage: /probe event <NAME>") return end
    local frame = CreateFrame("Frame")
    local ok = pcall(function() frame:RegisterEvent(name) end)
    if not ok then print("Probe: register failed for " .. name) return end
    print("Probe: listening for " .. name .. " (one-shot)")
    frame:SetScript("OnEvent", function(self, event, ...)
        local argv = {...}
        local parts = {}
        for i, v in ipairs(argv) do parts[i] = string.format("[%d %s] %s", i, type(v), shortStr(pretty(v), 80)) end
        print(string.format("Probe: %s fired (%d args): %s", event, #argv, table.concat(parts, " | ")))
        self:UnregisterEvent(event)
        self:SetScript("OnEvent", nil)
    end)
end

local watchers = {}
handlers.watch = function(args)
    local name = args[1]
    if not name then print("Usage: /probe watch <NAME>  (then /probe unwatch <NAME>)") return end
    if watchers[name] then print("Probe: already watching " .. name) return end
    local frame = CreateFrame("Frame")
    local ok = pcall(function() frame:RegisterEvent(name) end)
    if not ok then print("Probe: register failed for " .. name) return end
    watchers[name] = frame
    print("Probe: watching " .. name)
    frame:SetScript("OnEvent", function(self, event, ...)
        local argv = {...}
        local parts = {}
        for i, v in ipairs(argv) do parts[i] = string.format("[%d %s] %s", i, type(v), shortStr(pretty(v), 60)) end
        print(string.format("Probe: %s (%d): %s", event, #argv, table.concat(parts, " | ")))
    end)
end

handlers.unwatch = function(args)
    local name = args[1]
    if not name or not watchers[name] then print("Probe: not watching " .. tostring(name)) return end
    watchers[name]:UnregisterAllEvents()
    watchers[name]:SetScript("OnEvent", nil)
    watchers[name] = nil
    print("Probe: unwatched " .. name)
end

handlers.eval = function(args, raw)
    -- Use raw string after "eval " to preserve full expression.
    local code = raw and raw:match("^%s*eval%s+(.+)$")
    if not code then print("Usage: /probe eval <lua expression>") return end
    local f, err = loadstring("return " .. code)
    if not f then
        f, err = loadstring(code)
        if not f then print("Probe: parse error: " .. tostring(err)) return end
    end
    local ok, ret = pcall(f)
    if not ok then print("Probe: error: " .. tostring(ret)) return end
    print("Probe: " .. shortStr(pretty(ret), 300))
end

handlers.dump = function(args, raw)
    local code = raw and raw:match("^%s*dump%s+(.+)$")
    if not code then print("Usage: /probe dump <expression>") return end
    local f, err = loadstring("return " .. code)
    if not f then print("Probe: parse error: " .. tostring(err)) return end
    local ok, ret = pcall(f)
    if not ok then print("Probe: error: " .. tostring(ret)) return end
    print("Probe: " .. pretty(ret))
end

handlers.run = function() runProbe() end

handlers.status = function()
    local last = ProbeDB.runs[#ProbeDB.runs]
    if not last then print("Probe: no runs recorded.") return end
    local c = last.function_counts
    print(string.format("Probe: last run build %s.%s tocv %d. Functions: %d OK, %d MISSING, %d RAISED.",
        last.meta.version, last.meta.build, last.meta.tocversion or -1,
        c.OK or 0, c.MISSING or 0, c.RAISED or 0))
    local fired, total = 0, 0
    for _, e in pairs(registeredEvents) do
        total = total + 1
        if e.fired then fired = fired + 1 end
    end
    print(string.format("Probe: events registered=%d fired=%d", total, fired))
end

handlers.help = function()
    print("Probe commands:")
    print("  /probe api <name>          existence + arity check")
    print("  /probe call <name> [args]  pcall live, prints returns")
    print("  /probe event <NAME>        one-shot event listener")
    print("  /probe watch <NAME>        persistent listener")
    print("  /probe unwatch <NAME>      stop watching")
    print("  /probe eval <lua>          run an expression")
    print("  /probe dump <expr>         pretty-print a value")
    print("  /probe run                 re-run all targets now")
    print("  /probe status              summarize last run")
end

SlashCmdList["PROBE"] = function(msg)
    msg = msg or ""
    local cmd, rest = msg:match("^%s*(%S+)%s*(.*)$")
    if not cmd then handlers.help() return end
    local h = handlers[cmd]
    if not h then handlers.help() return end
    local args = splitArgs(rest or "")
    local ok, err = pcall(h, args, msg)
    if not ok then print("Probe: handler error: " .. tostring(err)) end
end

-- ---------- bootstrap ----------

local boot = CreateFrame("Frame")
boot:RegisterEvent("PLAYER_LOGIN")
boot:SetScript("OnEvent", function(self, event)
    if event == "PLAYER_LOGIN" then
        runProbe()
        print("Probe: /probe help for commands. Manifest at Probe/Targets.lua.")
    end
end)
