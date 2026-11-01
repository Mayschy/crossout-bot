'use strict';
// Чистит в MongoDB повторные сигналы одного предмета (и их итоги): оставляет первый в каждом окне.
// Сначала пробный прогон:  node scripts/dedupe-signals.js
// Удалить по-настоящему:   node scripts/dedupe-signals.js --apply     (окно: --hours 1)
const db = require('../db');
const apply = process.argv.includes('--apply');
const hi = process.argv.indexOf('--hours');
const hours = hi > 0 ? Number(process.argv[hi + 1]) : 1;

(async () => {
  const d = await db.getDb();
  if (!d) { console.error('Не задан MONGODB_URI или нет связи с базой'); process.exit(1); }
  const sigs = d.collection('signals'), outs = d.collection('outcomes');
  const all = await sigs.find({}, { projection: { _item: 1, _kind: 1, _ts: 1, t: 1 } }).sort({ _item: 1, _kind: 1, _ts: 1 }).toArray();
  const win = hours * 3600e3, drop = [], pairs = [], per = {};
  let key = null, last = 0;
  for (const x of all) {
    if (!x._ts) continue;
    const k = `${x._item}|${x._kind}`, ts = x._ts.getTime();
    if (k !== key) { key = k; last = -Infinity; }
    if (ts - last < win) { drop.push(x._id); if (x.t != null) pairs.push({ _item: x._item, t: x.t }); per[x._item] = (per[x._item] || 0) + 1; }
    else last = ts;
  }
  console.log(`Всего сигналов ${all.length}, повторов (окно ${hours} ч): ${drop.length}`);
  Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([i, n]) => console.log(`  предмет ${i}: лишних ${n}`));
  if (!apply) { console.log('Это пробный прогон. Чтобы удалить: добавь --apply'); return; }
  for (let i = 0; i < drop.length; i += 500) await sigs.deleteMany({ _id: { $in: drop.slice(i, i + 500) } });
  let o = 0;
  for (let i = 0; i < pairs.length; i += 200) o += (await outs.deleteMany({ $or: pairs.slice(i, i + 200) })).deletedCount;
  console.log(`Удалено сигналов: ${drop.length}, итогов: ${o}`);
})().then(() => db.close()).catch((e) => { console.error(e.message); process.exit(1); });
