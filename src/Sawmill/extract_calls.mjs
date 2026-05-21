// Sawmill/extract_calls.mjs
// Scans Lumberjack/*.lua for Blizzard API references and reports which are not yet covered
// by Probe/Targets.lua. Run after editing Lumberjack to keep the manifest in sync.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const lumberjackDir = path.join(repoRoot, 'Lumberjack');
const targetsPath = path.join(repoRoot, 'Probe', 'Targets.lua');

// Lua locals/keywords to ignore. Not exhaustive — we filter heavy below.
const IGNORE = new Set([
    'function', 'local', 'if', 'then', 'else', 'elseif', 'end', 'do', 'for', 'in', 'while',
    'return', 'break', 'true', 'false', 'nil', 'and', 'or', 'not', 'self', 'pcall',
    'tostring', 'tonumber', 'type', 'pairs', 'ipairs', 'next', 'unpack', 'select',
    'string', 'table', 'math', 'os', 'io', 'collectgarbage', 'loadstring', 'loadfile',
    'require', 'setmetatable', 'getmetatable', 'rawget', 'rawset', 'rawequal',
    'print', 'error', 'assert', 'xpcall',
]);

function listLuaFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listLuaFiles(full));
        else if (entry.name.endsWith('.lua')) out.push(full);
    }
    return out;
}

function stripComments(src) {
    // Remove --[[ ... ]] block comments and -- line comments. Naive but adequate.
    src = src.replace(/--\[\[[\s\S]*?\]\]/g, '');
    src = src.replace(/--[^\n]*/g, '');
    return src;
}

function extractCalls(src) {
    src = stripComments(src);
    const calls = new Set();
    const events = new Set();

    // Dotted/namespaced call: C_Foo.Bar(  or  Foo.Bar.Baz(
    const dotted = /(?<![.:\w])([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\s*\(/g;
    for (const m of src.matchAll(dotted)) calls.add(m[1]);

    // Top-level PascalCase call starting with capital, NOT preceded by . or : or word char.
    // This excludes frame:Method(), Namespace.Method(), and identifiers with underscores treated as method.
    const single = /(?<![.:\w])([A-Z][A-Za-z0-9_]+)\s*\(/g;
    for (const m of src.matchAll(single)) {
        if (!IGNORE.has(m[1])) calls.add(m[1]);
    }

    // pcall(Foo, ...) and pcall(Foo.Bar, ...) — Foo isn't followed by '(' so the patterns above miss it.
    const pcalled = /\bpcall\s*\(\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/g;
    for (const m of src.matchAll(pcalled)) calls.add(m[1]);

    // RegisterEvent("FOO_BAR")
    const evRe = /:RegisterEvent\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g;
    for (const m of src.matchAll(evRe)) events.add(m[1]);

    return { calls, events };
}

function readTargets(targetsSrc) {
    // Parse lightly: pull every name = "..." and event = "..." occurrence.
    const fnNames = new Set();
    const evNames = new Set();
    for (const m of targetsSrc.matchAll(/\bname\s*=\s*"([^"]+)"/g)) fnNames.add(m[1]);
    for (const m of targetsSrc.matchAll(/\bevent\s*=\s*"([^"]+)"/g)) evNames.add(m[1]);
    return { fnNames, evNames };
}

function main() {
    if (!fs.existsSync(targetsPath)) {
        console.error(`Targets manifest not found: ${targetsPath}`);
        process.exit(2);
    }
    const targetsSrc = fs.readFileSync(targetsPath, 'utf8');
    const { fnNames, evNames } = readTargets(targetsSrc);

    const allCalls = new Set();
    const allEvents = new Set();
    const files = listLuaFiles(lumberjackDir);
    if (files.length === 0) {
        console.error(`No .lua files found in ${lumberjackDir}`);
        process.exit(2);
    }
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        const { calls, events } = extractCalls(src);
        for (const c of calls) allCalls.add(c);
        for (const e of events) allEvents.add(e);
    }

    const missingFns = [...allCalls].filter(c => !fnNames.has(c) && !isLikelyLocal(c)).sort();
    const missingEvs = [...allEvents].filter(e => !evNames.has(e)).sort();

    console.log(`Lumberjack calls (PascalCase + dotted): ${allCalls.size}`);
    console.log(`Probe Targets covers ${fnNames.size} functions, ${evNames.size} events.`);
    console.log('');

    if (missingFns.length === 0) {
        console.log('Function coverage: OK — every call site has a Targets entry.');
    } else {
        console.log(`Function coverage: ${missingFns.length} call(s) NOT in Targets.lua:`);
        for (const c of missingFns) console.log('  - ' + c);
    }
    console.log('');

    if (missingEvs.length === 0) {
        console.log('Event coverage: OK — every RegisterEvent is in Targets.lua.');
    } else {
        console.log(`Event coverage: ${missingEvs.length} event(s) NOT in Targets.lua:`);
        for (const e of missingEvs) console.log('  - ' + e);
    }

    if (missingFns.length || missingEvs.length) process.exit(1);
}

function isLikelyLocal(name) {
    // Heuristic: anything starting with our own addon prefix or that's clearly internal.
    if (name.startsWith('Lumberjack')) return true;
    if (name === 'SLASH_LUMBERJACK1' || name === 'SLASH_LUMBERJACK2') return true;
    return false;
}

main();
