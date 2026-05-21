// Sawmill/addon_sync.mjs
import fs from 'node:fs';
import path from 'node:path';

/**
 * Checks if addons in the bundle are newer than those in the WoW installation.
 */
export function checkAddonsNeedUpdate(forestryHome, wowBaseDir) {
  if (!forestryHome || !wowBaseDir) return [];
  
  const addons = ['Lumberjack', 'Ranger'];
  const outdated = [];

  for (const addon of addons) {
    const bundlePath = path.join(forestryHome, 'addons', addon, `${addon}.toc`);
    const wowPath = path.join(wowBaseDir, 'Interface', 'AddOns', addon, `${addon}.toc`);

    if (!fs.existsSync(bundlePath)) continue;

    if (!fs.existsSync(wowPath)) {
      outdated.push(addon);
      continue;
    }

    const bundleStat = fs.statSync(bundlePath);
    const wowStat = fs.statSync(wowPath);

    if (bundleStat.mtimeMs > wowStat.mtimeMs) {
      outdated.push(addon);
    }
  }
  return outdated;
}

/**
 * Copies addons from the bundle to the WoW installation.
 */
export function syncAddons(forestryHome, wowBaseDir) {
  if (!forestryHome || !wowBaseDir) return;

  const addons = ['Lumberjack', 'Ranger'];
  for (const addon of addons) {
    const src = path.join(forestryHome, 'addons', addon);
    const dest = path.join(wowBaseDir, 'Interface', 'AddOns', addon);
    
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  }
}
