// Download the spam-model bundle for shadow mode (src/ml.js) and scam roasts into
// ./models/whatsapp-minilm-onnx. The files are attached to a GitHub release; each one's SHA-256
// is checked, so a corrupted or swapped file is never used. Files already present and correct
// are skipped.
//   node scripts/fetch-model.js          (or: npm run fetch-model)
// MODEL_BASE_URL overrides the download location, MODEL_DIR the target folder.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.MODEL_BASE_URL || 'https://github.com/raman2221/guardian-goose/releases/download/model-v2';
const DIR = process.env.MODEL_DIR || './models/whatsapp-minilm-onnx';
const FILES = {
  'model.onnx': 'bed93f1a1ce176772b891c4718c65c54539de75555490e2aa0060368b2af8cc7',
  'vocab.txt': 'b49e80874c5efbc7f4cde245a812673b05ef1360ced56b8bc8c750eaeef3fe0f',
  'goose.json': '067dc45b591e485ed4c42aea08339ae27af92eab555e594a5061d186a7172953',
  'parity.json': '5467d2dc6e218d145b2e924cbbce08b11c665bd1f1b041ec3d8ca0c1d29528c1',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(DIR, { recursive: true });
for (const [name, expected] of Object.entries(FILES)) {
  const path = join(DIR, name);
  if (existsSync(path) && sha256(readFileSync(path)) === expected) {
    console.log(`ok       ${name}`);
    continue;
  }
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== expected) throw new Error(`${name}: checksum mismatch, not saved`);
  writeFileSync(path, buf);
  console.log(`fetched  ${name} (${(buf.length / 1e6).toFixed(1)} MB)`);
}
console.log(`model bundle ready in ${DIR}. Enable with ml: { enabled: true } in config.js`);
