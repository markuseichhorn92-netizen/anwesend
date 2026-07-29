'use strict';

/**
 * „Gemeinsam kochen" – teilbarer Kochtopf mit prozentualem Anteil je Person.
 * -----------------------------------------------------------------------------
 * Zwei (oder mehr) Mitglieder kochen EINEN Topf und tracken jeweils NUR ihren
 * Anteil im eigenen Ernährungstagebuch. Ein Topf hält die Gesamt-Nährwerte des
 * ganzen Topfs plus eine Teilnehmerliste mit Prozent-Anteilen. Geteilt wird über
 * einen kurzen, eindeutigen Code (Link/QR) – wie beim Buddy-System (lib/social.js).
 *
 * Bewusst datensparsam: der Topf enthält NUR Titel, Nährwerte, optionale Zutaten
 * und je Teilnehmer Anzeigename + Prozent. KEINE Kontakt-/Mitgliedsdaten, keine
 * fremden Tagebücher. Nur wer den Code hat, sieht den Topf. Codes laufen ab (TTL).
 *
 * Store (Upstash Redis), Präfix cook:
 *   cook:pot:<CODE>   STRING(JSON) – der Topf (mit gleitender TTL bei Aktivität)
 *
 * Topf: { code, title, source:'recipe'|'ai'|'manual',
 *         total:{kcal,p,c,f},                    // GANZER Topf
 *         ingredients:[{text,grams}],            // optional (Anzeige)
 *         owner:{id,name},
 *         participants:[{id,name,pct,loggedAt}],
 *         createdAt, updatedAt }
 *
 * Grundsatz wie im Bestand: wirft NIE. Ohne Store -> null/keine Persistenz.
 */

const crypto = require('crypto');
const { redisPipeline, hasStore } = require('./store');

const POT = (code) => 'cook:pot:' + String(code).toUpperCase();
const TTL = 60 * 60 * 24 * 30;   // 30 Tage; bei jeder Aktualisierung erneuert (gleitend)
// Verwechslungsarmes Alphabet (ohne I, O, 0, 1) – identisch zum Buddy-Code.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const MAX_PARTICIPANTS = 8;
const MAX_INGREDIENTS = 30;
const MAX_NAME = 40;
const MAX_TITLE = 80;

function sid(x) { return String(x == null ? '' : x).trim(); }
function n0(v) { const n = Math.round(Number(v)); return (isNaN(n) || n < 0) ? 0 : n; }
function clampPct(v) { const n = Math.round(Number(v)); return isNaN(n) ? 0 : Math.max(0, Math.min(100, n)); }
function str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

