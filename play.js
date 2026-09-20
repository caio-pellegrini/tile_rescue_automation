const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const {
  summarize,
  chooseAction,
} = require('./agent');
const {
  applyVisionLabels,
  validateLayerGraph,
  writeVisionPacket,
} = require('./vision');
const { createClassifier } = require('./local_ml');

const DEFAULT_DEVICE = process.env.DEVICE || 'RQCY903RJQN';
const DEFAULT_LEVEL = process.env.LEVEL || '23';
const DEFAULT_SETTLE_MS = Number(process.env.SETTLE_MS || 1200);
const DEFAULT_MAX_MOVES = Number(process.env.MAX_MOVES || 1);

function usage() {
  console.log(`Tile Rescue runner

Uso:
  node play.js [--dry-run] [--live] [--moves N]
              [--device SERIAL] [--level N] [--run-dir PATH]
              [--settle-ms N] [--no-ml]

O padrão é dry-run: captura, classifica e recomenda sem tocar no celular.
`);
}

function parseArgs(argv) {
  const options = {
    live: false,
    maxMoves: DEFAULT_MAX_MOVES,
    device: DEFAULT_DEVICE,
    level: DEFAULT_LEVEL,
    settleMs: DEFAULT_SETTLE_MS,
    runDir: null,
    useMl: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--live') {
      options.live = true;
    } else if (arg === '--dry-run') {
      options.live = false;
    } else if (arg === '--no-ml') {
      options.useMl = false;
    } else if (arg === '--moves') {
      options.maxMoves = Number(argv[++i]);
    } else if (arg === '--device') {
      options.device = argv[++i];
    } else if (arg === '--level') {
      options.level = argv[++i];
    } else if (arg === '--run-dir') {
      options.runDir = argv[++i];
    } else if (arg === '--settle-ms') {
      options.settleMs = Number(argv[++i]);
    } else {
      throw new Error(`argumento desconhecido: ${arg}`);
    }
  }
  if (!Number.isInteger(options.maxMoves) || options.maxMoves < 1) {
    throw new Error('--moves precisa ser um inteiro positivo');
  }
  if (!Number.isFinite(options.settleMs) || options.settleMs < 0) {
    throw new Error('--settle-ms precisa ser um número não negativo');
  }
  return options;
}

