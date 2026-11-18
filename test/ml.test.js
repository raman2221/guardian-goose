import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { normalize, loadModel, recordShadow, pruneShadow } from '../src/ml.js';
import { openDb } from '../src/db.js';

// Raw text -> cleaned text, produced by the Python cleaning the model was trained with
// (goose-spam-model notebook 06). If ml.js drifts from it, the model sees unfamiliar text.
const cases = JSON.parse(readFileSync(new URL('./fixtures/normalize_cases.json', import.meta.url), 'utf8'));

test('normalize matches the training-time Python cleaning', () => {
  for (const c of cases) assert.equal(normalize(c.text), c.clean, `text: ${JSON.stringify(c.text)}`);
});

test('shadow rows keep text only when model and rules disagree or the model is confident', () => {
  const db = openDb(':memory:');
  const base = { gid: 'g', phone: 'p', ts: Math.floor(Date.now() / 1000), model: 'v2', signals: '', trusted: false, ms: 5 };
  recordShadow(db, { ...base, msgId: 'agree-normal', score: 0.02, modelSpam: false, ruleStrong: false, body: 'lunch at 1?' });
  recordShadow(db, { ...base, msgId: 'model-only', score: 0.93, modelSpam: true, ruleStrong: false, body: 'free stock group' });
  recordShadow(db, { ...base, msgId: 'rules-only', score: 0.1, modelSpam: false, ruleStrong: true, body: 'gofund link' });
  const body = (id) => db.prepare('SELECT body FROM ml_shadow WHERE msg_id=?').get(id).body;
  assert.equal(body('agree-normal'), null);
  assert.equal(body('model-only'), 'free stock group');
  assert.equal(body('rules-only'), 'gofund link');
  db.prepare("UPDATE ml_shadow SET ts = 0 WHERE msg_id = 'model-only'").run();
  pruneShadow(db);
  assert.equal(db.prepare('SELECT count(*) c FROM ml_shadow').get().c, 2);
});

// Full parity (tokens + scores) needs the exported model bundle and onnxruntime-node, which are
// optional, so this test skips cleanly without them.
const BUNDLE = process.env.GOOSE_ML_BUNDLE || './models/whatsapp-minilm-onnx';
const haveOrt = await import('onnxruntime-node').then(() => true, () => false);
const skip = !existsSync(`${BUNDLE}/parity.json`) ? `no model bundle at ${BUNDLE}`
  : !haveOrt ? 'onnxruntime-node not installed' : false;

test('token ids and scores match the exported model', { skip }, async () => {
  const parity = JSON.parse(readFileSync(`${BUNDLE}/parity.json`, 'utf8'));
  const model = await loadModel(BUNDLE);
  for (const c of parity) {
    assert.equal(normalize(c.text), c.clean, `clean: ${JSON.stringify(c.text)}`);
    assert.deepEqual(model.tokenIds(c.text), c.input_ids, `tokens: ${JSON.stringify(c.text)}`);
    const score = await model.score(c.text);
    assert.ok(Math.abs(score - c.score) < 1e-3, `score ${score} vs ${c.score}: ${JSON.stringify(c.text)}`);
  }
});
