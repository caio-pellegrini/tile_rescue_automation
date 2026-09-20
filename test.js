const assert = require('node:assert/strict');
const fs = require('node:fs');
const sharp = require('sharp');
const { connectedComponents, semanticType, summarize, chooseAction } = require('./agent');
const { applyVisionLabels, buildVisionManifest, cropBox, validateLayerGraph } = require('./vision');
const { groupEmbeddings } = require('./local_ml');
const { parseArgs } = require('./play');

async function load(path) {
  return sharp(fs.readFileSync(path)).raw().toBuffer({ resolveWithObject: true });
}

(async () => {
  assert.deepEqual(parseArgs([]), {
    live: false,
    maxMoves: 1,
    device: 'RQCY903RJQN',
    level: '23',
    settleMs: 1200,
    runDir: null,
    useMl: true,
  });
  assert.deepEqual(parseArgs(['--live', '--moves', '3', '--no-ml', '--settle-ms', '700']), {
    live: true,
    maxMoves: 3,
    device: 'RQCY903RJQN',
    level: '23',
    settleMs: 700,
    runDir: null,
    useMl: false,
  });

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

  const clusters = [];
  const cleanImage = await load('/tmp/tile_rescue_level23_clean.png');
  const clean = summarize(cleanImage, connectedComponents(cleanImage), clusters);
  assert.equal(Object.keys(clean.trayCounts).length, 0);
  assert.ok(clean.available.some(t => t.type === 'corn'));
  assert.ok(clean.available.some(t => t.type === 'chick'));
  assert.ok(clean.available.filter(t => t.type === 'cupcake').length >= 2);

  const afterOneImage = await load('/tmp/agent_after_one.png');
  const afterOne = summarize(afterOneImage, connectedComponents(afterOneImage), clusters);
  assert.equal(afterOne.trayCounts.carrot, 1);
  assert.ok(afterOne.available.some(t => t.type === 'corn'));

  const afterTwoImage = await load('/tmp/agent_after_two.png');
  const afterTwo = summarize(afterTwoImage, connectedComponents(afterTwoImage), clusters);
  assert.deepEqual(afterTwo.trayCounts, { carrot: 1, corn: 1 });
  const action = chooseAction(afterTwo);
  assert.equal(action.reason, 'complete-triple-potential');
  assert.equal(action.tile.type, 'corn');

  const trayRegressionImage = await load('/tmp/tile-rescue-after-two.png');
  const trayRegression = summarize(
    trayRegressionImage,
    connectedComponents(trayRegressionImage),
    [],
  );
  assert.equal(trayRegression.tray.length, 2);

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

  const occlusionImage = await load('/tmp/tile_rescue_manual_carrot_check.png');
  const occlusionState = summarize(
    occlusionImage,
    connectedComponents(occlusionImage),
    [],
  );
  const occlusionAction = chooseAction(occlusionState);
  assert.equal(occlusionAction.reason, 'release-hidden-match');
  assert.equal(occlusionAction.tile.type, 'cupcake');
  assert.equal(occlusionAction.reveals.type, 'carrot');
  assert.equal(semanticType([0.02, 0.038, 0.847, 0.04, 0, 0, 0, 0.055, 0]), 'chick');
  assert.equal(semanticType([0.0059, 0.0867, 0.7406, 0.0964, 0.0015, 0, 0, 0.0689, 0]), 'sun');
  assert.equal(semanticType([0, 0, 0, 0, 0, 0.2, 0]), 'unknown');

  const manifest = buildVisionManifest(occlusionState, occlusionImage.info);
  assert.ok(manifest.tiles.length > 0);
  assert.ok(manifest.tiles.every(tile => tile.crop.endsWith('.png')));
  assert.ok(manifest.tiles.every(tile => tile.box.width === 144 && tile.box.height === 144));
  assert.ok(manifest.references.some(reference => reference.type === 'carrot'));
  assert.deepEqual(cropBox({ cx: 10, cy: 10 }, occlusionImage.info), {
    left: 0, top: 0, width: 144, height: 144,
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
      }],
    },
  }, occlusionImage.info);
  assert.equal(layeredManifest.tiles[0].visibleCrop, 'visible/hidden-0-300-700.png');
  assert.deepEqual(layeredManifest.tiles[0].coveredBy, [{ cx: 300, cy: 600, confidence: 0.8 }]);
  assert.equal(layeredManifest.layerGraphValidation.valid, true);
  assert.equal(validateLayerGraph(layeredManifest.layerGraph).maxEdgesPerTarget, 1);

  const unlabeled = groupEmbeddings(
    [{ id: 'a', role: 'board' }, { id: 'b', role: 'board' }],
    [[1, 0], [0.99, 0.1]],
    0.8,
  );
  assert.equal(unlabeled.predictions[0].label, 'unknown');
  assert.match(unlabeled.predictions[0].groupId, /^unlabeled-group-/);

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
  console.log('vision/planner replay: ok');
})().catch(err => { console.error(err); process.exit(1); });
