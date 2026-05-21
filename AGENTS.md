# AGENTS.md

You are working on Forestry, a WoW BC Anniversary speedrun data capture project. The target is brittle and the conventions are non-standard. **Do not default to general dev habits.**

## Read first, in this order

1. **`METHODOLOGY.md`** — the rulebook. Non-negotiable.
2. **`PLAN.md`** — the project's roadmap and architecture.
3. **`docs/APIReport.md`** — the latest verified API surface for the current client build. The only source of truth for "does this Blizzard call work."

If you skip these and start writing code, you will produce broken Lua that crashes the addon. There is no shortcut.

## Project rules at a glance

- **Never add a Blizzard API call without first verifying it via Probe.** See METHODOLOGY §2 and §8.
- **No static reference dumps in this repo by policy.** Probe is authority. Don't pull `wow-ui-source` or `BlizzardInterfaceResources` back in without explicit user agreement.
- **Every external call is guarded** with one of the patterns in METHODOLOGY §4. No bare calls.
- **Probe is dev-only.** Never enable Probe during a real speedrun. Lumberjack stays clean of probe code.
- **Build-stamp every artifact** with `GetBuildInfo()`. See METHODOLOGY §5.
- **`_anniversary_` in the install path is not a flavor.** Trust `GetBuildInfo()` and `WOW_PROJECT_ID`, never the folder name.

## Don't

- Don't trust function names you remember from training data — verify each one with `/probe api <name>` and an entry in `src/Probe/Targets.lua`.
- Don't refactor Lumberjack "while you're in there." Make the smallest change that satisfies the task; the brittleness rewards minimal diffs.
- Don't add comments explaining what code does. Comments explain *why* (in `Targets.lua` notes, mostly), not *what*.
- Don't pull new static reference dumps without explicit user agreement. We chose probe over docs deliberately.
- Don't assume any retail-style API works. BC Anniversary is its own thing.

## Where things live

The project name is **Forestry** (the umbrella). Components are themed after the wood-cutting workflow:

- `src/Lumberjack/` — the speedrun capture addon (chops down trees: raw data → SavedVariables). Production-shape, every call verified.
- `src/Ranger/` — sidecar addon that identifies spells on sight (combat log → spell ID/name map). Account-wide.
- `src/Probe/` — dev-only sibling addon for runtime API verification and live introspection.
- `src/Sawmill/` — Node.js ingestion pipeline (processes raw captures into the SQLite DB and serves the preview UI); `node:sqlite`, no external deps.
- `src/Sawmill/www` — frontend for exploring the data, served by the Sawmill server on :3333 by default
- `src/Geographer/` — Node.js toolkit for GIS operations on WoW map data, used to build map background images
- `docs/` — static reference hints + auto-generated API reports.
- `archive/` (under src/Sawmill) — raw SavedVariables and combat log copies. Sacred. Don't delete.

## When something feels wrong

If a documented API doesn't work, an event doesn't fire, or a return shape mismatches the static refs — that is the *expected* failure mode of this project, not a surprise. Follow the loop in METHODOLOGY §2: discover → probe → verify → integrate. Do not patch around it in Lumberjack.
