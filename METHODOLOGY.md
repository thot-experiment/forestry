# Forestry Project Methodology

> **Naming:** Forestry is the project umbrella. The in-game capture addon is named **Lumberjack** (chops down trees), the server-side pipeline is **Sawmill** (processes raw lumber into finished output), and the spell-name sidecar addon is **Ranger** (identifies spells on sight). Probe is the dev-only API verifier.

This document is the rulebook. Read it before contributing — human or agent. The dev practices here intentionally diverge from typical software work because the target (WoW BC Anniversary client) is **brittle, undocumented, and inconsistently named**. Following normal habits will burn hours.

> *Slow is smooth, smooth is fast.*

---

## 1. Why this project is different

The WoW addon API is technically Lua, but in practice it is whatever a specific client build of a specific game flavor happens to expose. There is **no official, machine-readable, build-specific API reference** for what we are targeting. Public docs are a patchwork of community efforts pinned to whichever flavor the maintainer cares about. Three concrete consequences:

1. A function present in retail, vanilla Classic, *and* Wrath Classic may still be missing in BC Anniversary. Or present with a different signature. Or present but always returning `nil`.
2. Folder/version naming is misleading — for example, the install path `_anniversary_` could be vanilla Anniversary *or* BC Anniversary depending on the install. There is no reliable static check; the only way to know is `GetBuildInfo()` at runtime.
3. Static documentation **goes stale silently** when Blizzard hotfixes the client. There is no changelog you can subscribe to.

The implication: **the running client is the only authoritative source of truth.** Everything else is a hint.

---

## 2. The development loop

Every change that depends on a Blizzard API follows this loop. No shortcuts.

```
discover → probe → verify → integrate
```

- **Discover** — find a candidate API. Sources: `/probe api <name>` in-game, grep the static refs in `docs/`, search community wikis, ask another agent. None of these are trusted yet.
- **Probe** — add the symbol (with expected signature) to `src/Probe/Targets.lua`. Reload Probe in-game. Confirm it exists, returns the shape we expect, and behaves on representative inputs.
- **Verify** — run `node src/Sawmill/server.mjs --probe` to ingest `ProbeDB`, regenerate `docs/APIReport.md`, and append a build-stamped snapshot to `docs/history/`. The report is the durable evidence that this API works on this build.
- **Integrate** — only now add the call to the Lumberjack addon, guarded per §4.

If a step fails, you stop and resolve at that step. Do not "fix it in Lumberjack later." The Lumberjack addon's contract with reality is that every Blizzard call in it has been verified.

---

## 3. The Probe addon

`src/Probe/` is a sibling addon to `src/Lumberjack/`. It is **dev-only** — never enabled during a real speedrun. Deploy it with `update_dev.bat` (which calls `update_addon.mjs --dev`).

What Probe does:

- At `PLAYER_LOGIN`, dumps `GetBuildInfo()`, `WOW_PROJECT_ID`, locale, and the addon's understanding of itself.
- Reads `src/Probe/Targets.lua` and for each entry:
  - **Function targets**: checks existence, `pcall`s with sentinel args, records actual return arity and types, diffs vs the entry's `expect`.
  - **Event targets**: registers a listener and records the actual `argv` shape on first emission. Combat-gated events record on whatever the first natural firing is.
- Writes results to `ProbeDB` SavedVariables for Sawmill to ingest.

What Probe also does — slash introspection (the part that makes the loop bearable):

| Command | Purpose |
|---|---|
| `/probe api <name>` | Existence + arity check for any global, including dotted namespaces (`C_Container.GetContainerNumSlots`). |
| `/probe call <name> <args...>` | `pcall`s the function live, prints all returns. |
| `/probe event <NAME>` | One-shot listener; prints next firing's argv. |
| `/probe watch <NAME>` | Persistent listener; accumulates argv to chat until `/probe unwatch <NAME>`. |
| `/probe eval <lua>` | Sandboxed `loadstring`, pretty-printed result. Use sparingly. |
| `/probe dump <expr>` | Recursive serializer with depth cap. |

