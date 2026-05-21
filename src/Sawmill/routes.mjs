// Sawmill/routes.mjs
// HTTP routing. Two layers:
//   apiHandler  — own URL parsing, query strings, path params via URL().pathname split.
//   staticRouter — userver-based static file serving for non-/api/ paths.
//
// Big-chunk JSON endpoints — local-only, so we ship dense blobs rather than fine-grained filtering.

import path from 'node:path';
import zlib from 'node:zlib';
import Server from './userver.mjs';
import { CONFIG } from './config.mjs';
import { db } from './db.mjs';

const { build_router, serve_file } = Server(CONFIG.webRoot);

// Only gzip payloads big enough to matter. Under ~1KB the header overhead + CPU outweighs the win.
const GZIP_MIN_BYTES = 1024;

function sendJSON(res, body, status = 200) {
    const json = JSON.stringify(body);
    const buf = Buffer.from(json);
    const acceptEnc = res.req?.headers?.['accept-encoding'] || '';
    const wantsGzip = acceptEnc.includes('gzip') && buf.length >= GZIP_MIN_BYTES;
    if (wantsGzip) {
        const gz = zlib.gzipSync(buf);
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': gz.length,
            'Cache-Control': 'no-store',
        });
        res.end(gz);
        return;
    }
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
    });
    res.end(buf);
}

function sendError(res, status, msg) {
    sendJSON(res, { error: msg }, status);
}

import { STABLE_POLL_COLS, forwardFillBySession } from './www/analysis/utils.mjs';

// Columnar serializer for poll rows. Output shape:
//   { encoding: 'columnar_v1', n, dense, cols: { t, sid, hp, mp, ..., zone, sz } }
// - `t` is delta-encoded (first absolute, rest = delta from previous). Gzips well even when dense.
// - Numeric cols are emitted as plain JS arrays of length n.
//     When dense=false (write-on-change semantics, paired with rows_all): fields that didn't change
//     vs the previous row are emitted as null; client forward-fills during expansion.
//     When dense=true (paired with the filtered rows where intermediate rows have been dropped):
//     every slot carries the already-forward-filled value, so the client can use it directly.
// - zone/sz are run-length pairs [[startIdx, value], ...] regardless of dense — they rarely change
//   and RLE beats per-row storage handily.
// First wire-format step (PR 1a): server pays the encode cost, client re-expands to row objects.
// PR 1b will keep the wire format and switch the client to typed-array-backed access for memory.
const POLL_NUMERIC_COLS = [
    'sid', 'x', 'y', 'wx', 'wy', 'wz', 'inst',
    'mid', 'lvl', 'curr_xp', 'max_xp', 'rest',
    'hp', 'mp', 'en', 'rg',
    'combat', 'mnt', 'stealth', 'form', 'form_spell', 'cp', 'falling',
];
const POLL_STRING_COLS = ['zone', 'sz'];
function serializePollColumns(rows, dense) {
    const n = rows.length;
    const cols = {};
    const t = new Array(n);
    if (n > 0) {
        t[0] = rows[0].t;
        for (let i = 1; i < n; i++) t[i] = rows[i].t - rows[i - 1].t;
    }
    cols.t = t;
    for (const f of POLL_NUMERIC_COLS) {
        const out = new Array(n);
        if (dense) {
            for (let i = 0; i < n; i++) {
                const v = rows[i][f];
                out[i] = (v === undefined ? null : v);
            }
        } else {
            // Null-as-carry. Both null and undefined collapse to null on the wire.
            for (let i = 0; i < n; i++) {
                const v = rows[i][f];
                out[i] = (v === undefined || v === null) ? null : v;
            }
        }
        cols[f] = out;
    }
    for (const f of POLL_STRING_COLS) {
        const rle = [];
        let last = undefined;
        for (let i = 0; i < n; i++) {
            const v = rows[i][f] ?? null;
            if (v !== last) {
                rle.push([i, v]);
                last = v;
            }
        }
        cols[f] = rle;
    }
    return { encoding: 'columnar_v1', n, dense, cols };
}

