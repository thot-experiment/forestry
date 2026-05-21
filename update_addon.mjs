import fs from 'node:fs';
import path from 'node:path';
import { readIni } from './src/Sawmill/ini.mjs';

const configPath = './dev-config.ini';
const CONFIG = readIni(configPath);

const dev = process.argv.includes('--dev');

const addonsDir = path.join(CONFIG.wowBaseDir, 'Interface', 'AddOns');
const addons = ['Lumberjack', 'Ranger'];
if (dev) addons.push('Probe');

function deployOne(name) {
    const src = path.join(process.cwd(), 'src', name);
    const dst = path.join(addonsDir, name);
    if (!fs.existsSync(src)) {
        console.warn(`Skipping ${name}: source ${src} does not exist`);
        return;
    }
    console.log(`Deploying ${name}: ${src} -> ${dst}`);
    fs.cpSync(src, dst, { recursive: true });
}

try {
    if (!fs.existsSync(addonsDir)) fs.mkdirSync(addonsDir, { recursive: true });
    for (const a of addons) deployOne(a);
    console.log(dev ? 'Dev deploy complete (Lumberjack + Ranger + Probe).' : 'Deploy complete (Lumberjack + Ranger).');
} catch (err) {
    console.error('Failed to deploy:', err);
    process.exit(1);
}
