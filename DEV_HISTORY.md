# Forestry — Development History

Backward-looking record. PLAN.md is the forward-looking roadmap; DEV_NOTES.md has gotchas and invariants.

---

## System Architecture

Four independent data streams, joined by `session_id`:

| Stream | Source | Frequency | Purpose |
|---|---|---|---|
| `poll` | Addon (SavedVariables) | 10 Hz | Dense temporal grid: position, health, resources, perf |
| `events` | Addon (SavedVariables) | On-fire | Exact timestamps: state changes, loot, quests, friction |
| `snapshots` | Addon (SavedVariables) | 60s + triggers | Slow-moving heavy state: gear, bags, rep, talents, skills, party |
| `cleu` | `Logs/WoWCombatLog-*.txt` | Continuous | Full combat log via `LoggingCombat(true)` |

Splitting these prevents polling everything at 10Hz: stable data (buffs, gear) is write-on-change in poll; unbounded data (combat log) is native-file. Event-driven captures preserve exact timing without per-tick bloat.

**Components:**
- `src/Lumberjack/` — in-game capture addon (sessions, poll, events, snapshots, CLEU toggle)
- `src/Ranger/` — sidecar for spell name/metadata (account-wide SavedVariable, enriches spell-cast display)
- `src/Probe/` — dev-only API verifier, never enabled during a real run
- `src/Sawmill/` — Node.js pipeline: file watcher → archive → ingest → SQLite + web UI server
- `src/Geographer/` — offline map tools: coordinate math, ImageMagick resampling, 512px source PNGs

**Sawmill module layout:** `server.mjs` (entry) → `routes.mjs` (HTTP) + `watcher.mjs` (fs.watch) + `ingest.mjs` (Lumberjack→db) + `cleu.mjs` (combat log→db) + `db.mjs` (SQLite/schema) + `config.mjs` (paths) + `state.mjs` (mtime/offsets per file). Frontend: vanilla HTML + Alpine + uPlot + raw canvas at `Sawmill/www/`.

**SQLite schema (`forestry.db`):** Schema is fluid — `ensureColumn` adds columns on the fly as the addon emits new fields.
- `sessions` — session_id, start_time, character_name, realm, faction, race, class, character_guid, client_version, client_build, client_tocversion
- `poll` — timestamp, session_id, all poll columns (see below); sparse NULLs for write-on-change fields
- `events` — timestamp, session_id, event_type, x, y, zone, payload (JSON)
- `snapshots` — timestamp, session_id, kind (gear|bags|rep|talents|skills|party), payload (JSON)
- `cleu` — timestamp, session_id, event_type, source/dest guid+name, spell_id, spell_name, amount, critical, school, raw_line

---

## What Lumberjack Captures (current state)

**Poll stream (10Hz, sparse write-on-change):**
- Always-include (nil-transition semantics or changes every tick): `sid`, `t`, `hp`, `mp`, `en`, `rg`, `fps`, `lat`, `mem`, `tgt` (JSON blob), `cast`, `cast_id`, `wx`, `wy`, `wz`, `inst`
- Write-on-change (NULL = unchanged): `x`, `y`, `mid`, `z`, `sz`, `lvl`, `mxp`, `xp`, `rest`, `bags`, `gold`, `mnt`, `stealth`, `combat`, `form`, `cp`, `falling`

