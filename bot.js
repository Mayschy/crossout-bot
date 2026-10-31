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
 *   node bot.js --report             — сводка по журналу сигналов (journal/report.md)
 */

const fs = require('node:fs');
const path = require('node:path');
const mongo = require('./db'); // MongoDB: необязательно, без MONGODB_URI тихо отключается

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
  shadowMinProfit: num('SHADOW_MIN_PROFIT', 10),
  capitalBudget: num('CAPITAL_BUDGET', 10000), // оценка доли капитала, не торговый лимит
  minRoi: num('MIN_ROI', 0), // %
  minBuyOrders: num('MIN_BUY_ORDERS', 0), // последнее значение bo

  // расписание / дедупликация
  intervalMin: num('INTERVAL_MIN', 4),
  realertHours: num('REALERT_HOURS', 3),
  // история за 14 дней (Server Action с телом {itemIds, days}) — для медианы, спроса и оборота
  histOn: process.env.HIST !== '0',
  histDays: num('HIST_DAYS', 14),
  histActionId: process.env.HIST_ACTION_ID || '408d8a297ceba3e19a948d5049e80416ba20e188bf',
  cardsPerRun: num('CARDS_PER_RUN', 5), // сколько полноценных карточек слать за запуск, остальное — одним списком
  alertAfterFails: num('ALERT_AFTER_FAILS', 3), // в режиме --once: сколько запусков подряд должны упасть, прежде чем слать ⚠️
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

const UA = 'Mozilla/5.0 (X11; Linux x86_64) personal-crossout-flash-bot/1.0';

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
  // 403/429/5xx часто временные (защита сайта, смена адреса раннера GitHub): пробуем до 3 раз с паузой
  let status;
  let text;
  for (let attempt = 1; attempt <= 3; attempt++) {
    ({ status, text } = await callAction(actionId, []));
    const temporary = status === 403 || status === 429 || status >= 500;
    if (!temporary) break;
    if (attempt < 3) {
      log(`Сайт ответил HTTP ${status}, повтор ${attempt}/2 через 20 с`);
      await sleep(20_000);
    }
  }
  if (status === 403) throw new Error('Сайт ответил HTTP 403 (доступ отклонён: возможна блокировка адреса или защита от ботов)');
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
  // активность рынка: сколько раз за последний час менялись цены/лоты/заказы
  const recent = pts.slice(-12);
  let act = 0;
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1];
    const b = recent[i];
    if (a.s !== b.s || a.b !== b.b || a.so !== b.so || a.bo !== b.bo) act++;
  }
  const sv = pts.map((p) => p.s).filter((v) => v > 0);
  return {
    t: last.t,
    sale: last.s,
    ref,
    profit,
    roi: (profit / last.s) * 100,
    so: last.so,
    bo: last.bo,
    buy: last.b,
    act,
    lo: Math.min(...sv),
    hi: Math.max(...sv),
  };
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

const ICON_DIR = path.join(__dirname, 'icons'); // кэш иконок: каждую качаем один раз

