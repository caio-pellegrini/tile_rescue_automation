const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const DEFAULT_CROP_SIZE = 144;
const CONTACT_COLUMNS = 4;
const CONTACT_CELL_WIDTH = 190;
const CONTACT_CELL_HEIGHT = 190;
const MASK_BACKGROUND = '#149b7d';

function cropBox(tile, info, size = DEFAULT_CROP_SIZE) {
  const half = Math.floor(size / 2);
  const maxLeft = Math.max(0, info.width - size);
  const maxTop = Math.max(0, info.height - size);
  const left = Math.max(0, Math.min(maxLeft, Math.round(tile.cx - half)));
  const top = Math.max(0, Math.min(maxTop, Math.round(tile.cy - half)));
  return { left, top, width: size, height: size };
}

function tileId(tile, index, role = tile.cy >= 1600 ? 'tray' : 'board') {
  return `${role}-${index}-${tile.cx}-${tile.cy}`;
}

function safeFileName(value) {
  return value.replace(/[^a-z0-9_.-]+/gi, '_');
}

function tileManifest(tile, index, info, role) {
  role ||= tile.cy >= 1600 ? 'tray' : 'board';
  const id = tileId(tile, index, role);
  return {
    id,
    role,
    center: { x: tile.cx, y: tile.cy },
    box: cropBox(tile, info),
    detectedType: tile.type || 'unknown',
    groupId: tile.groupId || null,
    typeSource: tile.typeSource || 'unknown',
    variant: tile.variant || null,
    typeDistance: Number.isFinite(tile.typeDistance) ? tile.typeDistance : null,
    visibility: tile.visibility ?? null,
    confidence: tile.confidence ?? null,
    crop: `crops/${safeFileName(id)}.png`,
  };
}

function sameCenter(a, b) {
  return a && b && Number(a.cx ?? a.x) === Number(b.cx ?? b.x) &&
    Number(a.cy ?? a.y) === Number(b.cy ?? b.y);
}

function coverRect(tile) {
  return {
    left: Math.round(tile.cx - 71),
    top: Math.round(tile.cy - 80),
    width: 142,
    height: 160,
  };
}

