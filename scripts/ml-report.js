// Shadow-mode report: how the spam model's verdicts compare with the rules' over the last N days,
// and the messages where they disagree. Read-only. Usage (from the bot folder):
//   node scripts/ml-report.js [days=7]
import { DatabaseSync } from 'node:sqlite';
import cfg from '../config.js';

const days = Number(process.argv[2] || 7);
const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
const since = Math.floor(Date.now() / 1000) - days * 86400;
const rows = db.prepare('SELECT * FROM ml_shadow WHERE ts >= ? ORDER BY score DESC').all(since);
if (!rows.length) {
  console.log(`no shadow scores in the last ${days} days (is cfg.ml.enabled on?)`);
  process.exit(0);
}

const count = (fn) => rows.filter(fn).length;
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`last ${days} days: ${rows.length} group messages scored (model ${rows[0].model})`);
console.log(`  both say spam:       ${count((r) => r.model_spam && r.rule_strong)}`);
console.log(`  only the model:      ${count((r) => r.model_spam && !r.rule_strong)}   <- would the model have caught more?`);
console.log(`  only the rules:      ${count((r) => !r.model_spam && r.rule_strong)}   <- what the model misses`);
console.log(`  neither:             ${count((r) => !r.model_spam && !r.rule_strong)}`);
console.log(`  scoring time:        median ${ms[Math.floor(ms.length / 2)]} ms, slowest ${ms[ms.length - 1]} ms`);

const show = (title, list) => {
  console.log(`\n${title} (${list.length})`);
  for (const r of list.slice(0, 15))
    console.log(`  ${r.score.toFixed(3)} ${r.trusted ? '[trusted] ' : ''}${(r.body || '').replace(/\s+/g, ' ').slice(0, 140)}`);
};
show('ONLY THE MODEL flagged: check these by hand', rows.filter((r) => r.model_spam && !r.rule_strong));
show('ONLY THE RULES flagged', rows.filter((r) => !r.model_spam && r.rule_strong).reverse());
