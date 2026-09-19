const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

const DEVICE = process.env.DEVICE || 'RQCY903RJQN';
const LIVE = process.argv.includes('--live');
const MAX_MOVES = Number(process.env.MAX_MOVES || (LIVE ? 1 : 0));

// The playfield is everything between the level header and the tray. Keep
// these bounds independent from the card layout: levels can arrange cards in
// different rows and offsets, but the HUD/tray stay outside this region.
const BOARD_ROI = Object.freeze({ x0: 20, y0: 430, x1: 1060, y1: 1450 });

function adb(args, options = {}) {
  return execFileSync('adb', ['-s', DEVICE, ...args], {
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function capture() {
  const png = adb(['exec-out', 'screencap', '-p']);
  return sharp(png).raw().toBuffer({ resolveWithObject: true });
}

function pixel(image, x, y) {
  const { data, info } = image;
  x = Math.max(0, Math.min(info.width - 1, Math.round(x)));
  y = Math.max(0, Math.min(info.height - 1, Math.round(y)));
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

function isLightTilePixel(r, g, b) {
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const light = hi > 185 && lo > 125 && hi - lo < 115;
  const yellow = r > 165 && g > 105 && b < 175 && r > b * 1.25 && g > b * 1.05;
  return light || yellow;
}

function connectedComponents(image, roi = BOARD_ROI) {
  const { data, info } = image;
  roi = {
    x0: Math.max(0, roi.x0),
    y0: Math.max(0, roi.y0),
    x1: Math.min(info.width, roi.x1),
    y1: Math.min(info.height, roi.y1),
  };
  const rw = roi.x1 - roi.x0;
  const rh = roi.y1 - roi.y0;
  const mask = new Uint8Array(rw * rh);
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);

  for (let y = roi.y0; y < roi.y1; y++) {
    for (let x = roi.x0; x < roi.x1; x++) {
      const i = (y * info.width + x) * info.channels;
      if (isLightTilePixel(data[i], data[i + 1], data[i + 2])) {
        mask[(y - roi.y0) * rw + (x - roi.x0)] = 1;
      }
    }
  }

  const raw = [];
  for (let sy = 0; sy < rh; sy++) {
    for (let sx = 0; sx < rw; sx++) {
      const start = sy * rw + sx;
      if (!mask[start] || seen[start]) continue;
      let qh = 0, qt = 0, area = 0;
      let minX = sx, maxX = sx, minY = sy, maxY = sy;
      queue[qt++] = start;
      seen[start] = 1;
      while (qh < qt) {
        const idx = queue[qh++];
        const x = idx % rw;
        const y = Math.floor(idx / rw);
        area++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const n of [idx - 1, idx + 1, idx - rw, idx + rw]) {
          if (n < 0 || n >= mask.length || seen[n] || !mask[n]) continue;
          const nx = n % rw;
          const ny = Math.floor(n / rw);
          if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
          seen[n] = 1;
          queue[qt++] = n;
        }
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const validBoard = area >= 6500 && w >= 115 && h >= 115 && w <= 190 && h <= 210;
      if (validBoard) {
        raw.push({
          x: roi.x0 + minX,
          y: roi.y0 + minY,
          w, h, area,
          cx: Math.round(roi.x0 + (minX + maxX) / 2),
          cy: Math.round(roi.y0 + (minY + maxY) / 2),
        });
      }
    }
  }

  // One tile can produce several overlapping masks. Keep only the largest box
  // near each center.
  raw.sort((a, b) => b.area - a.area);
  const out = [];
  for (const item of raw) {
    const duplicate = out.some(prev => {
      const dx = prev.cx - item.cx;
      const dy = prev.cy - item.cy;
      return Math.hypot(dx, dy) < 48;
    });
    if (!duplicate) out.push(item);
  }
  return out.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

// A tile changes size when it moves from the board into the tray. Use a
// foreground color signature over the central card area, which is invariant
// to that scale change and still distinguishes the game's main icons.
function descriptor(image, cx, cy) {
  const bins = new Array(9).fill(0);
  let foreground = 0;
  for (let y = cy - 48; y <= cy + 48; y++) {
    for (let x = cx - 48; x <= cx + 48; x++) {
      const [r, g, b] = pixel(image, x, y);
      const hi = Math.max(r, g, b);
      const lo = Math.min(r, g, b);
      const sat = hi - lo;
      // The card face is neutral and does not identify the icon.
      if (sat < 32 && hi > 135) continue;
      foreground++;
      if (hi < 70) bins[0]++;
      else if (r > 180 && g < 130 && b < 160) bins[1]++; // red/pink shadow
      else if (r > 170 && g > 120 && b < 130) bins[2]++; // orange/yellow
      else if (r > 150 && g > 135 && b < 185) bins[3]++; // pale yellow
      else if (g > r * 1.12 && g > b * 1.12) bins[4]++; // green
      else if (b > r * 1.15 && b > g * 1.05) bins[5]++; // blue
      else if (r > g * 1.15 && b > g * 1.05) bins[6]++; // pink/purple
      else bins[7]++;
    }
  }
  if (foreground < 20) return null;
  return bins.map(v => v / foreground);
}

function semanticType(signature) {
  if (!signature) return 'unknown';
  const [, red, orange, pale, green, blue, pink] = signature;
  if (orange > 0.75) return 'sun';
  if (green > 0.25) return 'corn';
  if (green > 0.02 && green < 0.25 && blue + pink < 0.03) return 'carrot';
  if (blue + pink > 0.03 && orange > 0.20) return 'cupcake';
  if (orange > 0.45 && orange < 0.75 && green < 0.02 && blue + pink < 0.03) return 'chick';
  if (blue > 0.15) return 'whale';
  return 'unknown';
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
}

function assignTypes(tiles, clusters = []) {
  for (const tile of tiles) {
    if (!tile.signature) {
      tile.type = 'unknown';
      tile.typeDistance = Infinity;
      continue;
    }
    const semantic = semanticType(tile.signature);
    if (semantic !== 'unknown') {
      tile.type = semantic;
      tile.typeDistance = 0;
      continue;
    }
    let best = null;
    for (const cluster of clusters) {
      const d = distance(tile.signature, cluster.prototype);
      if (!best || d < best.d) best = { cluster, d };
    }
    // Empirical margin from board-to-tray scale changes on this device. A
    // larger distance stays a new visual class instead of guessing a match.
    if (best && best.d < 0.24) {
      tile.type = best.cluster.id;
      tile.typeDistance = Number(best.d.toFixed(4));
      best.cluster.prototype = best.cluster.prototype.map((v, i) => v * 0.85 + tile.signature[i] * 0.15);
    } else {
      const cluster = { id: `tile-${clusters.length}`, prototype: tile.signature, members: [tile] };
      clusters.push(cluster);
      tile.type = cluster.id;
      tile.typeDistance = 0;
    }
  }
  return clusters;
}

function trayTiles(image) {
  const out = [];
  const cy = 1740;
  // The tray is a fixed seven-slot strip on this device. Adjacent cards
  // overlap, so connected components are not a reliable way to count them.
  for (let slot = 0; slot < 7; slot++) {
    const cx = 120 + slot * 107;
    let light = 0;
    for (let y = cy - 58; y <= cy + 58; y += 2) {
      for (let x = cx - 48; x <= cx + 48; x += 2) {
        const [r, g, b] = pixel(image, x, y);
        if (isLightTilePixel(r, g, b)) light++;
      }
    }
    // Downsampled scan: a real card has hundreds of light samples; the dark
    // tray background and empty dividers do not.
    if (light < 1500) continue;
    out.push({
      x: cx - 60, y: cy - 66, w: 120, h: 133,
      area: light, cx, cy,
      signature: descriptor(image, cx, cy),
    });
  }
  return out;
}

function boardCardScore(image, cx, cy) {
  // The four corner patches avoid the icon itself and are a useful measure of
  // how much of a card face is actually exposed. Hidden cards usually have
  // one or more corners covered by a card above them.
  const patches = [
    [-42, -52], [42, -52],
    [-42, 52], [42, 52],
  ];
  let light = 0;
  let samples = 0;
  for (const [ox, oy] of patches) {
    for (let y = cy + oy - 12; y <= cy + oy + 12; y += 2) {
      for (let x = cx + ox - 12; x <= cx + ox + 12; x += 2) {
        const [r, g, b] = pixel(image, x, y);
        samples++;
        if (isLightTilePixel(r, g, b)) light++;
      }
    }
  }
  return light / samples;
}

function boardAreaTiles(image, components = []) {
  const out = [];
  const candidates = [];

  // Connected components are especially valuable for a card whose face is
  // fully visible but whose border touches another card. They seed the scan
  // with a precise center; the visibility check keeps partial/covered faces
  // out of the playable set.
  for (const component of components) {
    const visibility = boardCardScore(image, component.cx, component.cy);
    if (visibility < 0.75) continue;
    candidates.push({
      cx: component.cx,
      cy: component.cy,
      visibility,
      source: 'component',
      area: component.area,
    });
  }

  // Scan the whole board on a coarse grid. The score is deliberately based
  // on card corners rather than a fixed row/column layout.
  for (let cy = BOARD_ROI.y0 + 40; cy <= BOARD_ROI.y1 - 40; cy += 10) {
    for (let cx = BOARD_ROI.x0 + 70; cx <= BOARD_ROI.x1 - 70; cx += 10) {
      const visibility = boardCardScore(image, cx, cy);
      if (visibility >= 0.82) candidates.push({ cx, cy, visibility, source: 'scan' });
    }
  }

  // Greedy non-maximum suppression keeps the most exposed face when cards
  // overlap. Adjacent cards remain separate; a card above/below another is
  // suppressed when its rectangle overlaps the stronger candidate.
  candidates.sort((a, b) => {
    const sourceOrder = Number(b.source === 'component') - Number(a.source === 'component');
    return sourceOrder || b.visibility - a.visibility;
  });
  for (const candidate of candidates) {
    const overlaps = out.some(prev =>
      Math.abs(prev.cx - candidate.cx) < 120 &&
      Math.abs(prev.cy - candidate.cy) < 135);
    if (overlaps) continue;
    const signature = descriptor(image, candidate.cx, candidate.cy);
    if (!signature) continue;
    out.push({
      x: candidate.cx - 71,
      y: candidate.cy - 80,
      w: 142,
      h: 160,
      area: candidate.area || Math.round(candidate.visibility * 10000),
      visibility: Number(candidate.visibility.toFixed(3)),
      cx: candidate.cx,
      cy: candidate.cy,
      signature,
    });
  }

  return out.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

function dedupeTiles(tiles) {
  const out = [];
  for (const tile of tiles) {
    if (out.some(prev => Math.hypot(prev.cx - tile.cx, prev.cy - tile.cy) < 45)) continue;
    out.push(tile);
  }
  return out;
}

function summarize(image, components, clusters) {
  const componentTiles = components
    .map(c => ({ ...c, signature: descriptor(image, c.cx, c.cy) }));
  const exposed = boardAreaTiles(image, components);
  const boardTiles = dedupeTiles(exposed.concat(componentTiles));
  const tiles = boardTiles.concat(trayTiles(image));
  assignTypes(tiles, clusters);
  const available = exposed;
  // Exposed slots were included in `tiles`, so their assigned type is now
  // available; using these references avoids accidentally treating a hidden
  // component as playable.
  const tray = tiles.filter(t => t.cy >= 1600 && t.cy <= 1900);
  const visible = tiles.filter(t => t.cy < BOARD_ROI.y1);
  const trayCounts = {};
  for (const t of tray) trayCounts[t.type] = (trayCounts[t.type] || 0) + 1;
  const visibleCounts = {};
  for (const t of visible) visibleCounts[t.type] = (visibleCounts[t.type] || 0) + 1;

  return {
    screen: { width: image.info.width, height: image.info.height },
    detected: tiles.map(({ signature, ...t }) => t),
    available: available.map(({ signature, ...t }) => t),
    tray: tray.map(({ signature, ...t }) => t),
    trayCounts,
    visibleCounts,
    safety: {
      trayFull: tray.length >= 7,
      hasPlayableTiles: available.length > 0,
      liveAllowed: tray.length < 6,
    },
  };
}

function chooseAction(state) {
  const counts = state.trayCounts;
  const byType = new Map();
  for (const tile of state.available) {
    if (!byType.has(tile.type)) byType.set(tile.type, []);
    byType.get(tile.type).push(tile);
  }

  // First priority: complete a triple already represented twice in the tray.
  for (const [type, tiles] of byType) {
    if ((counts[type] || 0) >= 2) return { reason: 'complete-triple', tile: tiles[0] };
  }

  // A pair in the tray has precedence over starting/expanding another group.
  // If its third copy is not exposed, the next move is explicitly a search
  // for the hidden copy, rather than silently treating another icon as safe.
  const blockedGroups = Object.keys(counts).filter(type =>
    counts[type] >= 2 && !byType.has(type));
  if (blockedGroups.length) {
    if (!state.safety.liveAllowed) return { reason: 'safety-stop', tile: null, blockedGroups };
    let chosen = null;
    for (const tile of state.available) {
      const underneath = (state.detected || []).filter(other =>
        other.cy > tile.cy + 80 && Math.abs(other.cx - tile.cx) < 115).length;
      const score = underneath * 10 - tile.cy / 10000;
      if (!chosen || score > chosen.score) chosen = { tile, score };
    }
    return chosen
      ? { reason: 'search-hidden-match', targetTypes: blockedGroups, tile: chosen.tile }
      : { reason: 'no-action', targetTypes: blockedGroups, tile: null };
  }

  // Second priority: never choose an unrelated piece when a visible copy can
  // extend a group already in the tray.
  for (const [type, tiles] of byType) {
    if ((counts[type] || 0) >= 1 && tiles.length >= 1) {
      return { reason: 'make-pair-with-tray', tile: tiles[0] };
    }
  }

  // If no tray group exists yet, prefer the largest exposed group. This is
  // deterministic and prevents spatial detection order from choosing a
  // singleton when three equal cards are already available.
  const exposedGroups = [...byType.entries()]
    .filter(([type, tiles]) => (counts[type] || 0) === 0 && tiles.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  if (exposedGroups.length) {
    return { reason: 'start-exposed-pair', tile: exposedGroups[0][1][0] };
  }

  // Never fill the final tray slot without a direct match.
  if (!state.safety.liveAllowed) return { reason: 'safety-stop', tile: null };

  // Exploratory action: choose the exposed type seen most often on the board.
  let chosen = null;
  for (const tile of state.available) {
    const score = state.visibleCounts[tile.type] || 0;
    if (!chosen || score > chosen.score) chosen = { tile, score };
  }
  return chosen ? { reason: 'reveal-most-promising', tile: chosen.tile } : { reason: 'no-action', tile: null };
}

async function main() {
  let moves = 0;
  const clusters = [];
  while (true) {
    const image = await capture();
    const components = connectedComponents(image);
    const state = summarize(image, components, clusters);
    const action = chooseAction(state);
    console.log(JSON.stringify({ device: DEVICE, live: LIVE, moves, state, action }, null, 2));

    if (!LIVE || moves >= MAX_MOVES || !action.tile) break;
    adb(['shell', 'input', 'tap', String(action.tile.cx), String(action.tile.cy)]);
    moves++;
    await sleep(900);
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { descriptor, distance, connectedComponents, boardAreaTiles, summarize, chooseAction };