**Events (30+ registered):**
- Lifecycle: `PLAYER_LEVEL_UP`, `PLAYER_DEAD`, `PLAYER_ALIVE`, `PLAYER_UNGHOST`, `PLAYER_REGEN_ENABLED/DISABLED`, `PLAYER_UPDATE_RESTING`, `PLAYER_XP_UPDATE`
- Movement: `ZONE_CHANGED`, `ZONE_CHANGED_INDOORS`, `ZONE_CHANGED_NEW_AREA`, `TAXIMAP_OPENED`, `TAXIMAP_CLOSED`
- Quests: `QUEST_ACCEPTED`, `QUEST_TURNED_IN`, `QUEST_LOG_UPDATE`
- Loot/economy: `CHAT_MSG_LOOT`, `ITEM_PUSH`, `PLAYER_MONEY`, `CHAT_MSG_COMBAT_XP_GAIN`
- Friction: `MERCHANT_SHOW/CLOSED`, `TRAINER_SHOW/CLOSED`, `MAIL_SHOW/CLOSED`, `BANKFRAME_OPENED/CLOSED`, `AUCTION_HOUSE_SHOW/CLOSED`, `LOOT_OPENED/CLOSED`, `CINEMATIC_START/STOP`
- Combat/cast: `PLAYER_TARGET_CHANGED`, `UNIT_SPELLCAST_SUCCEEDED`, `CHARACTER_POINTS_CHANGED`, `SKILL_LINES_CHANGED`
- Chat/errors: `UI_ERROR_MESSAGE`, `CHAT_MSG_SYSTEM`, `HEARTHSTONE_BOUND`
- Party: `GROUP_ROSTER_UPDATE`, `PARTY_LEADER_CHANGED`, `PARTY_LOOT_METHOD_CHANGED`, `RAID_ROSTER_UPDATE`

**Snapshots (every 60s):** gear (slots 0–19 + durability), bags (itemID→count), rep (all factions via `ExpandAllFactionHeaders`), talents (`GetNumTalentTabs × GetNumTalents × GetTalentInfo`, rank>0 only), skills (`GetNumSkillLines × GetSkillLineInfo`, weapons/defense/professions/languages), party (IsInGroup/IsInRaid + member iteration).

**Slash commands (`/lumberjack` or `/lj`):** `status`, `size`, `sessions`, `log on|off`, `cleu on|off`, `rate <1..10>`, `wipe`, `help`.

**Cache pressure bands:** GREEN <5MB, YELLOW 5–20MB, RED ≥20MB. Crash mid-session loses data since last `/reload` — periodic reloads are mandatory for long sessions.

**Ranger sidecar:** captures localized spell names + metadata via `GetSpellInfo`/`GetSpellLevelLearned` for player casts, plus bulk extraction from CLEU `SPELL_*` subevents. Account-wide SavedVariable; enriches spell-cast display in the web UI without a separate fetch.

**Probe (dev-only):** verifies every Blizzard symbol against the live client. Latest report: **52+ OK, 0 MISSING, 0 RAISED**. `node src/Sawmill/server.mjs --probe` regenerates `docs/APIReport.md` + history snapshot. `node src/Sawmill/extract_calls.mjs` checks every Lumberjack call has a Targets entry.

---
 
## Client-Side Analysis (2026-05-19)
 
Implemented a client-side efficiency metric to identify idle time.
- Relocated analysis logic from server (`src/Sawmill/analysis/`) to client (`src/Sawmill/www/analysis/`) using ES modules.
- Transitioned frontend scripts (`app.js`, `timeline.js`, `poll_rows.js`) to `.mjs` and updated `index.html` to `type="module"`.
- Added an "Idle %" card to the zone-stats panel.
- **Fixed**: Corrected `totalDuration` calculation to sum active session time rather than wall-clock difference, preventing gaps between sessions from inflating the denominator.
- **Fixed**: Increased wiggle thresholds for position (0.5yd), HP (10), and MP (10) to prevent resource regeneration from falsely breaking stable-value blocks.
- Inverted the metric from "Efficiency %" to "Idle %" for better clarity.


First commit established the repo with all four components under their pre-rename names (`Forestry`/`Lumberjack`/`Lexicon`/`Probe`). The working MVP commit had end-to-end data flow: addon → SavedVariables → server → SQLite → browser.

---

## Core Capture Infrastructure (commits 039b973–a165efd)

