'use strict';
// Разовый импорт старых JSONL в MongoDB. Безопасно запускать повторно (дубли не создаются).
// Запуск:  node scripts/import-jsonl.js <папка с jsonl> [--dry]
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const db = require('../db');

const dir = process.argv[2] || 'data';
const dry = process.argv.includes('--dry');

const FILES = [
  { file: 'signals.jsonl', coll: 'signals', extra: { _kind: 'normal' } },
  { file: 'shadow.jsonl',  coll: 'signals', extra: { _kind: 'shadow' } },
  { file: 'outcomes.jsonl', coll: 'outcomes', extra: {} },
];

async function importFile({ file, coll, extra }) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) { console.log(`- ${file}: нет файла, пропуск`); return; }
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  let batch = [], read = 0, bad = 0, inserted = 0, dups = 0;
  const flush = async () => {
    if (!batch.length) return;
    if (!dry) {
      const r = await db.save(coll, batch, extra);
      if (r.error) throw new Error(r.error);
      inserted += r.inserted; dups += r.duplicates;
    }
    batch = [];
  };
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    try { batch.push(JSON.parse(s)); read++; } catch { bad++; continue; }
    if (batch.length >= 500) await flush();
  }
  await flush();
  console.log(`- ${file}: прочитано ${read}, битых строк ${bad}` +
    (dry ? ' (dry-run, в базу не писали)' : `, новых ${inserted}, уже были ${dups}`));
}

(async () => {
  if (!dry && !process.env.MONGODB_URI) { console.error('Не задан MONGODB_URI'); process.exit(1); }
  console.log(`Папка: ${path.resolve(dir)}${dry ? '  [DRY RUN]' : ''}`);
  for (const f of FILES) await importFile(f);
  if (!dry) {
    const d = await db.getDb();
    if (d) for (const c of ['signals', 'outcomes']) console.log(`В базе ${c}: ${await d.collection(c).countDocuments()}`);
  }
  await db.close();
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
