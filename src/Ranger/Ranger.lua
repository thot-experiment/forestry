-- Ranger
-- Captures localized names for spell/item IDs encountered during play.
-- Sidecar to Lumberjack: separate addon so its SavedVariable file is independent of the main log
-- (Lumberjack's growing/wiping log shouldn't churn the ranger's accumulated names, and vice versa).
--
-- v0.1 scope:
--   * Spell IDs from UNIT_SPELLCAST_SUCCEEDED (player only) → GetSpellInfo
--   * Spell IDs from COMBAT_LOG_EVENT_UNFILTERED's SPELL_* subevents (id+name comes for free in the
--     event payload — we just dedupe and store)
-- Items / talents / professions deferred to v0.2 once usage patterns are clearer.
--
-- All init deferred to ADDON_LOADED — see METHODOLOGY §9 (BC SavedVariables timing).

local ensureSpell
local addedThisSession = 0

local function ensureSpellFromAPI(spellID)
    if not spellID or RangerDB.spells[spellID] then return end
    local ok, name, rank, icon, castTime, minRange, maxRange = pcall(GetSpellInfo, spellID)
    if not ok or not name then return end
    -- GetSpellLevelLearned may be MISSING on 2.5.5 — wrap in pcall and tolerate nil.
    local lok, learnedLevel = pcall(GetSpellLevelLearned, spellID)
    RangerDB.spells[spellID] = {
        name = name,
        rank = (rank ~= "" and rank) or nil,
        icon = icon,
        cast_time = (castTime and castTime > 0) and castTime or nil,
        min_range = (minRange and minRange > 0) and minRange or nil,
        max_range = (maxRange and maxRange > 0) and maxRange or nil,
        level_learned = (lok and learnedLevel and learnedLevel > 0) and learnedLevel or nil,
    }
    addedThisSession = addedThisSession + 1
end

-- For CLEU we get the name in the event args, so no API call needed. Cheaper.
local function ensureSpellFromCLEU(spellID, spellName, spellSchool)
    if not spellID or not spellName or RangerDB.spells[spellID] then return end
    RangerDB.spells[spellID] = { name = spellName, school = spellSchool }
    addedThisSession = addedThisSession + 1
end

ensureSpell = ensureSpellFromAPI -- exposed alias if needed elsewhere

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("UNIT_SPELLCAST_SUCCEEDED")
frame:RegisterEvent("COMBAT_LOG_EVENT_UNFILTERED")

frame:SetScript("OnEvent", function(self, event, ...)
    if event == "ADDON_LOADED" then
        local addon = ...
        if addon ~= "Ranger" then return end
        RangerDB = RangerDB or {}
        RangerDB.spells = RangerDB.spells or {}
        RangerDB.items = RangerDB.items or {}
        RangerDB.meta = RangerDB.meta or {}
        local lok, locale = pcall(GetLocale)
        if lok then RangerDB.meta.locale = locale end
        local bok, version, build, _, tocversion = pcall(GetBuildInfo)
        if bok then
            RangerDB.meta.version = version
            RangerDB.meta.build = build
            RangerDB.meta.tocversion = tocversion
        end
        RangerDB.meta.last_session_start = time()
        self:UnregisterEvent("ADDON_LOADED")
        return
    end

    if not RangerDB then return end

    if event == "UNIT_SPELLCAST_SUCCEEDED" then
        local unit, _castGUID, spellID = ...
        if unit == "player" then ensureSpellFromAPI(spellID) end

    elseif event == "COMBAT_LOG_EVENT_UNFILTERED" then
        -- Use CombatLogGetCurrentEventInfo when available (verified shape via Probe required for prod).
        -- BC layout: timestamp, subevent, hideCaster, srcGUID, srcName, srcFlags, srcRaidFlags,
        --             destGUID, destName, destFlags, destRaidFlags, [prefix args for SPELL_*]
        -- For SPELL_* subevents the next three args are spellID, spellName, spellSchool.
        local ok, ts, sub, _hide, _sg, _sn, _sf, _srf, _dg, _dn, _df, _drf, sId, sName, sSchool =
            pcall(CombatLogGetCurrentEventInfo)
        if ok and sub and sId and sName and string.sub(sub, 1, 6) == "SPELL_" then
            ensureSpellFromCLEU(sId, sName, sSchool)
        end
    end
end)

-- Slash command. Console-only per project preference.
SLASH_RANGER1 = "/ranger"
SlashCmdList["RANGER"] = function()
    if not RangerDB then print("Ranger: not initialized yet."); return end
    local n = 0; for _ in pairs(RangerDB.spells) do n = n + 1 end
    print(string.format("Ranger: %d spells total (+%d this session)  locale=%s  build=%s",
        n, addedThisSession,
        RangerDB.meta.locale or "?", RangerDB.meta.build or "?"))
end
