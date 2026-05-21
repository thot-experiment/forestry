// Sawmill/ini.mjs
import fs from 'node:fs';

/**
 * Parses a basic INI file.
 * Supports [sections], key=value, and ; comments.
 */
export function readIni(filePath) {
  if (!fs.existsSync(filePath)) return null;
  
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const result = {};
  let currentSection = null;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith(';')) continue;

    // Remove trailing comments
    const commentIdx = line.indexOf(';');
    if (commentIdx !== -1) {
      line = line.substring(0, commentIdx).trim();
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.substring(1, line.length - 1);
      result[currentSection] = result[currentSection] || {};
    } else if (line.includes('=')) {
      const [key, ...valParts] = line.split('=');
      const value = valParts.join('=').trim();
      if (currentSection) {
        result[currentSection][key.trim()] = value;
      } else {
        result[key.trim()] = value;
      }
    }
  }
  return result;
}

/**
 * Writes an object to an INI file.
 */
export function writeIni(filePath, data) {
  let output = '';
  for (const [section, values] of Object.entries(data)) {
    output += `[${section}]\n`;
    for (const [key, value] of Object.entries(values)) {
      output += `${key} = ${value}\n`;
    }
    output += '\n';
  }
  fs.writeFileSync(filePath, output.trim(), 'utf8');
}
