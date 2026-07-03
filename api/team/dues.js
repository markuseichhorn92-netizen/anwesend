'use strict';

/**
 * Team-Backend: Offene Beiträge / Mahn-Liste.
 *   GET -> { ok, members:[…], capped }   Mitglieder mit offenem Betrag / in Mahnung / Inkasso
 *
 * Damit das Empfangsteam gezielt nachfassen kann. Analog zum Churn-Radar
 * (siehe api/team/churn.js): Kandidaten = Mitglieder, mit denen wir Vorgänge
 * haben (globaler Inbox-Index). Ein vollständiges Mitglieder-Verzeichnis aus
 * Magicline bräuchte den Scope MEMBER_LIST_READ (bewusst nicht angefragt) ->
 * OHNE diesen Scope sind nur die uns bereits BEKANNTEN Mitglieder bewertbar.
 *
 * Graceful Degradation: Jeder Magicline-/Store-Zugriff degradiert 403-/fehlersicher.
 * Fehlt der Store -> leere Liste. Ist der Scope CUSTOMER_ACCOUNT_READ (noch) nicht
 * freigeschaltet, liefert accountSummary { available:false } -> solche Mitglieder
 * werden einfach ausgelassen. Es wird nie geworfen.
 *
 * Datenschutz: keine Roh-/Bankdaten – nur aggregierter offener Betrag + Status.
 * Kostenbremse: max. ASSESS_CAP Mitglieder bewertet (begrenzte Nebenläufigkeit).
 * Wurde gekappt, meldet die Antwort capped:true.
 */

const TA = require('../../lib/teamAuth');
const Inbox = require('../../lib/inbox');
const MLAccount = require('../../lib/mlAccount');
const View = require('../../lib/teamView');

const ASSESS_CAP = 40;   // max. Mitglieder bewerten (Magicline-Reads begrenzen)
const SLICE = 6;         // begrenzte Nebenläufigkeit (nicht alle gleichzeitig)
const TOP = 25;          // max. ausgelieferte Mitglieder mit Rückstand

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  // Ohne Store kennen wir keine Vorgänge -> nichts bewertbar (kein Fehler).
  if (!Inbox.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, members: [] })); }

  // Kandidaten aus dem globalen Vorgangs-Index dedupliziert nach Mitglied.
  // (Ohne MEMBER_LIST_READ nur bekannte Mitglieder bewertbar – siehe oben.)
  let all = [];
  try { all = await Inbox.listAll({ limit: 400 }); } catch (e) { all = []; }

  const by = {};
  const order = [];
  for (const v of all) {
    const mid = v && v._memberId; if (!mid) continue;
    if (!by[mid]) { by[mid] = { memberId: String(mid), member: null, last: 0 }; order.push(mid); }
    const g = by[mid];
    if ((v.updatedAt || 0) > g.last) g.last = v.updatedAt || 0;
    if (!g.member && v.member && v.member.name) g.member = v.member;   // Snapshot für Name/Nr/Initialen
  }

  // Neueste Aktivität zuerst, dann kappen (Kostenbremse).
  let cands = order.map((mid) => by[mid]).sort((a, b) => b.last - a.last);
  const capped = cands.length > ASSESS_CAP;
  if (capped) cands = cands.slice(0, ASSESS_CAP);

  // Kontozusammenfassung je Kandidat mit begrenzter Nebenläufigkeit (Slices).
  // accountSummary degradiert 403-/fehlersicher -> { available:false }.
  const out = [];
  for (let i = 0; i < cands.length; i += SLICE) {
    const slice = cands.slice(i, i + SLICE);
    let sums = [];
    try {
      sums = await Promise.all(slice.map(async (g) => {
        let a = { available: false };
        try { a = await MLAccount.accountSummary(g.memberId); } catch (e) { a = { available: false }; }
        return { g: g, a: a || { available: false } };
      }));
    } catch (e) { sums = []; }

    for (const s of sums) {
      if (!s) continue;
      const a = s.a || {};
      // Ohne Scope (403) -> available:false -> Mitglied auslassen.
      if (!a.available) continue;

      const dlp = parseInt(a.dunningLevel, 10);
      const dunningLevel = (Number.isFinite(dlp) && dlp > 0) ? dlp : 0;
      const ocp = parseInt(a.openCount, 10);
      const openCount = (Number.isFinite(ocp) && ocp > 0) ? ocp : 0;
      const openTotal = (typeof a.openTotal === 'number' && Number.isFinite(a.openTotal)) ? a.openTotal : 0;
      const inDebtCollection = !!a.inDebtCollection;

      // Nur echte Rückstände übernehmen.
      if (!(inDebtCollection || dunningLevel > 0 || openCount > 0 || openTotal > 0)) continue;

      const snap = s.g.member || {};
      let name = snap.name || null;
      if (!name) name = 'Mitglied ' + s.g.memberId;
      let initials = snap.initials || null;
      if (!initials) { try { initials = View.initials(name); } catch (e) { initials = 'M'; } }

      out.push({
        id: s.g.memberId,
        name: name,
        nr: (snap.nr != null) ? snap.nr : null,
        initials: initials,
        openTotal: openTotal,
        currency: a.currency || 'EUR',
        openCount: openCount,
        dunningLevel: dunningLevel,
        inDebtCollection: inDebtCollection,
      });
    }
  }

  // Sortieren nach Schwere: Inkasso zuerst, dann Mahnstufe absteigend, dann offener Betrag absteigend.
  out.sort((a, b) => {
    if (a.inDebtCollection !== b.inDebtCollection) return a.inDebtCollection ? -1 : 1;
    if ((b.dunningLevel || 0) !== (a.dunningLevel || 0)) return (b.dunningLevel || 0) - (a.dunningLevel || 0);
    return (b.openTotal || 0) - (a.openTotal || 0);
  });

  const members = out.slice(0, TOP);

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, members: members, capped: capped }));
};
