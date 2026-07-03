'use strict';

/**
 * Automatisch bearbeitete Anfragen – kumulative Zähler (best effort).
 * -------------------------------------------------------------------
 * Zählt, wie viele Kundenanfragen OHNE Team gelöst wurden. Drei Kategorien:
 *   ai     = die KI hat geantwortet (FINN-Chat / Kontakt-KI)
 *   system = Selbstbedienung direkt in Magicline verbucht (kein Team)
 *   team   = ein Mensch hat einen Vorgang abgeschlossen
 * Automatisierungsquote = (ai + system) / (ai + system + team).
 *
 * Grundsätze:
 *  - Rein additiv & best effort: record() wirft NIE und darf einen Endpunkt
 *    niemals bremsen oder brechen. Alle Fehler werden geschluckt.
 *  - Ohne Store (Upstash nicht konfiguriert) -> alles No-Op / 0.
 *  - Datenschutz: NUR anonyme Zähler, keinerlei Inhalte.
 *
 * Datenmodell (kumulative INCR-Zähler in Upstash):
 *   hnd:<kind>              Gesamtzähler je Kategorie
 *   hnd:<kind>:<subtype>    Zähler nach Art (z. B. hnd:system:kuendigung)
 *   hnd:m:<memberId>:<kind> Zähler pro Kunde
 */

const { redisPipeline, hasStore } = require('./store');

const KINDS = { ai: true, system: true, team: true };

function keyTotal(kind) { return 'hnd:' + kind; }
function keySub(kind, subtype) { return 'hnd:' + kind + ':' + subtype; }
function keyMember(memberId, kind) { return 'hnd:m:' + memberId + ':' + kind; }

// Subtype defensiv säubern (keine Sonderzeichen in Keys, kurz halten).
function safeSub(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
}
// MemberId defensiv als String (keine Doppelpunkte, damit der Key-Aufbau stimmt).
function safeMember(id) {
  return String(id == null ? '' : id).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
}

function toNum(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * Einen automatisch/team-seitig gelösten Vorgang zählen. kind ∈ {ai,system,team}.
 * Erhöht in EINER Pipeline: Gesamt, nach Art und pro Kunde. Best effort – wirft nie,
 * blockiert nichts Kritisches. Ohne Store: No-Op.
 */
async function record(kind, memberId, subtype) {
  try {
    if (!hasStore) return;
    if (!KINDS[kind]) return;
    const mid = safeMember(memberId);
    const sub = safeSub(subtype);
    const cmds = [['INCR', keyTotal(kind)]];
    if (sub) cmds.push(['INCR', keySub(kind, sub)]);
    if (mid) cmds.push(['INCR', keyMember(mid, kind)]);
    await redisPipeline(cmds);
  } catch (e) { /* best effort – Zähler dürfen einen Endpunkt nie brechen */ }
}

/**
 * Gesamtzahlen + Automatisierungsquote.
 * -> { ai, system, team, quote }  (quote als 0..1, 0 wenn Summe 0).
 */
async function totals() {
  const out = { ai: 0, system: 0, team: 0, quote: 0 };
  try {
    if (!hasStore) return out;
    const res = await redisPipeline([
      ['GET', keyTotal('ai')],
      ['GET', keyTotal('system')],
      ['GET', keyTotal('team')],
    ]);
    out.ai = toNum(res && res[0]);
    out.system = toNum(res && res[1]);
    out.team = toNum(res && res[2]);
    const auto = out.ai + out.system;
    const sum = auto + out.team;
    out.quote = sum > 0 ? auto / sum : 0;
  } catch (e) { /* best effort */ }
  return out;
}

/**
 * Zahlen pro Kunde. -> { ai, system, team } (0 ohne Store/ohne Daten).
 */
async function forMember(memberId) {
  const out = { ai: 0, system: 0, team: 0 };
  try {
    if (!hasStore) return out;
    const mid = safeMember(memberId);
    if (!mid) return out;
    const res = await redisPipeline([
      ['GET', keyMember(mid, 'ai')],
      ['GET', keyMember(mid, 'system')],
      ['GET', keyMember(mid, 'team')],
    ]);
    out.ai = toNum(res && res[0]);
    out.system = toNum(res && res[1]);
    out.team = toNum(res && res[2]);
  } catch (e) { /* best effort */ }
  return out;
}

module.exports = { record, totals, forMember };
