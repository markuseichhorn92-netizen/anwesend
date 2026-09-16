'use strict';

/**
 * FINN – kleine gemeinsame Helfer (keine Abhängigkeiten außer node:crypto).
 */

const crypto = require('node:crypto');

function isProduction() {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
}

// Kurze, zufällige Kennung (Trace-Id, Bestätigungs-Id). URL-sicher.
function id(len) {
  return crypto.randomBytes(Math.max(8, Math.min(32, len || 12))).toString('base64url').slice(0, len || 16);
}

function sha1(s) { return crypto.createHash('sha1').update(String(s == null ? '' : s)).digest('hex'); }

// Stabiler Hash über beliebige Argumente (Bestätigung bindet sich an genau diese Args).
function hashArgs(o) {
  try { return sha1(JSON.stringify(sortKeys(o == null ? {} : o))); } catch (e) { return sha1(String(o)); }
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach((k) => { out[k] = sortKeys(v[k]); });
    return out;
  }
  return v;
}

// Kundenfreundliche Fehlertexte – technische Details bleiben serverseitig.
const SAFE = {
  forbidden: 'Das kann ich hier gerade nicht direkt erledigen. Ich gebe es ans Team weiter, wenn du möchtest.',
  unavailable: 'Magicline antwortet gerade nicht. Bitte versuch es in einem Moment noch einmal.',
  not_found: 'Dazu habe ich keine Daten gefunden.',
  invalid: 'Da fehlt mir noch eine Angabe.',
  rate_limited: 'Kurz durchatmen – das waren viele Anfragen auf einmal. Versuch es gleich nochmal.',
  no_ai: 'FINN ist gerade nicht verfügbar. Magst du es direkt unserem Team schreiben?',
  blocked: 'Diese Anfrage kann FINN aus Sicherheitsgründen nicht bearbeiten.',
  confirm_expired: 'Die Bestätigung ist abgelaufen. Sag mir einfach noch einmal, was du möchtest.',
  confirm_mismatch: 'Diese Bestätigung passt nicht zu deiner Sitzung.',
  failed: 'Da komme ich gerade nicht weiter. Magst du es unserem Team schreiben?',
};
function safeMessage(code) { return SAFE[code] || SAFE.failed; }

// Text kappen (für Tool-Ergebnisse im Prompt).
function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? (s.slice(0, n) + ' …') : s; }

// Deutsches Datum/Uhrzeit aus ISO – für Vorschauen und Antworten.
function fmtDT(iso) {
  try {
    const d = new Date(iso); if (isNaN(d.getTime())) return String(iso || '');
    const date = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' }).format(d);
    const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(d);
    return date + ', ' + time + ' Uhr';
  } catch (e) { return String(iso || ''); }
}
function fmtDate(iso) {
  try {
    const d = new Date(String(iso).length === 10 ? (iso + 'T12:00:00Z') : iso); if (isNaN(d.getTime())) return String(iso || '');
    return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' }).format(d);
  } catch (e) { return String(iso || ''); }
}
function todayYMD() { return new Date().toISOString().slice(0, 10); }

module.exports = { isProduction, id, sha1, hashArgs, sortKeys, safeMessage, SAFE, clip, fmtDT, fmtDate, todayYMD };
