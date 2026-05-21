import { computeEfficiency } from './analysis/metrics/efficiency.mjs';
// Front-page state: poll /api/snapshot, render run cards. On expand, fetch /api/runs/:key/poll
// for trajectory drawing.
//
// IMPORTANT: this script must execute BEFORE alpine.cdn.js so the alpine:init
// listener is registered before Alpine.start() fires (as a microtask between
// the two script executions). index.html loads us with no defer, ahead of Alpine.

const POLL_INTERVAL_MS = 5000;

// TBC level cap. Change here when adding Wrath (80), Cata (85), etc.
// TODO: derive dynamically from sessions.client_tocversion in the API snapshot
//       (tocversion 20500 = TBC/70, 30300 = WotLK/80, …) so expansion upgrades
//       don't require a code change.
// TODO: once max-level tracking is confirmed stable, add reputation-gain
//       visualisation — rep column on splits, rep/hr in the session legend.
const GAME_MAX_LEVEL = 70;

// Visible gap in seconds — when consecutive poll rows are farther apart than this,
// break the path (logout/dc rather than continuous movement).
const PATH_GAP_SEC = 2;

// Max plausible normalized-coord movement between two consecutive poll rows. Anything past this
// is a teleport (hearthstone, taxi end, spirit healer rez, /reload landing). Blink is ~20 yards
// (~0.007 normalized in a typical zone); mounted speed at 10Hz is ~1.7 yd/tick. 0.015 catches
// teleports while allowing 5x mounted-jitter overhead.
const PATH_TELEPORT_DIST = 0.015;

// Per-segment opacity buckets keyed by world-yard distance between the two endpoints.
// Slow movement (idle/walking/running) stays near 0.70; Blink (~20 yd in one tick) hits 0.40.
// Five 4-yard-wide buckets: [0-4), [4-8), [8-12), [12-16), [16+).
const SPEED_ALPHA_BUCKETS = [0.70, 0.64, 0.58, 0.52, 0.40];
function alphaForDist(d) {
    return SPEED_ALPHA_BUCKETS[Math.min(4, Math.floor(d / 4))];
}

