'use strict';

/**
 * FINN Journeys – Schalter und Admin-Einstellungen.
 * -----------------------------------------------------------------------------
 * Env (ohne Deployment umstellbar):
 *   JOURNEYS=1                Hauptschalter. Ohne ihn wird nichts gesendet und nichts aufgenommen.
 *   JOURNEYS_MODE=auto        echte Zustellung. Alles andere (Standard) = Probelauf „dry":
 *                             die Schritte laufen durch, gesendet wird nichts (jr:dry).
 *   JOURNEYS_TEST_NUMBERS     kommagetrennt. Gesetzt = NUR diese Nummern bekommen echte
 *                             Nachrichten, alle anderen laufen wie im Probelauf.
 *   JOURNEYS_TRACK=1          Check-ins zählen und Nachlauf starten, ohne JOURNEYS=1.
 *   JOURNEY_<KEY>=0           eine Journey hart aus (LEAD, ONBOARDING, HABIT, COMEBACK, INVITE).
 *
 * Admin-Einstellungen (Team-Backend „Journeys") liegen in jr:cfg:
 *   { journeys: { <key>: { on:boolean } }, templates: { <tplKey>: { sid, meta, lang, category } } }
 * Vorlagen-Zuordnung ist KEIN Geheimnis (Content-SIDs sind keine Zugangsdaten).
 */

const KV = require('../finn/kv');
const Phone = require('../phone');

const TZ = 'Europe/Berlin';
const CFG_KEY = 'jr:cfg';
const JOURNEY_KEYS = ['lead', 'onboarding', 'habit', 'comeback', 'invite'];

function on() { return process.env.JOURNEYS === '1'; }
function tracking() { return on() || process.env.JOURNEYS_TRACK === '1'; }
function mode() { return process.env.JOURNEYS_MODE === 'auto' ? 'auto' : 'dry'; }
function testNumbers() {
  return String(process.env.JOURNEYS_TEST_NUMBERS || '').split(',').map((s) => Phone.canon(s)).filter(Boolean);
}
function envOff(key) { return process.env['JOURNEY_' + String(key).toUpperCase()] === '0'; }

let cache = null, cacheAt = 0;
async function load(force) {
  if (!force && cache && Date.now() - cacheAt < 30000) return cache;
  const c = (await KV.getJSON(CFG_KEY)) || {};
  cache = { journeys: c.journeys || {}, templates: c.templates || {}, updatedAt: c.updatedAt || null, updatedBy: c.updatedBy || null };
  cacheAt = Date.now();
  return cache;
}
async function save(patch, who) {
  const cur = await load(true);
  const next = {
    journeys: Object.assign({}, cur.journeys, (patch && patch.journeys) || {}),
    templates: Object.assign({}, cur.templates, (patch && patch.templates) || {}),
    updatedAt: Date.now(), updatedBy: who ? String(who).slice(0, 60) : null,
  };
  await KV.set(CFG_KEY, next);
  cache = next; cacheAt = Date.now();
  return next;
}
function _clearCache() { cache = null; cacheAt = 0; }

// Ist eine Journey aktiv? Hauptschalter + Env-Notaus + Admin-Schalter (Standard: an,
// außer der Einladungsaktion – die startet nur, wenn das Team sie ausdrücklich einschaltet).
async function journeyOn(key) {
  if (!on() || envOff(key)) return false;
  const c = await load();
  const j = c.journeys[key];
  if (key === 'invite') return !!(j && j.on === true);
  return !(j && j.on === false);
}

module.exports = { TZ, CFG_KEY, JOURNEY_KEYS, on, tracking, mode, testNumbers, envOff, load, save, journeyOn, _clearCache };