All commands are `pcall`-wrapped and degrade safely. **`/probe` is the cheap way to discover. `Targets.lua` is the durable record.**

---

## 4. Guarding rules

We expect Blizzard calls to fail. Every external call follows one of these patterns. Copy them; don't improvise.

### 4a. Existence check before use
```lua
if type(C_Map) == "table" and type(C_Map.GetBestMapForUnit) == "function" then
    mapID = C_Map.GetBestMapForUnit("player")
end
```

### 4b. pcall with default
```lua
local ok, value = pcall(GetXPExhaustion)
local rested = (ok and value) or 0
```

### 4c. Nil-safe table walk
```lua
local p = C_Map and C_Map.GetPlayerMapPosition and C_Map.GetPlayerMapPosition(mapID, "player")
local x, y = p and p.x or 0, p and p.y or 0
```

### 4d. Multi-return pcall
```lua
local ok, a, b, c, lat = pcall(GetNetStats)
if not ok then a, b, c, lat = 0, 0, 0, 0 end
```

### 4e. Event handler: pcall the body
```lua
eventFrame:SetScript("OnEvent", function(self, event, ...)
    local ok, err = pcall(handle, event, ...)
    if not ok then LumberjackDB.errors[#LumberjackDB.errors+1] = { event = event, err = err, t = time() } end
end)
```

The cost of guarding is a few keystrokes. The cost of an unhandled `nil` call is a Lua taint that breaks the entire event frame for the rest of the session.

---

## 5. Build stamping

Every artifact carries `GetBuildInfo()`. Specifically:

- Each `sessions` row gets `client_version`, `client_build`, `client_tocversion`.
- Each Probe run gets the same in `ProbeDB.meta`.
- `docs/history/APIReport-<build>-<timestamp>.md` is named by build so we can diff across hotfixes.
- The Lumberjack addon's `Lumberjack.toc` declares its `## Interface:` value, but this is *not* trusted as a runtime fact — it tells the client "I claim to be compatible," not "this is what the client is."

When something breaks unexpectedly, the first question is always: *did the build change?*

---

## 6. Static refs are hints, not authority

`docs/` currently holds only the auto-generated `APIReport.md` and its `history/` snapshots. We deliberately do not vendor wrong-flavor reference dumps (`wow-ui-source`, `BlizzardInterfaceResources`, etc.) — their existence in the repo invites misuse, and Probe has been sufficient ground truth.

If a future contributor adds a hint source, it must be (a) clearly labeled with its flavor and build, (b) confined to its own subdirectory, and (c) treated as "what *might* exist" — never as authority. The answer to "does it exist for us?" is always `/probe api <name>`.

---

## 7. Blizzard naming glossary (gotchas)

| Term | What it actually is | Pitfall |
|---|---|---|
| `_classic_era_` | Vanilla 1.x re-release | Sometimes confused with Anniversary |
| `_anniversary_` | Either vanilla Anniversary *or* BC Anniversary depending on install | Folder name is **not** a flavor identifier |
| `_classic_` | Currently the most recent Classic progression flavor (changes over time) | Do not rely on this name being stable |
| `WOW_PROJECT_ID` | Numeric flavor ID at runtime | Authoritative; check this not the path |
| `GetBuildInfo()` | Returns `version, build, date, tocversion` | Authoritative; stamp every artifact with this |
| `## Interface:` (TOC) | What the addon claims to be compatible with | If wrong, the client may refuse to load the addon as enabled |
| `SavedVariables` | Account-wide persisted Lua table | Flushed only on logout / `/reload` — not periodically |
| `SavedVariablesPerCharacter` | Per-character version of the above | Same flush rules |
| `LoggingCombat(true)` | Toggles native combat log to file | Writes to `Logs/WoWCombatLog.txt`; survives crashes |
| `InCombatLockdown()` | Whether secure-action restrictions apply | **Not** "is the player in combat" — for that, use `UnitAffectingCombat("player")` |
| `GetTime()` | Seconds since client launch (float) | Resets on every client launch — not a stable timestamp |
| `time()` | Unix epoch seconds | Use this for cross-session timestamps |
| Group APIs | BC Anniversary 2.5.5 ships **retail-era** group functions/events, not the classic ones | `GetNumPartyMembers`/`GetNumRaidMembers`/`UnitIsPartyLeader`/`GetLootMethod`/`PARTY_MEMBERS_CHANGED` are all **MISSING**. Use `GetNumGroupMembers`/`UnitIsGroupLeader`/`C_PartyInfo.GetLootMethod`/`GROUP_ROSTER_UPDATE`. `IsInGroup`/`IsInRaid` exist. Probe everything; do NOT assume "BC = classic API names." |

