// Sawmill/inspect.mjs
// Spot-check tool for forestry.db. Console-only; pick a subcommand.
//
// Usage:
//   node Sawmill/inspect.mjs               # default: summary (counts + sessions)
//   node Sawmill/inspect.mjs counts        # row counts per table
//   node Sawmill/inspect.mjs sessions      # all session rows
//   node Sawmill/inspect.mjs poll [N]          # last N poll rows (default 5; raw, may have NULLs)
//   node Sawmill/inspect.mjs poll-ff [N]       # last N rows of latest session, forward-filled
//   node Sawmill/inspect.mjs poll-range        # time range per session
//   node Sawmill/inspect.mjs poll-sparsity     # NULL % per stable column for latest session (write-on-change health check)
//   node Sawmill/inspect.mjs world             # per-zone world-coord range from UnitPosition (latest session) — verifies IF/outside split
//   node Sawmill/inspect.mjs events [N]    # last N events
//   node Sawmill/inspect.mjs events-by-type
//   node Sawmill/inspect.mjs snapshots [N]
//   node Sawmill/inspect.mjs coverage      # what we register vs what we've captured (events / poll fields / snapshots / CLEU)
//   node Sawmill/inspect.mjs dupes         # duplicate poll (timestamp, session_id) check
//   node Sawmill/inspect.mjs orphans       # poll/event session_ids not in sessions table
//   node Sawmill/inspect.mjs schema        # PRAGMA table_info for each table
//   node Sawmill/inspect.mjs sql "<query>" # arbitrary SELECT
//
// All output goes to stdout, one row per line as JSON or aligned columns.

import sqlite from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'forestry.db');
const db = new sqlite.DatabaseSync(dbPath);

const TABLES = ['sessions', 'poll', 'events', 'snapshots', 'cleu'];

const sub = process.argv[2] || 'summary';
const arg1 = process.argv[3];

function counts() {
    for (const t of TABLES) {
        const c = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get();
        console.log(`${t.padEnd(12)} ${c.n}`);
    }
}

function sessions() {
    const rows = db.prepare('SELECT * FROM sessions ORDER BY start_time').all();
    if (rows.length === 0) { console.log('(no sessions)'); return; }
    for (const r of rows) console.log(JSON.stringify(r));
}

function poll(n) {
    n = parseInt(n) || 5;
    const rows = db.prepare(`SELECT timestamp, session_id, lvl, hp, mp, en, rg, fps, lat, gold, zone, combat
                              FROM poll ORDER BY timestamp DESC LIMIT ?`).all(n);
    for (const r of rows.reverse()) console.log(JSON.stringify(r));
    console.log(`(${rows.length} rows; total in table: ${db.prepare('SELECT COUNT(*) n FROM poll').get().n})`);
}

// Stable fields use write-on-change in Lumberjack; SQLite columns can be NULL when unchanged.
// Forward-fill carries the last known value forward per session.
const STABLE_POLL_COLS = [
    'x', 'y', 'wx', 'wy', 'wz', 'inst',
    'hp', 'mp', 'en', 'rg',
    'mid', 'zone', 'sz',
    'lvl', 'max_xp', 'curr_xp', 'rest',
    'bags', 'gold',
    'mnt', 'stealth', 'combat',
    'form', 'form_spell', 'cp', 'falling',
];

function pollFF(n) {
    n = parseInt(n) || 10;
    const lastSession = db.prepare('SELECT session_id FROM poll ORDER BY timestamp DESC LIMIT 1').get();
    if (!lastSession) { console.log('(no poll rows)'); return; }
    const sid = lastSession.session_id;
    const rows = db.prepare(`SELECT timestamp, x, y, mid, zone, sz, lvl, hp, mp, en, rg, combat, bags, gold,
                                     mnt, stealth, rest, cast, cast_id, fps, lat, curr_xp, max_xp
                              FROM poll WHERE session_id = ? ORDER BY timestamp`).all(sid);
    const last = {};
    for (const r of rows) {
        for (const f of STABLE_POLL_COLS) {
            if (r[f] === null && last[f] !== undefined) r[f] = last[f];
            else if (r[f] !== null) last[f] = r[f];
        }
    }
    console.log(`session: ${sid}, ${rows.length} rows total, showing last ${Math.min(n, rows.length)} (forward-filled)`);
    for (const r of rows.slice(-n)) console.log(JSON.stringify(r));
}

