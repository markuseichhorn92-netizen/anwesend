'use strict';

/**
 * WhatsApp-Einwilligungen und Sperrliste – je Rufnummer.
 * -----------------------------------------------------------------------------
 * Zwei getrennte Einwilligungen (UWG § 7, DSGVO Art. 6/7):
 *   service    – Terminerinnerungen und Hinweise zur Mitgliedschaft / zum Probetraining
 *   marketing  – Motivation, Fortschritt (aus Check-ins), Tipps und Angebote
 * Beides hängt an der NUMMER: WhatsApp ist ein Kanal je Nummer, und STOP kommt
 * von der Nummer, nicht von einer Kundennummer. Ist die Person bekannt (Mitglied),
 * wird die Einwilligung zusätzlich im Datenschutz-Nachweis (lib/privacy) geführt.
 *
 * jr:con:<nummer>  { service:{g,at,src,v,h}, marketing:{…}, log:[…20], cid?, lead? }
 * jr:sup:<hmac>    STOP-Sperre. Gehasht, damit nach einer Löschung keine Klarnummer
 *                  übrig bleibt; bleibt als Nachweis des Widerspruchs stehen (3 Jahre).
 */

const crypto = require('node:crypto');
const KV = require('../finn/kv');
const Phone = require('../phone');

const VERSION = '2026-09-29.1';
const TEXTS = Object.freeze({
  service: 'Ich möchte von Fit-Inn Trier per WhatsApp an meine Termine (z. B. Probetraining oder Einführungstraining) erinnert werden und Hinweise zu meiner Anmeldung bzw. Mitgliedschaft erhalten. Abmeldung jederzeit mit der Nachricht „STOP".',
  marketing: 'Ich möchte von Fit-Inn Trier per WhatsApp Motivation, Hinweise zu meinem Trainingsfortschritt, Tipps und Angebote erhalten (höchstens zwei Nachrichten pro Woche). Dafür wertet Fit-Inn die Anzahl und Häufigkeit meiner Check-ins aus. Einwilligung freiwillig, Abmeldung jederzeit mit „STOP".',
});
const TYPES = ['service', 'marketing'];
const PRIVACY_TYPE = { service: 'wa_service', marketing: 'wa_marketing' };
const CON_TTL = 3 * 365 * 86400;
const SUP_TTL = 3 * 365 * 86400;
const LOG_CAP = 20;

const K = (p) => 'jr:con:' + p;
function hashKey() { return process.env.JOURNEYS_HASH_KEY || process.env.MAGICLINE_WEBHOOK_KEY || process.env.CRON_SECRET || 'fitinn-journeys'; }
function supKey(p) { return 'jr:sup:' + crypto.createHmac('sha256', hashKey()).update(String(p)).digest('hex').slice(0, 32); }
function textHash(t) { return crypto.createHash('sha256').update(String(t || ''), 'utf8').digest('hex').slice(0, 16); }

async function raw(phone) {
  const p = Phone.canon(phone); if (!p) return null;
  return (await KV.getJSON(K(p))) || { log: [] };
}

// { service:bool, marketing:bool, suppressed:bool, serviceAt, marketingAt, src }
async function get(phone) {
  const p = Phone.canon(phone);
  if (!p) return { service: false, marketing: false, suppressed: false };
  const r = (await KV.getJSON(K(p))) || {};
  const sup = await suppressed(p);
  const s = !!(r.service && r.service.g), m = !!(r.marketing && r.marketing.g);
  return { service: !sup && (s || m), marketing: !sup && m, suppressed: sup, serviceAt: r.service ? r.service.at : null, marketingAt: r.marketing ? r.marketing.at : null, src: (r.marketing && r.marketing.src) || (r.service && r.service.src) || null };
}

async function mirrorPrivacy(cid, types, granted, src) {
  if (!cid || !/^[0-9]{1,12}$/.test(String(cid))) return;
  try {
    const Privacy = require('../privacy');
    for (const t of types) { if (PRIVACY_TYPE[t]) await Privacy.recordConsent(String(cid), PRIVACY_TYPE[t], granted, { source: String(src || 'whatsapp').slice(0, 60) }); }
  } catch (e) {}
}

// Einwilligung(en) erteilen. meta: { src, cid?, leadId? }
async function grant(phone, types, meta) {
  meta = meta || {};
  const p = Phone.canon(phone); if (!p) return null;
  types = (Array.isArray(types) ? types : [types]).filter((t) => TYPES.indexOf(t) >= 0);
  if (!types.length) return null;
  const r = await raw(p);
  const now = Date.now();
  types.forEach((t) => {
    r[t] = { g: true, at: now, src: String(meta.src || 'unbekannt').slice(0, 40), v: VERSION, h: textHash(TEXTS[t]) };
    r.log = [{ t: t, g: true, at: now, src: r[t].src }].concat(r.log || []).slice(0, LOG_CAP);
  });
  if (meta.cid) r.cid = String(meta.cid);
  if (meta.leadId) r.lead = String(meta.leadId);
  await KV.set(K(p), r, CON_TTL);
  await KV.del(supKey(p));          // erneute Einwilligung hebt einen früheren STOP auf
  await mirrorPrivacy(meta.cid || r.cid, types, true, meta.src);
  return get(p);
}

// Einwilligung(en) widerrufen. Ohne types: beide.
async function withdraw(phone, types, meta) {
  meta = meta || {};
  const p = Phone.canon(phone); if (!p) return null;
  types = (Array.isArray(types) && types.length ? types : TYPES).filter((t) => TYPES.indexOf(t) >= 0);
  const r = await raw(p);
  const now = Date.now();
  types.forEach((t) => {
    r[t] = { g: false, at: now, src: String(meta.src || 'unbekannt').slice(0, 40), v: VERSION };
    r.log = [{ t: t, g: false, at: now, src: r[t].src }].concat(r.log || []).slice(0, LOG_CAP);
  });
  if (meta.cid) r.cid = String(meta.cid);
  await KV.set(K(p), r, CON_TTL);
  await mirrorPrivacy(meta.cid || r.cid, types, false, meta.src);
  return get(p);
}

async function suppress(phone) { const p = Phone.canon(phone); if (!p) return false; return !!(await KV.set(supKey(p), String(Date.now()), SUP_TTL)); }
async function unsuppress(phone) { const p = Phone.canon(phone); if (!p) return false; return !!(await KV.del(supKey(p))); }
async function suppressed(phone) { const p = Phone.canon(phone); if (!p) return false; return (await KV.get(supKey(p))) != null; }

// Nachweis für Export/Team: Verlauf ohne Klartexte.
async function history(phone) { const r = await raw(phone); return r ? (r.log || []) : []; }
// Löschung der App-Daten: Einwilligungs-Datensatz der Nummer entfernen (Widerruf
// ist dann ohnehin im Datenschutz-Nachweis vermerkt). Die Sperrliste bleibt.
async function erase(phone) { const p = Phone.canon(phone); if (!p) return false; return !!(await KV.del(K(p))); }

module.exports = { VERSION, TEXTS, TYPES, PRIVACY_TYPE, get, grant, withdraw, suppress, unsuppress, suppressed, history, erase, textHash };
