// Sawmill/ingest.mjs
// Lumberjack.lua ingest path. Race-minimizing orchestration:
//   1. Copy Lumberjack.lua → Lumberjack.ingest.lua (same folder, intra-drive copy = fast)
//   2. Run lua_to_json.lua on the COPY to get the JSON snapshot.
//   3. Compute highwater = max(t) across poll/events/snapshots.
//   4. Append `LumberjackHighwaterMark = <t>` to the ORIGINAL. RACE WINDOW CLOSES HERE —
//      everything that follows can take seconds without risk of the marker being lost.
//   5. Rename the copy into archive/ (intra-drive rename = O(1)).
//   6. Insert into DB inside one transaction. Per-session dedup filters out anything
//      <= max(timestamp) already in the table for that session, so a lost marker
//      (cycle N races, mark wiped on WoW logout) only causes one cycle of duplicate
//      *candidates* — the next ingest re-derives the highwater and self-heals.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG } from './config.mjs';
import { db } from './db.mjs';

function maxT(rows) {
    if (!rows) return 0;
    let m = 0;
    for (const r of rows) if (r.t != null && r.t > m) m = r.t;
    return m;
}

export function ingestLumberjackData(data) {
    const { poll, events, snapshots, sessions } = data;
    const counts = { poll: 0, events: 0, snapshots: 0, dupes: 0 };

    db.exec('BEGIN');
    try {
        if (sessions) {
            const stmt = db.prepare('INSERT OR IGNORE INTO sessions (session_id, start_time, character_name, realm, faction, race, class, character_guid, client_version, client_build, client_tocversion, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const s of sessions) {
                stmt.run(
                    s.id, s.startTime, s.character, s.realm, s.faction, s.race, s.class,
                    s.character_guid ?? null,
                    s.client_version ?? null, s.client_build ?? null, s.client_tocversion ?? null,
                    1
                );
            }
        }

        // Per-session max(timestamp) cache. Incoming rows for a session are sorted by t
        // (insertion order in the Lua table), so a single threshold per (table, session) is sufficient.
        const maxStmt = {
            poll: db.prepare('SELECT MAX(timestamp) AS m FROM poll WHERE session_id = ?'),
            events: db.prepare('SELECT MAX(timestamp) AS m FROM events WHERE session_id = ?'),
            snapshots: db.prepare('SELECT MAX(timestamp) AS m FROM snapshots WHERE session_id = ?'),
        };
        const cache = { poll: new Map(), events: new Map(), snapshots: new Map() };
        function thresholdFor(table, sid) {
            const c = cache[table];
            if (c.has(sid)) return c.get(sid);
            const row = maxStmt[table].get(sid);
            const m = (row && row.m != null) ? row.m : 0;
            c.set(sid, m);
            return m;
        }

        if (poll) {
            // Stable fields may be missing per row due to write-on-change. Pass through as NULL;
            // forward-fill happens in inspect.mjs / the API.
            const stmt = db.prepare('INSERT INTO poll (timestamp, session_id, x, y, wx, wy, wz, inst, mid, zone, sz, lvl, curr_xp, max_xp, hp, mp, en, rg, combat, bags, gold, mnt, stealth, rest, cast, cast_id, form, form_spell, cp, falling, fps, lat, mem, tgt, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const p of poll) {
                if (p.t == null || p.t <= thresholdFor('poll', p.sid)) { counts.dupes++; continue; }
                stmt.run(
                    p.t, p.sid,
                    p.x ?? null, p.y ?? null,
                    p.wx ?? null, p.wy ?? null, p.wz ?? null, p.inst ?? null,
                    p.mid ?? null, p.z ?? null, p.sz ?? null,
                    p.lvl ?? null, p.xp ?? null, p.mxp ?? null,
                    p.hp ?? null, p.mp ?? null, p.en ?? null, p.rg ?? null,
                    p.combat === undefined ? null : (p.combat ? 1 : 0),
                    p.bags ?? null, p.gold ?? null,
                    p.mnt === undefined ? null : (p.mnt ? 1 : 0),
                    p.stealth === undefined ? null : (p.stealth ? 1 : 0),
                    p.rest ?? null,
                    p.cast ?? null, p.cast_id ?? null,
                    p.form ?? null, p.form_spell ?? null, p.cp ?? null,
                    p.falling ?? null,
                    p.fps ?? null, p.lat ?? null, p.mem ?? null,
                    p.tgt ? JSON.stringify(p.tgt) : null,
                    1
                );
                counts.poll++;
            }
        }

        if (events) {
            const stmt = db.prepare('INSERT INTO events (timestamp, session_id, event_type, x, y, zone, payload, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            for (const e of events) {
                if (e.t == null || e.t <= thresholdFor('events', e.sid)) { counts.dupes++; continue; }
                stmt.run(e.t, e.sid, e.event, e.x, e.y, e.z, JSON.stringify(e.payload), 1);
                counts.events++;
            }
        }

        if (snapshots) {
            const stmt = db.prepare('INSERT INTO snapshots (timestamp, session_id, kind, payload, schema_version) VALUES (?, ?, ?, ?, ?)');
            for (const s of snapshots) {
                if (s.t == null || s.t <= thresholdFor('snapshots', s.sid)) { counts.dupes++; continue; }
                stmt.run(s.t, s.sid, s.kind, JSON.stringify(s.payload), 1);
                counts.snapshots++;
            }
        }

        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }

    return counts;
}

