# Sawmill HTTP API

Base URL: `http://localhost:3333` (configurable via `[server] port` in `forestry.ini`)

All endpoints are GET-only. Responses are `application/json`, gzip-compressed when the payload exceeds ~1KB and the client sends `Accept-Encoding: gzip`.

---

## GET /api/snapshot

Database summary grouped by character + realm. Use this to enumerate available runs.

**Response**
```json
{
  "generated_at": 1716300000.0,
  "counts": {
    "poll":      { "rows": 500000, "latest": 1716299990 },
    "events":    { "rows": 12000,  "latest": 1716299985 },
    "snapshots": { "rows": 400,    "latest": 1716299900 },
    "cleu":      { "rows": 80000,  "latest": 1716299980 },
    "sessions":  { "rows": 42,     "latest": 1716200000 }
  },
  "runs": [
    {
      "key": "Arthas::Grobbulus",
      "character_name": "Arthas",
      "realm": "Grobbulus",
      "faction": "Alliance",
      "race": "Human",
      "class": "Paladin",
      "character_guid": "Player-...",
      "session_count": 12,
      "first_seen": 1715000000,
      "last_seen": 1716200000,
      "poll_rows": 320000,
      "event_rows": 8000,
      "cleu_rows": 50000,
      "duration": 86400,
      "lvl_min": 1,
      "lvl_max": 43,
      "sessions": [
        {
          "session_id": 7,
          "start_time": 1716100000,
          "poll_start": 1716100010,
          "poll_end": 1716108000,
          "poll_rows": 28000,
          "event_rows": 700,
          "cleu_rows": 4200,
          "lvl_min": 38,
          "lvl_max": 40,
          "client_build": "11501",
          "client_tocversion": "11502"
        }
      ]
    }
  ]
}
```

Runs are sorted by `last_seen` descending (most recently played first).

---

## GET /api/ranger

Spell ID → name lexicon built from the Ranger addon. Fetch once and cache — it changes only when new spells are observed in-game.

**Response**
```json
{
  "count": 1234,
  "spells": {
    "133": { "id": 133, "name": "Fireball", "rank": "Rank 1", "icon": "spell_fire_fireball", "school": 4 },
    "2139": { "id": 2139, "name": "Counterspell", "rank": null, "icon": "spell_frost_iceshock", "school": 64 }
  }
}
```

---

## GET /api/runs/:runKey/poll

Full poll stream + events + kills for a character run. This is the main data endpoint — the web UI fetches it once per run selection and derives all stats, trajectory, and timeline data from this response.

`:runKey` is `CharacterName::Realm`, URL-encoded (e.g. `Arthas%3A%3AGrobbulus`).

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `lvl_min` | integer | Exclude data below this character level |
| `lvl_max` | integer | Exclude data above this character level |
| `t_min` | float | Exclude data before this Unix timestamp (seconds) |
| `t_max` | float | Exclude data after this Unix timestamp (seconds) |
| `session_limit` | integer \| `all` | Only include the last N sessions. Omit or `all` = no limit |
| `fmt` | `columnar` | Use columnar_v1 wire format (see below). Default: row objects |

**Response (default `fmt=rows`)**
```json
{
  "run_key": "Arthas::Grobbulus",
  "sessions": [1, 3, 7],
  "class": "Paladin",
  "filters": { "lvl_min": 20, "lvl_max": 40 },
  "session_limit": null,
  "filter_active": true,

  "rows_all": [
    {
      "t": 1716100010, "sid": 7,
      "x": 0.512, "y": 0.341,
      "wx": -9456.2, "wy": 64.1, "wz": 56.8,
      "inst": 0, "mid": 1,
      "zone": "Elwynn Forest", "sz": "Northshire",
      "lvl": 38, "curr_xp": 14200, "max_xp": 48000,
      "hp": 980, "mp": 1240,
      "en": null, "rg": null,
      "rest": 4800,
      "combat": 0, "mnt": 0, "stealth": 0,
      "form": 0, "form_spell": null, "cp": 0, "falling": 0
    }
  ],
  "events_all": [
    {
      "t": 1716100200, "sid": 7,
      "event": "PLAYER_LEVEL_UP",
      "x": 0.51, "y": 0.34, "z": "Elwynn Forest",
      "payload": { "args": [39] }
    },
    {
      "t": 1716100350, "sid": 7,
      "event": "UNIT_SPELLCAST_SUCCEEDED",
      "x": 0.50, "y": 0.33, "z": "Elwynn Forest",
      "payload": { "args": ["player", null, 19750] },
      "spell_id": 19750, "spell_name": "Holy Light", "spell_rank": "Rank 5"
    }
  ],
  "kills_all": [
    { "t": 1716100300, "sid": 7, "dest_name": "Defias Bandit" }
  ],

  "rows": [],
  "events": [],
  "kills": [],

  "stats": {
    "duration_played": 7990,
    "xp_gained": 48200,
    "xp_per_hour": 21700.4,
    "levels_gained": 2,
    "deaths": 1,
    "quests_accepted": 4,
    "quests_turned_in": 3,
    "kills": 87,
    "jumps": 142,

    "spell_casts": [
      { "id": 19750, "name": "Holy Light", "rank": "Rank 5", "count": 312 }
    ],
    "spell_casts_by_zone": {
      "Elwynn Forest": [
        { "id": 19750, "name": "Holy Light", "rank": "Rank 5", "count": 180 }
      ]
    },

    "per_session": [
      {
        "sid": 7,
        "xp_gained": 48200,
        "duration": 7990,
        "xp_per_hour": 21700.4,
        "start_time": 1716100010,
        "lvl_min": 38, "lvl_max": 40,
        "deaths": 1,
        "level_ups": 2,
        "quests_accepted": 4,
        "quests_turned_in": 3,
        "kills": 87,
        "jumps": 142,
        "spell_casts": 312,
        "distance": 14.83,
        "top_zones": [
          { "z": "Elwynn Forest", "t": 5200 },
          { "z": "Stormwind City", "t": 1100 }
        ]
      }
    ],

    "splits": [
      {
        "idx": 0,
        "pt_start": 0, "pt_end": 900,
        "span": 900,
        "first_t": 1716100010, "last_t": 1716100910,
        "xp_gained": 6100, "xp_per_hour": 24400,
        "levels": 0,
        "lvl_start": 38, "lvl_end": 38,
        "kills": 12, "deaths": 0,
        "quests_accepted": 1, "quests_turned_in": 0,
        "distance": 2.1,
        "top_zone": "Elwynn Forest", "top_zone_seconds": 820
      }
    ]
  }
}
```