---

## 8. How to add a new Blizzard call (walkthrough)

You want the Lumberjack addon to capture rested XP. You think the call might be `GetXPExhaustion()`.

1. **Discover.** In-game, type `/probe api GetXPExhaustion`. Probe prints `function` and arity. Good sign. You have a candidate.
2. **Add to Targets.** Edit `src/Probe/Targets.lua`:
   ```lua
   { name = "GetXPExhaustion", argv = {}, expect = "number?", site = "Lumberjack/logPoll/rested",
     notes = "rested XP pool, may be nil if no rested" },
   ```
3. **Reload.** `/reload` in-game (or `update_dev.bat` then log out / back in if you also changed Lua).
4. **Probe.** Probe runs at login, records existence + return shape. `/probe call GetXPExhaustion` to see the actual value for your character.
5. **Verify.** Outside the game, run `node src/Sawmill/server.mjs --probe`. It updates `docs/APIReport.md` and appends a snapshot to `docs/history/`. Confirm the entry is `OK`.
6. **Integrate.** Only now, add the call to `src/Lumberjack/Lumberjack.lua`, guarded per §4:
   ```lua
   local ok, rested = pcall(GetXPExhaustion)
   data.rest = (ok and rested) or 0
   ```
7. **Run extract_calls.** `node src/Sawmill/extract_calls.mjs` confirms the Lumberjack addon's call is present in Targets. Coverage maintained.

This loop takes ~5 minutes once you're set up. Skipping it costs hours.

---

## 9. SavedVariables and memory

### Flush rules
- SavedVariables only flush on **logout** or **`/reload`**. A crash mid-session loses everything since the last flush. Periodic `/reload` is mandatory for long sessions.
- The file is just a Lua chunk — assignments execute top to bottom, so the **last** assignment wins.

### SavedVariables loading order — critical, BC Anniversary specific gotcha
- Standard WoW addon docs say SavedVariables are loaded into globals **before** the addon's Lua executes. **On BC Anniversary 2.5.5 this is observably wrong** — disk-loaded values land on top of the global *after* file scope runs, silently overwriting anything you assigned at file-scope time.
- Symptom: you `table.insert` a session entry into `LumberjackDB.sessions` at file scope, the print at insert time confirms `#LumberjackDB.sessions == 1`, but a slash command run a few seconds later sees `#LumberjackDB.sessions == 0`. The new entry was wiped by the disk overwrite.
- **Rule**: do *all* SavedVariables-touching init in an `ADDON_LOADED` handler, never at file scope. By the time `ADDON_LOADED` fires (with `addonName == "Lumberjack"`), the disk overwrite has happened and the globals are stable.
- Code at file scope can still create frames, register events, and define functions — but every function that reads/writes a SavedVariable must guard against the variable not being initialized yet (loggers in the Lumberjack addon bail early if `currentSessionID` is nil).

### The highwater-mark protocol (how `LumberjackDB` is wiped)

Sawmill writes a single global, `LumberjackHighwaterMark = <epoch>`, into the SavedVariables file after a confirmed ingest. The addon reads it on next `PLAYER_LOGIN` and trims every poll/events/snapshots row with `t <= mark`. Sessions are never trimmed.