function pollSparsity() {
    // For the most recent session, what fraction of stable fields are NULL (i.e., write-on-change is paying off)?
    const lastSession = db.prepare('SELECT session_id FROM poll ORDER BY timestamp DESC LIMIT 1').get();
    if (!lastSession) { console.log('(no poll rows)'); return; }
    const sid = lastSession.session_id;
    const total = db.prepare('SELECT COUNT(*) n FROM poll WHERE session_id = ?').get(sid).n;
    if (total === 0) { console.log('(no rows in last session)'); return; }
    console.log(`session: ${sid}  total rows: ${total}`);
    console.log(`field          NULLs    %sparse`);
    for (const f of STABLE_POLL_COLS) {
        const nulls = db.prepare(`SELECT COUNT(*) n FROM poll WHERE session_id = ? AND ${f} IS NULL`).get(sid).n;
        const pct = (100 * nulls / total).toFixed(1);
        console.log(`  ${f.padEnd(12)} ${String(nulls).padStart(6)}  ${pct.padStart(6)}%`);
    }
}

// Per-zone world-coord stats for the latest session — bbox + sample of (wx, wy, wz).
// Use this to verify UnitPosition wiring: e.g. running in/out of Ironforge should show
// distinct (inst, wx, wy) ranges between IF and Dun Morogh.
function world() {
    const lastSession = db.prepare('SELECT session_id FROM poll WHERE wx IS NOT NULL ORDER BY timestamp DESC LIMIT 1').get();
    if (!lastSession) {
        console.log('(no poll rows have world coords yet — log in with the updated Lumberjack addon and play a bit)');
        return;
    }
    const sid = lastSession.session_id;
    // zone is write-on-change; raw rows have NULL between transitions. Forward-fill in JS before grouping.
    const rows = db.prepare(`
        SELECT timestamp, zone, sz, inst, wx, wy, wz
        FROM poll WHERE session_id = ? AND wx IS NOT NULL ORDER BY timestamp
    `).all(sid);
    let lastZone = null, lastSz = null;
    const agg = new Map();
    for (const r of rows) {
        if (r.zone != null) lastZone = r.zone;
        if (r.sz != null) lastSz = r.sz;
        const key = `${lastZone || '?'}|${r.inst}`;
        let a = agg.get(key);
        if (!a) {
            a = { zone: lastZone, inst: r.inst, n: 0,
                wx_min: r.wx, wx_max: r.wx, wy_min: r.wy, wy_max: r.wy, wz_min: r.wz, wz_max: r.wz,
                t_min: r.timestamp, subzones: new Set() };
            agg.set(key, a);
        }
        a.n++;
        if (r.wx < a.wx_min) a.wx_min = r.wx; if (r.wx > a.wx_max) a.wx_max = r.wx;
        if (r.wy < a.wy_min) a.wy_min = r.wy; if (r.wy > a.wy_max) a.wy_max = r.wy;
        if (r.wz < a.wz_min) a.wz_min = r.wz; if (r.wz > a.wz_max) a.wz_max = r.wz;
        if (lastSz) a.subzones.add(lastSz);
    }
    const ordered = [...agg.values()].sort((a, b) => a.t_min - b.t_min);
    console.log(`session: ${sid}  (${rows.length} poll rows with world coords)`);
    console.log('zone'.padEnd(28) + 'inst'.padStart(5) + 'rows'.padStart(7)
        + '   wx range'.padEnd(28) + '   wy range'.padEnd(28) + '   wz range');
    for (const r of ordered) {
        const wxR = `${r.wx_min.toFixed(0)} .. ${r.wx_max.toFixed(0)}`;
        const wyR = `${r.wy_min.toFixed(0)} .. ${r.wy_max.toFixed(0)}`;
        const wzR = `${r.wz_min.toFixed(1)} .. ${r.wz_max.toFixed(1)}`;
        console.log(`${(r.zone || '?').padEnd(28)}${String(r.inst).padStart(5)}${String(r.n).padStart(7)}   ${wxR.padEnd(25)}   ${wyR.padEnd(25)}   ${wzR}`);
        if (r.subzones.size) console.log(`  subzones: ${[...r.subzones].join(', ')}`);
    }
    // Z-elevation sanity: if all wz are 0 across all zones the API may not return elevation on BC.
    const distinctZ = db.prepare(`SELECT COUNT(DISTINCT ROUND(wz, 1)) n FROM poll WHERE session_id = ? AND wz IS NOT NULL`).get(sid).n;
    console.log(`\ndistinct wz values across session: ${distinctZ}  ${distinctZ <= 1 ? '(BC UnitPosition appears to NOT return elevation — Z stuck at 0)' : '(Z elevation appears to work)'}`);
}