// /api/snapshot — counts + runs grouped by character_name+realm with per-session aggregates.
function getSnapshot() {
    const counts = {};
    for (const t of ['poll', 'events', 'snapshots', 'cleu']) {
        const c = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get();
        const ts = db.prepare(`SELECT MAX(timestamp) t FROM ${t}`).get();
        counts[t] = { rows: c.n, latest: ts?.t ?? null };
    }
    const sessC = db.prepare('SELECT COUNT(*) n FROM sessions').get();
    const sessTs = db.prepare('SELECT MAX(start_time) t FROM sessions').get();
    counts.sessions = { rows: sessC.n, latest: sessTs?.t ?? null };

    const sessions = db.prepare(`
        SELECT session_id, start_time, character_name, realm, faction, race, class,
               character_guid, client_version, client_build, client_tocversion
        FROM sessions ORDER BY start_time
    `).all();

    const sessionAggs = new Map(
        db.prepare(`
            SELECT s.session_id,
                   COUNT(DISTINCT p.rowid) AS poll_rows,
                   MIN(p.timestamp) AS poll_start,
                   MAX(p.timestamp) AS poll_end,
                   MIN(p.lvl) AS lvl_min,
                   MAX(p.lvl) AS lvl_max
            FROM sessions s LEFT JOIN poll p ON p.session_id = s.session_id
            GROUP BY s.session_id
        `).all().map(r => [r.session_id, r])
    );
    const eventAggs = new Map(
        db.prepare(`SELECT session_id, COUNT(*) n FROM events GROUP BY session_id`).all()
            .map(r => [r.session_id, r.n])
    );
    const cleuAggs = new Map(
        db.prepare(`SELECT session_id, COUNT(*) n FROM cleu GROUP BY session_id`).all()
            .map(r => [r.session_id, r.n])
    );

    const runs = new Map();
    for (const s of sessions) {
        const runKey = `${s.character_name || '?'}::${s.realm || '?'}`;
        if (!runs.has(runKey)) {
            runs.set(runKey, {
                key: runKey,
                character_name: s.character_name,
                realm: s.realm,
                faction: s.faction,
                race: s.race,
                class: s.class,
                character_guid: s.character_guid,
                sessions: [],
            });
        }
        const agg = sessionAggs.get(s.session_id) || {};
        runs.get(runKey).sessions.push({
            session_id: s.session_id,
            start_time: s.start_time,
            poll_start: agg.poll_start ?? null,
            poll_end: agg.poll_end ?? null,
            poll_rows: agg.poll_rows || 0,
            event_rows: eventAggs.get(s.session_id) || 0,
            cleu_rows: cleuAggs.get(s.session_id) || 0,
            lvl_min: agg.lvl_min ?? null,
            lvl_max: agg.lvl_max ?? null,
            client_build: s.client_build,
            client_tocversion: s.client_tocversion,
        });
    }

    const runArr = [...runs.values()].map(r => {
        const totals = r.sessions.reduce((acc, s) => {
            acc.poll_rows += s.poll_rows;
            acc.event_rows += s.event_rows;
            acc.cleu_rows += s.cleu_rows;
            acc.duration += (s.poll_end && s.poll_start) ? (s.poll_end - s.poll_start) : 0;
            if (s.lvl_min != null && (acc.lvl_min == null || s.lvl_min < acc.lvl_min)) acc.lvl_min = s.lvl_min;
            if (s.lvl_max != null && (acc.lvl_max == null || s.lvl_max > acc.lvl_max)) acc.lvl_max = s.lvl_max;
            return acc;
        }, { poll_rows: 0, event_rows: 0, cleu_rows: 0, duration: 0, lvl_min: null, lvl_max: null });
        const starts = r.sessions.map(s => s.start_time).filter(x => x);
        return {
            ...r,
            session_count: r.sessions.length,
            first_seen: starts.length ? Math.min(...starts) : null,
            last_seen: starts.length ? Math.max(...starts) : null,
            ...totals,
        };
    }).sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));

    return {
        generated_at: Date.now() / 1000,
        counts,
        runs: runArr,
    };
}

// Parse filter params: ?lvl_min=&lvl_max=&t_min=&t_max=. Missing/blank = no constraint on that axis.
function parseFilters(url) {
    const f = {};
    for (const k of ['lvl_min', 'lvl_max', 't_min', 't_max']) {
        const v = url.searchParams.get(k);
        if (v != null && v !== '') {
            const n = parseFloat(v);
            if (isFinite(n)) f[k] = n;
        }
    }
    return f;
}

// Parse session limit: ?session_limit=N or "all". Null = no limit.
function parseSessionLimit(url) {
    const v = url.searchParams.get('session_limit');
    if (v == null || v === '' || v === 'all') return null;
    const n = parseInt(v, 10);
    return isFinite(n) && n > 0 ? n : null;
}

// Forward-filled-lvl lookup at any timestamp t — for filtering events/kills by lvl-range when the
// event itself doesn't carry lvl. Returns null when t precedes the earliest poll row.
function makeLvlAtT(ffRows) {
    if (!ffRows.length) return () => null;
    const sorted = [...ffRows].sort((a, b) => a.t - b.t);
    return (t) => {
        if (t < sorted[0].t) return null;
        let lo = 0, hi = sorted.length - 1;
        while (lo < hi) {
            const m = (lo + hi + 1) >> 1;
            if (sorted[m].t <= t) lo = m; else hi = m - 1;
        }
        return sorted[lo].lvl ?? null;
    };
}

