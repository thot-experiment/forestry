# Geospatial reference — WoW BC world coords ↔ map images

How the trajectory viewer's coordinate system relates to WoW's world, and how the overhead reference PNGs in `src/Sawmill/www/map/` are georeferenced to it.

## World coordinate system

The logger records player position via `UnitPosition("player")` (BC return order: `y, x, z, instanceID`) and stores the two horizontal components on each row as `wx` and `wy`, both in WoW world yards. `src/Lumberjack/Lumberjack.lua` performs the assignment.

Empirically, after the projection in `src/Sawmill/www/app.js` runs, the canvas renders **north-up, west-left** when zone-shape recognizable areas are inspected against in-game knowledge. Treat that as the contract — names like "wx" / "wy" are storage labels, not axis claims. The single source of truth for which stored column ends up on which canvas axis is the projection itself: `normX(wx) → canvas-x` and `normY(wy) → canvas-y`, both with a `1 - …` flip. See `buildGeomCache` and the projection block in `drawTrajectory`.

Z is up (unused by the 2D map).

## ADT tile grid (the anchor for everything else)

Every WoW continent is a fixed **64×64 grid of ADT terrain tiles**. Each tile is exactly **533.33333 yd** (1600/3) on a side. Total continent extent: 64 × 533.333 ≈ **34133.33 yd** per side.

The grid is anchored such that **tile `(0, 0)`'s top-left (north-west) corner is at world `(+17066.666, +17066.666)`**, and tile indices increase as world coords decrease.

For tile index `(col, row)` (both 0..63), in storage-column terms the tile occupies:

```
wy range: [17066.666 - (col+1) * 533.333,  17066.666 - col * 533.333]
wx range: [17066.666 - (row+1) * 533.333,  17066.666 - row * 533.333]
```

Continent overhead exports from wow.export are renders of this grid (full 64×64 or a sub-rect of populated tiles).

## The reference PNGs

Three overhead exports live in `src/Sawmill/www/map/`. Filename schema:

```
<instanceId>_<tilesize>.png
```

- `<instanceId>` — World map identifier (0 = Eastern Kingdoms, 1 = Kalimdor, 530 = Outland).
- `<tilesize>` — pixels per ADT tile in the image.

Metadata (name, tile origin, tile count, and available sizes) is stored in `src/Sawmill/www/map/atlas.json`. The `top` field is `[leftCol, topRow]` — the tile-grid index of the NW corner of the cropped image. The `tiles` field is `[cols, rows]` — the tile extent of the crop; the renderer multiplies this by `MAP_TILE_YD` to get the world-yard rect rather than dividing image pixel dims (which would drift when raster sizes are rounded). The first entry of `sizes` is the active backdrop; later entries are kept for reference / future use.

Current files:

| File | Pixel size | Tiles (W×H) | Tile origin (col, row) |
|---|---|---|---|
| `0_53.png` | 1120 × 2240 | 21 × 42 | (24, 20) |
| `1_53.png` | 1600 × 2507 | 30 × 47 | (19, 9) |
| `530_53.png` | 2613 × 2080 | 49 × 39 | (12, 6) |
| `0_64.png` | 1344 × 2688 | 21 × 42 | (24, 20) |
| `1_64.png` | 1920 × 3008 | 30 × 47 | (19, 9) |
| `530_64.png` | 3136 × 2496 | 49 × 39 | (12, 6) |
| `0_512.png` | 10752 × 21504 | 21 × 42 | (24, 20) |
| `1_512.png` | 15360 × 24064 | 30 × 47 | (19, 9) |
| `530_512.png` | 25088 × 19968 | 49 × 39 | (12, 6) |

The `_53` set is the active backdrop, sized at exactly **160/3 ≈ 53.333 px per ADT tile** so 1 image pixel = 10 world yards. That makes the pixel grid line up cleanly with the in-game 5-yd / 10-yd ranges and lets the renderer flip to nearest-neighbor on zoom-in (>100%) without resampling artifacts. The `_64` set is an older Lanczos downsample kept around as a fallback. The `_512` originals are kept for re-sampling or vector tracing later.

