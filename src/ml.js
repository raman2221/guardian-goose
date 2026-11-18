// =============================================================================
//  ml.js — optional spam-model scoring for SHADOW MODE. Loads the ONNX bundle
//  exported by goose-spam-model (notebook 06), cleans text exactly like the
//  training notebooks, tokenizes it, and returns a spam probability. Nothing
//  here deletes, kicks, or flags: callers only record the score.
// -----------------------------------------------------------------------------
//  Definitions:
//    bundle      folder with model.onnx, vocab.txt, goose.json (+ parity.json)
//    normalize   text cleaning, version 2; must match notebook 03 exactly, or the
//                model sees text unlike its training data
//    wordpiece   greedy longest-prefix split of a word into vocabulary pieces
//                ("stocks" -> "stock", "##s"); unsplittable words -> [UNK]
//    cutoff      score at/above which the model would call a message spam
//    lane        one inference at a time; excess work is dropped, never queued
//                behind moderation (shadow scores are allowed to be incomplete)
// =============================================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NORMALIZE_VERSION = 2;
const MAX_WORD_CHARS = 100;   // longer "words" become [UNK], as in the trained tokenizer
const MAX_PENDING = 20;       // shadow scoring backlog cap; beyond this, messages go unscored

// Cyrillic / Greek letters that look Latin, plus small capitals (Unicode folding leaves these).
const LOOKALIKES = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b', 'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'τ': 't',
  'ι': 'i', 'κ': 'k', 'ν': 'v', 'υ': 'u', 'χ': 'x', 'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e',
  'ꜰ': 'f', 'ғ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n',
  'ᴏ': 'o', 'ᴘ': 'p', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
};
const LOOKALIKE_RE = new RegExp('[' + Object.keys(LOOKALIKES).join('') + ']', 'gu');

// Python's re is Unicode-aware: \w = letters, numbers, underscore; \d = any decimal digit. JS
// \w and \d are ASCII-only, so they are spelled out to match the training-time cleaning.
const W = '[\\p{L}\\p{N}_]';
const INVITE_RE = /(https?:\/\/)?(chat\.whatsapp\.com\/\S+|t\.me\/(joinchat\/|\+)\S+)/gu;
const URL_RE = new RegExp(
  `(https?:\\/\\/\\S+|www\\.\\S+|t\\.me\\/\\S+|(?<!${W})https?${W}*|(?<!${W})[\\p{L}\\p{N}_-]+\\.(com|net|org|io|me|ly|gle|ee|us|xyz|info|link)(?!${W})\\S*)`,
  'gu');
const SPACED_RE = /\b(?:[a-z] ){2,}[a-z]\b/g;

// Text cleaning, version 2 (notebook 03): fold fonts/accents/lookalikes, lowercase, invite links
// -> "invitelink", other links -> "url", digits -> 0, drop punctuation, rejoin s p a c e d
// letters (before collapsing spaces, so a double space still separates words).
export function normalize(text) {
  let t = String(text ?? '').normalize('NFKD').replace(/\p{Mn}/gu, '');
  t = t.toLowerCase().replace(LOOKALIKE_RE, (c) => LOOKALIKES[c]);
  t = t.replace(INVITE_RE, ' invitelink ').replace(URL_RE, ' url ');
  t = t.replace(/\p{Nd}/gu, '0').replace(/[^a-z0-9 ]+/g, ' ');
  t = t.replace(SPACED_RE, (run) => run.replace(/ /g, ''));
  return t.replace(/\s+/g, ' ').trim();
}

// WordPiece over already-normalized text (only a-z, 0-9, spaces), so splitting on spaces is the
// whole "basic tokenizer" step. Returns [CLS] ids... [SEP], cut to maxLen tokens.
export function tokenize(clean, vocab, special, maxLen) {
  const ids = [];
  for (const word of clean.split(' ').filter(Boolean)) {
    if (word.length > MAX_WORD_CHARS) { ids.push(special.unk); continue; }
    const pieces = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let id;
      while (end > start) {
        id = vocab.get(start === 0 ? word.slice(start, end) : '##' + word.slice(start, end));
        if (id !== undefined) break;
        end--;
      }
      if (end === start) { pieces.length = 0; pieces.push(special.unk); break; }
      pieces.push(id);
      start = end;
    }
    ids.push(...pieces);
  }
  return [special.cls, ...ids.slice(0, maxLen - 2), special.sep];
}

// Load a bundle and return { score(text), cutoff, version } or throw. onnxruntime-node is an
// optional dependency, imported only when shadow mode is enabled.
export async function loadModel(bundleDir) {
  const ort = await import('onnxruntime-node');
  const settings = JSON.parse(readFileSync(join(bundleDir, 'goose.json'), 'utf8'));
  if (settings.normalize_version !== NORMALIZE_VERSION)
    throw new Error(`bundle expects normalize v${settings.normalize_version}, ml.js implements v${NORMALIZE_VERSION}`);
  const tokens = readFileSync(join(bundleDir, 'vocab.txt'), 'utf8').split(/\r?\n/); // bundle may be written on Windows
  const vocab = new Map(tokens.map((tok, i) => [tok, i]));
  const session = await ort.InferenceSession.create(join(bundleDir, settings.model_file || 'model.onnx'),
    { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ['cpu'] });

  const tokenIds = (text) => tokenize(normalize(text), vocab, settings.special_ids, settings.max_len);
  const run = async (text) => {
    const ids = tokenIds(text);
    const shape = [1, ids.length];
    const tensor = (values) => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), shape);
    const out = await session.run({
      input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)), token_type_ids: tensor(ids.map(() => 0)),
    });
    const [normal, spam] = out[settings.output || 'logits'].data;
    const m = Math.max(normal, spam);
    return Math.exp(spam - m) / (Math.exp(normal - m) + Math.exp(spam - m));
  };

  // One inference at a time; drop (return null) when the backlog is full.
  let tail = Promise.resolve();
  let pending = 0;
  const score = (text) => {
    if (pending >= MAX_PENDING) return Promise.resolve(null);
    pending++;
    const job = tail.then(() => run(text)).finally(() => { pending--; });
    tail = job.catch(() => {});
    return job;
  };
  return { score, tokenIds, cutoff: settings.cutoff, version: settings.version || 'unknown', settings };
}

// Record one shadow score. Text is kept only when the model and the rules disagree or the model
// is confident, so reviewers can read the interesting cases without storing every message.
export function recordShadow(db, row) {
  const keepText = row.modelSpam !== row.ruleStrong || row.score >= 0.5;
  db.prepare(`INSERT OR IGNORE INTO ml_shadow (gid,phone,msg_id,ts,score,model,model_spam,rule_strong,signals,trusted,ms,body)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.gid, row.phone, row.msgId, row.ts, row.score, row.model, row.modelSpam ? 1 : 0, row.ruleStrong ? 1 : 0,
      row.signals, row.trusted ? 1 : 0, row.ms, keepText ? String(row.body).slice(0, 400) : null);
}

export const SHADOW_DAYS = 14;
export const pruneShadow = (db) =>
  db.prepare('DELETE FROM ml_shadow WHERE ts < ?').run(Math.floor(Date.now() / 1000) - SHADOW_DAYS * 86400);