```
session N
   |  /reload or logout
   v
WoW writes Lumberjack.lua  (LumberjackDB + LumberjackSettings; NO marker, see "Why not a SV" below)
   |  fs.watch fires; debounced 1.5s
   v
Sawmill:
   1. copy Lumberjack.lua → Lumberjack.ingest.lua  (same folder, intra-drive copy)
    2. spawn lua_to_json.lua on the COPY → JSON snapshot

   3. highwater = max(t) across poll/events/snapshots
   4. append `LumberjackHighwaterMark = <highwater>` to ORIGINAL  ◀── race window closes
   5. rename copy → archive/<ts>_Lumberjack.lua  (intra-drive rename, O(1))
   6. insert into SQLite in one transaction; per-session dedup drops rows with t <= db_max
   v
session N+1 starts
   |  PLAYER_LOGIN
   v
addon trims poll/events/snapshots by t <= LumberjackHighwaterMark
   |  sets LumberjackHighwaterMark = nil  (tidiness only — see "Why not a SV")
   v
play continues
```

Sessions are **never** trimmed. They're small and useful for cross-session joins. Sawmill ingests them with `INSERT OR IGNORE` so re-ingesting is harmless.

### Why `LumberjackHighwaterMark` is NOT a SavedVariable

`ForestryConsumed` (an old marker, predating both the rename and the highwater protocol) was registered in the .toc. That meant WoW would write the in-memory copy back to disk on logout, **clobbering** whatever the server had appended if the user logged back in before the ingest finished. Result: marker lost, no trim, unbounded growth.

`LumberjackHighwaterMark` is a plain Lua global. WoW still executes it on load (the SV file is just Lua), so the addon sees it — but WoW only persists registered SavedVariables on logout, so the marker can't be clobbered by a stale in-memory copy. The marker survives whatever the user does between cycles.

### Race-shrinking via copy-then-mark

Even with the SV trick, if Sawmill writes the marker *after* the user has already logged back in, the addon misses it for that cycle. The copy-then-probe-then-mark ordering minimizes that window: copy and probe take well under a second (10k rows), so by the time the slow archive + insert work runs, the marker is already on disk. If the marker still gets missed, the next cycle self-heals — `max(t)` is absolute, idempotent, and per-session dedup at insert time stops duplicate rows from landing in SQLite.

### What this guarantees

- Sawmill down → no marker → addon doesn't trim → data accumulates safely until ingest catches up.
- Sawmill crashes mid-ingest → no marker appended → next session sees no marker → no trim → next ingest re-derives the highwater and the per-session dedup filter drops the rows already in SQLite.
- WoW writes file while Sawmill is mid-append → mtime debounce (1.5s stable window) prevents this in practice; if it happened, the copy is already in-hand and unaffected.
- Sawmill always lands the source `.lua` in `archive/` (via rename of the in-folder copy) before declaring success. **The archive is the floor** — even if every other layer fails, the raw evidence is on disk.

### Per-session dedup at insert time

`ingestLumberjackData` opens a transaction, caches `SELECT MAX(timestamp) FROM <table> WHERE session_id = ?` per (table, session), and skips any incoming row with `t <= cached_max`. This is the safety net for the case where the marker was missed for one cycle: the file still contains rows already in SQLite, but the dedup filter drops them. The `counts.dupes` field on the ingest result is the signal that a race happened.

### Anti-loop

Sawmill's own marker append changes the file mtime, which would re-trigger the watch. Sawmill persists `lastIngestedMtime` per file in `src/Sawmill/.state.json`; if a watch event arrives with `mtime <= lastIngestedMtime`, it's ignored.

### Cache pressure thresholds (HUD bands)
- Green <5MB, yellow 5–20MB, red >20MB, hard floor 40MB.
- Above ~50MB the client load time spikes; above ~200MB the saved vars may fail to load entirely.
- Cache pressure is measured against **`LumberjackDB`** (per-character). The marker file is too small to ever matter.

