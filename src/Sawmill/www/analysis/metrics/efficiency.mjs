// Sawmill/analysis/metrics/efficiency.mjs

/**
 * Efficiency Metric: Identifies "idle" periods where the player is stationary
 * and resources are stable.
 * 
 * @param {Array} rows - Forward-filled poll rows
 * @param {Object} opts - Configuration (wiggle thresholds, min duration)
 */
export function computeEfficiency(rows, opts = {}) {
    const {
        posWiggle = 0.5,      // Yards (increased to account for coord jitter)
        hpWiggle = 10,        // Health units (increased to allow for regen)
        mpWiggle = 10,        // Mana units (increased to allow for regen)
        minIdleDuration = 15  // Seconds
    } = opts;

    if (rows.length < 2) return { totalIdleTime: 0, intervals: [] };

    const intervals = [];
    let currentStart = null;
    let lastStableRow = null;

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        
        if (lastStableRow) {
            const dx = Math.abs((r.wx || 0) - (lastStableRow.wx || 0));
            const dy = Math.abs((r.wy || 0) - (lastStableRow.wy || 0));
            const dz = Math.abs((r.wz || 0) - (lastStableRow.wz || 0));
            const dhp = Math.abs((r.hp || 0) - (lastStableRow.hp || 0));
            const dmp = Math.abs((r.mp || 0) - (lastStableRow.mp || 0));

            const isStable = r.sid === lastStableRow.sid && 
                                dx <= posWiggle && dy <= posWiggle && dz <= posWiggle &&
                                dhp <= hpWiggle && dmp <= mpWiggle;


            if (isStable) {
                // Continue current stable block
                lastStableRow = r;
                continue;
            }
        }

        // Not stable or first row: end previous block and start new
        if (currentStart !== null) {
            const duration = (lastStableRow.t - currentStart.t);
            if (duration >= minIdleDuration) {
                intervals.push({ start: currentStart.t, end: lastStableRow.t, duration });
            }
        }

        currentStart = r;
        lastStableRow = r;
    }

    // Close final interval
    if (currentStart !== null && lastStableRow) {
        const duration = (lastStableRow.t - currentStart.t);
        if (duration >= minIdleDuration) {
            intervals.push({ start: currentStart.t, end: lastStableRow.t, duration });
        }
    }

    const totalIdleTime = intervals.reduce((sum, int) => sum + int.duration, 0);
    
    let totalDuration = 0;
    if (rows.length > 1) {
        for (let i = 1; i < rows.length; i++) {
            const dt = rows[i].t - rows[i-1].t;
            if (rows[i].sid === rows[i-1].sid) {
                totalDuration += dt;
            }
        }
    }
    const idleScore = totalDuration > 0 ? (totalIdleTime / totalDuration) : 0;
    
    return {
        totalIdleTime,
        totalDuration,
        idleScore,
        intervals,
    };

}