Note that two of the `_53` images can't land on integer dimensions cleanly (Kalimdor would want height 2506.666, Outland would want width 2613.333) and are rounded up/down to the nearest integer. The renderer pulls tile counts from `atlas.json`'s `tiles` field rather than from `naturalWidth / 53.333` so this rounding does not propagate into world-coord placement — the image is still drawn into its exact world-yard rect.

### Grid-snapped resampling

A naive resample of `_512 → _53` would put internal image pixels at world positions `wxWest_true - (i + 0.5) × 10` where `wxWest_true = 17066.666… - col × 533.333…` — a number that isn't a multiple of 10. So image pixels would land ~3.3 yd off the 10-yard grid lines drawn by the renderer, and the misalignment is visible at zoom levels where the 10-yd grid is on screen.

Fix: when generating the `_53` set, apply a sub-pixel offset during resampling so that the output's pixel `(0, 0)` corner sits at a snapped NW corner `(wxWestSnap, wyNorthSnap)` where each coord is rounded to the nearest multiple of 10. The shift is at most ±5 yd of source content (≈3.2 source pixels at 1.04 yd/px), well inside Nyquist for the 10-yd output grid. The snapped corners are stored back into `atlas.json` as the `nw: [wxWest, wyNorth]` field. `drawMapBackdrop` anchors the image at `slot.nw` and uses `naturalWidth/Height × 10 yd` for the world extent. Tile edges no longer align with `MAP_WORLD_ORIGIN - col × MAP_TILE_YD` — they're off by up to 5 yd — but tile-edge alignment is invisible and grid-on-terrain alignment is what we actually look at.

In world view this snap is bypassed: the image is anchored on the un-snapped real NW so it lines up with trajectory data (which is placed at raw world coords plus a synthetic-layout offset). At world-view zoom the 10-yd grid is never visible (canvas is far too small for `step / yardsPerPixel ≥ MIN_PX_PER_STEP`) so the snap's benefit doesn't apply here.

Resampling command (ImageMagick). Each command uses `-distort Affine` with three source→dest control points to apply the per-continent sub-pixel shift in a single Lanczos resample pass. The shift values for `0`/`1`/`530` are `(−3.333, 0)`, `(+3.333, −3.333)`, `(−3.333, −3.333)` source yards; converted to source-pixel offsets via `÷ (533.333/512)` they become the `±3.2` source-px numbers in the commands. `-virtual-pixel edge` replicates the edge for the few sub-pixel-wide slivers that fall just outside the source image after shifting:

```sh
magick 0_512.png   -virtual-pixel edge -filter Lanczos \
  -set option:distort:viewport "1120x2240+0+0" \
  -distort Affine "-3.2,0  0,0   10748.8,0   1120,0   -3.2,21504   0,2240" \
  +repage 0_53.png

magick 1_512.png   -virtual-pixel edge -filter Lanczos \
  -set option:distort:viewport "1600x2507+0+0" \
  -distort Affine "3.2,-3.2  0,0   15363.2,-3.2   1600,0   3.2,24060.8   0,2507" \
  +repage 1_53.png

magick 530_512.png -virtual-pixel edge -filter Lanczos \
  -set option:distort:viewport "2613x2080+0+0" \
  -distort Affine "-3.2,-3.2  0,0   25081.6,-3.2   2613,0   -3.2,19964.8   0,2080" \
  +repage 530_53.png
```

## Image-pixel ↔ world-yard transform

The wow.export PNGs are oriented north-up natively: image pixel-x increases east, image pixel-y increases south. The canvas projection happens to render with the same orientation (north-up, west-left), so the image draws onto the canvas with **no rotation or transpose** — just a translate+scale into the world-yard rect of the cropped image. See `drawMapBackdrop` in `src/Sawmill/www/app.js`.