// /api/runs/:key/poll — all poll rows + marker-relevant events + kills, for every session in the run.
// Big chunk; the client filters by zone, joins kills to poll positions in time, derives dead spans.
// Forward-fill is per-session (matches addon's per-session lastPollState reset).
// Filters (lvl_min/max, t_min/max) are applied AFTER forward-fill so write-on-change NULLs don't
// confuse the lvl filter. Everything downstream (splits, per_session, spell_casts) runs over the
// filtered set so "what you see is what's measured."
function getRunPoll(runKey, filters = {}, sessionLimit = null, format = 'rows') {
    const [character_name, realm] = runKey.split('::');
    if (!character_name || !realm) return null;
    const sessions = db.prepare(
        'SELECT session_id, start_time, class FROM sessions WHERE character_name = ? AND realm = ? ORDER BY start_time'
    ).all(character_name, realm);
    if (sessions.length === 0) return { rows: [], sessions: [], events: [], kills: [] };

    // Apply session limit: keep only the last N sessions (newest-first by start_time).
    const limitSessions = sessionLimit >= 0 && sessionLimit < sessions.length
        ? sessions.slice(-sessionLimit)
        : sessions;
    const sids = limitSessions.map(s => s.session_id);
    const charClass = sessions[0]?.class || null;
    const placeholders = sids.map(() => '?').join(',');
    const allCharSids = sessions.map(s => s.session_id);
    const allCharPlaceholders = allCharSids.map(() => '?').join(',');

    const rows = db.prepare(`
        SELECT timestamp AS t, session_id AS sid, x, y, wx, wy, wz, inst,
               mid, zone, sz, lvl, curr_xp, max_xp, rest,
               hp, mp, en, rg, combat, mnt, stealth, form, form_spell, cp, falling
        FROM poll WHERE session_id IN (${placeholders}) ORDER BY session_id, timestamp
    `).all(...sids);
    // For format='columnar' rows_all needs the original write-on-change NULL pattern so the wire
    // payload can be sparse. Snapshot BEFORE forward-fill. Only allocate when actually emitting
    // columnar, since the snapshot is a non-trivial copy (n × ~25 fields). For format='rows' the
    // existing pipeline behavior is preserved — rows is forward-filled in place, no snapshot.
    const rawRows = format === 'columnar' ? rows.map(r => ({ ...r })) : null;
    // forwardFillBySession keys on .session_id; alias as sid in handlers but keep both for fill.
    for (const r of rows) r.session_id = r.sid;
    forwardFillBySession(rows);
    for (const r of rows) delete r.session_id;

    // Apply filter to rows. Build lvl-at-t lookup BEFORE filtering so events/kills can be filtered
    // against the same lvl context (otherwise an event mid-filter-window would have no lvl).
    const lvlAtT = makeLvlAtT(rows);
    const rowsFiltered = applyFilter(rows, filters, r => r.lvl);

    // Marker-relevant events only. QUEST_LOG_UPDATE intentionally excluded — too noisy to plot.
    // Friction event pairs (SHOW + CLOSED variants) included so the client can render duration bars
    // and tooltips. TAXIMAP_OPENED was already covered; TAXIMAP_CLOSED added here for the pair.
    // UNIT_SPELLCAST_SUCCEEDED is high-volume but client needs it for the per-cast mini-strip ticks
    // — we enrich with spell name below so tooltips don't require a separate lexicon round-trip.
    const markerEvents = [
        'PLAYER_DEAD', 'PLAYER_ALIVE', 'PLAYER_UNGHOST',
        'PLAYER_LEVEL_UP',
        'QUEST_ACCEPTED', 'QUEST_TURNED_IN',
        'UI_INFO_MESSAGE',
        'UNIT_SPELLCAST_SUCCEEDED',
        // Friction pairs
        'MERCHANT_SHOW', 'MERCHANT_CLOSED',
        'TRAINER_SHOW', 'TRAINER_CLOSED',
        'MAIL_SHOW', // MAIL_CLOSED never fires in TBC — mail rendered as instants
        'BANKFRAME_OPENED', 'BANKFRAME_CLOSED',
        'AUCTION_HOUSE_SHOW', 'AUCTION_HOUSE_CLOSED',
        'LOOT_OPENED', 'LOOT_CLOSED',
        'CINEMATIC_START', 'CINEMATIC_STOP',
        'TAXIMAP_OPENED', 'TAXIMAP_CLOSED',
        'HEARTHSTONE_BOUND',
    ];
    const evPlaceholders = markerEvents.map(() => '?').join(',');
    const events = db.prepare(`
        SELECT timestamp AS t, session_id AS sid, event_type AS event,
               x, y, zone AS z, payload
        FROM events WHERE session_id IN (${placeholders}) AND event_type IN (${evPlaceholders})
        ORDER BY timestamp
    `).all(...sids, ...markerEvents);
    // Try to parse payload JSON for the client; tolerate junk.
    for (const e of events) {
        try { e.payload = e.payload ? JSON.parse(e.payload) : null; } catch { /* leave as string */ }
    }
    // Enrich UNIT_SPELLCAST_SUCCEEDED with spell name/rank from the lexicon — saves the client a
    // separate fetch + join for tooltips on the per-cast mini-strip.
    const spellNamesForEvents = new Map(
        db.prepare('SELECT id, name, rank FROM spells').all().map(r => [r.id, r])
    );
    for (const e of events) {
        if (e.event !== 'UNIT_SPELLCAST_SUCCEEDED') continue;
        const id = e.payload?.args?.[2];
        if (id == null) continue;
        const info = spellNamesForEvents.get(id);
        e.spell_id = id;
        if (info) { e.spell_name = info.name; e.spell_rank = info.rank; }
    }

    // PARTY_KILL credit lines. Positions resolved client-side from poll rows.
    // Re-resolve sid by timestamp against this character's full session list. The stored
    // cleu.session_id is pinned at ingest time using only sessions that existed *then* —
    // if a kill line was processed before its real session was created, it got attributed to
    // a prior session, then later projected into that session's playtime band and appeared
    // shifted into the future. We re-derive sid here so display always matches the live
    // sessions table. TODO: backfill cleu.session_id in the DB (one-time UPDATE pass keyed
    // off the same logic) and fix cleu.mjs ingest so the stored value is correct going forward.
    const sortedCharSessions = sessions.slice().sort((a, b) => a.start_time - b.start_time);
    const resolveSidByT = (t) => {
        // Most recent session whose start_time <= t wins.
        let lo = 0, hi = sortedCharSessions.length - 1, pick = -1;
        while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (sortedCharSessions[m].start_time <= t) { pick = m; lo = m + 1; }
            else hi = m - 1;
        }
        return pick >= 0 ? sortedCharSessions[pick].session_id : null;
    };
    const sidsSet = new Set(sids);
    const killsRaw = allCharSids.length === 0 ? [] : db.prepare(`
        SELECT timestamp AS t, raw_line
        FROM cleu WHERE session_id IN (${allCharPlaceholders}) AND event_type = 'PARTY_KILL'
        ORDER BY timestamp
    `).all(...allCharSids);
    const kills = [];
    for (const k of killsRaw) {
        const sid = resolveSidByT(k.t);
        if (sid && sidsSet.has(sid)) {
            kills.push({ t: k.t, sid, dest_name: parseKillDestName(k.raw_line) });
        }
    }

    // Filter events + kills against the same constraints. Events/kills don't carry lvl in their row,
    // so use lvlAtT (built from the pre-filter forward-filled poll stream) to attribute lvl.
    const eventsFiltered = applyFilter(events, filters, e => lvlAtT(e.t));
    const killsFiltered = applyFilter(kills, filters, k => lvlAtT(k.t));

    const stats = computeRunStats({ rows: rowsFiltered, events: eventsFiltered, kills: killsFiltered, sids });

    // Always return both full timeline data AND filtered slice. The client uses `rows` for the timeline
    // (so brush-select / context stays visible) and `rowsFiltered` for trajectory + stats + splits.
    // For now we send the same array under both keys when no filter is active — keeps client logic
    // uniform.
    const filterActive = Object.keys(filters).length > 0 || sessionLimit != null;
    // format='columnar' emits rows_all as the sparse (write-on-change) snapshot taken before forward-
    // fill, and the filtered slice as a dense columnar payload. Everything else (events, kills, stats)
    // is unchanged — they were never the memory hog. When filter is inactive `rows` aliases `rows_all`
    // semantically; we still emit both for client-side uniformity (the columnar expander handles the
    // null-as-carry vs dense distinction itself).
    if (format === 'columnar') {
        return {
            run_key: runKey,
            sessions: sids,
            class: charClass,
            filters,
            session_limit: sessionLimit,
            filter_active: filterActive,
            encoding: 'columnar_v1',
            rows_all: serializePollColumns(rawRows, /*dense*/ false),
            rows: serializePollColumns(rowsFiltered, /*dense*/ true),
            events_all: events,
            kills_all: kills,
            events: eventsFiltered,
            kills: killsFiltered,
            stats,
        };
    }
    return {
        run_key: runKey,
        sessions: sids,
        class: charClass,
        filters,
        session_limit: sessionLimit,
        filter_active: filterActive,
        // Full unfiltered data for the timeline / brush-select context.
        rows_all: rows,
        events_all: events,
        kills_all: kills,
        // Filtered data (used by trajectory + stats + splits + per-zone). When no filter, equals *_all.
        rows: rowsFiltered,
        events: eventsFiltered,
        kills: killsFiltered,
        stats,
    };
}

