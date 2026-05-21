// Sawmill/cleu.mjs
// Parse and ingest WoWCombatLog-*.txt files.
//
// Combat logs are append-only per session/reload. We track byte offset per file in .state.json
// so each ingest only processes lines added since last run. Session linking is by character name
// + active session window: for each line, find a quoted "Char-Realm[-Region]" name that matches
// one of our known sessions, and tag with whichever session was active at that timestamp.

import fs from 'node:fs';
import path from 'node:path';

const LINE_RE = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)\.(\d+)([-+]\d+)\s+(.+)$/;

function parseLine(line) {
    const m = line.match(LINE_RE);
    if (!m) return null;
    const [, mo, day, yr, hr, min, sec, ms, tz, body] = m;
    const tzHours = parseInt(tz, 10);
    const utcMs = Date.UTC(
        parseInt(yr, 10), parseInt(mo, 10) - 1, parseInt(day, 10),
        parseInt(hr, 10), parseInt(min, 10), parseInt(sec, 10), parseInt(ms, 10)
    );
    // local time + (-tzHours hours) = UTC; equivalently subtract the offset.
    const timestamp = (utcMs - tzHours * 3600 * 1000) / 1000;
    const eventType = body.split(',', 1)[0];
    const names = [...body.matchAll(/"([^"]+)"/g)].map(x => x[1]);
    return { timestamp, eventType, names };
}

function buildSessionIndex(sessions) {
    // Map "Character-Realm" -> [sessions sorted by start_time ascending]
    const idx = new Map();
    for (const s of sessions) {
        if (!s.character_name || !s.realm) continue;
        const key = `${s.character_name}-${s.realm}`;
        if (!idx.has(key)) idx.set(key, []);
        idx.get(key).push(s);
    }
    for (const arr of idx.values()) arr.sort((a, b) => a.start_time - b.start_time);
    return idx;
}

function resolveSession(parsed, sessionIndex) {
    for (const rawName of parsed.names) {
        // Combat log names are "Wran-Nightslayer" or "Wran-Nightslayer-US" — strip a trailing -REGION.
        const stripped = rawName.replace(/-[A-Z]{2,3}$/, '');
        const candidates = sessionIndex.get(stripped);
        if (!candidates) continue;
        // Walk backwards: most recent session whose start_time <= parsed.timestamp wins.
        for (let i = candidates.length - 1; i >= 0; i--) {
            if (candidates[i].start_time <= parsed.timestamp) {
                return candidates[i].session_id;
            }
        }
    }
    return null;
}

export function processCleuFile(filePath, { db, state, archiveDir, debounceMs, skipArchive = false }) {
    let stat;
    try { stat = fs.statSync(filePath); }
    catch (e) { console.warn(`stat failed for ${filePath}: ${e.message}`); return; }

    const last = state.files[filePath] || {};
    if (stat.mtimeMs <= (last.lastIngestedMtime || 0)) return;
    if (stat.size <= (last.lastIngestedBytes || 0)) {
        // mtime changed but file didn't grow — nothing new to ingest. Update mtime stamp.
        state.files[filePath] = { ...last, lastIngestedMtime: stat.mtimeMs, lastIngestedAt: Date.now() };
        return;
    }

    const offset = last.lastIngestedBytes || 0;
    const newBytes = stat.size - offset;
    const buf = Buffer.alloc(newBytes);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buf, 0, newBytes, offset); }
    finally { fs.closeSync(fd); }
    const chunk = buf.toString('utf8');

    // Sync archive with the live file. WoW appends across sessions to a single combat log, so we
    // need to keep growing the archived copy too — otherwise rebuild only sees whatever bytes
    // existed at first sight. On first ingest copy the whole file; on subsequent ingests append
    // just the new bytes. archivePath is persisted in state so we can find it again next time.
    let archivePath = last.archivePath || null;
    if (!skipArchive) {
        try {
            if (!archivePath || !fs.existsSync(archivePath)) {
                const ts = Date.now();
                archivePath = path.join(archiveDir, `${ts}_${path.basename(filePath)}`);
                fs.copyFileSync(filePath, archivePath);
            } else {
                fs.appendFileSync(archivePath, chunk);
            }
        } catch (e) {
            console.warn(`archive sync failed: ${e.message}`);
        }
    }

    const sessions = db.prepare('SELECT session_id, character_name, realm, start_time FROM sessions').all();
    const sessionIndex = buildSessionIndex(sessions);

    const insert = db.prepare('INSERT INTO cleu (timestamp, session_id, event_type, raw_line, schema_version) VALUES (?, ?, ?, ?, ?)');
    let ingested = 0, unmatched = 0;

    db.exec('BEGIN');
    try {
        // BC Anniversary writes CRLF line endings; split on either Windows or Unix newlines
        // so lines don't carry a trailing \r (which `(.+)$` in the line regex won't match — `.` excludes \r).
        for (const line of chunk.split(/\r?\n/)) {
            if (!line) continue;
            const parsed = parseLine(line);
            if (!parsed) continue;
            const sid = resolveSession(parsed, sessionIndex);
            insert.run(parsed.timestamp, sid || 'unknown_session', parsed.eventType, line, 1);
            ingested++;
            if (!sid) unmatched++;
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        console.error(`CLEU ingest error for ${filePath}:`, e);
        return;
    }

    state.files[filePath] = {
        lastIngestedMtime: stat.mtimeMs,
        lastIngestedBytes: stat.size,
        lastIngestedAt: Date.now(),
        archivePath,
    };

    console.log(`CLEU ${path.basename(filePath)}: +${ingested} rows (${unmatched} unmatched, +${(newBytes/1024).toFixed(1)}KB from offset ${offset})`);
}