function adb(device, args) {
  return execFileSync('adb', ['-s', device, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function capture(device) {
  const png = adb(device, ['exec-out', 'screencap', '-p']);
  return sharp(png).raw().toBuffer({ resolveWithObject: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function tileForLog(tile) {
  if (!tile) return null;
  return {
    type: tile.type || 'unknown',
    groupId: tile.groupId || null,
    sessionGroupId: tile.sessionGroupId || null,
    planningKey: tile.planningKey || null,
    modelLabel: tile.modelLabel || null,
    modelGroupId: tile.modelGroupId || null,
    modelConflict: tile.modelConflict || null,
    x: tile.cx,
    y: tile.cy,
    confidence: tile.modelConfidence ?? tile.confidence ?? null,
    source: tile.typeSource || null,
  };
}

function screenLooksLikeTileRescue(image) {
  if (!image?.data || !image.info?.width || !image.info?.height) return false;
  const { data, info } = image;
  const channels = info.channels;
  const points = [0.2, 0.5, 0.8].map(ratio => [
    Math.floor(info.width * ratio),
    Math.floor(info.height * 0.13),
  ]);
  const tealPoints = points.filter(([x, y]) => {
    const offset = (y * info.width + x) * channels;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    return green - red >= 45 && green - blue >= 10 && green >= 100;
  });
  return tealPoints.length >= 2;
}

function buildPhaseMap(state) {
  const groups = new Map();
  const add = (tile, role) => {
    const planningKey = tile.planningKey || (
      tile.type && tile.type !== 'unknown' ? tile.type : null
    );
    const sessionGroupId = tile.sessionGroupId || tile.groupId || null;
    const key = planningKey || (sessionGroupId
      ? `group:${sessionGroupId}`
      : `unmapped:${role}:${tile.cx},${tile.cy}`);
    if (!groups.has(key)) {
      groups.set(key, {
        planningKey,
        sessionGroupId,
        type: tile.type && tile.type !== 'unknown' ? tile.type : 'unknown',
        typeSource: tile.typeSource || null,
        members: [],
        counts: { available: 0, tray: 0, hidden: 0 },
        confidences: [],
      });
    }
    const group = groups.get(key);
    group.members.push({
      role,
      x: tile.cx,
      y: tile.cy,
      type: tile.type || 'unknown',
      typeSource: tile.typeSource || null,
      confidence: tile.modelConfidence ?? tile.confidence ?? null,
    });
    group.counts[role]++;
    const confidence = tile.modelConfidence ?? tile.confidence;
    if (Number.isFinite(confidence)) group.confidences.push(confidence);
  };

  for (const tile of state.available || []) add(tile, 'available');
  for (const tile of state.tray || []) add(tile, 'tray');
  for (const tile of state.layerGraph?.hidden || []) add(tile, 'hidden');

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    screen: state.screen,
    groups: [...groups.values()].map(group => ({
      ...group,
      evidence: {
        playableCount: group.counts.available + group.counts.tray,
        strongEnoughForUnknownTriple: group.type !== 'unknown' ||
          group.counts.available + group.counts.tray >= 3,
        meanConfidence: group.confidences.length
          ? Number((group.confidences.reduce((sum, value) => sum + value, 0) / group.confidences.length).toFixed(4))
          : null,
      },
    })),
  };
}

function stateForLog(state) {
  return {
    tray: (state.tray || []).map(tileForLog),
    available: (state.available || []).map(tileForLog),
    hidden: (state.layerGraph?.hidden || []).map(tileForLog),
    trayCounts: state.trayCounts,
    visibleCounts: state.visibleCounts,
    graph: {
      nodes: state.layerGraph?.nodes?.length || 0,
      edges: state.layerGraph?.edges?.length || 0,
      validation: validateLayerGraph(state.layerGraph || {}),
    },
    safety: state.safety,
  };
}

async function analyze(image, options, clusters, classifier, packetDir) {
  const components = require('./agent').connectedComponents(image);
  const state = summarize(image, components, clusters);

  // First write the packet so the local model can consume its crops. It is
  // rewritten after labels are applied, leaving the audit manifest readable.
  await writeVisionPacket(image, state, packetDir);
  let ml = null;
  if (classifier) {
    ml = await classifier.classifyPacket(packetDir);
    await writeJson(path.join(packetDir, 'local-predictions.json'), ml);
    applyVisionLabels(state, ml.predictions, 0.75);
    await writeVisionPacket(image, state, packetDir);
  }

  const action = chooseAction(state);
  await writeJson(path.join(packetDir, 'phase-map.json'), buildPhaseMap(state));
  const analysis = {
    capturedAt: new Date().toISOString(),
    screenReady: screenLooksLikeTileRescue(image),
    state,
    action,
    stateSummary: stateForLog(state),
    mlSummary: ml ? {
      model: ml.model,
      threshold: ml.threshold,
      referenceCount: ml.referenceCount,
      tileCount: ml.tileCount,
      inferenceMs: ml.inferenceMs,
    } : null,
  };
  await writeJson(path.join(packetDir, 'analysis.json'), analysis);
  return analysis;
}

async function savePhase(image, analysis, phaseDir, phase, options) {
  await fs.mkdir(phaseDir, { recursive: true });
  await sharp(image.data, { raw: image.info }).png().toFile(path.join(phaseDir, `${phase}.png`));
  await writeJson(path.join(phaseDir, `${phase}.json`), {
    phase,
    capturedAt: analysis.capturedAt,
    device: options.device,
    level: options.level,
    state: analysis.state,
    action: analysis.action,
    screenReady: analysis.screenReady,
    stateSummary: analysis.stateSummary,
  });
}

function consoleSummary(move, options, analysis) {
  const action = analysis.action || {};
  const tile = tileForLog(action.tile);
  return {
    move,
    mode: options.live ? 'live' : 'dry-run',
    recommendation: action.reason || 'no-action',
    target: action.targetType || action.targetGroupId || null,
    tile,
    tray: analysis.stateSummary.tray,
    available: analysis.stateSummary.available,
    hidden: analysis.stateSummary.hidden,
    ml: analysis.mlSummary ? {
      model: analysis.mlSummary.model,
      references: analysis.mlSummary.referenceCount,
      inferenceMs: analysis.mlSummary.inferenceMs,
    } : null,
  };
}

function detectTerminalStatus(analysis) {
  const state = analysis?.state || {};
  const available = state.available || [];
  const hidden = state.layerGraph?.hidden || [];
  const tray = state.tray || [];
  const detected = state.detected || [];
  const screenReady = analysis.screenReady !== false;
  if (screenReady && !available.length && !hidden.length && !tray.length && !detected.length) {
    return {
      terminal: true,
      completed: true,
      completionReason: 'empty-board',
      stopReason: null,
    };
  }
  if (analysis?.action?.reason === 'safety-stop') {
    return {
      terminal: true,
      completed: false,
      completionReason: null,
      stopReason: 'safety-stop',
    };
  }
  return {
    terminal: false,
    completed: false,
    completionReason: null,
    stopReason: null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const runDir = path.resolve(options.runDir || path.join(
    '/tmp',
    'tile-rescue-runs',
    `level-${options.level}`,
    timestamp(),
  ));
  await fs.mkdir(runDir, { recursive: true });
  const run = {
    startedAt: new Date().toISOString(),
    device: options.device,
    level: options.level,
    live: options.live,
    maxMoves: options.maxMoves,
    settleMs: options.settleMs,
    mlEnabled: options.useMl,
    runDir,
    executedMoves: 0,
    completed: false,
    completionReason: null,
    stopReason: null,
  };
  await writeJson(path.join(runDir, 'run.json'), run);

  // The expensive local model is loaded once here and reused for every
  // observation in the run. This is the main performance benefit over the
  // old one-off command sequence.
  const classifier = options.useMl ? await createClassifier({}) : null;
  if (classifier) {
    run.ml = {
      model: classifier.model,
      threshold: classifier.threshold,
      libraryDir: classifier.libraryDir,
      referenceCount: classifier.referenceCount,
    };
  }
  await writeJson(path.join(runDir, 'run.json'), run);

  const clusters = [];
  let image = await capture(options.device);
  for (let move = 0; move < options.maxMoves; move++) {
    const phaseDir = path.join(runDir, `move-${String(move).padStart(3, '0')}-before`);
    const packetDir = path.join(phaseDir, 'vision');
    const analysis = await analyze(image, options, clusters, classifier, packetDir);
    await savePhase(image, analysis, phaseDir, 'before', options);
    console.log(JSON.stringify(consoleSummary(move, options, analysis)));

    const terminal = detectTerminalStatus(analysis);
    if (terminal.completed) {
      run.completed = true;
      run.completionReason = terminal.completionReason;
      break;
    }
    if (terminal.stopReason) {
      run.stopReason = terminal.stopReason;
      break;
    }
    if (!options.live) break;
    if (!analysis.action?.tile) {
      run.stopReason = 'no-action';
      break;
    }

    adb(options.device, [
      'shell',
      'input',
      'tap',
      String(Math.round(analysis.action.tile.cx)),
      String(Math.round(analysis.action.tile.cy)),
    ]);
    run.executedMoves++;
    await sleep(options.settleMs);

    image = await capture(options.device);
    const afterDir = path.join(runDir, `move-${String(move).padStart(3, '0')}-after`);
    await fs.mkdir(afterDir, { recursive: true });
    await sharp(image.data, { raw: image.info }).png().toFile(path.join(afterDir, 'after.png'));
    await writeJson(path.join(afterDir, 'after.json'), {
      phase: 'after',
      capturedAt: new Date().toISOString(),
      device: options.device,
      level: options.level,
      source: 'post-tap observation; analyzed as the next before frame',
    });

    // Detect an empty board immediately after the tap, before loading the
    // classifier for another full analysis. This is the authoritative
    // completion signal for a cleared level.
    const postTapState = summarize(
      image,
      require('./agent').connectedComponents(image),
      clusters,
    );
    const postTapTerminal = detectTerminalStatus({
      state: postTapState,
      screenReady: screenLooksLikeTileRescue(image),
    });
    if (postTapTerminal.completed) {
      run.completed = true;
      run.completionReason = postTapTerminal.completionReason;
      await writeJson(path.join(afterDir, 'after.json'), {
        phase: 'after',
        capturedAt: new Date().toISOString(),
        device: options.device,
        level: options.level,
        source: 'post-tap observation; analyzed as the next before frame',
        completed: true,
        completionReason: postTapTerminal.completionReason,
      });
      break;
    }
  }

  run.finishedAt = new Date().toISOString();
  await writeJson(path.join(runDir, 'run.json'), run);
  console.error(`run saved: ${runDir}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = {
  buildPhaseMap,
  detectTerminalStatus,
  parseArgs,
  stateForLog,
  tileForLog,
};