function pollRange() {
    const rows = db.prepare(`SELECT session_id, MIN(timestamp) as t_min, MAX(timestamp) as t_max,
                                    COUNT(*) as n
                             FROM poll GROUP BY session_id ORDER BY t_min`).all();
    for (const r of rows) {
        const dur = r.t_max - r.t_min;
        console.log(`${r.session_id.padEnd(28)}  rows=${String(r.n).padStart(5)}  duration=${dur.toFixed(1)}s  rate=${(r.n / Math.max(dur, 0.001)).toFixed(2)}/s`);
    }
}

function events(n) {
    n = parseInt(n) || 20;
    const rows = db.prepare(`SELECT timestamp, event_type, zone, payload
                              FROM events ORDER BY timestamp DESC LIMIT ?`).all(n);
    for (const r of rows.reverse()) console.log(JSON.stringify(r));
    console.log(`(${rows.length} rows; total in table: ${db.prepare('SELECT COUNT(*) n FROM events').get().n})`);
}

function eventsByType() {
    const rows = db.prepare(`SELECT event_type, COUNT(*) as n FROM events GROUP BY event_type ORDER BY n DESC`).all();
    for (const r of rows) console.log(`${String(r.n).padStart(6)}  ${r.event_type}`);
}

function snapshots(n) {
    n = parseInt(n) || 5;
    const counts = db.prepare(`SELECT kind, COUNT(*) as n FROM snapshots GROUP BY kind`).all();
    if (counts.length === 0) { console.log('(no snapshots)'); return; }
    for (const r of counts) console.log(`kind=${r.kind} count=${r.n}`);
    console.log('---');
    const rows = db.prepare(`SELECT timestamp, session_id, kind, payload FROM snapshots ORDER BY timestamp DESC LIMIT ?`).all(n);
    for (const r of rows.reverse()) {
        // Truncate payload for display
        const p = r.payload || '';
        const truncated = p.length > 200 ? p.slice(0, 200) + '...' : p;
        console.log(`[${r.kind}] t=${r.timestamp} sid=${r.session_id} payload=${truncated}`);
    }
}

function dupes() {
    const rows = db.prepare(`SELECT timestamp, session_id, COUNT(*) as c FROM poll
                              GROUP BY timestamp, session_id HAVING c > 1 LIMIT 10`).all();
    if (rows.length === 0) {
        console.log('No duplicate (timestamp, session_id) pairs in poll. Marker protocol healthy.');
        return;
    }
    console.log(`Found ${rows.length}+ duplicate pairs (showing 10):`);
    for (const r of rows) console.log(JSON.stringify(r));
}

