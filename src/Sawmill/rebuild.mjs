// Sawmill/rebuild.mjs
// Orchestrate database recovery from the archive directory.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { db } from './db.mjs';
import { ingestLumberjackData, probeFile } from './ingest.mjs';
import { processCleuFile } from './cleu.mjs';
import { ingestRangerFile } from './ranger.mjs';

export async function rebuildDatabase() {
    console.log(`Rebuilding database from archive: ${CONFIG.archivePath}`);
    
    if (!fs.existsSync(CONFIG.archivePath)) {
        console.error(`Archive directory not found: ${CONFIG.archivePath}`);
        return;
    }

    const files = fs.readdirSync(CONFIG.archivePath);
    
    // Phase 1: Lumberjack / Forestry (Essential for session context)
    console.log('\nPhase 1: Ingesting Lumberjack/Forestry data...');
    const lumberjackFiles = files.filter(f => f.endsWith('.lua') && (f.includes('Lumberjack') || f.includes('Forestry')));
    for (const file of lumberjackFiles) {
        const filePath = path.join(CONFIG.archivePath, file);
        
        let data = probeFile(filePath, 'LumberjackDB');
        if (!data) {
            data = probeFile(filePath, 'ForestryDB');
        }

        if (data) {
            const counts = ingestLumberjackData(data);
            console.log(`Ingested ${file}: ${JSON.stringify(counts)}`);
        } else {
            console.warn(`Failed to probe ${file} (tried LumberjackDB and ForestryDB)`);
        }
    }

    // Phase 2: Ranger / Lexicon (Spells)
    console.log('\nPhase 2: Ingesting Ranger/Lexicon data...');
    const rangerFiles = files.filter(f => f.endsWith('.lua') && (f.includes('Ranger') || f.includes('Lexicon')));
    for (const file of rangerFiles) {
        const filePath = path.join(CONFIG.archivePath, file);
        
        let result = ingestRangerFile(filePath, { skipArchive: true, globalName: 'RangerDB' });
        if (!result) {
            result = ingestRangerFile(filePath, { skipArchive: true, globalName: 'LexiconDB' });
        }

        if (result) {
            console.log(`Ingested ${file}: ${result.spells} spells`);
        } else {
            console.warn(`Failed to ingest ${file} (tried RangerDB and LexiconDB)`);
        }
    }

    // Phase 3: Combat Logs (CLEU)
    console.log('\nPhase 3: Ingesting Combat Logs...');
    const cleuFiles = files.filter(f => f.startsWith('WoWCombatLog') || f.endsWith('.txt'));
    const state = { files: {} };
    for (const file of cleuFiles) {
        const filePath = path.join(CONFIG.archivePath, file);
        processCleuFile(filePath, {
            db,
            state,
            archiveDir: CONFIG.archivePath,
            debounceMs: 0,
            skipArchive: true
        });
    }

    console.log('\nDatabase rebuild complete.');
}
