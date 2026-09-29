'use strict';

/**
 * WhatsApp-Kundenservice-Fenster (24 Stunden) je Nummer.
 * -----------------------------------------------------------------------------
 * Innerhalb von 24 h nach der letzten Nachricht der Person darf frei getextet
 * werden, danach nur mit freigegebener Vorlage. Meta UND Twilio nehmen einen
 * Freitext außerhalb des Fensters trotzdem an und melden den Fehler erst später
 * (131047 / 63016) – deshalb müssen wir selbst wissen, ob das Fenster offen ist.
 *
 * jr:win:<nummer> = Zeitpunkt der letzten eingehenden Nachricht (7 Tage aufbewahrt).
 * Offen heißt: jünger als 23 h 50 min (Sicherheitsabstand zum Ablauf).
 * Unbekannt (kein Eintrag) gilt als geschlossen.
 */

const KV = require('../finn/kv');
const Phone = require('../phone');

const OPEN_MS = 24 * 3600 * 1000 - 10 * 60 * 1000;
const TTL = 7 * 86400;
const K = (p) => 'jr:win:' + p;

async function touch(phone, at) {
  const p = Phone.canon(phone); if (!p) return false;
  return !!(await KV.set(K(p), String(at || Date.now()), TTL));
}
async function lastInbound(phone) {
  const p = Phone.canon(phone); if (!p) return null;
  const v = Number(await KV.get(K(p)));
  return v > 0 ? v : null;
}
async function isOpen(phone, now) {
  const t = await lastInbound(phone);
  return !!t && ((now || Date.now()) - t) < OPEN_MS;
}
// 'open' | 'closed' | 'unknown' – unknown = keine eingehende Nachricht in den letzten 7 Tagen
// (oder vor Einführung dieser Merkliste). Aufrufer entscheiden dann vorsichtig.
async function state(phone, now) {
  const t = await lastInbound(phone);
  if (!t) return 'unknown';
  return ((now || Date.now()) - t) < OPEN_MS ? 'open' : 'closed';
}
// Anbieter meldet „Fenster zu" (131047/63016): Eintrag altern lassen statt löschen,
// damit „wann zuletzt geschrieben" erhalten bleibt.
async function close(phone) {
  const p = Phone.canon(phone); if (!p) return false;
  const t = await lastInbound(p);
  if (!t) return true;
  return !!(await KV.set(K(p), String(Math.min(t, Date.now() - OPEN_MS - 1000)), TTL));
}
// Wann schließt das Fenster (ms) – null, wenn es zu ist.
async function closesAt(phone, now) {
  const t = await lastInbound(phone);
  if (!t) return null;
  const end = t + OPEN_MS;
  return end > (now || Date.now()) ? end : null;
}

module.exports = { touch, lastInbound, isOpen, state, close, closesAt, OPEN_MS };