document.addEventListener('alpine:init', () => {
    Alpine.data('snapshotApp', () => ({
       snap: { generated_at: 0, counts: {}, runs: [] },
        loaded: false,
        lastFetchAt: 0,
        expanded: {},          // runKey -> bool
        runLimit: 4,           // max sessions to show per run (4, 8, 16, 32, 64, "all"=unlimited)
        runPolls: {},          // runKey -> { rows, zones[{name,count}], legend[{sid,label,color}] }
        selectedZone: {},      // runKey -> zone name
        zoomView: {},          // runKey -> { scale, panX, panY } in canvas-pixel coords
        zoomBound: {},         // runKey -> true once mouse handlers attached
        hoverPoint: {},        // runKey -> { x, y, sid, t } currently hovered on timeline (for cross-view linking)
        colorByLevel: false,
        filters: {},           // runKey -> { lvl_min, lvl_max, t_min, t_max } — only EXPLICITLY-set fields present
        xpWindow: {},          // runKey -> seconds for XP/hr smoothing (default 120 = 2m)
        xpMode: {},            // runKey -> 'trapezoidal' | 'boxcar' | 'session' | 'absolute'
        timelineZoomed: {},    // runKey -> bool; reflects whether the timeline x-scale is zoomed in
        _filterDebounce: {},   // runKey -> setTimeout handle for debounced refetch
        _timer: null,
        _refreshTimer: null,
        // Per-run snapshot signatures from the LAST poll. We diff fresh snapshot fields against
        // these to decide (a) whether an expanded run needs a full /poll refetch, and (b) whether
        // a session_count increase warrants auto-scroll. Without this, fetchNow refetches the
        // whole multi-MB poll dataset for every expanded card every 5s even when nothing changed.
        _runSig: {},           // runKey -> { session_count, poll_rows, event_rows, cleu_rows, last_seen }

        start() {
            this.fetchNow();
            this._timer = setInterval(() => this.fetchNow(), POLL_INTERVAL_MS);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') this.fetchNow();
            });
            // Cross-view link: timeline hover → highlight on trajectory.
            // CRITICAL: only redraw the canvas, not the timeline. Calling draw() here would call
            // buildTimeline() which destroys+rebuilds uPlot on every mouse move, fires setCursor
            // on the new instance, which calls this handler again → infinite loop + fans spin up.
            window.__onTimelineHover = (hostId, row) => {
                const runKey = hostId.replace(/^timeline-/, '');
                if (row) this.hoverPoint[runKey] = { x: row.x, y: row.y, wx: row.wx, wy: row.wy, inst: row.inst, sid: row.sid, t: row.t };
                else delete this.hoverPoint[runKey];
                this.redrawTrajectoryOnly(runKey);
            };
        },

        async fetchNow() {
            try {
                const wasLoaded = this.loaded;
                const prevExpanded = wasLoaded ? Object.keys(this.expanded).filter(k => this.expanded[k]) : [];
                // Preserve filtered sessions from expanded runs so the snapshot replacement
                // doesn't briefly flash unfilter data (28 → 8 flicker).
                const prevSessions = {};
                if (wasLoaded) {
                    for (const k of prevExpanded) {
                        const r = this.snap.runs?.find(x => x.key === k);
                        if (r && r.sessions) prevSessions[k] = r.sessions;
                    }
                }
                const r = await fetch('/api/snapshot', { cache: 'no-store' });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const fresh = await r.json();
                this.lastFetchAt = Date.now();

                // Fast path: if the addon hasn't flushed since the last poll, the snapshot is
                // byte-identical (run aggregates and table counts only change on flush). Reassigning
                // this.snap anyway triggers Alpine to re-evaluate every x-text/x-for under the
                // snapshot — including the expanded card's heavy sessions/splits tables — which
                // causes a visible UI hitch every POLL_INTERVAL_MS. Skip the reassignment if nothing
                // material changed; we still update lastFetchAt so the "Xs ago" indicator keeps moving.
                if (wasLoaded && snapshotUnchanged(this.snap, fresh)) return;
                this.snap = fresh;
                this.loaded = true;
                // Restore filtered sessions for expanded runs so the DOM never sees the raw count.
                for (const k of prevExpanded) {
                    const nr = this.snap.runs?.find(x => x.key === k);
                    if (nr && prevSessions[k]) nr.sessions = prevSessions[k];
                }

                // Compute fresh per-run signatures from the new snapshot and diff against the
                // previous map. A signature change for an expanded run = "server has new data,
                // refetch the poll." session_count increasing for the latest run = "new session
                // arrived, scroll it into view." This is the ONLY scroll trigger.
                const changedKeys = new Set();
                let newSessionLatestKey = null;
                const newLatest = this.snap.runs[0]?.key || null;
                for (const run of this.snap.runs) {
                    const sig = sigOf(run);
                    const prev = this._runSig[run.key];
                    if (!prev || !sigEqual(prev, sig)) changedKeys.add(run.key);
                    if (run.key === newLatest && prev && sig.session_count > prev.session_count) {
                        newSessionLatestKey = run.key;
                    }
                    this._runSig[run.key] = sig;
                }

                // Initial-load auto-expand: open the latest card once on first fetch only.
                // Subsequent fetches never auto-expand — the user's expand/collapse choice wins.
                if (!wasLoaded && newLatest && !this.expanded[newLatest]) {
                    this.$nextTick(() => this.expandRun(newLatest));
                } else if (newSessionLatestKey) {
                    // A new session genuinely arrived for the latest run. Scroll it into view.
                    // Expand if not already expanded; if already expanded, just scroll.
                    this.$nextTick(() => {
                        if (!this.expanded[newSessionLatestKey]) this.expandRun(newSessionLatestKey);
                        const el = document.getElementById('run-card-' + newSessionLatestKey);
                        if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
                    });
                }

                // Refetch poll data for expanded runs ONLY if their snapshot signature changed.
                // Without this guard fetchNow pulls the full multi-MB poll dataset every 5s for
                // every expanded card, even when the server hasn't gained any new rows.
                const toRefetch = prevExpanded.filter(k => changedKeys.has(k));
                if (toRefetch.length > 0) {
                    if (this._refreshTimer) clearTimeout(this._refreshTimer);
                    this._refreshTimer = setTimeout(() => {
                        for (const k of toRefetch) {
                            if (this.expanded[k]) this.loadRunPoll(k);
                        }
                    }, 800);
                }
            } catch (e) {
                console.error('snapshot fetch failed', e);
            }
        },

        refreshAgeSec() {
            return (Date.now() - this.lastFetchAt) / 1000;
        },

    async expandRun(runKey) {
            this.expanded[runKey] = !this.expanded[runKey];
            if (this.expanded[runKey]) {
                // Collapse any other expanded cards so only one is open at a time
                for (const key of Object.keys(this.expanded)) {
                    if (key !== runKey && this.expanded[key]) {
                        this.expanded[key] = false;
                    }
                }
                document.body.style.overflow = 'hidden';
                if (!this.runPolls[runKey]) {
                    await this.loadRunPoll(runKey);
                }
                this.$nextTick(() => this.draw(runKey));
            } else {
                const anyExpanded = Object.values(this.expanded).some(v => v);
                if (!anyExpanded) {
                    document.body.style.overflow = '';
                }
            }
        },

        async loadRunPoll(runKey) {
            try {
                // Build query string from active explicit filters. Missing fields = no constraint.
                const f = this.filters[runKey] || {};
                const qs = [];
                for (const k of ['lvl_min', 'lvl_max', 't_min', 't_max']) {
                    if (f[k] != null && f[k] !== '') qs.push(`${k}=${encodeURIComponent(f[k])}`);
                }
                // Session limit from the header dropdown.
                const sl = this.runLimit;
                if (sl != null && sl !== 'all') qs.push(`session_limit=${encodeURIComponent(sl)}`);
                // Client always requests the columnar wire format. The server still supports the
                // legacy row-shape format for now (planned removal in a follow-up) but nothing on
                // this branch consumes it.
                qs.push('fmt=columnar');
                const url = '/api/runs/' + encodeURIComponent(runKey) + '/poll' + (qs.length ? '?' + qs.join('&') : '');
                const r = await fetch(url, { cache: 'no-store' });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json();
                if (data.encoding !== 'columnar_v1') {
                    console.error('loadRunPoll: server returned unexpected encoding', data.encoding);
                    return;
                }
                // PollRows: typed-array-backed view. rows_all is sparse (rows that didn't change a
                // field have null in the wire payload — expandPollRows turns this into change-only
                // index/value pairs that the per-column accessor walks). rows is the dense filtered
                // slice when a filter is active; otherwise it's the same shape as rows_all.
                data.rows_all = window.expandPollRows(data.rows_all);
                data.rows = window.expandPollRows(data.rows);
                const zones = summarizeZones(data.rows);
                // Append a synthetic "__world__" entry if we have world coords. Selecting it
                // triggers the cross-zone world-plane view (slice 8.5). Appended (not prepended) so
                // default auto-pick stays on the most-visited real zone. The count is the full row
                // count of the payload here — once we know world data is present the per-row "had a
                // value" filter is moot (wx is forward-filled densely; every row has a meaningful
                // value once the first row of its session set wx).
                if (data.rows.hasWorld) {
                    zones.push({ name: '__world__', count: data.rows.length, label: 'World (all zones)' });
                }
                const filteredSessionIds = new Set(data.sessions || []);
                const legend = buildLegend(data.sessions, data.stats?.per_session);
                const deadSpans = computeDeadSpans(data.events || []);
                const breakTimestamps = computeBreakTimestamps(data.events || []);
                const killsPositioned = positionKills(data.kills || [], data.rows);
                attachWorldCoordsToEvents(data.events || [], data.rows);
                const rowsAll = data.rows_all || data.rows;
                const atMaxLevel = (() => {
                    const v = rowsAll?._sparse?.lvl?.values;
                    if (!v?.length) return false;
                    let min = v[0];
                    for (let i = 1; i < v.length; i++) if (v[i] < min) min = v[i];
                    return min >= GAME_MAX_LEVEL;
                })();
                this.runPolls[runKey] = {
                    rows: data.rows,
                    rows_all: rowsAll,
                    events: data.events || [],
                    events_all: data.events_all || data.events || [],
                    kills: killsPositioned,
                    kills_all: data.kills_all || data.kills || [],
                    deadSpans,
                    breakTimestamps,
                    zones, legend, sessions: data.sessions,
                    class: data.class,
                    stats: data.stats,
                    filterActive: !!data.filter_active,
                    atMaxLevel,
                    viewStats: null,
                    viewStatTiles: [],
                    viewSpellCasts: [],
                };
                // Sync filtered sessions back to snapshot so the sessions table reflects the limit.
                const runObj = this.snap.runs.find(r => r.key === runKey);
                if (runObj) {
                    runObj.sessions = (runObj.sessions || []).filter(s => filteredSessionIds.has(s.session_id));
                }
                // Default XP/hr window: 2 minutes. Established on first load; user-controlled afterward.
                if (this.xpWindow[runKey] == null) this.xpWindow[runKey] = 120;
                if (this.xpMode[runKey] == null) this.xpMode[runKey] = 'trapezoidal';
                // Auto-pick the most-visited zone on first load; on refilter, only re-pick if the
                // currently-selected zone no longer exists in the filtered set.
                const zoneNames = new Set(zones.map(z => z.name));
                if ((!this.selectedZone[runKey] || !zoneNames.has(this.selectedZone[runKey])) && zones.length) {
                    this.selectedZone[runKey] = zones[0].name;
                    this.fitZoom(runKey);
                }
                this._cacheViewStats(runKey);
                this.$nextTick(() => this.draw(runKey));
            } catch (e) {
                console.error('run poll fetch failed', e);
            }
        },

        selectZone(runKey, zoneName) {
            this.selectedZone[runKey] = zoneName;
            this.fitZoom(runKey);
            // Recompute zone-scoped stats once per zone change (cached for templates).
            this._cacheViewStats(runKey);
            // Zone change doesn't affect timeline content — only redraw the canvas.
            this.$nextTick(() => this.redrawTrajectoryOnly(runKey));
        },

        fitZoom(runKey) {
            const data = this.runPolls[runKey];
            const zone = this.selectedZone[runKey];
            const canvas = document.getElementById('canvas-' + runKey);
            if (!data || !zone || !canvas) {
                this.zoomView[runKey] = { scale: 1, panX: 0, panY: 0 };
                return;
            }
            // drawTrajectory computes a square-padded yard-space bounds that already frames the
            // data — so scale=1 maps that square to S=max(W,H) pixels. Center it so the crop is
            // balanced (top+bottom on wide canvases, left+right on tall). Same logic for world
            // and per-zone view since both now project from wx/wy.
            const W = canvas.width, H = canvas.height;
            const S = Math.max(W, H);
            this.zoomView[runKey] = { scale: 1, panX: (W - S) / 2, panY: (H - S) / 2 };
        },

        draw(runKey) {
            this.redrawTrajectoryOnly(runKey);
            // Timeline is independent of zone selection. Heavy — only call on zone change or initial load.
            const data = this.runPolls[runKey];
            if (data && window.buildTimeline) {
                // Timeline rebuild always starts unzoomed (uPlot recreates the scale fresh).
                this.timelineZoomed[runKey] = false;
                window.buildTimeline('timeline-' + runKey, data, {
                    xpWindowSec: this.xpWindow[runKey] ?? 120,
                    xpMode: this.xpMode[runKey] ?? 'trapezoidal',
                    filterTRange: this._activeTRange(runKey),
                    onBrushSelect: ({ t_min, t_max }) => this.onTimelineBrush(runKey, t_min, t_max),
                    onZoomChange: (isZoomed) => { this.timelineZoomed[runKey] = isZoomed; },
                    onFilterClear: () => this.clearTimelineTFilter(runKey),
                    onSessionIsolate: ({ t_min, t_max }) => {
                        // Only act if no time filter is currently set — gives the user a quick
                        // "zoom to this session" without overriding an explicit selection.
                        if (this._activeTRange(runKey)) return;
                        this.onTimelineBrush(runKey, t_min, t_max);
                    },
                });
            }
        },

        // --- filtering ---

        // Min/max bounds derived from the FULL run (rows_all) so sliders cover the whole space
        // even when a filter is active.
        // lvl bounds: scan the sparse `lvl` change list directly (≤ a few dozen entries per run)
        // instead of touching every row. Cheaper than the old O(n) loop and runs on every Alpine
        // tick via the template bind, so worth keeping tight.
        runMinLvl(runKey) {
            const rs = this.runPolls[runKey]?.rows_all;
            if (!rs?.length) return 1;
            const v = rs._sparse.lvl.values;
            if (!v.length) return 1;
            let m = v[0]; for (let i = 1; i < v.length; i++) if (v[i] < m) m = v[i];
            return m;
        },
        runMaxLvl(runKey) {
            const rs = this.runPolls[runKey]?.rows_all;
            if (!rs?.length) return 60;
            const v = rs._sparse.lvl.values;
            if (!v.length) return 60;
            let m = v[0]; for (let i = 1; i < v.length; i++) if (v[i] > m) m = v[i];
            return m;
        },
        // t bounds: rows are stored ORDER BY session_id, timestamp so a global min/max requires a
        // full scan. The dense Float64Array makes that cheap (~5M ops/ms in modern V8) and the
        // result is small so we don't bother memoizing.
        runMinT(runKey) {
            const rs = this.runPolls[runKey]?.rows_all;
            if (!rs?.length) return 0;
            const t = rs.t;
            let m = t[0]; for (let i = 1; i < t.length; i++) if (t[i] < m) m = t[i];
            return m;
        },
        runMaxT(runKey) {
            const rs = this.runPolls[runKey]?.rows_all;
            if (!rs?.length) return 0;
            const t = rs.t;
            let m = t[0]; for (let i = 1; i < t.length; i++) if (t[i] > m) m = t[i];
            return m;
        },
        // Effective slider position = explicit filter value OR the natural bound.
        effLvlMin(runKey) { return this.filters[runKey]?.lvl_min ?? this.runMinLvl(runKey); },
        effLvlMax(runKey) { return this.filters[runKey]?.lvl_max ?? this.runMaxLvl(runKey); },
        // True when the entire visible window is at the level cap — XP UI is meaningless then.
        isAtMaxLevel(runKey) {
            return this.runPolls[runKey]?.atMaxLevel ?? false;
        },
        effTMin(runKey)   { return this.filters[runKey]?.t_min   ?? this.runMinT(runKey); },
        effTMax(runKey)   { return this.filters[runKey]?.t_max   ?? this.runMaxT(runKey); },
        _activeTRange(runKey) {
            const f = this.filters[runKey];
            if (!f || (f.t_min == null && f.t_max == null)) return null;
            return { t_min: f.t_min ?? this.runMinT(runKey), t_max: f.t_max ?? this.runMaxT(runKey) };
        },
        isFilterActive(runKey) {
            const f = this.filters[runKey];
            return !!(f && (f.lvl_min != null || f.lvl_max != null || f.t_min != null || f.t_max != null));
        },

        // Slider input handlers. x-model.number binds to the raw value; here we (a) snap value back
        // to null when it equals the natural bound (so we don't over-constrain & API stays clean),
        // (b) keep min ≤ max via auto-clamp, (c) debounce the refetch.
        onLvlMinChange(runKey, v) {
            const f = this.filters[runKey] || (this.filters[runKey] = {});
            const nat = this.runMinLvl(runKey);
            f.lvl_min = (v == null || v <= nat) ? null : Number(v);
            if (f.lvl_max != null && f.lvl_min != null && f.lvl_min > f.lvl_max) f.lvl_max = f.lvl_min;
            this._scheduleFilterRefetch(runKey);
        },
        onLvlMaxChange(runKey, v) {
            const f = this.filters[runKey] || (this.filters[runKey] = {});
            const nat = this.runMaxLvl(runKey);
            f.lvl_max = (v == null || v >= nat) ? null : Number(v);
            if (f.lvl_min != null && f.lvl_max != null && f.lvl_max < f.lvl_min) f.lvl_min = f.lvl_max;
            this._scheduleFilterRefetch(runKey);
        },
        onTMinChange(runKey, v) {
            const f = this.filters[runKey] || (this.filters[runKey] = {});
            const nat = this.runMinT(runKey);
            f.t_min = (v == null || v <= nat) ? null : Number(v);
            if (f.t_max != null && f.t_min != null && f.t_min > f.t_max) f.t_max = f.t_min;
            this._scheduleFilterRefetch(runKey);
        },
        onTMaxChange(runKey, v) {
            const f = this.filters[runKey] || (this.filters[runKey] = {});
            const nat = this.runMaxT(runKey);
            f.t_max = (v == null || v >= nat) ? null : Number(v);
            if (f.t_min != null && f.t_max != null && f.t_max < f.t_min) f.t_min = f.t_max;
            this._scheduleFilterRefetch(runKey);
        },
        onTimelineBrush(runKey, t_min, t_max) {
            const f = this.filters[runKey] || (this.filters[runKey] = {});
            f.t_min = t_min;
            f.t_max = t_max;
            // Brush is immediate (no debounce).
            this._refetchFiltered(runKey);
        },
        resetFilter(runKey) {
            this.filters[runKey] = {};
            this._refetchFiltered(runKey);
        },
        _scheduleFilterRefetch(runKey) {
            clearTimeout(this._filterDebounce[runKey]);
            this._filterDebounce[runKey] = setTimeout(() => this._refetchFiltered(runKey), 300);
        },
        async _refetchFiltered(runKey) {
            await this.loadRunPoll(runKey);
            // loadRunPoll already calls draw(); nothing more to do.
        },

        // XP/hr smoothing window — purely a timeline rebuild, no refetch.
        onXpWindowChange(runKey) {
            const data = this.runPolls[runKey];
            if (data && window.buildTimeline) {
                this.timelineZoomed[runKey] = false;
                window.buildTimeline('timeline-' + runKey, data, {
                    xpWindowSec: this.xpWindow[runKey] ?? 120,
                    xpMode: this.xpMode[runKey] ?? 'trapezoidal',
                    filterTRange: this._activeTRange(runKey),
                    onBrushSelect: ({ t_min, t_max }) => this.onTimelineBrush(runKey, t_min, t_max),
                    onZoomChange: (isZoomed) => { this.timelineZoomed[runKey] = isZoomed; },
                    onFilterClear: () => this.clearTimelineTFilter(runKey),
                    onSessionIsolate: ({ t_min, t_max }) => {
                        // Only act if no time filter is currently set — gives the user a quick
                        // "zoom to this session" without overriding an explicit selection.
                        if (this._activeTRange(runKey)) return;
                        this.onTimelineBrush(runKey, t_min, t_max);
                    },
                });
            }
        },

        onXpModeChange(runKey) {
            const data = this.runPolls[runKey];
            if (data && window.buildTimeline) {
                this.timelineZoomed[runKey] = false;
                window.buildTimeline('timeline-' + runKey, data, {
                    xpWindowSec: this.xpWindow[runKey] ?? 120,
                    xpMode: this.xpMode[runKey] ?? 'trapezoidal',
                    filterTRange: this._activeTRange(runKey),
                    onBrushSelect: ({ t_min, t_max }) => this.onTimelineBrush(runKey, t_min, t_max),
                    onZoomChange: (isZoomed) => { this.timelineZoomed[runKey] = isZoomed; },
                    onFilterClear: () => this.clearTimelineTFilter(runKey),
                    onSessionIsolate: ({ t_min, t_max }) => {
                        if (this._activeTRange(runKey)) return;
                        this.onTimelineBrush(runKey, t_min, t_max);
                    },
                });
            }
        },

        resetTimelineZoom(runKey) {
            window.resetTimelineZoom?.('timeline-' + runKey);
            this.timelineZoomed[runKey] = false;
        },
       onRunLimitChange() {
            for (const runKey of Object.keys(this.expanded)) {
                if (this.expanded[runKey]) {
                    this.loadRunPoll(runKey);
                }
            }
        },

         

        // Called when the user clicks outside the active filter band on the timeline. Clears the
        // t_min/t_max filter only (preserves lvl filters if set) and refetches.
        clearTimelineTFilter(runKey) {
            const f = this.filters[runKey];
            if (!f || (f.t_min == null && f.t_max == null)) return;
            f.t_min = null;
            f.t_max = null;
            this._refetchFiltered(runKey);
        },

        fmtFilterTime(runKey, t) {
            const base = this.runMinT(runKey);
            const elapsed = Math.max(0, Math.round(t - base));
            const h = Math.floor(elapsed / 3600);
            const m = Math.floor((elapsed % 3600) / 60);
            return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
        },

        toggleCanvasFullscreen(ev) {
            const wrap = ev.currentTarget.closest('.canvas-fs-wrap');
            if (!wrap) return;
            const canvas = wrap.querySelector('canvas');
            if (!canvas) return;
            const runKey = canvas.id.replace(/^canvas-/, '');

            if (document.fullscreenElement === wrap) {
                document.exitFullscreen();
                return;
            }
            // Resync the canvas backing store to the wrap's actual pixel dimensions and redraw.
            // Used on fullscreen enter, on window resize while fullscreen (e.g. user moves the
            // browser between monitors), and on exit. Without per-resize resync the bitmap keeps
            // its old aspect while CSS stretches it to the new viewport — visible squish/stretch.
            const resync = () => {
                const dpr = window.devicePixelRatio || 1;
                canvas.width = Math.round(wrap.clientWidth * dpr);
                canvas.height = Math.round(wrap.clientHeight * dpr);
                this.fitZoom(runKey);
                this.redrawTrajectoryOnly(runKey);
            };
            let ro = null;
            const onChange = () => {
                if (document.fullscreenElement === wrap) {
                    resync();
                    // Watch for size changes while fullscreen (window-resize, monitor swap).
                    // rAF-coalesced so a drag-resize doesn't fire 60×/sec.
                    let pending = 0;
                    ro = new ResizeObserver(() => {
                        if (pending) return;
                        pending = requestAnimationFrame(() => { pending = 0; resync(); });
                    });
                    ro.observe(wrap);
                } else {
                    if (ro) { ro.disconnect(); ro = null; }
                    canvas.width = 600;
                    canvas.height = 600;
                    this.fitZoom(runKey);
                    this.redrawTrajectoryOnly(runKey);
                    document.removeEventListener('fullscreenchange', onChange);
                }
            };
            document.addEventListener('fullscreenchange', onChange);
            wrap.requestFullscreen?.();
        },

        // Cheap canvas-only redraw — safe to call from mouse-move-rate handlers.
        redrawTrajectoryOnly(runKey) {
            // Coalesce redraws to one per animation frame. Timeline hover fires mousemove at
            // input-event rate (>60Hz on a fast mouse), each call would otherwise re-run the full
            // canvas pipeline — projection, marker draws, ctx.stroke per segment. rAF caps that
            // to one redraw per displayed frame; the latest hover state wins via the closure read
            // on `this`. _trajRafPending tracks pending frames per run so we don't double-schedule.
            if (!this._trajRafPending) this._trajRafPending = {};
            if (this._trajRafPending[runKey]) return;
            this._trajRafPending[runKey] = true;
            requestAnimationFrame(() => {
                this._trajRafPending[runKey] = false;
                const data = this.runPolls[runKey];
                if (!data) return;
                const zone = this.selectedZone[runKey];
                const canvas = document.getElementById('canvas-' + runKey);
                if (!canvas || !zone) return;
                if (!this.zoomView[runKey]) this.resetZoom(runKey);
                if (!this.zoomBound[runKey]) {
                    attachZoomHandlers(canvas, runKey, this);
                    this.zoomBound[runKey] = true;
                }
                drawTrajectory(canvas, data, zone, this.zoomView[runKey],
                               { colorByLevel: this.colorByLevel, hover: this.hoverPoint[runKey] });
            });
        },

        // Pre-compute zone-scoped stats whenever the zone or data changes — store on runPolls so
        // templates read from cached state (not call methods that iterate 4000+ rows per render).
        _cacheViewStats(runKey) {
            const data = this.runPolls[runKey];
            if (!data) return;
            const stats = this._computeZoneStats(runKey);
            // Mutate the existing object (Alpine's Proxy notices via property reassignment).
            this.runPolls[runKey] = {
                ...data,
                viewStats: stats,
                viewStatTiles: stats ? this._buildZoneStatTiles(stats, data.atMaxLevel) : [],
                viewSpellCasts: this._getZoneSpellCasts(runKey),
            };
        },

        spellCasts(runKey) {
            const d = this.runPolls[runKey];
            if (!d || !d.stats || !d.stats.spell_casts) return [];
            return d.stats.spell_casts;
        },

        // Stats restricted to the currently selected zone — computed once per zone-change in _cacheViewStats.
        // For the pseudo-zone "__world__", uses all rows (cross-zone summary).
        _computeZoneStats(runKey) {
            const data = this.runPolls[runKey];
            const zone = this.selectedZone[runKey];
            if (!data || !zone) return null;
            const pollRows = data.rows;
            if (!pollRows.length) return null;
            const useWorld = zone === '__world__';
            // Build the list of row index ranges in this zone, grouped by sid. World mode uses
            // every row in the run regardless of zone; per-zone walks the RLE zone column.
            // ranges: Map<sidStr, Array<[start, end)>>
            const ranges = new Map();
            const pushRange = (sidStr, start, end) => {
                let arr = ranges.get(sidStr);
                if (!arr) { arr = []; ranges.set(sidStr, arr); }
                arr.push([start, end]);
            };
            if (useWorld) {
                // Walk sid transitions in the full row stream; emit one [start,end) per sid.
                let s = 0;
                let lastSid = pollRows.sid[0];
                for (let i = 1; i < pollRows.length; i++) {
                    if (pollRows.sid[i] !== lastSid) {
                        pushRange(pollRows._sidStrings[lastSid], s, i);
                        s = i;
                        lastSid = pollRows.sid[i];
                    }
                }
                pushRange(pollRows._sidStrings[lastSid], s, pollRows.length);
            } else {
                const pairs = pollRows._zoneRle || [];
                for (let k = 0; k < pairs.length; k++) {
                    if (pairs[k][1] !== zone) continue;
                    const start = pairs[k][0];
                    const end = (k + 1 < pairs.length) ? pairs[k + 1][0] : pollRows.length;
                    // Split the run by sid in case two sessions share the same zone (rare but
                    // possible after server-side ORDER BY session_id, timestamp).
                    let s = start;
                    let lastSid = pollRows.sid[start];
                    for (let i = start + 1; i < end; i++) {
                        if (pollRows.sid[i] !== lastSid) {
                            pushRange(pollRows._sidStrings[lastSid], s, i);
                            s = i;
                            lastSid = pollRows.sid[i];
                        }
                    }
                    pushRange(pollRows._sidStrings[lastSid], s, end);
                }
            }
            if (ranges.size === 0) return null;
            const teleThresh2 = useWorld ? 100 * 100 : PATH_TELEPORT_DIST * PATH_TELEPORT_DIST;
            let distance = 0, playtime = 0, xpGained = 0;
            // Hoist coord arrays — they're hot. wx/wy is dense; x/y is sparse but we read it via
            // its accessor (rare per-row penalty; cursor stays warm).
            const wxArr = pollRows.wx, wyArr = pollRows.wy, tArr = pollRows.t;
            for (const sessionRanges of ranges.values()) {
                let tmin = Infinity, tmax = -Infinity;
                let lastCurrXp = null, lastMaxXp = null, lastLvl = null;
                for (const [start, end] of sessionRanges) {
                    for (let i = start; i < end; i++) {
                        if (tArr[i] < tmin) tmin = tArr[i];
                        if (tArr[i] > tmax) tmax = tArr[i];
                        if (i > start) {
                            const dt = tArr[i] - tArr[i - 1];
                            if (dt <= PATH_GAP_SEC) {
                                let a, b, c, d;
                                if (useWorld) {
                                    a = wxArr[i - 1]; b = wxArr[i]; c = wyArr[i - 1]; d = wyArr[i];
                                } else {
                                    a = pollRows.x(i - 1); b = pollRows.x(i);
                                    c = pollRows.y(i - 1); d = pollRows.y(i);
                                }
                                if (a != null && b != null && c != null && d != null) {
                                    const dx = b - a, dy = d - c;
                                    const d2 = dx * dx + dy * dy;
                                    if (d2 <= teleThresh2) distance += Math.sqrt(d2);
                                }
                            }
                        }
                        const curr_xp = pollRows.curr_xp(i);
                        const max_xp = pollRows.max_xp(i);
                        if (curr_xp != null && max_xp != null) {
                            const lvl = pollRows.lvl(i);
                            if (lastCurrXp != null && lastMaxXp != null) {
                                if (lvl != null && lastLvl != null && lvl > lastLvl) {
                                    xpGained += (lastMaxXp - lastCurrXp) + curr_xp;
                                } else if (curr_xp > lastCurrXp) {
                                    xpGained += curr_xp - lastCurrXp;
                                }
                            }
                            lastCurrXp = curr_xp; lastMaxXp = max_xp; lastLvl = lvl;
                        }
                    }
                }
                if (isFinite(tmin) && isFinite(tmax)) playtime += (tmax - tmin);
            }

            const kills = (data.kills || []).filter(k => zone === '__world__' || k.zone === zone).length;
            let deaths = 0, levelUps = 0, qAccept = 0, qTurnIn = 0;
            for (const e of (data.events || [])) {
                if (zone !== '__world__' && e.z !== zone) continue;
                if (e.event === 'PLAYER_DEAD') deaths++;
                else if (e.event === 'PLAYER_LEVEL_UP') levelUps++;
                else if (e.event === 'QUEST_ACCEPTED') qAccept++;
                else if (e.event === 'QUEST_TURNED_IN') qTurnIn++;
            }
            const zoneRows = [];
            for (const sessionRanges of ranges.values()) {
                for (const [start, end] of sessionRanges) {
                    for (let i = start; i < end; i++) zoneRows.push(pollRows.row(i));
                }
            }
            const efficiency = computeEfficiency(zoneRows);
            return {
                zone, distance, playtime, xpGained,
                xp_per_hour: playtime > 0 ? xpGained / (playtime / 3600) : 0,
                kills, deaths, levelUps, qAccept, qTurnIn,
                idleScore: efficiency.idleScore,
            };
        },

        _buildZoneStatTiles(s, atMaxLevel) {
            const distLabel = s.zone === '__world__'
                ? this.fmtYards(s.distance)
                : this.fmtDistance(s.distance);
            return [
                { label: 'playtime', value: this.fmtDuration(s.playtime) },
                ...(!atMaxLevel ? [
                    { label: 'xp', value: this.fmtNum(s.xpGained),
                      sub: s.xp_per_hour ? this.fmtNum(Math.round(s.xp_per_hour)) + '/hr' : '' },
                    { label: 'levels', value: s.levelUps },
                ] : []),
                { label: 'distance', value: distLabel },
                { label: 'kills', value: s.kills },
                { label: 'deaths', value: s.deaths },
                                 { label: 'quests in', value: s.qTurnIn + '/' + s.qAccept },
                                 { label: 'idle', value: s.idleScore ? (s.idleScore * 100).toFixed(1) + '%' : '—' },
                             ];

        },

        _getZoneSpellCasts(runKey) {
            const data = this.runPolls[runKey];
            const zone = this.selectedZone[runKey];
            if (!data || !zone || !data.stats || !data.stats.spell_casts_by_zone) return [];
            return data.stats.spell_casts_by_zone[zone] || [];
        },

        fmtDistance(d) {
            if (!d) return '—';
            // d is normalized (0..1 across the zone). Approximate yards using ~3000 yards/zone — rough but useful for comparison.
            const yards = d * 3000;
            return this.fmtYards(yards);
        },
        fmtYards(yards) {
            if (!yards) return '—';
            if (yards >= 1000) return (yards / 1000).toFixed(1) + 'k yd';
            return Math.round(yards) + ' yd';
        },

        // Per-session stat lookup for the sessions dropdown. Reads from stats.per_session computed
        // server-side when the run is expanded. Returns null if not yet loaded.
        sessionStat(runKey, sid, field) {
            const ps = this.runPolls[runKey]?.stats?.per_session;
            if (!ps) return null;
            const s = ps.find(p => p.sid === sid);
            return s ? s[field] : null;
        },

        getEfficiencyColor(val) {
            if (val == null) return 'transparent';
            const min = 10000, max = 100000;
            const t = Math.min(1, Math.max(0, (val - min) / (max - min)));
            return `hsl(${t * 120}, 70%, 50%)`;
        },

        // Format top zones for the per-session row: "Dun Morogh 12m, Loch Modan 4m"
        sessionTopZones(runKey, sid) {
            const ps = this.runPolls[runKey]?.stats?.per_session;
            if (!ps) return '';
            const s = ps.find(p => p.sid === sid);
            if (!s || !s.top_zones || s.top_zones.length === 0) return '';
            return s.top_zones.map(({ z, t }) => `${z} ${this.fmtDuration(t)}`).join(', ');
        },

        // Re-export for template use.
        prettySessionLabel(sid) { return prettySessionLabel(sid); },

        // "0:00–15:00" style label for a split's playtime range.
        fmtSplitRange(ptStart, ptEnd) {
            const pad = (n) => String(Math.floor(n)).padStart(2, '0');
            const fmt = (sec) => `${pad(sec / 60)}:${pad(sec % 60)}`;
            return `${fmt(ptStart)}–${fmt(ptEnd)}`;
        },

        statTiles(stats, atMaxLevel) {
            if (!stats) return [];
            return [
                { label: 'played',     value: this.fmtDuration(stats.duration_played) },
                ...(!atMaxLevel ? [
                    { label: 'xp gained',  value: this.fmtNum(stats.xp_gained),
                      sub: stats.xp_per_hour ? `${this.fmtNum(Math.round(stats.xp_per_hour))}/hr` : '' },
                    { label: 'levels',     value: stats.levels_gained },
                ] : []),
                { label: 'kills',      value: stats.kills },
                { label: 'deaths',     value: stats.deaths },
                { label: 'quests in',  value: `${stats.quests_turned_in}/${stats.quests_accepted}` },
                { label: 'jumps',      value: stats.jumps ?? 0 },
            ];
        },

        fmtNum(n) {
            if (n == null) return '—';
            if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
            return (n).toFixed(2);
        },

        fmtDuration(sec) {
            if (!sec || sec < 0) return '—';
            const s = Math.round(sec);
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const ss = s % 60;
            if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
            if (m > 0) return `${m}m${String(ss).padStart(2, '0')}s`;
            return `${ss}s`;
        },

        fmtDate(epoch) {
            if (!epoch) return '—';
            return new Date(epoch * 1000).toLocaleString();
        },

        fmtAgo(epoch) {
            if (!epoch) return '—';
            const ageSec = Date.now() / 1000 - epoch;
            if (ageSec < 0) return 'in the future?';
            if (ageSec < 60) return `${Math.round(ageSec)}s ago`;
            if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
            if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`;
            return `${Math.round(ageSec / 86400)}d ago`;
        },
    }));
});

// --- helpers (plain functions, no Alpine state) ---

// Per-run signature derived from /api/snapshot fields. Any change here means the server has
// gained rows for this run — used to gate poll refetches (and auto-scroll on session_count++).
function sigOf(run) {
    return {
        session_count: run.session_count || 0,
        poll_rows: run.poll_rows || 0,
        event_rows: run.event_rows || 0,
        cleu_rows: run.cleu_rows || 0,
        last_seen: run.last_seen || 0,
    };
}
function sigEqual(a, b) {
    return a.session_count === b.session_count
        && a.poll_rows === b.poll_rows
        && a.event_rows === b.event_rows
        && a.cleu_rows === b.cleu_rows
        && a.last_seen === b.last_seen;
}

// True if `fresh` carries no user-visible deltas from `prev` — same set of runs, same per-run
// signatures, same global table counts. Used to skip the wholesale snap reassignment that would
// otherwise re-render the entire UI every poll.
function snapshotUnchanged(prev, fresh) {
    if (!prev || !fresh) return false;
    const a = prev.runs || [], b = fresh.runs || [];
    if (a.length !== b.length) return false;
    const bByKey = new Map(b.map(r => [r.key, r]));
    for (const ra of a) {
        const rb = bByKey.get(ra.key);
        if (!rb) return false;
        if (!sigEqual(sigOf(ra), sigOf(rb))) return false;
    }
    const ca = prev.counts || {}, cb = fresh.counts || {};
    const kca = Object.keys(ca), kcb = Object.keys(cb);
    if (kca.length !== kcb.length) return false;
    for (const k of kca) {
        const va = ca[k], vb = cb[k];
        if (!vb) return false;
        if (va.rows !== vb.rows || va.latest !== vb.latest) return false;
    }
    return true;
}

// Build per-session [{start, end}] intervals where player was dead.
// BC fires PLAYER_ALIVE on ghost-state entry (a few seconds after PLAYER_DEAD), so a naive
// "first ALIVE after DEAD closes the span" gives only ~2s windows. Real revive is:
//   - PLAYER_UNGHOST when corpse run completes (definitive end of dead state), OR
//   - PLAYER_ALIVE that's at least DEAD_ALIVE_MIN_GAP seconds after DEAD (spirit healer rez).
const DEAD_ALIVE_MIN_GAP = 8;

function computeDeadSpans(events) {
    const spans = [];
    const bySession = new Map();
    for (const e of events) {
        if (!['PLAYER_DEAD', 'PLAYER_ALIVE', 'PLAYER_UNGHOST'].includes(e.event)) continue;
        if (!bySession.has(e.sid)) bySession.set(e.sid, []);
        bySession.get(e.sid).push(e);
    }
    for (const [sid, evs] of bySession) {
        evs.sort((a, b) => a.t - b.t);
        let openDeath = null;
        for (const e of evs) {
            if (e.event === 'PLAYER_DEAD') {
                openDeath = e.t;
            } else if (openDeath != null) {
                // UNGHOST always closes. PLAYER_ALIVE only closes if enough time has passed
                // (otherwise it's the intra-death ghost-entry fire we want to ignore).
                if (e.event === 'PLAYER_UNGHOST' || (e.t - openDeath) >= DEAD_ALIVE_MIN_GAP) {
                    spans.push({ sid, start: openDeath, end: e.t });
                    openDeath = null;
                }
            }
        }
        if (openDeath != null) spans.push({ sid, start: openDeath, end: Infinity });
    }
    return spans;
}

// Per-session sorted timestamps where the path should hard-break regardless of distance/time:
// PLAYER_DEAD / PLAYER_ALIVE / PLAYER_UNGHOST mark state transitions where the spirit healer
// teleport may be small enough to slip under the distance threshold (especially in compact zones).
function computeBreakTimestamps(events) {
    const bySid = new Map();
    for (const e of events) {
        if (!['PLAYER_DEAD', 'PLAYER_ALIVE', 'PLAYER_UNGHOST'].includes(e.event)) continue;
        if (!bySid.has(e.sid)) bySid.set(e.sid, []);
        bySid.get(e.sid).push(e.t);
    }
    for (const arr of bySid.values()) arr.sort((a, b) => a - b);
    return bySid;
}

function hasBreakBetween(breakTimestamps, sid, t1, t2) {
    const arr = breakTimestamps.get(sid);
    if (!arr) return false;
    // Linear scan is fine — death events per session are tiny (<10).
    for (const t of arr) {
        if (t > t1 && t < t2) return true;
        if (t >= t2) break;
    }
    return false;
}

function isDead(spans, sid, t) {
    for (const s of spans) {
        if (s.sid === sid && t >= s.start && t <= s.end) return true;
    }
    return false;
}

// For each kill row, find the nearest poll sample in the same session and within 2s.
// Drops kills that can't be positioned (rare; happens if session has no poll rows nearby).
// Also attaches wx/wy/inst when present so kills can be drawn in the world view.
// Build per-sid contiguous row index ranges over a PollRows. Wire format guarantees rows are
// ORDER BY session_id, timestamp so each sid occupies a single [start, end) span. Returns
// Map<sidString, {start, end}>. O(n) one pass, used by the position-by-t helpers below.
function pollRangesBySid(rows) {
    const out = new Map();
    if (!rows.length) return out;
    let start = 0;
    let lastSidInt = rows.sid[0];
    let lastSidStr = rows._sidStrings[lastSidInt];
    for (let i = 1; i < rows.length; i++) {
        const s = rows.sid[i];
        if (s !== lastSidInt) {
            out.set(lastSidStr, { start, end: i });
            start = i;
            lastSidInt = s;
            lastSidStr = rows._sidStrings[s];
        }
    }
    out.set(lastSidStr, { start, end: rows.length });
    return out;
}

// Binary search for the row index in [lo, hi) whose t is closest to target. Returns the index, or
// -1 if no row is within `maxDt` of target. Uses Float64 t directly off the dense backbone.
function nearestRowIdx(rows, lo, hi, target, maxDt) {
    if (lo >= hi) return -1;
    let l = lo, h = hi - 1;
    while (l < h) {
        const m = (l + h) >> 1;
        if (rows.t[m] < target) l = m + 1; else h = m;
    }
    let best = l;
    if (l > lo && Math.abs(rows.t[l - 1] - target) < Math.abs(rows.t[l] - target)) best = l - 1;
    return Math.abs(rows.t[best] - target) > maxDt ? -1 : best;
}

function positionKills(kills, pollRows) {
    if (!kills.length || !pollRows.length) return [];
    const ranges = pollRangesBySid(pollRows);
    const out = [];
    for (const k of kills) {
        const range = ranges.get(k.sid);
        if (!range) continue;
        const idx = nearestRowIdx(pollRows, range.start, range.end, k.t, 2);
        if (idx < 0) continue;
        // Drop kills whose nearest poll row has no zone-local coord (rare — happens if the
        // nearest poll precedes the first row that ever set x/y in that session). x/y is sparse,
        // so we resolve via accessor.
        const x = pollRows.x(idx); const y = pollRows.y(idx);
        if (x == null || y == null) continue;
        out.push({
            ...k,
            x, y,
            zone: pollRows.zone(idx),
            wx: pollRows.wx[idx], wy: pollRows.wy[idx],
            inst: pollRows.inst[idx],
        });
    }
    return out;
}

// Attach world coords (wx/wy/inst) to events via nearest-poll-within-2s lookup. Mutates events in
// place. wx/wy are dense (forward-filled at expand time) — a row that never received a world coord
// still has wx=0 in the typed array. inst=0 is *not* a valid sentinel: Eastern Kingdoms uses
// instanceId 0. The hasWorldAt[i] bitmask is the authoritative "has world coords" signal.
function attachWorldCoordsToEvents(events, pollRows) {
    if (!events.length || !pollRows.length) return;
    const ranges = pollRangesBySid(pollRows);
    for (const e of events) {
        const range = ranges.get(e.sid);
        if (!range) continue;
        const idx = nearestRowIdx(pollRows, range.start, range.end, e.t, 2);
        if (idx < 0) continue;
        if (!pollRows.hasWorldAt[idx]) continue;
        e.wx = pollRows.wx[idx];
        e.wy = pollRows.wy[idx];
        e.inst = pollRows.inst[idx];
    }
}

function summarizeZones(rows) {
    const counts = new Map();
    if (!rows.length) return [];
    // zone is RLE — walk the RLE pairs directly to avoid an n-time accessor scan. Each run
    // contributes (nextStart - thisStart) to its zone's count; the final run extends to rows.length.
    const pairs = rows._zoneRle || [];
    for (let k = 0; k < pairs.length; k++) {
        const [start, name] = pairs[k];
        if (name == null) continue;
        const end = (k + 1 < pairs.length) ? pairs[k + 1][0] : rows.length;
        counts.set(name, (counts.get(name) || 0) + (end - start));
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
}

// Distinct color per session, golden-angle hue spacing.
function sessionColor(idx) {
    const hue = (idx * 137.508) % 360;
    return `hsl(${hue}, 70%, 60%)`;
}

function buildLegend(sessionIds, perSession) {
    const sessMap = new Map((perSession || []).map(s => [s.sid, s]));
    return sessionIds.map((sid, i) => {
        const s = sessMap.get(sid) || {};
        return {
            sid,
            label: prettySessionLabel(sid),
            color: sessionColor(i),
            xp_gained: s.xp_gained || 0,
            xp_per_hour: s.xp_per_hour || 0,
            duration: s.duration || 0,
        };
    });
}

// Short 24-hour format: "5/16 23:50"
function prettySessionLabel(sid) {
    const m = sid.match(/^(\d+)_/);
    if (!m) return sid;
    const epoch = parseInt(m[1], 10);
    if (!isFinite(epoch)) return sid;
    const d = new Date(epoch * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Project a normalized (0..1) world coord to canvas pixels under the given view transform.
// Uniform projection unit S = max(W, H) so 1 world unit = same number of pixels on both axes
// (aspect-correct: a circle in data space stays a circle on canvas) AND the data fills the
// viewport at scale=1 (covers the smaller canvas axis, overflows the larger — like a fullscreen
// map). Off-screen overflow is clipped by the canvas's clip rect; pan/zoom navigate around it.
function projectX(nx, view, W, H) { return view.panX + nx * Math.max(W, H) * view.scale; }
function projectY(ny, view, W, H) { return view.panY + ny * Math.max(W, H) * view.scale; }

// Inverse — canvas pixel back to normalized world coord (used to anchor wheel-zoom on cursor).
function unprojectX(px, view, W, H) { return (px - view.panX) / (Math.max(W, H) * view.scale); }
function unprojectY(py, view, W, H) { return (py - view.panY) / (Math.max(W, H) * view.scale); }

// Single shared floating tooltip element — pointer-events:none so it never blocks the canvas.
let __canvasTooltip = null;
function showCanvasTooltip(x, y, text) {
    if (!__canvasTooltip) {
        __canvasTooltip = document.createElement('div');
        __canvasTooltip.className = 'canvas-tooltip';
        document.body.appendChild(__canvasTooltip);
    }
    // In fullscreen only descendants of the fullscreen element are visible — reparent the
    // tooltip there so it shows up over the canvas. Re-home to body when fullscreen exits.
    const fsEl = document.fullscreenElement;
    const desiredParent = fsEl || document.body;
    if (__canvasTooltip.parentNode !== desiredParent) desiredParent.appendChild(__canvasTooltip);
    __canvasTooltip.textContent = text;
    __canvasTooltip.style.left = (x + 12) + 'px';
    __canvasTooltip.style.top = (y + 12) + 'px';
    __canvasTooltip.style.display = 'block';
}
function hideCanvasTooltip() {
    if (__canvasTooltip) __canvasTooltip.style.display = 'none';
}
// Exposed for timeline.js (which loads BEFORE app.js but only calls these at hover-time).
window.showCanvasTooltip = showCanvasTooltip;
window.hideCanvasTooltip = hideCanvasTooltip;

function attachZoomHandlers(canvas, runKey, app) {
    let dragging = null;

    canvas.addEventListener('mousemove', (e) => {
        if (dragging) { hideCanvasTooltip(); return; }
        const view = app.zoomView[runKey];
        if (!view || !canvas._markers || !canvas._markerProj) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;

        const geom = canvas._geomCache?.geom;
        if (geom) {
            const R = geom.bounds.maxX - geom.bounds.minX;
            const S = Math.max(canvas.width, canvas.height);
            const wx = geom.bounds.minX + R * (1 - (mx - view.panX) / (S * view.scale));
            const wy = geom.bounds.minY + R * (1 - (my - view.panY) / (S * view.scale));
            app.hoverPoint[runKey] = { ...app.hoverPoint[runKey], wx, wy };
            app.redrawTrajectoryOnly(runKey);
        }

        const { projX, projY } = canvas._markerProj;
        let nearest = null, minDist2 = 144; // ~12px hit radius in canvas pixels
        for (const m of canvas._markers) {
            const px = projX(m.x), py = projY(m.y);
            const dx = px - mx, dy = py - my;
            const d2 = dx * dx + dy * dy;
            if (d2 < minDist2) { minDist2 = d2; nearest = m; }
        }
        if (nearest) showCanvasTooltip(e.clientX, e.clientY, nearest.label);
        else hideCanvasTooltip();
    });
    canvas.addEventListener('mouseleave', () => {
        hideCanvasTooltip();
        delete app.hoverPoint[runKey];
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const view = app.zoomView[runKey];
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
        const my = (e.clientY - rect.top) * (canvas.height / rect.height);
        const factor = e.deltaY < 0 ? 1.2 : (1 / 1.2);
        // Wheel zoom is effectively unbounded — practical range needs to span from "all three
        // continents fit" (deep zoom out from a 100-yd auto-fitted zone view, ~scale 0.002) to
        // "1 yard fills the screen" (deep zoom in, ~scale 100+). Wide clamp protects against
        // runaway floats but stays out of the user's way.
        const newScale = Math.min(10000, Math.max(0.0001, view.scale * factor));
        const realFactor = newScale / view.scale;
        app.zoomView[runKey] = {
            scale: newScale,
            panX: mx - (mx - view.panX) * realFactor,
            panY: my - (my - view.panY) * realFactor,
        };
        app.redrawTrajectoryOnly(runKey);
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
        const view = app.zoomView[runKey];
        dragging = { startX: e.clientX, startY: e.clientY, origPanX: view.panX, origPanY: view.panY };
        canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const dx = (e.clientX - dragging.startX) * scaleX;
        const dy = (e.clientY - dragging.startY) * scaleY;
        const view = app.zoomView[runKey];
        app.zoomView[runKey] = { ...view, panX: dragging.origPanX + dx, panY: dragging.origPanY + dy };
        app.redrawTrajectoryOnly(runKey);
    });
    window.addEventListener('mouseup', () => {
        if (dragging) canvas.style.cursor = '';
        dragging = null;
    });
    canvas.addEventListener('dblclick', () => {
        app.fitZoom(runKey);
        app.redrawTrajectoryOnly(runKey);
    });

    canvas.style.cursor = 'grab';
    canvas.title = 'wheel: zoom · drag: pan · dblclick: reset';
}

// Overhead-map atlas — loaded once, lazily, on first canvas draw. atlas.json maps instanceId →
// { name, top: [left_col, top_row], tiles: [cols, rows], sizes: [{ path }] }. We use the first
// entry of `sizes` as the active backdrop. Pixel↔world transform per GEOSPATIAL.md: each ADT tile
// is 1600/3 yards on a side, world origin at (+17066.666, +17066.666). The active raster set is
// 160/3 px per tile so 1 image px = 10 world yards exactly.
const MAP_TILE_YD = 1600 / 3;          // 533.333…
const MAP_WORLD_ORIGIN = 17066.666;    // top-left (NW) corner of tile (0,0) in world coords

// Marker visuals — radii are in WORLD YARDS so they shrink as you zoom out, matching the path's
// own world-scale. A marker that drops below MARKER_MIN_PX after scaling is skipped entirely (would
// otherwise stipple the map with sub-pixel noise on far-out zoom). Quest turn-ins and deaths get a
// slightly larger radius so the events you'd actually want to find from a zoomed-out view stay
// findable. Color/hollow are also centralized here so adding a new marker type is one entry.
const MARKER_MIN_PX = 1; // below 1 device pixel, skip the draw — keeps far-out world view clean.
// A spec may carry `emoji: "..."` to draw a text glyph instead of a filled/hollow disc. For
// monochrome glyphs we append U+FE0E (text-style variation selector) to force the system to render
// the text form rather than the colorful emoji form, so `color` still controls the fill. SESSION_START
// is sized small because per-session start dots are a low-priority anchor — they should be visible
// at normal zoom but vanish on far-out views.
const MARKER_SPECS = {
    QUEST_TURNED_IN:        { yd: 6.0, color: 'gold',    hollow: false },
    QUEST_ACCEPTED:         { yd: 4.0, color: 'gold',    hollow: false },
    UI_INFO_MESSAGE:        { yd: 3.0, color: '#ffd060', hollow: false },
    PLAYER_DEAD:            { yd: 8.0, color: '#fff',    hollow: false, emoji: '☠︎' }, // ☠ text-style
    PLAYER_LEVEL_UP:        { yd: 4.0, color: '#a4f0ff', hollow: false },
    KILL:                   { yd: 4.0, color: '#ff5470', hollow: false },
    SESSION_START:          { yd: 3.0, color: null,      hollow: false }, // color filled in per-session
};

// World-mode multi-continent layout. Real WoW continents overlap in raw (wx, wy) — every continent's
// coords live in roughly the same ±17066 yard box, so drawing them at their real positions stacks
// them on top of each other. The world view solves this by reprojecting each instance into a
// synthetic plane where the three continents sit side-by-side: Kalimdor on the left, Eastern
// Kingdoms on the right (north-aligned with Kalimdor at the top), Outland centered horizontally
// below them with its top edge touching EK's bottom edge. Per-instance offsets are computed from
// atlas.json's `top` field so the layout is data-driven. Instances NOT in this map (raids,
// dungeons, world bosses, etc.) are dropped from the world view entirely — there's no map for them.
const WORLD_LAYOUT_GAP_YD = MAP_TILE_YD; // visual gap between Kalimdor and Eastern Kingdoms (1 ADT tile)
let __worldLayout = null;
function getWorldLayout() {
    if (__worldLayout) return __worldLayout;
    if (!__mapAtlas) return null;
    // We need image dims to know each continent's tile (cols, rows). If any of the three core
    // instances hasn't loaded yet, defer — caller is expected to retry on a redraw after
    // atlas-image onload fires.
    const KAL = '1', EK = '0', OUT = '530';
    const need = [KAL, EK, OUT];
    for (const id of need) {
        const slot = __mapAtlas[id];
        if (!slot || !slot.ready) return null;
    }
    const dims = (id) => {
        const slot = __mapAtlas[id];
        return {
            cols: slot.tiles[0],
            rows: slot.tiles[1],
            leftCol: slot.top[0],
            topRow: slot.top[1],
        };
    };
    const kal = dims(KAL), ek = dims(EK), out = dims(OUT);

    // Real NW corner of each continent in (wx=east-west, wy=north-south) world coords. The NW
    // corner has the LARGEST wx (most west) and LARGEST wy (most north). +wx increases west,
    // +wy increases north; both are flipped to canvas coords by the existing projection.
    const realNW = (d) => ({
        wx: MAP_WORLD_ORIGIN - d.leftCol * MAP_TILE_YD,
        wy: MAP_WORLD_ORIGIN - d.topRow * MAP_TILE_YD,
    });
    const widthYd = (d) => d.cols * MAP_TILE_YD;   // east-west extent in yards
    const heightYd = (d) => d.rows * MAP_TILE_YD;  // north-south extent in yards

    // Synthetic NW corners. Anchor Kalimdor at (0, 0); EK to the east of Kalimdor with a gap and
    // its top edge aligned; Outland centered horizontally below the shorter continent.
    const synKal = { wx: 0, wy: 0 };
    const synEK  = { wx: -widthYd(kal) - WORLD_LAYOUT_GAP_YD, wy: 0 };
    const ekBottom  = synEK.wy  - heightYd(ek);
    const kalBottom = synKal.wy - heightYd(kal);
    // Outland's top edge touches the bottom edge of the SHORTER continent. EK is usually shorter
    // (42 vs 47 tiles); guard with Math.max so this stays correct if dims ever shift.
    const shorterBottom = Math.max(ekBottom, kalBottom); // larger wy = farther north = shorter
    // Horizontally center Outland between Kalimdor's west edge and EK's east edge.
    const kalWestEdge = synKal.wx;                                       // = 0
    const ekEastEdge  = synEK.wx - widthYd(ek);
    const spanCenter  = (kalWestEdge + ekEastEdge) / 2;
    const synOut = { wx: spanCenter + widthYd(out) / 2, wy: shorterBottom };

    const synNW = { [KAL]: synKal, [EK]: synEK, [OUT]: synOut };
    const offsets = {};
    for (const id of need) {
        const rn = realNW(dims(id));
        offsets[id] = { dWx: synNW[id].wx - rn.wx, dWy: synNW[id].wy - rn.wy };
    }
    __worldLayout = {
        knownInstances: new Set(need),
        offsetOf(inst) { return offsets[String(inst)] || null; },
        synNWOf(inst) { return synNW[String(inst)] || null; },
    };
    return __worldLayout;
}
let __mapAtlas = null;          // instanceId -> { top:[col,row], img:HTMLImageElement, ready:bool, failed:bool }
let __mapAtlasPromise = null;   // dedup the atlas.json fetch
function loadMapAtlas(onReady) {
    if (__mapAtlas) return __mapAtlas;
    if (!__mapAtlasPromise) {
        __mapAtlasPromise = fetch('map/atlas.json')
            .then(r => r.json())
            .then(json => {
                __mapAtlas = {};
                for (const [id, entry] of Object.entries(json)) {
                    const path = entry.sizes?.[0]?.path;
                    if (!path) continue;
                    const img = new Image();
                    const slot = { top: entry.top, tiles: entry.tiles, nw: entry.nw, img, ready: false, failed: false };
                    img.onload = () => { slot.ready = true; if (onReady) onReady(); };
                    img.onerror = () => { slot.failed = true; };
                    img.src = 'map/' + path;
                    __mapAtlas[id] = slot;
                }
            })
            .catch(() => { __mapAtlas = {}; });
    }
    return null;
}

// Draw the overhead reference PNG slice for each instance present in `instances` (Set of stringified
// ids) at 50% opacity into the current canvas. Uses the same projX/projY world→canvas transform as
// the trajectory itself, so paths line up with terrain without any extra math. Called before paths.
//
// NOTE on axis naming: GEOSPATIAL.md claims "+X = north, +Y = west", and Lumberjack.lua's
// UnitPosition assignment matches that label scheme. But in practice the trajectory projection ends
// up rendering wx → canvas-x (east-west) and wy → canvas-y (north-south) with north up, west left.
// Easiest interpretation: treat the stored `wx` column as the east-west axis and `wy` as
// north-south for the purpose of placing the overhead PNG.
//   atlas.json `top: [leftCol, topRow]` — leftCol indexes the east-west tile axis (→ wx),
//   topRow indexes the north-south tile axis (→ wy).
function drawMapBackdrop(ctx, instances, projX, projY, isWorld = false) {
    if (!__mapAtlas) return;
    const layout = isWorld ? getWorldLayout() : null;
    ctx.save();
    ctx.globalAlpha = 0.5;
    const prevSmoothing = ctx.imageSmoothingEnabled;
    for (const id of instances) {
        const slot = __mapAtlas[id];
        if (!slot || !slot.ready) continue;
        const img = slot.img;
        const [cols, rows] = slot.tiles;
        const [leftCol, topRow] = slot.top;
        // Zone mode: anchor on the per-continent SNAPPED NW corner (from atlas.json `nw`). The
        // raster was resampled with a sub-pixel shift so that every internal image-pixel center
        // lands on a 10-yard world grid position. Width/height in yards = naturalWidth/Height × 10
        // (raster is exactly 10 yd/px). Tile edges therefore no longer match
        // MAP_WORLD_ORIGIN - col*MAP_TILE_YD (off by up to 5 yd at the snap step), but the terrain
        // content lines up with the 10-yd grid, which is what's actually visible.
        //
        // World mode: anchor on the UN-SNAPPED real NW so trajectory data (placed at raw world
        // coords + synthetic offset) lines up with the image. The 10-yd grid isn't visible at
        // world-view zoom levels (canvas is far too small for 10-yd lines to clear MIN_PX_PER_STEP),
        // so the snap's grid-alignment benefit doesn't apply here anyway.
        let wxWest, wyNorth, wxEastYd, wySouthYd;
        if (layout) {
            const off = layout.offsetOf(id);
            if (!off) continue;
            wxWest = (MAP_WORLD_ORIGIN - leftCol * MAP_TILE_YD) + off.dWx;
            wyNorth = (MAP_WORLD_ORIGIN - topRow * MAP_TILE_YD) + off.dWy;
            wxEastYd = cols * MAP_TILE_YD;
            wySouthYd = rows * MAP_TILE_YD;
        } else {
            const [wxWestSnap, wyNorthSnap] = slot.nw;
            wxWest = wxWestSnap;
            wyNorth = wyNorthSnap;
            wxEastYd = img.naturalWidth * 10;
            wySouthYd = img.naturalHeight * 10;
        }
        const wxEast = wxWest - wxEastYd;
        const wySouth = wyNorth - wySouthYd;
        // Image (0,0) is NW corner → (projX(wxWest), projY(wyNorth)) on canvas (top-left).
        // Image (imgW, imgH) is SE corner → (projX(wxEast), projY(wySouth)) (bottom-right).
        const x0 = projX(wxWest);
        const y0 = projY(wyNorth);
        const x1 = projX(wxEast);
        const y1 = projY(wySouth);
        const drawW = Math.abs(x1 - x0);
        const drawH = Math.abs(y1 - y0);
        // Nearest-neighbor when drawing larger than native (zoomed past 100%): preserves the pixel
        // grid instead of bilinear-smearing it. Below 100% we want smoothing back on so downscale
        // doesn't shimmer/alias. Toggled per-image because each continent can hit a different ratio
        // in world view, though in practice they share the same canvas scale.
        ctx.imageSmoothingEnabled = drawW <= img.naturalWidth;
        ctx.drawImage(img, Math.min(x0, x1), Math.min(y0, y1), drawW, drawH);
    }
    ctx.imageSmoothingEnabled = prevSmoothing;
    ctx.restore();
}

// Build the pan/zoom-invariant geometry for a given (data, zone, colorByLevel, W, H). Coords are
// NORMALIZED: nx, ny ∈ roughly [0, 1] across the squared yard-space bounds, with the X/Y flips
// already baked in. Projection at draw time is then a pure affine: px = panX + nx * S * scale,
// py = panY + ny * S * scale, where S = max(W, H). Pan and zoom do NOT invalidate this cache —
// only data identity, zone, colorByLevel, or canvas size do. See drawTrajectory for the projection.
function buildGeomCache(data, zoneName, opts, W, H) {
    const isWorld = zoneName === '__world__';
    const teleportThresh = 100;
    const teleportThresh2 = teleportThresh * teleportThresh;
    const pollRows = data.rows;

    // World mode reprojects rows/events/kills through getWorldLayout() so continents sit side-by-side
    // instead of stacking on raw (wx, wy). Rows whose instance isn't covered by the layout are
    // dropped — the world view only renders continents we have maps for. In zone mode this is a
    // no-op pass-through.
    const worldLayout = isWorld ? getWorldLayout() : null;
    // Per-row predicate against PollRows index. Used by the bounds + decimation pass below. Returns
    // [includedFlag, projectedWx, projectedWy] inlined as three locals to avoid per-row alloc.
    // For world mode we need a stable inst→offset cache so we don't call offsetOf() on every row.
    const worldOffByInst = new Int8Array(0); // unused placeholder when !isWorld
    let offsetForInst;
    if (isWorld && worldLayout) {
        // Build a small lookup table: instance id → {dWx, dWy} or null. Inst ids are small (<10
        // realistically); a plain Map is fine and the cost is per-distinct-inst, not per-row.
        const cache = new Map();
        offsetForInst = (inst) => {
            if (cache.has(inst)) return cache.get(inst);
            const off = worldLayout.offsetOf(inst) || null;
            cache.set(inst, off);
            return off;
        };
    }
    const targetZone = isWorld ? null : zoneName;

    // Bounds padded to a square so 1 yard east = 1 yard north on canvas. 5% extra padding so paths
    // don't kiss the edge. Also collect the set of instanceIds that contributed rows — used by the
    // map backdrop to pick which overhead PNGs to draw.
    //
    // MIN_BOUNDS_YD floors how zoomed-in the default framing can get: a filter that selects a tiny
    // segment (~5 yd in an inn) would otherwise frame the canvas to that 5-yd box at the start, so
    // the user has to scroll out a lot before they see context. Floor of 100 yd keeps the default
    // view recognizable while still framing small segments reasonably. User wheel zoom is uncapped
    // (see attachZoomHandlers) so this only affects fit/auto-frame.
    const MIN_BOUNDS_YD = 100;
    const instances = new Set();
    let bounds;
    {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const n = pollRows.length;
        if (isWorld) {
            for (let i = 0; i < n; i++) {
                if (!pollRows.hasWorldAt[i]) continue;
                const inst = pollRows.inst[i];
                const off = offsetForInst ? offsetForInst(inst) : null;
                if (!off) continue;
                instances.add(String(inst));
                const wx = pollRows.wx[i] + off.dWx;
                const wy = pollRows.wy[i] + off.dWy;
                if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
                if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
            }
        } else {
            // Zone mode: walk the RLE zone column to find the run(s) matching targetZone, then
            // pull wx/wy from the dense backbone for those index ranges. Beats touching every row.
            const pairs = pollRows._zoneRle || [];
            for (let k = 0; k < pairs.length; k++) {
                if (pairs[k][1] !== targetZone) continue;
                const start = pairs[k][0];
                const end = (k + 1 < pairs.length) ? pairs[k + 1][0] : n;
                for (let i = start; i < end; i++) {
                    // Every in-zone row contributes its instance to the backdrop pick. Instance 0
                    // is Eastern Kingdoms — a real, common value, so we add unconditionally; the
                    // backdrop renderer culls instances it doesn't have an atlas slot for.
                    if (pollRows.hasWorldAt[i]) instances.add(String(pollRows.inst[i]));
                    const wx = pollRows.wx[i], wy = pollRows.wy[i];
                    if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
                    if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
                }
            }
        }
        // In world mode, always frame ALL three known continents so the user can see the full
        // layout even when their data only covers one. Also force `instances` to the full set so
        // the map backdrop draws all three regardless of where rows landed.
        if (isWorld && worldLayout) {
            for (const id of worldLayout.knownInstances) {
                instances.add(id);
            }
        }
        if (!isFinite(minX)) bounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
        else {
            const padX = (maxX - minX) * 0.05, padY = (maxY - minY) * 0.05;
            const w = (maxX - minX) + 2 * padX, h = (maxY - minY) + 2 * padY;
            const side = Math.max(w, h, MIN_BOUNDS_YD);
            const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
            bounds = { minX: cx - side / 2, maxX: cx + side / 2, minY: cy - side / 2, maxY: cy + side / 2 };
        }
    }

    // WoW world axes: UnitPosition returns (Y, X, Z, instance). +Y is west, +X is north. Standard
    // map orientation = north up, east right, so canvas horizontal flips wx and vertical flips wy.
    // Both flips live in the (1 - …) terms here, so projection at draw time is a pure affine.
    const rangeX = bounds.maxX - bounds.minX;
    const rangeY = bounds.maxY - bounds.minY;
    const normX = (wx) => 1 - (wx - bounds.minX) / rangeX;
    const normY = (wy) => 1 - (wy - bounds.minY) / rangeY;

    // Stride decimation per session — logger runs at 10Hz so even short runs hit tens of thousands
    // of rows per session; drawing every segment is wasted CPU since canvas is only ~1000px wide.
    // Cached on `data` keyed by (zone, isWorld) so pan/zoom/hover redraws hit it. TARGET_PER_SESSION
    // is sized generously so ~4× zoom-in still has ≥canvas-width samples; re-decimating on zoom
    // would invalidate this cache on every wheel event.
    //
    // Cache shape (typed-array-backed): Map<sidString, { idx: Uint32Array, wxOut: Float32Array,
    // wyOut: Float32Array }>. `idx[k]` is the row index into pollRows for the k-th decimated
    // sample. `wxOut/wyOut` are the *projection-space* coords for that sample — equal to
    // pollRows.wx/wy in zone mode, offset by the synthetic per-continent layout in world mode.
    // Decimation is stride-based; we add the last row explicitly to keep the trajectory's endpoint.
    const TARGET_PER_SESSION = 8000;
    const trajCacheKey = `traj:${isWorld ? '__world__' : zoneName}`;
    if (!data._trajCache) data._trajCache = {};
    let bySession = data._trajCache[trajCacheKey];
    if (!bySession) {
        bySession = new Map();
        // First pass: collect raw indices per sid (filtered by zone / world-layout). We accumulate
        // to plain JS arrays here because sizes are unknown; switch to typed arrays during decimation.
        const rawIdxBySid = new Map();
        const n = pollRows.length;
        if (isWorld) {
            for (let i = 0; i < n; i++) {
                if (!pollRows.hasWorldAt[i]) continue;
                if (offsetForInst && !offsetForInst(pollRows.inst[i])) continue;
                const sidStr = pollRows._sidStrings[pollRows.sid[i]];
                let arr = rawIdxBySid.get(sidStr);
                if (!arr) { arr = []; rawIdxBySid.set(sidStr, arr); }
                arr.push(i);
            }
        } else {
            const pairs = pollRows._zoneRle || [];
            for (let k = 0; k < pairs.length; k++) {
                if (pairs[k][1] !== targetZone) continue;
                const start = pairs[k][0];
                const end = (k + 1 < pairs.length) ? pairs[k + 1][0] : n;
                for (let i = start; i < end; i++) {
                    const sidStr = pollRows._sidStrings[pollRows.sid[i]];
                    let arr = rawIdxBySid.get(sidStr);
                    if (!arr) { arr = []; rawIdxBySid.set(sidStr, arr); }
                    arr.push(i);
                }
            }
        }
        // Second pass: decimate each session's indices and materialize the projection coords.
        for (const [sidStr, rawArr] of rawIdxBySid) {
            const stride = rawArr.length > TARGET_PER_SESSION
                ? Math.floor(rawArr.length / TARGET_PER_SESSION) : 1;
            // Compute the output length: ceil(N/stride) plus 1 if we'd otherwise drop the last row.
            const sampledCount = Math.ceil(rawArr.length / stride);
            const includesLast = (sampledCount - 1) * stride === rawArr.length - 1;
            const outLen = sampledCount + (includesLast ? 0 : (rawArr.length > 0 ? 1 : 0));
            const idx = new Uint32Array(outLen);
            const wxOut = new Float32Array(outLen);
            const wyOut = new Float32Array(outLen);
            let w = 0;
            for (let k = 0; k < rawArr.length; k += stride) {
                const i = rawArr[k];
                idx[w] = i;
                if (isWorld) {
                    const off = offsetForInst(pollRows.inst[i]);
                    wxOut[w] = pollRows.wx[i] + off.dWx;
                    wyOut[w] = pollRows.wy[i] + off.dWy;
                } else {
                    wxOut[w] = pollRows.wx[i];
                    wyOut[w] = pollRows.wy[i];
                }
                w++;
            }
            if (!includesLast && rawArr.length > 0) {
                const i = rawArr[rawArr.length - 1];
                idx[w] = i;
                if (isWorld) {
                    const off = offsetForInst(pollRows.inst[i]);
                    wxOut[w] = pollRows.wx[i] + off.dWx;
                    wyOut[w] = pollRows.wy[i] + off.dWy;
                } else {
                    wxOut[w] = pollRows.wx[i];
                    wyOut[w] = pollRows.wy[i];
                }
                w++;
            }
            bySession.set(sidStr, { idx, wxOut, wyOut });
        }
        data._trajCache[trajCacheKey] = bySession;
    }

    const DEAD_COLOR = '#555';
    const deadSpans = data.deadSpans || [];
    const breakTs = data.breakTimestamps || new Map();

    const colorBySid = new Map();
    data.legend.forEach(l => colorBySid.set(l.sid, l.color));

    let lvlMin = Infinity, lvlMax = -Infinity;
    if (opts.colorByLevel) {
        // Sparse: read the lvl change-list values directly. Equivalent to walking every row.
        const lvlVals = pollRows._sparse.lvl.values;
        for (let i = 0; i < lvlVals.length; i++) {
            const v = lvlVals[i];
            if (v < lvlMin) lvlMin = v;
            if (v > lvlMax) lvlMax = v;
        }
        if (!isFinite(lvlMin)) lvlMin = 1;
        if (!isFinite(lvlMax)) lvlMax = 60;
    }

    // Per-color normalized-segment buffers. Two-pass: first count to size each Float32Array, then
    // fill. Avoids growing arrays per segment. Each segment is 4 floats: nx0, ny0, nx1, ny1. Reads
    // t from the dense backbone (pollRows.t) and lvl via the sparse accessor.
    const segCountByColor = new Map();
    const segmentClassification = []; // { sidStr, k, color } where k is the index into the decimated arrays
    for (const [sidStr, session] of bySession) {
        const baseColor = colorBySid.get(sidStr) || '#888';
        const { idx, wxOut, wyOut } = session;
        for (let k = 1; k < idx.length; k++) {
            const ia = idx[k - 1], ib = idx[k];
            const dt = pollRows.t[ib] - pollRows.t[ia];
            if (dt > PATH_GAP_SEC) continue;
            const dx = wxOut[k] - wxOut[k - 1];
            const dy = wyOut[k] - wyOut[k - 1];
            if (dx * dx + dy * dy > teleportThresh2) continue;
            if (hasBreakBetween(breakTs, sidStr, pollRows.t[ia], pollRows.t[ib])) continue;
            const dead = isDead(deadSpans, sidStr, pollRows.t[ib]);
            let color;
            if (dead) color = DEAD_COLOR;
            else if (opts.colorByLevel) {
                const lvl = pollRows.lvl(ib) ?? pollRows.lvl(ia);
                color = levelColor(lvl, lvlMin, lvlMax);
            } else color = baseColor;
            const alpha = alphaForDist(Math.sqrt(dx * dx + dy * dy));
            const key = `${color}|${alpha}`;
            segCountByColor.set(key, (segCountByColor.get(key) || 0) + 1);
            segmentClassification.push({ sidStr, k, color, alpha });
        }
    }
    const segments = new Map();
    const segWriteIdx = new Map();
    for (const [key, count] of segCountByColor) {
        segments.set(key, new Float32Array(count * 4));
        segWriteIdx.set(key, 0);
    }
    for (const { sidStr, k, color, alpha } of segmentClassification) {
        const { wxOut, wyOut } = bySession.get(sidStr);
        const key = `${color}|${alpha}`;
        const buf = segments.get(key);
        const w = segWriteIdx.get(key);
        buf[w]     = normX(wxOut[k - 1]);
        buf[w + 1] = normY(wyOut[k - 1]);
        buf[w + 2] = normX(wxOut[k]);
        buf[w + 3] = normY(wyOut[k]);
        segWriteIdx.set(key, w + 4);
    }

    // Session-start dots (drawn over paths). Color is the session's legend color, NOT the
    // colorByLevel hue — matches existing behavior. wxOut/wyOut are already in projection coords. yd
    // comes from MARKER_SPECS.SESSION_START so the dot shrinks with zoom and disappears under
    // MARKER_MIN_PX the same way event markers do.
    const sessionStarts = [];
    const startSpec = MARKER_SPECS.SESSION_START;
    for (const [sidStr, session] of bySession) {
        if (!session.idx.length) continue;
        sessionStarts.push({
            nx: normX(session.wxOut[0]),
            ny: normY(session.wyOut[0]),
            color: colorBySid.get(sidStr) || '#888',
            yd: startSpec.yd,
        });
    }

    // Markers — event markers + kills. Keep wx/wy alongside normalized coords so the hover
    // handler (which reads canvas._markers with .x/.y in world coords) keeps working unchanged.
    // Events/kills already carry plain (wx, wy, inst, zone) shape (events from
    // attachWorldCoordsToEvents, kills from positionKills) so we keep the per-event remap predicate
    // as a small helper — they're rare enough that the object alloc here doesn't matter.
    const remap = (r) => {
        if (r.wx == null || r.wy == null) return null;
        if (!isWorld) {
            if (r.zone !== zoneName) return null;
            return { wx: r.wx, wy: r.wy };
        }
        if (!worldLayout) return null;
        const off = worldLayout.offsetOf(r.inst);
        if (!off) return null;
        return { wx: r.wx + off.dWx, wy: r.wy + off.dWy };
    };
    const remapEvent = (e) => remap({ wx: e.wx, wy: e.wy, zone: e.z, inst: e.inst });
    const remapKill  = (k) => remap({ wx: k.wx, wy: k.wy, zone: k.zone, inst: k.inst });
    const markers = [];
    for (const k of (data.kills || [])) {
        const p = remapKill(k);
        if (!p) continue;
        const spec = MARKER_SPECS.KILL;
        markers.push({
            nx: normX(p.wx), ny: normY(p.wy),
            wx: p.wx, wy: p.wy,
            color: spec.color, yd: spec.yd, hollow: spec.hollow, emoji: spec.emoji,
            label: 'Kill: ' + (k.dest_name || 'unknown'),
        });
    }
    const events = data.events || [];
    for (const e of events) {
        const p = remapEvent(e);
        if (!p) continue;
        const spec = MARKER_SPECS[e.event];
        if (!spec) continue;
        const args = e.payload && e.payload.args;
        let label;
        if      (e.event === 'QUEST_TURNED_IN')   label = 'Quest turned in' + (args ? ' (id ' + args[0] + ', +' + (args[1] || 0) + ' xp, +' + (args[2] || 0) + 'c)' : '');
        else if (e.event === 'QUEST_ACCEPTED')    label = 'Quest accepted' + (args && args[1] ? ' (id ' + args[1] + ')' : '');
        else if (e.event === 'UI_INFO_MESSAGE')   label = (args && (args[1] || args['1'])) || 'UI info';
        else if (e.event === 'PLAYER_DEAD')       label = 'Death';
        else if (e.event === 'PLAYER_LEVEL_UP')   label = 'Level up' + (args ? ' → ' + args[0] : '');
        // Use remapped (synthetic in world mode, raw in zone mode) coords for both the normalized
        // draw position and the wx/wy stored on the marker. The wx/wy on the marker is what the
        // hover ring uses as its world-coord anchor, so it must live in the same projection space
        // as the path or the ring will land in the wrong place.
        markers.push({
            nx: normX(p.wx), ny: normY(p.wy),
            wx: p.wx, wy: p.wy,
            color: spec.color, yd: spec.yd, hollow: spec.hollow, emoji: spec.emoji,
            label,
        });
    }

    return { bounds, segments, sessionStarts, markers, instances, W, H };
}

function drawTrajectory(canvas, data, zoneName, view, opts = {}) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    // Kick off atlas load on first draw. When images finish loading, invalidate ALL trajectory
    // caches so the backdrop and the world-mode multi-continent layout (which depends on atlas-
    // derived per-instance dims) take effect without the user having to pan/zoom.
    if (!__mapAtlas) {
        loadMapAtlas(() => {
            // Atlas dims may shift the world layout — drop the cached world-mode bySession too.
            if (data._trajCache) delete data._trajCache['traj:__world__'];
            __worldLayout = null; // recompute on next access now that we have image dims
            document.querySelectorAll('canvas').forEach(c => {
                if (c._staticCache) c._staticCache = null;
                if (c._geomCache) c._geomCache = null;
                if (typeof c._redrawHook === 'function') c._redrawHook();
            });
        });
    }
    canvas._redrawHook = () => drawTrajectory(canvas, data, zoneName, view, opts);

    // Static-layer cache. Everything except the cross-view hover ring depends only on
    // (data, zone, view, colorByLevel, canvas size) — pan/zoom/zone/data invalidate it, but a
    // raw mousemove from the timeline doesn't. On a cache hit we just blit the offscreen and
    // redraw the hover ring on top, which is ~free. canvas._markers + _markerProj are also
    // stashed on the cache so the marker-hover handler still sees fresh data on cache hits.
    const cacheKey = [
        zoneName,
        view.scale, view.panX, view.panY,
        opts.colorByLevel ? 1 : 0,
        W, H,
        String(data.rows.length),
    ].join('|');
    // Also compare data identity — a filter refetch replaces the entire data object, and we
    // can't usefully fold that into a string key, so it's a separate field.
    if (canvas._staticCache && canvas._staticCache.key === cacheKey && canvas._staticCache.data === data) {
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(canvas._staticCache.bitmap, 0, 0);
        canvas._markers = canvas._staticCache.markers;
        canvas._markerProj = canvas._staticCache.markerProj;
        drawHoverRing(ctx, canvas._staticCache.markerProj, opts);
        return;
    }

    // Geometry cache — pan/zoom-invariant. Key on data identity, zone, colorByLevel, W, H. Any of
    // those changing invalidates; pure pan/zoom does not. Pan/zoom redraws still go through the
    // full drawTrajectory path below (which projects on the fly), but the heavy classification
    // work — bounds, decimation, segment dead/break filtering, marker filtering — is reused.
    const geomKey = [
        zoneName,
        opts.colorByLevel ? 1 : 0,
        W, H,
        String(data.rows.length),
    ].join('|');
    if (!canvas._geomCache || canvas._geomCache.key !== geomKey || canvas._geomCache.data !== data) {
        canvas._geomCache = {
            key: geomKey,
            data,
            geom: buildGeomCache(data, zoneName, opts, W, H),
        };
    }
    const geom = canvas._geomCache.geom;
    const bounds = geom.bounds;

    ctx.clearRect(0, 0, W, H);

    // Background — grid is drawn later (after projection is set up) so it can be world-aligned.
    ctx.fillStyle = '#0e1014';
    ctx.fillRect(0, 0, W, H);
    // Canvas-aligned border (frames the viewport regardless of pan/zoom).
    ctx.strokeStyle = '#2a2f3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

    // Project from normalized coords (nx, ny stored in the geom cache) to canvas pixels.
    // Uniform projection unit S = max(W,H) preserves aspect while covering the smaller canvas axis
    // at scale=1. Both flips (east-right, north-up) are already baked into the normalized coords.
    const S = Math.max(W, H);
    const SS = S * view.scale;
    const panX = view.panX, panY = view.panY;
    // World-coord projection used by the grid and the hover ring (markerProj contract).
    const projX = (wx) => panX + (1 - (wx - bounds.minX) / (bounds.maxX - bounds.minX)) * SS;
    const projY = (wy) => panY + (1 - (wy - bounds.minY) / (bounds.maxY - bounds.minY)) * SS;

    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Clip to canvas so panned content doesn't leak past the border.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    // Overhead-map backdrop — drawn under the grid + paths so they sit on top. Uses the same
    // projX/projY world transform as everything else, so terrain lines up with trajectories. In
    // world mode the per-instance synthetic offsets from getWorldLayout() relocate each PNG into
    // its slot in the side-by-side multi-continent layout.
    if (geom.instances && geom.instances.size) {
        drawMapBackdrop(ctx, geom.instances, projX, projY, zoneName === '__world__');
    }

    // World-aligned reference grid in real yards. Three nested levels (10/100/1000 yd); each
    // hides itself when its pixel spacing collapses below MIN_PX_PER_STEP so we don't draw a
    // muddy wash of lines on zoomed-out views. Lines are stroked in WORLD coords (projected
    // through projX/projY) so they pan and zoom with the data.
    drawYardGrid(ctx, projX, projY, bounds, view, W, H);

    // Per-color Path2Ds are built ONCE in normalized 0..1 space and cached on the geom (geom is
    // pan/zoom-invariant). Pan-frame work is then: setTransform → N strokes. The transform maps
    // normalized → canvas pixels, so the cached paths never need to be rebuilt for pan/zoom.
    // lineWidth needs to be inverse-scaled because the transform scales stroke width too.
    if (!geom.paths) {
        const paths = new Map();
        for (const [key, buf] of geom.segments) {
            const pipe = key.lastIndexOf('|');
            const color = key.slice(0, pipe);
            const alpha = parseFloat(key.slice(pipe + 1));
            const p = new Path2D();
            for (let i = 0; i < buf.length; i += 4) {
                p.moveTo(buf[i], buf[i + 1]);
                p.lineTo(buf[i + 2], buf[i + 3]);
            }
            paths.set(key, { path: p, color, alpha });
        }
        geom.paths = paths;
    }
    ctx.save();
    ctx.setTransform(SS, 0, 0, SS, panX, panY);
    ctx.lineWidth = 1.5 / SS;
    for (const { path, color, alpha } of geom.paths.values()) {
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    // Markers + session starts — drawn after paths so they sit on top. Radii are in WORLD YARDS
    // so they shrink with zoom; below MARKER_MIN_PX we skip the draw to keep the far-zoom-out view
    // clean. pxPerYard = (S * scale) / bounds-side, which is the same as 1 / yardsPerPixel.
    const R = bounds.maxX - bounds.minX;
    const pxPerYard = (R > 0 && isFinite(R)) ? (SS / R) : 0;
    // Session-start dots first so event markers stamp on top of them when they overlap.
    // Viewport cull: skip the draw entirely if the marker's bounding box lies outside the canvas.
    for (const s of geom.sessionStarts) {
        const r = s.yd * pxPerYard;
        if (r < MARKER_MIN_PX) continue;
        const px = panX + s.nx * SS, py = panY + s.ny * SS;
        if (px + r < 0 || px - r > W || py + r < 0 || py - r > H) continue;
        drawMarker(ctx, px, py, s.color, r, false);
    }
    const markersForHover = [];
    for (const m of geom.markers) {
        const r = m.yd * pxPerYard;
        const px = panX + m.nx * SS, py = panY + m.ny * SS;
        if (r >= MARKER_MIN_PX && px + r >= 0 && px - r <= W && py + r >= 0 && py - r <= H) {
            drawMarker(ctx, px, py, m.color, r, m.hollow, m.emoji);
        }
        // Always keep the marker in the hover list, even when off-screen or sub-pixel — small dots
        // still get a 12-px hit radius (defined in attachZoomHandlers), and timeline-driven hovers
        // can legitimately target an off-screen marker (the hover ring will fall outside the clip).
        markersForHover.push({ x: m.wx, y: m.wy, label: m.label });
    }
    // Hover-ring needs to remap raw (wx, wy, inst) → projection coords in world mode, so we stash
    // the zone identity on markerProj for drawHoverRing to consult.
    const markerProj = { projX, projY, bounds, isWorld: zoneName === '__world__' };
    canvas._markers = markersForHover;
    canvas._markerProj = markerProj;

    ctx.restore(); // close clip before snapshotting so the cache contains the final pixels

    // Snapshot what we just drew so timeline-hover mousemoves can blit instead of redrawing
    // the whole path. The cache stays valid until view/zone/data/size changes (see top of fn).
    // OffscreenCanvas where available (Chromium/Firefox); plain <canvas> fallback otherwise.
    const offscreen = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(W, H)
        : Object.assign(document.createElement('canvas'), { width: W, height: H });
    offscreen.getContext('2d').drawImage(canvas, 0, 0);
    canvas._staticCache = {
        key: cacheKey,
        data,
        bitmap: offscreen,
        markers: markersForHover,
        markerProj,
    };

    // Cross-view hover ring — drawn after the snapshot so it isn't baked in.
    drawHoverRing(ctx, markerProj, opts);
}

function drawHoverRing(ctx, markerProj, opts) {
    let hoverX = opts.hover?.wx;
    let hoverY = opts.hover?.wy;
    if (hoverX == null || hoverY == null) return;
    // In world mode the path is drawn in synthetic coords; the timeline-fed hover comes from a
    // raw poll row, so we need to remap before projecting. The canvas-side mousemove handler
    // already writes synthetic coords back into hoverPoint (it uses the inverse of the same
    // projection), so we only remap if the hover carries an instance id, which only the timeline
    // path attaches.
    if (markerProj.isWorld && opts.hover?.inst != null) {
        const layout = getWorldLayout();
        const off = layout?.offsetOf(opts.hover.inst);
        if (!off) return; // hovered row is in an instance we don't render — skip
        hoverX += off.dWx;
        hoverY += off.dWy;
    }
    const hx = markerProj.projX(hoverX);
    const hy = markerProj.projY(hoverY);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(hx, hy, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.arc(hx, hy, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

// World-aligned reference grid at 10/100/1000 yard intervals. Each level fades in as zoom
// increases past its readable density; finer levels disappear first on zoom-out so the chart
// doesn't drown in lines. Stroked in canvas pixels but positioned via the wx/wy projection so
// lines stick to world coords during pan/zoom.
function drawYardGrid(ctx, projX, projY, bounds, view, W, H) {
    const R = bounds.maxX - bounds.minX;
    if (!isFinite(R) || R <= 0) return;
    const S = Math.max(W, H);
    // R / (S * scale) = yards per canvas pixel along each world axis (square bounds, uniform proj).
    const yardsPerPixel = R / (S * view.scale);
    if (!isFinite(yardsPerPixel) || yardsPerPixel <= 0) return;

    const MIN_PX_PER_STEP = 6; // below this, lines mush together — drop the level.
    const LEVELS = [
        { step: 10,   color: '#0003' }, // very dark minor
        { step: 100,  color: '#0006' }, // medium (matches original grid brightness)
        { step: 1000, color: '#0008' }, // brighter reference
    ];

    // Inverse-project canvas X=0 and X=W to wx range. projX(wx) = panX + (1 - (wx-minX)/R) * S * scale.
    // Solving: wx(cx) = minX + R * (1 - (cx - panX) / (S * scale)).
    const wxAtCx = (cx) => bounds.minX + R * (1 - (cx - view.panX) / (S * view.scale));
    const wyAtCy = (cy) => bounds.minY + R * (1 - (cy - view.panY) / (S * view.scale));
    // X-flip means cx=0 → wxAt0 is the LARGER wx; we want a sorted range for the loop.
    let wxLo = wxAtCx(W), wxHi = wxAtCx(0);
    if (wxLo > wxHi) [wxLo, wxHi] = [wxHi, wxLo];
    let wyLo = wyAtCy(H), wyHi = wyAtCy(0);
    if (wyLo > wyHi) [wyLo, wyHi] = [wyHi, wyLo];

    ctx.save();
    ctx.lineWidth = 1;
    for (const { step, color } of LEVELS) {
        if (step / yardsPerPixel < MIN_PX_PER_STEP) continue;
        ctx.strokeStyle = color;
        ctx.beginPath();
        const firstX = Math.ceil(wxLo / step) * step;
        for (let wx = firstX; wx <= wxHi; wx += step) {
            const px = Math.round(projX(wx)) + 0.5; // crisp 1px stroke
            ctx.moveTo(px, 0); ctx.lineTo(px, H);
        }
        const firstY = Math.ceil(wyLo / step) * step;
        for (let wy = firstY; wy <= wyHi; wy += step) {
            const py = Math.round(projY(wy)) + 0.5;
            ctx.moveTo(0, py); ctx.lineTo(W, py);
        }
        ctx.stroke();
    }
    ctx.restore();
}

function drawMarker(ctx, x, y, color, r, hollow = false, emoji = null) {
    if (emoji) {
        // Text-style glyph (e.g. skull-and-crossbones ☠︎). Sized so the glyph height ≈ 2r — sans-serif
        // cap height is ~0.7em, but emoji/symbol glyphs tend to fill closer to the full em box, so
        // 2r as the font size lands close to a marker disc of radius r. textAlign/textBaseline restore
        // is implicit (we don't touch them between calls; defaults reset per ctx restore at higher
        // scopes).
        ctx.font = (2 * r) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(emoji, x, y);
        return;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (hollow) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    } else {
        ctx.fillStyle = color;
        ctx.fill();
    }
}

// Level → blue (low) → green → yellow → red (high). Maps lvl ∈ [min, max] → hue 240..0.
function levelColor(lvl, lvlMin, lvlMax) {
    if (lvl == null) return '#666';
    const span = Math.max(1, lvlMax - lvlMin);
    const t = (lvl - lvlMin) / span;
    const hue = 240 * (1 - t); // 240 = blue, 0 = red
    return `hsl(${hue}, 70%, 55%)`;
}
