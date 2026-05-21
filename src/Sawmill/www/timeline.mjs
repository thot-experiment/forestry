// Lumberjack/www/timeline.js
// uPlot-based timeline per run.
//
// X axis is "playtime" (cumulative seconds with session gaps cut out), NOT wall-clock —
// the user plays in fits and spurts, so wall-clock leaves giant empty stretches that aren't
// interesting. Session boundaries are shown as colored background bands (matching the trajectory
// session legend) so you can tell which session you're looking at.
//
// Series: cumulative XP (left axis, gold), HP / MP / EN / RG on shared right axis (resource colors).
// Resources that are all-zero for the whole run aren't shown (e.g. a mage never has rage).
// Druid form switches active resource by tick — all three are stored so the chart shows the live one.
//
// Overlays: kill bottom-ticks, quest turn-in top-ticks, level-up dashed verticals, dead-interval bg.
//
// Loaded BEFORE app.js + alpine — sets window.buildTimeline / window.destroyTimeline.

(function () {
    'use strict';

    const TIMELINE_INSTANCES = new Map(); // hostId -> { uplot, hoverHandler, overEl }
    // Inter-session gap target in canvas pixels. Used to compute padSec dynamically so the visual
    // width of the gap is consistent regardless of how long the run is. 4px was the user request.
    const SESSION_PAD_PX = 4;

    // Friction event pairs: SHOW/CLOSED variants → kind + color. SHOW fires first, CLOSED ends the span.
    const FRICTION_TYPES = {
        MERCHANT_SHOW:      { kind: 'vendor',    color: '#4ec9b0', closer: 'MERCHANT_CLOSED' },
        TRAINER_SHOW:       { kind: 'trainer',   color: '#c586c0', closer: 'TRAINER_CLOSED' },
        // MAIL_CLOSED never fires in TBC — mail is rendered as instants, not spans.
        BANKFRAME_OPENED:   { kind: 'bank',      color: '#d7ba7d', closer: 'BANKFRAME_CLOSED' },
        AUCTION_HOUSE_SHOW: { kind: 'ah',        color: '#b5cea8', closer: 'AUCTION_HOUSE_CLOSED' },
        LOOT_OPENED:        { kind: 'loot',      color: '#9aa3b2', closer: 'LOOT_CLOSED' },
        CINEMATIC_START:    { kind: 'cinematic', color: '#e0e0e0', closer: 'CINEMATIC_STOP' },
        TAXIMAP_OPENED:     { kind: 'taxi',      color: '#7cc4ff', closer: 'TAXIMAP_CLOSED' },
    };
    const FRICTION_CLOSERS = (() => {
        const m = {};
        for (const [opener, v] of Object.entries(FRICTION_TYPES)) m[v.closer] = v.kind;
        return m;
    })();
 
    // Primary stance/form lookup, keyed by aura spell ID (poll.form_spell). Durable across
    // characters and locales — no per-class bar-slot guessing.
    const STANCE_BY_SPELL = {
        0:     { name: 'Humanoid',     color: '#444' },     // also "no stance" for warrior
        // Druid
        5487:  { name: 'Bear',         color: '#8b4513' },
        9634:  { name: 'Dire Bear',    color: '#a0522d' },
        768:   { name: 'Cat',          color: '#ffaa00' },
        783:   { name: 'Travel',       color: '#aaddff' },
        1066:  { name: 'Aquatic',      color: '#00ffff' },
        24858: { name: 'Moonkin',      color: '#ffccff' },
        33891: { name: 'Tree of Life', color: '#7fcb6c' },
        33943: { name: 'Flight',       color: '#c0c0ff' },
        40120: { name: 'Swift Flight', color: '#e0d0ff' },
        // Warrior
        2457:  { name: 'Battle',       color: '#ffcc00' },
        71:    { name: 'Defensive',    color: '#44aaff' },
        2458:  { name: 'Berserker',    color: '#ff4444' },
        // Priest
        15473: { name: 'Shadowform',   color: '#aa55cc' },
        // Shaman — TODO: verify form_spell aura ID in-game; 2645 is the cast spell, aura may differ
        2645:  { name: 'Ghost Wolf',   color: '#aaccee' },
    };
    const STANCE_DEFAULT = { name: 'Unknown', color: '#333' };
    // Legacy fallback for archived data captured before form_spell existed. Per-class bar-slot
    // map — best-effort; will mislabel if the character's learned-form set differs from the one
    // these slots were derived against (e.g. a Druid with Aquatic shifts Cat from slot 2 to 3).
    const STANCE_BY_SLOT_LEGACY = {
        Warrior: { 1: 2457, 2: 71, 3: 2458 },
        Druid:   { 1: 5487, 2: 768, 3: 783, 4: 24858 },
    };
    // Returns the active form's spell ID for a poll row. Prefers the durable form_spell field;
    // falls back to the per-class slot map for old data that only has the bar index.
    function rowFormSpell(r, charClass) {
        if (r.form_spell != null) return r.form_spell;
        const slot = r.form;
        if (slot == null) return null;
        if (slot === 0) return 0;
        return STANCE_BY_SLOT_LEGACY[charClass]?.[slot] ?? null;
    }
    const DRUID_BEAR_SPELLS = new Set([5487, 9634]);
    const DRUID_CAT_SPELL = 768;
    const STEALTH_OVERLAY_FILL = 'rgba(170, 85, 204, 0.86)'; // 86% purple, matches Shadowform hue family
    const MOUNTED_OVERLAY_FILL = 'rgba(255, 195, 50, 0.55)'; // warm gold, distinct from stealth purple

    // Walk events in time order; pair each SHOW with the next CLOSED of the same kind in the same
    // session. Orphan closers (no preceding SHOW) emit a zero-duration marker so user sees something
    // happened. Open-at-end-of-session spans extend to the last event in that session.
    function computeFrictionSpans(events) {
        const sorted = events.slice().sort((a, b) => a.t - b.t);
        const sessLast = new Map();
        for (const e of sorted) sessLast.set(e.sid, e.t);
        const spans = [];
        const openBySid = new Map(); // sid -> { kind -> startT }
        for (const e of sorted) {
            const opener = FRICTION_TYPES[e.event];
            if (opener) {
                if (!openBySid.has(e.sid)) openBySid.set(e.sid, {});
                if (openBySid.get(e.sid)[opener.kind] == null) {
                    openBySid.get(e.sid)[opener.kind] = e.t;
                }
                continue;
            }
            const closingKind = FRICTION_CLOSERS[e.event];
            if (!closingKind) continue;
            const info = Object.values(FRICTION_TYPES).find(v => v.kind === closingKind);
            const openSt = openBySid.get(e.sid)?.[closingKind];
            if (openSt != null) {
                spans.push({ sid: e.sid, kind: closingKind, color: info.color, start: openSt, end: e.t });
                openBySid.get(e.sid)[closingKind] = null;
            } else {
                // Orphan close — render as a thin marker rather than nothing.
                spans.push({ sid: e.sid, kind: closingKind, color: info.color, start: e.t, end: e.t, orphan: true });
            }
        }
        // Still-open at end of session: extend to last seen timestamp for that session.
        for (const [sid, openMap] of openBySid) {
            for (const [kind, startT] of Object.entries(openMap)) {
                if (startT == null) continue;
                const info = Object.values(FRICTION_TYPES).find(v => v.kind === kind);
                spans.push({ sid, kind, color: info.color, start: startT, end: sessLast.get(sid), openEnded: true });
            }
        }
        return spans;
    }

    // Compute per-session offsets so timestamps map to a continuous playtime axis (gaps removed).
    // padSec controls the visual gap between adjacent sessions on the playtime axis. Callers compute
    // a value that yields ~SESSION_PAD_PX canvas pixels at the current plot width.
    function buildPlaytimeMap(rows, padSec) {
        const ranges = new Map();
        for (const r of rows) {
            const existing = ranges.get(r.sid);
            if (!existing) ranges.set(r.sid, { sid: r.sid, min: r.t, max: r.t });
            else {
                if (r.t < existing.min) existing.min = r.t;
                if (r.t > existing.max) existing.max = r.t;
            }
        }
        const sorted = [...ranges.values()].sort((a, b) => a.min - b.min);
        let cumulative = 0;
        for (const s of sorted) {
            s.offset = cumulative - s.min;     // playT = realT + offset
            s.duration = s.max - s.min;
            s.playStart = cumulative;
            s.playEnd = cumulative + s.duration;
            cumulative += s.duration + padSec;
        }
        const offsetBySid = new Map(sorted.map(s => [s.sid, s.offset]));
        const projectT = (sid, t) => {
            const o = offsetBySid.get(sid);
            return o == null ? t : t + o;
        };
        return { sessions: sorted, offsetBySid, projectT };
    }

    // Total session-time (excludes pads) — used to derive padSec from a target pixel width.
    function totalSessionPlaytime(rows) {
        const ranges = new Map();
        for (const r of rows) {
            const e = ranges.get(r.sid);
            if (!e) ranges.set(r.sid, { min: r.t, max: r.t });
            else { if (r.t < e.min) e.min = r.t; if (r.t > e.max) e.max = r.t; }
        }
        let total = 0;
        for (const r of ranges.values()) total += r.max - r.min;
        return total;
    }

    // Cumulative XP per row, handling level-ups (curr_xp resets to 0 at higher max_xp).
    function buildXpCumSeries(rows) {
        let total = 0;
        const out = new Array(rows.length);
        const lastBySid = new Map();
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            // max_xp=0 means the addon captured a frame before UnitXP() was ready (happens on
            // login/reload). Treat it as missing data — don't update lastBySid so the zero can't
            // corrupt the gain calculation for the real value that follows immediately after.
            if (r.curr_xp != null && r.max_xp != null && r.max_xp > 0) {
                const last = lastBySid.get(r.sid);
                if (last && last.curr_xp != null && last.max_xp != null) {
                    if (r.lvl != null && last.lvl != null && r.lvl > last.lvl) {
                        total += (last.max_xp - last.curr_xp) + r.curr_xp;
                    } else if (r.curr_xp > last.curr_xp) {
                        total += r.curr_xp - last.curr_xp;
                    }
                }
                lastBySid.set(r.sid, r);
            }
            out[i] = total;
        }
        return out;
    }

    // Trapezoidal kernel: flat-top with linear ramps. Same flat-line guarantee as the boxcar
    // (W ≥ slice → exactly flat at slice average) but each event's contribution smoothly ramps
    // in and out instead of stepping, so the curve has no discontinuities. With ramp width τ = W
    // (ramps as wide as the flat half-width) the kernel spans ±2W.
    //   k_W(u) = 1                  for |u| ≤ W
    //          = 2 − |u|/W           for W < |u| ≤ 2W
    //          = 0                   otherwise
    function trapK(u, W) {
        const a = u < 0 ? -u : u;
        if (a <= W) return 1;
        if (a >= 2 * W) return 0;
        return 2 - a / W;
    }
    // Antiderivative F(v) = ∫_{-2W}^{v} k(s) ds, used to compute the per-event mass in the slice.
    // Full kernel area = 3W (2W flat + W from the two triangular ramps).
    function trapF(v, W) {
        if (v <= -2 * W) return 0;
        if (v <= -W)   { const x = v + 2 * W; return 0.5 * x * x / W; }
        if (v <=  W)   return v + 1.5 * W;
        if (v <= 2 * W) { const x = 2 * W - v; return 3 * W - 0.5 * x * x / W; }
        return 3 * W;
    }

    // Instantaneous XP/hr via a mass-preserving trapezoidal-kernel moving sum. Each in-slice XP
    // gain is distributed over [t_j − 2W, t_j + 2W] as a trapezoid, renormalized so its integral
    // over [T0, T1] equals the gain. Two properties hold exactly:
    //   (1) ∫_{T0}^{T1} rate dt = total XP gained in slice, independent of W.
    //   (2) W ≥ T1 − T0 → flat region [t_j ± W] covers the whole slice for any in-slice t_j →
    //       k_W(t-t_j) = 1 and Z_j = slice for every event → rate(t) = total_xp / slice. Flat.
    // O(N·m) where m is the avg event count in a 4W window.
    function buildXpRateTrapezoid(xs, xpCum, W, T0, T1) {
        const n = xs.length;
        const out = new Array(n).fill(0);
        if (n < 2 || W <= 0) return out;

        const evT = [];
        const evWt = [];
        for (let i = 1; i < n; i++) {
            const gain = xpCum[i] - xpCum[i - 1];
            if (gain <= 0) continue;
            const t = xs[i];
            if (t < T0 || t > T1) continue;
            const Z = trapF(T1 - t, W) - trapF(T0 - t, W);
            if (Z <= 0) continue;
            evT.push(t);
            evWt.push(gain / Z);
        }
        if (evT.length === 0) return out;

        // Two-pointer window over events within ±2W of each sample.
        const support = 2 * W;
        let lo = 0, hi = 0;
        for (let i = 0; i < n; i++) {
            const x = xs[i];
            while (hi < evT.length && evT[hi] <= x + support) hi++;
            while (lo < hi && evT[lo] < x - support) lo++;
            let s = 0;
            for (let j = lo; j < hi; j++) s += evWt[j] * trapK(x - evT[j], W);
            out[i] = s * 3600;
        }
        return out;
    }

    // Boxcar (rectangular) kernel rate. Same Z-renormalization as trapezoid for boundary correctness.
    // O(N+M): two-pointer over events, k=1 in window so inner sum needs no trapK call.
    function buildXpRateBoxcar(xs, xpCum, W, T0, T1) {
        const n = xs.length;
        const out = new Array(n).fill(0);
        if (n < 2 || W <= 0) return out;
        const evT = [];
        const evWt = [];
        for (let i = 1; i < n; i++) {
            const gain = xpCum[i] - xpCum[i - 1];
            if (gain <= 0) continue;
            const t = xs[i];
            if (t < T0 || t > T1) continue;
            const Z = Math.max(0, Math.min(t + W, T1) - Math.max(t - W, T0));
            if (Z <= 0) continue;
            evT.push(t);
            evWt.push(gain / Z);
        }
        if (evT.length === 0) return out;
        let lo = 0, hi = 0;
        for (let i = 0; i < n; i++) {
            const x = xs[i];
            while (hi < evT.length && evT[hi] <= x + W) hi++;
            while (lo < hi && evT[lo] < x - W) lo++;
            let s = 0;
            for (let j = lo; j < hi; j++) s += evWt[j];
            out[i] = s * 3600;
        }
        return out;
    }

    // Per-session average rate: total XP in session / session wall-clock duration * 3600.
    // Returns a flat value per session — useful for comparing sessions directly.
    function buildXpRateSession(sortedRows, xpCum, ptMap) {
        const n = sortedRows.length;
        const out = new Array(n).fill(0);
        const sessXp = new Map();
        for (let i = 0; i < n; i++) {
            const sid = sortedRows[i].sid;
            const e = sessXp.get(sid);
            if (!e) sessXp.set(sid, { firstXp: xpCum[i], lastXp: xpCum[i] });
            else e.lastXp = xpCum[i];
        }
        const rateMap = new Map();
        for (const [sid, { firstXp, lastXp }] of sessXp) {
            const s = ptMap.sessions.find(sess => sess.sid === sid);
            rateMap.set(sid, s && s.duration > 0 ? ((lastXp - firstXp) / s.duration) * 3600 : 0);
        }
        for (let i = 0; i < n; i++) out[i] = rateMap.get(sortedRows[i].sid) ?? 0;
        return out;
    }

    function fmtElapsed(sec) {
        if (sec == null || !isFinite(sec)) return '';
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
        if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
        return `${s}s`;
    }

    function allZero(arr) {
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] != null && arr[i] !== 0) return false;
        }
        return true;
    }

    // Ensure a uPlot scale range is never degenerate [v, v]. uPlot computes a step of 0 for a
    // zero-width scale, loops forever in its splits generator, and blows up with RangeError.
    // Falls back to [min(lo, 0), hi + 1] so a flat series (e.g. constant HP, no XP gained) still
    // shows its value in natural context rather than a 1-unit band at an arbitrary offset.
    function guardRange(lo, hi) {
        return lo < hi ? [lo, hi] : [Math.min(lo, 0), hi + 1];
    }

    // Stride decimation over the FULL arrays. Picks stride = floor(N / targetN) so the output
    // sits between targetN and 2·targetN points. Single increment loop, no per-row decisions.
    // We deliberately do NOT slice to a visible [xMin,xMax] range — the full series is always
    // shipped to uPlot so zoom/pan stays self-consistent (slicing would clip data outside the
    // current view and you'd see truncation past the edges as you panned around). targetN sized
    // generously (~plotW × 4) so even 4× zoom-in still has plenty of points within view.
    // Returns { xs, columns, indexMap } where indexMap[i] is the original index for decimated i.
    function decimateForPlot(xs, columns, targetN) {
        const n = xs.length;
        const stride = Math.max(1, Math.floor(n / targetN));
        if (stride === 1) {
            const idMap = new Array(n);
            for (let i = 0; i < n; i++) idMap[i] = i;
            return { xs, columns, indexMap: idMap };
        }
        const outLen = Math.ceil(n / stride) + 1;
        const outXs = new Array(outLen);
        const outCols = columns.map(() => new Array(outLen));
        const indexMap = new Array(outLen);
        let w = 0;
        for (let i = 0; i < n; i += stride) {
            outXs[w] = xs[i];
            for (let c = 0; c < columns.length; c++) outCols[c][w] = columns[c][i];
            indexMap[w] = i;
            w++;
        }
        if (n > 0 && indexMap[w - 1] !== n - 1) {
            outXs[w] = xs[n - 1];
            for (let c = 0; c < columns.length; c++) outCols[c][w] = columns[c][n - 1];
            indexMap[w] = n - 1;
            w++;
        }
        outXs.length = w;
        for (const col of outCols) col.length = w;
        indexMap.length = w;
        return { xs: outXs, columns: outCols, indexMap };
    }

    function buildTimeline(hostId, data, opts = {}) {
        if (typeof uPlot === 'undefined') { console.warn('uPlot not loaded yet'); return; }
        const host = document.getElementById(hostId);
        if (!host) return;

        destroyTimeline(hostId);

        // Timeline ALWAYS uses the full unfiltered context (rows_all/events_all/kills_all when
        // present) so brush-select on it can target the entire run.
        //
        // data.rows_all is a PollRows (typed-array-backed). Timeline subsequently sorts + builds
        // many per-row derived series, all of which want plain objects — we materialize via
        // .toArray() here. The materialized array is GC'd when buildTimeline returns; the canonical
        // long-lived storage stays as PollRows in runPolls[runKey].
        const rowsPoll = data.rows_all || data.rows;
        const rowsSrc = rowsPoll && typeof rowsPoll.toArray === 'function'
            ? rowsPoll.toArray()
            : (rowsPoll || []);
        const eventsSrc = data.events_all || data.events || [];
        const killsSrc = data.kills_all || data.kills || [];
        if (rowsSrc.length === 0) return;

        // XP/hr smoothing window in playtime-seconds; configurable via opts.xpWindowSec.
        const xpWindowSec = opts.xpWindowSec ?? 120;
        const xpMode = opts.xpMode ?? 'trapezoidal';
        // Active filter window (in real wall-clock seconds); rendered as a translucent overlay so
        // the user sees where the filter is relative to the full run.
        const filterTRange = opts.filterTRange || null;
        // Callback for brush-select on the timeline — receives { t_min, t_max } in real wall-clock.
        const onBrushSelect = opts.onBrushSelect || null;
        // Optional callback fired when the user click-zooms or resets zoom; receives bool isZoomed.
        // App layer uses this to toggle visibility of the "reset zoom" button.
        const onZoomChange = opts.onZoomChange || null;
        // Fired when the user clicks outside the active filter band — app should clear the filter.
        const onFilterClear = opts.onFilterClear || null;
        // Fired on double-click — receives { t_min, t_max } of the session at the cursor in real
        // wall-clock seconds. App should only act if no filter is currently active.
        const onSessionIsolate = opts.onSessionIsolate || null;

        // Sort by wall-clock for cross-session interleaving.
        const sortedRows = rowsSrc.slice().sort((a, b) => a.t - b.t);
        // Dynamic inter-session pad: target SESSION_PAD_PX visual pixels regardless of how long
        // the run is. Plot width minus ~110px axis margin gives effective plot width.
        const widthEarly = host.clientWidth || 800;
        const plotWEarly = Math.max(100, widthEarly - 110);
        const totalRawPt = totalSessionPlaytime(sortedRows);
        const padSec = totalRawPt > 0
            ? Math.max(1, SESSION_PAD_PX * totalRawPt / plotWEarly)
            : 1;
        const ptMap = buildPlaytimeMap(sortedRows, padSec);

        // For druids, rage is only meaningful in Bear and energy is only meaningful in Cat.
        // Outside those forms the values are stale carry-overs (or zero), so null them out per row
        // so uPlot breaks the line — keeps the trace readable instead of a flatline across the run.
        const charClass = data.class;

        const xs = new Array(sortedRows.length);
        const hps = new Array(sortedRows.length);
        const mps = new Array(sortedRows.length);
        const ens = new Array(sortedRows.length);
        const rgs = new Array(sortedRows.length);
        for (let i = 0; i < sortedRows.length; i++) {
            const r = sortedRows[i];
            xs[i] = ptMap.projectT(r.sid, r.t);
            hps[i] = r.hp;
            mps[i] = r.mp;
            if (charClass === 'Druid') {
                const fs = rowFormSpell(r, 'Druid');
                ens[i] = fs === DRUID_CAT_SPELL    ? r.en : null;
                rgs[i] = DRUID_BEAR_SPELLS.has(fs) ? r.rg : null;
            } else {
                ens[i] = r.en;
                rgs[i] = r.rg;
            }
        }
        const xpCum = buildXpCumSeries(sortedRows);
        const xpW = Math.max(1, xpWindowSec);
        const xpT0Init = xs[0];
        const xpT1Init = xs[xs.length - 1];
        let xpRate;
        if (xpMode === 'absolute') {
            xpRate = xpCum;
        } else if (xpMode === 'boxcar') {
            xpRate = buildXpRateBoxcar(xs, xpCum, xpW, xpT0Init, xpT1Init);
        } else if (xpMode === 'session') {
            xpRate = buildXpRateSession(sortedRows, xpCum, ptMap);
        } else {
            xpRate = buildXpRateTrapezoid(xs, xpCum, xpW, xpT0Init, xpT1Init);
        }

        // Project events / kills / dead spans into playtime coords too.
        const events = eventsSrc.map(e => ({ ...e, pt: ptMap.projectT(e.sid, e.t) }));
        const kills = killsSrc.map(k => ({ ...k, pt: ptMap.projectT(k.sid, k.t) }));
        const deadSpans = (data.deadSpans || []).map(s => ({
            sid: s.sid,
            start: ptMap.projectT(s.sid, s.start),
            end: isFinite(s.end) ? ptMap.projectT(s.sid, s.end) : Infinity,
        }));
        // Friction spans (vendor/trainer/mail/bank/ah/taxi/loot/cinematic) — paired SHOW/CLOSED.
        const frictionSpans = computeFrictionSpans(eventsSrc).map(s => ({
            ...s,
            pt_start: ptMap.projectT(s.sid, s.start),
            pt_end: ptMap.projectT(s.sid, s.end),
        }));

        // Jumps derived from poll rows: 0→1 transitions of `falling` per session.
        const jumps = [];
        {
            const lastBySid = new Map();
            for (const r of sortedRows) {
                if (r.falling == null) { continue; }
                const last = lastBySid.get(r.sid);
                if (last === 0 && r.falling === 1) {
                    jumps.push({ t: r.t, sid: r.sid, pt: ptMap.projectT(r.sid, r.t) });
                }
                lastBySid.set(r.sid, r.falling);
            }
        }

        // Combat spans derived from poll rows: runs where combat is truthy.
        const combatSpans = [];
        {
            const openBySid = new Map();
            const lastPtBySid = new Map();
            for (const r of sortedRows) {
                const pt = ptMap.projectT(r.sid, r.t);
                lastPtBySid.set(r.sid, pt);
                const open = openBySid.has(r.sid);
                if (r.combat && !open) {
                    openBySid.set(r.sid, pt);
                } else if (!r.combat && open) {
                    combatSpans.push({ start: openBySid.get(r.sid), end: pt });
                    openBySid.delete(r.sid);
                }
            }
            for (const [sid, ptStart] of openBySid) {
                combatSpans.push({ start: ptStart, end: lastPtBySid.get(sid) ?? ptStart });
            }
        }

        // Spell casts from UNIT_SPELLCAST_SUCCEEDED events. Pre-enriched server-side with name/rank.
        const spellCasts = eventsSrc
            .filter(e => e.event === 'UNIT_SPELLCAST_SUCCEEDED')
            .map(e => ({
                t: e.t, sid: e.sid,
                pt: ptMap.projectT(e.sid, e.t),
                spell_id: e.spell_id,
                spell_name: e.spell_name,
                spell_rank: e.spell_rank,
            }));

        // Inverse mapping: playtime → real wall-clock t. Used by brush-select to convert the
        // selected playtime range back to (t_min, t_max) for the filter API.
        const ptToT = (pt) => {
            for (const s of ptMap.sessions) {
                if (pt >= s.playStart - 0.001 && pt <= s.playEnd + 0.001) return pt - s.offset;
            }
            // Outside any session — clamp to bounds.
            if (ptMap.sessions.length === 0) return null;
            if (pt < ptMap.sessions[0].playStart) return ptMap.sessions[0].min;
            const last = ptMap.sessions[ptMap.sessions.length - 1];
            return last.max;
        };
        const tToPt = (t, sid) => sid ? ptMap.projectT(sid, t) : t; // sid required for accuracy

        // Session color lookup (matches trajectory legend).
        const sessionColors = new Map((data.legend || []).map(l => [l.sid, l.color]));

        // Decide which resource series to show — drop ones that are all-zero across the run.
        const showMp = !allZero(mps);
        const showEn = !allZero(ens);
        const showRg = !allZero(rgs);
        const showXp = !allZero(xpRate);

        const winMin = Math.round(xpWindowSec / 60);
        const xpLabel = xpMode === 'absolute' ? 'XP gained'
            : xpMode === 'session' ? 'XP/hr (session avg)'
            : xpMode === 'boxcar'  ? `XP/hr (${winMin}m box)`
            : `XP/hr (${winMin}m smooth)`;
        const series = [
            {},
            ...(showXp ? [{ label: xpLabel, scale: 'xp', stroke: 'gold', width: 1.5, points: { show: false } }] : []),
            { label: 'HP', scale: 'hp', stroke: '#ff6b6b', width: 1, points: { show: false } },
        ];
        const seriesData = [xs, ...(showXp ? [xpRate] : []), hps];
            if (showMp) { series.push({ label: 'Mana', scale: 'mp', stroke: '#5b8df5', width: 1, points: { show: false } }); seriesData.push(mps); }
            if (showEn) { series.push({ label: 'Energy', scale: 'en', stroke: '#ffd060', width: 1, points: { show: false } }); seriesData.push(ens); }
            if (showRg) { series.push({ label: 'Rage', scale: 'rg', stroke: '#ff9050', width: 1, points: { show: false } }); seriesData.push(rgs); }

        // Stride-decimate the full master arrays once. Logger runs at 10Hz so a 1h run is 36k
        // samples — even at 4× zoom that's still 9k points visible, way more than plot pixels.
        // We target ~plotW × 4 so per-pixel detail stays good across reasonable zoom levels
        // without re-decimating on every scale change (which previously clipped data outside
        // the visible window and made zoom-in look like missing data). fullSeriesData stays in
        // closure for the setScale hook to recompute xpRate against the FULL xs.
        const fullSeriesData = seriesData; // [xs, xpRate, hps, mps?, ens?, rgs?]
        function decimateAll() {
            const plotW = host.clientWidth || 800;
            const targetN = Math.max(2000, plotW * 4);
            const cols = fullSeriesData.slice(1);
            const dec = decimateForPlot(fullSeriesData[0], cols, targetN);
            return { data: [dec.xs, ...dec.columns], indexMap: dec.indexMap };
        }
        let decimated = decimateAll();
        let displayData = decimated.data;
        let displayIndexMap = decimated.indexMap;

        const width = host.clientWidth || 800;
        // Reserve space ABOVE the plot for the mini-timeline (jump / spell / stance). Below the plot
        // would collide with the X-axis tick labels — uPlot pins those just under the axis line and
        // there's no clean way to push them to the bottom of the axis box.
        // 3 strips for all classes: jump + spell + stance. The stance strip carries form segments
        // (for shapeshifters), mounted overlay, and stealth overlay — useful for every class.
        const STRIP_COUNT = 3;
        const MINI_STRIPS_PX = 4 + STRIP_COUNT * 6 + (STRIP_COUNT - 1) * 2 + 2; // top inset + strips + bottom slack
        const height = 280 + MINI_STRIPS_PX;
        const X_AXIS_SIZE = 50;

        // Convert wall-clock t back to playtime by finding which session contains t (or clamp
        // to the nearest session edge if t is in a gap).
        const realTToPt = (t) => {
            const ss = ptMap.sessions;
            if (!ss.length) return 0;
            if (t <= ss[0].min) return ss[0].playStart;
            for (const s of ss) {
                if (t >= s.min && t <= s.max) return t + s.offset;
            }
            for (let i = 0; i < ss.length - 1; i++) {
                if (t > ss[i].max && t < ss[i + 1].min) return ss[i].playEnd;
            }
            return ss[ss.length - 1].playEnd;
        };

        const uPlotOpts = {
            width, height,
            // Reserve MINI_STRIPS_PX of canvas above the plot bbox for the jump/spell/stance mini-timeline.
            padding: [MINI_STRIPS_PX, null, null, null],
scales: {
            x: { time: false },
            xp: {
                range: (u, min, max) => {
                    if (xpMode === 'absolute') return guardRange(0, max * 1.05 + 1);
                    u._xpMin = min;
                    const span = max - min;
                    return guardRange(min - (span * 0.5), max);
                }
            },
            hp: {
                auto: true,
                range: (u, min, max) => {
                    const span = max - min;
                    // Extends the bottom by 50% to push HP into the top 2/3
                    return guardRange(min - (span * 0.5), max);
                }
            },
            mp: { auto: true, range: (u, min, max) => guardRange(0, max * 3) },
            en: { auto: true, range: (u, min, max) => guardRange(0, max * 3) },
            rg: { auto: true, range: (u, min, max) => guardRange(0, max * 3) },
        },
        axes: [
            { stroke: '#888', grid: { stroke: '#222', width: 1 }, values: (u, vals) => vals.map(fmtElapsed), size: X_AXIS_SIZE },
            ...(showXp ? [{
                scale: 'xp', stroke: 'gold', grid: { stroke: '#1a1a1a', width: 1 }, size: 60,
                filter: (u, splits) => splits.filter(v => v >= (xpMode === 'absolute' ? 0 : (u._xpMin || 0)))
            }] : []),
            { scale: 'hp', side: 1, size: 50, stroke: 'transparent', grid: { show: false }, values: () => [] },
            { scale: 'mp', side: 1, size: 0,  stroke: 'transparent', grid: { show: false }, values: () => [] },
            { scale: 'en', side: 1, size: 0,  stroke: 'transparent', grid: { show: false }, values: () => [] },
            { scale: 'rg', side: 1, size: 0,  stroke: 'transparent', grid: { show: false }, values: () => [] },
        ],
          series,
          // drag.setScale=false → dragging draws a selection rectangle WITHOUT zooming. setSelect
          // hook converts the selection to a wall-clock range and notifies the app for filtering.
          cursor: {
            points: { size: 6 },
            drag: { x: true, y: false, setScale: false },
          },
          legend: { show: true },
          hooks: {
            // Recompute the XP/hr series against the currently visible x-range so the
            // mass-conservation + flat-line-at-large-W properties hold for the visible slice
            // (the smoothing kernel needs to know the slice bounds to renormalize). Then
            // re-decimate the FULL series — we don't slice to the visible range any more,
            // since that caused data to disappear past the edges of zoomed views.
            setScale: [
              function recomputeOnZoom(u, key) {
                if (key !== 'x') return;
                const sc = u.scales.x;
                if (sc.min == null || sc.max == null) return;
                if (u.__xpLastT0 === sc.min && u.__xpLastT1 === sc.max) return;
                u.__xpLastT0 = sc.min;
                u.__xpLastT1 = sc.max;
                if (showXp && (xpMode === 'trapezoidal' || xpMode === 'boxcar')) {
                    fullSeriesData[1] = xpMode === 'boxcar'
                        ? buildXpRateBoxcar(xs, xpCum, xpW, sc.min, sc.max)
                        : buildXpRateTrapezoid(xs, xpCum, xpW, sc.min, sc.max);
                }
                const next = decimateAll();
                displayData = next.data;
                displayIndexMap = next.indexMap;
                u.__indexMap = displayIndexMap;
                u.setData(displayData, false);
              },
            ],
            // setCursor fires AFTER uPlot updates its built-in cursor + legend. Using this
            // (rather than overriding cursor.bind.mousemove) preserves the live value readout
            // at the bottom that we previously broke. Map the decimated cursor.idx back
            // through indexMap so the hover handler still sees the original poll row.
            setCursor: [
              function forwardCursor(u) {
                const idx = u.cursor.idx;
                const origIdx = (idx != null && u.__indexMap) ? u.__indexMap[idx] : idx;
                const row = (origIdx != null && sortedRows[origIdx]) ? sortedRows[origIdx] : null;
                if (window.__onTimelineHover) window.__onTimelineHover(hostId, row);
              },
            ],
            // setSelect fires on every mouseup uPlot's drag intercepted. We only treat it as a
            // brush when the user clearly moved (>=8px) — smaller motions are handled by the
            // mousedown/mouseup pair below as clicks, since uPlot's width=0 reading is flaky
            // when the user drifts even 3-4px during a click.
            setSelect: [
            function forwardSelect(u) {
              if (!onBrushSelect) return;
              const sel = u.select;
              if (!sel || sel.width < 8) return;
              const ptStart = u.posToVal(sel.left, 'x');
              const ptEnd = u.posToVal(sel.left + sel.width, 'x');
              const tStart = ptToT(ptStart);
              const tEnd = ptToT(ptEnd);
              if (tStart != null && tEnd != null) {
                onBrushSelect({ t_min: tStart, t_max: tEnd });
              }
            },
            ],
            draw: [
            function drawOverlays(u) {
              const ctx = u.ctx;
              const plotT = u.bbox.top;
              const plotH = u.bbox.height;
              // Hoverables rebuilt per draw. Each entry has hitX0/hitX1/hitY0/hitY1 (canvas
              // pixels — `valToPos` is already in canvas pixel space when can=true) + label.
              const hover = [];

              // Session-color background bands (drawn first, behind everything).
              ctx.save();
              for (const s of ptMap.sessions) {
                const x0 = u.valToPos(s.playStart, 'x', true);
                const x1 = u.valToPos(s.playEnd, 'x', true);
                const color = sessionColors.get(s.sid) || '#444';
                ctx.fillStyle = hexAlpha(color, 0.12);
                ctx.fillRect(x0, plotT, Math.max(1, x1 - x0), plotH);
              }
              ctx.restore();

              // Dead intervals — grey shading + hoverable for "died here" tooltip.
              ctx.save();
              ctx.fillStyle = 'rgba(120,120,120,0.25)';
              for (const s of deadSpans) {
                const x0 = u.valToPos(s.start, 'x', true);
                const x1 = u.valToPos(isFinite(s.end) ? s.end : u.scales.x.max, 'x', true);
                ctx.fillRect(x0, plotT, Math.max(1, x1 - x0), plotH);
                const durSec = isFinite(s.end) ? (s.end - s.start) : 0;
                hover.push({
                  hitX0: x0, hitX1: x1, hitY0: plotT + plotH - 14, hitY1: plotT + plotH,
                  label: `Dead for ${fmtElapsed(durSec)}`,
                  priority: 1,
                });
              }
              ctx.restore();

              // Friction strip — colored bars at top of plot showing menu-time per type.
              // 6px tall, just above the resource series. Multiple types may overlap; alpha
              // blends them.
              const FRICTION_Y = plotT;
              const FRICTION_H = 6;
              ctx.save();
              for (const fs of frictionSpans) {
                const x0 = u.valToPos(fs.pt_start, 'x', true);
                const x1 = u.valToPos(fs.pt_end, 'x', true);
                const w = Math.max(2, x1 - x0); // min 2px so zero-duration orphans show
                ctx.fillStyle = hexAlpha(fs.color, fs.orphan ? 0.9 : 0.7);
                ctx.fillRect(x0, FRICTION_Y, w, FRICTION_H);
                const durSec = fs.end - fs.start;
                const tag = fs.orphan ? ' (close only)' : (fs.openEnded ? ' (still open at end)' : '');
                hover.push({
                  hitX0: x0, hitX1: x0 + w, hitY0: FRICTION_Y, hitY1: FRICTION_Y + FRICTION_H,
                  label: `${fs.kind}: ${fmtElapsed(durSec)}${tag}`,
                  priority: 3,
                });
              }
              ctx.restore();

              // Mail ticks — instant marks (MAIL_CLOSED doesn't fire in TBC).
              ctx.save();
              ctx.fillStyle = '#ff9050';
              for (const e of events) {
                if (e.event !== 'MAIL_SHOW') continue;
                const x = u.valToPos(e.pt, 'x', true);
                ctx.fillRect(x - 1, FRICTION_Y, 2, FRICTION_H);
                hover.push({
                  hitX0: x - 3, hitX1: x + 3, hitY0: FRICTION_Y, hitY1: FRICTION_Y + FRICTION_H,
                  label: 'Mailbox opened',
                  priority: 3,
                });
              }
              ctx.restore();

              // Level-ups — full-height dashed cyan. Hoverable rect is a thin column near
              // the top of the plot so it doesn't steal hover from everything below.
              ctx.save();
              ctx.strokeStyle = '#a4f0ff';
              ctx.setLineDash([3, 3]);
              for (const e of events) {
                if (e.event !== 'PLAYER_LEVEL_UP') continue;
                const x = u.valToPos(e.pt, 'x', true);
                ctx.beginPath(); ctx.moveTo(x, plotT); ctx.lineTo(x, plotT + plotH); ctx.stroke();
                const args = e.payload && e.payload.args;
                const lvl = args ? args[0] : '?';
                hover.push({
                  hitX0: x - 3, hitX1: x + 3, hitY0: plotT + FRICTION_H, hitY1: plotT + FRICTION_H + 24,
                  label: `Level up → ${lvl}`,
                  priority: 4,
                });
              }
              ctx.restore();

              // Quest turn-ins (top) — gold ticks just below the friction strip.
              ctx.save();
              ctx.strokeStyle = 'gold';
              ctx.lineWidth = 2;
              for (const e of events) {
                if (e.event !== 'QUEST_TURNED_IN') continue;
                const x = u.valToPos(e.pt, 'x', true);
                ctx.beginPath(); ctx.moveTo(x, plotT + FRICTION_H); ctx.lineTo(x, plotT + FRICTION_H + 8); ctx.stroke();
                const args = e.payload && e.payload.args;
                const xp = args && args[1] ? `+${args[1]} xp` : '';
                const money = args && args[2] ? `, +${args[2]}c` : '';
                const id = args ? args[0] : '?';
                hover.push({
                  hitX0: x - 4, hitX1: x + 4, hitY0: plotT + FRICTION_H, hitY1: plotT + FRICTION_H + 14,
                  label: `Quest #${id} turned in${xp ? ' (' + xp + money + ')' : ''}`,
                  priority: 5,
                });
              }
              ctx.restore();

              // Quest accepts — smaller gold ticks (faded).
              ctx.save();
              ctx.strokeStyle = 'rgba(255, 215, 0, 0.5)';
              ctx.lineWidth = 1;
              for (const e of events) {
                if (e.event !== 'QUEST_ACCEPTED') continue;
                const x = u.valToPos(e.pt, 'x', true);
                ctx.beginPath(); ctx.moveTo(x, plotT + FRICTION_H); ctx.lineTo(x, plotT + FRICTION_H + 4); ctx.stroke();
                const args = e.payload && e.payload.args;
                const id = args && args[1] ? args[1] : '?';
                hover.push({
                  hitX0: x - 3, hitX1: x + 3, hitY0: plotT + FRICTION_H, hitY1: plotT + FRICTION_H + 8,
                  label: `Quest accepted (#${id})`,
                  priority: 5,
                });
              }
              ctx.restore();

              // Deaths — small hollow circle at bottom near the kill ticks region.
              ctx.save();
              ctx.strokeStyle = '#fff';
              ctx.lineWidth = 1.5;
              for (const e of events) {
                if (e.event !== 'PLAYER_DEAD') continue;
                const x = u.valToPos(e.pt, 'x', true);
                ctx.beginPath();
                ctx.arc(x, plotT + plotH - 10, 3, 0, Math.PI * 2);
                ctx.stroke();
                hover.push({
                  hitX0: x - 5, hitX1: x + 5, hitY0: plotT + plotH - 15, hitY1: plotT + plotH - 5,
                  label: 'Death' + (e.z ? ` (${e.z})` : ''),
                  priority: 5,
                });
              }
              ctx.restore();

              // Kill ticks (bottom) — red.
              ctx.save();
              ctx.strokeStyle = '#ff5470';
              ctx.lineWidth = 1;
              for (const k of kills) {
                const x = u.valToPos(k.pt, 'x', true);
                ctx.beginPath(); ctx.moveTo(x, plotT + plotH - 6); ctx.lineTo(x, plotT + plotH); ctx.stroke();
                hover.push({
                  hitX0: x - 3, hitX1: x + 3, hitY0: plotT + plotH - 8, hitY1: plotT + plotH,
                  label: 'Kill: ' + (k.dest_name || 'unknown'),
                  priority: 6,
                });
              }
              ctx.restore();

               // Mini-timeline ABOVE bbox: jump / spell-cast / stance.
              // Below the bbox collides with uPlot's X-axis tick labels (it pins them just
              // under the axis line). So we reserved MINI_STRIPS_PX of top padding via
               // uPlotOpts.padding and draw the mini-timeline up there. Order, top → bottom:
              // jump, spell, stance (stance closest to the plot since it's most "game-state").
              const STRIP_H = 6;
               const STRIP_GAP = 2;
              const stripLeft = u.bbox.left;
              const stripRight = u.bbox.left + u.bbox.width;
              const jumpY   = plotT - MINI_STRIPS_PX + 4;
              const spellY  = jumpY + STRIP_H + STRIP_GAP;
              const stanceY = spellY + STRIP_H + STRIP_GAP;

              // Strip backgrounds (faint) so the rows are discoverable even when empty.
              ctx.save();
              ctx.fillStyle = 'rgba(255,255,255,0.04)';
              ctx.fillRect(stripLeft, jumpY,   stripRight - stripLeft, STRIP_H);
              ctx.fillRect(stripLeft, spellY,  stripRight - stripLeft, STRIP_H);
              ctx.fillRect(stripLeft, stanceY, stripRight - stripLeft, STRIP_H);
              ctx.restore();

              // Combat segments (red).
              ctx.save();
              ctx.fillStyle = 'rgba(220, 50, 50, 0.65)';
              for (const s of combatSpans) {
                const x0 = u.valToPos(s.start, 'x', true);
                const x1 = u.valToPos(s.end, 'x', true);
                ctx.fillRect(x0, jumpY, Math.max(1, x1 - x0), STRIP_H);
              }
              ctx.restore();

              // Dead segments (pale teal) — overwrites combat/eat since they're exclusive.
              ctx.save();
              ctx.fillStyle = 'rgba(100, 210, 195, 0.75)';
              for (const s of deadSpans) {
                const x0 = u.valToPos(s.start, 'x', true);
                const x1 = u.valToPos(isFinite(s.end) ? s.end : u.scales.x.max, 'x', true);
                ctx.fillRect(x0, jumpY, Math.max(1, x1 - x0), STRIP_H);
              }
              ctx.restore();

              // Jump ticks — 1px wide, cyan-ish.
              ctx.save();
              ctx.fillStyle = '#9accff';
              for (const j of jumps) {
                const x = u.valToPos(j.pt, 'x', true);
                ctx.fillRect(x - 0.5, jumpY, 1, STRIP_H);
                hover.push({
                  hitX0: x - 2, hitX1: x + 2, hitY0: jumpY - 1, hitY1: jumpY + STRIP_H + 1,
                  label: 'Jump',
                  priority: 2,
                });
              }
              ctx.restore();

              // Spell-cast ticks — 1px wide, purple. Tooltip uses pre-enriched spell_name.
              ctx.save();
              ctx.fillStyle = '#c586c0';
              for (const c of spellCasts) {
                const x = u.valToPos(c.pt, 'x', true);
                ctx.fillRect(x - 0.5, spellY, 1, STRIP_H);
                const label = c.spell_name
                  ? (c.spell_rank ? `${c.spell_name} (${c.spell_rank})` : c.spell_name)
                  : `Spell #${c.spell_id ?? '?'}`;
                hover.push({
                  hitX0: x - 2, hitX1: x + 2, hitY0: spellY - 1, hitY1: spellY + STRIP_H + 1,
                  label,
                  priority: 2,
                });
              }
              ctx.restore();

              // Stance/Form strip — solid blocks per active form, segmented by spell-ID transitions.
              // Shown for all classes. rowFormSpell handles form_spell→form (legacy) fallback.
              // Rogues have no shapeshift forms so their strip base stays the faint background;
              // the mounted and stealth overlays below still render on top of it.
              if (charClass !== 'Rogue') {
                ctx.save();
                const flushStance = (spell, x0, x1) => {
                  if (spell == null || x1 <= x0) return;
                  const config = STANCE_BY_SPELL[spell] || STANCE_DEFAULT;
                  ctx.fillStyle = config.color;
                  ctx.fillRect(x0, stanceY, x1 - x0, STRIP_H);
                  hover.push({
                    hitX0: x0, hitX1: x1, hitY0: stanceY, hitY1: stanceY + STRIP_H,
                    label: config.name,
                    priority: 2,
                  });
                };
                let curSpell = null;
                let segX0 = 0;
                for (let i = 0; i < sortedRows.length; i++) {
                  const spell = rowFormSpell(sortedRows[i], charClass);
                  const x = u.valToPos(xs[i], 'x', true);
                  if (i === 0) { curSpell = spell; segX0 = x; continue; }
                  if (spell !== curSpell) {
                    flushStance(curSpell, segX0, x);
                    curSpell = spell;
                    segX0 = x;
                  }
                  if (i === sortedRows.length - 1) {
                    flushStance(curSpell, segX0, x);
                  }
                }
                ctx.restore();
              }

              // Mounted overlay — warm gold band on the stance strip while player is mounted.
              // Drawn on top of form base so it's visible for all classes regardless of form.
              ctx.save();
              ctx.fillStyle = MOUNTED_OVERLAY_FILL;
              {
                const flushMounted = (x0, x1) => {
                  if (x1 <= x0) return;
                  ctx.fillRect(x0, stanceY, x1 - x0, STRIP_H);
                  hover.push({
                    hitX0: x0, hitX1: x1, hitY0: stanceY, hitY1: stanceY + STRIP_H,
                    label: 'Mounted',
                    priority: 3,
                  });
                };
                let onMount = false;
                let segX0 = 0;
                for (let i = 0; i < sortedRows.length; i++) {
                  const m = sortedRows[i].mnt ? true : false;
                  const x = u.valToPos(xs[i], 'x', true);
                  if (i === 0) { onMount = m; segX0 = x; continue; }
                  if (m !== onMount) {
                    if (onMount) flushMounted(segX0, x);
                    onMount = m;
                    segX0 = x;
                  }
                  if (i === sortedRows.length - 1 && onMount) {
                    flushMounted(segX0, x);
                  }
                }
              }
              ctx.restore();

              // Stealth overlay — purple band painted on the stance strip during stealthed periods.
              // Drawn last so it composites on top of both form and mounted. Priority 4 beats
              // mounted (3) so a stealthed Druid Cat reads "Stealth" not "Mounted" in the tooltip.
              ctx.save();
              ctx.fillStyle = STEALTH_OVERLAY_FILL;
              {
                const flushStealth = (x0, x1) => {
                  if (x1 <= x0) return;
                  ctx.fillRect(x0, stanceY, x1 - x0, STRIP_H);
                  hover.push({
                    hitX0: x0, hitX1: x1, hitY0: stanceY, hitY1: stanceY + STRIP_H,
                    label: 'Stealth',
                    priority: 4,
                  });
                };
                let inStealth = false;
                let segX0 = 0;
                for (let i = 0; i < sortedRows.length; i++) {
                  const s = sortedRows[i].stealth ? true : false;
                  const x = u.valToPos(xs[i], 'x', true);
                  if (i === 0) { inStealth = s; segX0 = x; continue; }
                  if (s !== inStealth) {
                    if (inStealth) flushStealth(segX0, x);
                    inStealth = s;
                    segX0 = x;
                  }
                  if (i === sortedRows.length - 1 && inStealth) {
                    flushStealth(segX0, x);
                  }
                }
              }
              ctx.restore();

              // Active filter overlay — dim the areas OUTSIDE the filter window so the
              // active region pops. Visually distinct from session bands and dead spans.
              if (filterTRange && filterTRange.t_min != null && filterTRange.t_max != null) {
                const ptMin = realTToPt(filterTRange.t_min);
                const ptMax = realTToPt(filterTRange.t_max);
                const xMin = u.valToPos(ptMin, 'x', true);
                const xMax = u.valToPos(ptMax, 'x', true);
                ctx.save();
                ctx.fillStyle = 'rgba(14, 16, 20, 0.55)';
                // Left dim
                if (xMin > u.bbox.left) ctx.fillRect(u.bbox.left, plotT, xMin - u.bbox.left, plotH);
                // Right dim
                const right = u.bbox.left + u.bbox.width;
                if (xMax < right) ctx.fillRect(xMax, plotT, right - xMax, plotH);
                // Edge accent lines
                ctx.strokeStyle = '#7cc4ff';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(xMin, plotT); ctx.lineTo(xMin, plotT + plotH); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(xMax, plotT); ctx.lineTo(xMax, plotT + plotH); ctx.stroke();
                ctx.restore();
              }

              // Stash hoverables on the uPlot instance so the mousemove handler can find them.
              u.__hoverables = hover;
            },
            ],
          },
        };

      const u = new uPlot(uPlotOpts, displayData, host);
      // Cache the playtime → real timestamp inverse for tooltip linking back to wall-clock.
      u.__pt = ptMap;
      u.__sortedRows = sortedRows;
      u.__indexMap = displayIndexMap;
      // Pre-seed the setScale-hook cache with the initial range we already computed against,
      // so uPlot's first internal setScale fire doesn't redundantly rebuild the rate series.
      u.__xpLastT0 = xpT0Init;
      u.__xpLastT1 = xpT1Init;

       // Hover-tooltip handler on the host element (NOT u.over) so the mini-timeline below the bbox
      // also get tooltips. uPlot's over div only covers the plot area; events bubble from over
      // up to host, so host gets all mouse events for the whole canvas. We measure relative to
      // the canvas element so the coords map directly to the hit rects we built with valToPos.
      const tipCanvas = u.ctx.canvas;
      const showTip = window.showCanvasTooltip;
      const hideTip = window.hideCanvasTooltip;
      const hoverHandler = (e) => {
        if (!showTip || !u.__hoverables) return;
        const rect = tipCanvas.getBoundingClientRect();
        const dpr = u.pxRatio || (window.devicePixelRatio || 1);
        // Canvas origin (0,0) in canvas pixels = top-left of canvas in CSS coords. Multiply
        // CSS mouse offset by pxRatio to get canvas pixel position — directly comparable to
        // the hit rects in u.__hoverables (which used valToPos with can=true).
        const mx = (e.clientX - rect.left) * dpr;
        const my = (e.clientY - rect.top) * dpr;
        let best = null;
        for (const h of u.__hoverables) {
          if (mx < h.hitX0 || mx > h.hitX1 || my < h.hitY0 || my > h.hitY1) continue;
          if (!best || h.priority > best.priority) best = h;
        }
        if (best) showTip(e.clientX, e.clientY, best.label);
        else hideTip && hideTip();
      };
      const leaveHandler = () => { hideTip && hideTip(); };
      host.addEventListener('mousemove', hoverHandler);
      host.addEventListener('mouseleave', leaveHandler);

      // Click detection: tracks mousedown→mouseup pairs, classifies as click only if motion
      // stayed under 5px. setSelect's drag threshold is 8px so the two never overlap. Inside
      // the active filter band → zoom; outside → clear the filter.
      let mouseDown = null;
      const mouseDownHandler = (e) => {
        if (e.button !== 0) return;
        mouseDown = { x: e.clientX, y: e.clientY };
      };
      const mouseUpHandler = (e) => {
        if (!mouseDown || e.button !== 0) return;
        const dx = Math.abs(e.clientX - mouseDown.x);
        const dy = Math.abs(e.clientY - mouseDown.y);
        mouseDown = null;
        if (dx > 5 || dy > 5) return;
        if (!filterTRange) return;
        const overRect = u.over.getBoundingClientRect();
        const ox = e.clientX - overRect.left;
        const oy = e.clientY - overRect.top;
        // Restrict to the plot area; clicks on legend/axes shouldn't trigger zoom/reset.
        if (ox < 0 || ox > u.over.clientWidth || oy < 0 || oy > u.over.clientHeight) return;
        const ptClick = u.posToVal(ox, 'x');
        const ptMin = realTToPt(filterTRange.t_min);
        const ptMax = realTToPt(filterTRange.t_max);
        if (ptClick >= ptMin && ptClick <= ptMax) {
          u.setScale('x', { min: ptMin, max: ptMax });
          if (onZoomChange) onZoomChange(true);
        } else if (onFilterClear) {
          onFilterClear();
        }
      };
      host.addEventListener('mousedown', mouseDownHandler);
      host.addEventListener('mouseup', mouseUpHandler);

      // Double-click → isolate clicked session by setting filter to its real-t range.
      const dblClickHandler = (e) => {
        if (!onSessionIsolate) return;
        const overRect = u.over.getBoundingClientRect();
        const ox = e.clientX - overRect.left;
        const oy = e.clientY - overRect.top;
        if (ox < 0 || ox > u.over.clientWidth || oy < 0 || oy > u.over.clientHeight) return;
        const pt = u.posToVal(ox, 'x');
        for (const s of ptMap.sessions) {
          if (pt >= s.playStart && pt <= s.playEnd) {
            onSessionIsolate({ t_min: s.min, t_max: s.max });
            return;
          }
        }
      };
      host.addEventListener('dblclick', dblClickHandler);

      // Track host size changes (window resize, sidebar toggle, etc.) and call uPlot's setSize.
      // rAF-coalesced so a drag-resize doesn't fire 60×/sec — also re-decimates against the new
      // pixel width via the existing setScale path. We pass the same height so only width tracks.
      let resizeRaf = 0;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          const w = host.clientWidth;
          if (w > 0 && w !== u.width) u.setSize({ width: w, height });
        });
      });
      resizeObserver.observe(host);

      TIMELINE_INSTANCES.set(hostId, {
        uplot: u, hostEl: host, resizeObserver,
        hoverHandler, leaveHandler, mouseDownHandler, mouseUpHandler, dblClickHandler,
      });
    }

  // Reset the x scale to the full data range. Called from the app when the user clicks the
  // "reset zoom" button. No-op if the timeline isn't built or has no data.
  function resetTimelineZoom(hostId) {
    const inst = TIMELINE_INSTANCES.get(hostId);
    if (!inst?.uplot) return;
    const u = inst.uplot;
    const xs = u.data?.[0];
    if (!xs || xs.length === 0) return;
    u.setScale('x', { min: xs[0], max: xs[xs.length - 1] });
  }

  function destroyTimeline(hostId) {
    const inst = TIMELINE_INSTANCES.get(hostId);
    if (inst) {
      try { inst.hostEl.removeEventListener('mousemove', inst.hoverHandler); } catch { /* ignore */ }
      try { inst.hostEl.removeEventListener('mouseleave', inst.leaveHandler); } catch { /* ignore */ }
      try { inst.hostEl.removeEventListener('mousedown', inst.mouseDownHandler); } catch { /* ignore */ }
      try { inst.hostEl.removeEventListener('mouseup', inst.mouseUpHandler); } catch { /* ignore */ }
      try { inst.hostEl.removeEventListener('dblclick', inst.dblClickHandler); } catch { /* ignore */ }
      try { inst.resizeObserver && inst.resizeObserver.disconnect(); } catch { /* ignore */ }
      try { inst.uplot.destroy(); } catch { /* ignore */ }
      TIMELINE_INSTANCES.delete(hostId);
    }
  }

  // Convert an `hsl(...)` or `#rrggbb` color into an rgba with the given alpha.
  function hexAlpha(color, alpha) {
    if (color.startsWith('hsl')) {
      // Replace hsl(h, s%, l%) with hsla(h, s%, l%, alpha).
      return color.replace(/^hsl\((.+)\)$/, (_, inner) => `hsla(${inner}, ${alpha})`);
    }
    if (color.startsWith('#') && color.length === 7) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
  }

  window.buildTimeline = buildTimeline;
  window.destroyTimeline = destroyTimeline;
  window.resetTimelineZoom = resetTimelineZoom;
  window.__TIMELINES = TIMELINE_INSTANCES;
})();