// Generic row filter: keep entries where t ∈ [t_min, t_max] AND lvl ∈ [lvl_min, lvl_max].
// `lvlOf(entry)` returns the lvl to compare against (null = "lvl unknown, fail the filter
// only if the user set a lvl constraint AT ALL"). Forgiving: missing constraints = pass.
function applyFilter(entries, filters, lvlOf) {
    const { t_min, t_max, lvl_min, lvl_max } = filters;
    const hasT = t_min != null || t_max != null;
    const hasLvl = lvl_min != null || lvl_max != null;
    if (!hasT && !hasLvl) return entries;
    return entries.filter(e => {
        if (t_min != null && e.t < t_min) return false;
        if (t_max != null && e.t > t_max) return false;
        if (hasLvl) {
            const lvl = lvlOf(e);
            if (lvl == null) return false;            // unknown lvl + active lvl filter = drop
            if (lvl_min != null && lvl < lvl_min) return false;
            if (lvl_max != null && lvl > lvl_max) return false;
        }
        return true;
    });
}

function computeRunStats({ rows, events, kills, sids }) {
    // Per-session aggregates: walk rows grouped by session for xp + duration + jumps + distance.
    const rowsBySid = new Map();
    for (const r of rows) {
        if (!rowsBySid.has(r.sid)) rowsBySid.set(r.sid, []);
        rowsBySid.get(r.sid).push(r);
    }

    // Per-session counts of marker events.
    const evCountsBySid = new Map(); // sid -> { deaths, levelUps, qAccept, qTurnIn }
    for (const e of events) {
        let c = evCountsBySid.get(e.sid);
        if (!c) { c = { deaths: 0, levelUps: 0, qAccept: 0, qTurnIn: 0 }; evCountsBySid.set(e.sid, c); }
        if (e.event === 'PLAYER_DEAD') c.deaths++;
        else if (e.event === 'PLAYER_LEVEL_UP') c.levelUps++;
        else if (e.event === 'QUEST_ACCEPTED') c.qAccept++;
        else if (e.event === 'QUEST_TURNED_IN') c.qTurnIn++;
    }
    const killCountsBySid = new Map();
    for (const k of kills) killCountsBySid.set(k.sid, (killCountsBySid.get(k.sid) || 0) + 1);

    // Per-session spell cast totals — UNIT_SPELLCAST_SUCCEEDED count grouped by session.
    const placeholdersAll = sids.map(() => '?').join(',');
    const castsPerSession = sids.length === 0 ? [] : db.prepare(`
        SELECT session_id, COUNT(*) AS n FROM events
        WHERE session_id IN (${placeholdersAll}) AND event_type = 'UNIT_SPELLCAST_SUCCEEDED'
        GROUP BY session_id
    `).all(...sids);
    const castCountsBySid = new Map(castsPerSession.map(r => [r.session_id, r.n]));

    const PATH_GAP_SEC = 2;
    const PATH_TELEPORT_DIST = 0.015;

    const perSession = sids.map(sid => {
        const sr = rowsBySid.get(sid) || [];
        let xp = 0, last = null;
        for (const r of sr) {
            if (r.curr_xp != null && r.max_xp != null) {
                if (last && last.curr_xp != null && last.max_xp != null) {
                    if (r.lvl != null && last.lvl != null && r.lvl > last.lvl) {
                        xp += (last.max_xp - last.curr_xp) + r.curr_xp;
                    } else if (r.curr_xp > last.curr_xp) {
                        xp += r.curr_xp - last.curr_xp;
                    }
                }
                last = r;
            }
        }
        let tmin = Infinity, tmax = -Infinity;
        let jumps = 0, lastFalling = null;
        let distance = 0;
        const zoneTime = new Map();
        for (let i = 0; i < sr.length; i++) {
            const r = sr[i];
            if (r.t < tmin) tmin = r.t; if (r.t > tmax) tmax = r.t;
            if (r.falling != null) {
                if (lastFalling === 0 && r.falling === 1) jumps++;
                lastFalling = r.falling;
            }
            if (i > 0) {
                const prev = sr[i - 1];
                const dt = r.t - prev.t;
                if (dt <= PATH_GAP_SEC && prev.x != null && prev.y != null && r.x != null && r.y != null) {
                    const dx = r.x - prev.x, dy = r.y - prev.y, d2 = dx * dx + dy * dy;
                    if (d2 <= PATH_TELEPORT_DIST * PATH_TELEPORT_DIST) distance += Math.sqrt(d2);
                }
                if (prev.zone) zoneTime.set(prev.zone, (zoneTime.get(prev.zone) || 0) + Math.min(dt, PATH_GAP_SEC));
            }
        }
        const dur = sr.length ? (tmax - tmin) : 0;
        const lvlMin = sr.reduce((m, r) => r.lvl != null && (m == null || r.lvl < m) ? r.lvl : m, null);
        const lvlMax = sr.reduce((m, r) => r.lvl != null && (m == null || r.lvl > m) ? r.lvl : m, null);
        const topZones = [...zoneTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([z, t]) => ({ z, t }));
        const ev = evCountsBySid.get(sid) || { deaths: 0, levelUps: 0, qAccept: 0, qTurnIn: 0 };
        return {
            sid,
            xp_gained: xp,
            duration: dur,
            xp_per_hour: dur > 0 ? xp / (dur / 3600) : 0,
            start_time: sr.length ? tmin : null,
            lvl_min: lvlMin, lvl_max: lvlMax,
            deaths: ev.deaths,
            level_ups: ev.levelUps,
            quests_accepted: ev.qAccept,
            quests_turned_in: ev.qTurnIn,
            kills: killCountsBySid.get(sid) || 0,
            jumps,
            spell_casts: castCountsBySid.get(sid) || 0,
            distance,
            top_zones: topZones,
        };
    });

    // XP gained across sessions; handles level-ups (curr_xp resets to 0 at higher max_xp).
    let xpGained = 0;
    let lastBySid = new Map();
    for (const r of rows) {
        if (r.curr_xp == null || r.max_xp == null) { lastBySid.set(r.sid, r); continue; }
        const last = lastBySid.get(r.sid);
        if (last && last.curr_xp != null && last.max_xp != null) {
            if (r.lvl != null && last.lvl != null && r.lvl > last.lvl) {
                xpGained += (last.max_xp - last.curr_xp) + r.curr_xp;
            } else if (r.curr_xp > last.curr_xp) {
                xpGained += r.curr_xp - last.curr_xp;
            }
            // curr_xp going down without a level-up is a write-on-change artifact; ignore.
        }
        lastBySid.set(r.sid, r);
    }

    // Playtime: sum of (max_t − min_t) per session.
    let duration = 0;
    const sessSpan = new Map();
    for (const r of rows) {
        const s = sessSpan.get(r.sid);
        if (!s) sessSpan.set(r.sid, { min: r.t, max: r.t });
        else { if (r.t < s.min) s.min = r.t; if (r.t > s.max) s.max = r.t; }
    }
    for (const s of sessSpan.values()) duration += (s.max - s.min);

    const xpPerHour = duration > 0 ? xpGained / (duration / 3600) : 0;

    // Event counts.
    let deaths = 0, levelUps = 0, qAccept = 0, qTurnIn = 0;
    for (const e of events) {
        if (e.event === 'PLAYER_DEAD') deaths++;
        else if (e.event === 'PLAYER_LEVEL_UP') levelUps++;
        else if (e.event === 'QUEST_ACCEPTED') qAccept++;
        else if (e.event === 'QUEST_TURNED_IN') qTurnIn++;
    }

    // Jumps: count 0→1 transitions of `falling` per session. Conflates jumps with falls off cliffs.
    let jumps = 0;
    const lastFalling = new Map();
    for (const r of rows) {
        if (r.falling == null) continue;
        const last = lastFalling.get(r.sid);
        if (last === 0 && r.falling === 1) jumps++;
        lastFalling.set(r.sid, r.falling);
    }

    // Spell cast counts from events.UNIT_SPELLCAST_SUCCEEDED payload, joined to lexicon names.
    const placeholders = sids.map(() => '?').join(',');
    const spellNames = new Map(
        db.prepare('SELECT id, name, rank FROM spells').all().map(r => [r.id, r])
    );
    const enrichCast = (c) => {
        const lex = spellNames.get(c.spell_id);
        return {
            id: c.spell_id,
            name: lex?.name || null,
            rank: lex?.rank || null,
            count: c.n,
        };
    };
    const castRows = sids.length === 0 ? [] : db.prepare(`
        SELECT json_extract(payload, '$.args[2]') AS spell_id, COUNT(*) AS n
        FROM events
        WHERE session_id IN (${placeholders}) AND event_type = 'UNIT_SPELLCAST_SUCCEEDED'
        GROUP BY spell_id
        ORDER BY n DESC
        LIMIT 30
    `).all(...sids);
    const spellCasts = castRows.map(enrichCast);

    // Same query, grouped by zone too — for the per-zone stats panel client-side.
    const castByZoneRows = sids.length === 0 ? [] : db.prepare(`
        SELECT zone, json_extract(payload, '$.args[2]') AS spell_id, COUNT(*) AS n
        FROM events
        WHERE session_id IN (${placeholders}) AND event_type = 'UNIT_SPELLCAST_SUCCEEDED'
        GROUP BY zone, spell_id
        ORDER BY zone, n DESC
    `).all(...sids);
    const spellCastsByZone = {};
    for (const r of castByZoneRows) {
        const z = r.zone || '(unknown)';
        if (!spellCastsByZone[z]) spellCastsByZone[z] = [];
        spellCastsByZone[z].push(enrichCast(r));
    }

    const splits = computeSplits({ rows, events, kills });

    return {
        duration_played: duration,
        xp_gained: xpGained,
        xp_per_hour: xpPerHour,
        levels_gained: levelUps,
        deaths,
        quests_accepted: qAccept,
        quests_turned_in: qTurnIn,
        kills: kills.length,
        jumps,
        spell_casts: spellCasts,
        spell_casts_by_zone: spellCastsByZone,
        per_session: perSession,
        splits,
    };
}

