'use strict';
/**
 * Crossout flash-crash notifier.
 * Node 20+, без зависимостей.
 *
 *   node bot.js                      — основной цикл (24/7)
 *   node bot.js --once               — один проход и выход (удобно с DRY_RUN=1)
 *   node bot.js --calibrate 1599:1799 51.78:66.47
 *                                    — подбор формулы «Эталона» по строкам таблицы (Продажа:Эталон)
 *   node bot.js --dump [id ...]      — сохранить сырые данные в dump.json (все предметы или только указанные)
 *   node bot.js --find мамонт        — поиск ID по названию (нужен список названий)
 *   node bot.js --test               — отправить тестовое сообщение в Telegram
 */

const fs = require('node:fs');
const path = require('node:path');

// ───────────────────────── .env (без зависимостей) ─────────────────────────
function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const num = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`Некорректное число в ${key}: "${v}"`);
  return n;
};

// ───────────────────────── Конфиг ─────────────────────────
const DEFAULT_ACTION_ID = '007b18493a3b098d0942d07efe4de4b088e6543441';

const CFG = {
  pageUrl: process.env.PAGE_URL || 'https://crossoutcore.ru/flash-crashes/',
  actionId: process.env.NEXT_ACTION_ID || DEFAULT_ACTION_ID,

  tgToken: process.env.TG_TOKEN || '',
  tgChat: process.env.TG_CHAT_ID || '',
  dryRun: process.env.DRY_RUN === '1',

  // фильтры
  minProfit: num('MIN_PROFIT', 30),
  minRoi: num('MIN_ROI', 0), // %
  minBuyOrders: num('MIN_BUY_ORDERS', 0), // последнее значение bo

  // расписание / дедупликация
  intervalMin: num('INTERVAL_MIN', 4),
  realertHours: num('REALERT_HOURS', 3),
  maxPerMessage: num('MAX_PER_MESSAGE', 10),
  maxDataAgeMin: num('MAX_DATA_AGE_MIN', 20),

  // формула
  fee: num('FEE', 0.9), // Прибыль = Эталон * fee - Продажа
  minRefPoints: num('MIN_REF_POINTS', 3),
  ref: {
    mode: (process.env.REF_MODE || 'mean').toLowerCase(), // mean | median | max | min
    field: (process.env.REF_FIELD || 's').toLowerCase(), // s | b
    count: num('REF_POINTS', 6), // 30 мин / 5 мин
    skipLast: num('REF_SKIP_LAST', 0), // 1 = не учитывать текущую точку
  },

  // названия: по умолчанию берём из HTML страницы crossoutcore (self.__next_f)
  // NAMES_URL пустой = не качать; NAMES_URL=https://... = JSON-массив [{id,name}]
  namesUrl: process.env.NAMES_URL === undefined ? 'html' : process.env.NAMES_URL,
  itemLinkTpl: process.env.ITEM_LINK_TPL || '',

  // иконки: IMAGES=0 выключает отправку картинок
  images: process.env.IMAGES !== '0',
  imageTpl: process.env.IMAGE_TPL || 'https://crossoutcore.ru/images/items/{id}.webp',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Дерево роутера Next.js (из рабочего кода в консоли браузера)
const TREE =
  '%5B%22%22%2C%7B%22children%22%3A%5B%5B%22locale%22%2C%22ru%22%2C%22d%22%2Cnull%5D%2C%7B%22children%22%3A%5B%22(app)%22%2C%7B%22children%22%3A%5B%22flash-crashes%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C16%5D%7D%2Cnull%2Cnull%2C0%5D';

const STATE_FILE = path.join(__dirname, 'state.json');
const NAMES_FILE = path.join(__dirname, 'names.json');
const NAMES_CUSTOM_FILE = path.join(__dirname, 'names.custom.json'); // ручные дополнения: {"123":"Название"}

// ───────────────────────── Утилиты ─────────────────────────
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f2 = (n) => Number(n).toFixed(2);

class ActionError extends Error {} // сломан/устарел next-action ID или формат ответа

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(st) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, STATE_FILE);
}

