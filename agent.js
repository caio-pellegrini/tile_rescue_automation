const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const {
  applyVisionLabels,
  loadVisionLabels,
  planningKeyForTile,
  writeVisionPacket,
} = require('./vision');

const DEVICE = process.env.DEVICE || 'RQCY903RJQN';
const LIVE = process.argv.includes('--live');
const EXPORT_VISION = process.argv.includes('--export-vision');
const VISION_LABELS_FILE = process.env.VISION_LABELS_FILE;
const MAX_MOVES = Number(process.env.MAX_MOVES || (LIVE ? 1 : 0));
const SAVE_FRAMES = LIVE || process.env.SAVE_FRAMES === '1';
const LEVEL = process.env.LEVEL || '23';
const RUN_LOG_DIR = process.env.RUN_LOG_DIR || path.join(
  '/tmp',
  'tile-rescue-runs',
  `level-${LEVEL}`,
  new Date().toISOString().replace(/[:.]/g, '-'),
);

// The playfield is everything between the level header and the tray. Keep
// these bounds independent from the card layout: levels can arrange cards in
// different rows and offsets, but the HUD/tray stay outside this region.
// On the current 1080x2340 device layout, level 24 showed a lower board layer
// extending to roughly y=1423. Keep the tray outside the ROI while including
// these lower cards; the tray begins later around y=1600.
const BOARD_ROI = Object.freeze({ x0: 20, y0: 430, x1: 1060, y1: 1480 });

