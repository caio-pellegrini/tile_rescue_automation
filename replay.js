const fs = require('node:fs');
const sharp = require('sharp');
const { connectedComponents, summarize, chooseAction } = require('./agent');

async function load(path) {
  return sharp(fs.readFileSync(path)).raw().toBuffer({ resolveWithObject: true });
}

(async () => {
  const clusters = [];
  for (const path of ['/tmp/tile_rescue_level23_clean.png', '/tmp/agent_after_one.png', '/tmp/agent_after_two.png']) {
    const image = await load(path);
    const state = summarize(image, connectedComponents(image), clusters);
    const action = chooseAction(state);
    console.log(JSON.stringify({ path, tray: state.trayCounts, available: state.available.map(t => [t.cx, t.cy, t.type]), action: action.reason }, null, 2));
  }
})().catch(err => { console.error(err); process.exit(1); });