// 15-minute splits over CONTINUOUS playtime. Playtime is wall-clock time across all sessions
// minus gaps > PATH_GAP_SEC (logout/dc). Each row's playtime offset = sum of capped dts of all
// prior rows globally. Buckets are 900-sec wide. Events/kills inherit the playtime of the
// nearest preceding poll row (within 2s) for bucket assignment.
const SPLIT_SEC = 900;
const SPLIT_GAP_CAP = 2;
function computeSplits({ rows, events, kills }) {
    if (!rows.length) return [];
    // Sort rows globally by t (rows arrive ordered by session_id then timestamp — not globally sorted).
    // Don't mutate the input rows — they're the same array we return in the API response. Build a
    // parallel array of { row, pt } so we can bucket without leaking __pt into the JSON.
    const sorted = [...rows].sort((a, b) => a.t - b.t);
    let playtime = 0;
    const playtimeAtT = []; // parallel array of { t, pt } for nearest-lookup
    const ptByIndex = new Array(sorted.length);
    for (let i = 0; i < sorted.length; i++) {
        if (i > 0) {
            const dt = sorted[i].t - sorted[i - 1].t;
            // Cross-session gap: also clamp (different sessions are non-continuous play).
            const sameSession = sorted[i].sid === sorted[i - 1].sid;
            playtime += sameSession ? Math.min(dt, SPLIT_GAP_CAP) : 0;
        }
        ptByIndex[i] = playtime;
        playtimeAtT.push({ t: sorted[i].t, pt: playtime });
    }

    // Bucket setup.
    const totalPlaytime = playtime;
    const bucketCount = Math.max(1, Math.ceil(totalPlaytime / SPLIT_SEC));
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        idx: i,
        pt_start: i * SPLIT_SEC,
        pt_end: Math.min((i + 1) * SPLIT_SEC, totalPlaytime),
        xp_gained: 0,
        levels: 0,
        kills: 0,
        deaths: 0,
        quests_accepted: 0,
        quests_turned_in: 0,
        distance: 0,
        zone_time: new Map(),
        first_t: null,
        last_t: null,
        lvl_start: null,
        lvl_end: null,
    }));

    // Walk rows and attribute xp/distance/zone-time to buckets.
    // XP carries from previous row regardless of bucket — but XP delta is attributed to the
    // bucket of the LATER row. Level changes also attribute to the later-row bucket.
    let lastBySid = new Map();
    for (let i = 0; i < sorted.length; i++) {
        const r = sorted[i];
        const b = buckets[Math.min(Math.floor(ptByIndex[i] / SPLIT_SEC), bucketCount - 1)];
        if (b.first_t == null) b.first_t = r.t;
        b.last_t = r.t;
        if (r.lvl != null) {
            if (b.lvl_start == null) b.lvl_start = r.lvl;
            b.lvl_end = r.lvl;
        }
        const prev = lastBySid.get(r.sid);
        if (prev) {
            const dt = r.t - prev.t;
            if (dt <= SPLIT_GAP_CAP) {
                // distance
                if (prev.x != null && prev.y != null && r.x != null && r.y != null) {
                    const dx = r.x - prev.x, dy = r.y - prev.y, d2 = dx * dx + dy * dy;
                    if (d2 <= 0.015 * 0.015) b.distance += Math.sqrt(d2);
                }
                // zone-time (attributed to the bucket of the later row)
                if (prev.zone) b.zone_time.set(prev.zone, (b.zone_time.get(prev.zone) || 0) + Math.min(dt, SPLIT_GAP_CAP));
                // xp delta
                if (r.curr_xp != null && r.max_xp != null && prev.curr_xp != null && prev.max_xp != null) {
                    if (r.lvl != null && prev.lvl != null && r.lvl > prev.lvl) {
                        b.xp_gained += (prev.max_xp - prev.curr_xp) + r.curr_xp;
                        b.levels += (r.lvl - prev.lvl);
                    } else if (r.curr_xp > prev.curr_xp) {
                        b.xp_gained += r.curr_xp - prev.curr_xp;
                    }
                }
            }
        }
        lastBySid.set(r.sid, r);
    }

    // Helper: find playtime at any wall-clock t via binary search on sorted rows.
    const ptAtT = (t) => {
        if (t <= playtimeAtT[0].t) return playtimeAtT[0].pt;
        if (t >= playtimeAtT[playtimeAtT.length - 1].t) return playtimeAtT[playtimeAtT.length - 1].pt;
        let lo = 0, hi = playtimeAtT.length - 1;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (playtimeAtT[m].t < t) lo = m + 1; else hi = m;
        }
        return playtimeAtT[lo].pt;
    };
    const bucketForT = (t) => {
        const pt = ptAtT(t);
        return buckets[Math.min(Math.floor(pt / SPLIT_SEC), bucketCount - 1)];
    };

    for (const e of events) {
        const b = bucketForT(e.t);
        if (!b) continue;
        if (e.event === 'PLAYER_DEAD') b.deaths++;
        else if (e.event === 'QUEST_ACCEPTED') b.quests_accepted++;
        else if (e.event === 'QUEST_TURNED_IN') b.quests_turned_in++;
    }
    for (const k of kills) {
        const b = bucketForT(k.t);
        if (b) b.kills++;
    }

    // Finalize: convert zone_time to top zone label, compute xp_per_hour, span.
    return buckets.map(b => {
        const span = b.pt_end - b.pt_start;
        const topZone = [...b.zone_time.entries()].sort((a, c) => c[1] - a[1])[0];
        return {
            idx: b.idx,
            pt_start: b.pt_start,
            pt_end: b.pt_end,
            span,
            first_t: b.first_t,
            last_t: b.last_t,
            xp_gained: b.xp_gained,
            xp_per_hour: span > 0 ? b.xp_gained / (span / 3600) : 0,
            levels: b.levels,
            lvl_start: b.lvl_start,
            lvl_end: b.lvl_end,
            kills: b.kills,
            deaths: b.deaths,
            quests_accepted: b.quests_accepted,
            quests_turned_in: b.quests_turned_in,
            distance: b.distance,
            top_zone: topZone ? topZone[0] : null,
            top_zone_seconds: topZone ? topZone[1] : 0,
        };
    });
}

