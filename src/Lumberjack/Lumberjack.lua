-- Initialization
-- IMPORTANT: On BC Anniversary, SavedVariables are NOT reliably populated when this file's
-- top-level scope runs. If we initialize LumberjackDB here and append a session entry, WoW
-- subsequently loads SavedVariables on top of our globals and our session entry is lost.
-- See METHODOLOGY §9. All SavedVariables-touching init is deferred to ADDON_LOADED below.

local POLL_RATE = 10
local SNAPSHOT_INTERVAL = 60

-- Generated lazily inside initSession so it picks up the post-load player name.
local SESSION_ID
local currentSessionID

-- GetTime() returns seconds since the client launched, NOT Unix epoch. time() is epoch but
-- integer-only. We capture the offset once per session and combine: epoch sub-second timestamps
-- aligned with combat log timestamps and sessions.startTime. nowEpoch() is the only clock used
-- on poll/events/snapshots rows so cross-session merging and CLEU joins work on a single axis.
local EPOCH_OFFSET = 0
local function nowEpoch() return GetTime() + EPOCH_OFFSET end

-- Utility Functions
local function getPosition()
    local mapID = C_Map.GetBestMapForUnit("player")
    local pos = { x = 0, y = 0, mapID = mapID or 0, zone = GetZoneText() or "Unknown", subzone = GetSubZoneText() or "Unknown" }
    if mapID then
        local p = C_Map.GetPlayerMapPosition(mapID, "player")
        if p then pos.x, pos.y = p.x, p.y end
    end
    -- World coordinates via UnitPosition — returns (y, x, z, instanceID) in world axes.
    -- Independent of map: works in instances, doesn't need per-zone atlas stitching.
    -- Probe-verified on BC Anniversary; Z is elevation (0 may be sea-level coincidence — needs more samples).
    local upok, wy, wx, wz, inst = pcall(UnitPosition, "player")
    if upok and wy then
        pos.wy, pos.wx, pos.wz, pos.inst = wy, wx, wz, inst
    end
    return pos
end

local function getTargetData()
    if not UnitExists("target") then return nil end
    return {
        guid = UnitGUID("target"),
        name = UnitName("target"),
        level = UnitLevel("target"),
        class = UnitClass("target"),
        classification = UnitClassification("target"),
        health = UnitHealth("target"),
        maxHealth = UnitHealthMax("target"),
    }
end