/** Иконка предмета: сначала из кэша на диске, иначе скачиваем (3 попытки) и сохраняем */
async function fetchIcon(id) {
  const ext = sharp ? 'jpg' : 'webp';
  const type = sharp ? 'image/jpeg' : 'image/webp';
  const file = path.join(ICON_DIR, `${id}.${ext}`);
  try {
    if (fs.existsSync(file)) return { buf: fs.readFileSync(file), type, ext };
  } catch {
    /* кэш повреждён — качаем заново */
  }
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(CFG.imageTpl.replace('{id}', id), {
        headers: { 'user-agent': UA, referer: CFG.pageUrl, accept: 'image/*' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let buf = Buffer.from(await r.arrayBuffer());
      if (sharp) buf = await sharp(buf).resize(320, 320, { fit: 'contain', background: '#1a1a1a' }).jpeg({ quality: 85 }).toBuffer();
      try {
        fs.mkdirSync(ICON_DIR, { recursive: true });
        fs.writeFileSync(file, buf);
      } catch {
        /* не удалось сохранить в кэш — не страшно */
      }
      return { buf, type, ext };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  const cause = lastErr.cause ? ` [${lastErr.cause.code || lastErr.cause.message}]` : '';
  log(`Иконка #${id} не загружена: ${lastErr.message}${cause}`);
  return null;
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

// ───────────────────────── История за N дней (медиана, спрос, оборот) ─────────────────────────
const HIST_TREE =
  '%5B%22%22%2C%7B%22children%22%3A%5B%5B%22locale%22%2C%22ru%22%2C%22d%22%2Cnull%5D%2C%7B%22children%22%3A%5B%22(app)%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C16%5D%7D%2Cnull%2Cnull%2C0%5D';

/** Ответ RSC: строка `1:{"567":[{t,s,b,so,bo},...]}` → Map<id, Point[]> (работает и для одного предмета) */
function parseHistoryLoose(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^[0-9a-zA-Z]+:(\{.*)$/.exec(line);
    if (!m) continue;
    let o;
    try {
      o = JSON.parse(m[1]);
    } catch {
      continue;
    }
    for (const [k, arr] of Object.entries(o)) {
      const id = Number(k);
      if (!Number.isFinite(id) || !Array.isArray(arr) || !arr.length || typeof arr[0] !== 'object') continue;
      const pts = arr
        .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(Number(p.s)))
        .map((p) => ({ t: p.t, s: Number(p.s) || 0, b: Number(p.b) || 0, so: Number(p.so) || 0, bo: Number(p.bo) || 0 }))
        .sort((x, y) => x.t - y.t);
      if (pts.length) out.set(id, pts);
    }
  }
  return out;
}

async function fetchHistory(ids, days) {
  const origin = new URL(CFG.pageUrl).origin;
  const res = await fetch(origin + '/', {
    method: 'POST',
    headers: {
      accept: 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': CFG.histActionId,
      'next-router-state-tree': HIST_TREE,
      origin,
      referer: origin + '/',
      'user-agent': UA,
    },
    body: JSON.stringify([{ itemIds: ids, days, aggregationMinutes: '$undefined' }]),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseHistoryLoose(await res.text());
}

/** Статистика за период относительно текущей цены продажи */
function histStats(pts, sale) {
  const arr = pts.filter((p) => p.s > 0);
  if (arr.length < 288) return null; // меньше суток данных — нечего считать
  const vals = arr.map((p) => p.s).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  const med = q(0.5);
  const days = Math.max(1, (arr[arr.length - 1].t - arr[0].t) / 86_400);
  let gone = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i].so < arr[i - 1].so) gone++;
  const bos = arr.map((p) => p.bo).sort((a, b) => a - b);
  return {
    days: Math.round(days),
    med,
    p25: q(0.25),
    p75: q(0.75),
    below: ((med - sale) / med) * 100, // насколько текущая цена ниже медианы
    pctAbove: (vals.filter((v) => v > sale).length / vals.length) * 100, // доля времени, когда цена была выше текущей
    gonePerDay: gone / days, // сколько раз в сутки уменьшалось число лотов (продажа или снятие)
    demand: (arr.filter((p) => p.bo > 0).length / arr.length) * 100, // доля времени, когда были заказы на покупку
    medBo: bos[Math.floor(bos.length / 2)],
    profitMed: med * CFG.fee - sale,
  };
}

/** Дополняем предметы данными за период (одним запросом; если не вышло — пропускаем, бот работает как раньше) */
async function enrichWithHistory(items) {
  if (!CFG.histOn || !items.length) return;
  try {
    const ids = items.map((f) => f.id);
    let map = await fetchHistory(ids, CFG.histDays);
    for (const id of ids) {
      if (map.has(id)) continue;
      try {
        const one = await fetchHistory([id], CFG.histDays); // запасной путь: по одному
        if (one.has(id)) map.set(id, one.get(id));
      } catch {
        /* пропускаем */
      }
    }
    for (const f of items) {
      const pts = map.get(f.id);
      f.h = pts ? histStats(pts, f.sale) : null;
    }
  } catch (e) {
    log(`История за ${CFG.histDays} дн. недоступна: ${e.message}`);
    jEvent(`HIST недоступна: ${e.message} (возможно, изменился next-action ID)`);
  }
}

/** Оценка ликвидности 0–100 (эвристика: покупатели, активность рынка, выгода мгновенной продажи; с историей — ещё оборот и стабильность спроса) */
function liquidity(f) {
  let sc = 0;
  sc += f.bo >= 8 ? 40 : f.bo >= 4 ? 30 : f.bo >= 1 ? 15 : 0;
  sc += f.act >= 6 ? 30 : f.act >= 3 ? 20 : f.act >= 1 ? 10 : 0;
  const exit = f.buy > 0 ? (f.buy * CFG.fee) / f.sale : 0;
  sc += exit >= 1 ? 30 : exit >= 0.9 ? 20 : exit >= 0.8 ? 10 : 0;
  if (f.h) {
    const hs = (f.h.gonePerDay >= 10 ? 15 : f.h.gonePerDay >= 3 ? 8 : 0) + (f.h.demand >= 90 ? 15 : f.h.demand >= 60 ? 8 : 0);
    sc = Math.round(sc * 0.7 + hs);
  }
  if (f.bo === 0) sc = Math.min(sc, 25);
  const icon = sc >= 70 ? '🟢' : sc >= 40 ? '🟡' : '🔴';
  const label = sc >= 70 ? 'высокая' : sc >= 40 ? 'средняя' : 'низкая';
  const filled = Math.round(sc / 10);
  return { score: sc, icon, label, bar: '▰'.repeat(filled) + '▱'.repeat(10 - filled) };
}

/** Полная карточка предмета (подпись к фото ≤ 1024 символов) */
function card(f, names) {
  const liq = liquidity(f);
  const drop = ((f.ref - f.sale) / f.ref) * 100;
  const instant = f.buy > 0 ? f.buy * CFG.fee - f.sale : null;
  const link = CFG.itemLinkTpl ? CFG.itemLinkTpl.replace('{id}', f.id) : '';
  const nm = esc(nameOf(names, f.id));
  const title = link ? `<a href="${esc(link)}">${nm}</a>` : nm;
  const lines = [
    `🔻 <b>${title}</b>  <code>#${f.id}</code>`,
    '',
    `💸 Купить сейчас: <b>${f2(f.sale)}</b>`,
    `🎯 Эталон (${CFG.ref.count * 5} мин): ${f2(f.ref)}  (<b>−${drop.toFixed(1)}%</b>)`,
    `💰 Прибыль: <b>+${f2(f.profit)}</b>  ·  ROI <b>${f2(f.roi)}%</b>`,
  ];
  if (instant !== null) lines.push(`⚡ Сразу в заказ (${f2(f.buy)}): ${instant >= 0 ? '+' : ''}${f2(instant)}`);
  lines.push(
    '',
    `📦 Предложений: <b>${f.so}</b>  ·  🛒 Покупателей: <b>${f.bo}</b>`,
    `🧭 Ликвидность: ${liq.icon} ${liq.bar} ${liq.score}/100 (${liq.label})`,
    `📈 За 2 ч: ${f2(f.lo)} – ${f2(f.hi)}`
  );
  if (f.h) {
    const h = f.h;
    lines.push(
      `📅 За ${h.days} дн: медиана <b>${f2(h.med)}</b> · сейчас ${h.below >= 0 ? '−' : '+'}${Math.abs(h.below).toFixed(1)}% от неё`,
      `   дешевле текущей цена была лишь в ${(100 - h.pctAbove).toFixed(0)}% времени`,
      `💎 Прибыль к медиане: <b>${h.profitMed >= 0 ? '+' : ''}${f2(h.profitMed)}</b>`,
      `🔁 Лотов уходит ~${h.gonePerDay.toFixed(1)}/сут · спрос есть в ${h.demand.toFixed(0)}% времени`
    );
  }
  const warn = [];
  if (f.h && f.h.below < 3) warn.push(`ℹ️ Цена не ниже ${f.h.days}-дневной медианы — похоже на норму, а не на обвал`);
  if (f.h && f.h.demand < 50) warn.push(`⚠️ Спрос нерегулярный: заказы на покупку есть лишь в ${f.h.demand.toFixed(0)}% времени`);
  if (f.h && f.h.gonePerDay < 1) warn.push(`ℹ️ Лоты уходят редко (~${f.h.gonePerDay.toFixed(1)}/сут): продавать придётся долго`);
  if (f.bo === 0) warn.push('⚠️ <b>Нет заказов на покупку</b> — быстро продать не получится');
  if (f.roi > 100) warn.push('⚠️ ROI выше 100% — похоже на аномалию или «ловушку», проверь цены на сайте');
  if (f.so <= 2) warn.push('ℹ️ Мало лотов — цена может быть случайной');
  if (warn.length) lines.push('', ...warn);
  return lines.join('\n');
}

/** Короткая строка для списка «ещё N предметов» */
function compactItem(f, names) {
  const liq = liquidity(f);
  return (
    `${liq.icon} <b>${esc(nameOf(names, f.id))}</b> <code>#${f.id}</code>  ` +
    `${f2(f.sale)} → ${f2(f.ref)} · <b>+${f2(f.profit)}</b> · ${f2(f.roi)}% · 🛒${f.bo} · 📦${f.so}`
  );
}

// ───────────────────────── Журнал сигналов и результатов ─────────────────────────
// Файлы (только дописываются, поэтому хорошо хранятся в git):
//   signals.jsonl  — каждое отправленное уведомление (цены, ликвидность, время)
//   outcomes.jsonl — что стало с ценой через 30/60/120 минут после сигнала
//   events.log     — человекочитаемый журнал событий (сигналы, итоги, ошибки, отчёты)
//   report.md      — сводка (обновляется при изменениях)
const JOURNAL_ON = process.env.JOURNAL !== '0';
const JDIR = path.resolve(__dirname, process.env.JOURNAL_DIR || 'journal');
const SIG_FILE = path.join(JDIR, 'signals.jsonl');
const SHADOW_FILE = path.join(JDIR, 'shadow.jsonl');
const OUT_FILE = path.join(JDIR, 'outcomes.jsonl');
const EVT_FILE = path.join(JDIR, 'events.log');
const REPORT_FILE = path.join(JDIR, 'report.md');
const HORIZONS = [10, 20, 30, 60, 120]; // минут после сигнала
const REPORT_ON = process.env.REPORT !== '0';
const REPORT_TZ = 'Europe/Kyiv';
const REPORT_HOUR_LOCAL = num('REPORT_HOUR_LOCAL', 10);
let journalDirty = false;

function jAppend(file, line) {
  fs.mkdirSync(JDIR, { recursive: true });
  fs.appendFileSync(file, line + '\n');
}

// Копия записи в MongoDB. Не блокирует цикл; ошибки базы не роняют бота (JSONL остаётся основным).
const dbPending = [];
function dbSave(collection, rec, extra) {
  dbPending.push(mongo.save(collection, [rec], extra).catch((e) => log('MongoDB:', e.message)));
}
async function dbFlush(close = false) {
  await Promise.allSettled(dbPending.splice(0));
  if (close) await mongo.close();
}

function jRead(file, tailBytes = 0) {
  try {
    const st = fs.statSync(file);
    let txt;
    if (tailBytes && st.size > tailBytes) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(tailBytes);
      fs.readSync(fd, buf, 0, tailBytes, st.size - tailBytes);
      fs.closeSync(fd);
      txt = buf.toString('utf8');
      txt = txt.slice(txt.indexOf('\n') + 1); // отбрасываем обрезанную первую строку
    } else {
      txt = fs.readFileSync(file, 'utf8');
    }
    return txt
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function jEvent(msg) {
  if (!JOURNAL_ON) return;
  try {
    jAppend(EVT_FILE, `${new Date().toISOString()} ${String(msg).replace(/\s+/g, ' ').slice(0, 400)}`);
  } catch {
    /* журнал не должен ронять бота */
  }
}

function signalRecord(f, names, t = Date.now()) {
  const liq = liquidity(f);
  return {
    id: f.id, name: nameOf(names, f.id), t, sale: f.sale, ref: f.ref,
    profit: Number(f2(f.profit)), roi: Number(f2(f.roi)),
    bo: f.bo, so: f.so, buy: f.buy, act: f.act, liq: liq.score,
    med: f.h ? Number(f2(f.h.med)) : null,
    below: f.h ? Number(f.h.below.toFixed(1)) : null,
    gone: f.h ? Number(f.h.gonePerDay.toFixed(1)) : null,
    dem: f.h ? Number(f.h.demand.toFixed(0)) : null,
  };
}

function jSignal(f, names) {
  if (!JOURNAL_ON) return;
  try {
    const rec = signalRecord(f, names);
    jAppend(SIG_FILE, JSON.stringify(rec));
    dbSave('signals', { ...rec, ctx: f.ctx }, { _kind: 'normal' });
    jEvent(`SIGNAL #${f.id} ${rec.name}: купить ${f2(f.sale)}, эталон ${f2(f.ref)}, прибыль ${f2(f.profit)}, ликвидность ${rec.liq}`);
    journalDirty = true;
  } catch (e) { log('Журнал (сигнал):', e.message); }
}

// Теневые кандидаты не отправляются в Telegram. Один эпизод на предмет в REALERT_HOURS.
// Повтор при новом существенном падении (ещё >= 3%) допускается как новый эпизод.
function jShadows(found, names, state) {
  if (!JOURNAL_ON) return;
  state.shadowSeen = state.shadowSeen || {};
  const now = Date.now();
  const cooldown = Math.max(1, CFG.realertHours) * 3_600_000;
  for (const f of found) {
    if (f.profit < CFG.shadowMinProfit || f.profit >= CFG.minProfit) continue;
    const prev = state.shadowSeen[f.id];
    if (prev && now - prev.t < cooldown && f.sale >= prev.sale * 0.97) continue;
    try {
      const rec = { ...signalRecord(f, names, now), shadow: true };
      jAppend(SHADOW_FILE, JSON.stringify(rec));
      dbSave('signals', { ...rec, ctx: f.ctx }, { _kind: 'shadow' });
      state.shadowSeen[f.id] = { t: now, sale: f.sale };
      journalDirty = true;
    } catch (e) { log('Журнал (теневой сигнал):', e.message); }
  }
  for (const [id, v] of Object.entries(state.shadowSeen)) if (now - v.t > 2 * 86_400_000) delete state.shadowSeen[id];
}

function allSignals(tailBytes = 0) {
  return [...jRead(SIG_FILE, tailBytes), ...jRead(SHADOW_FILE, tailBytes)];
}

/** Для сигналов последних ~3 часов дописываем итоги через 30/60/120 минут, по истории цен с сайта */
function jOutcomes(data) {
  if (!JOURNAL_ON) return;
  try {
    const now = Date.now();
    const sigs = allSignals(500_000).filter((r) => now - r.t < 3 * 3_600_000);
    if (!sigs.length) return;
    const done = new Set(jRead(OUT_FILE, 300_000).map((o) => `${o.id}:${o.t}:${o.h}`));
    for (const r of sigs) {
      const pts = data.get(r.id);
      if (!pts || !pts.length) continue;
      for (const h of HORIZONS) {
        const key = `${r.id}:${r.t}:${h}`;
        const target = r.t + h * 60_000;
        if (done.has(key) || now < target) continue;
        let best = pts[pts.length - 1];
        let bestD = Infinity;
        for (const p of pts) {
          const d = Math.abs(p.t * 1000 - target);
          if (d < bestD) {
            best = p;
            bestD = d;
          }
        }
        const late = bestD > Math.min(12, Math.max(6, h / 2)) * 60_000; // ближайшая точка истории слишком далеко от нужного момента
        const out = {
          id: r.id,
          t: r.t,
          h,
          at: best.t * 1000,
          s: best.s,
          b: best.b,
          so: best.so,
          bo: best.bo,
          ask: Number((best.s * CFG.fee - r.sale).toFixed(2)), // продажа по минимальному лоту на тот момент
          instant: best.b > 0 ? Number((best.b * CFG.fee - r.sale).toFixed(2)) : null, // сразу в заказ на покупку
          taken: best.s > r.sale * 1.01, // цена поднялась, НЕ подтверждение продажи
          shadow: !!r.shadow,
          roi: Number(((best.s * CFG.fee / r.sale - 1) * 100).toFixed(2)),
          capital: r.sale,
          late,
        };
        jAppend(OUT_FILE, JSON.stringify(out));
        dbSave('outcomes', out);
        if (!r.shadow) jEvent(`OUTCOME #${r.id} через ${h} мин: цена ${f2(best.s)} (было ${f2(r.sale)}), по лоту ${out.ask >= 0 ? '+' : ''}${out.ask}${late ? ' [неточно]' : ''}`);
        journalDirty = true;
      }
    }
  } catch (e) {
    log('Журнал (итоги):', e.message);
  }
}

function jRows() {
  const sigs = allSignals();
  const by = new Map();
  for (const o of jRead(OUT_FILE)) if (!o.late) by.set(`${o.id}:${o.t}:${o.h}`, o);
  return sigs.map((s) => ({ ...s, o: Object.fromEntries(HORIZONS.map((h) => [h, by.get(`${s.id}:${s.t}:${h}`)])) }));
}

function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function jSummary(rows, h) {
  const valid = rows.filter((r) => r.o[h] && !r.o[h].late);
  const xs = valid.map((r) => r.o[h]);
  const rois = valid.map((r) => (r.o[h].ask / r.sale) * 100);
  const inst = valid.filter((r) => r.o[h].instant !== null);
  return {
    n: xs.length,
    unique: new Set(valid.map((r) => r.id)).size,
    taken: xs.length ? (xs.filter((o) => o.taken).length / xs.length) * 100 : null,
    roiMed: median(rois), roiMean: rois.length ? rois.reduce((a,b) => a+b,0)/rois.length : null,
    roiPos: rois.length ? rois.filter((v) => v > 0).length / rois.length * 100 : null,
    roiP25: rois.length ? [...rois].sort((a,b)=>a-b)[Math.floor((rois.length-1)*.25)] : null,
    roiP75: rois.length ? [...rois].sort((a,b)=>a-b)[Math.floor((rois.length-1)*.75)] : null,
    instPos: inst.length ? inst.filter((r) => r.o[h].instant > 0).length / inst.length * 100 : null,
    instN: inst.length,
  };
}
const pct = (v, digits=1) => v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
const nonneg = (v) => v === null ? '—' : `${v.toFixed(0)}%`;

function jReportHtml(state) {
  const rows = jRows();
  if (!rows.length) return null;
  const live = rows.filter((r) => !r.shadow);
  const shadows = rows.filter((r) => r.shadow);
  const local = new Intl.DateTimeFormat('ru-RU', { timeZone: REPORT_TZ, dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  const lines = [`📊 <b>Crossout — утренняя аналитика</b>`, `${local} (${REPORT_TZ})`,
    `Сигналы: <b>${live.length}</b> · теневые: <b>${shadows.length}</b> · уникальных предметов: <b>${new Set(rows.map(r=>r.id)).size}</b>`,
    `Пороги: Telegram ≥${CFG.minProfit} · тень ≥${CFG.shadowMinProfit} монет`, '',
    '<b>📈 Реальные уведомления: динамика цены</b>'];
  for (const h of HORIZONS) {
    const x = jSummary(live, h);
    lines.push(x.n ? `⏱ ${h}м (n=${x.n}): медиана ${pct(x.roiMed)} · плюс ${nonneg(x.roiPos)} · цена ушла вверх ${nonneg(x.taken)}` : `⏱ ${h}м: нет итогов`);
  }
  lines.push('', '<b>🔎 Теневые сигналы (без уведомлений)</b>');
  for (const h of [20, 60, 120]) {
    const x = jSummary(shadows, h);
    lines.push(x.n ? `${h}м (n=${x.n}): медиана ${pct(x.roiMed)} · плюс ${nonneg(x.roiPos)}` : `${h}м: пока нет итогов`);
  }
  lines.push('', '<b>💧 Ликвидность, результаты через час</b>');
  for (const [label, fn] of [['🟢 ≥70',r=>r.liq>=70],['🟡 40–69',r=>r.liq>=40 && r.liq<70],['🔴 ниже 40',r=>r.liq<40]]) {
    const x = jSummary(live.filter(fn),60);
    lines.push(x.n ? `${label} (n=${x.n}): медиана ${pct(x.roiMed)} · плюс ${nonneg(x.roiPos)}` : `${label}: данных пока нет`);
  }
  lines.push('', `<b>💰 Стоимость предмета, час (бюджет ${CFG.capitalBudget} монет)</b>`);
  for (const [label, fn] of [['До 500',r=>r.sale<500],['500–1499',r=>r.sale>=500&&r.sale<1500],['1500–2999',r=>r.sale>=1500&&r.sale<3000],['От 3000',r=>r.sale>=3000]]) {
    const x=jSummary(live.filter(fn),60);
    lines.push(x.n ? `${label} (n=${x.n}): медиана ${pct(x.roiMed)} · плюс ${nonneg(x.roiPos)}` : `${label}: данных нет`);
  }
  const relevant = live.filter(r => r.o[60] && !r.o[60].late);
  const expensive = relevant.filter(r => r.sale > CFG.capitalBudget * .3);
  lines.push(`Капитал >30% бюджета в одном предмете: ${expensive.length}/${relevant.length} сигналов`);
  const hour = jSummary(live,60);
  if (hour.n) lines.push(`Разброс ROI (час): P25 ${pct(hour.roiP25)} · медиана ${pct(hour.roiMed)} · P75 ${pct(hour.roiP75)}`);
  const prev=state && state.statsPrev;
  if(prev) lines.push(``, `🛠 Вчера: запусков ${prev.runs}, ошибок ${prev.fails}`);
  lines.push('', '<i>⚠️ Это не результат реальных сделок: условная продажа по минимальному лоту с комиссией 10%. Рост минимальной цены не доказывает исполнение заказа. Повторы предметов зависимы. Для массмаркета нет данных о фактическом объёме сделок.</i>');
  return lines.join('\n');
}

function jWriteReportMd(state) {
  const html = jReportHtml(state);
  if (!html) return;
  const md = html.replace(/<b>(.*?)<\/b>/g, '**$1**').replace(/<i>(.*?)<\/i>/g, '_$1_').replace(/<[^>]+>/g, '');
  const recent = jRows().sort((a,b)=>b.t-a.t).slice(0,40);
  const fmt = (o) => o && !o.late ? `${o.ask>=0?'+':''}${o.ask}` : '…';
  const table = ['| Время (UTC) | Тип | Предмет | Купить | ROI сигнала | Ликв. | 10 | 20 | 30 | 60 | 120 |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...recent.map(r=>`| ${new Date(r.t).toISOString().slice(5,16).replace('T',' ')} | ${r.shadow?'тень':'сигнал'} | ${r.name} #${r.id} | ${f2(r.sale)} | ${pct(r.roi)} | ${r.liq} | ${fmt(r.o[10])} | ${fmt(r.o[20])} | ${fmt(r.o[30])} | ${fmt(r.o[60])} | ${fmt(r.o[120])} |`)
  ].join('\n');
  fs.mkdirSync(JDIR,{recursive:true});
  fs.writeFileSync(REPORT_FILE,`# Журнал результатов\n\n${md}\n\n## Последние 40 наблюдений\n\n${table}\n`);
}

function bumpStats(state, ok) {
  const day = new Date().toISOString().slice(0, 10);
  if (!state.stats || state.stats.day !== day) {
    if (state.stats) state.statsPrev = state.stats;
    state.stats = { day, runs: 0, fails: 0 };
  }
  state.stats.runs++;
  if (!ok) state.stats.fails++;
  saveState(state);
}

async function maybeDailyReport(state) {
  if (!JOURNAL_ON || !REPORT_ON) return;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  if (state.lastReportDay === day || Number(get('hour')) < REPORT_HOUR_LOCAL) return;
  if (!jRows().some((r) => HORIZONS.some((h) => r.o[h]))) return;
  const html = jReportHtml(state);
  if (!html) return;
  try {
    await tgSend(html);
    state.lastReportDay = day;
    saveState(state);
    jEvent('REPORT отправлен в Telegram');
  } catch (e) { log('Отчёт не отправлен:', e.message); }
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
    if (r.profit >= Math.min(CFG.minProfit, CFG.shadowMinProfit) && r.roi >= CFG.minRoi && r.bo >= CFG.minBuyOrders) {
      // последние 24 точки (~2 ч) — только для MongoDB, в JSONL не пишем, чтобы не раздувать git
      const ctx = pts.slice(-24).map((p) => ({ t: p.t, s: p.s, b: p.b, so: p.so, bo: p.bo }));
      found.push({ id, ...r, ctx });
    }
  }

  const ageMin = (nowSec - newest) / 60;
  if (ageMin > CFG.maxDataAgeMin) {
    throw new Error(`Данные на сайте не обновлялись ${ageMin.toFixed(0)} мин — уведомления приостановлены`);
  }

  found.sort((a, b) => b.profit - a.profit);

  state.alerts = state.alerts || {};
  const now = Date.now();
  const realertMs = CFG.realertHours * 3_600_000;
  const notified = found.filter((f) => f.profit >= CFG.minProfit);
  const fresh = notified.filter((f) => !state.alerts[f.id] || now - state.alerts[f.id] > realertMs);

  log(`Предметов: ${data.size}, сигналы: ${notified.length}, тень: ${found.length-notified.length}, новых для уведомления: ${fresh.length}, возраст данных: ${ageMin.toFixed(1)} мин`);
  jShadows(found, names, state);

  jOutcomes(data); // итоги по прошлым сигналам

  const top = fresh.slice(0, CFG.cardsPerRun);
  const rest = fresh.slice(CFG.cardsPerRun);
  await enrichWithHistory(top); // история за 14 дней только для тех, что пойдут в карточки

  // отдельная красивая карточка (фото + подпись) на каждый из лучших предметов
  for (const f of top) {
    const text = card(f, names);
    const icon = CFG.images ? await fetchIcon(f.id) : null;
    try {
      if (!icon) throw new Error('нет иконки');
      await tgSendAlbum([{ id: f.id, icon }], text); // один элемент = обычный sendPhoto
    } catch (e) {
      log(`Фото не отправлено (${e.message}) — шлю текстом`);
      await tgSend(text);
    }
    state.alerts[f.id] = Date.now();
    jSignal(f, names);
    saveState(state);
    await sleep(1200); // лимит Telegram: ~1 сообщение в секунду в один чат
  }

  // остальное — одним сообщением со списком
  for (let i = 0; i < rest.length; i += 20) {
    const part = rest.slice(i, i + 20);
    await tgSend(`📋 <b>Ещё ${part.length} из ${rest.length}</b> (прибыль ≥ ${CFG.minProfit})\n\n` + part.map((f) => compactItem(f, names)).join('\n'));
    for (const f of part) {
      state.alerts[f.id] = Date.now();
      jSignal(f, names);
    }
    saveState(state);
  }

  if (journalDirty) {
    try {
      jWriteReportMd(state);
    } catch (e) {
      log('report.md:', e.message);
    }
    journalDirty = false;
  }
  await maybeDailyReport(state);

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
  if (argv[0] === '--report') {
    const html = jReportHtml(state);
    if (!html) return log('В журнале пока нет сигналов');
    jWriteReportMd(state);
    console.log(html.replace(/<[^>]+>/g, ''));
    return log(`Сводка записана: ${REPORT_FILE}`);
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
      if (state.failStreak) {
        jEvent(`RECOVERED после ${state.failStreak} неудачных запусков подряд`);
        state.failStreak = 0;
        saveState(state);
      }
      bumpStats(state, true);
    } catch (e) {
      state.failStreak = (state.failStreak || 0) + 1;
      saveState(state);
      bumpStats(state, false);
      jEvent(`ERROR (${state.failStreak} подряд): ${e.message}`);
      log(`Ошибка цикла (${state.failStreak} подряд):`, e.message);
      // разовые сбои не будят: алерт только после N неудачных запусков подряд
      if (state.failStreak >= CFG.alertAfterFails) await alertError(e, state);
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
      await dbFlush();
    } catch (e) {
      log('Ошибка цикла:', e.message);
      jEvent(`ERROR: ${e.message}`);
      await alertError(e, state);
    }
    await sleep(CFG.intervalMin * 60_000 * (0.85 + Math.random() * 0.3)); // небольшой джиттер
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

main()
  .then(() => dbFlush(true))
  .catch(async (e) => {
    console.error('Фатальная ошибка:', e.message);
    await dbFlush(true).catch(() => {});
    process.exit(1);
  });
