'use strict';

/**
 * App-Feedback (Mitglieder -> Team-Backend -> Entwicklung).
 * ---------------------------------------------------------
 * Mitglieder geben über ein Banner auf der Startseite Feedback ab. Mitgeschickt
 * werden NUR technische, für Fehlerbehebung nötige Angaben (Plattform, grobe
 * Geräte-/OS-Kennung, aktueller Screen, App-Version, Viewport) – ANONYM: KEIN
 * Name, KEINE Mitgliedsnummer, KEINE E-Mail, KEINE memberId, KEINE IP. Der
 * Absender wird beim Speichern bewusst NICHT mit dem Feedback verknüpft.
 *
 * Speichermodell (Upstash/Redis, studioweit – KEIN Personenbezug):
 *   fb:index        Set der Feedback-IDs
 *   fb:item:<id>    Ein Feedback (JSON)
 *
 * Die ID ist zeit-sortierbar (Millis-Präfix), damit „neueste zuerst" und das
 * Kappen alter Einträge ohne Zusatzdaten funktionieren. No-Op ohne Store; wirft nie.
 */

const crypto = require('crypto');
const { redisPipeline, hasStore } = require('./store');

const IDX_KEY = 'fb:index';
const ITEM = (id) => 'fb:item:' + id;
const CAP = 500;                    // maximal gespeicherte Feedbacks (älteste werden gekappt)

const CATEGORIES = ['bug', 'idee', 'lob', 'sonstiges'];
const STATUSES = ['new', 'done'];
// Nur diese technischen Meta-Felder werden übernommen (Whitelist). Alles andere wird verworfen.
const META_KEYS = ['platform', 'appMode', 'screen', 'appVersion', 'build', 'os', 'device', 'ua', 'viewport', 'lang', 'dpr', 'online', 'theme'];

// Steuerzeichen (0..31, 127) neutralisieren -> Space. keepNewlines behält Tab (9) und Zeilenumbruch (10).
function stripCtl(v, keepNewlines) {
  const s = String(v == null ? '' : v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 32 && !(keepNewlines && (c === 9 || c === 10))) || c === 127) { out += ' '; continue; }
    out += s.charAt(i);
  }
  return out;
}
// Kurzfelder (Meta): Steuerzeichen raus, Whitespace zu einem Space, kappen.
function str(v, max) { return stripCtl(v, false).replace(/\s+/g, ' ').trim().slice(0, max || 200); }
// Freitext (Feedback): Steuerzeichen raus, Zeilenumbrüche erhalten, kappen.
function textField(v, max) {
  return stripCtl(String(v == null ? '' : v).replace(/\r\n?/g, '\n'), true)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max || 2000);
}

function nowMs() { return Date.now(); }
function newId() { return String(nowMs()).padStart(14, '0') + '-' + crypto.randomBytes(4).toString('hex'); }
function tsOfId(id) { const n = parseInt(String(id || '').slice(0, 14), 10); return isFinite(n) ? n : 0; }

// Technische Meta anonymisiert säubern: nur Whitelist, gekappt, keine Freitextfelder mit PII.
function sanitizeMeta(meta) {
  meta = meta && typeof meta === 'object' ? meta : {};
  const out = {};
  META_KEYS.forEach((k) => {
    if (meta[k] == null || meta[k] === '') return;
    if (k === 'online') { out.online = !!meta.online; return; }
    if (k === 'dpr') { const n = parseFloat(meta.dpr); if (isFinite(n)) out.dpr = Math.round(n * 100) / 100; return; }
    out[k] = str(meta[k], k === 'ua' ? 300 : 80);
  });
  return out;
}

// Ein sauberes Feedback-Objekt aus der Client-Eingabe bauen (server-autoritativ).
function buildRecord(input) {
  input = input || {};
  let category = String(input.category || 'sonstiges').toLowerCase();
  if (CATEGORIES.indexOf(category) < 0) category = 'sonstiges';
  return {
    id: newId(),
    ts: nowMs(),
    category: category,
    text: textField(input.text, 2000),
    meta: sanitizeMeta(input.meta),
    status: 'new',
    doneAt: null,
  };
}

async function submit(input) {
  const rec = buildRecord(input);
  if (!rec.text) return { ok: false, error: 'empty' };
  if (!hasStore) return { ok: false, disabled: true };
  try {
    await redisPipeline([['SET', ITEM(rec.id), JSON.stringify(rec)], ['SADD', IDX_KEY, rec.id]]);
    prune().catch(() => {});   // best-effort, nicht blockierend
    return { ok: true, id: rec.id };
  } catch (e) { return { ok: false, error: 'store_failed' }; }
}

// Älteste Einträge über der Obergrenze entfernen.
async function prune() {
  if (!hasStore) return;
  let ids = [];
  try { const [r] = await redisPipeline([['SMEMBERS', IDX_KEY]]); ids = Array.isArray(r) ? r : []; } catch (e) { return; }
  if (ids.length <= CAP) return;
  ids.sort((a, b) => tsOfId(a) - tsOfId(b));               // ältestes zuerst
  const drop = ids.slice(0, ids.length - CAP);
  const cmds = [];
  drop.forEach((id) => { cmds.push(['DEL', ITEM(id)]); cmds.push(['SREM', IDX_KEY, id]); });
  try { await redisPipeline(cmds); } catch (e) {}
}

async function list(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 200, CAP));
  if (!hasStore) return { items: [], total: 0, open: 0 };
  let ids = [];
  try { const [r] = await redisPipeline([['SMEMBERS', IDX_KEY]]); ids = Array.isArray(r) ? r : []; } catch (e) { return { items: [], total: 0, open: 0 }; }
  ids.sort((a, b) => tsOfId(b) - tsOfId(a));               // neueste zuerst
  const total = ids.length;
  const pick = ids.slice(0, limit);
  let vals = [];
  try { vals = pick.length ? await redisPipeline(pick.map((id) => ['GET', ITEM(id)])) : []; } catch (e) { vals = []; }
  const items = [];
  let open = 0;
  (vals || []).forEach((v, i) => {
    if (!v) return;
    let o; try { o = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return; }
    if (!o || !o.id) o = Object.assign({ id: pick[i] }, o || {});
    items.push(o);
  });
  items.forEach((o) => { if (o.status !== 'done') open++; });
  return { items: items, total: total, open: open };
}

async function setStatus(id, status) {
  if (!hasStore) return { ok: false, disabled: true };
  status = STATUSES.indexOf(String(status)) >= 0 ? String(status) : 'new';
  let o = null;
  try { const [v] = await redisPipeline([['GET', ITEM(id)]]); o = v ? (typeof v === 'string' ? JSON.parse(v) : v) : null; } catch (e) {}
  if (!o) return { ok: false, error: 'not_found' };
  o.status = status;
  o.doneAt = status === 'done' ? nowMs() : null;
  try { await redisPipeline([['SET', ITEM(id), JSON.stringify(o)]]); return { ok: true, item: o }; } catch (e) { return { ok: false, error: 'store_failed' }; }
}

async function remove(id) {
  if (!hasStore) return { ok: false, disabled: true };
  try { await redisPipeline([['DEL', ITEM(id)], ['SREM', IDX_KEY, id]]); return { ok: true }; } catch (e) { return { ok: false, error: 'store_failed' }; }
}

module.exports = {
  hasStore, CATEGORIES, STATUSES, META_KEYS, CAP,
  sanitizeMeta, buildRecord, submit, list, setStatus, remove, prune,
};