For a cropped image with tile size `T` px and origin `(leftCol, topRow)`:

```
wxWest  = 17066.666 - leftCol * 533.333                  // NW corner, stored-wx (canvas-x axis)
wxEast  = 17066.666 - (leftCol + cols) * 533.333         // SE corner
wyNorth = 17066.666 - topRow * 533.333                   // NW corner, stored-wy (canvas-y axis)
wySouth = 17066.666 - (topRow + rows) * 533.333          // SE corner
```

NW corner of the cropped image lives at canvas position `(projX(wxWest), projY(wyNorth))`; SE corner at `(projX(wxEast), projY(wySouth))`. The backdrop is drawn at 50% opacity before the yard grid and trajectory.

NW/SE corners of each PNG in storage coords, useful for sanity checks:

| Continent | NW (wx, wy) | SE (wx, wy) |
|---|---|---|
| Azeroth (EK) | (+4266.66, +6400.00) | (−6933.33, −16000.00) |
| Kalimdor | (+6933.33, +12266.66) | (−9066.66, −12800.00) |
| Outland | (+10666.66, +13866.66) | (−15466.66, −6933.33) |

(NW has the largest `wx` and largest `wy` of any pixel in the image; SE has the smallest of each.)

## Auto-zoom floor and wheel zoom range

`buildGeomCache` floors the auto-framing bounds at **100 yd per side** (`MIN_BOUNDS_YD`) so a filter that picks out a tiny segment (an inn, a single quest turn-in) doesn't slam the default view to a 5-yd box. The wheel zoom is effectively uncapped (`0.0001 … 10000`) so the user can scroll out to see all three continents at once even from a deep auto-zoom.

## Marker sizing

Event/kill markers in `app.js` are sized in **yards** via the `MARKER_SPECS` table — quest turn-ins and deaths are 1.5 yd, everything else is 1 yd. At draw time the marker radius scales with zoom: `r_px = yd * SS / boundsSide`. Markers below `MARKER_MIN_PX` (1 px) are skipped to keep far-out views clean; hover tooltips still work because the hit-radius is canvas-px, not marker-px.

## World view: multi-continent layout

Real WoW continents overlap in raw `(wx, wy)` — every continent's coords live in roughly the same ±17066 yard box, so drawing them at their real positions stacks them on top of each other. The `__world__` view in `src/Sawmill/www/app.js` solves this by reprojecting each instance into a synthetic plane where the three continents sit side-by-side. Layout (see `getWorldLayout`):

- **Kalimdor** anchored at synthetic NW `(0, 0)`.
- **Eastern Kingdoms** east of Kalimdor with a one-tile (533.33 yd) gap, top edges aligned.
- **Outland** centered horizontally between Kalimdor's west edge and EK's east edge, with its top edge touching the bottom edge of the shorter of the two continents (EK).

Per-instance offsets are derived from `atlas.json`'s `top` field at runtime, so the layout is data-driven. Rows/events/kills whose `inst` isn't covered by the layout (raids, dungeons, world bosses) are **dropped from the world view entirely** — they have no map. The full layout is always framed even when the player's data only covers one continent, so the empty continents' maps still show.

The world view's bounds are determined by the run's trajectory data (via the same `MIN_BOUNDS_YD` padding in `buildGeomCache`), so auto-zoom fits the active data rather than the full layout.

## Provenance and future work

- PNGs are wow.export overhead renders sourced from minimap/terrain tile data of a 2.4.3-era client.
- The 64-px-per-tile rasters are intended as a temporary backdrop only. Long-term plan: hand-trace into per-feature SVG layers (coastlines, roads, rivers, zone boundaries) authored in a viewBox using world yards directly, so the existing `projX`/`projY` projection draws them without any extra transform.
- Instances (dungeons, raids) currently have no world coords from `UnitPosition` and no map data. Out of scope for now; combat-log positions could be a path if it ever matters.