function orphans() {
    const sids = new Set(db.prepare('SELECT session_id FROM sessions').all().map(r => r.session_id));
    const pollSids = new Set(db.prepare('SELECT DISTINCT session_id FROM poll').all().map(r => r.session_id));
    const evSids = new Set(db.prepare('SELECT DISTINCT session_id FROM events').all().map(r => r.session_id));
    const orphPoll = [...pollSids].filter(s => !sids.has(s));
    const orphEv = [...evSids].filter(s => !sids.has(s));
    console.log(`sessions table: ${sids.size} ids`);
    console.log(`poll references: ${pollSids.size} distinct ids; orphans (in poll, missing from sessions): ${orphPoll.length}`);
    for (const s of orphPoll) console.log('  ' + s);
    console.log(`events references: ${evSids.size} distinct ids; orphans: ${orphEv.length}`);
    for (const s of orphEv) console.log('  ' + s);
}

function schema() {
    for (const t of TABLES) {
        console.log(`--- ${t} ---`);
        const cols = db.prepare(`PRAGMA table_info(${t})`).all();
        for (const c of cols) console.log(`  ${c.cid}  ${c.name}  ${c.type}${c.pk ? '  PK' : ''}`);
    }
}

function summary() {
    console.log('=== counts ===');
    counts();
    console.log('\n=== sessions ===');
    sessions();
    console.log('\n=== poll-range ===');
    pollRange();
    console.log('\n=== orphans ===');
    orphans();
    console.log('\n=== events-by-type ===');
    eventsByType();
    console.log('\n=== snapshots ===');
    snapshots(0);
    console.log('\n=== dupes ===');
    dupes();
}

function sql(q) {
    if (!q) { console.error('Usage: inspect.mjs sql "SELECT ..."'); process.exit(2); }
    if (!/^\s*select\s/i.test(q)) { console.error('Refusing non-SELECT query.'); process.exit(2); }
    const rows = db.prepare(q).all();
    for (const r of rows) console.log(JSON.stringify(r));
    console.log(`(${rows.length} rows)`);
}

