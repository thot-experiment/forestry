// Sawmill/first_run.mjs
import { syncAddons } from './addon_sync.mjs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { writeIni } from './ini.mjs';

function isWsl() {
  try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); }
  catch { return false; }
}

/**
 * Validates if a directory is a valid WoW Anniversary installation.
 */
function isValidWowDir(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    const required = ['Interface', 'WTF', 'Logs'];
    return required.every(sub => {
      const testpath = path.join(dir, sub)
      return fs.existsSync(testpath)
    });
  } catch {
    return false;
  }
}

/**
 * Probes common installation paths.
 */
async function probeWowDir() {
  const commonPaths = [
  ]

  // Also check other fixed drives
  const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const drive of drives) {
    commonPaths.push(`${drive}:\\Program Files (x86)\\World of Warcraft\\_anniversary_`);
    commonPaths.push(`${drive}:\\Program Files\\World of Warcraft\\_anniversary_`);
    commonPaths.push(`${drive}:\\Battle.net\\World of Warcraft\\_anniversary_`);
    commonPaths.push(`${drive}:\\games\\bnet\\World of Warcraft\\_anniversary_`);
  }

  for (const p of commonPaths) {
    if (isValidWowDir(p)) return p;
  }
  return null;
}

export async function runFirstRunSetup(forestryHome) {
  console.log('--- Forestry First-Run Setup ---');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let wowDir = await probeWowDir();
  
  if (wowDir) {
    const confirm = await rl.question(`Found WoW installation at: ${wowDir}\nIs this correct? (Y/n): `);
    if (confirm.trim() !== '' && !confirm.toLowerCase().startsWith('y')) {
      wowDir = null;
    }
  }

  if (!wowDir) {
    while (true) {
      const answer = await rl.question('Could not find (or incorrect) WoW installation. Please paste the path to your WoW folder (containing Interface, WTF, Logs): ');
      if (isValidWowDir(answer.trim())) {
        wowDir = answer.trim();
        break;
      }
      console.log('Invalid path. Please try again.');
    }
  }

  rl.close();

  // On a no-deps build, deps/lua won't exist — verify lua54 is on PATH instead
  const bundledLua = path.join(forestryHome, 'deps', 'lua', 'lua54.exe');
  if (!fs.existsSync(bundledLua)) {
    const { spawnSync } = await import('node:child_process');
    let found = null;
    let version = '';
    for (const exe of ['lua54', 'lua']) {
      const probe = spawnSync(exe, ['-v'], { encoding: 'utf8' });
      if (!probe.error) { found = exe; version = (probe.stdout || probe.stderr).trim(); break; }
    }
    if (!found) {
      console.warn('\nWARNING: Neither lua54 nor lua was found on your PATH.');
      console.warn('This build requires a Lua interpreter to be installed and accessible.');
      console.warn('Download from: https://luabinaries.sourceforge.net/\n');
    } else {
      console.log(`Lua found on PATH (${found}): ${version}`);
    }
  }

  // On WSL with FORESTRY_HOME on an NTFS mount, SQLite locking fails — redirect to native fs
  const useNativeDataDir = isWsl() && forestryHome.startsWith('/mnt/');
  const dataDir = useNativeDataDir
    ? path.join(process.env.HOME || '/tmp', '.local', 'share', 'forestry')
    : forestryHome;
  if (useNativeDataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`WSL + NTFS mount detected: database and archive will be stored at ${dataDir}`);
  }

  // 1. Write forestry.ini
  const iniPath = path.join(forestryHome, 'forestry.ini');
  const config = {
    wow: { base_dir: wowDir },
    server: { port: '3333', open_browser: 'true' },
    paths: {
      db:      useNativeDataDir ? path.join(dataDir, 'forestry.db') : 'forestry.db',
      archive: useNativeDataDir ? path.join(dataDir, 'archive')     : 'archive',
    },
  };
  writeIni(iniPath, config);
  console.log('Config saved to forestry.ini');

  // 2. Deploy Addons
  const addons = ['Lumberjack', 'Ranger'];
  for (const addon of addons) {
    const src = path.join(forestryHome, 'addons', addon);
    const dest = path.join(wowDir, 'Interface', 'AddOns', addon);
    
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true });
      console.log(`Deployed ${addon} addon...`);
    } else {
      console.warn(`Warning: Could not find addon source at ${src}`);
    }
  }

  console.log('\nSetup complete! You can now launch WoW.');
  console.log('-----------------------------------\n');
}
