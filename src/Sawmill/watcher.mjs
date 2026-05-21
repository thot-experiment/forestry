// Sawmill/watcher.mjs
// Watches WTF/ for Lumberjack.lua changes and Logs/ for combat log appends.
// Debounce + mtime guard on Lumberjack side; cleu.mjs handles its own mtime+byte-offset.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { db } from './db.mjs';
import { state, saveState } from './state.mjs';
import { processLumberjackIngest } from './ingest.mjs';
import { processCleuFile } from './cleu.mjs';
import { ingestRangerFile } from './ranger.mjs';

const DEBOUNCE_MS = 1500;
const debounceTimers = new Map();

function processLumberjackFile(filePath) {
    const existing = debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(filePath, setTimeout(() => {
        debounceTimers.delete(filePath);
        let stat;
        try { stat = fs.statSync(filePath); }
        catch (e) { console.warn(`stat failed for ${filePath}: ${e.message}`); return; }
        const last = state.files[filePath];
        if (last && stat.mtimeMs <= last.lastIngestedMtime) return;
        console.log(`Ingesting ${filePath}`);
        const result = processLumberjackIngest(filePath);
        if (result) {
            const { counts, highwater } = result;
            console.log(`  inserted: poll=${counts.poll} events=${counts.events} snapshots=${counts.snapshots} (skipped ${counts.dupes} dupes); highwater=${highwater}`);
        }
        try {
            const post = fs.statSync(filePath);
            state.files[filePath] = { lastIngestedMtime: post.mtimeMs, lastIngestedAt: Date.now() };
            saveState();
        } catch { /* ignore */ }
    }, DEBOUNCE_MS));
}

function processCleuFileDebounced(filePath) {
    const existing = debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(filePath, setTimeout(() => {
        debounceTimers.delete(filePath);
        try {
            processCleuFile(filePath, { db, state, archiveDir: CONFIG.archivePath, debounceMs: DEBOUNCE_MS });
        } catch (e) {
            console.error(`CLEU process failed for ${filePath}:`, e);
        }
        saveState();
    }, DEBOUNCE_MS));
}

function findNamed(dir, targetName, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const res = path.join(dir, entry.name);
        if (entry.isDirectory()) findNamed(res, targetName, files);
        else if (entry.name === targetName) files.push(res);
    }
    return files;
}
const findLumberjackFiles = (dir) => findNamed(dir, 'Lumberjack.lua');
const findRangerFiles = (dir) => findNamed(dir, 'Ranger.lua');

// Ranger is small + idempotent (INSERT OR REPLACE). Debounce + mtime guard.
function processRangerFile(filePath) {
    const existing = debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(filePath, setTimeout(() => {
        debounceTimers.delete(filePath);
        let stat;
        try { stat = fs.statSync(filePath); }
        catch (e) { console.warn(`stat failed for ${filePath}: ${e.message}`); return; }
        const last = state.files[filePath];
        if (last && stat.mtimeMs <= last.lastIngestedMtime) return;
        const r = ingestRangerFile(filePath);
        if (r) console.log(`Ranger ${path.basename(filePath)}: +${r.spells} spell rows (locale=${r.meta?.locale || '?'})`);
        try {
            const post = fs.statSync(filePath);
            state.files[filePath] = { lastIngestedMtime: post.mtimeMs, lastIngestedAt: Date.now() };
            saveState();
        } catch { /* ignore */ }
    }, DEBOUNCE_MS));
}

export function startWatching() {
    if (!fs.existsSync(CONFIG.wowPath)) {
        console.error(`Error: WoW WTF path does not exist: ${CONFIG.wowPath}`);
        process.exit(1);
    }
    console.log(`Sawmill is watching: ${CONFIG.wowPath}`);

    const initial = findLumberjackFiles(CONFIG.wowPath);
    console.log(`Found ${initial.length} Lumberjack.lua file(s). Scheduling initial ingest...`);
    initial.forEach(processLumberjackFile);

    const initialLex = findRangerFiles(CONFIG.wowPath);
    console.log(`Found ${initialLex.length} Ranger.lua file(s). Scheduling initial ingest...`);
    initialLex.forEach(processRangerFile);

    fs.watch(CONFIG.wowPath, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (filename.endsWith('Lumberjack.lua')) processLumberjackFile(path.join(CONFIG.wowPath, filename));
        else if (filename.endsWith('Ranger.lua')) processRangerFile(path.join(CONFIG.wowPath, filename));
    });

    if (fs.existsSync(CONFIG.logsDir)) {
        const initialLogs = fs.readdirSync(CONFIG.logsDir).filter(n => CONFIG.combatLogPattern.test(n));
        console.log(`Found ${initialLogs.length} combat log file(s) at startup. Scheduling initial ingest...`);
        for (const name of initialLogs) processCleuFileDebounced(path.join(CONFIG.logsDir, name));

        fs.watch(CONFIG.logsDir, (_eventType, filename) => {
            if (filename && CONFIG.combatLogPattern.test(filename)) {
                processCleuFileDebounced(path.join(CONFIG.logsDir, filename));
            }
        });
    } else {
        console.log(`Logs dir not found: ${CONFIG.logsDir}`);
    }
}

// Exposed for --manual mode.
export function manualIngest(filePath) {
    const result = processLumberjackIngest(filePath);
    if (result) {
        const { counts, highwater } = result;
        console.log(`Manual ingest: poll=${counts.poll} events=${counts.events} snapshots=${counts.snapshots} (skipped ${counts.dupes} dupes); highwater=${highwater}`);
    }
}
