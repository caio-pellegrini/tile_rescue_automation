const assert = require('node:assert/strict');
const { semanticType, chooseAction } = require('./agent');
const { applyVisionLabels, buildVisionManifest, cropBox, validateLayerGraph } = require('./vision');
const { groupEmbeddings, loadCatalog } = require('./local_ml');
const { buildPhaseMap, detectTerminalStatus, parseArgs, parseRawScreencap } = require('./play');

(async () => {
  assert.deepEqual(parseArgs([]), {
    live: false,
    maxMoves: 1,
    device: 'RQCY903RJQN',
    level: '23',
    settleMs: 1200,
    runDir: null,
    replayDir: null,
    fast: false,
    rawCapture: false,
    useMl: true,
  });
  assert.deepEqual(parseArgs(['--live', '--moves', '3', '--no-ml', '--settle-ms', '700']), {
    live: true,
    maxMoves: 3,
    device: 'RQCY903RJQN',
    level: '23',
    settleMs: 700,
    runDir: null,
    replayDir: null,
    fast: false,
    rawCapture: false,
    useMl: false,
  });
  assert.deepEqual(parseArgs(['--fast', '--moves', '3', '--replay-dir', '/tmp/replay']), {
    live: false,
    maxMoves: 3,
    device: 'RQCY903RJQN',
    level: '23',
    settleMs: 1200,
    runDir: null,
    replayDir: '/tmp/replay',
    fast: true,
    rawCapture: false,
    useMl: true,
  });
  assert.deepEqual(parseArgs(['--raw-capture']), {
    live: false,
    maxMoves: 1,
    device: 'RQCY903RJQN',
    level: '23',
    settleMs: 1200,
    runDir: null,
    replayDir: null,
    fast: false,
    rawCapture: true,
    useMl: true,
  });
  const rawWidth = 2;
  const rawHeight = 1;
  const raw = Buffer.alloc(16 + rawWidth * rawHeight * 4);
  raw.writeUInt32LE(rawWidth, 0);
  raw.writeUInt32LE(rawHeight, 4);
  raw.writeUInt32LE(1, 8);
  raw[16] = 11;
  raw[17] = 22;
  raw[18] = 33;
  raw[19] = 255;
  assert.deepEqual(parseRawScreencap(raw), {
    data: raw.subarray(16),
    info: { width: 2, height: 1, channels: 4 },
    header: { pixelFormat: 1, dataSpace: 0 },
  });
  assert.throws(() => parseRawScreencap(Buffer.alloc(16)), /não suportado/);
  const truncatedRaw = Buffer.alloc(16);
  truncatedRaw.writeUInt32LE(rawWidth, 0);
  truncatedRaw.writeUInt32LE(rawHeight, 4);
  truncatedRaw.writeUInt32LE(1, 8);
  assert.throws(() => parseRawScreencap(truncatedRaw), /esperado 24/);
  const unsupportedRaw = Buffer.from(raw);
  unsupportedRaw.writeUInt32LE(2, 8);
  assert.throws(() => parseRawScreencap(unsupportedRaw), /pixel format 2/);
  assert.deepEqual(detectTerminalStatus({
    state: { available: [], tray: [], layerGraph: { hidden: [] } },
    action: { reason: 'no-action', tile: null },
  }), {
    terminal: true,
    completed: true,
    completionReason: 'empty-board',
    stopReason: null,
  });
  assert.deepEqual(detectTerminalStatus({
    state: { available: [{ type: 'pepper' }], tray: [], layerGraph: { hidden: [] } },
    action: { reason: 'safety-stop', tile: null },
  }), {
    terminal: true,
    completed: false,
    completionReason: null,
    stopReason: 'safety-stop',
  });
  assert.equal(detectTerminalStatus({
    state: { available: [{ type: 'pepper' }], tray: [], layerGraph: { hidden: [] } },
    action: { reason: 'reveal-most-promising', tile: { cx: 1, cy: 1 } },
  }).terminal, false);
  assert.equal(detectTerminalStatus({
    screenReady: false,
    state: { available: [], tray: [], layerGraph: { hidden: [] } },
    action: { reason: 'no-action', tile: null },
  }).terminal, false);
  assert.equal(detectTerminalStatus({
    screenReady: true,
    state: {
      detected: [{ cx: 540, cy: 1367, type: 'unknown' }],
      available: [],
      tray: [],
      layerGraph: { hidden: [] },
    },
    action: { reason: 'no-action', tile: null },
  }).terminal, false);

  const preservedState = {
    detected: [{ cx: 100, cy: 700, type: 'sun', typeSource: 'legacy-semantic' }],
    available: [{ cx: 100, cy: 700, type: 'sun', typeSource: 'legacy-semantic' }],
    tray: [],
    trayCounts: {},
    visibleCounts: { sun: 1 },
    occlusionGraph: { hidden: [] },
  };
  const preservedResult = applyVisionLabels(preservedState, [{
    id: 'board-0-100-700', label: 'unknown', groupId: 'unlabeled-group-1', confidence: 0.99,
  }]);
  assert.equal(preservedResult.applied, 0);
  assert.equal(preservedState.available[0].type, 'sun');

  const groupedState = {
    detected: [
      { cx: 100, cy: 700, type: 'unknown' },
      { cx: 200, cy: 700, type: 'unknown' },
      { cx: 300, cy: 700, type: 'unknown' },
      { cx: 400, cy: 700, type: 'unknown' },
    ],
    available: [
      { cx: 100, cy: 700, type: 'unknown' },
      { cx: 200, cy: 700, type: 'unknown' },
      { cx: 300, cy: 700, type: 'unknown' },
      { cx: 400, cy: 700, type: 'unknown' },
    ],
    tray: [],
    trayCounts: {},
    visibleCounts: {},
    occlusionGraph: { hidden: [] },
  };
  const groupedPredictions = [100, 200, 300, 400].map((cx, index) => ({
    id: `board-${index}-${cx}-700`,
    label: 'unknown',
    groupId: 'unlabeled-group-1',
    confidence: 0.82 + index * 0.005,
  }));
  const groupedResult = applyVisionLabels(groupedState, groupedPredictions);
  assert.equal(groupedResult.groupApplied, 4);
  assert.ok(groupedState.available.every(tile => tile.planningKey === 'group:unlabeled-group-1'));
  const phaseMap = buildPhaseMap(groupedState);
  assert.equal(phaseMap.groups.length, 1);
  assert.equal(phaseMap.groups[0].evidence.strongEnoughForUnknownTriple, true);

  const conflictState = {
    detected: [{ cx: 500, cy: 700, type: 'cupcake', groupId: 'cupcake', typeSource: 'legacy-semantic' }],
    available: [{ cx: 500, cy: 700, type: 'cupcake', groupId: 'cupcake', typeSource: 'legacy-semantic' }],
    tray: [],
    trayCounts: {},
    visibleCounts: { cupcake: 1 },
    occlusionGraph: { hidden: [] },
  };
  applyVisionLabels(conflictState, [{
    id: 'board-0-500-700', label: 'cake', referenceLabel: 'cake',
    groupId: 'cake', confidence: 0.92,
  }]);
  assert.equal(conflictState.available[0].type, 'cupcake');
  assert.equal(conflictState.available[0].typeSource, 'legacy-semantic-preserved');
  assert.equal(conflictState.available[0].modelConflict.modelLabel, 'cake');

  // Replay of /tmp/tile-rescue-dry-run-20260920: the four brown cards were
  // one strong visual group even though the catalog returned unknown/cake
  // below the 0.88 named-reference threshold. The planner must use that
  // temporary identity for the triple opportunity.
  const puddingGroup = 'unlabeled-group-1';
  const puddingDryRun = chooseAction({
    trayCounts: {},
    available: [
      ...[539, 682, 326, 540].map((cx, index) => ({
        type: 'unknown',
        groupId: puddingGroup,
        sessionGroupId: puddingGroup,
        planningKey: `group:${puddingGroup}`,
        cx,
        cy: index < 2 ? 715 : 1177,
      })),
      { type: 'sun', groupId: 'sun', sessionGroupId: 'sun', planningKey: 'sun', cx: 390, cy: 720 },
      { type: 'sun', groupId: 'sun', sessionGroupId: 'sun', planningKey: 'sun', cx: 754, cy: 1177 },
    ],
    detected: [],
    visibleCounts: { [`group:${puddingGroup}`]: 4, sun: 2 },
    safety: { liveAllowed: true },
  });
  assert.equal(puddingDryRun.reason, 'start-exposed-triple');
  assert.equal(puddingDryRun.targetGroupId, puddingGroup);
  assert.equal(puddingDryRun.availableCount, 4);

  const blockedUnknown = chooseAction({
    trayCounts: { [`group:${puddingGroup}`]: 2 },
    available: [{ type: 'sun', planningKey: 'sun', cx: 100, cy: 700 }],
    detected: [],
    visibleCounts: { sun: 1 },
    safety: { liveAllowed: true },
  });
  assert.equal(blockedUnknown.reason, 'safety-stop');
  assert.equal(blockedUnknown.tile, null);

  const hiddenCupcakeState = {
    detected: [
      { cx: 100, cy: 700, type: 'cupcake', typeSource: 'legacy-semantic' },
      { cx: 200, cy: 700, type: 'cupcake', typeSource: 'legacy-semantic' },
      { cx: 300, cy: 700, type: 'cake', typeSource: 'legacy-semantic' },
      { cx: 400, cy: 700, type: 'cake', typeSource: 'legacy-semantic' },
    ],
    available: [
      { cx: 100, cy: 700, type: 'cupcake', typeSource: 'legacy-semantic' },
      { cx: 200, cy: 700, type: 'cupcake', typeSource: 'legacy-semantic' },
      { cx: 300, cy: 700, type: 'cake', typeSource: 'legacy-semantic' },
      { cx: 400, cy: 700, type: 'cake', typeSource: 'legacy-semantic' },
    ],
    tray: [],
    trayCounts: {},
    visibleCounts: { cupcake: 2, cake: 2 },
    layerGraph: {
      hidden: [{ cx: 100, cy: 600, type: 'unknown' }],
      edges: [{
        cover: { cx: 100, cy: 700 },
        target: { cx: 100, cy: 600, type: 'unknown' },
        overlap: 0.5,
        confidence: 0.99,
      }],
    },
    occlusionGraph: { hidden: [], edges: [] },
    safety: { liveAllowed: true },
  };
  applyVisionLabels(hiddenCupcakeState, [{
    id: 'hidden-0-100-600', label: 'cupcake', referenceLabel: 'cupcake',
    groupId: 'cupcake', confidence: 0.8806,
  }]);
  assert.equal(hiddenCupcakeState.layerGraph.edges[0].target.type, 'cupcake');
  const hiddenCupcakeAction = chooseAction(hiddenCupcakeState);
  assert.equal(hiddenCupcakeAction.targetType, 'cupcake');
  assert.equal(hiddenCupcakeAction.tile.type, 'cupcake');
  assert.equal(hiddenCupcakeAction.releaseScore.matchedTargetCount, 1);

  const exposedTripleBeatsExploration = chooseAction({
    trayCounts: { sun: 2 },
    available: [
      { type: 'cupcake', groupId: 'cupcake', sessionGroupId: 'cupcake', cx: 100, cy: 700 },
      { type: 'cupcake', groupId: 'cupcake', sessionGroupId: 'cupcake', cx: 200, cy: 700 },
      { type: 'cupcake', groupId: 'cupcake', sessionGroupId: 'cupcake', cx: 300, cy: 700 },
      { type: 'pepper', groupId: 'pepper', sessionGroupId: 'pepper', cx: 400, cy: 700 },
    ],
    detected: [],
    visibleCounts: { cupcake: 3, pepper: 1 },
    layerGraph: { edges: [] },
    occlusionGraph: { edges: [] },
    safety: { liveAllowed: true },
  });
  assert.equal(exposedTripleBeatsExploration.reason, 'start-exposed-triple');
  assert.equal(exposedTripleBeatsExploration.targetType, 'cupcake');
  assert.equal(exposedTripleBeatsExploration.tile.type, 'cupcake');

  // A cupcake already in the tray plus two exposed cupcakes must beat a
  // blocked sun pair and an unrelated exposed pudding triple.
  const trayTripleBeatsBlockedPair = chooseAction({
    tray: [{}, {}, {}, {}, {}],
    trayCounts: { sun: 2, pepper: 1, cupcake: 1 },
    available: [
      { type: 'cupcake', planningKey: 'cupcake', cx: 100, cy: 700 },
      { type: 'cupcake', planningKey: 'cupcake', cx: 200, cy: 700 },
      { type: 'pudding', planningKey: 'pudding', cx: 300, cy: 700 },
      { type: 'pudding', planningKey: 'pudding', cx: 400, cy: 700 },
      { type: 'pudding', planningKey: 'pudding', cx: 500, cy: 700 },
      { type: 'pepper', planningKey: 'pepper', cx: 600, cy: 700 },
    ],
    detected: [],
    visibleCounts: { cupcake: 2, pudding: 3, pepper: 1 },
    layerGraph: { edges: [] },
    occlusionGraph: { edges: [] },
    safety: { liveAllowed: true },
  });
  assert.equal(trayTripleBeatsBlockedPair.reason, 'complete-triple-potential');
  assert.equal(trayTripleBeatsBlockedPair.targetType, 'cupcake');

  // With three empty tray slots, an exposed triple beats extending a single
  // pepper pair; the triple has a guaranteed completion rather than merely a
  // possible future match.
  const exposedTripleBeatsPair = chooseAction({
    tray: [{}, {}, {}, {}],
    trayCounts: { pepper: 1 },
    available: [
      { type: 'pudding', planningKey: 'pudding', cx: 100, cy: 700 },
      { type: 'pudding', planningKey: 'pudding', cx: 200, cy: 700 },
      { type: 'pudding', planningKey: 'pudding', cx: 300, cy: 700 },
      { type: 'pepper', planningKey: 'pepper', cx: 400, cy: 700 },
    ],
    detected: [],
    visibleCounts: { pudding: 3, pepper: 1 },
    layerGraph: { edges: [] },
    occlusionGraph: { edges: [] },
    safety: { liveAllowed: true },
  });
  assert.equal(exposedTripleBeatsPair.reason, 'start-exposed-triple');
  assert.equal(exposedTripleBeatsPair.targetType, 'pudding');

  // If fewer than three slots are free, do not start the exposed triple;
  // extend the available pepper pair instead.
  const pairBeatsFullTrayTriple = chooseAction({
    tray: [{}, {}, {}, {}, {}],
    trayCounts: { sun: 2, pepper: 1 },
    available: [
      { type: 'pudding', planningKey: 'pudding', cx: 100, cy: 700 },
      { type: 'pudding', planningKey: 'pudding', cx: 200, cy: 700 },
      { type: 'pudding', planningKey: 'pudding', cx: 300, cy: 700 },
      { type: 'pepper', planningKey: 'pepper', cx: 400, cy: 700 },
    ],
    detected: [],
    visibleCounts: { pudding: 3, pepper: 1 },
    layerGraph: { edges: [] },
    occlusionGraph: { edges: [] },
    safety: { liveAllowed: true },
  });
  assert.equal(pairBeatsFullTrayTriple.reason, 'make-pair-with-tray');
  assert.equal(pairBeatsFullTrayTriple.targetType, 'pepper');

  const syntheticInfo = { width: 1080, height: 2340 };
  const syntheticOcclusionState = {
    detected: [
      { cx: 300, cy: 700, type: 'carrot' },
      { cx: 120, cy: 1740, type: 'carrot' },
    ],
    available: [{ cx: 300, cy: 700, type: 'carrot' }],
    tray: [{ cx: 120, cy: 1740, type: 'carrot' }],
    trayCounts: { carrot: 1 },
    visibleCounts: { carrot: 1 },
    safety: { liveAllowed: true },
    layerGraph: {
      hidden: [{ cx: 300, cy: 800, visibility: 0.4, type: 'carrot' }],
      edges: [{
        cover: { cx: 300, cy: 700 },
        target: { cx: 300, cy: 800, type: 'carrot' },
        overlap: 0.4,
        confidence: 0.8,
      }],
    },
  };
  let manifest = buildVisionManifest(syntheticOcclusionState, syntheticInfo);
  let occlusionImage = { info: syntheticInfo };
  let occlusionState = syntheticOcclusionState;

  const grouped = chooseAction({
    trayCounts: {},
    available: [
      { type: 'sun', cx: 100, cy: 700 },
      { type: 'sun', cx: 200, cy: 700 },
      { type: 'cupcake', cx: 300, cy: 700 },
      { type: 'cupcake', cx: 400, cy: 700 },
      { type: 'cupcake', cx: 500, cy: 700 },
    ],
    detected: [],
    visibleCounts: { sun: 2, cupcake: 3 },
    safety: { liveAllowed: true },
  });
  assert.equal(grouped.reason, 'start-exposed-triple');
  assert.equal(grouped.tile.type, 'cupcake');

  const graphTieBreak = chooseAction({
    trayCounts: {},
    available: [
      { type: 'pepper', sessionGroupId: 'pepper', groupId: 'pepper', cx: 100, cy: 700 },
      { type: 'pepper', sessionGroupId: 'pepper', groupId: 'pepper', cx: 200, cy: 700 },
      { type: 'pudding', sessionGroupId: 'pudding', groupId: 'pudding', cx: 300, cy: 700 },
      { type: 'pudding', sessionGroupId: 'pudding', groupId: 'pudding', cx: 400, cy: 700 },
    ],
    detected: [],
    visibleCounts: { pepper: 2, pudding: 2 },
    layerGraph: {
      edges: [
        { cover: { cx: 100, cy: 700 }, target: { cx: 100, cy: 600, type: 'pepper' }, overlap: 0.4, confidence: 0.9 },
        { cover: { cx: 100, cy: 700 }, target: { cx: 200, cy: 600, type: 'pepper' }, overlap: 0.3, confidence: 0.8 },
        { cover: { cx: 300, cy: 700 }, target: { cx: 300, cy: 600, type: 'pudding' }, overlap: 0.4, confidence: 0.9 },
      ],
    },
    safety: { liveAllowed: true },
  });
  assert.equal(graphTieBreak.reason, 'start-exposed-pair');
  assert.equal(graphTieBreak.targetType, 'pepper');
  assert.equal(graphTieBreak.releaseScore.matchedTargetCount, 2);
  assert.equal(graphTieBreak.releaseScore.targetCount, 2);

  const trayTriple = chooseAction({
    trayCounts: { butterfly: 1 },
    available: [
      { type: 'butterfly', cx: 100, cy: 700 },
      { type: 'butterfly', cx: 200, cy: 700 },
      { type: 'sun', cx: 300, cy: 700 },
      { type: 'sun', cx: 400, cy: 700 },
      { type: 'sun', cx: 500, cy: 700 },
    ],
    detected: [],
    visibleCounts: { butterfly: 2, sun: 3 },
    safety: { liveAllowed: true },
  });
  assert.equal(trayTriple.reason, 'complete-triple-potential');
  assert.equal(trayTriple.targetType, 'butterfly');
  assert.equal(trayTriple.tile.type, 'butterfly');

  const carrotTriple = chooseAction({
    trayCounts: {},
    available: [
      { type: 'carrot', planningKey: 'carrot', cx: 100, cy: 700 },
      { type: 'carrot', planningKey: 'carrot', cx: 200, cy: 700 },
      { type: 'carrot', planningKey: 'carrot', cx: 300, cy: 700 },
      { type: 'butterfly', planningKey: 'butterfly', cx: 400, cy: 700 },
      { type: 'butterfly', planningKey: 'butterfly', cx: 500, cy: 700 },
    ],
    detected: [],
    visibleCounts: { carrot: 3, butterfly: 2 },
    safety: { liveAllowed: true },
  });
  assert.equal(carrotTriple.reason, 'start-exposed-triple');
  assert.equal(carrotTriple.targetType, 'carrot');

  assert.equal(semanticType([0.02, 0.038, 0.847, 0.04, 0, 0, 0, 0.055, 0]), 'chick');
  assert.equal(semanticType([0.0059, 0.0867, 0.7406, 0.0964, 0.0015, 0, 0, 0.0689, 0]), 'sun');
  assert.equal(semanticType([0, 0, 0, 0, 0.2, 0, 0]), 'unknown');

  assert.ok(manifest.tiles.length > 0);
  assert.ok(manifest.tiles.every(tile => tile.crop.endsWith('.png')));
  assert.ok(manifest.tiles
    .filter(tile => tile.role !== 'tray')
    .every(tile => tile.box.width === 142 && tile.box.height === 160));
  assert.ok(manifest.tiles
    .filter(tile => tile.role === 'tray')
    .every(tile => tile.box.width === 108 && tile.box.height === 140));
  assert.ok(manifest.references.some(reference => reference.type === 'carrot'));
  assert.deepEqual(cropBox({ cx: 10, cy: 10 }, occlusionImage.info), {
    left: 0, top: 0, width: 142, height: 160,
  });

  const layeredManifest = buildVisionManifest({
    detected: [],
    tray: [],
    available: [],
    trayCounts: {},
    safety: {},
    layerGraph: {
      hidden: [{ cx: 300, cy: 700, visibility: 0.4, type: 'unknown' }],
      edges: [{
        cover: { cx: 300, cy: 600 },
        target: { cx: 300, cy: 700 },
        overlap: 0.4,
        confidence: 0.8,
      }, {
        cover: { cx: 600, cy: 600 },
        target: { cx: 300, cy: 700 },
        overlap: 0.4,
        confidence: 0.61,
      }],
    },
  }, occlusionImage.info);
  assert.equal(layeredManifest.tiles[0].visibleCrop, 'visible/hidden-0-300-700.png');
  assert.deepEqual(layeredManifest.tiles[0].coveredBy, [
    { cx: 300, cy: 600, confidence: 0.8 },
    { cx: 600, cy: 600, confidence: 0.61 },
  ]);
  assert.deepEqual(layeredManifest.tiles[0].maskedBy, [{ cx: 300, cy: 600, confidence: 0.8 }]);
  assert.equal(layeredManifest.tiles[0].visibleMask.maskedFraction, 0.375);
  assert.equal(layeredManifest.tiles[0].visibleMask.remainingFraction, 0.625);
  assert.equal(layeredManifest.layerGraphValidation.valid, true);
  assert.equal(validateLayerGraph(layeredManifest.layerGraph).maxEdgesPerTarget, 2);

  const unlabeled = groupEmbeddings(
    [{ id: 'a', role: 'board' }, { id: 'b', role: 'board' }],
    [[1, 0], [0.99, 0.1]],
    0.8,
  );
  assert.equal(unlabeled.predictions[0].label, 'unknown');
  assert.match(unlabeled.predictions[0].groupId, /^unlabeled-group-/);

  const catalog = await loadCatalog();
  assert.ok(Array.isArray(catalog.icons.carrot));
  assert.ok(catalog.icons.carrot.length >= 3);

  const labelTarget = manifest.tiles.find(tile => tile.role === 'tray');
  const labelState = {
    detected: [{ cx: labelTarget.center.x, cy: labelTarget.center.y, type: 'unknown' }],
    available: [],
    tray: [{ cx: labelTarget.center.x, cy: labelTarget.center.y, type: 'unknown' }],
    trayCounts: { unknown: 1 },
    visibleCounts: {},
    occlusionGraph: { hidden: [] },
  };
  const labelResult = applyVisionLabels(labelState, [{
    id: labelTarget.id, label: 'carrot', referenceLabel: 'carrot', groupId: 'group_a', confidence: 0.96,
  }]);
  assert.equal(labelResult.applied, 2);
  assert.deepEqual(labelState.trayCounts, { carrot: 1 });
  console.log('vision/planner tests: ok');
})().catch(err => { console.error(err); process.exit(1); });