function randomCode() {
  const b = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

function normTotal(t) { t = t || {}; return { kcal: n0(t.kcal), p: n0(t.p), c: n0(t.c), f: n0(t.f) }; }
function totalEmpty(t) { return !(t.kcal > 0 || t.p > 0 || t.c > 0 || t.f > 0); }
function normPerson(p) { p = p || {}; const idv = sid(p.id); if (!idv) return null; return { id: idv, name: str(p.name, MAX_NAME) || 'Mitglied' }; }
function normIngredient(x) {
  const text = str(x && (x.text || x.name), 90);
  if (!text) return null;
  return { text: text, grams: n0(x && x.grams) };
}

async function getPot(code) {
  code = sid(code).toUpperCase();
  if (!hasStore || !code) return null;
  let s;
  try { [s] = await redisPipeline([['GET', POT(code)]]); } catch (e) { return null; }
  if (!s || s === '1') return null;   // '1' = reservierter, noch nicht gefüllter Code
  try { const pot = JSON.parse(s); return (pot && pot.code) ? pot : null; } catch (e) { return null; }
}

async function savePot(pot) {
  if (!hasStore || !pot || !pot.code) return false;
  try { await redisPipeline([['SET', POT(pot.code), JSON.stringify(pot), 'EX', TTL]]); return true; }
  catch (e) { return false; }
}

// Neuen Topf anlegen. owner = {id,name}; o = { title, total:{kcal,p,c,f}, ingredients?, source? }.
// Der Ersteller ist automatisch erster Teilnehmer (Anteil 0 %, setzt er selbst).
async function createPot(owner, o) {
  o = o || {};
  const own = normPerson(owner);
  const total = normTotal(o.total);
  if (!hasStore || !own || totalEmpty(total)) return null;
  const title = str(o.title, MAX_TITLE) || 'Gemeinsamer Topf';
  const ingredients = (Array.isArray(o.ingredients) ? o.ingredients : []).slice(0, MAX_INGREDIENTS).map(normIngredient).filter(Boolean);
  const source = ['recipe', 'ai', 'manual'].indexOf(o.source) >= 0 ? o.source : 'manual';
  // Eindeutigen Code beanspruchen (SET NX) – reserviert den Schlüssel, bevor der Topf gefüllt wird.
  let code = null;
  for (let i = 0; i < 8; i++) {
    const c = randomCode();
    try { const [set] = await redisPipeline([['SET', POT(c), '1', 'NX', 'EX', TTL]]); if (set) { code = c; break; } }
    catch (e) { code = c; break; }
  }
  if (!code) return null;
  const now = Date.now();
  const pot = {
    code: code, title: title, source: source, total: total, ingredients: ingredients,
    owner: own, participants: [{ id: own.id, name: own.name, pct: 0, loggedAt: 0 }],
    createdAt: now, updatedAt: now,
  };
  if (!(await savePot(pot))) return null;
  return pot;
}

// Person dem Topf hinzufügen (idempotent). Liefert den Topf (oder null ohne Code/Person).
async function joinPot(code, person) {
  const pot = await getPot(code);
  const per = normPerson(person);
  if (!pot || !per) return null;
  const exists = (pot.participants || []).some(function (p) { return String(p.id) === per.id; });
  if (!exists) {
    if ((pot.participants || []).length >= MAX_PARTICIPANTS) return pot;   // voll -> nur ansehen
    pot.participants.push({ id: per.id, name: per.name, pct: 0, loggedAt: 0 });
    pot.updatedAt = Date.now();
    await savePot(pot);
  }
  return pot;
}

function participantOf(pot, memberId) {
  const mid = sid(memberId);
  return (pot && pot.participants || []).filter(function (p) { return String(p.id) === mid; })[0] || null;
}

// Eigenen Anteil (in %) setzen. Nur wer Teilnehmer ist.
async function setPct(code, memberId, pct) {
  const pot = await getPot(code);
  if (!pot) return null;
  const p = participantOf(pot, memberId);
  if (!p) return null;
  p.pct = clampPct(pct);
  pot.updatedAt = Date.now();
  await savePot(pot);
  return pot;
}

// Merkt: dieser Teilnehmer hat seinen Anteil ins Tagebuch übernommen.
async function markLogged(code, memberId) {
  const pot = await getPot(code);
  if (!pot) return null;
  const p = participantOf(pot, memberId);
  if (!p) return null;
  p.loggedAt = Date.now();
  pot.updatedAt = Date.now();
  await savePot(pot);
  return pot;
}

// Topf verlassen. Der Ersteller löscht damit den ganzen Topf; andere entfernen nur sich.
async function leavePot(code, memberId) {
  const pot = await getPot(code);
  const mid = sid(memberId);
  if (!pot || !mid) return null;
  if (String(pot.owner && pot.owner.id) === mid) {
    try { await redisPipeline([['DEL', POT(pot.code)]]); } catch (e) {}
    return { deleted: true };
  }
  pot.participants = (pot.participants || []).filter(function (p) { return String(p.id) !== mid; });
  pot.updatedAt = Date.now();
  await savePot(pot);
  return pot;
}

// Der auf den Anteil (pct %) skalierte Nährwert-Beitrag einer Person – dieselbe
// Faktor-Skalierung wie beim portionsweisen Eintragen im Tagebuch.
function shareFor(pot, memberId) {
  const p = participantOf(pot, memberId);
  const pct = p ? clampPct(p.pct) : 0;
  const fac = pct / 100;
  const t = normTotal(pot && pot.total);
  return {
    pct: pct,
    kcal: Math.round(t.kcal * fac),
    p: Math.round(t.p * fac),
    c: Math.round(t.c * fac),
    f: Math.round(t.f * fac),
  };
}

module.exports = {
  getPot, createPot, joinPot, setPct, markLogged, leavePot, shareFor, participantOf,
  normTotal, TTL, MAX_PARTICIPANTS, CODE_LEN,
  hasStore,
};