export function probeFile(filePath, globalName = 'LumberjackDB') {
    const result = spawnSync(CONFIG.luaExe, [CONFIG.luaScript, filePath, globalName], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
    if (result.status !== 0) {
        console.error(`Lua dump failed for ${filePath}:`, result.stderr);
        return null;
    }
    try {
        return JSON.parse(result.stdout);
    } catch (e) {
        console.error('Failed to parse Lua JSON output:', e);
        return null;
    }
}

export function appendHighwaterMarker(filePath, highwater) {
    if (!highwater || highwater <= 0) return;
    // Plain global assignment. Not registered as a SavedVariable in the .toc, so WoW reads it
    // on load (the SV file is just Lua) but won't persist it back. That asymmetry is what lets
    // the marker survive the race: even if the user logs in seconds after ingest writes it,
    // the marker is on disk for the next WoW load.
    fs.appendFileSync(filePath, `\nLumberjackHighwaterMark = ${highwater}\n`);
}

// Single entry point: copy → probe → mark → archive → insert.
export function processLumberjackIngest(filePath) {
    const dir = path.dirname(filePath);
    const copyPath = path.join(dir, 'Lumberjack.ingest.lua');

    try {
        fs.copyFileSync(filePath, copyPath);
    } catch (e) {
        console.error(`copy ${filePath} → ${copyPath} failed: ${e.message}`);
        return null;
    }

    try {
        const data = probeFile(copyPath);
        if (!data) return null;

        const highwater = Math.max(maxT(data.poll), maxT(data.events), maxT(data.snapshots));

        // Race window closes here. After this line, the slow archive + insert work can take
        // as long as it wants without risking marker loss on the next WoW logout.
        try {
            appendHighwaterMarker(filePath, highwater);
        } catch (e) {
            console.error(`marker append failed: ${e.message}`);
        }

        // Rename the copy into archive/ — same drive, so this is O(1) and we don't double-copy.
        const archiveFile = path.join(CONFIG.archivePath, `${Date.now()}_Lumberjack.lua`);
        try {
            fs.renameSync(copyPath, archiveFile);
        } catch (e) {
            // Cross-device rename is the only realistic failure here; fall back to copy+unlink.
            try { fs.copyFileSync(copyPath, archiveFile); fs.unlinkSync(copyPath); }
            catch (e2) { console.error(`archive failed: ${e2.message}`); }
        }

        const counts = ingestLumberjackData(data);
        return { counts, highwater };
    } finally {
        // Safety net: if anything above threw, the copy might still be sitting in the WTF folder.
        try { if (fs.existsSync(copyPath)) fs.unlinkSync(copyPath); } catch { /* best effort */ }
    }
}
