# Project Forestry: WoW Speedrun Data Capture

Core capture and visualization complete (slices 0–9.12). See DEV_HISTORY.md for architecture and completed work; DEV_NOTES.md for gotchas.

## Open Work

- [ ] **8.6-future-b** Drop legacy row-shape server path. Remove the `format === 'rows'` branch in `getRunPoll` and the `fmt` dispatcher param — emit columnar unconditionally.

- [ ] **8.6-future-c** PollRows + Alpine Proxy trap. PollRows instances live inside `runPolls[runKey]`, wrapped in Alpine's reactive Proxy. Method calls on the prototype work; indexed reads on typed arrays may go through the trap. No measured pathology yet. If hot loops feel slow, hoist `data.rows` via `Alpine.raw(...)` at the top of `buildGeomCache` / `_computeZoneStats`.

- [ ] **8.6-future-d** Server scaling (defer until scale forces it): (a) default time filter to "last session" on first load, (b) server-side downsampling for unfiltered timeline, (c) streaming/paged fetch. Edge case: filtered xp_gained re-anchors per session — if window cuts mid-level, first interior row's `curr_xp` anchors the delta correctly (verified by `computeRunStats`). Comparison-mode deferred.

- [ ] **8.6-future-e** Capture max vitals in Lumberjack: `UnitHealthMax("player")` and `UnitPowerMax("player", 0)`. Necessary for accurate resource-efficiency metrics.

- [ ] **8.7 Map render: affine-only pan/zoom (DEFERRED — design complete, implementation paused)**

  **Premise.** Pan/zoom are pure affine transforms on a fixed point cloud. `drawTrajectory` re-runs all geometry work on every drag frame; cache key includes `panX/panY/scale` so any pan delta = full miss. Hot suspects: `isDead`'s linear scan over `deadSpans` (O(segments × deadSpans)), marker filter rebuild, OffscreenCanvas snapshot.

  **Goal.** Per-frame work reduced to: typed-array walk + Path2D builds + N strokes + marker re-projection. Cache invalidates ONLY on data identity change, zone change, colorByLevel toggle, or canvas resize.

  **Step 1 — ✅ COMPLETED.** `buildGeomCache(data, zoneName, opts, W, H)` extracts pan/zoom-invariant geometry in normalized `[0,1]` coords. Both axis flips (east-right, north-up) baked in at cache-build time. Cache shape:
  ```
  { bounds, segments: Map<color, Float32Array[nx0,ny0,nx1,ny1,...]>,
    sessionStarts: [{nx,ny,color}], markers: [{nx,ny,wx,wy,color,r,hollow,label}], W, H }
  ```
  Stored on `canvas._geomCache`, keyed by `(zone, colorByLevel, W, H, data identity)`. `drawTrajectory` projects from this cache; static bitmap cache still in place as second layer. Two-pass segment fill (count → preallocate Float32Array → fill) avoids per-segment array growth. Pure pan/zoom no longer triggers `buildGeomCache`.

  **Step 2 — render-path rewrite.**
  - **2a (recommended): `ctx.setTransform`.** Build `Path2D` per color at cache-build time (one-time cost). Per frame: `ctx.setTransform(S*scale, 0, 0, S*scale, panX, panY)`, stroke each Path2D, reset transform for markers/grid. Zero JS per-segment per-frame.
  - **2b: keep JS projection, skip OffscreenCanvas during drag.** Pass `opts.skipSnapshot` from drag handler; only snapshot on `mouseup`. Cheaper to ship, smaller win.
  Start with 2b to measure, commit to 2a if quality holds (Path2D + setTransform is lossless — paths are vector, no blit-then-redraw dance needed).

  **Step 3.** Once 2a lands: delete `canvas._staticCache` and the per-frame OffscreenCanvas snapshot at `app.js:1272-1282`. Timeline-hover redraws cost the same as a pan frame — sub-ms. Re-verify timeline-hover feels snappy on largest test run.

  **Step 4.** Explicit `invalidateGeomCache(runKey)` called from: `selectZone`, `fetchNow` (data identity change), `colorByLevel` toggle, fullscreen resize. Pan/zoom/hover never touch the cache.

  **Step 5 (forward-looking).** Layer registry under the transform: background image → grid → trajectory paths → SVG overlays → markers → hover ring. Each entry: `{kind: 'image'|'path2d'|'segments'|'markers', source, transform: 'world'|'pixel'}`. SVG overlays via `new Path2D(svgPathString)` stroked under the transform.

  **Gotchas.**
  - `ctx.setTransform` with a scaled coordinate space affects `lineWidth` — must divide by `S*scale` to keep strokes 1.5px on screen. `lineCap`/`lineJoin` unaffected. Test at extreme zoom (50×) that strokes don't go sub-pixel.
  - `drawYardGrid` (app.js:1312) takes pixel-space `projX`/`projY` callbacks — keep it in pixel space, called between path stroke and `setTransform` reset.
  - `data._trajCache` keyed on `(zone, isWorld)` — keep as-is, `buildGeomCache` already reuses it.
  - Filter refetch replaces `runPolls[runKey]` with a new data object identity — `canvas._geomCache.data !== data` triggers rebuild correctly.
  - Fullscreen canvas resize (`app.js:451-471`) must invalidate geom cache since `W/H` affect `S`.

  **Done criteria.** Drag 30k-row multi-session run at 60fps fullscreen. Zoom responds within a frame. Timeline-hover redraws in <2ms. No regressions in marker hover, dead-color paths, teleport breaks, color-by-level, filter sliders, cross-view hover ring, world view.


## Open Questions

- Compress archived raw inputs (gzip) or keep plaintext for diffing?
- When to visualize talents/professions snapshot data — defer until a query needs it.
- Multi-class visualization: druid (form transitions), rogue (combo points), warrior (stance switches) all have captured data but vis paths are untested with real data.


## Crazy Future Ideas

- binpack or otherwise compress the addon row data to save memory, because of how inefficient lua storage is, and because the client is effectively append only for the densest data, that means we don't have to worry about decoding or editing or anything else, we just have to have an efficient compression scheme for a given datapoint, taking into account that wow stores its variables in plaintext LUA, we can do base[number_of_printable_ascii_characters] binary encoding of float64s and it would probably still be way cheaper, and it's just one encode step so maybe not that hard to implement, then we just have one decode step on the ingest side and the pipeline can stay the same. just on intuition this could reduce cache pressure by like 4x?
- rwrite the interactive parts of the frontend in shaders, a large portion of the compute that we want to do to process and analyze the data can be computed server side *once* per session, and then a lot of the rendering transforms are really well suited to gpus since you're like, positioning a fuckton of points, we could easily go from chugging on 180k points to butter on 5m with some serious optimization
- rewrite all of the javascript stuff to use txiki.js, which is basically a stdlib for quickjs that gives you all the things you really need (incl sqlite) 2mb, can compile a project to a binary for mac/linux/windows, would make things much easier to ship and more reliably portable than node
- web assembly processing kernels for the data on the backend, run in parallell per slice, easy parallelism win on a machine with a lot of cores for any sort of data transforms you might want to do
- could potentially ship lua as a wasm module with the backend eliminating the dependency, works with txiki.js port because that has WASI support ect, shouldn't be toooo hard
