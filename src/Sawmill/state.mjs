// Sawmill/state.mjs
// Per-file ingest state (mtime + byte offset per source file).

import fs from 'node:fs';
import { CONFIG } from './config.mjs';

export const state = { files: {} };

if (fs.existsSync(CONFIG.statePath)) {
    try {
        Object.assign(state, JSON.parse(fs.readFileSync(CONFIG.statePath, 'utf8')));
    } catch (e) {
        console.warn('Could not parse .state.json, starting fresh:', e.message);
    }
}

export function saveState() {
    fs.writeFileSync(CONFIG.statePath, JSON.stringify(state, null, 2));
}
