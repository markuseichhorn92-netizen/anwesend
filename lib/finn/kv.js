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
  mem.delete(key); memLists.delete(key); memZ.delete(key); memH.delete(key); return true;
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

async function srem(key, member) {
  if (Store.hasStore) { try { await Store.redisPipeline([['SREM', key, member]]); return true; } catch (e) { return false; } }
  if (!memMode()) return false;
  const e = mem.get(key); if (alive(e) && Array.isArray(e.v)) e.v = e.v.filter((x) => x !== member); return true;
}
async function expire(key, ttlSec) {
  if (Store.hasStore) { try { await Store.redisPipeline([['EXPIRE', key, String(ttlSec)]]); return true; } catch (e) { return false; } }
  if (!memMode()) return false;
  const e = mem.get(key) || memZ.get(key) || memH.get(key); if (e) e.exp = ttlExp(ttlSec); return true;
}

// ── Sortierte Mengen (Fälligkeiten, Index) ──
const memZ = new Map();         // key -> { m: Map(member -> score), exp }
function zget(key) { let e = memZ.get(key); if (!alive(e)) { e = { m: new Map(), exp: 0 }; memZ.set(key, e); } return e; }
function zsorted(key) { return Array.from(zget(key).m.entries()).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)); }

async function zadd(key, score, member) {
  if (Store.hasStore) { try { await Store.redisPipeline([['ZADD', key, String(score), String(member)]]); return true; } catch (e) { return false; } }
  if (!memMode()) return false;
  zget(key).m.set(String(member), Number(score)); return true;
}
async function zrem(key, member) {
  if (Store.hasStore) { try { await Store.redisPipeline([['ZREM', key, String(member)]]); return true; } catch (e) { return false; } }
  if (!memMode()) return false;
  zget(key).m.delete(String(member)); return true;
}
async function zscore(key, member) {
  if (Store.hasStore) { try { const [r] = await Store.redisPipeline([['ZSCORE', key, String(member)]]); return r == null ? null : Number(r); } catch (e) { return null; } }
  if (!memMode()) return null;
  const v = zget(key).m.get(String(member)); return v == null ? null : v;
}
async function zcard(key) {
  if (Store.hasStore) { try { const [r] = await Store.redisPipeline([['ZCARD', key]]); return Number(r) || 0; } catch (e) { return 0; } }
  if (!memMode()) return 0;
  return zget(key).m.size;
}
// Mitglieder mit min <= score <= max, aufsteigend, höchstens `limit`.
async function zrangeByScore(key, min, max, limit) {
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
  if (Store.hasStore) {
    try { const [r] = await Store.redisPipeline([['ZRANGEBYSCORE', key, String(min), String(max), 'LIMIT', '0', String(lim)]]); return Array.isArray(r) ? r.map(String) : []; } catch (e) { return []; }
  }
  if (!memMode()) return [];
  const lo = min === '-inf' ? -Infinity : Number(min), hi = max === '+inf' ? Infinity : Number(max);
  return zsorted(key).filter((x) => x[1] >= lo && x[1] <= hi).slice(0, lim).map((x) => x[0]);
}
// Neueste zuerst (höchster Score), [start, stop] wie ZREVRANGE.
async function zrevrange(key, start, stop) {
  if (Store.hasStore) { try { const [r] = await Store.redisPipeline([['ZREVRANGE', key, String(start || 0), String(stop == null ? -1 : stop)]]); return Array.isArray(r) ? r.map(String) : []; } catch (e) { return []; } }
  if (!memMode()) return [];
  const a = zsorted(key).reverse().map((x) => x[0]);
  const en = stop == null || stop < 0 ? a.length : stop + 1;
  return a.slice(start || 0, en);
}
// Entfernt alle Mitglieder mit score <= max (Aufräumen alter Index-Einträge).
async function zremRangeByScore(key, min, max) {
  if (Store.hasStore) { try { const [r] = await Store.redisPipeline([['ZREMRANGEBYSCORE', key, String(min), String(max)]]); return Number(r) || 0; } catch (e) { return 0; } }
  if (!memMode()) return 0;
  const lo = min === '-inf' ? -Infinity : Number(min), hi = Number(max); const e = zget(key); let n = 0;
  Array.from(e.m.entries()).forEach(([m, s]) => { if (s >= lo && s <= hi) { e.m.delete(m); n++; } });
  return n;
}
// Behält nur die `keep` höchsten Scores.
async function ztrimTop(key, keep) {
  if (Store.hasStore) { try { await Store.redisPipeline([['ZREMRANGEBYRANK', key, '0', String(-(keep + 1))]]); return true; } catch (e) { return false; } }
  if (!memMode()) return false;
  const a = zsorted(key); const e = zget(key); a.slice(0, Math.max(0, a.length - keep)).forEach((x) => e.m.delete(x[0])); return true;
}

