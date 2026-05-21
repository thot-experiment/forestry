// xp_debug.mjs — diagnose XP rate spikes on the timeline.
//
// Replicates buildXpCumSeries + buildPlaytimeMap from timeline.mjs but runs
// against the raw DB so we can inspect individual rows. Prints every row where
// a single-step XP gain looks anomalous and a tail of the last N minutes.
//
// Usage:
//   node src/Sawmill/xp_debug.mjs [char_name_fragment] [tail_minutes]
//   node src/Sawmill/xp_debug.mjs Wran 20
//
// Output sections:
//   SESSIONS         — session ids, time range, row count
//   LARGE JUMPS      — steps where xpDelta > threshold (default 3000 XP)
//   LAST N MIN TAIL  — every XP-bearing row in the last N minutes of playtime

import sqlite from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new sqlite.DatabaseSync(path.join(__dirname, 'forestry.db'));

const charFragment = process.argv[2] || '';
const tailMinutes  = parseFloat(process.argv[3] || '20');
const jumpThresh   = parseInt(process.argv[4] || '3000');

// ── 1. Find matching sessions ──────────────────────────────────────────────
const sessionRows = charFragment
    ? db.prepare(`SELECT * FROM sessions WHERE character_name LIKE ? ORDER BY start_time`)
         .all(`%${charFragment}%`)
    : db.prepare(`SELECT * FROM sessions ORDER BY start_time`).all();

if (sessionRows.length === 0) {
    console.error(`No sessions found${charFragment ? ` matching "${charFragment}"` : ''}.`);
    process.exit(1);
}
console.log(`\n=== SESSIONS (${sessionRows.length}) ===`);
for (const s of sessionRows) {
    const range = db.prepare(`SELECT MIN(timestamp) t0, MAX(timestamp) t1, COUNT(*) n
                               FROM poll WHERE session_id = ?`).get(s.session_id);
    const dur = ((range.t1 - range.t0) / 60).toFixed(1);
    console.log(`  ${s.session_id}  char=${s.character_name}  lvl_start=?  rows=${range.n}  dur=${dur}min  ${new Date(range.t0 * 1000).toISOString()}`);
}

// ── 2. Load all poll rows for these sessions, forward-fill XP fields ───────
const sidSet = new Set(sessionRows.map(s => s.session_id));
const placeholders = [...sidSet].map(() => '?').join(',');
const rawRows = db.prepare(
    `SELECT timestamp, session_id, lvl, curr_xp, max_xp
     FROM poll WHERE session_id IN (${placeholders}) ORDER BY timestamp`
).all(...sidSet);

// Forward-fill per session (mirrors PollRows sparse accessor semantics).
const lastBySid = new Map();
const filled = rawRows.map(r => {
    const prev = lastBySid.get(r.session_id) || {};
    const lvl     = r.lvl     ?? prev.lvl     ?? null;
    const curr_xp = r.curr_xp ?? prev.curr_xp ?? null;
    const max_xp  = r.max_xp  ?? prev.max_xp  ?? null;
    const out = { t: r.timestamp, sid: r.session_id, lvl, curr_xp, max_xp };
    lastBySid.set(r.session_id, { lvl, curr_xp, max_xp });
    return out;
});

// ── 3. Build playtime map (mirrors buildPlaytimeMap) ───────────────────────
const ranges = new Map();
for (const r of filled) {
    const e = ranges.get(r.sid);
    if (!e) ranges.set(r.sid, { min: r.t, max: r.t });
    else { if (r.t < e.min) e.min = r.t; if (r.t > e.max) e.max = r.t; }
}
const sorted = [...ranges.entries()].sort((a, b) => a[1].min - b[1].min);
const offsetBySid = new Map();
let cumulative = 0;
for (const [sid, range] of sorted) {
    offsetBySid.set(sid, cumulative - range.min);
    cumulative += (range.max - range.min) + 2; // 2s pad
}
const projectT = (sid, t) => t + (offsetBySid.get(sid) ?? 0);

// ── 4. Build cumulative XP series (mirrors buildXpCumSeries) ───────────────
const xpLastBySid = new Map();
let xpTotal = 0;
const xpSeries = filled.map(r => {
    let delta = 0;
    let deltaReason = '';
    if (r.curr_xp != null && r.max_xp != null) {
        const last = xpLastBySid.get(r.sid);
        if (r.max_xp === 0) {
            // Bogus frame (addon not ready yet); flag but don't update lastBySid.
            if (last) deltaReason = `max_xp=0 BAD FRAME (curr_xp was ${last.curr_xp})`;
        } else {
            if (last && last.curr_xp != null && last.max_xp != null) {
                if (r.lvl != null && last.lvl != null && r.lvl > last.lvl) {
                    delta = (last.max_xp - last.curr_xp) + r.curr_xp;
                    deltaReason = `levelup ${last.lvl}→${r.lvl}`;
                } else if (r.curr_xp > last.curr_xp) {
                    delta = r.curr_xp - last.curr_xp;
                    deltaReason = `xp+${delta}`;
                } else if (r.curr_xp < last.curr_xp && (r.lvl == null || r.lvl === last.lvl)) {
                    deltaReason = `xp_DROP ${last.curr_xp}→${r.curr_xp} (missed levelup?)`;
                }
            }
            xpLastBySid.set(r.sid, r);
        }
    }
    xpTotal += delta;
    return {
        t: r.t,
        pt: projectT(r.sid, r.t),
        sid: r.sid,
        lvl: r.lvl,
        curr_xp: r.curr_xp,
        max_xp: r.max_xp,
        delta,
        deltaReason,
        cumXp: xpTotal,
    };
});