// PARTY_KILL,<srcGUID>,"<srcName>",<srcFlags>,<srcRaidFlags>,<destGUID>,"<destName>",...
function parseKillDestName(rawLine) {
    if (!rawLine) return null;
    const quoted = rawLine.match(/"([^"]*)"/g);
    if (!quoted || quoted.length < 2) return null;
    return quoted[1].replace(/^"|"$/g, '');
}

// /api/ranger — all spell ID→name pairs we've captured from the Ranger addon.
// Static-ish: client fetches once, caches, uses for enrichment.
function getRanger() {
    const spells = db.prepare(`SELECT id, name, rank, icon, school FROM spells ORDER BY id`).all();
    return {
        count: spells.length,
        spells: Object.fromEntries(spells.map(s => [s.id, s])),
    };
}

// API dispatcher — own routing. Supports path params + query strings via URL().
export async function apiHandler(req, res) {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return sendError(res, 400, 'bad URL'); }
    const p = url.pathname;

    try {
        if (p === '/api/snapshot' && req.method === 'GET') {
            return sendJSON(res, getSnapshot());
        }
        if (p === '/api/ranger' && req.method === 'GET') {
            return sendJSON(res, getRanger());
        }
        // /api/runs/<urlencoded-key>/poll[?lvl_min=&lvl_max=&t_min=&t_max=&session_limit=N|all]
        const m = p.match(/^\/api\/runs\/([^/]+)\/poll$/);
        if (m && req.method === 'GET') {
            const runKey = decodeURIComponent(m[1]);
            const filters = parseFilters(url);
            const sessionLimit = parseSessionLimit(url);
            // fmt=columnar opts into the columnar_v1 wire format for rows_all/rows. Default stays
            // 'rows' (existing per-row JSON) so this stays a no-op until the client asks for it.
            const format = url.searchParams.get('fmt') === 'columnar' ? 'columnar' : 'rows';
            const data = getRunPoll(runKey, filters, sessionLimit, format);
            if (!data) return sendError(res, 404, 'unknown run');
            return sendJSON(res, data);
        }
        sendError(res, 404, `no API route for ${p}`);

    } catch (e) {
        console.error(`API handler error on ${p}:`, e);
        sendError(res, 500, e.message);
    }
}

// Static (userver) router — root + everything not /api/.
const table = new Map();
table.set('/', { GET: serve_file(path.join(CONFIG.webRoot, 'index.html')) });
const staticDefault = { GET: serve_file() };

export const staticRouter = build_router(table, staticDefault);
