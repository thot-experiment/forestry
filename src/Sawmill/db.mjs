// Sawmill/db.mjs
// Single shared SQLite handle. Schema is fluid: CREATE for new tables, ensureColumn
// adds new columns to existing tables on the fly. Inspect via `inspect.mjs schema`.

import sqlite from 'node:sqlite';
import { CONFIG } from './config.mjs';

export const db = new sqlite.DatabaseSync(CONFIG.dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        start_time INTEGER,
        character_name TEXT,
        realm TEXT,
        faction TEXT,
        race TEXT,
        class TEXT,
        character_guid TEXT,
        client_version TEXT,
        client_build TEXT,
        client_tocversion INTEGER,
        schema_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS poll (
        timestamp REAL,
        session_id TEXT,
        x REAL, y REAL,
        mid INTEGER, zone TEXT, sz TEXT,
        lvl INTEGER, curr_xp REAL, max_xp REAL,
        hp REAL, mp REAL, en REAL, rg REAL,
        combat INTEGER, bags INTEGER, gold INTEGER,
        mnt INTEGER, stealth INTEGER, rest REAL,
        cast TEXT, cast_id INTEGER,
        fps REAL, lat REAL, mem REAL,
        schema_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
        timestamp REAL,
        session_id TEXT,
        event_type TEXT,
        x REAL, y REAL, zone TEXT,
        payload TEXT,
        schema_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS snapshots (
        timestamp REAL,
        session_id TEXT,
        kind TEXT,
        payload TEXT,
        schema_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS cleu (
        timestamp REAL,
        session_id TEXT,
        event_type TEXT,
        raw_line TEXT,
        schema_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS spells (
        id INTEGER PRIMARY KEY,
        name TEXT,
        rank TEXT,
        icon TEXT,
        school INTEGER,
        cast_time REAL,
        min_range REAL,
        max_range REAL,
        level_learned INTEGER,
        captured_at REAL
    );
`);
ensureColumn('spells', 'cast_time', 'REAL');
ensureColumn('spells', 'min_range', 'REAL');
ensureColumn('spells', 'max_range', 'REAL');
ensureColumn('spells', 'level_learned', 'INTEGER');

function ensureColumn(table, col, type) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find(c => c.name === col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
        console.log(`[migration] added ${table}.${col} ${type}`);
    }
}

ensureColumn('sessions', 'character_guid', 'TEXT');
ensureColumn('sessions', 'client_version', 'TEXT');
ensureColumn('sessions', 'client_build', 'TEXT');
ensureColumn('sessions', 'client_tocversion', 'INTEGER');
ensureColumn('poll', 'mid', 'INTEGER');
ensureColumn('poll', 'sz', 'TEXT');
ensureColumn('poll', 'mnt', 'INTEGER');
ensureColumn('poll', 'stealth', 'INTEGER');
ensureColumn('poll', 'rest', 'REAL');
ensureColumn('poll', 'cast', 'TEXT');
ensureColumn('poll', 'cast_id', 'INTEGER');
ensureColumn('poll', 'form', 'INTEGER');
// form_spell = aura-derived spell ID of the active shapeshift/stance. Stable across characters.
// Captured in parallel with `form` (bar-slot index) so analysis can cross-check the two sources.
ensureColumn('poll', 'form_spell', 'INTEGER');
ensureColumn('poll', 'cp', 'INTEGER');
ensureColumn('poll', 'falling', 'INTEGER');
// World coords from UnitPosition: wx/wy/wz are absolute world axes (yards), inst is instanceID.
// Independent of map — works in instances + no per-zone atlas stitching needed for trajectory.
ensureColumn('poll', 'wx', 'REAL');
ensureColumn('poll', 'wy', 'REAL');
ensureColumn('poll', 'wz', 'REAL');
ensureColumn('poll', 'inst', 'INTEGER');
// Target data: JSON blob of {guid,name,level,class,classification,health,maxHealth} when player has a
// target, null when not. Lumberjack has always captured this in the addon (logPoll's `tgt = getTargetData()`)
// but it was being dropped at the SQL layer pre-2026-05-17.
ensureColumn('poll', 'tgt', 'TEXT');
