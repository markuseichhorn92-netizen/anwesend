'use strict';

/**
 * Mitglieder-Einstellungen (App-Präferenzen), serverseitig in Upstash.
 *   mpref:<memberId>  Hash  { reminders: '1'|'0' }
 * Aktuell: E-Mail-Erinnerungen an/aus (Standard an). Transaktionale
 * Bestätigungen (Vertrag, Kündigung, …) sind davon NICHT betroffen.
 */

const { redisPipeline, hasStore } = require('./store');

const KEY = (id) => 'mpref:' + id;
const TTL = String(400 * 86400); // ~13 Monate, wird bei jeder Änderung verlängert

// Alle Boolean-Einstellungen mit Standardwert (Standard überall: an / opt-out).
//   reminders     E-Mail-Trainingserinnerungen
//   push          Push-Mitteilungen (Hauptschalter)
//   pushPostfach  neue Nachricht/Antwort im Postfach
//   pushTermin    Termin-Erinnerungen
//   pushKonto     offene Beiträge/Rechnungen
//   pushNews      Studio-News & Aktionen
const BOOL_KEYS = ['reminders', 'push', 'pushPostfach', 'pushTermin', 'pushKonto', 'pushNews'];

function toMap(v) {
  if (!v) return {};
  if (Array.isArray(v)) { const m = {}; for (let i = 0; i + 1 < v.length; i += 2) m[v[i]] = v[i + 1]; return m; }
  return typeof v === 'object' ? v : {};
}

function defaults() { const o = {}; BOOL_KEYS.forEach((k) => { o[k] = true; }); return o; }

async function getPrefs(memberId) {
  if (!hasStore || memberId == null) return defaults();
  try {
    const [flat] = await redisPipeline([['HGETALL', KEY(memberId)]]);
    const m = toMap(flat);
    const out = {};
    BOOL_KEYS.forEach((k) => { out[k] = !(m[k] === '0' || m[k] === 'false'); }); // Standard: an
    return out;
  } catch (e) { return defaults(); }
}

async function setPrefs(memberId, patch) {
  if (!hasStore || memberId == null) return { ok: false, prefs: defaults() };
  const cmds = [];
  BOOL_KEYS.forEach((k) => { if (typeof patch[k] === 'boolean') cmds.push(['HSET', KEY(memberId), k, patch[k] ? '1' : '0']); });
  if (cmds.length) { cmds.push(['EXPIRE', KEY(memberId), TTL]); await redisPipeline(cmds); }
  const prefs = await getPrefs(memberId);
  return { ok: true, prefs: prefs };
}

module.exports = { getPrefs, setPrefs, BOOL_KEYS };