**Highwater-mark protocol.** Sawmill copies `Lumberjack.lua` → `Lumberjack.ingest.lua`, probes the copy, appends `LumberjackHighwaterMark = <epoch>` to the *original* as a plain Lua global (not a SavedVariable — WoW can't clobber a plain global on logout), renames the copy into `archive/`, then inserts in one transaction with per-session dedup. On next `PLAYER_LOGIN` the addon trims rows with `t <= mark`. Sessions are never trimmed. Crash/race recovery: missed marker = next ingest re-derives the highwater; per-session dedup drops rows already in SQLite.

**Epoch-aligned timestamps.** `t` on all rows is `GetTime() + EPOCH_OFFSET` where `EPOCH_OFFSET = time() - GetTime()` computed once per session. Sub-second precision, wall-clock aligned. Shared axis across all five tables — enables cross-session merging and CLEU joins. Raw `GetTime()` resets every client launch and is NOT used.

**Write-on-change.** Stable poll fields only emit when value changes. `lastPollState` resets per session so the first row of each session always carries full state. Forward-fill on the consumer side (`inspect.mjs poll-ff`).

**Key bug fixes:** UnitPower index mismap (BC indices are `0=Mana, 1=Rage, 3=Energy`, not retail order); CLEU CRLF parsing; lua_to_json.lua replacing the older dump_to_json; ack-then-trim marker protocol achieving zero verified duplicates; epoch timestamp alignment replacing raw GetTime across all streams.

---

## Visualization: Slices 8.1–8.6 (commits 5d7a6ae–e394773)

**8.1 — Scaffold.** `server.mjs` + `routes.mjs` apiHandler/staticRouter split, `/api/snapshot`, `www/` frontend with run-grouped session list, Alpine reactivity, 5s polling.

**8.2 — Trajectory canvas.** `/api/runs/:key/poll` (forward-filled, per-session), zone picker, x/y path drawing on canvas. Colors by session (golden-angle hues) or level (blue→red gradient). Multi-session overlay per zone. Zoom/pan: wheel + drag + dblclick-reset, range 0.0001–10000 (effectively uncapped). Auto-fit floors at `MIN_BOUNDS_YD = 100` so a tiny filtered segment doesn't slam to a 5-yd box. Markers are yard-sized (`MARKER_SPECS`; quest/deaths = 1.5 yd, others = 1 yd), scale with zoom, skip-draw below 1px. Dead-color path (grey during `PLAYER_DEAD→PLAYER_UNGHOST`/delayed-ALIVE spans). Teleport break detection at `PATH_TELEPORT_DIST = 0.04` normalized.

**8.3 — Timeline.** uPlot with playtime axis (session gaps cut out), session-color background bands, multi-resource series (HP/MP/EN/RG, auto-hidden when all-zero), level-up dashed lines, quest turn-in ticks, kill ticks, dead-interval shading. Per-run stats: played, xp, xp/hr, levels, kills, deaths, quests, distance, spell-cast frequency (top 30, Ranger-enriched). Per-session detail in dropdown. SESSION_PAD_PX = 4 (fixed gap in pixels regardless of total playtime).

**8.3e — Cross-view hover (one direction).** Timeline hover → highlight ring on trajectory at that poll row. Reverse (trajectory → timeline cursor) is unimplemented.

**8.3f — Performance.** `draw()` (full rebuild) vs `redrawTrajectoryOnly()` (cheap canvas-only pass). Per-zone stats cached into `runPolls[runKey].viewStatTiles` on `selectZone` rather than recomputed on every Alpine render cycle.

**8.4 — Splits.** 15-min buckets over continuous playtime (gaps capped at 2s). Each bucket: `{pt_start, pt_end, xp_gained, xp_per_hour, levels, kills, deaths, quests_*, distance, top_zone}`. Rendered as `<details>` table.

**8.5 — World view.** `__world__` pseudo-zone: filters rows to those with `wx/wy`, draws all sessions in world yards. `projX` uses `(1 - norm(wx, ...))` for north-up/west-left orientation (empirically verified — see GEOSPATIAL.md). Multi-continent synthetic layout: per-instance offsets from `atlas.json` `top` fields; Kalimdor left, EK right (top-aligned), Outland centered below. Unknown instances (raids, dungeons) dropped from world view.

**8.6 — Filtering.** Dual-handle level+time range sliders (ANDed). API: `?lvl_min=&lvl_max=&t_min=&t_max=`. Response carries `rows_all` (full context, drives timeline) and `rows` (filtered, drives everything else). Brush-select on timeline: uPlot `cursor.drag.x = true`, `setSelect` hook → `t_min/t_max`. Dimmed-outside overlay shows active region. Timeline always uses `rows_all` so context stays visible.

**8.6b — XP/hr.** Cumulative XP replaced with mass-preserving trapezoidal-kernel moving-sum. Each XP gain distributed over `[t_j−2W, t_j+2W]` as a trapezoid; integral of rate(t) = gain regardless of window W. Per-card slider (60s–3600s, default 600s).

**8.6-future-a — Columnar wire format.** `columnar_v1`: per-column typed arrays, delta-encoded `t`, write-on-change nulls in `rows_all`, dense in `rows`, RLE for `zone`/`sz`. Client `PollRows` object: dense `Float64Array t`, `Uint16Array sid`, `Float32Array wx/wy/wz`, `Int16Array inst`, `Uint8Array hasWorldAt` bitmask. All other numeric fields sparse via `{indices: Uint32Array, values: TypedArray}` with cursor-optimized accessors. ~half wire size, ~1/8 client memory vs row-shape at scale. Legacy row-shape server path still wired but no client consumes it.

**8.7 — Geometry cache (Step 1 complete).** `buildGeomCache` extracts pan/zoom-invariant geometry in normalized coords into `canvas._geomCache`. Pure pan/zoom no longer triggers cache rebuild. Step 2+ (setTransform render, static cache removal) deferred — see PLAN.md.

---

## Capture Expansion: Slice 9 (9.1–9.12)

**Why this slice.** Pre-slice 9 we could measure moving time and combat time but menu friction was invisible — couldn't distinguish "30s in vendor" from "AFK." Talents/skills had never been snapshotted. XP attribution required polling diffs.

**9.1 — Probe pass #1.** 7 new function targets OK (GetNumTalentTabs, GetTalentTabInfo, GetNumTalents, GetTalentInfo, GetNumSkillLines, GetSkillLineInfo, ExpandSkillHeader). 19/20 new events register; `CONFIRM_BINDER_BIND` rejected on BC — use `HEARTHSTONE_BOUND`.

**9.2 — Friction events.** All SHOW/OPENED + CLOSED pairs + TAXIMAP_CLOSED registered. Rendered as 6px friction strip (vendor=teal, trainer=purple, mail=orange, bank=gold, ah=lime, loot=grey, cinematic=white, taxi=blue) with hover tooltips showing per-instance duration.

**9.3 — Sharper XP.** `PLAYER_XP_UPDATE` + `CHAT_MSG_COMBAT_XP_GAIN` registered. Polled XP still drives the chart; events give exact source tuples for future attribution.

**9.4/9.5 — Talents + skills snapshots.** `logSnapshot('talents')` iterates GetNumTalentTabs × GetNumTalents × GetTalentInfo (rank>0 only). `logSnapshot('skills')` calls ExpandSkillHeader(0) then GetNumSkillLines × GetSkillLineInfo (skips headers + unrankable). Both wired into the 60s loop. Rendering deferred.

**9.6 — Hearthstone.** `HEARTHSTONE_BOUND` registered; `CHAT_MSG_SYSTEM` as fallback.

**9.7/9.9 — Party state + BC API discovery.** BC Anniversary 2.5.5 ships *retail-era* group APIs. `GetNumPartyMembers`/`GetNumRaidMembers`/`UnitIsPartyLeader`/`GetLootMethod`/`PARTY_MEMBERS_CHANGED`/`PARTY_CONVERTED_TO_RAID` are all MISSING. OK: `IsInGroup`/`IsInRaid`, `GetNumGroupMembers`, `UnitIsGroupLeader`, `C_PartyInfo.GetLootMethod` (returns integer enum, not legacy string tuple), `GROUP_ROSTER_UPDATE`. Safe path: `IsInGroup`/`IsInRaid` + `UnitExists("party1..4")` iteration.

**9.8 — Target persistence.** `poll.tgt` TEXT JSON blob was captured by the addon but silently dropped by `ingest.mjs`; fixed. Query via `json_extract(tgt, '$.name')`.

**9.bugfix — World-view X-axis mirror.** `projX` for `__world__` was flipped; fixed to `(1 - norm(wx, ...))`.

**9.11 — Mini-strips.** Jump indicators (1px cyan, `falling` 0→1 transitions) and spell-cast ticks (1px purple, enriched server-side from spells table) added below the timeline. Hover listener moved to `host` element so mini-strips get tooltips.

**9.12 — Overhead map + world layout.** `atlas.json` + per-instance PNGs at 64px/tile (downsampled from 512px originals). `drawMapBackdrop` at 50% opacity under trajectory+grid. World view multi-continent layout data-driven from `atlas.json` `top` fields; adding continents is a data change, not a code change.

**9.10 — Friction viz + tooltips.** `computeFrictionSpans` pairs SHOW/OPENED with CLOSED; renders strip; full `__hoverables` registry for all timeline elements (deaths, kills, quest events, level-ups, friction spans, dead intervals). Highest-priority hit wins on overlap.

**Decided not to capture:** `UNIT_AURA` (too noisy), `UNIT_HEALTH` (10Hz poll sufficient), group/raid events (irrelevant for solo 1–58).

---
## Bundle/Release: Slice 10

**10 — Distribution / Bundling** Goal: Windows-friendly `dist/` folder + `.zip` — unzip, double-click, done. No Node install required.
This involved a lot of moving things around and rewriting stuff to be neater without really changing any functionality, it mostly works now!

## Component Rename: Forestry → Lumberjack / Sawmill / Ranger (commit 2d70447)

| Old | New | Role |
|---|---|---|
| `src/Forestry/` | `src/Lumberjack/` | In-game capture addon |
| `src/Lumberjack/` | `src/Sawmill/` | Node.js server pipeline |
| `src/Lexicon/` | `src/Ranger/` | Spell-name sidecar addon |

SavedVariables: `ForestryDB → LumberjackDB`, `ForestrySettings → LumberjackSettings`, `LexiconDB → RangerDB`. Slash command: `/forestry → /lumberjack` (+ `/lj`). API: `/api/lexicon → /api/ranger`. Project umbrella name "Forestry" preserved everywhere. `/forestrywipe` dropped (clean break). Archive captures and history snapshots left immutable.

The old `ForestryConsumed` marker was a registered SavedVariable — WoW would write the in-memory copy back on logout, clobbering whatever the server had appended. `LumberjackHighwaterMark` is a plain Lua global; WoW only persists registered SavedVariables, so the marker survives whatever the user does between ingest cycles.

---

## Geospatial Refactor (commits 5415243–3d28df6)

Extracted geospatial concerns to `src/Geographer/`: `geographer.mjs` (coordinate math), `generate_maps.mjs` (ImageMagick batch resampling), continent metadata JSON, 512px source PNGs. `GEOSPATIAL.md` at repo root (full axis-convention and georeferencing spec; the authoritative reference for projX/projY conventions and atlas format).

64px/tile working copies live in `src/Sawmill/www/map/` for the UI. 512px originals stay in `src/Geographer/` (large; excluded from dist bundle).

---

## SavedVariables Migration (Phase B)

One-shot script specified at `scripts/migrate_local_savedvars.mjs` to rename `ForestryDB → LumberjackDB` etc. in existing WTF SavedVariables files. Not shipped in bundle (user is the only current data producer). `--dry-run` and `--cleanup` modes. Verify the script exists at that path before running.

---

## Resolved Findings: Combat Log

- `LoggingCombat(true)` writes outside instances on BC Anniversary 2.5.5 — confirmed with 192KB open-world capture in Dun Morogh.
- File naming: `Logs/WoWCombatLog-MMDDYY_HHMMSS.txt` — one file per session/reload, NOT a single rotating log.
- Line format: `5/15/2026 13:56:02.036-7  EVENT,...` — full date with year and timezone offset; no inference needed.
- First line of every file: `COMBAT_LOG_VERSION,9,ADVANCED_LOG_ENABLED,0,BUILD_VERSION,2.5.5,PROJECT_ID,5` — useful for per-log build stamping.
- Account-wide file; CLEU rows linked to sessions by character name (region-suffix-stripped) + timestamp window.
- Windows writes CRLF. Must split on `/\r?\n/`.