// ── Hashes (Wochenzähler je Mitglied) ──
const memH = new Map();         // key -> { h: Map(field -> string), exp }
function hget0(key) { let e = memH.get(key); if (!alive(e)) { e = { h: new Map(), exp: 0 }; memH.set(key, e); } return e; }
function flat(v) { if (!Array.isArray(v)) return v && typeof v === 'object' ? v : {}; const o = {}; for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1]; return o; }

async function hgetall(key) {
  if (Store.hasStore) { try { const [r] = await Store.redisPipeline([['HGETALL', key]]); return flat(r); } catch (e) { return {}; } }
  if (!memMode()) return {};
  const o = {}; hget0(key).h.forEach((v, k) => { o[k] = v; }); return o;
}
async function hset(key, obj, ttlSec) {
  const fields = Object.keys(obj || {}); if (!fields.length) return true;
  if (Store.hasStore) {
    try { const cmd = ['HSET', key]; fields.forEach((f) => cmd.push(f, String(obj[f]))); const cmds = [cmd]; if (ttlSec) cmds.push(['EXPIRE', key, String(ttlSec)]); await Store.redisPipeline(cmds); return true; } catch (e) { return false; }
  }
  if (!memMode()) return false;
  const e = hget0(key); fields.forEach((f) => e.h.set(f, String(obj[f]))); if (ttlSec) e.exp = ttlExp(ttlSec); return true;
}
async function hincrby(key, field, by, ttlSec) {
  if (Store.hasStore) {
    try { const cmds = [['HINCRBY', key, String(field), String(by || 1)]]; if (ttlSec) cmds.push(['EXPIRE', key, String(ttlSec)]); const r = await Store.redisPipeline(cmds); return Number(r[0]) || 0; } catch (e) { return null; }
  }
  if (!memMode()) return null;
  const e = hget0(key); const n = (Number(e.h.get(String(field))) || 0) + (Number(by) || 1); e.h.set(String(field), String(n)); if (ttlSec) e.exp = ttlExp(ttlSec); return n;
}
async function hdel(key, fields) {
  fields = (Array.isArray(fields) ? fields : [fields]).map(String).filter(Boolean); if (!fields.length) return true;
  if (Store.hasStore) { try { await Store.redisPipeline([['HDEL', key].concat(fields)]); return true; } catch (e) { return false; } }
  if (!memMode()) return false;
  const e = hget0(key); fields.forEach((f) => e.h.delete(f)); return true;
}

// Nur für Tests: In-Memory-Zustand leeren.
function _reset() { mem.clear(); memLists.clear(); memZ.clear(); memH.clear(); }

module.exports = {
  available, mode, get, getJSON, mgetJSON, set, del, incr, lpush, lrange, lrangeJSON, sadd, smembers, srem, expire,
  zadd, zrem, zscore, zcard, zrangeByScore, zrevrange, zremRangeByScore, ztrimTop,
  hgetall, hset, hincrby, hdel,
  _reset,
};
