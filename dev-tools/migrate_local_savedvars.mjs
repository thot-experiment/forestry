import fs from 'node:fs';
import path from 'node:path';
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { readIni } from '../src/Sawmill/ini.mjs';

const CONFIG_FILE = 'dev-config.ini';

function loadConfig() {
  try {
    return readIni(CONFIG_FILE);
  } catch (e) {
    console.error(`Error reading ${CONFIG_FILE}: ${e.message}`);
    process.exit(1);
  }
}

function migrateFile(filePath, targetPath, replacements) {
  const content = readFileSync(filePath, 'utf8');
  let newContent = content;
  for (const [oldVal, newVal] of Object.entries(replacements)) {
    newContent = newContent.split(oldVal).join(newVal);
  }
  return newContent;
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isCleanup = args.includes('--cleanup');

  const config = loadConfig();
  const wowBaseDir = config.wow?.base_dir || config.wowBaseDir;

  if (!wowBaseDir) {
    console.error('wowBaseDir not found in dev-config.ini');
    process.exit(1);
  }

  console.log(`WoW Base Directory: ${wowBaseDir}`);

  const accountDir = path.join(wowBaseDir, 'WTF', 'Account');
  if (!existsSync(accountDir)) {
    console.error(`Account directory not found: ${accountDir}`);
    process.exit(1);
  }

  const accounts = readdirSync(accountDir);

  for (const account of accounts) {
    const accountPath = path.join(accountDir, account);
    if (!fs.lstatSync(accountPath).isDirectory()) continue;

    // Account-wide SavedVariables
    const accountSVPath = path.join(accountPath, 'SavedVariables');
    if (existsSync(accountSVPath) && fs.lstatSync(accountSVPath).isDirectory()) {
      const lexiconFile = path.join(accountSVPath, 'Lexicon.lua');
      const rangerFile = path.join(accountSVPath, 'Ranger.lua');

      if (existsSync(lexiconFile) && !existsSync(rangerFile)) {
        console.log(`Migrating Lexicon -> Ranger: ${lexiconFile}`);
        if (!isDryRun) {
          const newContent = migrateFile(lexiconFile, rangerFile, {
            'LexiconDB': 'RangerDB'
          });
          writeFileSync(rangerFile, newContent);
          renameSync(lexiconFile, lexiconFile + '.bak');
        } else {
          console.log(`  [Dry Run] Would migrate ${lexiconFile} to ${rangerFile} and backup to .bak`);
        }
      }
    }

    // Character-specific SavedVariables
    const servers = readdirSync(accountPath).filter(name => {
      const fullPath = path.join(accountPath, name);
      return fs.lstatSync(fullPath).isDirectory() && name !== 'SavedVariables';
    });

    for (const server of servers) {
      const serverPath = path.join(accountPath, server);
      const characters = readdirSync(serverPath).filter(name => {
        const fullPath = path.join(serverPath, name);
        return fs.lstatSync(fullPath).isDirectory();
      });

      for (const character of characters) {
        const charSVPath = path.join(serverPath, character, 'SavedVariables');
        if (existsSync(charSVPath) && fs.lstatSync(charSVPath).isDirectory()) {
          const forestryFile = path.join(charSVPath, 'Forestry.lua');
          const lumberjackFile = path.join(charSVPath, 'Lumberjack.lua');

          if (existsSync(forestryFile) && !existsSync(lumberjackFile)) {
            console.log(`Migrating Forestry -> Lumberjack: ${forestryFile}`);
            if (!isDryRun) {
              const newContent = migrateFile(forestryFile, lumberjackFile, {
                'ForestryDB': 'LumberjackDB',
                'ForestrySettings': 'LumberjackSettings',
                'ForestryHighwaterMark': 'LumberjackHighwaterMark'
              });
              writeFileSync(lumberjackFile, newContent);
              renameSync(forestryFile, forestryFile + '.bak');
            } else {
              console.log(`  [Dry Run] Would migrate ${forestryFile} to ${lumberjackFile} and backup to .bak`);
            }
          }
        }
      }
    }
  }

  if (isCleanup && !isDryRun) {
    console.log('Cleaning up .bak files...');
    // To implement cleanup, we'd need to traverse again or keep a list.
    // Let's just do a simple recursive search for .bak files in WTF/Account.
    const findBakFiles = (dir) => {
      let results = [];
      const list = readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.lstatSync(fullPath);
        if (stat.isDirectory()) {
          results = results.concat(findBakFiles(fullPath));
        } else if (file.endsWith('.bak')) {
          results.push(fullPath);
        }
      }
      return results;
    };

    const bakFiles = findBakFiles(accountDir);
    for (const bakFile of bakFiles) {
      if (bakFile.includes('Forestry.lua.bak') || bakFile.includes('Lexicon.lua.bak')) {
        console.log(`Deleting ${bakFile}`);
        fs.unlinkSync(bakFile);
      }
    }
  }

  console.log('Migration complete.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
