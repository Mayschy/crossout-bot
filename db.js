'use strict';
// MongoDB-слой для crossout-bot. Если MONGODB_URI не задан или база недоступна —
// тихо отключается, бот продолжает писать JSONL как раньше (fallback).
const crypto = require('crypto');

const DB_NAME = process.env.MONGODB_DB || 'crossout';

let client = null;
let db = null;
let dead = false;

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// Детерминированный _id: одна и та же запись никогда не вставится дважды
// ctx (контекст из последних точек истории) в хэш не входит: так запись, импортированная
// из старого JSONL, и та же запись от бота (уже с ctx) получают один и тот же _id.
function hashId(doc) {
  const { ctx, ...rest } = doc; // eslint-disable-line no-unused-vars
  return crypto.createHash('sha1').update(stable(rest)).digest('hex');
}

function toDate(x) {
  if (x == null) return null;
  if (typeof x === 'number') return new Date(x < 1e11 ? x * 1000 : x); // секунды или мс
  const d = new Date(x);
  return isNaN(d) ? null : d;
}

// Служебные поля _ts/_item для индексов; исходные поля записи не трогаем
function normalize(raw, extra) {
  const doc = JSON.parse(JSON.stringify(raw));
  Object.assign(doc, extra);
  const ts = toDate(doc.ts ?? doc.t ?? doc.time ?? doc.at ?? doc.createdAt ?? doc.date);
  if (ts) doc._ts = ts;
  const item = doc.itemId ?? doc.id ?? doc.item_id ?? doc.item;
  if (item != null) doc._item = item;
  doc._id = hashId(doc);
  return doc;
}

async function getDb() {
  if (dead) return null;
  if (db) return db;
  const URI = process.env.MONGODB_URI || ''; // читаем лениво: .env в bot.js подгружается позже, чем require
  if (!URI) { dead = true; return null; }
  try {
    const { MongoClient } = require('mongodb');
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
    await client.connect();
    db = client.db(DB_NAME);
    await Promise.all([
      db.collection('signals').createIndex({ _ts: -1 }),
      db.collection('signals').createIndex({ _item: 1, _ts: -1 }),
      db.collection('signals').createIndex({ _kind: 1, _ts: -1 }),
      db.collection('outcomes').createIndex({ _ts: -1 }),
      db.collection('outcomes').createIndex({ _item: 1, _ts: -1 }),
    ]);
    return db;
  } catch (e) {
    console.error('[db] недоступна, работаем только с JSONL:', e.message);
    dead = true;
    return null;
  }
}

// save('signals', [rec], { _kind: 'normal' | 'shadow' })
async function save(collection, records, extra = {}) {
  const d = await getDb();
  if (!d || !records.length) return { inserted: 0, duplicates: 0 };
  try {
    const docs = records.map(r => normalize(r, extra));
    const ops = docs.map(doc => ({
      updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc }, upsert: true },
    }));
    const res = await d.collection(collection).bulkWrite(ops, { ordered: false });
    return { inserted: res.upsertedCount, duplicates: docs.length - res.upsertedCount };
  } catch (e) {
    console.error('[db] ошибка записи:', e.message);
    return { inserted: 0, duplicates: 0, error: e.message };
  }
}


// Одиночный документ (состояние бота): так дедупликация не зависит от кэша GitHub Actions
async function loadDoc(collection, id) {
  const d = await getDb();
  if (!d) return null;
  try {
    const x = await d.collection(collection).findOne({ _id: id });
    if (x) delete x._id;
    return x;
  } catch (e) { console.error('[db] ошибка чтения:', e.message); return null; }
}
async function saveDoc(collection, id, obj) {
  const d = await getDb();
  if (!d) return false;
  try {
    await d.collection(collection).replaceOne({ _id: id }, JSON.parse(JSON.stringify(obj)), { upsert: true });
    return true;
  } catch (e) { console.error('[db] ошибка записи состояния:', e.message); return false; }
}

async function close() {
  if (client) { try { await client.close(); } catch {} client = null; db = null; }
}

module.exports = { save, loadDoc, saveDoc, close, getDb };