// ── 5. Print large XP jumps ────────────────────────────────────────────────
const large = xpSeries.filter(r => r.delta > jumpThresh || r.deltaReason.includes('DROP'));
console.log(`\n=== LARGE XP JUMPS (>${jumpThresh} XP or drops) — ${large.length} events ===`);
if (large.length === 0) {
    console.log('  (none)');
} else {
    console.log('  timestamp            pt_sec   sid(short)  lvl  curr_xp  max_xp    delta  reason');
    for (const r of large) {
        const ts = new Date(r.t * 1000).toISOString().replace('T', ' ').slice(0, 19);
        const sidShort = r.sid.slice(-8);
        console.log(`  ${ts}  ${r.pt.toFixed(1).padStart(8)}  ..${sidShort}  ${String(r.lvl ?? '?').padStart(3)}  ${String(r.curr_xp ?? 'n/a').padStart(7)}  ${String(r.max_xp ?? 'n/a').padStart(6)}  ${String(r.delta).padStart(7)}  ${r.deltaReason}`);
    }
}

// ── 6. Tail: last N minutes of playtime ───────────────────────────────────
let ptMax = -Infinity;
for (const r of xpSeries) if (r.pt > ptMax) ptMax = r.pt;
const ptCutoff = ptMax - tailMinutes * 60;
const tail = xpSeries.filter(r => r.pt >= ptCutoff && (r.delta > 0 || r.deltaReason.includes('DROP')));
console.log(`\n=== LAST ${tailMinutes} MIN XP EVENTS (playtime > ${(ptCutoff / 60).toFixed(1)} min) — ${tail.length} events ===`);
if (tail.length === 0) {
    console.log('  (no XP events in this window)');
} else {
    console.log('  timestamp            pt_min   sid(short)  lvl  curr_xp  max_xp    delta  reason');
    for (const r of tail) {
        const ts = new Date(r.t * 1000).toISOString().replace('T', ' ').slice(0, 19);
        const sidShort = r.sid.slice(-8);
        const ptMin = (r.pt / 60).toFixed(2);
        console.log(`  ${ts}  ${ptMin.padStart(7)}  ..${sidShort}  ${String(r.lvl ?? '?').padStart(3)}  ${String(r.curr_xp ?? 'n/a').padStart(7)}  ${String(r.max_xp ?? 'n/a').padStart(6)}  ${String(r.delta).padStart(7)}  ${r.deltaReason}`);
    }
}

// ── 7. Simulate rate at peak ───────────────────────────────────────────────
// For each large jump, compute what trapezoid rate it would produce near its timestamp.
if (large.length > 0) {
    console.log(`\n=== SIMULATED RATE AT LARGE EVENTS (W=120s) ===`);
    const W = 120;
    function trapF(v) {
        if (v <= -2 * W) return 0;
        if (v <= -W)   { const x = v + 2 * W; return 0.5 * x * x / W; }
        if (v <=  W)   return v + 1.5 * W;
        if (v <= 2 * W) { const x = 2 * W - v; return 3 * W - 0.5 * x * x / W; }
        return 3 * W;
    }
    const T0 = xpSeries[0].pt;
    const T1 = xpSeries[xpSeries.length - 1].pt;
    for (const r of large) {
        if (r.delta <= 0) continue;
        const t = r.pt;
        const Z = trapF(T1 - t) - trapF(T0 - t);
        const wt = Z > 0 ? r.delta / Z : Infinity;
        // Peak rate is at the event itself (trapK=1 at u=0 for u <= W)
        const peakRate = wt * 1 * 3600;
        const Zfrac = (Z / (3 * W) * 100).toFixed(0);
        console.log(`  +${r.delta} XP @ pt=${(t/60).toFixed(2)}min  Z=${Z.toFixed(1)} (${Zfrac}% of full kernel)  → peak rate ${Math.round(peakRate).toLocaleString()} XP/hr`);
        if (Z < 0.1 * 3 * W) {
            console.log(`    ^^^ Z is ${Zfrac}% of full kernel — VERY SMALL, this will spike the rate!`);
        }
    }
}

db.close();