function intersection(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function visibleCropSvg(box, covers) {
  const rects = covers
    .map(cover => intersection(box, coverRect(cover)))
    .filter(Boolean)
    .map(rect => `<rect x="${rect.left - box.left}" y="${rect.top - box.top}" width="${rect.width}" height="${rect.height}" fill="${MASK_BACKGROUND}"/>`)
    .join('');
  return Buffer.from(`<svg width="${box.width}" height="${box.height}"><g>${rects}</g></svg>`);
}

function validateLayerGraph(layerGraph = {}) {
  const hidden = layerGraph.hidden || [];
  const edges = layerGraph.edges || [];
  const hiddenKeys = new Set(hidden.map(tile => `${tile.cx},${tile.cy}`));
  const incoming = new Map();
  const issues = [];
  let minOverlap = 1;
  let minConfidence = 1;
  for (const edge of edges) {
    const targetKey = `${edge.target.cx},${edge.target.cy}`;
    incoming.set(targetKey, (incoming.get(targetKey) || 0) + 1);
    if (!hiddenKeys.has(targetKey)) issues.push(`target-not-hidden:${targetKey}`);
    if (!Number.isFinite(edge.overlap) || edge.overlap < 0.12) issues.push(`weak-overlap:${targetKey}`);
    if (!Number.isFinite(edge.confidence) || edge.confidence < 0.35) issues.push(`weak-confidence:${targetKey}`);
    if (Number.isFinite(edge.overlap)) minOverlap = Math.min(minOverlap, edge.overlap);
    if (Number.isFinite(edge.confidence)) minConfidence = Math.min(minConfidence, edge.confidence);
  }
  const counts = [...incoming.values()];
  return {
    valid: issues.length === 0,
    hiddenCount: hidden.length,
    edgeCount: edges.length,
    coveredTargetCount: incoming.size,
    uncoveredTargetCount: hidden.filter(tile => !incoming.has(`${tile.cx},${tile.cy}`)).length,
    maxEdgesPerTarget: counts.length ? Math.max(...counts) : 0,
    minOverlap: edges.length ? Number(minOverlap.toFixed(3)) : null,
    minConfidence: edges.length ? Number(minConfidence.toFixed(3)) : null,
    issues,
  };
}

function buildVisionManifest(state, info) {
  const detected = (state.detected || []).map((tile, index) => tileManifest(tile, index, info));
  const layerGraph = state.layerGraph || { nodes: [], hidden: [], edges: [] };
  const hidden = (layerGraph.hidden || state.occlusionGraph?.hidden || [])
    .map((tile, index) => tileManifest(tile, index, info, 'hidden'));
  const layerEdges = layerGraph.edges || [];
  for (const tile of hidden) {
    const covers = layerEdges
      .filter(edge => sameCenter(edge.target, tile.center))
      .map(edge => ({
        cx: edge.cover.cx,
        cy: edge.cover.cy,
        confidence: edge.confidence ?? null,
      }));
    if (covers.length) {
      tile.coveredBy = covers;
      tile.visibleCrop = `visible/${safeFileName(tile.id)}.png`;
    }
  }
  const tiles = detected.concat(hidden);
  const references = [];
  for (const tile of tiles.filter(item => item.role === 'tray')) {
    if (!references.some(reference => reference.type === tile.detectedType)) {
      references.push({ type: tile.detectedType, tileId: tile.id, crop: tile.crop });
    }
  }
  return {
    schemaVersion: 2,
    createdBy: 'tile_rescue_automation',
    purpose: 'Classify visible and partially occluded Tile Rescue cards.',
    instructions: {
      classifyEachCrop: true,
      assignDynamicGroupIds: false,
      labelExamples: ['blueberry', 'butterfly', 'cake', 'sun', 'carrot', 'unknown'],
      includeTopAlternatives: true,
      estimateVisibleFraction: true,
      useVisibleCropForHidden: true,
      doNotInferClicks: 'The local geometry/occlusion graph decides which card must be tapped.',
    },
    screen: state.screen,
    currentState: {
      trayCounts: state.trayCounts,
      availableCount: (state.available || []).length,
      safety: state.safety,
    },
    references,
    tiles,
    layerGraph,
    layerGraphValidation: validateLayerGraph(layerGraph),
    graph: state.occlusionGraph || { nodes: [], hidden: [], edges: [] },
  };
}

async function loadVisionLabels(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed.predictions || parsed.labels || []);
}

function applyVisionLabels(state, predictions, minimumConfidence = 0.75) {
  const accepted = (Array.isArray(predictions) ? predictions : [])
    .filter(prediction => prediction && typeof prediction.id === 'string')
    .filter(prediction => Number(prediction.confidence) >= minimumConfidence)
    .filter(prediction => typeof prediction.label === 'string')
    // An uncertain model result must not erase a useful legacy semantic label.
    // Unknown predictions remain in local-predictions.json for diagnosis, but
    // only a named reference is allowed to change the planner's state.
    .filter(prediction => prediction.referenceLabel || prediction.label !== 'unknown');

  const byCenter = new Map();
  for (const prediction of accepted) {
    const match = prediction.id.match(/-(\d+)-(\d+)$/);
    if (!match) continue;
    byCenter.set(`${Number(match[1])},${Number(match[2])}`, prediction);
  }

  const collections = [
    state.detected,
    state.available,
    state.tray,
    state.layerGraph?.hidden,
    state.occlusionGraph?.hidden,
  ];
  let applied = 0;
  for (const collection of collections) {
    for (const tile of collection || []) {
      const prediction = byCenter.get(`${tile.cx},${tile.cy}`);
      if (!prediction) continue;
      // groupId is local to the current screen and is what lets a new level
      // use completely different icons without relying on semantic names.
      tile.groupId = prediction.groupId || prediction.label || null;
      tile.type = prediction.referenceLabel || (prediction.label && prediction.label !== 'unknown'
        ? prediction.label
        : 'unknown');
      tile.typeSource = prediction.referenceLabel ? 'local-reference' : 'local-ml';
      tile.modelLabel = prediction.label;
      tile.typeDistance = Number((1 - Number(prediction.confidence)).toFixed(4));
      tile.modelConfidence = Number(prediction.confidence);
      applied++;
    }
  }

  // The same coordinates can occur in detected and available. Recount after
  // applying labels so the planner consumes the corrected semantic state.
  state.trayCounts = {};
  for (const tile of state.tray || []) state.trayCounts[tile.type] = (state.trayCounts[tile.type] || 0) + 1;
  state.visibleCounts = {};
  for (const tile of state.detected || []) {
    if (tile.cy < 1600) state.visibleCounts[tile.type] = (state.visibleCounts[tile.type] || 0) + 1;
  }
  return { state, applied };
}

