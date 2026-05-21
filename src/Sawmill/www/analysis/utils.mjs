// Sawmill/analysis/utils.mjs

export const STABLE_POLL_COLS = [
    'x', 'y', 'wx', 'wy', 'wz', 'inst',
    'hp', 'mp', 'en', 'rg',
    'mid', 'zone', 'sz',
    'lvl', 'curr_xp', 'max_xp', 'rest',
    'bags', 'gold',
    'mnt', 'stealth', 'combat',
    'form', 'form_spell', 'cp', 'falling',
];

export function forwardFillBySession(rows) {
    const lastBySid = new Map();
    for (const r of rows) {
        let last = lastBySid.get(r.session_id);
        if (!last) { last = {}; lastBySid.set(r.session_id, last); }
        for (const f of STABLE_POLL_COLS) {
            if (r[f] === null || r[f] === undefined) {
                if (last[f] !== undefined) r[f] = last[f];
            } else {
                last[f] = r[f];
            }
        }
    }
    return rows;
}
