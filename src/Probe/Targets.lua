-- Probe/Targets.lua
-- Hand-curated manifest of Blizzard symbols Probe should verify on this client build.
-- Format:
--   functions: { name = "DottedName", argv = {...}, expect = "type or shape", site = "where used", notes = "why" }
--   events:    { event = "EVENT_NAME", site = "where used", notes = "why" }
--
-- Sentinel args should be safe defaults: "player", 0, "target", etc.
-- "expect" is informational; the runner records actual return shape regardless.

ProbeTargets = {

functions = {
    -- Position / map
    { name = "C_Map.GetBestMapForUnit", argv = {"player"}, expect = "number?",
      site = "Lumberjack/getPosition", notes = "current map ID" },
    { name = "C_Map.GetPlayerMapPosition", argv = {0, "player"}, expect = "vector or nil",
      site = "Lumberjack/getPosition", notes = "0 is sentinel; runner passes whatever resolved mapID returned" },
    { name = "GetZoneText", argv = {}, expect = "string",
      site = "Lumberjack/getPosition" },
    { name = "GetSubZoneText", argv = {}, expect = "string",
      site = "Lumberjack/getPosition" },
    { name = "GetMinimapZoneText", argv = {}, expect = "string",
      site = "candidate", notes = "may be more granular than GetSubZoneText" },

    -- Player identity
    { name = "UnitName", argv = {"player"}, expect = "string,string?",
      site = "Lumberjack/initSession" },
    { name = "GetUnitName", argv = {"player", false}, expect = "string",
      site = "Lumberjack/initSession" },
    { name = "GetRealmName", argv = {}, expect = "string",
      site = "Lumberjack/initSession" },
    { name = "UnitRace", argv = {"player"}, expect = "string,string,number",
      site = "Lumberjack/initSession" },
    { name = "UnitClass", argv = {"player"}, expect = "string,string,number",
      site = "Lumberjack/initSession" },
    { name = "UnitFactionGroup", argv = {"player"}, expect = "string,string",
      site = "Lumberjack/initSession", notes = "verified replacement for UnitFaction/GetFactionAlliance (both MISSING on 2.5.5)" },

    -- Player vitals
    { name = "UnitLevel", argv = {"player"}, expect = "number",
      site = "Lumberjack/logPoll" },
    { name = "UnitHealth", argv = {"player"}, expect = "number",
      site = "Lumberjack/logPoll" },
    { name = "UnitHealthMax", argv = {"player"}, expect = "number",
      site = "Lumberjack/logPoll" },
    { name = "UnitPower", argv = {"player", 0}, expect = "number",
      site = "Lumberjack/logPoll", notes = "BC indices: 0=Mana, 1=Rage, 2=Focus (pet), 3=Energy, 4=Happiness (pet). Forestry captures 0/1/3 as mp/rg/en respectively." },
    { name = "UnitPowerMax", argv = {"player", 0}, expect = "number",
      site = "candidate" },
    { name = "UnitXP", argv = {"player"}, expect = "number",
      site = "Lumberjack/logPoll" },
    { name = "UnitXPMax", argv = {"player"}, expect = "number",
      site = "Lumberjack/logPoll" },
    { name = "GetXPExhaustion", argv = {}, expect = "number?",
      site = "Lumberjack/logPoll", notes = "rested XP pool" },

    -- Combat / state
    { name = "UnitAffectingCombat", argv = {"player"}, expect = "boolean",
      site = "Lumberjack/logPoll",
      notes = "verified replacement for InCombatLockdown (which exists but means 'secure-action restricted', wrong semantic)" },
    { name = "IsMounted", argv = {}, expect = "boolean",
      site = "Lumberjack/logPoll" },
    { name = "GetShapeshiftForm", argv = {}, expect = "number",
      site = "Lumberjack/logPoll", notes = "druid form determines active resource (cat=energy, bear=rage). Other classes return 0/1 for stance/shadowform/etc." },
    { name = "GetComboPoints", argv = {"player", "target"}, expect = "number",
      site = "Lumberjack/logPoll", notes = "0..5; rogues/cat-druids. 0 when no target or non-applicable class" },
    { name = "IsFalling", argv = {}, expect = "boolean",
      site = "Lumberjack/logPoll", notes = "true while airborne — write-on-change in poll lets us count jump transitions" },
    { name = "UnitPosition", argv = {"player"}, expect = "y?,x?,z?,instanceID?",
      site = "candidate", notes = "may be MISSING on 2.5.5; if available, returns world-axis y/x/z (NOT the 0..1 map coord)" },
    { name = "IsStealthed", argv = {}, expect = "boolean",
      site = "Lumberjack/logPoll", notes = "verified replacement for UnitIsStealthy (which is MISSING on 2.5.5)" },

    -- Target
    { name = "UnitExists", argv = {"target"}, expect = "boolean",
      site = "Lumberjack/getTargetData" },
    { name = "UnitGUID", argv = {"player"}, expect = "string",
      site = "Lumberjack/getTargetData" },
    { name = "UnitClassification", argv = {"player"}, expect = "string",
      site = "Lumberjack/getTargetData" },

    -- Casting
    { name = "UnitCastingInfo", argv = {"player"}, expect = "string?,...",
      site = "Lumberjack/logPoll" },
    { name = "UnitChannelInfo", argv = {"player"}, expect = "string?,...",
      site = "candidate" },

    -- Money / inventory
    { name = "GetMoney", argv = {}, expect = "number",
      site = "Lumberjack/logPoll" },
    { name = "C_Container.GetContainerNumFreeSlots", argv = {0}, expect = "number,number",
      site = "Lumberjack/logPoll" },
    { name = "C_Container.GetContainerNumSlots", argv = {0}, expect = "number",
      site = "Lumberjack/logSnapshot" },
    { name = "C_Container.GetContainerItemLink", argv = {0, 1}, expect = "string?",
      site = "Lumberjack/logSnapshot" },
    { name = "GetInventoryItemLink", argv = {"player", 1}, expect = "string?",
      site = "Lumberjack/logSnapshot",
      notes = "called with integer slot 0..19; GetInventorySlotInfo deliberately not used (it expects a slot name string)" },
    { name = "GetInventoryItemDurability", argv = {1}, expect = "number,number",
      site = "Lumberjack/logSnapshot (gear)",
      notes = "returns current and max durability of equipped item" },

    -- Performance / timing
    { name = "GetFramerate", argv = {}, expect = "number",
      site = "Lumberjack/logPoll", notes = "verified — note lowercase r (GetFrameRate uppercase R is MISSING on 2.5.5)" },
    { name = "GetNetStats", argv = {}, expect = "number,number,number,number",
      site = "Lumberjack/logPoll",
      notes = "returns (downKBps, upKBps, latencyHomeMs, latencyWorldMs); Forestry uses world latency (4th return)" },
    { name = "GetTime", argv = {}, expect = "number",
      site = "Lumberjack/everywhere" },
    { name = "time", argv = {}, expect = "number",
      site = "Lumberjack/everywhere" },

    -- Combat log
    { name = "LoggingCombat", argv = {true}, expect = "boolean?",
      site = "Lumberjack/cleu toggle", notes = "side effect — toggles file logging" },

    -- Faction reputation (used by Lumberjack/logSnapshot kind=rep — pending probe verification)
    { name = "GetNumFactions", argv = {}, expect = "number",
      site = "Lumberjack/logSnapshot (rep)" },
    { name = "GetFactionInfo", argv = {1}, expect = "name,desc,standingID,barMin,barMax,barValue,atWar,canToggle,isHeader,isCollapsed,hasRep,isWatched,isChild",
      site = "Lumberjack/logSnapshot (rep)" },
    { name = "ExpandAllFactionHeaders", skip_call = true,
      site = "Lumberjack/logSnapshot (rep)",
      notes = "must be called before the GetFactionInfo loop; otherwise collapsed headers hide their factions" },
    { name = "GetFactionInfoByID", argv = {69}, expect = "string,...",
      site = "candidate (lookup by stable faction ID; 69=Darnassus)" },

    -- Spells (Ranger)
    { name = "GetSpellInfo", argv = {116}, expect = "name,rank,icon,castTime,minRange,maxRange,spellID",
      site = "Ranger/ensureSpellFromAPI", notes = "116 = Frostbolt rank 1; localized name" },
    { name = "GetSpellLevelLearned", argv = {116}, expect = "number?",
      site = "Ranger/ensureSpellFromAPI", notes = "may be MISSING on 2.5.5; wrapped in pcall" },
    { name = "GetLocale", argv = {}, expect = "string",
      site = "Ranger/ADDON_LOADED", notes = "client locale, e.g. 'enUS'" },
    { name = "CombatLogGetCurrentEventInfo", argv = {}, expect = "ts,subevent,hideCaster,...,spellID?,spellName?,spellSchool?",
      site = "Ranger/COMBAT_LOG_EVENT_UNFILTERED", notes = "BC: shape includes prefix args after destFlags; SPELL_* subevents give (id,name,school)" },

    -- Build / version
    { name = "GetBuildInfo", argv = {}, expect = "string,string,string,number",
      site = "Probe/init", notes = "ground truth for build identity" },
    { name = "C_AddOns.GetAddOnMetadata", argv = {"Probe", "Version"}, expect = "string?",
      site = "Probe/init", notes = "verified replacement for GetAddOnMetadata (which is MISSING on 2.5.5)" },

    -- UI primitives (Forestry no longer renders an in-game UI; CreateFrame still used for event/main frames)
    { name = "CreateFrame", argv = {"Frame"}, expect = "table",
      site = "Lumberjack/eventFrame, mainFrame, startupFrame", notes = "core API" },

    -- Talents (candidate — slice 8.7 snapshot kind=talents). BC has 3 talent tabs per class.
    { name = "GetNumTalentTabs", argv = {}, expect = "number",
      site = "candidate (Lumberjack/logSnapshot talents)", notes = "BC returns 3 for most classes (one tab per spec)" },
    { name = "GetTalentTabInfo", argv = {1}, expect = "name,iconTexture,pointsSpent,fileName",
      site = "candidate (Lumberjack/logSnapshot talents)" },
    { name = "GetNumTalents", argv = {1}, expect = "number",
      site = "candidate (Lumberjack/logSnapshot talents)", notes = "talents in tab N" },
    { name = "GetTalentInfo", argv = {1, 1}, expect = "name,iconTexture,tier,column,rank,maxRank",
      site = "candidate (Lumberjack/logSnapshot talents)" },

    -- Party / raid state (candidate — slice 9.7 snapshot kind=party). BC uses GetNumPartyMembers
    -- (excludes self) and GetNumRaidMembers (includes self). Existence-only checks for IsInGroup/IsInRaid
    -- since they were added later than BC and may be MISSING.
    { name = "GetNumPartyMembers", argv = {}, expect = "number",
      site = "candidate (Lumberjack/logSnapshot party)", notes = "0..4; does NOT count self. **MISSING on BC Anniversary 2.5.5** despite being the BC-classic name — BC anniversary ships with retail-era group APIs. Use GetNumGroupMembers." },
    { name = "GetNumRaidMembers", argv = {}, expect = "number",
      site = "candidate (Lumberjack/logSnapshot party)", notes = "**MISSING on BC Anniversary 2.5.5**. Use GetNumGroupMembers." },
    { name = "GetNumGroupMembers", argv = {}, expect = "number",
      site = "Lumberjack/logSnapshot (party)", notes = "retail-era replacement, probe-verified OK on BC Anniversary 2.5.5. Includes self when in raid; excludes self when in party." },
    { name = "GetNumSubgroupMembers", argv = {}, expect = "number",
      site = "Lumberjack/logSnapshot (party)", notes = "retail-era equivalent of GetNumPartyMembers (excludes self), probe-verified OK on BC." },
    { name = "IsInGroup", argv = {}, expect = "boolean?",
      site = "candidate (Lumberjack/logSnapshot party)", notes = "may be MISSING on BC — fall back to GetNumPartyMembers() > 0" },
    { name = "IsInRaid", argv = {}, expect = "boolean?",
      site = "candidate (Lumberjack/logSnapshot party)", notes = "may be MISSING on BC — fall back to GetNumRaidMembers() > 0" },
    { name = "UnitName", argv = {"party1"}, expect = "string?",
      site = "candidate (Lumberjack/logSnapshot party)", notes = "nil when party1 slot empty; iterate party1..party4 / raid1..raid40" },
    { name = "UnitClass", argv = {"party1"}, expect = "string?,string?,number?",
      site = "candidate (Lumberjack/logSnapshot party)" },
    { name = "UnitLevel", argv = {"party1"}, expect = "number?",
      site = "candidate (Lumberjack/logSnapshot party)" },
    { name = "UnitGUID", argv = {"party1"}, expect = "string?",
      site = "candidate (Lumberjack/logSnapshot party)" },
    { name = "GetPartyLeaderIndex", argv = {}, expect = "number?",
      site = "candidate (Lumberjack/logSnapshot party)", notes = "may not exist on BC; UnitIsPartyLeader('party1') is the fallback" },
    { name = "UnitIsPartyLeader", argv = {"player"}, expect = "boolean",
      site = "candidate (Lumberjack/logSnapshot party)", notes = "**MISSING on BC Anniversary 2.5.5**. Use UnitIsGroupLeader." },
    { name = "UnitIsGroupLeader", argv = {"player"}, expect = "boolean",
      site = "Lumberjack/logSnapshot (party)", notes = "retail-era replacement, probe-verified OK on BC Anniversary 2.5.5." },
    { name = "GetLootMethod", argv = {}, expect = "string,number?,number?",
      site = "candidate (Lumberjack/logSnapshot party)", notes = "**MISSING on BC Anniversary 2.5.5**. Probe C_PartyInfo.GetLootMethod." },
    { name = "C_PartyInfo.GetLootMethod", argv = {}, expect = "number (integer enum)",
      site = "Lumberjack/logSnapshot (party)", notes = "retail-era namespace, probe-verified OK on BC. Returns an integer enum, NOT the legacy (string,masterPartyID,masterRaidID) shape — store the int and map client-side if needed." },

    -- Skills (candidate — slice 8.7 snapshot kind=skills). Includes weapon skills, professions, defense.
    { name = "GetNumSkillLines", argv = {}, expect = "number",
      site = "candidate (Lumberjack/logSnapshot skills)" },
    { name = "GetSkillLineInfo", argv = {1}, expect = "skillName,header,isExpanded,skillRank,numTempPoints,skillModifier,skillMaxRank,isAbandonable,stepCost,rankCost,minLevel,skillCostType,skillDescription",
      site = "candidate (Lumberjack/logSnapshot skills)", notes = "iterate 1..GetNumSkillLines(). Headers like 'Languages' have header=true and should be skipped or noted" },
    { name = "ExpandSkillHeader", argv = {0}, expect = "(side-effect)",
      site = "candidate (Lumberjack/logSnapshot skills)", notes = "0 expands all; call before iterating GetSkillLineInfo so collapsed sections aren't hidden" },
},

events = {
    -- Lifecycle
    { event = "ADDON_LOADED", site = "Lumberjack/startupFrame", notes = "argv: addonName. Used by Forestry to defer SavedVariables init (see METHODOLOGY §9)" },
    { event = "PLAYER_LOGIN", site = "Probe/init", notes = "argv shape on first login this session" },
    { event = "PLAYER_ENTERING_WORLD", site = "Probe/init", notes = "may carry isInitialLogin, isReloadingUi" },
    { event = "PLAYER_LEVEL_UP", site = "Lumberjack/events" },
    { event = "PLAYER_DEAD", site = "Lumberjack/events" },
    { event = "PLAYER_ALIVE", site = "Lumberjack/events" },
    { event = "PLAYER_UNGHOST", site = "Lumberjack/events", notes = "fires when player rezzes from ghost (corpse run completed or accept rez)" },
    { event = "PLAYER_REGEN_ENABLED", site = "Lumberjack/events", notes = "combat exit" },
    { event = "PLAYER_REGEN_DISABLED", site = "Lumberjack/events", notes = "combat enter" },
    { event = "PLAYER_UPDATE_RESTING", site = "Lumberjack/events", notes = "rested-state change (entering/leaving an inn or rest area)" },

    -- Movement
    { event = "ZONE_CHANGED", site = "Lumberjack/events" },
    { event = "ZONE_CHANGED_INDOORS", site = "Lumberjack/events" },
    { event = "ZONE_CHANGED_NEW_AREA", site = "Lumberjack/events" },
    { event = "TAXIMAP_OPENED", site = "Lumberjack/events", notes = "flight master opened" },

    -- Quest
    { event = "QUEST_ACCEPTED", site = "Lumberjack/events", notes = "argv likely (questLogIndex, questID); shape captured by probe" },
    { event = "QUEST_TURNED_IN", site = "Lumberjack/events", notes = "argv likely (questID, xpReward, moneyReward)" },
    { event = "QUEST_LOG_UPDATE", site = "Lumberjack/events" },

    -- Loot / inventory
    { event = "CHAT_MSG_LOOT", site = "Lumberjack/events", notes = "loot text including 'You receive loot: [Item]'" },
    { event = "ITEM_PUSH", site = "Lumberjack/events", notes = "argv: bagSlot, iconFileID — item picked up" },
    { event = "BAG_UPDATE_DELAYED", site = "candidate", notes = "snapshots already cover bag contents every 60s" },

    -- Economy
    { event = "PLAYER_MONEY", site = "Lumberjack/events" },

    -- Targeting
    { event = "PLAYER_TARGET_CHANGED", site = "Lumberjack/events" },

    -- Casts
    { event = "UNIT_SPELLCAST_SUCCEEDED", site = "Lumberjack/events", notes = "argv: unitTarget, castGUID, spellID (probe-verified)" },
    { event = "COMBAT_LOG_EVENT_UNFILTERED", site = "Ranger/COMBAT_LOG_EVENT_UNFILTERED", notes = "fires per CLEU line — Ranger uses CombatLogGetCurrentEventInfo() rather than varargs" },

    -- Character progression
    { event = "CHARACTER_POINTS_CHANGED", site = "Lumberjack/events", notes = "talent points spent/refunded" },
    { event = "SKILL_LINES_CHANGED", site = "Lumberjack/events", notes = "weapon skills, professions" },

    -- Errors / chat
    { event = "UI_ERROR_MESSAGE", site = "Lumberjack/events", notes = "argv: errorType, errorMessage — qualitative signal of player mistakes" },
    { event = "UI_INFO_MESSAGE", site = "Lumberjack/events", notes = "argv likely (errorType, message); fires for 'Quest complete!', objective ticks ('Wolf Pelt: 5/8'). Probe to confirm payload shape on 2.5.5." },
    { event = "CHAT_MSG_SYSTEM", site = "Lumberjack/events" },

    -- Friction events (candidate — slice 8.7). Pair of SHOW/CLOSE to measure time-in-menu. All should
    -- fire on the addon's event frame regardless of UI presence; payload is usually empty (event only).
    { event = "MERCHANT_SHOW", site = "candidate (friction: vendor/repair)" },
    { event = "MERCHANT_CLOSED", site = "candidate (friction: vendor/repair)" },
    { event = "TRAINER_SHOW", site = "candidate (friction: skill/spell training)" },
    { event = "TRAINER_CLOSED", site = "candidate (friction: skill/spell training)" },
    { event = "MAIL_SHOW", site = "candidate (friction: mail)" },
    { event = "MAIL_CLOSED", site = "candidate (friction: mail)" },
    { event = "BANKFRAME_OPENED", site = "candidate (friction: bank)" },
    { event = "BANKFRAME_CLOSED", site = "candidate (friction: bank)" },
    { event = "AUCTION_HOUSE_SHOW", site = "candidate (friction: AH — rare at 1-58 but exists)" },
    { event = "AUCTION_HOUSE_CLOSED", site = "candidate (friction: AH)" },
    { event = "LOOT_OPENED", site = "candidate (friction: looting)", notes = "argv likely (autoLoot, isFromItem); confirm shape via probe" },
    { event = "LOOT_CLOSED", site = "candidate (friction: looting)" },
    { event = "CINEMATIC_START", site = "candidate (friction: cutscene; IF gate, intro, etc. — often skippable)" },
    { event = "CINEMATIC_STOP", site = "candidate (friction: cutscene)" },
    { event = "TAXIMAP_CLOSED", site = "candidate (friction: taxi-decision time; we already capture TAXIMAP_OPENED)" },

    -- Sharper XP signal (candidate — slice 8.7). Polled XP-diff loses precision and source attribution.
    { event = "PLAYER_XP_UPDATE", site = "candidate (precise XP-gain events)",
      notes = "argv: unitTarget (always 'player' for this event). Doesn't carry source/amount directly — for that, watch CHAT_MSG_COMBAT_XP_GAIN strings. May replace polled curr_xp deltas." },
    { event = "CHAT_MSG_COMBAT_XP_GAIN", site = "candidate (XP-source attribution)",
      notes = "string messages like 'You receive 145 experience' or 'You gain 100 experience.'; parseable for amount + source (mob name)" },

    -- Hearthstone bind tracking (candidate). On BC the bind event may be CONFIRM_BINDER_BIND (prompt)
    -- and/or HEARTHSTONE_BOUND (post-confirm). Probe both; whichever fires reliably wins.
    { event = "CONFIRM_BINDER_BIND", site = "candidate (hearthstone bind prompt)" },
    { event = "HEARTHSTONE_BOUND", site = "candidate (hearthstone bind confirmed; may be retail-only)" },

    -- Faction reputation deltas (candidate — sharper than the 60s rep snapshot).
    { event = "UPDATE_FACTION", site = "candidate (rep changes; pairs with rep snapshot)" },

    -- Party / raid (candidate — slice 9.7). BC uses PARTY_MEMBERS_CHANGED (NOT GROUP_ROSTER_UPDATE
    -- which arrived later). Probe both to learn which the client accepts.
    { event = "PARTY_MEMBERS_CHANGED", site = "candidate (party join/leave/kick)" },
    { event = "GROUP_ROSTER_UPDATE", site = "candidate (party/raid roster — retail-era name, may NOT register on BC)" },
    { event = "PARTY_LEADER_CHANGED", site = "candidate (leader handoff)" },
    { event = "PARTY_LOOT_METHOD_CHANGED", site = "candidate (loot rules changed — group/master/round-robin etc.)" },
    { event = "RAID_ROSTER_UPDATE", site = "candidate (raid join/leave — fires for raid-size groups)" },
    { event = "PARTY_CONVERTED_TO_RAID", site = "candidate (party promoted to raid)" },
},

}
