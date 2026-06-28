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

function toMap(v) {
  if (!v) return {};
  if (Array.isArray(v)) { const m = {}; for (let i = 0; i + 1 < v.length; i += 2) m[v[i]] = v[i + 1]; return m; }
  return typeof v === 'object' ? v : {};
}

async function getPrefs(memberId) {
  if (!hasStore || memberId == null) return { reminders: true };
  try {
    const [flat] = await redisPipeline([['HGETALL', KEY(memberId)]]);
    const m = toMap(flat);
    return { reminders: !(m.reminders === '0' || m.reminders === 'false') }; // Standard: an
  } catch (e) { return { reminders: true }; }
}

async function setPrefs(memberId, patch) {
  if (!hasStore || memberId == null) return { ok: false, prefs: { reminders: true } };
  const cmds = [];
  if (typeof patch.reminders === 'boolean') cmds.push(['HSET', KEY(memberId), 'reminders', patch.reminders ? '1' : '0']);
  if (cmds.length) { cmds.push(['EXPIRE', KEY(memberId), TTL]); await redisPipeline(cmds); }
  const prefs = await getPrefs(memberId);
  return { ok: true, prefs: prefs };
}

module.exports = { getPrefs, setPrefs };
