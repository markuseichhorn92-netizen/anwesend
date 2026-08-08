'use strict';

/**
 * Generische, NICHT personenbezogene Betriebszähler (Tages-Buckets).
 * -----------------------------------------------------------------------------
 * Für den Ops-Überblick: „wie oft passiert was" – App-Fehler, WhatsApp-KI-Nutzung
 * usw. Es werden AUSSCHLIESSLICH Zahlen gespeichert (Name + Tag + Count), niemals
 * Inhalte, Namen, IDs oder Freitext. Tages-Buckets erlauben 1-/7-/30-Tage-Fenster.
 *
 * Keys:  ops:names            SET der bekannten Zählernamen
 *        ops:c:<name>:<YYYY-MM-DD>  Tageszähler (INCRBY), 35 Tage TTL
 *
 * No-Op ohne Store; wirft nie.
 */

const { redisPipeline, hasStore } = require('./store');

const NAMES = 'ops:names';
const C = (name, day) => 'ops:c:' + name + ':' + day;
const TTL = 60 * 60 * 24 * 35;   // 35 Tage – deckt das 30-Tage-Fenster ab.
const WINDOW = 30;

function dayStr(ms) { return new Date(ms == null ? Date.now() : ms).toISOString().slice(0, 10); }
function daysBack(n) { const out = [], now = Date.now(); for (let i = 0; i < n; i++) out.push(dayStr(now - i * 86400000)); return out; }
function safeName(s) { return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_:.-]/g, '').slice(0, 60); }

// Einen Zähler um n (Standard 1) erhöhen. Wirft nie.
async function bump(name, n) {
  const nm = safeName(name); if (!hasStore || !nm) return false;
  const inc = Math.max(1, parseInt(n, 10) || 1);
  const day = dayStr();
  try {
    await redisPipeline([
      ['INCRBY', C(nm, day), String(inc)], ['EXPIRE', C(nm, day), String(TTL)],
      ['SADD', NAMES, nm], ['EXPIRE', NAMES, String(TTL)],
    ]);
    return true;
  } catch (e) { return false; }
}

// Liefert { <name>: { d1, d7, d30 } } für alle bekannten Zähler. Wirft nie.
async function read() {
  if (!hasStore) return {};
  let names = [];
  try { const [r] = await redisPipeline([['SMEMBERS', NAMES]]); names = Array.isArray(r) ? r : []; } catch (e) { return {}; }
  if (!names.length) return {};
  const win = daysBack(WINDOW);
  const cmds = [];
  names.forEach((nm) => win.forEach((d) => cmds.push(['GET', C(nm, d)])));
  let vals = [];
  try { vals = await redisPipeline(cmds); } catch (e) { return {}; }
  const out = {};
  names.forEach((nm, ni) => {
    let d1 = 0, d7 = 0, d30 = 0;
    for (let i = 0; i < WINDOW; i++) {
      const v = Number(vals[ni * WINDOW + i]) || 0;
      d30 += v; if (i < 7) d7 += v; if (i < 1) d1 += v;
    }
    out[nm] = { d1: d1, d7: d7, d30: d30 };
  });
  return out;
}

module.exports = { bump, read };
