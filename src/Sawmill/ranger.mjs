// Sawmill/ranger.mjs
// Ingest the Ranger addon's SavedVariable (RangerDB) into the `spells` table.
// Ranger is per-account, not per-character, so its file lives under WTF/Account/<acct>/SavedVariables/Ranger.lua.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG } from './config.mjs';
import { db } from './db.mjs';

export function ingestRangerFile(filePath, { skipArchive = false, globalName = 'RangerDB' } = {}) {
    const ts = Date.now();
    if (!skipArchive) {
        try {
            fs.copyFileSync(filePath, path.join(CONFIG.archivePath, `${ts}_Ranger.lua`));
        } catch (e) {
            console.warn(`Ranger archive copy failed: ${e.message}`);
        }
    }

    const result = spawnSync(CONFIG.luaExe, [CONFIG.luaScript, filePath, globalName], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
    if (result.status !== 0) {
        console.error(`Ranger Lua dump failed for ${filePath}:`, result.stderr);
        return null;
    }
    let data;
    try { data = JSON.parse(result.stdout); }
    catch (e) { console.error('Ranger JSON parse failed:', e); return null; }

    const spells = data.spells || {};
    const stmt = db.prepare(`INSERT OR REPLACE INTO spells
        (id, name, rank, icon, school, cast_time, min_range, max_range, level_learned, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let n = 0;
    db.exec('BEGIN');
    try {
        for (const idStr of Object.keys(spells)) {
            const id = parseInt(idStr, 10);
            if (!isFinite(id)) continue;
            const s = spells[idStr] || {};
            stmt.run(
                id,
                s.name ?? null,
                s.rank ?? null,
                s.icon ?? null,
                typeof s.school === 'number' ? s.school : null,
                typeof s.cast_time === 'number' ? s.cast_time : null,
                typeof s.min_range === 'number' ? s.min_range : null,
                typeof s.max_range === 'number' ? s.max_range : null,
                typeof s.level_learned === 'number' ? s.level_learned : null,
                Date.now() / 1000
            );
            n++;
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        console.error('Ranger insert failed:', e);
        return null;
    }
    return { spells: n, meta: data.meta || null };
}
