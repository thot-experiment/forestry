// changelog.mjs
// Generate CHANGELOG.md from annotated git tags and commit history.
//
// Usage:
//   node changelog.mjs            — preview what the next release will contain
//   node changelog.mjs --write    — write / prepend to CHANGELOG.md
//   node changelog.mjs --dry-run  — print only, never write
//
// Tagging a release:
//   git tag -a v1.1 -m "Short description of this release"
//   node changelog.mjs --write
//   node build_release.mjs --compress

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// ── Git helper (no shell — avoids %s/%h expansion on Windows cmd.exe) ─────────
function git(args, fallback = null) {
    try {
        const out = execFileSync('git', args, { encoding: 'utf8' }).trim();
        return out || fallback;
    } catch { return fallback; }
}

// ── ANSI ─────────────────────────────────────────────────────────────────────
const C = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    green:  '\x1b[32m',
    cyan:   '\x1b[36m',
    yellow: '\x1b[33m',
    gray:   '\x1b[90m',
};
const W = 56;
const BAR = C.dim + '─'.repeat(W) + C.reset;

// ── Resolve version context ───────────────────────────────────────────────────
const currentTag = git(['describe', '--tags', '--exact-match']);
const latestTag  = git(['describe', '--tags', '--abbrev=0']);

// If HEAD is exactly tagged, find the tag before it for the diff range.
const fromTag = currentTag
    ? git(['describe', '--tags', '--abbrev=0', `${currentTag}^`])
    : latestTag;

const toRef   = currentTag || 'HEAD';
const range   = fromTag ? `${fromTag}..${toRef}` : null; // null = entire history
const version = currentTag || 'unreleased';
const date    = new Date().toISOString().slice(0, 10);

// Subject line from the annotated tag message.
const tagline = currentTag
    ? git(['tag', '-l', '--format=%(contents:subject)', currentTag])
    : null;

// ── Collect commits ───────────────────────────────────────────────────────────
// Use \x01 (SOH) as field delimiter — never appears in commit messages.
const logArgs = ['log', '--pretty=format:%s\x01%h', ...(range ? [range] : [])];
const rawLog  = git(logArgs) || '';
const commits = rawLog
    ? rawLog.split('\n').filter(Boolean).map(line => {
        const sep = line.indexOf('\x01');
        return sep === -1
            ? { subject: line, hash: '' }
            : { subject: line.slice(0, sep), hash: line.slice(sep + 1) };
    })
    : [];

// ── Pretty-print ──────────────────────────────────────────────────────────────
const sinceLabel = fromTag ? `since ${fromTag}` : 'entire history';
const countLabel = `${commits.length} commit${commits.length !== 1 ? 's' : ''} ${sinceLabel}`;

console.log();
console.log(C.bold + C.cyan + '  Forestry Changelog' + C.reset);
console.log(BAR);
console.log(
    C.bold + C.green + `  ${version}` + C.reset +
    C.dim  + `  ·  ${date}  ·  ${countLabel}` + C.reset
);
if (tagline) console.log(C.yellow + `  ${tagline}` + C.reset);
console.log(BAR);

if (commits.length === 0) {
    console.log(C.dim + '  (no commits)' + C.reset);
} else {
    const SUBJECT_W = W - 11;
    for (const { subject, hash } of commits) {
        const trimmed = subject.length > SUBJECT_W
            ? subject.slice(0, SUBJECT_W - 1) + '…'
            : subject;
        const pad = ' '.repeat(Math.max(1, SUBJECT_W - trimmed.length + 2));
        console.log(`  ${C.dim}•${C.reset} ${trimmed}${pad}${C.gray}${hash}${C.reset}`);
    }
}

console.log(BAR);
console.log();

// ── Write CHANGELOG.md ────────────────────────────────────────────────────────
const dryRun = process.argv.includes('--dry-run');
const write  = process.argv.includes('--write') || process.env.CHANGELOG_WRITE === '1';

if (dryRun || !write) {
    if (!write) console.log(C.dim + '  Run with --write to update CHANGELOG.md\n' + C.reset);
    process.exit(0);
}

const headline = tagline ? `\n${tagline}\n\n` : '\n';
const bullets  = commits.map(({ subject, hash }) => `- ${subject}${hash ? ` (${hash})` : ''}`).join('\n') || '- (no commits)';
const section  = `## ${version} — ${date}${headline}${bullets}\n`;

const CHANGELOG = 'CHANGELOG.md';
const existing  = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, 'utf8') : '# Changelog\n\n';
const HEADER    = '# Changelog\n\n';
const body      = existing.startsWith(HEADER) ? existing.slice(HEADER.length) : existing;

if (body.startsWith(`## ${version}`)) {
    console.log(C.yellow + `  ${CHANGELOG} already has ${version} — skipped\n` + C.reset);
} else {
    fs.writeFileSync(CHANGELOG, HEADER + section + '\n' + body);
    console.log(C.green + `  → ${CHANGELOG} updated\n` + C.reset);
}