function labelSvg(text, width = CONTACT_CELL_WIDTH, height = 28) {
  const escaped = String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  return Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#18202b"/><text x="8" y="19" fill="white" font-size="13" font-family="sans-serif">${escaped}</text></svg>`,
  );
}

function svgNumber(value) {
  return Number(value).toFixed(1);
}

function graphOverlaySvg(imageInfo, state) {
  const graph = state.layerGraph || { nodes: [], hidden: [], edges: [] };
  const available = state.available || [];
  const hidden = graph.hidden || [];
  const availableKeys = new Set(available.map(tile => `${tile.cx},${tile.cy}`));
  const hiddenKeys = new Set(hidden.map(tile => `${tile.cx},${tile.cy}`));
  const edgeSvg = (graph.edges || []).map(edge => {
    const cover = edge.cover;
    const target = edge.target;
    return `<line x1="${svgNumber(cover.cx)}" y1="${svgNumber(cover.cy)}" x2="${svgNumber(target.cx)}" y2="${svgNumber(target.cy)}" stroke="#ff4d6d" stroke-width="3" opacity="0.72"/>`;
  }).join('');
  const nodeSvg = (graph.nodes || []).map(node => {
    const key = `${node.cx},${node.cy}`;
    const isAvailable = availableKeys.has(key);
    const isHidden = hiddenKeys.has(key);
    const color = isAvailable ? '#26e07f' : isHidden ? '#ff4d6d' : '#ffd166';
    return `<circle cx="${svgNumber(node.cx)}" cy="${svgNumber(node.cy)}" r="16" fill="${color}" fill-opacity="0.28" stroke="${color}" stroke-width="3"/><text x="${svgNumber(node.cx + 19)}" y="${svgNumber(node.cy - 17)}" fill="white" font-size="15" font-family="sans-serif" stroke="#111827" stroke-width="4" paint-order="stroke">${isAvailable ? 'A' : isHidden ? 'H' : '?'} ${svgNumber(node.visibility ?? 0)}</text>`;
  }).join('');
  const legend = `<rect x="16" y="16" width="300" height="76" rx="8" fill="#111827" fill-opacity="0.86"/><text x="30" y="40" fill="white" font-size="16" font-family="sans-serif">Layer graph diagnostic</text><text x="30" y="62" fill="#26e07f" font-size="14" font-family="sans-serif">A = available</text><text x="150" y="62" fill="#ff4d6d" font-size="14" font-family="sans-serif">H = hidden candidate</text><text x="30" y="82" fill="#ffd166" font-size="14" font-family="sans-serif">line = likely covers</text>`;
  return Buffer.from(`<svg width="${imageInfo.width}" height="${imageInfo.height}">${edgeSvg}${nodeSvg}${legend}</svg>`);
}