// ───────────────────────── Получение данных ─────────────────────────
async function callAction(actionId, body) {
  const res = await fetch(CFG.pageUrl, {
    method: 'POST',
    headers: {
      accept: 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': actionId,
      'next-router-state-tree': TREE,
      origin: new URL(CFG.pageUrl).origin,
      referer: CFG.pageUrl,
      'user-agent': UA,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function looksLikeDataset(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = Object.keys(o).slice(0, 20);
  if (keys.length < 3) return false;
  let ok = 0;
  for (const k of keys) {
    const a = o[k];
    if (Array.isArray(a) && a.length && a[0] && typeof a[0] === 'object' && 't' in a[0] && 's' in a[0]) ok++;
  }
  return ok >= 3;
}

function findDataset(node, depth = 0) {
  if (looksLikeDataset(node)) return node;
  if (depth >= 3 || !node || typeof node !== 'object') return null;
  for (const v of Object.values(node)) {
    const r = findDataset(v, depth + 1);
    if (r) return r;
  }
  return null;
}

/** RSC-поток: строки вида `N:JSON`. Ищем строку-объект {id: [точки]}. → Map<id, Point[]> */
function parseHistory(text) {
  for (const line of text.split('\n')) {
    const m = /^[0-9a-zA-Z]+:([\[{].*)$/.exec(line);
    if (!m) continue;
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const ds = findDataset(parsed);
    if (!ds) continue;
    const out = new Map();
    for (const [k, arr] of Object.entries(ds)) {
      const id = Number(k);
      if (!Number.isFinite(id) || !Array.isArray(arr)) continue;
      const pts = arr
        .filter((p) => p && Number.isFinite(p.t))
        .map((p) => ({ t: p.t, s: Number(p.s) || 0, b: Number(p.b) || 0, so: Number(p.so) || 0, bo: Number(p.bo) || 0 }))
        .sort((a, b) => a.t - b.t);
      if (pts.length) out.set(id, pts);
    }
    if (out.size) return out;
  }
  return null;
}

async function tryAction(actionId) {
  const { status, text } = await callAction(actionId, []);
  if (status === 429 || status >= 500) throw new Error(`Сайт ответил HTTP ${status} (временная ошибка)`);
  if (status !== 200) throw new ActionError(`HTTP ${status} — вероятно, next-action ID устарел`);
  const data = parseHistory(text);
  if (!data || data.size < 50) {
    throw new ActionError(
      `Ответ получен, но формат не распознан (${text.length} байт): ${text.slice(0, 120).replace(/\s+/g, ' ')}`
    );
  }
  return data;
}

/** Достаём кандидаты next-action ID из JS-чанков страницы (createServerReference("<id>",...)) */
async function discoverActionIds() {
  const headers = { 'user-agent': UA, accept: 'text/html,*/*' };
  const html = await (await fetch(CFG.pageUrl, { headers, signal: AbortSignal.timeout(30_000) })).text();
  const scripts = [...new Set([...html.matchAll(/\/_next\/static\/[^"'\s\\]+?\.js/g)].map((m) => m[0]))].slice(0, 80);
  const ids = new Set();
  for (const s of scripts) {
    try {
      const r = await fetch(new URL(s, CFG.pageUrl), { headers, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) continue;
      const js = await r.text();
      for (const m of js.matchAll(/createServerReference\)?\(\s*["']([0-9a-f]{40,})["']/g)) ids.add(m[1]);
    } catch {
      /* пропускаем чанк */
    }
  }
  return [...ids];
}

async function getData(state) {
  const saved = state.actionBase === CFG.actionId && state.actionId ? state.actionId : null;
  const current = saved || CFG.actionId;
  try {
    return await tryAction(current);
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    log('next-action не сработал:', e.message);

    // авто-поиск нового ID — не чаще раза в 30 минут
    if (Date.now() - (state.lastDiscover || 0) < 30 * 60_000) throw e;
    state.lastDiscover = Date.now();
    saveState(state);

    log('Ищу новый next-action ID в JS-чанках…');
    const cands = (await discoverActionIds()).filter((id) => id !== current).slice(0, 12);
    log(`Кандидатов: ${cands.length}`);
    for (const id of cands) {
      try {
        const data = await tryAction(id);
        log('Найден рабочий next-action ID:', id);
        state.actionId = id;
        state.actionBase = CFG.actionId;
        saveState(state);
        return data;
      } catch {
        /* следующий кандидат */
      }
    }
    throw new ActionError(
      `Не удалось получить данные: next-action ID устарел и автопоиск не помог. Исходная ошибка: ${e.message}. ` +
        `Откройте страницу, найдите в DevTools → Network запрос POST /flash-crashes/ с телом [] и обновите NEXT_ACTION_ID в .env.`
    );
  }
}

// ───────────────────────── Названия ─────────────────────────
function readNamesFile(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.entries(obj).map(([k, v]) => [Number(k), String(v)]);
  } catch {
    return [];
  }
}

/** В HTML лежит self.__next_f.push([1,"...{\"id\":253,\"name\":\"ЗИС-46 Мамонт\",\"rarityId\":6..."]) → {id: name} */
function parseNamesFromHtml(html) {
  const out = {};
  const unq = (s) => {
    // два уровня экранирования: строка в push(...) → JSON внутри
    try {
      s = JSON.parse('"' + s + '"');
      return JSON.parse('"' + s + '"');
    } catch {
      return s;
    }
  };
  const reEsc = /\\"id\\":(\d+),\\"name\\":\\"(.*?)\\",\\"rarityId\\"/g; // экранированный вариант
  for (const m of html.matchAll(reEsc)) out[m[1]] = unq(m[2]);
  if (!Object.keys(out).length) {
    const rePlain = /"id":(\d+),"name":"(.*?)","rarityId"/g; // неэкранированный вариант
    for (const m of html.matchAll(rePlain)) out[m[1]] = unq(m[2]);
  }
  return out;
}

async function loadNames() {
  let entries = [];
  let fresh = false;
  try {
    fresh = Date.now() - fs.statSync(NAMES_FILE).mtimeMs < 7 * 86_400_000;
  } catch {
    /* нет кэша */
  }
  if (fresh) entries = readNamesFile(NAMES_FILE);
  else if (CFG.namesUrl) {
    try {
      const html = CFG.namesUrl === 'html';
      const res = await fetch(html ? CFG.pageUrl : CFG.namesUrl, {
        headers: { accept: html ? 'text/html,*/*' : 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const obj = {};
      if (html) {
        Object.assign(obj, parseNamesFromHtml(await res.text()));
      } else {
        const arr = await res.json();
        for (const it of Array.isArray(arr) ? arr : []) {
          const id = it.id ?? it.Id;
          const name = it.name ?? it.Name;
          if (id != null && name) obj[id] = String(name);
        }
      }
      if (!Object.keys(obj).length) throw new Error('пустой список');
      fs.writeFileSync(NAMES_FILE, JSON.stringify(obj));
      entries = Object.entries(obj).map(([k, v]) => [Number(k), v]);
      log(`Названия загружены: ${entries.length}`);
    } catch (e) {
      log('Не удалось загрузить названия:', e.message, '— использую старый кэш (если есть)');
      entries = readNamesFile(NAMES_FILE);
    }
  } else entries = readNamesFile(NAMES_FILE);

  const map = new Map(entries);
  for (const [k, v] of readNamesFile(NAMES_CUSTOM_FILE)) map.set(k, v); // ручные имеют приоритет
  return map;
}

const nameOf = (names, id) => names.get(id) || `Предмет #${id}`;

// ───────────────────────── Расчёт ─────────────────────────
function agg(mode, vals) {
  if (!vals.length) return NaN;
  switch (mode) {
    case 'mean':
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'median': {
      const v = [...vals].sort((a, b) => a - b);
      const m = v.length >> 1;
      return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    }
    case 'max':
      return Math.max(...vals);
    case 'min':
      return Math.min(...vals);
    default:
      throw new Error(`Неизвестный REF_MODE: ${mode} (mean | median | max | min)`);
  }
}

function reference(pts, { mode, field, count, skipLast }) {
  const end = pts.length - skipLast;
  const win = pts.slice(Math.max(0, end - count), Math.max(0, end));
  const vals = win.map((p) => p[field]).filter((v) => v > 0);
  return { ref: agg(mode, vals), n: vals.length };
}

function evaluate(pts) {
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  if (!(last.s > 0)) return null;
  const { ref, n } = reference(pts, CFG.ref);
  if (!(ref > 0) || n < CFG.minRefPoints) return null;
  const profit = ref * CFG.fee - last.s;
  return { t: last.t, sale: last.s, ref, profit, roi: (profit / last.s) * 100, so: last.so, bo: last.bo, buy: last.b };
}

// ───────────────────────── Telegram ─────────────────────────
async function tgSend(text) {
  if (CFG.dryRun) {
    console.log('[DRY_RUN → Telegram]\n' + text + '\n');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CFG.tgChat,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(`Telegram: HTTP ${res.status} ${j.description || ''}`.trim());
}

// sharp — необязательная зависимость (npm i sharp): конвертирует webp в jpeg, который Telegram точно принимает
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  /* работаем без конвертации */
}

/** Telegram не смог сам скачать иконку по URL, поэтому качаем сами и загружаем файлом */
async function fetchIcon(id) {
  try {
    const r = await fetch(CFG.imageTpl.replace('{id}', id), {
      headers: { 'user-agent': UA, referer: CFG.pageUrl, accept: 'image/*' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let buf = Buffer.from(await r.arrayBuffer());
    let type = 'image/webp';
    let ext = 'webp';
    if (sharp) {
      buf = await sharp(buf).resize(320, 320, { fit: 'contain', background: '#1a1a1a' }).jpeg({ quality: 85 }).toBuffer();
      type = 'image/jpeg';
      ext = 'jpg';
    }
    return { buf, type, ext };
  } catch (e) {
    log(`Иконка #${id} не загружена: ${e.message}`);
    return null;
  }
}

/** Одно сообщение-альбом: до 10 фото, подпись (общая) на первом фото */
async function tgSendAlbum(items, caption) {
  if (CFG.dryRun) {
    console.log(`[DRY_RUN → Telegram альбом из ${items.length} фото]\n${caption}\n`);
    return;
  }
  const fd = new FormData();
  fd.append('chat_id', CFG.tgChat);
  let method;
  if (items.length === 1) {
    method = 'sendPhoto';
    fd.append('caption', caption);
    fd.append('parse_mode', 'HTML');
    fd.append('photo', new Blob([items[0].icon.buf], { type: items[0].icon.type }), `${items[0].id}.${items[0].icon.ext}`);
  } else {
    method = 'sendMediaGroup';
    fd.append(
      'media',
      JSON.stringify(
        items.map((it, i) => ({
          type: 'photo',
          media: `attach://p${i}`,
          ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
        }))
      )
    );
    items.forEach((it, i) => fd.append(`p${i}`, new Blob([it.icon.buf], { type: it.icon.type }), `${it.id}.${it.icon.ext}`));
  }
  const res = await fetch(`https://api.telegram.org/bot${CFG.tgToken}/${method}`, {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(`Telegram ${method}: HTTP ${res.status} ${j.description || ''}`.trim());
}

/** Короткий формат для подписи альбома (лимит подписи 1024 символа) */
function compactItem(f, names) {
  return (
    `🔻 <b>${esc(nameOf(names, f.id))}</b> <code>#${f.id}</code>\n` +
    `${f2(f.sale)} → ${f2(f.ref)} · <b>+${f2(f.profit)}</b> · ${f2(f.roi)}% · зак ${f.bo} · лот ${f.so}`
  );
}

function formatItem(f, names) {
  const link = CFG.itemLinkTpl ? CFG.itemLinkTpl.replace('{id}', f.id) : '';
  const title = link ? `<a href="${esc(link)}">${esc(nameOf(names, f.id))}</a>` : esc(nameOf(names, f.id));
  return (
    `🔻 <b>${title}</b> <code>#${f.id}</code>\n` +
    `Продажа <b>${f2(f.sale)}</b> → эталон ${f2(f.ref)}\n` +
    `Прибыль <b>${f2(f.profit)}</b> · ROI ${f2(f.roi)}%\n` +
    `Заказов на покупку: ${f.bo} · лотов: ${f.so}`
  );
}

// ───────────────────────── Один проход ─────────────────────────
async function cycle(names, state) {
  const data = await getData(state);
  const nowSec = Date.now() / 1000;

  let newest = 0;
  const found = [];
  for (const [id, pts] of data) {
    newest = Math.max(newest, pts[pts.length - 1].t);
    const r = evaluate(pts);
    if (!r) continue;
    if (r.profit >= CFG.minProfit && r.roi >= CFG.minRoi && r.bo >= CFG.minBuyOrders) found.push({ id, ...r });
  }

  const ageMin = (nowSec - newest) / 60;
  if (ageMin > CFG.maxDataAgeMin) {
    throw new Error(`Данные на сайте не обновлялись ${ageMin.toFixed(0)} мин — уведомления приостановлены`);
  }

  found.sort((a, b) => b.profit - a.profit);

  state.alerts = state.alerts || {};
  const now = Date.now();
  const realertMs = CFG.realertHours * 3_600_000;
  const fresh = found.filter((f) => !state.alerts[f.id] || now - state.alerts[f.id] > realertMs);

  log(`Предметов: ${data.size}, подходят: ${found.length}, новых для уведомления: ${fresh.length}, возраст данных: ${ageMin.toFixed(1)} мин`);

  const chunks = [];
  if (CFG.images) {
    // в режиме альбомов: не больше 10 фото и подпись ≤ ~1000 символов
    let cur = [];
    let len = 80; // запас под шапку
    for (const f of fresh) {
      const l = compactItem(f, names).length + 1;
      if (cur.length && (cur.length >= Math.min(10, CFG.maxPerMessage) || len + l > 1000)) {
        chunks.push(cur);
        cur = [];
        len = 80;
      }
      cur.push(f);
      len += l;
    }
    if (cur.length) chunks.push(cur);
  } else {
    for (let i = 0; i < fresh.length; i += CFG.maxPerMessage) chunks.push(fresh.slice(i, i + CFG.maxPerMessage));
  }

  for (const chunk of chunks) {
    const header = `⚡ Обвал цен: ${chunk.length} шт. (прибыль ≥ ${CFG.minProfit})\n\n`;
    if (CFG.images) {
      // один альбом на пачку: до 10 фото, одна общая подпись
      const caption = header + chunk.map((f) => compactItem(f, names)).join('\n');
      const icons = await Promise.all(chunk.map((f) => fetchIcon(f.id)));
      const items = chunk.map((f, i) => ({ id: f.id, icon: icons[i] })).filter((x) => x.icon);
      try {
        if (!items.length) throw new Error('нет ни одной иконки');
        await tgSendAlbum(items, caption);
      } catch (e) {
        log(`Альбом не отправлен (${e.message}) — шлю текстом`);
        await tgSend(caption);
      }
      for (const f of chunk) state.alerts[f.id] = Date.now();
      saveState(state);
    } else {
      await tgSend(header + chunk.map((f) => formatItem(f, names)).join('\n\n'));
      for (const f of chunk) state.alerts[f.id] = Date.now();
      saveState(state); // сохраняем после каждой успешной отправки
    }
  }

  // чистка старых записей
  for (const [id, ts] of Object.entries(state.alerts)) if (now - ts > Math.max(realertMs * 2, 86_400_000)) delete state.alerts[id];
  saveState(state);
}

// ───────────────────────── Ошибки → Telegram (с троттлингом) ─────────────────────────
async function alertError(e, state) {
  state.errors = state.errors || {};
  const key = e instanceof ActionError ? 'action' : /не обновлялись/.test(e.message) ? 'stale' : 'other';
  const throttleMs = (key === 'other' ? 1 : 3) * 3_600_000;
  if (Date.now() - (state.errors[key] || 0) < throttleMs) return;
  try {
    await tgSend(`⚠️ <b>Бот Crossout</b>: ${esc(e.message).slice(0, 900)}`);
    state.errors[key] = Date.now();
    saveState(state);
  } catch (e2) {
    log('Не удалось отправить алерт об ошибке:', e2.message);
  }
}

// ───────────────────────── Калибровка формулы «Эталона» ─────────────────────────
function buildVariants() {
  const out = [];
  for (const field of ['s', 'b'])
    for (const mode of ['mean', 'median', 'max', 'min'])
      for (let count = 2; count <= 12; count++)
        for (const skipLast of [0, 1])
          out.push({ field, mode, count, skipLast, label: `${field}.${mode} по ${count} точкам${skipLast ? ' без текущей' : ''}` });
  return out;
}

function calibrate(data, names, args) {
  const EPS = 0.006;
  const pairs = args.map((a) => {
    const [s, e] = a.split(':').map((x) => Number(x.trim().replace(',', '.')));
    if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error(`Ожидаю пары вида Продажа:Эталон, получено "${a}"`);
    return [s, e];
  });
  const variants = buildVariants();
  const score = new Map(); // label -> Set(pairIdx)

  pairs.forEach(([sale, et], pi) => {
    console.log(`\n=== Пара ${pi + 1}: продажа ${sale}, эталон ${et} ===`);
    let matched = false;
    for (let off = 0; off <= 2 && !matched; off++) {
      for (const [id, pts] of data) {
        const p2 = off ? pts.slice(0, pts.length - off) : pts;
        const last = p2[p2.length - 1];
        if (!last || Math.abs(last.s - sale) > EPS) continue;
        matched = true;
        const hits = variants.filter((v) => Math.abs(reference(p2, v).ref - et) <= EPS);
        console.log(
          `• id ${id} (${nameOf(names, id)})${off ? `, данные ушли вперёд на ${off} точк.` : ''}: ` +
            (hits.length ? `совпало формул: ${hits.length}` : 'продажа совпала, эталон НЕ совпал ни с одной формулой')
        );
        for (const v of hits.slice(0, 8)) console.log(`    ✓ ${v.label}`);
        if (hits.length > 8) console.log(`    … и ещё ${hits.length - 8}`);
        for (const v of hits) {
          if (!score.has(v.label)) score.set(v.label, new Set());
          score.get(v.label).add(pi);
        }
        if (!hits.length) {
          console.log('    последние точки (t, s, b, so, bo):');
          for (const p of p2.slice(-14)) console.log(`      ${p.t}  s=${p.s}  b=${p.b}  so=${p.so}  bo=${p.bo}`);
        }
      }
    }
    if (!matched) console.log('Предмет с такой ценой продажи не найден (данные могли обновиться — повторите быстрее после обновления таблицы).');
  });

  const ranked = [...score.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
  console.log('\n=== Итог: формулы по числу совпавших пар ===');
  if (!ranked.length) console.log('Ни одна формула не подошла. Пришлите вывод выше (особенно блок «последние точки»).');
  for (const [label, set] of ranked) console.log(`${set.size}/${pairs.length}  ${label}`);
  console.log('\nПропишите в .env: REF_FIELD, REF_MODE, REF_POINTS (число точек), REF_SKIP_LAST (0 или 1).');
}

// ───────────────────────── Запуск ─────────────────────────
function requireTelegram() {
  if (CFG.dryRun) return;
  if (!CFG.tgToken || !CFG.tgChat) throw new Error('Заполните TG_TOKEN и TG_CHAT_ID в .env (или запустите с DRY_RUN=1)');
}

async function main() {
  const argv = process.argv.slice(2);
  const state = loadState();

  if (argv[0] === '--calibrate') {
    if (argv.length < 2) throw new Error('Пример: node bot.js --calibrate 1599:1799 51.78:66.47');
    const [data, names] = await Promise.all([getData(state), loadNames()]);
    return calibrate(data, names, argv.slice(1));
  }
  if (argv[0] === '--dump') {
    const data = await getData(state);
    const ids = argv.slice(1).map(Number);
    const out = {};
    for (const [id, pts] of data) if (!ids.length || ids.includes(id)) out[id] = pts;
    fs.writeFileSync('dump.json', JSON.stringify(out, null, 1));
    log(`dump.json: ${Object.keys(out).length} предметов`);
    return;
  }
  if (argv[0] === '--find') {
    const q = argv.slice(1).join(' ').toLowerCase();
    const names = await loadNames();
    let n = 0;
    for (const [id, name] of names) if (name.toLowerCase().includes(q)) console.log(id, name), n++;
    if (!n) console.log('Ничего не найдено (названия не загружены или нет совпадений).');
    return;
  }
  if (argv[0] === '--test') {
    requireTelegram();
    await tgSend('✅ Бот Crossout: тестовое сообщение');
    return log('Отправлено');
  }

  requireTelegram();
  const names = await loadNames();

  if (argv[0] === '--once') {
    try {
      await cycle(names, state);
    } catch (e) {
      // в режиме «по расписанию» (GitHub Actions / Планировщик) ошибки тоже должны доходить до Telegram
      log('Ошибка цикла:', e.message);
      await alertError(e, state);
    }
    return;
  }

  log(
    `Старт. MIN_PROFIT=${CFG.minProfit}, интервал ${CFG.intervalMin} мин, повтор через ${CFG.realertHours} ч, ` +
      `эталон: ${CFG.ref.field}.${CFG.ref.mode} по ${CFG.ref.count} точкам${CFG.ref.skipLast ? ' без текущей' : ''}`
  );
  try {
    await tgSend(`🤖 Бот Crossout запущен. Порог прибыли: ${CFG.minProfit}, проверка каждые ${CFG.intervalMin} мин.`);
  } catch (e) {
    log('Стартовое сообщение не отправлено:', e.message);
  }

  for (;;) {
    try {
      await cycle(names, state);
    } catch (e) {
      log('Ошибка цикла:', e.message);
      await alertError(e, state);
    }
    await sleep(CFG.intervalMin * 60_000 * (0.85 + Math.random() * 0.3)); // небольшой джиттер
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

main().catch((e) => {
  console.error('Фатальная ошибка:', e.message);
  process.exit(1);
});
