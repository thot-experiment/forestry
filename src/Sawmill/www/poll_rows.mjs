// Lumberjack/www/poll_rows.js — typed-array-backed view of a columnar_v1 poll payload.
//
// Memory model:
//   - DENSE typed arrays for fields touched by hot loops every row: t, sid, wx, wy, wz, inst.
//     Indexed directly: rows.t[i], rows.wx[i]. No accessor overhead.
//   - SPARSE accessors for write-on-change fields. Each column stores (indices, values) for the
//     positions where the field actually changed; rows.hp(i) looks up the most recent change at or
//     before i. Lookups exploit sequential access via a per-column cursor (rows._cursors); a
//     non-sequential access falls back to binary search. At 5M rows with most fields changing in
//     ~1-15% of rows, this drops the in-memory footprint by ~5-10x vs dense.
//   - zone / sz stay as RLE pairs (rarely change) with the same cursor trick.
//
// String sids are interned to integers in `rows.sid` (Uint16Array). rows.sidOf(i) returns the
// session_id string when callers need it (legend, prettySessionLabel, debugging).
//
// Wire format documented in routes.mjs:serializePollColumns.

(function () {
    'use strict';

    // Per-column dtype for SPARSE numeric columns. Choose the smallest type that fits the value
    // range — these allocations are sized to the *change count*, not n, so a too-narrow choice
    // would silently truncate. Validated against the addon's known ranges.
    const SPARSE_DTYPES = {
        mid: Uint16Array,       // map ids fit in 16
        lvl: Uint8Array,        // 1..70
        curr_xp: Uint32Array,   // up to ~10M past lvl 60
        max_xp: Uint32Array,
        rest: Uint32Array,
        hp: Uint16Array,        // max ~30k
        mp: Uint16Array,
        en: Uint16Array,
        rg: Uint16Array,
        combat: Uint8Array,     // 0/1
        mnt: Uint8Array,        // 0/1
        stealth: Uint8Array,    // 0/1
        falling: Uint8Array,    // 0/1
        form: Uint8Array,       // small enum
        form_spell: Uint32Array,// spell ids up to ~50k
        cp: Uint8Array,         // 0..5
        // x, y are normalized zone-local coords [0,1]; rare changes. Store as Float32.
        x: Float32Array,
        y: Float32Array,
    };

    // The list of dense fields. wz is included even though only a few callers use it because it
    // changes every row anyway, so sparse storage would not save anything.
    const DENSE_FIELDS = ['t', 'sid', 'wx', 'wy', 'wz', 'inst'];

    function expandPollRows(payload) {
        if (!payload) return emptyPollRows();
        if (payload.encoding !== 'columnar_v1') {
            console.error('expandPollRows: unexpected encoding', payload.encoding);
            return emptyPollRows();
        }
        const n = payload.n | 0;
        if (n === 0) return emptyPollRows();
        const cols = payload.cols || {};
        const dense = !!payload.dense;

        const rows = Object.create(PollRowsProto);
        rows.length = n;
        rows.dense = dense;

        // t: delta-decoded. Float64 because t is seconds-since-epoch (high magnitude).
        const t = new Float64Array(n);
        const tIn = cols.t || [];
        t[0] = tIn[0] || 0;
        for (let i = 1; i < n; i++) t[i] = t[i - 1] + (tIn[i] || 0);
        rows.t = t;

        // sid: intern string → small int. Builds `rows.sid` (Uint16Array) and `rows._sidStrings`
        // (array indexed by interned int). We also forward-fill sid because a null sid in the wire
        // would be ambiguous w.r.t. the per-session carry logic. The server always emits sid for
        // every row (it's the GROUP BY column), so in practice this is a one-pass copy.
        const sidIn = cols.sid || [];
        const sidMap = new Map();
        const sidStrings = [];
        const sid = new Uint16Array(n);
        {
            let last = 0;
            for (let i = 0; i < n; i++) {
                const v = sidIn[i];
                if (v != null) {
                    let idx = sidMap.get(v);
                    if (idx === undefined) {
                        idx = sidStrings.length;
                        sidStrings.push(String(v));
                        sidMap.set(v, idx);
                    }
                    last = idx;
                }
                sid[i] = last;
            }
        }
        rows.sid = sid;
        rows._sidStrings = sidStrings;

        // Dense numeric coords. Floats so we keep wx/wy precision at world-yard magnitudes (~17k).
        // wx/wy/wz forward-fill per-sid when dense=false. Inst is small int with the same fill.
        // We also build hasWorldAt: a Uint8Array bitmask, 1 iff the row's wx is the result of an
        // actual recorded value (direct or carried forward from an earlier non-null in the same
        // session). Necessary because instance ID 0 is a legitimate instance (Eastern Kingdoms /
        // Azeroth), so we cannot use inst==0 as the "no world coords" sentinel — and wx==0 is also
        // legitimate. forwardFillBySession does this on the server side; we must reproduce here.
        const wxFill = forwardFillNumericWithMask(cols.wx, n, dense, sid, Float32Array);
        rows.wx = wxFill.arr;
        rows.hasWorldAt = wxFill.mask;
        rows.wy = forwardFillNumeric(cols.wy, n, dense, sid, Float32Array);
        rows.wz = forwardFillNumeric(cols.wz, n, dense, sid, Float32Array);
        rows.inst = forwardFillNumeric(cols.inst, n, dense, sid, Int16Array);
        // hasWorld: true iff any row in this payload had a non-null wx on the wire. Used to gate
        // the "show __world__ pseudo-zone" UI in the run header.
        rows.hasWorld = !!(cols.wx && cols.wx.some(v => v != null));

        // Sparse columns. For each, we collect (changeIdx[], value[]) walking the source array.
        // When dense=true we still sparse-encode the runs (consecutive equal values), since dense
        // just means "no carry-forward semantics" — the values themselves are still mostly stable.
        rows._sparse = {};
        for (const [name, Ctor] of Object.entries(SPARSE_DTYPES)) {
            rows._sparse[name] = buildSparseColumn(cols[name], n, dense, sid, Ctor);
        }
        // Per-column cursors used by the accessor to exploit sequential access.
        rows._cursors = Object.create(null);

        // Strings as RLE.
        rows._zoneRle = cols.zone || [];
        rows._szRle = cols.sz || [];

        return rows;
    }

    // Same as forwardFillNumeric, but additionally returns a Uint8Array bitmask: mask[i]=1 iff the
    // row's value originates from an actual non-null in the wire payload (direct or carried). When
    // dense=true every row by definition has a non-null, so mask is all-ones. When dense=false, the
    // first rows of a session with no recorded value yet have mask=0.
    function forwardFillNumericWithMask(src, n, dense, sid, Ctor) {
        const arr = new Ctor(n);
        const mask = new Uint8Array(n);
        if (!src || src.length !== n) return { arr, mask };
        if (dense) {
            mask.fill(1);
            for (let i = 0; i < n; i++) {
                const v = src[i];
                if (v != null) arr[i] = v;
            }
            return { arr, mask };
        }
        const lastBySid = [];
        const seenBySid = [];
        for (let i = 0; i < n; i++) {
            const s = sid[i];
            const v = src[i];
            if (v != null) { lastBySid[s] = v; seenBySid[s] = 1; arr[i] = v; mask[i] = 1; }
            else if (seenBySid[s]) { arr[i] = lastBySid[s]; mask[i] = 1; }
        }
        return { arr, mask };
    }

    // Forward-fill a numeric column into a dense typed array. Handles dense=true (no nulls in src)
    // and dense=false (nulls carry forward, reset per sid). Returns the typed array.
    function forwardFillNumeric(src, n, dense, sid, Ctor) {
        const out = new Ctor(n);
        if (!src || src.length !== n) return out; // column missing → zero-initialized
        if (dense) {
            for (let i = 0; i < n; i++) {
                const v = src[i];
                if (v != null) out[i] = v;
            }
            return out;
        }
        // Carry per-sid. Use a small array indexed by sid (always small N — < 100 sessions).
        const lastBySid = [];
        for (let i = 0; i < n; i++) {
            const s = sid[i];
            const v = src[i];
            if (v != null) { lastBySid[s] = v; out[i] = v; }
            else if (lastBySid[s] !== undefined) { out[i] = lastBySid[s]; }
            // else leave 0
        }
        return out;
    }

    // Build a sparse column from the source wire array. Walks src, emits (idx, value) for every
    // value that *differs from the per-sid carry*. Result: two typed arrays sized to the actual
    // change count. The accessor's lookup returns the last value with idx <= i for the same sid;
    // since the addon resets per-session and we forward-fill per-sid, the per-sid index is
    // implicit — a sparse value with idx=k applies to subsequent rows of the same sid until the
    // next sparse value (regardless of sid). That works because at every sid transition, the very
    // first row of the new session has a non-null value for every stable field (the addon dumps a
    // full snapshot at session start). Verified against forwardFillBySession's behavior in
    // routes.mjs — last value of a closing sid never bleeds into the next sid because the new
    // sid's first row always sets every stable column.
    function buildSparseColumn(src, n, dense, sid, Ctor) {
        if (!src || src.length !== n) {
            return { indices: new Uint32Array(0), values: new Ctor(0) };
        }
        // First pass: count entries we'll emit so we can size exactly.
        let count = 0;
        if (dense) {
            // dense=true: emit at every value change (sparse-encode the run).
            let last = null;
            for (let i = 0; i < n; i++) {
                const v = src[i];
                if (v == null) continue;
                if (v !== last) { count++; last = v; }
            }
        } else {
            // dense=false: src already has nulls where unchanged. Emit each non-null.
            for (let i = 0; i < n; i++) if (src[i] != null) count++;
        }
        const indices = new Uint32Array(count);
        const values = new Ctor(count);
        let w = 0;
        if (dense) {
            let last = null;
            for (let i = 0; i < n; i++) {
                const v = src[i];
                if (v == null) continue;
                if (v !== last) { indices[w] = i; values[w] = v; w++; last = v; }
            }
        } else {
            for (let i = 0; i < n; i++) {
                const v = src[i];
                if (v == null) continue;
                indices[w] = i; values[w] = v; w++;
            }
        }
        return { indices, values };
    }

    // Sparse lookup with a per-column cursor. Most loops walk i forward, so we keep a cursor
    // pointing at the last hit; if the next call still satisfies indices[cursor] <= i < indices[cursor+1],
    // it's an O(1) advance. Cursor is reset on out-of-order access via binary search.
    function sparseAt(rows, col, i) {
        const { indices, values } = col;
        if (indices.length === 0) return null;
        const cName = col._name;
        let c = rows._cursors[cName] | 0;
        if (c >= indices.length) c = indices.length - 1;
        // Slide forward if possible.
        while (c + 1 < indices.length && indices[c + 1] <= i) c++;
        // Or back up if i moved backward.
        if (indices[c] > i) {
            // Binary search for the largest index <= i.
            let lo = 0, hi = c;
            while (lo < hi) {
                const m = (lo + hi + 1) >> 1;
                if (indices[m] <= i) lo = m; else hi = m - 1;
            }
            c = lo;
        }
        rows._cursors[cName] = c;
        return indices[c] <= i ? values[c] : null;
    }

    // RLE lookup with a cursor. Same structure as sparseAt — different store.
    function rleAt(rows, pairs, cursorKey, i) {
        if (!pairs.length) return null;
        let c = rows._cursors[cursorKey] | 0;
        if (c >= pairs.length) c = pairs.length - 1;
        while (c + 1 < pairs.length && pairs[c + 1][0] <= i) c++;
        if (pairs[c][0] > i) {
            let lo = 0, hi = c;
            while (lo < hi) {
                const m = (lo + hi + 1) >> 1;
                if (pairs[m][0] <= i) lo = m; else hi = m - 1;
            }
            c = lo;
        }
        rows._cursors[cursorKey] = c;
        return pairs[c][0] <= i ? pairs[c][1] : null;
    }

    // Prototype with accessor methods. Each sparse column gets a method named after the column
    // (rows.hp(i), rows.lvl(i), ...). Built dynamically so adding a new column is a one-line
    // SPARSE_DTYPES change.
    const PollRowsProto = {};
    for (const name of Object.keys(SPARSE_DTYPES)) {
        const cursorKey = '_s_' + name;
        PollRowsProto[name] = function (i) {
            const col = this._sparse[name];
            // Annotate the column with its cursor key once. Cheap and lets sparseAt key cursors
            // without an extra map lookup.
            if (!col._name) col._name = cursorKey;
            return sparseAt(this, col, i);
        };
    }
    PollRowsProto.zone = function (i) { return rleAt(this, this._zoneRle, '_zone', i); };
    PollRowsProto.sz = function (i) { return rleAt(this, this._szRle, '_sz', i); };
    PollRowsProto.sidOf = function (i) { return this._sidStrings[this.sid[i]] || null; };
    // Row-object factory for cold paths (tooltips, debugging). Allocates a plain object — don't
    // call from hot loops.
    PollRowsProto.row = function (i) {
        return {
            t: this.t[i],
            sid: this.sidOf(i),
            wx: this.wx[i], wy: this.wy[i], wz: this.wz[i],
            inst: this.inst[i],
            zone: this.zone(i), sz: this.sz(i),
            x: this.x(i), y: this.y(i),
            lvl: this.lvl(i), curr_xp: this.curr_xp(i), max_xp: this.max_xp(i),
            rest: this.rest(i),
            hp: this.hp(i), mp: this.mp(i), en: this.en(i), rg: this.rg(i),
            combat: this.combat(i), mnt: this.mnt(i), stealth: this.stealth(i),
            falling: this.falling(i),
            form: this.form(i), form_spell: this.form_spell(i), cp: this.cp(i),
            mid: this.mid(i),
        };
    };
    // Full materialization. Used by timeline.js, which sorts + builds many per-row derived series
    // — the conversion lives for one buildTimeline call and is GC'd. Don't store the result.
    PollRowsProto.toArray = function () {
        const out = new Array(this.length);
        for (let i = 0; i < this.length; i++) out[i] = this.row(i);
        return out;
    };
    PollRowsProto[Symbol.iterator] = function* () {
        for (let i = 0; i < this.length; i++) yield this.row(i);
    };

    function emptyPollRows() {
        const rows = Object.create(PollRowsProto);
        rows.length = 0;
        rows.dense = true;
        rows.t = new Float64Array(0);
        rows.sid = new Uint16Array(0);
        rows.wx = new Float32Array(0);
        rows.hasWorldAt = new Uint8Array(0);
        rows.hasWorld = false;
        rows.wy = new Float32Array(0);
        rows.wz = new Float32Array(0);
        rows.inst = new Int16Array(0);
        rows._sidStrings = [];
        rows._sparse = {};
        for (const [name, Ctor] of Object.entries(SPARSE_DTYPES)) {
            rows._sparse[name] = { indices: new Uint32Array(0), values: new Ctor(0) };
        }
        rows._cursors = Object.create(null);
        rows._zoneRle = [];
        rows._szRle = [];
        return rows;
    }

    window.expandPollRows = expandPollRows;
    window.PollRows = { expand: expandPollRows };
})();
