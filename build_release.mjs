import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import https from 'node:https';

// Prefer an exact tag on HEAD (release build); fall back to dev-<hash>.
function resolveVersion() {
  try { return execFileSync('git', ['describe', '--tags', '--exact-match'], { encoding: 'utf8' }).trim(); }
  catch { return 'dev-' + execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
}
const VERSION = resolveVersion();

async function downloadNode() {
  const nodeDir = path.resolve('deps/node');
  const nodeExePath = path.join(nodeDir, 'node.exe');

  if (fs.existsSync(nodeExePath)) return;

  console.log('Fetching portable node.exe...');
  if (!fs.existsSync(nodeDir)) fs.mkdirSync(nodeDir, { recursive: true });

  const url = 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-win-x64/node.exe';
  const file = fs.createWriteStream(nodeExePath);

  return new Promise((resolve, reject) => {
    https.get(url, response => {
      response.pipe(file);
      file.on('finish', () => { file.close(); console.log('Node.exe downloaded.'); resolve(); });
    }).on('error', reject);
  });
}

function copyFolderRecursiveSync(src, dest, exclude = []) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (exclude.some(p => srcPath.includes(p))) continue;
    if (entry.isDirectory()) copyFolderRecursiveSync(srcPath, destPath, exclude);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function copyMapTiles(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const tile of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, tile), path.join(dest, tile));
  }
}

async function build({ compress = false, noDeps = false, clean = false } = {}) {
  const suffix = noDeps ? '-no-deps' : '';
  const DIST_DIR = `dist/forestry-${VERSION}${suffix}`;
  const DIST_PATH = path.resolve(DIST_DIR);
  const ZIP_PATH = `${DIST_DIR}.zip`;

  console.log(`Building release ${VERSION}${suffix}...`);

  // Generate / update CHANGELOG.md before packaging.
  execSync('node changelog.mjs --write', { stdio: 'inherit', env: { ...process.env, CHANGELOG_WRITE: '1' } });

  // 0. Clean dist/
  if (clean && fs.existsSync('dist')) {
    fs.rmSync('dist', { recursive: true, force: true });
    console.log('Cleaned dist/');
  }

  // 1. Wipe + recreate dist
  if (fs.existsSync(DIST_PATH)) fs.rmSync(DIST_PATH, { recursive: true, force: true });
  fs.mkdirSync(DIST_PATH, { recursive: true });

  // 2. Copy Addons
  const addonsDir = path.join(DIST_PATH, 'addons');
  copyFolderRecursiveSync('src/Lumberjack', path.join(addonsDir, 'Lumberjack'));
  copyFolderRecursiveSync('src/Ranger', path.join(addonsDir, 'Ranger'));

  // 3. Copy Deps (download node first so it's present when deps/ is copied)
  if (!noDeps) {
    await downloadNode();
    copyFolderRecursiveSync('deps', path.join(DIST_PATH, 'deps'));
  }

  // 4. Copy Sawmill
  const sawmillDir = path.join(DIST_PATH, 'sawmill');
  copyFolderRecursiveSync('src/Sawmill', sawmillDir, ['forestry.db', 'archive', '.state.json', 'node_modules']);

  // 5. Install production dependencies
  console.log('Installing production dependencies...');
  execSync('npm install --omit=dev', { cwd: sawmillDir, stdio: 'inherit' });

  // 6. Write Forestry.bat / Forestry.sh
  const nodeInvoke = noDeps ? 'node' : '"%~dp0deps\\node\\node.exe"';
  const batContent = `@echo off\nset FORESTRY_HOME=%~dp0\n${nodeInvoke} "%~dp0sawmill\\server.mjs" %* || pause\n`;
  fs.writeFileSync(path.join(DIST_PATH, 'Forestry.bat'), batContent);

  const shContent = `#!/usr/bin/env sh\nFORESTRY_HOME="$(cd "$(dirname "$0")" && pwd)"\nexport FORESTRY_HOME\nexec node "$FORESTRY_HOME/sawmill/server.mjs" "$@"\n`;
  const shPath = path.join(DIST_PATH, 'Forestry.sh');
  fs.writeFileSync(shPath, shContent);
  fs.chmodSync(shPath, 0o755);

  // 8. Copy README.txt + API.md + CHANGELOG.md
  fs.copyFileSync('USER_README.md', path.join(DIST_PATH, 'README.md'));
  fs.copyFileSync('API.md', path.join(DIST_PATH, 'API.md'));
  if (fs.existsSync('CHANGELOG.md')) fs.copyFileSync('CHANGELOG.md', path.join(DIST_PATH, 'CHANGELOG.md'));

  // 9. Zip
  if (compress) {
    console.log('Zipping distribution...');
    execSync(`powershell -Command "Compress-Archive -Path '${DIST_PATH}\\*' -DestinationPath '${path.resolve(ZIP_PATH)}' -Force"`);
  }

  console.log(`\nBuild complete: ${compress ? ZIP_PATH : DIST_PATH}`);
}

// --- Argument parsing ---
const KNOWN_FLAGS = ['--compress', '--no-deps', '--clean', '--all'];

const args = process.argv.slice(2);
const unknown = args.filter(a => !KNOWN_FLAGS.includes(a));
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}`);
  console.error(`Valid flags: ${KNOWN_FLAGS.join(', ')}`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.exit(1);
}

const compress = args.includes('--compress');
const clean    = args.includes('--clean');

const runs = args.includes('--all')
  ? [{ compress, noDeps: false, clean }, { compress, noDeps: true, clean: false }]
  : [{ compress, noDeps: args.includes('--no-deps'), clean }];

for (const flags of runs) {
  await build(flags);
}

