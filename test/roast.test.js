import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ROASTS, pickRoast, takeRoastSlot, isStockScam } from '../src/roast.js';
import { loadModel } from '../src/ml.js';

const STOCK_PITCH = 'This is a stock market study group. Members can share investment philosophies, experiences, and advice. '
  + 'Beginners and investment enthusiasts are welcome to join and learn together.\nhttps://chat.whatsapp.com/Xq7LmP2vRt9KdW4sYb8NzA';
const DONATION = 'Please do not ignore this message. I am an orphan and need help with school fees, even $5 could help. God bless';

test('a group never gets the same roast twice in a row', () => {
  let previous = null;
  for (let i = 0; i < 300; i++) {
    const line = pickRoast('group-a');
    assert.notEqual(line, previous);
    previous = line;
  }
});

test('roasts never tag or name anyone', () => {
  for (const line of ROASTS) {
    assert.doesNotMatch(line, /@|\{|\+\d/, line);
  }
});

test('one roast per group per cooldown, groups independent', () => {
  const t0 = 1_000_000;
  assert.equal(takeRoastSlot('g1', 10, t0), true);
  assert.equal(takeRoastSlot('g1', 10, t0 + 60_000), false);       // 1 min later: still cooling down
  assert.equal(takeRoastSlot('g2', 10, t0 + 60_000), true);        // another group is unaffected
  assert.equal(takeRoastSlot('g1', 10, t0 + 10 * 60_000), true);   // cooldown over
});

test('without the model, finance vocabulary decides', async () => {
  assert.equal(await isStockScam(STOCK_PITCH, null), true);
  assert.equal(await isStockScam(DONATION, null), false);
});

const BUNDLE = process.env.GOOSE_ML_BUNDLE || './models/whatsapp-minilm-onnx';
const haveOrt = await import('onnxruntime-node').then(() => true, () => false);
test('with the model, a stock pitch is a stock scam and a donation appeal is not',
  { skip: !(existsSync(`${BUNDLE}/model.onnx`) && haveOrt) && 'no model bundle or onnxruntime-node' }, async () => {
    const ml = await loadModel(BUNDLE);
    assert.equal(await isStockScam(STOCK_PITCH, ml), true);
    assert.equal(await isStockScam(DONATION, ml), false);
  });
