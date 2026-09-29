'use strict';
// Kleiner Redis-Nachbau für Tests (kein Test selbst – der Runner nimmt nur *.test.js).
// Deckt die Befehle ab, die lib/store-Nutzer über die Upstash-Pipeline schicken.
// TTL/EXPIRE werden ignoriert (Tests laufen kurz). NX wird beachtet.

function create() {
  const S = new Map();   // key -> string
  const SETS = new Map(), LISTS = new Map(), Z = new Map(), H = new Map();
  const has = (k) => S.has(k) || SETS.has(k) || LISTS.has(k) || Z.has(k) || H.has(k);
  const zs = (k) => { if (!Z.has(k)) Z.set(k, new Map()); return Z.get(k); };
  const hs = (k) => { if (!H.has(k)) H.set(k, new Map()); return H.get(k); };
  const zsorted = (k) => Array.from(zs(k).entries()).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const num = (v, inf) => (v === '-inf' ? -Infinity : (v === '+inf' ? Infinity : Number(v)));

  function one(c) {
    const op = String(c[0]).toUpperCase(); const k = c[1] != null ? String(c[1]) : '';
    const rest = c.slice(2).map(String);
    switch (op) {
      case 'GET': return S.has(k) ? S.get(k) : null;
      case 'MGET': return c.slice(1).map((x) => (S.has(String(x)) ? S.get(String(x)) : null));
      case 'SET': { const nx = rest.slice(1).map((x) => x.toUpperCase()).indexOf('NX') >= 0; if (nx && S.has(k)) return null; S.set(k, String(c[2])); return 'OK'; }
      case 'DEL': { let n = 0; c.slice(1).forEach((x) => { x = String(x); if (has(x)) n++; S.delete(x); SETS.delete(x); LISTS.delete(x); Z.delete(x); H.delete(x); }); return n; }
      case 'INCR': { const n = (parseInt(S.get(k), 10) || 0) + 1; S.set(k, String(n)); return n; }
      case 'EXPIRE': return 1;
      case 'TYPE': return S.has(k) ? 'string' : SETS.has(k) ? 'set' : LISTS.has(k) ? 'list' : Z.has(k) ? 'zset' : H.has(k) ? 'hash' : 'none';
      case 'SADD': { if (!SETS.has(k)) SETS.set(k, new Set()); c.slice(2).forEach((x) => SETS.get(k).add(String(x))); return 1; }
      case 'SREM': { if (SETS.has(k)) c.slice(2).forEach((x) => SETS.get(k).delete(String(x))); return 1; }
      case 'SMEMBERS': return SETS.has(k) ? Array.from(SETS.get(k)) : [];
      case 'SCARD': return SETS.has(k) ? SETS.get(k).size : 0;
      case 'SISMEMBER': return SETS.has(k) && SETS.get(k).has(String(c[2])) ? 1 : 0;
      case 'LPUSH': { if (!LISTS.has(k)) LISTS.set(k, []); c.slice(2).forEach((x) => LISTS.get(k).unshift(String(x))); return LISTS.get(k).length; }
      case 'RPUSH': { if (!LISTS.has(k)) LISTS.set(k, []); c.slice(2).forEach((x) => LISTS.get(k).push(String(x))); return LISTS.get(k).length; }
      case 'LTRIM': { if (LISTS.has(k)) { const a = LISTS.get(k), s = parseInt(c[2], 10) || 0, e = parseInt(c[3], 10); LISTS.set(k, a.slice(s, e < 0 ? a.length + e + 1 : e + 1)); } return 'OK'; }
      case 'LRANGE': { const a = LISTS.get(k) || [], s = parseInt(c[2], 10) || 0, e = parseInt(c[3], 10); return a.slice(s, e < 0 ? a.length + e + 1 : e + 1); }
      case 'LLEN': return (LISTS.get(k) || []).length;
      case 'ZADD': { const z = zs(k); for (let i = 2; i + 1 < c.length; i += 2) z.set(String(c[i + 1]), Number(c[i])); return 1; }
      case 'ZREM': { const z = zs(k); c.slice(2).forEach((m) => z.delete(String(m))); return 1; }
      case 'ZSCORE': { const v = zs(k).get(String(c[2])); return v == null ? null : String(v); }
      case 'ZCARD': return zs(k).size;
      case 'ZRANGEBYSCORE': {
        const lo = num(c[2]), hi = num(c[3]); let a = zsorted(k).filter((x) => x[1] >= lo && x[1] <= hi).map((x) => x[0]);
        const li = rest.map((x) => x.toUpperCase()).indexOf('LIMIT'); if (li >= 0) { const off = parseInt(rest[li + 1], 10) || 0, cnt = parseInt(rest[li + 2], 10); a = a.slice(off, off + cnt); }
        return a;
      }
      case 'ZRANGE': { const a = zsorted(k), s = parseInt(c[2], 10) || 0, e = parseInt(c[3], 10); const sl = a.slice(s, e < 0 ? a.length + e + 1 : e + 1); return rest.map((x) => x.toUpperCase()).indexOf('WITHSCORES') >= 0 ? [].concat.apply([], sl.map((x) => [x[0], String(x[1])])) : sl.map((x) => x[0]); }
      case 'ZREVRANGE': { const a = zsorted(k).reverse(), s = parseInt(c[2], 10) || 0, e = parseInt(c[3], 10); return a.slice(s, e < 0 ? a.length + e + 1 : e + 1).map((x) => x[0]); }
      case 'ZREMRANGEBYSCORE': { const lo = num(c[2]), hi = num(c[3]); let n = 0; const z = zs(k); Array.from(z.entries()).forEach(([m, sc]) => { if (sc >= lo && sc <= hi) { z.delete(m); n++; } }); return n; }
      case 'ZREMRANGEBYRANK': { const a = zsorted(k); const s = parseInt(c[2], 10), e = parseInt(c[3], 10); const from = s < 0 ? a.length + s : s, to = e < 0 ? a.length + e : e; let n = 0; a.forEach((x, i) => { if (i >= from && i <= to) { zs(k).delete(x[0]); n++; } }); return n; }
      case 'HGETALL': { const h = H.get(k); if (!h) return []; const out = []; h.forEach((v, f) => out.push(f, v)); return out; }
      case 'HGET': { const h = H.get(k); return h && h.has(String(c[2])) ? h.get(String(c[2])) : null; }
      case 'HSET': { const h = hs(k); for (let i = 2; i + 1 < c.length; i += 2) h.set(String(c[i]), String(c[i + 1])); return 1; }
      case 'HINCRBY': { const h = hs(k); const n = (parseInt(h.get(String(c[2])), 10) || 0) + (parseInt(c[3], 10) || 0); h.set(String(c[2]), String(n)); return n; }
      case 'HDEL': { const h = H.get(k); if (h) c.slice(2).forEach((f) => h.delete(String(f))); return 1; }
      case 'SCAN': { const all = [].concat(Array.from(S.keys()), Array.from(SETS.keys()), Array.from(LISTS.keys()), Array.from(Z.keys()), Array.from(H.keys())); return ['0', Array.from(new Set(all))]; }
      case 'KEYS': { const re = new RegExp('^' + String(c[1]).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); return [].concat(Array.from(S.keys()), Array.from(SETS.keys()), Array.from(LISTS.keys()), Array.from(Z.keys()), Array.from(H.keys())).filter((x) => re.test(x)); }
      default: return null;
    }
  }
  return {
    S, SETS, LISTS, Z, H,
    store: { hasStore: true, redisPipeline: async (cmds) => cmds.map(one), localParts: () => ({ weekday: 1, hour: 10, minute: 0, slot: 20 }), TZ: 'Europe/Berlin' },
    keys: () => [].concat(Array.from(S.keys()), Array.from(SETS.keys()), Array.from(LISTS.keys()), Array.from(Z.keys()), Array.from(H.keys())),
    json: (k) => { try { return S.has(k) ? JSON.parse(S.get(k)) : null; } catch (e) { return null; } },
    reset: () => { S.clear(); SETS.clear(); LISTS.clear(); Z.clear(); H.clear(); },
  };
}

module.exports = { create };