### Write-on-change for poll rows
Poll runs at 10Hz and many fields don't change tick-to-tick. To keep cache pressure low, the Lumberjack addon tracks a `lastPollState` cache and only emits a stable field into a poll row when its value differs from the last emission. Conceptually, all poll fields *could* be write-on-change — the split is purely a storage-vs-parse-convenience trade. Fields stay dense only when they change most ticks anyway (so the cache check would be wasted) or when they have a representational issue (see `cast` below).

**Dense** (every poll row carries these):
- `sid`, `t` — row identity, non-negotiable. `t` is epoch-aligned (see "Timestamp axis" below).
- `fps`, `lat`, `mem` — per-tick perf signal; these fluctuate every tick anyway, so write-on-change would re-emit on every row — pure cache-compare overhead with no storage win.
- `tgt` — `{guid, name, level, class, classification, health, maxHealth}` when player has a target, naturally nil otherwise (Lua omits nil-keyed fields on serialize). Persisted as `poll.tgt TEXT` JSON blob; query via `json_extract(tgt, '$.name')`. **Kept dense because Lua tables can't represent "explicit nil"** — write-on-change can't emit a "target dropped" transition. Pre-2026-05-17 the addon captured this but `ingest.mjs` was silently dropping it.
- `cast`, `cast_id` — naturally nil when not casting; same "stopped" transition problem as `tgt`. `UNIT_SPELLCAST_SUCCEEDED` is the discrete companion signal.

**Write-on-change** (NULL means "unchanged since last emission"; consumer forward-fills per session):
- `x`, `y` — normalized map-relative position (0..1 inside current zone). Re-emit when moving; skipped when stationary.
- `wx`, `wy`, `wz`, `inst` — world coords + instance ID from `UnitPosition("player")`. X/Y in world yards (signed), Z stuck at 0 on BC Anniversary (verified across 800+ samples in/out of Ironforge — elevation is not exposed). Independent of map; enables cross-zone trajectory without an atlas. Nil-guarded in the addon (pcall may fail transiently); a nil read leaves forward-fill on the last good value.
- `hp`, `mp`, `en`, `rg` — change every tick during combat / regen; stable at cap out of combat. `mp = UnitPower(0)`, `rg = UnitPower(1)`, `en = UnitPower(3)`. **BC `UnitPower` indices are NOT (mana/rage/energy) in 0/1/2 order** — they're `0=Mana, 1=Rage, 2=Focus(pet), 3=Energy, 4=Happiness(pet)`. Pre-2026-05-16 code mapped 1→en and 2→rg; both wrong.
- `mid`, `z`, `sz` — zone trio, change on zone transitions
- `lvl`, `mxp`, `xp` — level + XP cap + current XP (XP is flat between gains)
- `rest`, `bags`, `gold` — slow-changing counters
- `mnt`, `stealth`, `combat` — booleans; transitions are infrequent at the macro level
- `form` — shapeshift form OR stance (unified via `GetShapeshiftForm()`; druid 1=bear/3=cat/etc., warrior 1=battle/2=def/3=zerk, rogue 1=stealth, priest 1=shadowform, 0 otherwise). One column covers both concepts.
- `cp` — combo points on target (rogue/cat-druid). 0..5, mostly idle outside combat → write-on-change wins.
- `falling` — `IsFalling()` as 0/1; 0→1 transition counts as a jump (or cliff fall — same physics).

All write-on-change values are guaranteed non-nil scalars (numbers/booleans/strings) so `lastPollState[k] ~= v` handles transitions in both directions correctly. The keep-list for forward-fill on the consumer side lives in `STABLE_POLL_COLS` (duplicated in `inspect.mjs` and `routes.mjs`).

### Timestamp axis (load-bearing)
`t` on poll/events/snapshots rows is `GetTime() + EPOCH_OFFSET` where `EPOCH_OFFSET = time() - GetTime()` is computed once per session in `initSession()`. This gives sub-second precision aligned to epoch — the same axis as `sessions.startTime` and CLEU lines. Cross-session merging, CLEU↔poll joins, and the playtime axis in the timeline all depend on this. **Never regress to raw `GetTime()`** — its zero point is the client launch and resets every relog.

