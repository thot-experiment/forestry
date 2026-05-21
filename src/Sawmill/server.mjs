// Sawmill/server.mjs
// Main entry: starts file watching + HTTP server. Also dispatches CLI modes:
//   node Sawmill/server.mjs           # watch + serve
//   node Sawmill/server.mjs --probe   # ingest Probe.lua → docs/APIReport.md
//   node Sawmill/server.mjs --manual <path/to/Lumberjack.lua>

process.on('uncaughtException', (err) => {
    console.error('\nFATAL ERROR: Uncaught Exception\n', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\nFATAL ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

import http from 'node:http';

import { exec } from 'node:child_process';
import { CONFIG, reloadConfig } from './config.mjs';

if (process.argv.includes('--probe')) {
    const { runProbeIngest } = await import('./probe.mjs');
    runProbeIngest({
        wowBaseDir: CONFIG.wowBaseDir,
        repoRoot: CONFIG.repoRoot,
        luaExe: CONFIG.luaExe,
        archiveDir: CONFIG.archivePath,
    });
} else if (process.argv.includes('--rebuild')) {
    const { rebuildDatabase } = await import('./rebuild.mjs');
    await rebuildDatabase();
    process.exit(0);
} else if (process.argv.includes('--manual')) {

    const filePath = process.argv[process.argv.indexOf('--manual') + 1];
    if (!filePath) {
        console.error('Usage: server.mjs --manual <path/to/Lumberjack.lua>');
        process.exit(2);
    }
    const { manualIngest } = await import('./watcher.mjs');
    manualIngest(filePath);
} else {
    const { startWatching } = await import('./watcher.mjs');
    const { apiHandler, staticRouter } = await import('./routes.mjs');
    const { runFirstRunSetup } = await import('./first_run.mjs');
    const { checkAddonsNeedUpdate, syncAddons } = await import('./addon_sync.mjs');

    // Bundled mode: check for first-run setup
    if (process.env.FORESTRY_HOME && !CONFIG.wowBaseDir) {
        await runFirstRunSetup(process.env.FORESTRY_HOME);
        reloadConfig();
    }

    // Bundled mode: check for addon updates
    if (process.env.FORESTRY_HOME && CONFIG.wowBaseDir) {
        const outdated = checkAddonsNeedUpdate(process.env.FORESTRY_HOME, CONFIG.wowBaseDir);
        if (outdated.length > 0) {
            const readline = await import('node:readline/promises');
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await rl.question(`Addon updates available (${outdated.join(', ')}). Update now? (y/n): `);
            if (answer.toLowerCase().startsWith('y')) {
                syncAddons(process.env.FORESTRY_HOME, CONFIG.wowBaseDir);
                console.log('Addons updated successfully.');
            }
            rl.close();
        }
    }

    startWatching();

    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/api/')) return apiHandler(req, res);
        return staticRouter(req, res);
    });
    server.listen(CONFIG.httpPort, () => {
        // Stamp the console window title so it's findable on a crowded taskbar. OSC 0 escape
        // works in Windows Terminal + cmd.exe; process.title covers task manager / *nix terminals.
        const title = `Sawmill :${CONFIG.httpPort}`;
        process.title = title;
        if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${title}\x07`);
        console.log(`Sawmill server: http://localhost:${CONFIG.httpPort}  (db: ${CONFIG.dbPath})`);

        if (CONFIG.openBrowser && !process.argv.includes('--no-browser')) {
            exec(`start "" http://localhost:${CONFIG.httpPort}`);
        }
    });
}
