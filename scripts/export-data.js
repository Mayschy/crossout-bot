'use strict';
// Читает MongoDB и пишет web/data.json (публичный снимок для страницы). Секреты в json не попадают.
const fs = require('fs');
const path = require('path');
const db = require('../db');

(async () => {
  const d = await db.getDb();
  if (!d) throw new Error('Нет подключения к MongoDB: проверь секрет MONGODB_URI');
  const sigs = await d.collection('signals').find({}, { projection: { _id: 0, ctx: 0 } }).sort({ _ts: -1 }).limit(3000).toArray();
  const outs = await d.collection('outcomes').find({ late: { $ne: true } }, { projection: { _id: 0 } }).sort({ _ts: -1 }).limit(20000).toArray();
  const ask = new Map(outs.map((o) => [`${o.id}:${o.t}:${o.h}`, o.ask]));
  const rows = sigs.map((s) => ({
    id: s.id, name: s.name, t: s.t, sale: s.sale, profit: s.profit, roi: s.roi, liq: s.liq, sh: s.shadow || s._kind === 'shadow' ? 1 : 0,
    o: Object.fromEntries([10, 20, 30, 60, 120].map((h) => [h, ask.get(`${s.id}:${s.t}:${h}`) ?? null])),
  }));
  const total = { signals: await d.collection('signals').countDocuments(), outcomes: await d.collection('outcomes').countDocuments() };
  fs.writeFileSync(path.join(__dirname, '..', 'web', 'data.json'), JSON.stringify({ updated: Date.now(), total, rows }));
  console.log(`data.json: ${rows.length} сигналов из ${total.signals}`);
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