`lastPollState` is reset at the start of every session so the first poll row of a fresh session always carries the full state. Across `/reload`, the addon reloads, the cache resets, and the first post-reload poll re-emits everything.

Sawmill ingest passes missing values as SQL `NULL`. Analysis code forward-fills per-session — `node src/Sawmill/inspect.mjs poll-ff` is the canonical example. `poll-sparsity` reports what % of rows have NULL per stable column (sanity check that write-on-change is paying off).
- Cache pressure thresholds (HUD bands): green <5MB, yellow 5–20MB, red >20MB, hard floor 40MB. Above ~50MB the client load time spikes; above ~200MB the saved vars may fail to load entirely.

---

## 10. Debugging FAQ

**Q: My addon loaded but nothing happens.**
A: Check the SavedVariables file exists: `WTF/Account/<account>/SavedVariables/<Addon>.lua` (account-wide) or `WTF/Account/<account>/<realm>/<character>/SavedVariables/<Addon>.lua` (per-character). It is created on first logout, not first login.

**Q: I added an event but the handler never fires.**
A: Three checks. (1) `frame:RegisterEvent("EXACT_NAME")` — case matters and it's underscore_separated. (2) Confirm the event exists for our flavor: `/probe event THE_NAME` then trigger it manually. (3) Confirm your `OnEvent` script is still attached — a later `SetScript` may have clobbered it.

**Q: Lua error: "attempt to call a nil value (global 'X')".**
A: X does not exist in this build. Stop, run `/probe api X`, find the actual name (try wow.gamepedia search, but verify with probe).

**Q: `/reload` and my data is gone.**
A: Did `PLAYER_LOGIN` fire and auto-wipe? `/reload` triggers the full login sequence including `PLAYER_LOGIN`. If you want to preserve data across a `/reload`, you must `sawmill --probe`-ingest before reloading, or temporarily disable the wipe.

**Q: Sawmill inserted the same row N times.**
A: Should not happen — the highwater protocol (§9) plus per-session dedup at insert time prevents it. If you see duplicates in SQLite, either (a) the dedup filter was bypassed (check `ingestLumberjackData` still queries `MAX(timestamp)` per session), (b) two sessions ended up with the same `session_id` (the id includes `time()` + player name; collision would require two same-second logins on the same character), or (c) the mtime guard in `Sawmill/.state.json` got cleared *and* the dedup filter was also bypassed. The `counts.dupes` field in the ingest log line tells you how many incoming rows were filtered as dupes — a non-zero value is a sign the marker raced and self-healed.

**Q: How do I know which BC Anniversary build I'm on?**
A: In-game: `/run print(GetBuildInfo())`. Or just look at any session row in `forestry.db`.

**Q: I want to test something that only happens in combat.**
A: `/probe watch <EVENT_NAME>`, then engage a mob. The watcher accumulates events to chat with their argv. Or use `/probe call` for combat-flagged functions while in combat (they may behave differently than out).

---

## 11. Conventions for new code

- All Blizzard calls go through one of the patterns in §4. No bare external calls.
- Every new call has a Targets entry with `site = "<file>/<function>/<purpose>"` so we can grep back from the manifest to the consumer.
- The Lumberjack addon never assumes a Blizzard return is non-nil. Default to a sentinel (0, false, ""), let the analysis layer decide later.
- Comments in the Lumberjack addon are sparse. The Targets manifest carries the *why* (notes field). The addon carries the *what*.
- No new addon directories without a `## Interface:` and a comment in the .toc explaining the flavor target.

---

## 12. Documentation maintenance

`PLAN.md` is forward-looking only. `DEV_HISTORY.md` is the backward-looking record. When a release plan's major phases are complete, compact the completed phases into `DEV_HISTORY.md`, remove them from `PLAN.md`, and delete the release plan file — don't leave it lingering as a stale mirror. A good trigger: when the "open items" section of a release plan is either empty or contains only future work. Future-work items should be promoted into `PLAN.md`'s roadmap before the release plan file is deleted.
