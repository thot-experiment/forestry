// Geographer/generate_maps.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const SOURCE_DIR = 'src/Geographer';
const OUTPUT_DIR = 'src/Sawmill/www/map';

const MAP_CONFIGS = {
    '0': {
        src: '0_512.png',
        dest: '0_53.png',
        cmd: 'magick 0_512.png -virtual-pixel edge -filter Lanczos -set option:distort:viewport "1120x2240+0+0" -distort Affine "-3.2,0 0,0 10748.8,0 1120,0 -3.2,21504 0,2240" +repage 0_53.png'
    },
    '1': {
        src: '1_512.png',
        dest: '1_53.png',
        cmd: 'magick 1_512.png -virtual-pixel edge -filter Lanczos -set option:distort:viewport "1600x2507+0+0" -distort Affine "3.2,-3.2 0,0 15363.2,-3.2 1600,0 3.2,24060.8 0,2507" +repage 1_53.png'
    },
    '530': {
        src: '530_512.png',
        dest: '530_53.png',
        cmd: 'magick 530_512.png -virtual-pixel edge -filter Lanczos -set option:distort:viewport "2613x2080+0+0" -distort Affine "-3.2,-3.2 0,0 25081.6,-3.2 2613,0 -3.2,19964.8 0,2080" +repage 530_53.png'
    }
};

async function generate() {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const atlas = {};

    for (const [id, cfg] of Object.entries(MAP_CONFIGS)) {
        console.log(`Generating ${cfg.dest}...`);
        
        // Update command to use absolute paths to be safe
        const srcPath = path.resolve(SOURCE_DIR, cfg.src);
        const destPath = path.resolve(OUTPUT_DIR, cfg.dest);
        
        // Replace filenames in the command with absolute paths
        const finalCmd = cfg.cmd
            .replace(cfg.src, `"${srcPath}"`)
            .replace(cfg.dest, `"${destPath}"`);
            
        execSync(finalCmd, { stdio: 'inherit' });

        // Load metadata from sidecar JSON
        const meta = JSON.parse(fs.readFileSync(path.resolve(SOURCE_DIR, `${id}.json`), 'utf8'));
        
        atlas[id] = {
            name: meta.name,
            top: meta.top,
            tiles: meta.tiles,
            nw: meta.nw,
            sizes: [
                { path: cfg.dest },
                // We only ship the _53 set now, keeping the others as references if needed
                // but the request was to use the _53 maps.
            ]
        };
    }

    fs.writeFileSync(path.resolve(OUTPUT_DIR, 'atlas.json'), JSON.stringify(atlas, null, 2));
    console.log('\nMap generation complete. atlas.json updated.');
}

generate().catch(console.error);
