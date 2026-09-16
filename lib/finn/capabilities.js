'use strict';

/**
 * FINN – Capability Detection für Magicline-Scopes.
 * -----------------------------------------------------------------------------
 * Regel: Kein Scope wird als vorhanden ANGENOMMEN. Es gibt drei Zustände:
 *   ok         – ein Aufruf mit diesem Scope war erfolgreich (2xx)
 *   forbidden  – Magicline hat 403 geantwortet (gemerkt, 6 h)
 *   unknown    – noch nie probiert bzw. Gedächtnis abgelaufen
 *
 * `can(scope)` ist absichtlich optimistisch für alles außer MEMBER_LIST_READ:
 * die bestehenden Wrapper sind 403-fest, ein Versuch tut also nicht weh, und ein
 * 403 wird sofort gemerkt (danach bietet FINN das Werkzeug nicht mehr an).
 * MEMBER_LIST_READ gilt nur als nutzbar, wenn er in ML_SCOPES deklariert ist UND
 * nicht als forbidden gemerkt wurde (Auftrag: nicht implementieren, solange nicht
 * vorhanden – aber die Architektur vorbereiten).
 *
 * ML_SCOPES (kommagetrennt) ist eine DEKLARATION des Betreibers, keine Wahrheit:
 * sie steuert nur die Anzeige „erwartet" im Team-Backend.
 */

const KV = require('./kv');

const FORBIDDEN_TTL = 6 * 3600;     // nach 6 h wird erneut probiert (Scope könnte freigeschaltet sein)
const OK_TTL = 7 * 86400;

// Scope -> wofür FINN ihn braucht (für die Statusseite; Liste = die tatsächlich im Code genutzten Scopes).
const SCOPES = {
  CUSTOMER_READ: 'Kunde lesen, Suche, Vertrag',
  CUSTOMER_SELF_SERVICE_WRITE: 'Adresse, Kontakt, Bankdaten ändern',
  CUSTOMER_PRIVACY_WRITE: 'Datenschutz-Einstellungen',
  ADDITIONAL_INFORMATION_READ: 'Zusatzinformationen',
  CUSTOMER_BENEFIT_READ: 'Vorteile/Benefits',
  CUSTOMER_MEASUREMENT_READ: 'Körperwerte',
  MEMBERSHIP_SELF_SERVICE_READ: 'Kündigungsgründe, Pausen-Konfiguration',
  MEMBERSHIP_SELF_SERVICE_WRITE: 'Kündigung, Widerruf, Beitragspause',
  MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_READ: 'Zusatzmodule anzeigen',
  MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_WRITE: 'Zusatzmodule buchen/kündigen',
  MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_CONTRACT_READ: 'Modulvertrag lesen',
  CUSTOMER_ACCOUNT_READ: 'Beitragskonto',
  PAYMENT_WRITE: 'Zahlungsmittel (Finion Pay)',
  BOOKABLE_APPOINTMENTS_READ: 'Terminarten und freie Slots',
  APPOINTMENTS_READ: 'Gebuchte Termine',
  APPOINTMENTS_WRITE: 'Termin buchen/stornieren',
  CHECKIN_READ: 'Check-in-Verlauf',
  CHECKIN_WRITE: 'Ein-/Auschecken',
  CUSTOMER_ACCESS_MEDIUM_READ: 'Zugangsmedien anzeigen',
  CUSTOMER_ACCESS_MEDIUM_WRITE: 'Zugangsmedium sperren/ausgeben',
  CUSTOMER_DOCUMENT_READ: 'Dokumente anzeigen',
  CUSTOMER_DOCUMENT_WRITE: 'Dokumente hochladen',
  COMMUNICATION_WRITE: 'Nachrichten über Magicline',
  COMMUNICATION_PREFERENCES_READ: 'Kommunikations-Einwilligungen lesen',
  COMMUNICATION_PREFERENCES_WRITE: 'Kommunikations-Einwilligungen ändern',
  LEAD_READ: 'Lead-Konfiguration',
  LEAD_WRITE: 'Leads anlegen',
  STUDIO_READ: 'Öffnungszeiten, Auslastung',
  EMPLOYEE_READ: 'Mitarbeiter',
  MEMBER_LIST_READ: 'Mitgliederverzeichnis (bewusst NICHT angefragt)',
};
const NEVER_ASSUME = { MEMBER_LIST_READ: true };