local function estimateDBSize()
    -- Rough heuristic: poll ~150 bytes, event ~200 bytes, snapshot ~500 bytes
    local size = (#LumberjackDB.poll * 150) + (#LumberjackDB.events * 200) + (#LumberjackDB.snapshots * 500)
    return size / (1024 * 1024) -- MB
end

-- Trim rows whose `t` is <= highwater. Rows are appended in epoch order so this is a prefix trim,
-- but we scan instead of binary-searching: idempotent (no harm re-applying the same mark) and the
-- per-login cost is negligible at the row counts we ever see in-memory.
local function trimByTime(t, highwater)
    if not highwater or highwater <= 0 then return t, 0 end
    local out = {}
    local trimmed = 0
    for i = 1, #t do
        if t[i].t and t[i].t > highwater then
            out[#out + 1] = t[i]
        else
            trimmed = trimmed + 1
        end
    end
    return out, trimmed
end

-- Write-on-change cache. Stable fields are only emitted into a poll row when their value
-- has changed since the last poll. Reset at the start of every session (in initSession) so
-- the first poll of a fresh session always carries all stable values.
local lastPollState = {}

-- Form/stance spell IDs. GetShapeshiftForm() returns a bar-slot index, which is character-specific
-- (slots fill in spell-learn order, so the same form maps to different integers depending on which
-- forms a druid has learned). The spell ID of the form's aura is the stable identifier — same
-- value for everyone, locale-independent. Walk player buffs each poll; first match wins. Set to
-- 0 when no recognized form/stance is active.
local FORM_SPELLS = {
    -- Druid
    [5487]  = true, [9634]  = true, -- Bear / Dire Bear
    [768]   = true,                 -- Cat
    [783]   = true,                 -- Travel
    [1066]  = true,                 -- Aquatic
    [24858] = true,                 -- Moonkin
    [33891] = true,                 -- Tree of Life
    [33943] = true,                 -- Flight Form
    [40120] = true,                 -- Swift Flight Form
    -- Warrior
    [2457]  = true,                 -- Battle Stance
    [71]    = true,                 -- Defensive Stance
    [2458]  = true,                 -- Berserker Stance
    -- Priest
    [15473] = true,                 -- Shadowform
}
local function getFormSpellId()
    for i = 1, 40 do
        local name, _, _, _, _, _, _, _, _, spellId = UnitBuff("player", i)
        if not name then return 0 end
        if FORM_SPELLS[spellId] then return spellId end
    end
    return 0
end

-- Stream Loggers — all bail early until ADDON_LOADED sets up LumberjackDB and currentSessionID.
local function logPoll()
    if not (currentSessionID and LumberjackDB and LumberjackDB.poll) then return end
    local pos = getPosition()
    local target = getTargetData()
    -- UnitCastingInfo returns (name, displayName, texture, startMS, endMS, isTradeSkill, castGUID, notInterruptible, spellID).
    -- spellID is the stable identifier; name is locale-dependent.
    local castName, _, _, _, _, _, _, _, castSpellID = UnitCastingInfo("player")

    local rok, restedXP = pcall(GetXPExhaustion)
    local nok, _, _, _, latWorld = pcall(GetNetStats)
    local cok, inCombat = pcall(UnitAffectingCombat, "player")
    local sok, isStealthed = pcall(IsStealthed)
    local fok, fps = pcall(GetFramerate)

    local bagFree = 0
    for i = 0, 4 do
        local free = C_Container.GetContainerNumFreeSlots(i)
        bagFree = bagFree + (free or 0)
    end

    -- Dense fields (every row): identifiers, perf signals that fluctuate every tick anyway,
    -- and the nil-prone fields (tgt/cast/cast_id) where write-on-change can't represent the
    -- "stopped" transition. UNIT_SPELLCAST_SUCCEEDED is the discrete companion for cast.
    -- Everything scalar that *can* be nil-unsafely tracked goes through maybeWrite below.
    local data = {
        sid = currentSessionID,
        t = nowEpoch(),
        fps = (fok and fps) or 0,
        lat = (nok and latWorld) or 0,
        mem = collectgarbage("count"),
        tgt = target,        -- nil when no target; Lua omits nil-valued keys on serialize
        cast = castName,     -- nil when not casting
        cast_id = castSpellID,
    }

    -- Stable fields: emit only when value differs from last poll. Analysis code forward-fills.
    -- All values here are guaranteed non-nil scalars (booleans/numbers/strings) so the cache compare
    -- handles transitions in both directions without nil-loss.
    local function maybeWrite(key, value)
        if lastPollState[key] ~= value then
            data[key] = value
            lastPollState[key] = value
        end
    end

    -- Position (map-relative and world). pos.x/pos.y are guaranteed numbers (default 0). World
    -- coords are nil-guarded because pcall(UnitPosition) may fail transiently; on nil we just skip
    -- the write so forward-fill keeps the last good reading.
    maybeWrite("x", pos.x)
    maybeWrite("y", pos.y)
    if pos.wx ~= nil then maybeWrite("wx", pos.wx) end
    if pos.wy ~= nil then maybeWrite("wy", pos.wy) end
    if pos.wz ~= nil then maybeWrite("wz", pos.wz) end
    if pos.inst ~= nil then maybeWrite("inst", pos.inst) end
    -- Vitals. Full HP/mana out of combat = stable; combat ticks change every poll anyway, so the
    -- cache compare is cheap-and-correct in both regimes.
    maybeWrite("hp", UnitHealth("player"))
    -- UnitPower indices on BC Anniversary 2.5.5 (probe-verified via druid form-shift testing):
    --   0 = Mana, 1 = Rage, 2 = Focus (pet), 3 = Energy, 4 = Happiness (pet).
    maybeWrite("mp", UnitPower("player", 0))
    maybeWrite("rg", UnitPower("player", 1))
    maybeWrite("en", UnitPower("player", 3))
    maybeWrite("mid", pos.mapID)
    maybeWrite("z", pos.zone)
    maybeWrite("sz", pos.subzone)
    maybeWrite("lvl", UnitLevel("player"))
    maybeWrite("mxp", UnitXPMax("player"))
    maybeWrite("xp", UnitXP("player"))
    maybeWrite("rest", restedXP or 0)
    maybeWrite("bags", bagFree)
    maybeWrite("gold", GetMoney())
    maybeWrite("mnt", IsMounted())
    maybeWrite("stealth", (sok and isStealthed) or false)
    maybeWrite("combat", (cok and inCombat) or false)
    -- Shapeshift form. We capture two parallel signals so analysis can cross-check them:
    --   form       — GetShapeshiftForm() bar-slot index (character-specific; depends on which
    --                forms have been learned). Kept for back-compat with archived data.
    --   form_spell — aura-derived spell ID of the active form (stable across characters,
    --                preferred by the web side).
    local fmok, formIdx = pcall(GetShapeshiftForm)
    maybeWrite("form", (fmok and formIdx) or 0)
    local fsok, formSpell = pcall(getFormSpellId)
    maybeWrite("form_spell", (fsok and formSpell) or 0)
    -- Combo points on the current target (rogue/druid in cat form). 0..5. Changes too quickly for
    -- write-on-change in a fight, but mostly idle outside combat, so still net-win.
    local cpok, comboPts = pcall(GetComboPoints, "player", "target")
    maybeWrite("cp", (cpok and comboPts) or 0)
    -- IsFalling toggles true when airborne (jumps + falls indistinguishable). Write-on-change makes
    -- each false→true transition a "jump initiated" event we can count in stats.
    local jok, falling = pcall(IsFalling)
    maybeWrite("falling", (jok and falling) and 1 or 0)

    table.insert(LumberjackDB.poll, data)
end

local function logEvent(eventName, payload)
    if not (currentSessionID and LumberjackDB and LumberjackDB.events) then return end
    local pos = getPosition()
    local data = {
        sid = currentSessionID,
        t = nowEpoch(),
        event = eventName,
        x = pos.x, y = pos.y, z = pos.zone,
        payload = payload or {},
    }
    table.insert(LumberjackDB.events, data)
end

local function logSnapshot(kind)
    if not (currentSessionID and LumberjackDB and LumberjackDB.snapshots) then return end
    local data = {
        sid = currentSessionID,
        t = nowEpoch(),
        kind = kind,
        payload = {},
    }

    if kind == "gear" then
        -- Slots 0..19: ammo (0) + standard equipment (1..19, includes ranged/idol slot 18 and tabard 19).
        -- Pass integer directly; GetInventorySlotInfo wants a slot NAME and is the wrong API here.
        for i = 0, 19 do
            local ok, link = pcall(GetInventoryItemLink, "player", i)
            if ok and link then
                local dok, cur, max = pcall(GetInventoryItemDurability, i)
                data.payload[i] = {
                    link = link,
                    dur = (dok and cur) or nil,
                    max = (dok and max) or nil,
                }
            end
        end
    elseif kind == "bags" then
        for bag = 0, 4 do
            local nok, n = pcall(C_Container.GetContainerNumSlots, bag)
            if nok and n and n > 0 then
                for slot = 1, n do
                    local lok, item = pcall(C_Container.GetContainerItemLink, bag, slot)
                    if lok and item then data.payload[bag .. "_" .. slot] = item end
                end
            end
        end
    elseif kind == "rep" then
        -- All faction APIs pcall-guarded; if any are MISSING the snapshot is just empty.
        -- Run probe pass to confirm GetNumFactions / GetFactionInfo / ExpandAllFactionHeaders are OK.
        pcall(ExpandAllFactionHeaders)
        local nok, n = pcall(GetNumFactions)
        if nok and n then
            for i = 1, n do
                local ok, name, _, standingID, barMin, barMax, barValue,
                      _, _, isHeader, _, hasRep = pcall(GetFactionInfo, i)
                if ok and name and not isHeader and hasRep then
                    data.payload[name] = {
                        standing = standingID,
                        value = barValue,
                        min = barMin,
                        max = barMax,
                    }
                end
            end
        end
    elseif kind == "talents" then
        -- 3 tabs per BC class. Per-talent: name, rank, max_rank, position. Skip un-spent talents
        -- (rank==0) to keep payload small — easy to derive "not learned" from absence.
        local tabsOk, numTabs = pcall(GetNumTalentTabs)
        if tabsOk and numTabs then
            for tab = 1, numTabs do
                local tabInfo = { spent = 0, talents = {} }
                local ok, tabName, _, pointsSpent = pcall(GetTalentTabInfo, tab)
                if ok and tabName then
                    tabInfo.name = tabName
                    tabInfo.spent = pointsSpent or 0
                end
                local nok, n = pcall(GetNumTalents, tab)
                if nok and n then
                    for ti = 1, n do
                        local tok, tname, _, tier, col, rank, maxRank = pcall(GetTalentInfo, tab, ti)
                        if tok and tname and rank and rank > 0 then
                            tabInfo.talents[tname] = { rank = rank, max = maxRank, tier = tier, col = col }
                        end
                    end
                end
                data.payload["tab" .. tab] = tabInfo
            end
        end
    elseif kind == "skills" then
        -- Weapon skills, defense, professions, languages. Expand collapsed headers first so
        -- iteration reaches every line. Drop header rows (header=true) and unrankable lines (max=0).
        pcall(ExpandSkillHeader, 0)
        local nok, n = pcall(GetNumSkillLines)
        if nok and n then
            for i = 1, n do
                local ok, skillName, header, _, rank, _, _, maxRank = pcall(GetSkillLineInfo, i)
                if ok and skillName and not header and maxRank and maxRank > 0 then
                    data.payload[skillName] = { rank = rank or 0, max = maxRank }
                end
            end
        end
    elseif kind == "party" then
        -- Snapshot full party/raid roster. BC Anniversary 2.5.5 ships with RETAIL-era group APIs;
        -- BC-classic GetNumPartyMembers / UnitIsPartyLeader / GetLootMethod are all MISSING.
        -- All APIs used here are probe-verified OK on this build (see docs/APIReport.md):
        --   IsInGroup / IsInRaid / GetNumGroupMembers / GetNumSubgroupMembers / UnitIsGroupLeader /
        --   C_PartyInfo.GetLootMethod. C_PartyInfo.GetLootMethod returns an integer enum (not the
        --   legacy (string, masterPartyID, masterRaidID) shape).
        local gok, inGroup = pcall(IsInGroup)
        local rok, inRaid = pcall(IsInRaid)
        data.payload.in_group = (gok and inGroup) or false
        data.payload.in_raid = (rok and inRaid) or false
        local _, ng = pcall(GetNumGroupMembers); data.payload.num_group = ng or 0
        local _, ns = pcall(GetNumSubgroupMembers); data.payload.num_subgroup = ns or 0
        local members = {}
        if not data.payload.in_group and not data.payload.in_raid then
            -- Solo — emit minimal payload so we have a row attesting "no party at time T".
            data.payload.members = members
            data.payload.member_count = 0
        else
            local function snapshotUnit(unit, slot)
                if not UnitExists(unit) then return false end
                local nameOk, name = pcall(UnitName, unit)
                local classOk, _, classToken = pcall(UnitClass, unit)
                local levelOk, level = pcall(UnitLevel, unit)
                local guidOk, guid = pcall(UnitGUID, unit)
                local leaderOk, isLeader = pcall(UnitIsGroupLeader, unit)
                members[slot] = {
                    name = nameOk and name or nil,
                    class = classOk and classToken or nil,
                    level = levelOk and level or nil,
                    guid = guidOk and guid or nil,
                    leader = leaderOk and isLeader or nil,
                }
                return true
            end
            if data.payload.in_raid then
                for i = 1, 40 do
                    if not snapshotUnit("raid" .. i, "raid" .. i) then break end
                end
            else
                snapshotUnit("player", "player")
                for i = 1, 4 do
                    if not snapshotUnit("party" .. i, "party" .. i) then break end
                end
            end
            data.payload.members = members
            local n = 0; for _ in pairs(members) do n = n + 1 end; data.payload.member_count = n
            local lootOk, lootMethod = pcall(function() return C_PartyInfo.GetLootMethod() end)
            if lootOk and lootMethod ~= nil then data.payload.loot_method = lootMethod end
        end
    end

    table.insert(LumberjackDB.snapshots, data)
end

-- Event Handlers
local eventFrame = CreateFrame("Frame")
-- Lifecycle
eventFrame:RegisterEvent("PLAYER_LEVEL_UP")
eventFrame:RegisterEvent("PLAYER_DEAD")
eventFrame:RegisterEvent("PLAYER_ALIVE")
eventFrame:RegisterEvent("PLAYER_UNGHOST")
eventFrame:RegisterEvent("PLAYER_REGEN_ENABLED")
eventFrame:RegisterEvent("PLAYER_REGEN_DISABLED")
eventFrame:RegisterEvent("PLAYER_UPDATE_RESTING")
-- Movement
eventFrame:RegisterEvent("ZONE_CHANGED")
eventFrame:RegisterEvent("ZONE_CHANGED_INDOORS")
eventFrame:RegisterEvent("ZONE_CHANGED_NEW_AREA")
eventFrame:RegisterEvent("TAXIMAP_OPENED")
-- Quest
eventFrame:RegisterEvent("QUEST_ACCEPTED")
eventFrame:RegisterEvent("QUEST_TURNED_IN")
eventFrame:RegisterEvent("QUEST_LOG_UPDATE")
-- Loot / inventory
eventFrame:RegisterEvent("CHAT_MSG_LOOT")
eventFrame:RegisterEvent("ITEM_PUSH")
-- Economy
eventFrame:RegisterEvent("PLAYER_MONEY")
-- Targeting
eventFrame:RegisterEvent("PLAYER_TARGET_CHANGED")
-- Casts
eventFrame:RegisterEvent("UNIT_SPELLCAST_SUCCEEDED")
-- Character progression
eventFrame:RegisterEvent("CHARACTER_POINTS_CHANGED")
eventFrame:RegisterEvent("SKILL_LINES_CHANGED")
-- Errors / system
eventFrame:RegisterEvent("UI_ERROR_MESSAGE")
eventFrame:RegisterEvent("UI_INFO_MESSAGE")     -- "Quest complete", objective progress ("Wolf Pelt: 5/8"), etc. Per-event payload shape pending probe.
eventFrame:RegisterEvent("CHAT_MSG_SYSTEM")
-- Friction (menu time — vendor / trainer / mail / bank / AH / loot / cinematic / taxi).
-- All probe-verified registerable on 2.5.5. Most carry no payload — fact-of-fire is the signal.
eventFrame:RegisterEvent("MERCHANT_SHOW")
eventFrame:RegisterEvent("MERCHANT_CLOSED")
eventFrame:RegisterEvent("TRAINER_SHOW")
eventFrame:RegisterEvent("TRAINER_CLOSED")
eventFrame:RegisterEvent("MAIL_SHOW")
eventFrame:RegisterEvent("MAIL_CLOSED")
eventFrame:RegisterEvent("BANKFRAME_OPENED")
eventFrame:RegisterEvent("BANKFRAME_CLOSED")
eventFrame:RegisterEvent("AUCTION_HOUSE_SHOW")
eventFrame:RegisterEvent("AUCTION_HOUSE_CLOSED")
eventFrame:RegisterEvent("LOOT_OPENED")
eventFrame:RegisterEvent("LOOT_CLOSED")
eventFrame:RegisterEvent("CINEMATIC_START")
eventFrame:RegisterEvent("CINEMATIC_STOP")
eventFrame:RegisterEvent("TAXIMAP_CLOSED")
-- Sharper XP signal — explicit XP-gain event + parseable chat message with (amount, source).
eventFrame:RegisterEvent("PLAYER_XP_UPDATE")
eventFrame:RegisterEvent("CHAT_MSG_COMBAT_XP_GAIN")
-- Hearthstone bind tracking. CONFIRM_BINDER_BIND was probe-rejected on BC; HEARTHSTONE_BOUND works.
eventFrame:RegisterEvent("HEARTHSTONE_BOUND")
-- Faction reputation deltas — sharper than the 60s rep snapshot.
eventFrame:RegisterEvent("UPDATE_FACTION")
-- Party / raid roster changes. Probe confirmed BC Anniversary 2.5.5 ships RETAIL-era event names:
-- GROUP_ROSTER_UPDATE is canonical (registered OK); PARTY_MEMBERS_CHANGED and PARTY_CONVERTED_TO_RAID
-- are MISSING. Everything else is probe-verified OK on this build.
eventFrame:RegisterEvent("GROUP_ROSTER_UPDATE")
eventFrame:RegisterEvent("PARTY_LEADER_CHANGED")
eventFrame:RegisterEvent("PARTY_LOOT_METHOD_CHANGED")
eventFrame:RegisterEvent("RAID_ROSTER_UPDATE")

eventFrame:SetScript("OnEvent", function(self, event, ...)
    local args = {...}
    logEvent(event, { args = args })
end)

-- Main Loop. Idle until ADDON_LOADED has set up LumberjackSettings + currentSessionID.
local mainFrame = CreateFrame("Frame")
mainFrame.lastPoll = 0
mainFrame.lastSnapshot = 0

mainFrame:SetScript("OnUpdate", function(self, elapsed)
    if not (LumberjackSettings and currentSessionID) then return end

    self.lastPoll = self.lastPoll + elapsed
    self.lastSnapshot = self.lastSnapshot + elapsed

    if self.lastPoll >= (1 / LumberjackSettings.pollRate) then
        if LumberjackSettings.loggingEnabled then logPoll() end
        self.lastPoll = 0
    end

    if self.lastSnapshot >= SNAPSHOT_INTERVAL then
        if LumberjackSettings.loggingEnabled then
            logSnapshot("gear")
            logSnapshot("bags")
            logSnapshot("rep")
            logSnapshot("talents")
            logSnapshot("skills")
            logSnapshot("party")
        end
        self.lastSnapshot = 0
    end
end)

-- Session metadata. Called from ADDON_LOADED, NOT file scope — see top-of-file comment.
local function initSession()
    EPOCH_OFFSET = time() - GetTime()
    SESSION_ID = string.format("%d_%s", time(), UnitName("player") or "Unknown")
    local fok, factionGroup = pcall(UnitFactionGroup, "player")
    local bok, version, build, _, tocversion = pcall(GetBuildInfo)
    local gok, playerGUID = pcall(UnitGUID, "player")
    local session = {
        id = SESSION_ID,
        startTime = time(),
        character = UnitName("player"),
        realm = GetRealmName(),
        faction = (fok and factionGroup) or "Unknown",
        race = UnitRace("player"),
        class = UnitClass("player"),
        character_guid = gok and playerGUID or nil,
        client_version = bok and version or nil,
        client_build = bok and build or nil,
        client_tocversion = bok and tocversion or nil,
    }
    table.insert(LumberjackDB.sessions, session)
    currentSessionID = SESSION_ID
    lastPollState = {} -- reset write-on-change cache so the first poll of this session emits all stable fields
    print(string.format("Lumberjack: session %s started (sessions table now has %d entr%s)",
        SESSION_ID, #LumberjackDB.sessions, #LumberjackDB.sessions == 1 and "y" or "ies"))
end

-- Startup: ADDON_LOADED does all SavedVariables-touching init. PLAYER_LOGIN does the marker trim.
local startupFrame = CreateFrame("Frame")
startupFrame:RegisterEvent("ADDON_LOADED")
startupFrame:RegisterEvent("PLAYER_LOGIN")
startupFrame:SetScript("OnEvent", function(self, event, addonName)
    if event == "ADDON_LOADED" and addonName == "Lumberjack" then
        -- SavedVariables are now actually populated.
        if not LumberjackSettings then
            LumberjackSettings = {
                loggingEnabled = true,
                pollRate = POLL_RATE,
                captureChat = true,
                captureCLEU = true,
            }
        end
        LumberjackDB = LumberjackDB or { poll = {}, events = {}, snapshots = {}, sessions = {} }
        LumberjackDB.poll = LumberjackDB.poll or {}
        LumberjackDB.events = LumberjackDB.events or {}
        LumberjackDB.snapshots = LumberjackDB.snapshots or {}
        LumberjackDB.sessions = LumberjackDB.sessions or {}

        initSession()

        if LumberjackSettings.captureCLEU then
            pcall(LoggingCombat, true)
        end

        self:UnregisterEvent("ADDON_LOADED")

    elseif event == "PLAYER_LOGIN" then
        if LumberjackHighwaterMark then
            local pT, eT, sT
            LumberjackDB.poll,      pT = trimByTime(LumberjackDB.poll,      LumberjackHighwaterMark)
            LumberjackDB.events,    eT = trimByTime(LumberjackDB.events,    LumberjackHighwaterMark)
            LumberjackDB.snapshots, sT = trimByTime(LumberjackDB.snapshots, LumberjackHighwaterMark)
            print(string.format("Lumberjack: highwater=%s; trimmed %d poll, %d events, %d snapshots",
                tostring(LumberjackHighwaterMark), pT, eT, sT))
            -- Clear in-memory copy so a /reload-mid-session doesn't re-log the same trim. WoW won't
            -- persist this nil (the global isn't a SavedVariable) but tidiness is free.
            LumberjackHighwaterMark = nil
        else
            print("Lumberjack: no highwater mark found on login")
        end
    end
end)

-- Slash Commands — console-only interface. Run "/lumberjack" with no args for help.
local function fmtCount(n)
    if n >= 1e6 then return string.format("%.1fM", n / 1e6) end
    if n >= 1e3 then return string.format("%.1fk", n / 1e3) end
    return tostring(n)
end

local subcommands = {}

local function notReady()
    if LumberjackDB and LumberjackSettings then return false end
    print("Lumberjack: not initialized yet (ADDON_LOADED hasn't fired). Try again in a moment.")
    return true
end

subcommands.status = function()
    if notReady() then return end
    local pos = getPosition()
    local lvl = UnitLevel("player")
    local xp, mxp = UnitXP("player"), UnitXPMax("player")
    local pct = (mxp and mxp > 0) and (xp / mxp) * 100 or 0
    local last = LumberjackDB.sessions[#LumberjackDB.sessions]
    local duration = last and (time() - last.startTime) or 0
    local size = estimateDBSize()
    print(string.format("Lumberjack: lvl %d (%.1f%%)  zone=%s (%.2f, %.2f)  session=%ds  cache=%.2fMB",
        lvl or 0, pct, pos.zone, pos.x, pos.y, duration, size))
    print(string.format("  rows: poll=%s events=%s snapshots=%s sessions=%s  logging=%s cleu=%s rate=%dHz",
        fmtCount(#LumberjackDB.poll), fmtCount(#LumberjackDB.events),
        fmtCount(#LumberjackDB.snapshots), fmtCount(#LumberjackDB.sessions),
        LumberjackSettings.loggingEnabled and "on" or "off",
        LumberjackSettings.captureCLEU and "on" or "off",
        LumberjackSettings.pollRate))
end

subcommands.size = function()
    if notReady() then return end
    local size = estimateDBSize()
    local band = size < 5 and "GREEN" or (size < 20 and "YELLOW" or "RED")
    print(string.format("Lumberjack: cache=%.2fMB [%s]  poll=%d events=%d snapshots=%d sessions=%d",
        size, band, #LumberjackDB.poll, #LumberjackDB.events, #LumberjackDB.snapshots, #LumberjackDB.sessions))
end

subcommands.sessions = function()
    if notReady() then return end
    print(string.format("Lumberjack: %d session entr%s", #LumberjackDB.sessions,
        #LumberjackDB.sessions == 1 and "y" or "ies"))
    local last = LumberjackDB.sessions[#LumberjackDB.sessions]
    if last then
        print(string.format("  last: id=%s char=%s startTime=%d", last.id, last.character or "?", last.startTime or 0))
    end
end

subcommands.log = function(args)
    if notReady() then return end
    local v = args[1]
    if v == "on" then LumberjackSettings.loggingEnabled = true
    elseif v == "off" then LumberjackSettings.loggingEnabled = false
    elseif v ~= nil then print("Usage: /lumberjack log on|off") return end
    print("Lumberjack: logging=" .. (LumberjackSettings.loggingEnabled and "on" or "off"))
end

subcommands.cleu = function(args)
    if notReady() then return end
    local v = args[1]
    if v == "on" then LumberjackSettings.captureCLEU = true; pcall(LoggingCombat, true)
    elseif v == "off" then LumberjackSettings.captureCLEU = false; pcall(LoggingCombat, false)
    elseif v ~= nil then print("Usage: /lumberjack cleu on|off") return end
    print("Lumberjack: cleu=" .. (LumberjackSettings.captureCLEU and "on" or "off"))
end

subcommands.rate = function(args)
    if notReady() then return end
    local hz = tonumber(args[1])
    if not hz or hz < 1 or hz > 10 then
        print("Usage: /lumberjack rate <1..10>  (current: " .. LumberjackSettings.pollRate .. " Hz)")
        return
    end
    LumberjackSettings.pollRate = hz
    print("Lumberjack: pollRate=" .. hz .. " Hz")
end

subcommands.wipe = function()
    if notReady() then return end
    LumberjackDB.poll = {}
    LumberjackDB.events = {}
    LumberjackDB.snapshots = {}
    print("Lumberjack: data wiped (sessions preserved).")
end

subcommands.help = function()
    print("Lumberjack commands:")
    print("  /lumberjack status          show level/xp/zone/coords/duration/cache")
    print("  /lumberjack size            cache band + per-stream counts")
    print("  /lumberjack sessions        sessions table count + last entry")
    print("  /lumberjack log on|off      toggle logging (poll + snapshots)")
    print("  /lumberjack cleu on|off     toggle native combat log writing")
    print("  /lumberjack rate <1..10>    set poll rate in Hz")
    print("  /lumberjack wipe            clear poll/events/snapshots (sessions preserved)")
end

local function splitArgs(s)
    local out = {}
    for token in string.gmatch(s or "", "%S+") do out[#out + 1] = token end
    return out
end

SLASH_LUMBERJACK1 = "/lumberjack"
SLASH_LUMBERJACK2 = "/lj"
SlashCmdList["LUMBERJACK"] = function(msg)
    local cmd, rest = (msg or ""):match("^%s*(%S*)%s*(.*)$")
    if not cmd or cmd == "" then subcommands.help() return end
    local h = subcommands[cmd]
    if not h then print("Lumberjack: unknown subcommand '" .. cmd .. "'. Try /lumberjack help") return end
    local ok, err = pcall(h, splitArgs(rest))
    if not ok then print("Lumberjack: handler error: " .. tostring(err)) end
end
