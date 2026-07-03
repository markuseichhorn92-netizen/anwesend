'use strict';

/**
 * Kommunikations-/Marketing-Einwilligungen – Magicline Open API
 * (Scopes COMMUNICATION_PREFERENCES_READ / COMMUNICATION_PREFERENCES_WRITE).
 * -------------------------------------------------------------------------
 * ANNAHME zu den Endpunkten: Magicline dokumentiert diese Präferenzen je nach
 * Tenant/Version uneinheitlich. Wir nehmen die plausibelsten Pfade an
 *   GET  /customers/{id}/communication-preferences
 *   PUT  /customers/{id}/communication-preferences   (Fallback: POST)
 * und normalisieren die Kanäle robust: Feldnamen können emailAllowed /
 * allowEmail / marketingEmail / email / consents:[{channel,allowed}] … heißen.
 * Zurückgegeben werden nur die tatsächlich vorhandenen Kanäle.
 *
 * Degradiert sauber: Fehlt der Scope, antwortet Magicline mit 403 -> die
 * Funktionen liefern { available:false } bzw. { ok:false, forbidden:true }
 * und werfen NIE, damit die UI den Bereich einfach ausblenden kann.
 */

const { ml } = require('./members');

// Die vier Kanäle, die die UI kennt.
const CHANNELS = ['email', 'phone', 'post', 'sms'];

// Pfad – BASE aus members.js enthält bereits das /v1-Präfix.
function path(id) { return '/customers/' + encodeURIComponent(id) + '/communication-preferences'; }

// Einen Wert robust in bool/null überführen (bool, 0/1, "true"/"yes"/"allowed" …).
function truthy(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    var s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'allowed' || s === 'granted' || s === 'opt_in' || s === 'optin' || s === 'active' || s === 'enabled') return true;
    if (s === 'false' || s === 'no' || s === 'n' || s === '0' || s === 'denied' || s === 'revoked' || s === 'opt_out' || s === 'optout' || s === 'inactive' || s === 'disabled') return false;
  }
  return null;
}

// bool aus einem Wert ODER aus einem Consent-Objekt ({allowed:true} / {consent:true} …).
function boolFrom(v) {
  var t = truthy(v);
  if (t !== null) return t;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    var keys = ['allowed', 'consent', 'consented', 'granted', 'enabled', 'value', 'optIn', 'active', 'selected', 'permitted', 'permission'];
    for (var i = 0; i < keys.length; i++) {
      if (v[keys[i]] !== undefined) { var b = truthy(v[keys[i]]); if (b !== null) return b; }
    }
  }
  return null;
}

// Kanal aus einem Feld-/Consent-Namen erkennen. Reihenfolge zählt (sms vor phone,
// email vor post), damit z. B. "email" nicht als "mail"->post fehlgedeutet wird.
function channelOf(key) {
  var k = String(key || '').toLowerCase();
  if (/whatsapp|sms|textmessage|shortmessage/.test(k)) return 'sms';
  if (/e[_-]?mail|email/.test(k)) return 'email';
  if (/post|letter|mailing|physical/.test(k)) return 'post';
  if (/phone|telephone|(^|[^a-z])call|(^|[^a-z])tel([^a-z]|$)/.test(k)) return 'phone';
  return null;
}

// Präferenzen aus beliebiger Container-Form (Objekt oder Consent-Array) einsammeln.
function collect(obj, prefs) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var name = it.channel || it.type || it.name || it.key || it.communicationChannel || it.medium || it.channelType || '';
      var ch = channelOf(name);
      if (ch && prefs[ch] === undefined) {
        var b = boolFrom(it);
        if (b !== null) prefs[ch] = b;
      }
    });
    return;
  }
  Object.keys(obj).forEach(function (key) {
    var ch = channelOf(key);
    if (!ch || prefs[ch] !== undefined) return;
    var b = boolFrom(obj[key]);
    if (b !== null) prefs[ch] = b;
  });
}

// Einwilligungen lesen. -> { available:true, prefs:{email?,phone?,post?,sms?} } | { available:false }
async function getCommPrefs(customerId) {
  var r;
  try { r = await ml('GET', path(customerId)); }
  catch (e) { return { available: false }; }
  if (!r || r.status < 200 || r.status >= 300 || !r.json || typeof r.json !== 'object') return { available: false };

  var prefs = {};
  var containers = [r.json];
  ['communicationPreferences', 'preferences', 'communicationConsents', 'consents', 'marketingConsents', 'consent', 'permissions', 'channels', 'settings', 'data', 'result']
    .forEach(function (k) { if (r.json[k] !== undefined && r.json[k] !== null) containers.push(r.json[k]); });
  containers.forEach(function (c) { collect(c, prefs); });

  var out = {};
  CHANNELS.forEach(function (ch) { if (typeof prefs[ch] === 'boolean') out[ch] = prefs[ch]; });
  if (!Object.keys(out).length) return { available: false };
  return { available: true, prefs: out };
}

// Einwilligungen schreiben. patch = { email?,phone?,post?,sms? } (bool).
// -> { ok, forbidden, status, error }. Wirft nie.
async function setCommPrefs(customerId, patch) {
  patch = patch || {};
  var body = {};
  CHANNELS.forEach(function (ch) { if (typeof patch[ch] === 'boolean') body[ch] = patch[ch]; });
  if (!Object.keys(body).length) return { ok: false, forbidden: false, status: 400, error: 'no_valid_channels' };

  var p = path(customerId);
  var r;
  try { r = await ml('PUT', p, body); }
  catch (e) { return { ok: false, forbidden: false, status: 0, error: 'network' }; }
  // Manche Tenants akzeptieren nur POST -> bei 404/405 einmal mit POST nachfassen.
  if (r && (r.status === 404 || r.status === 405)) {
    try { r = await ml('POST', p, body); }
    catch (e) { return { ok: false, forbidden: false, status: 0, error: 'network' }; }
  }
  if (!r) return { ok: false, forbidden: false, status: 0, error: 'network' };
  if (r.status === 403) return { ok: false, forbidden: true, status: 403 };
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, forbidden: false, status: r.status, error: (r.json && (r.json.errorMessage || r.json.message)) || null };
  }
  return { ok: true, forbidden: false, status: r.status };
}

module.exports = { getCommPrefs, setCommPrefs };
