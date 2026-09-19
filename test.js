const assert = require('node:assert/strict');
const fs = require('node:fs');
const sharp = require('sharp');
const { connectedComponents, summarize, chooseAction } = require('./agent');

async function load(path) {
  return sharp(fs.readFileSync(path)).raw().toBuffer({ resolveWithObject: true });
}

(async () => {
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
  assert.equal(action.reason, 'make-pair-with-tray');
  assert.equal(action.tile.type, 'corn');

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
  assert.equal(grouped.reason, 'start-exposed-pair');
  assert.equal(grouped.tile.type, 'cupcake');

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
  console.log('vision/planner replay: ok');
})().catch(err => { console.error(err); process.exit(1); });
