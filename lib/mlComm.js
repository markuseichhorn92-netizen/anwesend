'use strict';

/**
 * Kommunikations-/Marketing-Einwilligungen – Magicline Open API
 * (Scopes COMMUNICATION_PREFERENCES_READ / COMMUNICATION_PREFERENCES_WRITE).
 * -------------------------------------------------------------------------
 * Verifiziert gegen die echte OpenAPI-Spec:
 *   GET  /communications/{customerId}/communication-preferences
 *   PUT  /communications/{customerId}/communication-preferences
 * Beide arbeiten mit einem Array von CommunicationPreference:
 *   [{ messageCategory: 'CONTRACT'|'GENERAL'|'APPOINTMENT'|'NEWSLETTER'|'LOYALTY_PROGRAM',
 *      channels: [{ communicationChannel: 'EMAIL'|'PHONE'|'LETTER'|'TEXT_MESSAGE'|…,
 *                   customerOverridable: bool, active: bool }] }]
 *
 * Fürs Mitglied ist die Werbe-/Marketing-Einwilligung relevant -> Kategorie
 * NEWSLETTER. Wir bilden deren Kanäle auf die flachen UI-Schalter ab
 * (EMAIL->email, PHONE->phone, LETTER->post, TEXT_MESSAGE->sms) und zeigen nur
 * Kanäle, die das Mitglied selbst ändern darf (customerOverridable !== false).
 *
 * Degradiert sauber: 403/Fehler/unerwartete Form -> { available:false } bzw.
 * { ok:false, forbidden:true }. Wirft NIE.
 */

const { ml } = require('./members');

// Magicline-Kanal <-> UI-Schalter.
const CH_MAP = { EMAIL: 'email', PHONE: 'phone', LETTER: 'post', TEXT_MESSAGE: 'sms' };
const CH_REV = { email: 'EMAIL', phone: 'PHONE', post: 'LETTER', sms: 'TEXT_MESSAGE' };
// Relevante Kategorie (Werbung/Newsletter). Über Env anpassbar, falls gewünscht.
const CATEGORY = (process.env.COMM_PREF_CATEGORY || 'NEWSLETTER').toUpperCase();

// Pfad – BASE aus members.js enthält bereits das /v1-Präfix.
function path(id) { return '/communications/' + encodeURIComponent(id) + '/communication-preferences'; }

// Die relevante Präferenz-Kategorie aus dem Array holen (NEWSLETTER, sonst die
// erste mit Kanälen als Fallback).
function pickCategory(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.find(function (p) { return p && String(p.messageCategory).toUpperCase() === CATEGORY && Array.isArray(p.channels); })
    || arr.find(function (p) { return p && Array.isArray(p.channels) && p.channels.length; })
    || null;
}

// Einwilligungen lesen. -> { available:true, prefs:{email?,phone?,post?,sms?} } | { available:false }
async function getCommPrefs(customerId) {
  var r;
  try { r = await ml('GET', path(customerId)); }
  catch (e) { return { available: false }; }
  if (!r || r.status < 200 || r.status >= 300 || !Array.isArray(r.json)) return { available: false };
  var cat = pickCategory(r.json);
  if (!cat) return { available: false };
  var out = {};
  cat.channels.forEach(function (c) {
    if (!c) return;
    var ch = CH_MAP[String(c.communicationChannel || '').toUpperCase()];
    if (!ch) return;
    if (c.customerOverridable === false) return;   // nur selbst änderbare Kanäle anzeigen
    out[ch] = c.active !== false;
  });
  if (!Object.keys(out).length) return { available: false };
  return { available: true, prefs: out };
}

// Einwilligungen schreiben. patch = { email?,phone?,post?,sms? } (bool).
// Liest das aktuelle Array, schaltet die betroffenen Kanäle der Kategorie um und
// schreibt das komplette Array zurück. -> { ok, forbidden, status, error }. Wirft nie.
async function setCommPrefs(customerId, patch) {
  patch = patch || {};
  var p = path(customerId);

  // 1) aktuellen Stand holen
  var r;
  try { r = await ml('GET', p); }
  catch (e) { return { ok: false, forbidden: false, status: 0, error: 'network' }; }
  if (!r) return { ok: false, forbidden: false, status: 0, error: 'network' };
  if (r.status === 403) return { ok: false, forbidden: true, status: 403 };
  if (r.status < 200 || r.status >= 300 || !Array.isArray(r.json)) {
    return { ok: false, forbidden: false, status: r.status || 0, error: 'read_failed' };
  }
  var arr = r.json;
  var cat = pickCategory(arr);
  if (!cat || !Array.isArray(cat.channels)) return { ok: false, forbidden: false, status: 404, error: 'category_not_found' };

  // 2) betroffene Kanäle umschalten (nur änderbare)
  var changed = false;
  Object.keys(patch).forEach(function (k) {
    if (typeof patch[k] !== 'boolean') return;
    var target = CH_REV[k];
    if (!target) return;
    cat.channels.forEach(function (c) {
      if (c && String(c.communicationChannel || '').toUpperCase() === target && c.customerOverridable !== false) {
        c.active = patch[k]; changed = true;
      }
    });
  });
  if (!changed) return { ok: false, forbidden: false, status: 400, error: 'no_valid_channels' };

  // 3) komplettes Array zurückschreiben
  var w;
  try { w = await ml('PUT', p, arr); }
  catch (e) { return { ok: false, forbidden: false, status: 0, error: 'network' }; }
  if (!w) return { ok: false, forbidden: false, status: 0, error: 'network' };
  if (w.status === 403) return { ok: false, forbidden: true, status: 403 };
  if (w.status < 200 || w.status >= 300) {
    return { ok: false, forbidden: false, status: w.status, error: (w.json && (w.json.errorMessage || w.json.message)) || null };
  }
  return { ok: true, forbidden: false, status: w.status };
}

module.exports = { getCommPrefs, setCommPrefs };
