const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
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
const RAW_RGBA_8888_PIXEL_FORMAT = 1;

function usage() {
  console.log(`Tile Rescue runner

Uso:
  node play.js [--dry-run] [--live] [--moves N]
              [--device SERIAL] [--level N] [--run-dir PATH]
              [--settle-ms N] [--no-ml] [--fast] [--live-fast]
              [--replay-dir PATH] [--raw-capture]

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
    replayDir: null,
    fast: false,
    rawCapture: false,
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
    } else if (arg === '--fast') {
      options.fast = true;
    } else if (arg === '--live-fast') {
      options.live = true;
      options.fast = true;
    } else if (arg === '--raw-capture') {
      options.rawCapture = true;
    } else if (arg === '--moves') {
      options.maxMoves = Number(argv[++i]);
    } else if (arg === '--device') {
      options.device = argv[++i];
    } else if (arg === '--level') {
      options.level = argv[++i];
    } else if (arg === '--run-dir') {
      options.runDir = argv[++i];
    } else if (arg === '--replay-dir') {
      options.replayDir = argv[++i];
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
  if (options.live && options.replayDir) {
    throw new Error('--replay-dir só pode ser usado em dry-run');
  }
  return options;
}

function recordTiming(timing, key, startedAt) {
  if (!timing) return;
  const elapsed = performance.now() - startedAt;
  timing[key] = Number(((timing[key] || 0) + elapsed).toFixed(3));
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

function parseRawScreencap(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 16) {
    throw new Error(`screencap bruto inválido: cabeçalho ausente (${raw?.length || 0} bytes)`);
  }
  const width = raw.readUInt32LE(0);
  const height = raw.readUInt32LE(4);
  const pixelFormat = raw.readUInt32LE(8);
  const dataSpace = raw.readUInt32LE(12);
  if (pixelFormat !== RAW_RGBA_8888_PIXEL_FORMAT) {
    throw new Error(
      `screencap bruto não suportado: pixel format ${pixelFormat}; `
      + `esperado RGBA_8888 (${RAW_RGBA_8888_PIXEL_FORMAT})`,
    );
  }
  const payloadBytes = width * height * 4;
  if (!width || !height || !Number.isSafeInteger(payloadBytes) || raw.length !== 16 + payloadBytes) {
    throw new Error(
      `screencap bruto não suportado: ${width}x${height}, ${raw.length} bytes; `
      + `esperado ${16 + payloadBytes}`,
    );
  }
  return {
    data: raw.subarray(16),
    info: { width, height, channels: 4 },
    header: { pixelFormat, dataSpace },
  };
}

async function capture(device, timing = null, rawCapture = false) {
  const startedAt = performance.now();
  const adbStartedAt = performance.now();
  const bytes = adb(device, rawCapture
    ? ['exec-out', 'screencap']
    : ['exec-out', 'screencap', '-p']);
  recordTiming(timing, 'adbMs', adbStartedAt);
  const decodeStartedAt = performance.now();
  let image;
  if (rawCapture) {
    image = parseRawScreencap(bytes);
    if (timing) {
      timing.format = 'raw-rgba';
      timing.rawHeader = image.header;
    }
    recordTiming(timing, 'rawParseMs', decodeStartedAt);
  } else {
    image = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    if (timing) timing.format = 'png';
    recordTiming(timing, 'decodeMs', decodeStartedAt);
  }
  recordTiming(timing, 'totalMs', startedAt);
  return image;
}

async function loadReplayImage(filePath, timing = null) {
  const startedAt = performance.now();
  const png = await fs.readFile(filePath);
  recordTiming(timing, 'fileReadMs', startedAt);
  const decodeStartedAt = performance.now();
  const image = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  recordTiming(timing, 'decodeMs', decodeStartedAt);
  recordTiming(timing, 'totalMs', startedAt);
  return image;
}

async function replayFramePaths(replayDir, maxMoves) {
  const paths = [];
  for (let move = 0; move < maxMoves; move++) {
    const filePath = path.join(replayDir, `move-${String(move).padStart(3, '0')}-before`, 'before.png');
    try {
      await fs.access(filePath);
    } catch {
      break;
    }
    paths.push(filePath);
  }
  if (!paths.length) throw new Error(`nenhuma captura before encontrada em ${replayDir}`);
  return paths;
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

async function analyze(image, options, clusters, classifier, packetDir, timing = {}) {
  timing.startedAt = new Date().toISOString();
  const analysisStartedAt = performance.now();
  timing.stages ||= {};
  timing.artifacts ||= {};
  timing.ml ||= {};
  const geometryStartedAt = performance.now();
  const components = require('./agent').connectedComponents(image);
  recordTiming(timing.stages, 'connectedComponentsMs', geometryStartedAt);
  const state = summarize(image, components, clusters, timing.stages);

  // First write the packet so the local model can consume its crops. It is
  // rewritten after labels are applied, leaving the audit manifest readable.
  const packetOptions = options.fast
    ? { audit: false, includeVisibleCrops: false }
    : { audit: true, includeVisibleCrops: true };
  await writeVisionPacket(image, state, packetDir, timing.artifacts, packetOptions);
  let ml = null;
  if (classifier) {
    ml = await classifier.classifyPacket(packetDir, timing.ml, {
      classifyHidden: !options.fast,
    });
    timing.ml = ml.timing || timing.ml;
    const predictionWriteStartedAt = performance.now();
    await writeJson(path.join(packetDir, 'local-predictions.json'), ml);
    recordTiming(timing.artifacts, 'jsonWriteMs', predictionWriteStartedAt);
    const applyLabelsStartedAt = performance.now();
    applyVisionLabels(state, ml.predictions, 0.75);
    recordTiming(timing.stages, 'applyLabelsMs', applyLabelsStartedAt);
    await writeVisionPacket(image, state, packetDir, timing.artifacts, packetOptions);
  }

  const chooseActionStartedAt = performance.now();
  const action = chooseAction(state);
  recordTiming(timing.stages, 'chooseActionMs', chooseActionStartedAt);
  const phaseMapStartedAt = performance.now();
  await writeJson(path.join(packetDir, 'phase-map.json'), buildPhaseMap(state));
  recordTiming(timing.artifacts, 'jsonWriteMs', phaseMapStartedAt);
  const analysisStartedAtForWrite = performance.now();
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
      timing: ml.timing || null,
    } : null,
    timing,
  };
  await writeJson(path.join(packetDir, 'analysis.json'), analysis);
  recordTiming(timing.artifacts, 'jsonWriteMs', analysisStartedAtForWrite);
  recordTiming(timing.stages, 'analysisMs', analysisStartedAt);
  return analysis;
}

async function savePhase(image, analysis, phaseDir, phase, options, timing = null) {
  const startedAt = performance.now();
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
    timing: analysis.timing || timing,
  });
  recordTiming(timing?.artifacts, 'phaseWriteMs', startedAt);
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
    fast: options.fast,
    rawCapture: options.rawCapture,
    maxMoves: options.maxMoves,
    settleMs: options.settleMs,
    mlEnabled: options.useMl,
    replayDir: options.replayDir,
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
  const modelLoadStartedAt = performance.now();
  const classifier = options.useMl ? await createClassifier({}) : null;
  run.modelLoadMs = Number((performance.now() - modelLoadStartedAt).toFixed(3));
  if (classifier) {
    run.ml = {
      model: classifier.model,
      threshold: classifier.threshold,
      libraryDir: classifier.libraryDir,
      referenceCount: classifier.referenceCount,
    };
  }
  await writeJson(path.join(runDir, 'run.json'), run);

  const replayPaths = options.replayDir
    ? await replayFramePaths(path.resolve(options.replayDir), options.maxMoves)
    : null;
  const clusters = [];
  let firstCaptureTiming = {};
  let previousAfterDir = null;
  let image = replayPaths
    ? await loadReplayImage(replayPaths[0], firstCaptureTiming)
    : await capture(options.device, firstCaptureTiming, options.rawCapture);
  for (let move = 0; move < options.maxMoves; move++) {
    const moveStartedAt = performance.now();
    const timing = {
      schemaVersion: 1,
      move,
      capture: firstCaptureTiming,
      stages: {},
      ml: {},
      artifacts: {},
      io: {},
    };
    const phaseDir = path.join(runDir, `move-${String(move).padStart(3, '0')}-before`);
    const packetDir = path.join(phaseDir, 'vision');
    const analysis = await analyze(image, options, clusters, classifier, packetDir, timing);
    await savePhase(image, analysis, phaseDir, 'before', options, timing);
    console.log(JSON.stringify(consoleSummary(move, options, analysis)));

    const terminal = detectTerminalStatus(analysis);
    if (terminal.completed) {
      run.completed = true;
      run.completionReason = terminal.completionReason;
      if (previousAfterDir) {
        const previousAfterPath = path.join(previousAfterDir, 'after.json');
        try {
          const previousAfter = JSON.parse(await fs.readFile(previousAfterPath, 'utf8'));
          await writeJson(previousAfterPath, {
            ...previousAfter,
            completed: true,
            completionReason: terminal.completionReason,
            completionDetectedOn: 'next-analysis',
          });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      timing.finishedAt = new Date().toISOString();
      timing.totalMoveMs = Number((performance.now() - moveStartedAt).toFixed(3));
      await writeJson(path.join(phaseDir, 'timing.json'), timing);
      break;
    }
    if (terminal.stopReason) {
      run.stopReason = terminal.stopReason;
      timing.finishedAt = new Date().toISOString();
      timing.totalMoveMs = Number((performance.now() - moveStartedAt).toFixed(3));
      await writeJson(path.join(phaseDir, 'timing.json'), timing);
      break;
    }
    if (!options.live && !replayPaths) {
      timing.finishedAt = new Date().toISOString();
      timing.totalMoveMs = Number((performance.now() - moveStartedAt).toFixed(3));
      await writeJson(path.join(phaseDir, 'timing.json'), timing);
      break;
    }
    if (!analysis.action?.tile) {
      run.stopReason = 'no-action';
      timing.finishedAt = new Date().toISOString();
      timing.totalMoveMs = Number((performance.now() - moveStartedAt).toFixed(3));
      await writeJson(path.join(phaseDir, 'timing.json'), timing);
      break;
    }

    if (replayPaths) {
      const nextPath = replayPaths[move + 1];
      if (!nextPath) {
        timing.finishedAt = new Date().toISOString();
        timing.totalMoveMs = Number((performance.now() - moveStartedAt).toFixed(3));
        await writeJson(path.join(phaseDir, 'timing.json'), timing);
        break;
      }
      const nextCaptureTiming = {};
      const replayStartedAt = performance.now();
      image = await loadReplayImage(nextPath, nextCaptureTiming);
      recordTiming(timing.io, 'nextReplayLoadMs', replayStartedAt);
      timing.captureAfter = nextCaptureTiming;
      timing.finishedAt = new Date().toISOString();
      timing.totalMoveMs = Number((performance.now() - moveStartedAt).toFixed(3));
      await writeJson(path.join(phaseDir, 'timing.json'), timing);
      firstCaptureTiming = nextCaptureTiming;
      continue;
    }

    const tapStartedAt = performance.now();
    adb(options.device, [
      'shell',
      'input',
      'tap',
      String(Math.round(analysis.action.tile.cx)),
      String(Math.round(analysis.action.tile.cy)),
    ]);
    recordTiming(timing.io, 'tapAdbMs', tapStartedAt);
    run.executedMoves++;
    const settleStartedAt = performance.now();
    await sleep(options.settleMs);
    recordTiming(timing.io, 'settleWaitMs', settleStartedAt);

    const afterCaptureTiming = {};
    image = await capture(options.device, afterCaptureTiming, options.rawCapture);
    timing.captureAfter = afterCaptureTiming;
    const afterDir = path.join(runDir, `move-${String(move).padStart(3, '0')}-after`);
    previousAfterDir = afterDir;
    const afterWriteStartedAt = performance.now();
    await fs.mkdir(afterDir, { recursive: true });
    await sharp(image.data, { raw: image.info }).png().toFile(path.join(afterDir, 'after.png'));
    await writeJson(path.join(afterDir, 'after.json'), {
      phase: 'after',
      capturedAt: new Date().toISOString(),
      device: options.device,
      level: options.level,
      source: 'post-tap observation; analyzed as the next before frame',
      timing: afterCaptureTiming,
    });
    recordTiming(timing.artifacts, 'afterWriteMs', afterWriteStartedAt);

    // The next fast analysis consumes this same `after` image, so repeating
    // the full geometry/occlusion summary here only adds latency between
    // taps. Keep the immediate completion check for the final allowed move;
    // otherwise defer it to the next analysis, before another tap can occur.
    const checkPostTapNow = !options.fast || move + 1 >= options.maxMoves;
    if (checkPostTapNow) {
      const postTapStartedAt = performance.now();
      const postTapComponentsStartedAt = performance.now();
      const postTapComponents = require('./agent').connectedComponents(image);
      recordTiming(timing.io, 'postTapConnectedComponentsMs', postTapComponentsStartedAt);
      const postTapState = summarize(
        image,
        postTapComponents,
        clusters,
        timing.io,
      );
      recordTiming(timing.io, 'postTapSummaryMs', postTapStartedAt);
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
          timing,
        });
        timing.finishedAt = new Date().toISOString();
        timing.totalMoveMs = Number((performance.now() - moveStartedAt).toFixed(3));
        await writeJson(path.join(phaseDir, 'timing.json'), timing);
        break;
      }
    } else {
      timing.io.postTapCheck = 'deferred-to-next-analysis';
    }

    timing.finishedAt = new Date().toISOString();
    timing.totalMoveMs = Number((performance.now() - moveStartedAt).toFixed(3));
    await writeJson(path.join(phaseDir, 'timing.json'), timing);
    firstCaptureTiming = afterCaptureTiming;
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
  parseRawScreencap,
  parseArgs,
  stateForLog,
  tileForLog,
};