async function writeVisionPacket(image, state, outputDir) {
  const manifest = buildVisionManifest(state, image.info);
  const cropsDir = path.join(outputDir, 'crops');
  const visibleDir = path.join(outputDir, 'visible');
  await fs.mkdir(cropsDir, { recursive: true });
  await fs.mkdir(visibleDir, { recursive: true });

  const screenPath = path.join(outputDir, 'screen.png');
  await sharp(image.data, { raw: image.info }).png().toFile(screenPath);

  if (manifest.layerGraph.nodes?.length) {
    await sharp(image.data, { raw: image.info })
      .composite([{ input: graphOverlaySvg(image.info, state), left: 0, top: 0 }])
      .png()
      .toFile(path.join(outputDir, 'layer-graph-overlay.png'));
    manifest.debugArtifacts = {
      layerGraphOverlay: 'layer-graph-overlay.png',
      rawCrops: 'crops/',
      visibleOnlyCrops: 'visible/',
    };
  }

  const composites = [];
  const visibleComposites = [];
  const visibleTiles = manifest.tiles.filter(tile => tile.visibleCrop && tile.coveredBy?.length);
  for (const tile of manifest.tiles) {
    const crop = await sharp(image.data, { raw: image.info })
      .extract(tile.box)
      .png()
      .toBuffer();
    await fs.writeFile(path.join(outputDir, tile.crop), crop);

    if (tile.visibleCrop && tile.coveredBy?.length) {
      const visibleCrop = await sharp(crop)
        .composite([{ input: visibleCropSvg(tile.box, tile.coveredBy), left: 0, top: 0 }])
        .png()
        .toBuffer();
      await fs.writeFile(path.join(outputDir, tile.visibleCrop), visibleCrop);
      const visibleIndex = visibleComposites.length / 2;
      const visibleX = (visibleIndex % CONTACT_COLUMNS) * CONTACT_CELL_WIDTH;
      const visibleY = Math.floor(visibleIndex / CONTACT_COLUMNS) * CONTACT_CELL_HEIGHT;
      visibleComposites.push({
        input: visibleCrop,
        left: visibleX + Math.floor((CONTACT_CELL_WIDTH - tile.box.width) / 2),
        top: visibleY + 8,
      });
      visibleComposites.push({
        input: labelSvg(`${tile.id}  visible-only`),
        left: visibleX,
        top: visibleY + 152,
      });
    }

    const index = composites.length / 2;
    const x = (index % CONTACT_COLUMNS) * CONTACT_CELL_WIDTH;
    const y = Math.floor(index / CONTACT_COLUMNS) * CONTACT_CELL_HEIGHT;
    composites.push({
      input: crop,
      left: x + Math.floor((CONTACT_CELL_WIDTH - tile.box.width) / 2),
      top: y + 8,
    });
    composites.push({
      input: labelSvg(`${tile.id}  ${tile.detectedType}`),
      left: x,
      top: y + 152,
    });
  }

  const rows = Math.max(1, Math.ceil(manifest.tiles.length / CONTACT_COLUMNS));
  await sharp({
    create: {
      width: CONTACT_COLUMNS * CONTACT_CELL_WIDTH,
      height: rows * CONTACT_CELL_HEIGHT,
      channels: 3,
      background: '#0c1118',
    },
  })
    .composite(composites)
    .png()
    .toFile(path.join(outputDir, 'contact-sheet.png'));

  if (visibleTiles.length) {
    const visibleRows = Math.max(1, Math.ceil(visibleTiles.length / CONTACT_COLUMNS));
    await sharp({
      create: {
        width: CONTACT_COLUMNS * CONTACT_CELL_WIDTH,
        height: visibleRows * CONTACT_CELL_HEIGHT,
        channels: 3,
        background: '#0c1118',
      },
    })
      .composite(visibleComposites)
      .png()
      .toFile(path.join(outputDir, 'visible-contact-sheet.png'));
  }

  await fs.writeFile(
    path.join(outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(outputDir, 'layer-graph-validation.json'),
    `${JSON.stringify(manifest.layerGraphValidation, null, 2)}\n`,
  );
  return { outputDir, manifest, screenPath };
}

module.exports = {
  DEFAULT_CROP_SIZE,
  buildVisionManifest,
  validateLayerGraph,
  cropBox,
  applyVisionLabels,
  writeVisionPacket,
  loadVisionLabels,
};
