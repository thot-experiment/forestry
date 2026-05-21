// changelog.mjs
// Generate CHANGELOG.md from annotated git tags and commit history.
//
// Usage:
//   node changelog.mjs            — preview what the next release will contain
//   node changelog.mjs --write    — write / overwrite CHANGELOG.md
//   node changelog.mjs --dry-run  — print only, never write
//
// Tagging a release:
//   git tag -a v1.1 -m "Short description of this release"
//   node changelog.mjs --write
//   node build_release.mjs --compress
//
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// ── Git helper ──────────────────────────────────────────────────────────────────
function git(args, fallback = null) {
    try {
        const out = execFileSync('git', args, { 
            encoding: 'utf8', 
            stdio: ['ignore', 'pipe', 'ignore'] 
        }).trim();
        return out || fallback;
    } catch { return fallback; }
}

// ── ANSI ─────────────────────────────────────────────────────────────────────────
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

// ── Data Extraction ──────────────────────────────────────────────────────────────
function getCommits(range) {
    if (!range) return [];
    const rawLog = git(['log', '--pretty=format:%s\x01%h', range]) || '';
    return rawLog.split('\n').filter(Boolean).map(line => {
        const sep = line.indexOf('\x01');
        return sep === -1
            ? { subject: line, hash: '' }
            : { subject: line.slice(0, sep), hash: line.slice(sep + 1) };
    });
}

function generateChangelogData() {
    const rawTags = git(['tag', '--sort=-creatordate'], '');
    const tags = rawTags ? rawTags.split('\n').filter(Boolean) : [];
    const headHash = git(['rev-parse', '--short', 'HEAD']);
    const headTag = git(['describe', '--tags', '--exact-match']);

    const releases = [];

    // 1. Untagged commits (HEAD to latest tag)
    if (!headTag) {
        const latestTag = tags[0];
        const range = latestTag ? `${latestTag}..HEAD` : null;
        releases.push({
            version: `untagged build @ ${headHash}`,
            date: new Date().toISOString().slice(0, 10),
            tagline: null,
            commits: getCommits(range),
            isUntagged: true
        });
    }

    // 2. Process Tags
    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        const prevTag = tags[i + 1];
        const range = prevTag ? `${prevTag}..${tag}` : null;
        
        // Only fetch commits for the most recent tag
        const commits = (i === 0) ? getCommits(range) : [];
        
        releases.push({
            version: tag,
            date: git(['log', '-1', '--format=%ai', tag], '').slice(0, 10),
            tagline: git(['tag', '-l', '--format=%(contents)', tag]),
            commits: commits,
            isUntagged: false
        });
    }

    return releases;
}

// ── Formatters ──────────────────────────────────────────────────────────────────
function formatAsConsole(releases) {
    if (releases.length === 0) {
        console.log(C.dim + '  No tags or commits found.' + C.reset);
        return;
    }

    // Preview only shows the first (newest) release
    const rel = releases[0];
    const countLabel = `${rel.commits.length} commit${rel.commits.length !== 1 ? 's' : ''}`;

    console.log();
    console.log(C.bold + C.cyan + '  Forestry Changelog Preview' + C.reset);
    console.log(BAR);
    console.log(
        C.bold + C.green + `  ${rel.version}` + C.reset +
        C.dim  + `  ·  ${rel.date}  ·  ${countLabel}` + C.reset
    );
    if (rel.tagline) console.log(C.yellow + `  ${rel.tagline}` + C.reset);
    console.log(BAR);

    if (rel.commits.length === 0) {
        console.log(C.dim + '  (no commits)' + C.reset);
    } else {
        const SUBJECT_W = W - 11;
        for (const { subject, hash } of rel.commits) {
            const trimmed = subject.length > SUBJECT_W
                ? subject.slice(0, SUBJECT_W - 1) + '…'
                : subject;
            const pad = ' '.repeat(Math.max(1, SUBJECT_W - trimmed.length + 2));
            console.log(`  ${C.dim}•${C.reset} ${trimmed}${pad}${C.gray}${hash}${C.reset}`);
        }
    }
    console.log(BAR);
    console.log();
}

function formatAsMarkdown(releases) {
    let md = '# Changelog\n\n';

    for (const rel of releases) {
        md += `## ${rel.version} — ${rel.date}\n\n`;
        if (rel.tagline) {
            md += `-----------------\n${rel.tagline}\n-----------------\n\n`;
        }
        if (rel.commits.length > 0) {
            if (rel.isUntagged) {
                md += `-----------------\n`;
            } else {
                md += `## Commit History\n`;
            }
            md += rel.commits.map(({ subject, hash }) => `- ${subject}${hash ? ` (${hash})` : ''}`).join('\n');
            md += '\n\n';
        } else if (rel.isUntagged) {
            md += `-----------------\n- (no commits)\n\n`;
        }
        md += '\n';
    }
    return md.trim() + '\n';
}

// ── Main ─────────────────────────────────────────────────────────────────────────
const dryRun = process.argv.includes('--dry-run');
const write  = process.argv.includes('--write') || process.env.CHANGELOG_WRITE === '1';

const data = generateChangelogData();

if (dryRun || !write) {
    formatAsConsole(data);
    if (!write) console.log(C.dim + '  Run with --write to update CHANGELOG.md\n' + C.reset);
    process.exit(0);
}

const CHANGELOG = 'CHANGELOG.md';
const markdown = formatAsMarkdown(data);
fs.writeFileSync(CHANGELOG, markdown);
console.log(C.green + `  → ${CHANGELOG} updated (idempotent rebuild)\n` + C.reset);
