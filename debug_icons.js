const fs = require('node:fs');
const sharp = require('sharp');
const { descriptor, distance } = require('./agent');

async function image(path) {
  return sharp(fs.readFileSync(path)).raw().toBuffer({ resolveWithObject: true });
}

const known = [
  ['carrot-board', '/tmp/tile_rescue_level23_clean.png', 326, 1177],
  ['cupcake-board', '/tmp/tile_rescue_level23_clean.png', 540, 1177],
  ['sun-board', '/tmp/tile_rescue_level23_clean.png', 754, 1177],
  ['carrot-tray', '/tmp/agent_after_one.png', 120, 1740],
  ['corn-current', '/tmp/agent_after_one.png', 326, 1167],
  ['cupcake-current', '/tmp/agent_after_one.png', 540, 1177],
  ['sun-current', '/tmp/agent_after_one.png', 754, 1177],
];

(async () => {
  const cache = new Map();
  for (const [, path] of known) if (!cache.has(path)) cache.set(path, await image(path));
  const values = known.map(([name, path, x, y]) => ({ name, v: descriptor(cache.get(path), x, y) }));
  for (const a of values) {
    const row = values.map(b => `${b.name}:${distance(a.v, b.v).toFixed(3)}`).join('  ');
    console.log(row);
  }
})().catch(err => { console.error(err); process.exit(1); });
