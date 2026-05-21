# Forestry — Dev Notes

Short-form gotchas and non-obvious invariants. These all cost real time to discover. See METHODOLOGY.md for the full rulebook and DEV_HISTORY.md for context on what was built.

---

## BC-specific API surprises

**`PLAYER_DEAD/ALIVE/UNGHOST` sequence is weird.**
`PLAYER_ALIVE` fires ~2s after `PLAYER_DEAD` as a ghost-state entry — it is NOT a revive signal. Real revive is `PLAYER_UNGHOST` (corpse run complete) or a delayed `PLAYER_ALIVE` (spirit healer rez, 8s+ after death). `computeDeadSpans` in `app.js` encodes this correctly — don't "fix" it back to "first ALIVE closes the span" without testing on a real death.

**`UnitPower` indices on BC are NOT (0=mana, 1=rage, 2=energy).**
Probe-verified order: `0=Mana, 1=Rage, 2=Focus (pet), 3=Energy, 4=Happiness (pet)`. Pre-fix code mapped `UnitPower(1)` to energy and `UnitPower(2)` to rage — both wrong. Current mapping: `mp=UnitPower(0)`, `rg=UnitPower(1)`, `en=UnitPower(3)`.

**`GetShapeshiftForm()` covers warrior stances, rogue stealth, priest shadowform — not just druid forms.**
The `form` column is the unified stance/form column for all classes. There is no separate stance column; don't add one. Druid: 1=bear, 3=cat, etc. Warrior: 1=battle, 2=def, 3=berserker. Rogue: 1=stealth. Priest: 1=shadowform. 0 = none.

**`UnitPosition("player")` returns world X/Y but Z is always 0 on BC Anniversary.**
Verified over 800+ samples in/out of Ironforge. Elevation is not exposed. Don't build anything assuming Z carries height data.

**`CONFIRM_BINDER_BIND` is rejected on BC; use `HEARTHSTONE_BOUND`.**

**`C_PartyInfo.GetLootMethod` returns an integer enum, not the legacy `(string, masterPartyID, masterRaidID)` tuple.**

---

## Server / ingest invariants

**Eastern Kingdoms uses `instanceId = 0` — do NOT treat it as "no world coords".**
EK is the most-played continent and legitimately carries `inst = 0` in every poll row. The authoritative "this row has world data" signal is the `PollRows.hasWorldAt[i]` bitmask (1 iff `wx` had a real recorded value, direct or forward-filled). An `inst === 0` check silently drops all EK trajectory data.

**`tgt` and `cast` poll fields are kept dense (not write-on-change) because Lua tables can't represent "explicit nil".**
Write-on-change can't emit a "target dropped" or "cast ended" transition — the field just disappears from the serialized table, indistinguishable from "unchanged." These columns must stay dense so the consumer can observe the nil transition.

**Combat log files on Windows use CRLF.** Always split on `/\r?\n/`. A bare `\n` split leaves `\r` on the last token of every line and silently misparses timestamps.

**`userver.mjs` strips `?query` and `#hash` before path resolution.** Without this, a request for `/poll_rows.js?v=2` 404s on disk and never matches the router. Both `serve_file` and `build_router` split on `[?#]` before joining onto `WEB_ROOT`.

---

## Frontend invariants

**`app.js` must load BEFORE `alpine.cdn.js`, with no `defer` on either.**
Alpine CDN queues `Alpine.start()` as a microtask between deferred scripts. An `alpine:init` listener registered in a deferred `app.js` fires too late and Alpine initializes without it. Pattern in `index.html`: `<script src="/app.js"></script><script defer src="alpine.cdn.js"></script>`.

**Never call expensive operations inside Alpine template expressions (`x-for`, `x-show`, etc.).**
These re-run on every reactive render (snapshot polls every 5s). If a method iterates thousands of rows, it melts the CPU on each poll tick. Pattern: pre-compute into reactive state on the triggering event (e.g. `selectZone`), store on `runPolls[runKey].viewFoo`, read the cached field in the template.

**Never call `buildTimeline()` (uPlot destroy + new) from a mouse-rate handler.**
This caused an infinite `setCursor → rebuild → setCursor` loop that pinned the CPU. The hover handler must call `redrawTrajectoryOnly()`, not `draw()`. The split between `draw()` (full rebuild) and `redrawTrajectoryOnly()` (cheap canvas-only pass) is load-bearing.

---

## Data model subtleties

**`x`/`y` (zone-relative, 0..1) vs `wx`/`wy` (world yards, signed) are different coordinate systems.**
`x`/`y` are the map-relative position within the current zone — they reset when you change zones and are only useful for per-zone trajectory. `wx`/`wy` are absolute world yards, good for cross-zone trajectory and the world view. Easy to conflate; they are independent poll columns.

**Resource columns (`mp`, `en`, `rg`) are all captured every poll, but only one is "live" per class/form.**
The vis hides series that are all-zero across a run. Druids switch on shift: cat=energy (`en`), bear=rage (`rg`), other=mana (`mp`). Warriors always rage. Rogues always energy. The `form` column is the signal for which resource is active.

**`form` and `cp` (combo points) are write-on-change.** A null `cp` row means "unchanged since last emission," not "zero combo points." Forward-fill per session before querying.

---

## Architecture principles

**Timestamp axis is load-bearing — never use raw `GetTime()`.**
`t` on all poll/events/snapshots rows is `GetTime() + EPOCH_OFFSET` where `EPOCH_OFFSET = time() - GetTime()` is computed once per session at init. `GetTime()` resets to 0 every client launch; raw GetTime breaks cross-session merging and CLEU joins. The five tables (sessions/poll/events/snapshots/cleu) share one wall-clock axis because of this. Don't regress.

**Schema widening is processing, not capture.**
The Lumberjack addon captures fields → SavedVariables → `archive/` (raw .lua). Sawmill's SQLite schema is one rendering of that archive for query convenience; `ensureColumn` widens it lazily as new fields appear. The archive is the floor — even if every other layer fails, the raw evidence is on disk. Don't design the addon around what the schema can query; design it around what would be useful to have captured.

**`forestry.db` is safely wipeable.**
The archive is ground truth. Wiping the DB and re-ingesting from `archive/` is a supported workflow. `ensureColumn` makes forward migrations harmless, so the DB doesn't need explicit migration scripts.

---

## Diagnostic commands

```
node src/Sawmill/inspect.mjs coverage       # registered-vs-captured matrix
node src/Sawmill/inspect.mjs poll-sparsity  # write-on-change health (high NULL% = good)
node src/Sawmill/inspect.mjs world          # per-zone world-coord bboxes (verify UnitPosition wiring)
node src/Sawmill/inspect.mjs schema         # live column list
node src/Sawmill/inspect.mjs sql "SELECT …" # ad-hoc SELECT-only queries
node src/Sawmill/server.mjs --probe         # refresh docs/APIReport.md from last ProbeDB
```