function adb(args, options = {}) {
  return execFileSync('adb', ['-s', DEVICE, ...args], {
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function analyzeImage(image, clusters) {
  const components = connectedComponents(image);
  const state = summarize(image, components, clusters);
  if (VISION_LABELS_FILE) {
    const labels = await loadVisionLabels(VISION_LABELS_FILE);
    const result = applyVisionLabels(state, labels, Number(process.env.VISION_MIN_CONFIDENCE || 0.75));
    console.error(`vision labels applied: ${result.applied}`);
  }
  return { state, action: chooseAction(state) };
}

async function saveRunFrame(image, state, action, phase, runDir) {
  const imagePath = path.join(runDir, `${phase}.png`);
  const metadataPath = path.join(runDir, `${phase}.json`);
  await sharp(image.data, { raw: image.info }).png().toFile(imagePath);
  await fs.writeFile(metadataPath, `${JSON.stringify({
    phase,
    capturedAt: new Date().toISOString(),
    device: DEVICE,
    level: LEVEL,
    state,
    action,
  }, null, 2)}\n`);
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

function isNeutralCardPixel(r, g, b) {
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  return hi > 200 && lo > 155 && hi - lo < 80;
}

function isCollectibleGoldPixel(r, g, b) {
  return r > 135 && g > 105 && b < 115 && r > b * 1.35 && g > b * 1.15;
}

function connectedComponents(image, roi = BOARD_ROI, predicate = isLightTilePixel) {
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
      if (predicate(data[i], data[i + 1], data[i + 2])) {
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
  // A chick and a sun share the same yellow/orange palette. The chick crop
  // contains the eyes/beak as a small dark population; check that before the
  // broad orange=>sun rule.
  if (orange > 0.70 && signature[0] > 0.012) return 'chick';
  if (orange > 0.70) return 'sun';
  // Green icons are intentionally left unknown. The palette-only rules used
  // to call them corn/carrot, but the current game uses green peppers too.
  // A temporary visual group or a catalog reference is safer than a guessed
  // canonical name.
  if (blue + pink > 0.03 && orange > 0.20) return 'cupcake';
  // Do not classify a weaker orange sun as a chick. The tray can change the
  // orange ratio slightly because cards overlap; a chick still needs the dark
  // eyes/beak evidence above this rule.
  if (orange > 0.45 && orange < 0.75 && signature[0] > 0.012 && green < 0.02 && blue + pink < 0.03) return 'chick';
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
      tile.typeSource = 'unknown';
      tile.typeDistance = Infinity;
      tile.sessionGroupId = tile.sessionGroupId || tile.groupId || null;
      tile.planningKey = planningKeyForTile(tile);
      continue;
    }
    const semantic = semanticType(tile.signature);
    if (semantic !== 'unknown') {
      tile.type = semantic;
      tile.groupId = semantic;
      tile.sessionGroupId = semantic;
      tile.planningKey = planningKeyForTile(tile);
      tile.typeSource = 'legacy-semantic';
      tile.typeDistance = 0;
      continue;
    }
    let best = null;
    for (const cluster of clusters) {
      const d = distance(tile.signature, cluster.prototype);
      if (!best || d < best.d) best = { cluster, d };
    }
    // Color signatures are only a conservative fallback. A broad threshold
    // incorrectly merged the blue blueberry with the purple butterfly on the
    // current level, so keep the margin tight and let the named local ML
    // library handle new icons whenever it is available.
    if (best && best.d < 0.10) {
      tile.type = 'unknown';
      tile.groupId = best.cluster.id;
      tile.sessionGroupId = best.cluster.id;
      tile.planningKey = planningKeyForTile(tile);
      tile.typeSource = 'visual-cluster';
      tile.typeDistance = Number(best.d.toFixed(4));
      best.cluster.prototype = best.cluster.prototype.map((v, i) => v * 0.85 + tile.signature[i] * 0.15);
    } else {
      const cluster = { id: `visual-group-${clusters.length + 1}`, prototype: tile.signature, members: [tile] };
      clusters.push(cluster);
      tile.type = 'unknown';
      tile.groupId = cluster.id;
      tile.sessionGroupId = cluster.id;
      tile.planningKey = planningKeyForTile(tile);
      tile.typeSource = 'visual-cluster';
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
  // The current 1080px layout uses 120px slot centers; using the old 107px
  // step progressively shifts crops into the neighboring card.
  for (let slot = 0; slot < 7; slot++) {
    const cx = 120 + slot * 120;
    let light = 0;
    let leftLight = 0;
    let rightLight = 0;
    for (let y = cy - 58; y <= cy + 58; y += 2) {
      // Adjacent tray cards overlap horizontally. Count the slot from its
      // central face only; a wide scan mistakes the right edge of the prior
      // card for a new card in the next empty slot.
      for (let x = cx - 36; x <= cx + 36; x += 2) {
        const [r, g, b] = pixel(image, x, y);
        if (!isLightTilePixel(r, g, b)) continue;
        light++;
        if (x < cx) leftLight++;
        else rightLight++;
      }
    }
    // Downsampled scan: a real card has hundreds of light samples; the dark
    // tray background and empty dividers do not.
    // Blue/dark icons occupy less of the white face than pale icons such as
    // cake. The current threshold keeps empty dividers out while retaining a
    // real blueberry in the first slot.
    // A neighboring card can still contribute light pixels on one side of
    // an empty slot. Require both halves of the slot to contain the card
    // face, preserving real green/dark icons while rejecting that edge.
    if (light < 900 || Math.min(leftLight, rightLight) < 200) continue;
    out.push({
      x: cx - 60, y: cy - 66, w: 120, h: 133,
      area: light, cx, cy,
      signature: descriptor(image, cx, cy),
    });
  }
  return out;
}

function cardVariant(image, cx, cy) {
  const patches = [
    [-50, -50], [50, -50],
    [-50, 50], [50, 50],
  ];
  let gold = 0;
  let neutral = 0;
  for (const [ox, oy] of patches) {
    for (let y = cy + oy - 10; y <= cy + oy + 10; y += 3) {
      for (let x = cx + ox - 10; x <= cx + ox + 10; x += 3) {
        const [r, g, b] = pixel(image, x, y);
        if (isCollectibleGoldPixel(r, g, b)) gold++;
        if (isNeutralCardPixel(r, g, b)) neutral++;
      }
    }
  }
  const total = gold + neutral;
  if (total < 20) return 'unknown';
  return gold / total > 0.45 ? 'collectible' : 'normal';
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
      variant: cardVariant(image, candidate.cx, candidate.cy),
    });
  }

  // Gold cards are valid sun cards, but a diagonal overlap with a neutral
  // card is strong evidence that the gold card is underneath it. The old
  // color-only detector promoted those cards to `available`, creating the
  // false extra sun seen on level 23.
  for (const tile of out) {
    if (tile.variant !== 'collectible') continue;
    const cover = out.find(other => {
      if (other === tile || other.variant !== 'normal') return false;
      const dx = Math.abs(other.cx - tile.cx);
      const dy = Math.abs(other.cy - tile.cy);
      if (dx < 35 || dy < 35 || dx >= 190 || dy >= 190) return false;
      const overlapWidth = Math.max(0, 190 - dx);
      const overlapHeight = Math.max(0, 190 - dy);
      return (overlapWidth * overlapHeight) / (190 * 190) >= 0.04;
    });
    if (cover) {
      tile.playable = false;
      tile.occludedBy = { cx: cover.cx, cy: cover.cy };
    }
  }

  return out
    .filter(tile => tile.playable !== false)
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

// Diagnostic layer detector. Unlike boardAreaTiles(), this deliberately keeps
// partially exposed faces and does not require a matching tray type. It is not
// used to click yet; its job is to expose the complete layer hypothesis to a
// visual classifier and make false geometry visible during validation.
function boardLayerCandidates(image, threshold = 0.38) {
  const candidates = [];
  for (let cy = BOARD_ROI.y0 + 35; cy <= BOARD_ROI.y1 - 35; cy += 10) {
    for (let cx = BOARD_ROI.x0 + 70; cx <= BOARD_ROI.x1 - 70; cx += 10) {
      const visibility = boardCardScore(image, cx, cy);
      if (visibility < threshold) continue;
      candidates.push({ cx, cy, visibility });
    }
  }

  candidates.sort((a, b) => b.visibility - a.visibility);
  const out = [];
  for (const candidate of candidates) {
    if (out.some(prev => Math.hypot(prev.cx - candidate.cx, prev.cy - candidate.cy) < 85)) continue;
    const signature = descriptor(image, candidate.cx, candidate.cy);
    if (!signature) continue;
    out.push({
      x: candidate.cx - 71,
      y: candidate.cy - 80,
      w: 142,
      h: 160,
      cx: candidate.cx,
      cy: candidate.cy,
      visibility: Number(candidate.visibility.toFixed(3)),
      signature,
      variant: cardVariant(image, candidate.cx, candidate.cy),
    });
  }
  return out.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

function layerOverlapRatio(a, b) {
  const overlapWidth = Math.max(0, 190 - Math.abs(a.cx - b.cx));
  const overlapHeight = Math.max(0, 190 - Math.abs(a.cy - b.cy));
  return (overlapWidth * overlapHeight) / (190 * 190);
}

function buildLayerGraph(image, available) {
  const candidates = boardLayerCandidates(image);
  const hidden = candidates.filter(candidate =>
    !available.some(tile => Math.hypot(tile.cx - candidate.cx, tile.cy - candidate.cy) < 55));
  const hiddenKeys = new Set(hidden.map(tile => `${tile.cx},${tile.cy}`));
  const edges = [];
  for (const a of candidates) {
    for (const b of candidates) {
      if (a === b) continue;
      // A relation must point to a genuinely hidden candidate. Without this
      // guard, the coarse diagnostic scan creates duplicate edges to a second
      // point near an already available card.
      if (!hiddenKeys.has(`${b.cx},${b.cy}`)) continue;
      const overlap = layerOverlapRatio(a, b);
      // Tiny corner intersections are common between neighboring cards but do
      // not provide enough evidence that one card covers another.
      if (overlap < 0.12) continue;
      // A fully exposed/neutral face is generally the cover when it overlaps
      // a gold or weakly exposed face. Keep the relation probabilistic: this
      // graph is a hypothesis for the classifier, not a click authorization.
      const scoreA = a.visibility + (a.variant === 'normal' ? 0.05 : 0);
      const scoreB = b.visibility + (b.variant === 'normal' ? 0.05 : 0);
      const cover = scoreA >= scoreB ? a : b;
      const target = cover === a ? b : a;
      if (cover.visibility - target.visibility < 0.02 && cover.variant === target.variant) continue;
      const confidence = Number(Math.min(0.99, overlap * 1.5 + Math.max(0, scoreA - scoreB)).toFixed(3));
      if (confidence < 0.35) continue;
      edges.push({
        cover: { cx: cover.cx, cy: cover.cy },
        target: { cx: target.cx, cy: target.cy, visibility: target.visibility, variant: target.variant },
        relation: 'likely-covers',
        overlap: Number(overlap.toFixed(3)),
        confidence,
      });
    }
  }
  const uniqueEdges = edges.filter((edge, index) => {
    const duplicate = edges.slice(0, index).some(previous =>
      previous.cover.cx === edge.target.cx && previous.cover.cy === edge.target.cy &&
      previous.target.cx === edge.cover.cx && previous.target.cy === edge.cover.cy);
    return !duplicate;
  });
  // A partially visible card can overlap several neighbors. Keep only the two
  // strongest explanations per target so the graph remains useful for
  // validation instead of becoming a dense mesh of speculative relations.
  const rankedByTarget = new Map();
  for (const edge of uniqueEdges) {
    const key = `${edge.target.cx},${edge.target.cy}`;
    if (!rankedByTarget.has(key)) rankedByTarget.set(key, []);
    rankedByTarget.get(key).push(edge);
  }
  const validatedEdges = [];
  for (const group of rankedByTarget.values()) {
    group.sort((a, b) => b.confidence - a.confidence || b.overlap - a.overlap);
    validatedEdges.push(...group.slice(0, 2));
  }
  return {
    nodes: candidates.map(tile => ({
      cx: tile.cx,
      cy: tile.cy,
      visibility: tile.visibility,
      variant: tile.variant,
    })),
    hidden,
    edges: validatedEdges,
  };
}

function cardRectsOverlap(a, b) {
  return Math.abs(a.cx - b.cx) < 120 && Math.abs(a.cy - b.cy) < 135;
}

function cardOverlapRatio(a, b) {
  const overlapWidth = Math.max(0, 142 - Math.abs(a.cx - b.cx));
  const overlapHeight = Math.max(0, 160 - Math.abs(a.cy - b.cy));
  return (overlapWidth * overlapHeight) / (142 * 160);
}

function buildOcclusionGraph(image, available, tray) {
  const trayTypes = [...new Set(tray.map(tile => tile.type))];
  const references = new Map();
  for (const tile of tray) {
    if (!references.has(tile.type)) references.set(tile.type, tile.signature);
  }

  const hidden = [];
  const edges = [];
  for (const targetType of trayTypes) {
    const reference = references.get(targetType);
    if (!reference) continue;

    for (const cover of available) {
      const candidates = [];
      // Search only the rectangle that could be hidden by this card. This is
      // much less ambiguous than classifying every background pixel as a tile.
      for (let cy = Math.max(BOARD_ROI.y0, cover.cy - 100); cy <= Math.min(BOARD_ROI.y1, cover.cy + 135); cy += 10) {
        for (let cx = Math.max(BOARD_ROI.x0 + 48, cover.cx - 110); cx <= Math.min(BOARD_ROI.x1 - 48, cover.cx + 110); cx += 10) {
          const distanceFromCover = Math.hypot(cx - cover.cx, cy - cover.cy);
          if (distanceFromCover < 70) continue;
          const signature = descriptor(image, cx, cy);
          if (semanticType(signature) !== targetType) continue;
          const visualDistance = distance(signature, reference);
          if (visualDistance > 0.16) continue;
          const hiddenTile = { cx, cy };
          const overlap = cardOverlapRatio(cover, hiddenTile);
          if (overlap < 0.25 || cy < cover.cy + 20) continue;
          // Do not mistake the icon/card face of a neighboring exposed tile
          // for a second hidden tile. A valid hidden candidate may overlap its
          // cover, but not another independently playable card.
          const overlapsAnotherAvailable = available.some(other =>
            other !== cover && cardRectsOverlap(other, hiddenTile));
          if (overlapsAnotherAvailable) continue;
          candidates.push({ cx, cy, signature, visualDistance, overlap });
        }
      }

      // Collapse the dense scan into one possible hidden card per region.
      candidates.sort((a, b) => {
        const scoreA = a.overlap * 0.7 + (1 - a.visualDistance) * 0.3;
        const scoreB = b.overlap * 0.7 + (1 - b.visualDistance) * 0.3;
        return scoreB - scoreA;
      });
      let candidate = null;
      for (const item of candidates) {
        if (!candidate || Math.hypot(item.cx - candidate.cx, item.cy - candidate.cy) >= 55) {
          candidate = item;
          break;
        }
      }
      if (!candidate) continue;

      const node = {
        id: `hidden-${hidden.length}`,
        type: targetType,
        x: candidate.cx - 71,
        y: candidate.cy - 80,
        w: 142,
        h: 160,
        cx: candidate.cx,
        cy: candidate.cy,
        confidence: Number((1 - candidate.visualDistance).toFixed(3)),
        overlap: Number(candidate.overlap.toFixed(3)),
      };
      hidden.push(node);
      edges.push({
        cover: { cx: cover.cx, cy: cover.cy, type: cover.type },
        target: node,
        relation: 'covers',
      });
    }
  }

  // The same partial card can be found from two neighboring cover cards.
  const uniqueHidden = [];
  const uniqueEdges = [];
  for (const edge of edges) {
    let node = uniqueHidden.find(item =>
      item.type === edge.target.type && Math.hypot(item.cx - edge.target.cx, item.cy - edge.target.cy) < 55);
    if (!node) {
      node = edge.target;
      uniqueHidden.push(node);
    }
    uniqueEdges.push({ ...edge, target: node });
  }

  return {
    nodes: available.map(tile => ({ cx: tile.cx, cy: tile.cy, type: tile.type })),
    hidden: uniqueHidden,
    edges: uniqueEdges,
  };
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
  // White card faces can be merged with yellow components. Add a second seed
  // pass so a foreground chick/cupcake remains detectable when it overlaps a
  // collectible gold card.
  const neutralComponents = connectedComponents(image, BOARD_ROI, isNeutralCardPixel);
  const allComponents = components.concat(neutralComponents);
  const componentTiles = components
    .map(c => ({ ...c, signature: descriptor(image, c.cx, c.cy) }));
  const exposed = boardAreaTiles(image, allComponents);
  const boardTiles = dedupeTiles(exposed.concat(componentTiles));
  const tiles = boardTiles.concat(trayTiles(image));
  assignTypes(tiles, clusters);
  const available = exposed;
  const layerGraph = buildLayerGraph(image, available);
  // Exposed slots were included in `tiles`, so their assigned type is now
  // available; using these references avoids accidentally treating a hidden
  // component as playable.
  const tray = tiles.filter(t => t.cy >= 1600 && t.cy <= 1900);
  const visible = tiles.filter(t => t.cy < BOARD_ROI.y1);
  const occlusionGraph = buildOcclusionGraph(image, available, tray);
  const trayCounts = {};
  for (const t of tray) {
    const key = planningKeyForTile(t);
    if (key) trayCounts[key] = (trayCounts[key] || 0) + 1;
  }
  const visibleCounts = {};
  for (const t of visible) {
    const key = planningKeyForTile(t);
    if (key) visibleCounts[key] = (visibleCounts[key] || 0) + 1;
  }

  return {
    screen: { width: image.info.width, height: image.info.height },
    detected: tiles.map(({ signature, ...t }) => t),
    available: available.map(({ signature, ...t }) => t),
    tray: tray.map(({ signature, ...t }) => t),
    layerGraph: {
      ...layerGraph,
      hidden: layerGraph.hidden.map(({ signature, ...t }) => t),
    },
    occlusionGraph,
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
  const byPlanningKey = new Map();
  for (const tile of state.available) {
    const key = planningKeyForTile(tile);
    if (!key) continue;
    if (!byPlanningKey.has(key)) byPlanningKey.set(key, []);
    byPlanningKey.get(key).push(tile);
  }

  const isUnknownGroup = key => key.startsWith('group:');
  const totalGroupCount = (key, tiles) => tiles.length + (counts[key] || 0);
  const eligibleUnknownGroup = (key, tiles) => !isUnknownGroup(key) || totalGroupCount(key, tiles) >= 3;
  const releaseScoreForTile = (tile, groupKey) => {
    const edges = state.layerGraph?.edges || [];
    const targets = new Map();
    for (const edge of edges) {
      if (!edge.cover || !edge.target) continue;
      if (Math.hypot(edge.cover.cx - tile.cx, edge.cover.cy - tile.cy) > 48) continue;
      if (edge.target.selectedCover &&
        Math.hypot(edge.cover.cx - edge.target.selectedCover.cx,
          edge.cover.cy - edge.target.selectedCover.cy) > 48) continue;
      const targetKey = `${edge.target.cx},${edge.target.cy}`;
      const targetPlanningKey = planningKeyForTile(edge.target);
      const previous = targets.get(targetKey) || {
        overlap: 0,
        confidence: 0,
        matching: targetPlanningKey === groupKey,
      };
      previous.overlap = Math.max(previous.overlap, edge.overlap || 0);
      previous.confidence = Math.max(previous.confidence, edge.confidence || 0);
      previous.matching ||= targetPlanningKey === groupKey;
      targets.set(targetKey, previous);
    }
    const targetValues = [...targets.values()];
    const matchingTargets = targetValues.filter(target => target.matching);
    return {
      targetCount: targetValues.length,
      matchedTargetCount: matchingTargets.length,
      weightedScore: Number(targetValues
        .reduce((sum, target) => sum + target.overlap * target.confidence, 0)
        .toFixed(4)),
      matchedWeightedScore: Number(matchingTargets
        .reduce((sum, target) => sum + target.overlap * target.confidence, 0)
        .toFixed(4)),
    };
  };
  const groupCandidate = (key, tiles) => {
    const best = tiles
      .map(tile => ({ tile, releaseScore: releaseScoreForTile(tile, key) }))
      .sort((a, b) => b.releaseScore.matchedTargetCount - a.releaseScore.matchedTargetCount ||
        b.releaseScore.matchedWeightedScore - a.releaseScore.matchedWeightedScore ||
        b.releaseScore.targetCount - a.releaseScore.targetCount ||
        b.releaseScore.weightedScore - a.releaseScore.weightedScore ||
        a.tile.cy - b.tile.cy || a.tile.cx - b.tile.cx)[0];
    return { key, tiles, ...best };
  };
  const compareGroupCandidates = (a, b) =>
    b.tiles.length - a.tiles.length ||
    b.releaseScore.matchedTargetCount - a.releaseScore.matchedTargetCount ||
    b.releaseScore.matchedWeightedScore - a.releaseScore.matchedWeightedScore ||
    a.key.localeCompare(b.key);
  const targetFields = (key, tile) => isUnknownGroup(key)
    ? { targetGroupId: tile.sessionGroupId || tile.groupId || key.slice('group:'.length) }
    : { targetType: tile.type };

  const exposedTripleCandidates = () => [...byPlanningKey.entries()]
    .filter(([key, tiles]) => eligibleUnknownGroup(key, tiles) &&
      (counts[key] || 0) === 0 && tiles.length >= 3)
    .map(([key, tiles]) => groupCandidate(key, tiles))
    .sort(compareGroupCandidates);

  // First priority: complete a triple already represented twice in the tray.
  const immediateTriples = [...byPlanningKey.entries()]
    .filter(([key, tiles]) => eligibleUnknownGroup(key, tiles) && (counts[key] || 0) >= 2)
    .map(([key, tiles]) => groupCandidate(key, tiles))
    .sort(compareGroupCandidates);
  if (immediateTriples.length) {
    const candidate = immediateTriples[0];
    return {
      reason: 'complete-triple',
      ...targetFields(candidate.key, candidate.tile),
      releaseScore: candidate.releaseScore,
      tile: candidate.tile,
    };
  }

  // A single card in the tray plus two exposed copies completes a triple and
  // frees a tray slot. This must beat blocked pairs and unrelated exposed
  // groups, even when another pair is already waiting in the tray.
  const trayTripleGroups = [...byPlanningKey.entries()]
    .filter(([key, tiles]) => eligibleUnknownGroup(key, tiles) && (counts[key] || 0) === 1 && tiles.length >= 2)
    .map(([key, tiles]) => groupCandidate(key, tiles))
    .sort(compareGroupCandidates);
  if (trayTripleGroups.length) {
    const candidate = trayTripleGroups[0];
    return {
      reason: 'complete-triple-potential',
      ...targetFields(candidate.key, candidate.tile),
      availableCount: candidate.tiles.length,
      releaseScore: candidate.releaseScore,
      tile: candidate.tile,
    };
  }

  // Starting a fully exposed triple is safer than extending a single pair,
  // but only when all three taps can fit before the triple is removed.
  const traySize = Array.isArray(state.tray)
    ? state.tray.length
    : Object.values(counts).reduce((sum, count) => sum + count, 0);
  const exposedTriples = exposedTripleCandidates();
  if (traySize + 3 <= 7 && exposedTriples.length) {
    const candidate = exposedTriples[0];
    return {
      reason: 'start-exposed-triple',
      ...targetFields(candidate.key, candidate.tile),
      availableCount: candidate.tiles.length,
      releaseScore: candidate.releaseScore,
      tile: candidate.tile,
    };
  }

  // A pair in the tray has precedence over starting/expanding another group.
  // If its third copy is not exposed, the next move is explicitly a search
  // for the hidden copy, rather than silently treating another icon as safe.
  const blockedGroups = Object.keys(counts).filter(key =>
    counts[key] >= 2 && !byPlanningKey.has(key));
  if (blockedGroups.length) {
    if (!state.safety.liveAllowed) return { reason: 'safety-stop', tile: null, blockedGroups };
    // A hidden card with the same visual group is not enough to authorize a
    // search: hidden groups are intentionally not applied by vision.js. Do
    // not turn an unknown tray pair into an arbitrary exploratory tap.
    if (blockedGroups.some(isUnknownGroup)) {
      return { reason: 'safety-stop', tile: null, blockedGroups };
    }

    const releaseEdge = (state.occlusionGraph?.edges || [])
      .filter(edge => blockedGroups.includes(edge.target.type))
      .sort((a, b) => {
        const confidence = (b.target.confidence || 0) - (a.target.confidence || 0);
        return confidence || (b.target.overlap || 0) - (a.target.overlap || 0);
      })[0];
    if (releaseEdge) {
      const cover = state.available.find(tile =>
        tile.cx === releaseEdge.cover.cx && tile.cy === releaseEdge.cover.cy);
      if (cover) {
        return {
          reason: 'release-hidden-match',
          targetTypes: blockedGroups,
          reveals: releaseEdge.target,
          tile: cover,
        };
      }
    }

    // If the tray cannot fit an exposed triple, prefer a safe single-pair
    // extension over exploratory searching for the blocked pair.
    const trayPairs = [...byPlanningKey.entries()]
      .filter(([key, tiles]) => eligibleUnknownGroup(key, tiles) &&
        (counts[key] || 0) >= 1 && tiles.length >= 1)
      .map(([key, tiles]) => groupCandidate(key, tiles))
      .sort(compareGroupCandidates);
    if (trayPairs.length) {
      const candidate = trayPairs[0];
      return {
        reason: 'make-pair-with-tray',
        ...targetFields(candidate.key, candidate.tile),
        releaseScore: candidate.releaseScore,
        tile: candidate.tile,
      };
    }

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

  // A single-card tray group with one exposed copy is useful, but it is only
  // a pair extension and therefore comes after all visible triple options.
  const trayPairs = [...byPlanningKey.entries()]
    .filter(([key, tiles]) => eligibleUnknownGroup(key, tiles) && (counts[key] || 0) >= 1 && tiles.length >= 1)
    .map(([key, tiles]) => groupCandidate(key, tiles))
    .sort(compareGroupCandidates);
  if (trayPairs.length) {
    const candidate = trayPairs[0];
    return {
      reason: 'make-pair-with-tray',
      ...targetFields(candidate.key, candidate.tile),
      releaseScore: candidate.releaseScore,
      tile: candidate.tile,
    };
  }

  // If no tray group exists yet, prefer the largest exposed group. This is
  // deterministic and prevents spatial detection order from choosing a
  // singleton when three equal cards are already available.
  const exposedGroups = [...byPlanningKey.entries()]
    .filter(([key, tiles]) => eligibleUnknownGroup(key, tiles) && (counts[key] || 0) === 0 &&
      tiles.length >= (isUnknownGroup(key) ? 3 : 2))
    .map(([key, tiles]) => groupCandidate(key, tiles))
    .sort(compareGroupCandidates);
  if (exposedGroups.length) {
    const candidate = exposedGroups[0];
    return {
      reason: candidate.tiles.length >= 3 ? 'start-exposed-triple' : 'start-exposed-pair',
      ...targetFields(candidate.key, candidate.tile),
      availableCount: candidate.tiles.length,
      releaseScore: candidate.releaseScore,
      tile: candidate.tile,
    };
  }

  // Never fill the final tray slot without a direct match.
  if (!state.safety.liveAllowed) return { reason: 'safety-stop', tile: null };

  // Exploratory action: choose the exposed type seen most often on the board.
  let chosen = null;
  for (const tile of state.available) {
    const key = planningKeyForTile(tile);
    if (!key || isUnknownGroup(key)) continue;
    const score = state.visibleCounts[key] || 0;
    if (!chosen || score > chosen.score) chosen = { tile, score };
  }
  return chosen ? { reason: 'reveal-most-promising', tile: chosen.tile } : { reason: 'no-action', tile: null };
}

async function main() {
  let moves = 0;
  const clusters = [];
  let runDir = null;
  if (SAVE_FRAMES) {
    runDir = RUN_LOG_DIR;
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify({
      startedAt: new Date().toISOString(),
      device: DEVICE,
      level: LEVEL,
      live: LIVE,
      maxMoves: MAX_MOVES,
      visionLabelsFile: VISION_LABELS_FILE || null,
    }, null, 2)}\n`);
    console.error(`run frames: ${runDir}`);
  }
  while (true) {
    const image = await capture();
    const { state, action } = await analyzeImage(image, clusters);
    if (runDir) await saveRunFrame(image, state, action, `move-${String(moves).padStart(3, '0')}-before`, runDir);
    if (EXPORT_VISION || process.env.VISION_PACKET_DIR) {
      const outputDir = process.env.VISION_PACKET_DIR || path.resolve('vision-packet');
      const packet = await writeVisionPacket(image, state, outputDir);
      console.error(`vision packet written to ${packet.outputDir}`);
    }
    console.log(JSON.stringify({ device: DEVICE, live: LIVE, moves, state, action }, null, 2));

    if (EXPORT_VISION || !LIVE || moves >= MAX_MOVES || !action.tile) break;
    adb(['shell', 'input', 'tap', String(action.tile.cx), String(action.tile.cy)]);
    moves++;
    await sleep(900);

    if (runDir) {
      const afterImage = await capture();
      const after = await analyzeImage(afterImage, clusters);
      await saveRunFrame(afterImage, after.state, after.action, `move-${String(moves - 1).padStart(3, '0')}-after`, runDir);
    }
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  descriptor,
  distance,
  connectedComponents,
  boardAreaTiles,
  boardLayerCandidates,
  buildLayerGraph,
  cardVariant,
  buildOcclusionGraph,
  summarize,
  chooseAction,
  planningKeyForTile,
  semanticType,
};