**`rows_all` / `rows` field reference**

| Field | Type | Description |
|---|---|---|
| `t` | float | Unix timestamp (seconds) |
| `sid` | integer | Session ID |
| `x`, `y` | float 0–1 | Zone-relative position |
| `wx`, `wy`, `wz` | float | World coordinates (UnitPosition) |
| `inst` | integer | Instance ID (0 = open world) |
| `mid` | integer | Map ID |
| `zone` | string | Zone name |
| `sz` | string | Subzone name |
| `lvl` | integer | Character level |
| `curr_xp`, `max_xp` | integer | XP bar values |
| `hp`, `mp`, `en`, `rg` | integer | Health / mana / energy / rage (null if not applicable to class) |
| `rest` | integer | Rested XP bonus remaining |
| `combat` | 0\|1 | In combat flag |
| `mnt` | 0\|1 | Mounted flag |
| `stealth` | 0\|1 | Stealthed flag |
| `form` | integer | Shapeshift/stance form ID |
| `form_spell` | integer | Spell ID of active form |
| `cp` | integer | Combo points |
| `falling` | 0\|1 | Falling flag (0→1 transition = jump) |

**`*_all` vs filtered keys**

The response always contains both:
- `rows_all`, `events_all`, `kills_all` — the full unfiltered dataset (for timeline context and brush-select)
- `rows`, `events`, `kills` — the filtered slice (for trajectory, stats, and splits)

When no filters are active, both sets are identical.

**Event types included in `events`**

`PLAYER_DEAD`, `PLAYER_ALIVE`, `PLAYER_UNGHOST`, `PLAYER_LEVEL_UP`, `QUEST_ACCEPTED`, `QUEST_TURNED_IN`, `UI_INFO_MESSAGE`, `UNIT_SPELLCAST_SUCCEEDED`, `MERCHANT_SHOW/CLOSED`, `TRAINER_SHOW/CLOSED`, `MAIL_SHOW/CLOSED`, `BANKFRAME_OPENED/CLOSED`, `AUCTION_HOUSE_SHOW/CLOSED`, `LOOT_OPENED/CLOSED`, `CINEMATIC_START/STOP`, `TAXIMAP_OPENED/CLOSED`, `HEARTHSTONE_BOUND`

`UNIT_SPELLCAST_SUCCEEDED` events are enriched with `spell_id`, `spell_name`, and `spell_rank` when the spell is in the Ranger lexicon.

**Splits**

`stats.splits` divides total playtime into 15-minute buckets. Playtime is wall-clock time with gaps > 2 seconds capped (logout/disconnect gaps are not counted). Cross-session gaps are excluded entirely. Each split carries XP, kills, deaths, quests, distance, dominant zone, and XP/hr for that segment.

---

### Columnar wire format (`fmt=columnar`)

Request `?fmt=columnar` to receive poll rows as column arrays instead of row objects. The wire payload is significantly smaller, especially with gzip.

```json
{
  "encoding": "columnar_v1",
  "n": 28000,
  "dense": false,
  "cols": {
    "t":   [1716100010, 1, 1, 2, 1],
    "sid": [7, null, null, null, null],
    "lvl": [38, null, null, null, null],
    "zone": [[0, "Elwynn Forest"], [8400, "Stormwind City"]],
    "sz":   [[0, "Northshire"], [1200, null]]
  }
}
```

- `t` is delta-encoded: the first value is absolute, subsequent values are deltas from the previous timestamp.
- Numeric columns are plain arrays of length `n`. `null` means the field did not change since the previous row (write-on-change semantics) when `dense=false`.
- `zone` and `sz` are run-length encoded as `[[startIndex, value], ...]` pairs.
- When `dense=true` (the filtered `rows` payload), every slot carries an explicit forward-filled value.

The response shape for `fmt=columnar` is otherwise identical to the default format — `events`, `kills`, and `stats` are always row objects.