// Coverage: parse Lumberjack.lua for what we REGISTER, then compare against the DB. The mental-overview
// report — answers "what do we actually have to work with?" without grepping source manually.
function humanAgo(t) {
    if (!t) return '-';
    const age = Date.now() / 1000 - t;
    if (age < 0) return 'future?';
    if (age < 60) return `${Math.round(age)}s ago`;
    if (age < 3600) return `${Math.round(age / 60)}m ago`;
    if (age < 86400) return `${Math.round(age / 3600)}h ago`;
    return `${Math.round(age / 86400)}d ago`;
}
function truncate(s, n) {
    if (s == null) return '';
    s = String(s);
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function coverage() {
    const lumberjackPath = path.join(__dirname, '..', 'Lumberjack', 'Lumberjack.lua');
    const src = fs.readFileSync(lumberjackPath, 'utf8');
    const registered = [...src.matchAll(/RegisterEvent\("([A-Z_]+)"\)/g)].map(m => m[1]);

    // Startup events (handled separately, not stored in `events` table).
    const STARTUP = new Set(['ADDON_LOADED', 'PLAYER_LOGIN']);
    const captureable = registered.filter(e => !STARTUP.has(e));

    const eventCounts = new Map(
        db.prepare(`SELECT event_type, COUNT(*) n, MAX(timestamp) t FROM events GROUP BY event_type`).all()
            .map(r => [r.event_type, r])
    );

    console.log('=== EVENTS REGISTERED IN FORESTRY ===');
    console.log('  ' + 'event'.padEnd(32) + 'count'.padStart(8) + '   latest      sample payload');
    let seen = 0, missing = 0;
    for (const ev of captureable) {
        const stat = eventCounts.get(ev);
        if (!stat) {
            missing++;
            console.log(`  ${ev.padEnd(32)} ${'0'.padStart(8)}   ${'-'.padEnd(10)}  (never seen)`);
            continue;
        }
        seen++;
        const sample = db.prepare(`SELECT payload FROM events WHERE event_type = ? AND payload IS NOT NULL LIMIT 1`).get(ev);
        console.log(`  ${ev.padEnd(32)} ${String(stat.n).padStart(8)}   ${humanAgo(stat.t).padEnd(10)}  ${truncate(sample?.payload, 80)}`);
    }
    console.log(`  -- ${seen} seen / ${missing} never-seen / ${captureable.length} total registered`);

    // Events seen in DB that we don't currently register — flags stale data from previous runs.
    const seenSet = [...eventCounts.keys()];
    const unregistered = seenSet.filter(e => !registered.includes(e));
    if (unregistered.length) {
        console.log('\n=== EVENT TYPES IN DB BUT NOT REGISTERED (stale data from prior addon versions) ===');
        for (const ev of unregistered) console.log(`  ${ev.padEnd(32)} ${String(eventCounts.get(ev).n).padStart(8)}`);
    }

    // Poll fields — sparsity and a sample value.
    console.log('\n=== POLL FIELDS (non-null counts; write-on-change cols will look sparse) ===');
    const pollCols = db.prepare(`PRAGMA table_info(poll)`).all().map(c => c.name)
        .filter(c => c !== 'schema_version');
    const totalPoll = db.prepare(`SELECT COUNT(*) n FROM poll`).get().n;
    for (const col of pollCols) {
        const nonNull = db.prepare(`SELECT COUNT(*) n FROM poll WHERE "${col}" IS NOT NULL`).get().n;
        const pct = totalPoll ? (100 * nonNull / totalPoll).toFixed(1) : '0';
        const sample = db.prepare(`SELECT "${col}" v FROM poll WHERE "${col}" IS NOT NULL LIMIT 1`).get();
        console.log(`  ${col.padEnd(18)} ${String(nonNull).padStart(8)}/${String(totalPoll).padStart(8)} (${pct.padStart(5)}%)  sample: ${truncate(sample?.v, 40)}`);
    }

    // Snapshots — kind breakdown.
    console.log('\n=== SNAPSHOT KINDS ===');
    const kinds = db.prepare(`SELECT kind, COUNT(*) n, MAX(timestamp) t FROM snapshots GROUP BY kind`).all();
    if (kinds.length === 0) console.log('  (none captured)');
    for (const k of kinds) {
        const sample = db.prepare(`SELECT payload FROM snapshots WHERE kind = ? LIMIT 1`).get(k.kind);
        console.log(`  ${k.kind.padEnd(18)} ${String(k.n).padStart(8)}   ${humanAgo(k.t).padEnd(10)}  ${truncate(sample?.payload, 80)}`);
    }
    // Implemented vs documented kinds.
    const implemented = new Set(['gear', 'bags', 'rep', 'talents', 'skills', 'party']);
    const documented = ['gear', 'bags', 'rep', 'talents', 'skills', 'party'];
    const missingKinds = documented.filter(k => !implemented.has(k));
    if (missingKinds.length) console.log(`  -- documented but not implemented: ${missingKinds.join(', ')}`);

    // CLEU event types (these are subevents inside the native combat log file).
    console.log('\n=== CLEU SUBEVENTS (from native combat log) ===');
    const cleuTypes = db.prepare(`SELECT event_type, COUNT(*) n FROM cleu GROUP BY event_type ORDER BY n DESC`).all();
    if (cleuTypes.length === 0) console.log('  (none captured)');
    for (const t of cleuTypes) {
        console.log(`  ${t.event_type.padEnd(32)} ${String(t.n).padStart(8)}`);
    }
}

const handlers = {
    summary, counts, sessions,
    poll, 'poll-ff': pollFF, 'poll-range': pollRange, 'poll-sparsity': pollSparsity, world,
    events, 'events-by-type': eventsByType,
    snapshots, coverage, dupes, orphans, schema, sql,
};

const fn = handlers[sub];
if (!fn) {
    console.error(`Unknown subcommand: ${sub}`);
    console.error(`Available: ${Object.keys(handlers).join(', ')}`);
    process.exit(2);
}
fn(arg1);
