// Geographer/geographer.mjs

export const MAP_WORLD_ORIGIN = 17066.666666666668;
export const MAP_TILE_YD = 533.3333333333334; // 1600 / 3

/**
 * Converts a tile grid coordinate [col, row] to world yards [wx, wy].
 * @param {[number, number]} tileCoord - [col, row]
 * @returns {[number, number]} [wx, wy]
 */
export function tileToWorld(tileCoord) {
    const [col, row] = tileCoord;
    return [
        MAP_WORLD_ORIGIN - row * MAP_TILE_YD,
        MAP_WORLD_ORIGIN - col * MAP_TILE_YD
    ];
}

/**
 * Converts world yards [wx, wy] to tile grid coordinates [col, row].
 * @param {[number, number]} worldCoord - [wx, wy]
 * @returns {[number, number]} [col, row]
 */
export function worldToTile(worldCoord) {
    const [wx, wy] = worldCoord;
    return [
        (MAP_WORLD_ORIGIN - wy) / MAP_TILE_YD,
        (MAP_WORLD_ORIGIN - wx) / MAP_TILE_YD
    ];
}

/**
 * Calculates the snapped NW corner for a map.
 * Based on GEOSPATIAL.md: each coord is rounded to the nearest multiple of 10.
 */
export function snapCoord(val) {
    return Math.round(val / 10) * 10;
}