const cache = new Map();   // scope -> { state, at, status, exp }
const KEY = (s) => 'finncap:' + String(s).toUpperCase();

function declared() {
  return String(process.env.ML_SCOPES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}
function isDeclared(scope) { return declared().indexOf(String(scope).toUpperCase()) >= 0; }

const CACHE_MS = 60000;
let loadedAt = 0;
function toEntry(v) {
  return v && v.state ? { state: v.state, at: v.at || 0, status: v.status || null, exp: Date.now() + CACHE_MS } : { state: 'unknown', at: 0, status: null, exp: Date.now() + CACHE_MS };
}
// Alle Scope-Zustände in EINEM KV-Aufruf laden (statt je Scope einzeln – das kostete
// pro Gesprächsschritt bis zu 30 Round-Trips). Danach bedient der Cache 60 s lang.
async function loadAll() {
  if (Date.now() - loadedAt < CACHE_MS) return;
  const names = Object.keys(SCOPES);
  const vals = await KV.mgetJSON(names.map(KEY));
  names.forEach((s, i) => { const c = cache.get(s); if (!(c && c.exp > Date.now())) cache.set(s, toEntry(vals[i])); });
  loadedAt = Date.now();
}
async function readState(scope) {
  const s = String(scope).toUpperCase();
  let c = cache.get(s);
  if (c && c.exp > Date.now()) return c;
  await loadAll();
  c = cache.get(s);
  if (c && c.exp > Date.now()) return c;
  const e = toEntry(await KV.getJSON(KEY(s)));   // Scope außerhalb der Liste
  cache.set(s, e);
  return e;
}
async function write(scope, state, status, ttl) {
  const s = String(scope).toUpperCase();
  const rec = { state: state, at: Date.now(), status: status || null };
  cache.set(s, Object.assign({ exp: Date.now() + 60000 }, rec));
  try { await KV.set(KEY(s), rec, ttl); } catch (e) {}
}

async function noteForbidden(scope, status) { if (!scope) return; await write(scope, 'forbidden', status || 403, FORBIDDEN_TTL); }
async function noteOk(scope) { if (!scope) return; await write(scope, 'ok', 200, OK_TTL); }

// Ergebnis eines Wrapper-Aufrufs auswerten: 403 -> forbidden, 2xx -> ok. Wirft nie.
async function record(scope, r) {
  if (!scope || !r) return;
  try {
    if (r.forbidden === true || r.status === 403 || r.status === 401) return await noteForbidden(scope, r.status || 403);
    if (r.ok === true || r.available === true || (r.status >= 200 && r.status < 300)) return await noteOk(scope);
  } catch (e) {}
}

// true = FINN darf es versuchen. false = bekannt verboten bzw. nie angenommen.
async function can(scope) {
  const s = String(scope || '').toUpperCase();
  if (!s) return true;
  const st = await readState(s);
  if (st.state === 'forbidden') return false;
  if (NEVER_ASSUME[s]) return isDeclared(s) && st.state === 'ok' ? true : (isDeclared(s) && st.state !== 'forbidden');
  return true;
}
async function canAll(scopes) {
  for (const s of (scopes || [])) { if (!(await can(s))) return false; }
  return true;
}

// Übersicht für das Team-Backend: 🟢 ok, 🟡 unknown (deklariert/nicht deklariert), 🔴 forbidden.
async function status() {
  const out = [];
  const dec = declared();
  for (const s of Object.keys(SCOPES)) {
    const st = await readState(s);
    const light = st.state === 'ok' ? 'green' : (st.state === 'forbidden' ? 'red' : 'yellow');
    out.push({ scope: s, purpose: SCOPES[s], state: st.state, light: light, declared: dec.indexOf(s) >= 0, at: st.at || null, status: st.status || null, neverAssume: !!NEVER_ASSUME[s] });
  }
  return out;
}

// Nur für Tests.
function _reset() { cache.clear(); loadedAt = 0; }

module.exports = { SCOPES, NEVER_ASSUME, declared, isDeclared, can, canAll, record, noteForbidden, noteOk, status, readState, _reset, FORBIDDEN_TTL };
