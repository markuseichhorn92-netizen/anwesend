'use strict';

/**
 * FINN – schlanker KV-Adapter.
 * -----------------------------------------------------------------------------
 * Produktion: Upstash über lib/store.redisPipeline (wie der ganze Bestand).
 * Ohne KV in Nicht-Produktion (Tests, lokale Entwicklung): In-Memory-Fallback,
 * damit Bestätigungen, Audit und Event-Dedup testbar sind.
 * Ohne KV in Produktion: `available() === false` – Aufrufer müssen fail-closed
 * reagieren (z. B. keine Bestätigung ausstellen, die niemand mehr einlösen kann).
 *
 * Alle Funktionen werfen nie; Fehler -> null/false.
 */

const Store = require('../store');
const { isProduction } = require('./util');

const mem = new Map();          // key -> { v, exp }
const memLists = new Map();     // key -> { arr, exp }

function memMode() { return !Store.hasStore && !isProduction(); }
function available() { return Store.hasStore || memMode(); }
function mode() { return Store.hasStore ? 'kv' : (memMode() ? 'memory' : 'none'); }

function alive(e) { return e && (!e.exp || e.exp > Date.now()); }
function ttlExp(ttl) { return ttl ? Date.now() + ttl * 1000 : 0; }

async function get(key) {
  if (Store.hasStore) { try { const [v] = await Store.redisPipeline([['GET', key]]); return v == null ? null : v; } catch (e) { return null; } }
  if (!memMode()) return null;
  const e = mem.get(key); if (!alive(e)) { mem.delete(key); return null; } return e.v;
}
async function getJSON(key) { const v = await get(key); if (v == null) return null; try { return JSON.parse(v); } catch (e) { return null; } }
// Mehrere Schlüssel in EINEM Aufruf (MGET) – spart bei 30 Scopes 30 Round-Trips.
async function mgetJSON(keys) {
  keys = Array.isArray(keys) ? keys : [];
  if (!keys.length) return [];
  const parse = (v) => { if (v == null) return null; try { return JSON.parse(v); } catch (e) { return null; } };
  if (Store.hasStore) { try { const [r] = await Store.redisPipeline([['MGET'].concat(keys)]); return (Array.isArray(r) ? r : []).map(parse); } catch (e) { return keys.map(() => null); } }
  const out = []; for (const k of keys) out.push(parse(await get(k))); return out;
}

// set(key, value, ttlSec, { nx:true }) -> true wenn gesetzt, false wenn NX verhinderte, null bei Fehler.
async function set(key, value, ttlSec, opts) {
  opts = opts || {};
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (Store.hasStore) {
    const cmd = ['SET', key, v]; if (ttlSec) cmd.push('EX', String(ttlSec)); if (opts.nx) cmd.push('NX');
    try { const [r] = await Store.redisPipeline([cmd]); return opts.nx ? (r === 'OK' || r === true) : true; } catch (e) { return null; }
  }
  if (!memMode()) return null;
  const cur = mem.get(key);
  if (opts.nx && alive(cur)) return false;
  mem.set(key, { v: v, exp: ttlExp(ttlSec) }); return true;
}
async function del(key) {
  if (Store.hasStore) { try { await Store.redisPipeline([['DEL', key]]); return true; } catch (e) { return false; } }
  if (!memMode()) return false;
  mem.delete(key); memLists.delete(key); return true;
}
async function incr(key, ttlSec) {
  if (Store.hasStore) {
    try { const cmds = [['INCR', key]]; if (ttlSec) cmds.push(['EXPIRE', key, String(ttlSec)]); const r = await Store.redisPipeline(cmds); return Number(r[0]) || 0; } catch (e) { return null; }
  }
  if (!memMode()) return null;
  const e = mem.get(key); const n = (alive(e) ? Number(e.v) || 0 : 0) + 1;
  mem.set(key, { v: String(n), exp: alive(e) && e.exp ? e.exp : ttlExp(ttlSec) }); return n;
}
// Liste: neueste zuerst, auf cap gekappt.
async function lpush(key, value, cap, ttlSec) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (Store.hasStore) {
    try {
      const cmds = [['LPUSH', key, v]]; if (cap) cmds.push(['LTRIM', key, '0', String(cap - 1)]); if (ttlSec) cmds.push(['EXPIRE', key, String(ttlSec)]);
      await Store.redisPipeline(cmds); return true;
    } catch (e) { return false; }
  }
  if (!memMode()) return false;
  let e = memLists.get(key); if (!alive(e)) e = { arr: [], exp: ttlExp(ttlSec) };
  e.arr.unshift(v); if (cap && e.arr.length > cap) e.arr.length = cap; memLists.set(key, e); return true;
}
async function lrange(key, start, stop) {
  if (Store.hasStore) { try { const [r] = await Store.redisPipeline([['LRANGE', key, String(start || 0), String(stop == null ? -1 : stop)]]); return Array.isArray(r) ? r : []; } catch (e) { return []; } }
  if (!memMode()) return [];
  const e = memLists.get(key); if (!alive(e)) return [];
  const s = start || 0, en = stop == null || stop < 0 ? e.arr.length : stop + 1;
  return e.arr.slice(s, en);
}
async function lrangeJSON(key, start, stop) {
  return (await lrange(key, start, stop)).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}
async function sadd(key, member, ttlSec) {
  if (Store.hasStore) { try { const cmds = [['SADD', key, member]]; if (ttlSec) cmds.push(['EXPIRE', key, String(ttlSec)]); await Store.redisPipeline(cmds); return true; } catch (e) { return false; } }
  if (!memMode()) return false;
  let e = mem.get(key); if (!alive(e) || !Array.isArray(e.v)) e = { v: [], exp: ttlExp(ttlSec) };
  if (e.v.indexOf(member) < 0) e.v.push(member); mem.set(key, e); return true;
}
async function smembers(key) {
  if (Store.hasStore) { try { const [r] = await Store.redisPipeline([['SMEMBERS', key]]); return Array.isArray(r) ? r : []; } catch (e) { return []; } }
  if (!memMode()) return [];
  const e = mem.get(key); return alive(e) && Array.isArray(e.v) ? e.v.slice() : [];
}

// Nur für Tests: In-Memory-Zustand leeren.
function _reset() { mem.clear(); memLists.clear(); }

module.exports = { available, mode, get, getJSON, mgetJSON, set, del, incr, lpush, lrange, lrangeJSON, sadd, smembers, _reset };
