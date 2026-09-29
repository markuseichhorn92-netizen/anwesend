'use strict';

/**
 * FINN Journeys – Zustellstatus einer Journey-Nachricht (Twilio StatusCallback /
 * Meta statuses). Nur Nachrichten, die wir selbst gesendet haben (jr:out:<id>).
 *
 *   Fenster zu        63016 (Twilio) · 131047 (Meta)  -> Fenster als geschlossen merken,
 *                     Schritt einmal neu einplanen (dann als Vorlage)
 *   Marketingdeckel   63049 (Twilio) · 131049 (Meta)  -> einmal 24 h später erneut
 *   ungültige Nummer  63024, 63003, 21211 · 131026    -> Nummer sperren (facts.invalidPhone)
 */

const KV = require('../finn/kv');
const KPI = require('./kpi');
const Window = require('./window');
const Store = require('./store');

const WINDOW_CODES = { 63016: 1, 131047: 1 };
const CAP_CODES = { 63049: 1, 131049: 1 };
const INVALID_CODES = { 63024: 1, 63003: 1, 21211: 1, 131026: 1 };

async function onStatus(id, status, code) {
  if (!id) return { known: false };
  const rec = await KV.getJSON('jr:out:' + id);
  if (!rec) return { known: false };
  const s = String(status || '').toLowerCase();
  const c = code ? Number(String(code).replace(/[^0-9]/g, '')) : 0;
  // Testversand aus dem Team-Backend: nur den Stand fürs Versandprotokoll merken –
  // keine Kennzahlen, kein Wiederholen, keine Sperren.
  if (rec.t) {
    if (s === 'delivered') rec.d = 1;
    else if (s === 'read') { rec.d = 1; rec.r = 1; }
    else if (s === 'failed' || s === 'undelivered') rec.f = c || 1;
    await KV.set('jr:out:' + id, rec, 7 * 86400);
    return { known: true, test: true, code: c || null };
  }
  if (s === 'delivered' && !rec.d) { rec.d = 1; await KPI.bump(rec.j, 'delivered'); }
  else if (s === 'read' && !rec.r) { rec.r = 1; if (!rec.d) { rec.d = 1; await KPI.bump(rec.j, 'delivered'); } await KPI.bump(rec.j, 'read'); }
  else if ((s === 'failed' || s === 'undelivered') && !rec.f) {
    rec.f = c || 1;
    await KPI.bump(rec.j, 'failed');
    const Engine = require('./engine');
    if (WINDOW_CODES[c]) { await Window.close(rec.p); if (rec.via === 'session') await Engine.retry(rec.subj, rec.j, rec.s, 60000, 'window'); }
    else if (CAP_CODES[c]) { await Engine.retry(rec.subj, rec.j, rec.s, 24 * 3600000, 'cap'); }
    else if (INVALID_CODES[c]) {
      const st = await Store.load(rec.subj);
      if (st) { st.facts = st.facts || {}; st.facts.invalidPhone = Date.now(); await Store.save(st); }
    }
  }
  await KV.set('jr:out:' + id, rec, 7 * 86400);
  return { known: true, code: c || null };
}

module.exports = { onStatus, WINDOW_CODES, CAP_CODES, INVALID_CODES };
