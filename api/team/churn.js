'use strict';

/**
 * Team-Backend: Churn-Radar.
 *   GET -> { ok, members:[…], capped }   Risiko-Mitglieder (Score + Gründe)
 *
 * Kandidaten = Mitglieder, mit denen wir Vorgänge haben (globaler Inbox-Index).
 * Ein vollständiges Mitglieder-Verzeichnis aus Magicline bräuchte den Scope
 * MEMBER_LIST_READ (bewusst nicht angefragt) -> OHNE diesen Scope sind nur die
 * uns bereits BEKANNTEN Mitglieder bewertbar. Jeder Magicline-/Store-Zugriff
 * degradiert 403-/fehlersicher; fehlt der Store, kommt eine leere Liste zurück.
 *
 * Kostenbremse: es werden max. ASSESS_CAP Mitglieder bewertet (jeweils mit
 * begrenzter Nebenläufigkeit). Wurde gekappt, meldet die Antwort capped:true.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const Inbox = require('../../lib/inbox');
const Churn = require('../../lib/churn');

const ASSESS_CAP = 40;   // max. Mitglieder bewerten (Magicline-Reads begrenzen)
const SLICE = 6;         // begrenzte Nebenläufigkeit (nicht alle gleichzeitig)
const TOP = 20;          // max. ausgelieferte Risiko-Mitglieder

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'admin.manage', res)) return;
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  // Ohne Store kennen wir keine Vorgänge -> nichts bewertbar (kein Fehler).
  if (!Inbox.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, members: [] })); }

  // Kandidaten aus dem globalen Vorgangs-Index gruppieren (dedupliziert nach
  // Mitglied). Die bekannten Vorgänge je Mitglied gehen an assess weiter, damit
  // dort kein zweiter Inbox-Read nötig ist.
  let all = [];
  try { all = await Inbox.listAll({ limit: 400 }); } catch (e) { all = []; }

  const by = {};
  const order = [];
  for (const v of all) {
    const mid = v && v._memberId; if (!mid) continue;
    if (!by[mid]) { by[mid] = { memberId: String(mid), member: null, vorgaenge: [], last: 0 }; order.push(mid); }
    const g = by[mid];
    g.vorgaenge.push(v);
    if ((v.updatedAt || 0) > g.last) g.last = v.updatedAt || 0;
    if (!g.member && v.member && v.member.name) g.member = v.member;
  }

  // Neueste Aktivität zuerst, dann kappen (Kostenbremse).
  let cands = order.map((mid) => by[mid]).sort((a, b) => b.last - a.last);
  const capped = cands.length > ASSESS_CAP;
  if (capped) cands = cands.slice(0, ASSESS_CAP);

  // Bewerten mit begrenzter Nebenläufigkeit (Slices). assess wirft nie.
  const out = [];
  for (let i = 0; i < cands.length; i += SLICE) {
    const slice = cands.slice(i, i + SLICE);
    let scored = [];
    try {
      scored = await Promise.all(slice.map((g) => {
        const snap = g.member || {};
        return Churn.assess(g.memberId, {
          name: snap.name || null, nr: snap.nr || null, initials: snap.initials || null,
          vorgaenge: g.vorgaenge,
        });
      }));
    } catch (e) { scored = []; }
    for (const s of scored) { if (s) out.push(s); }
  }

  // Nur echte Risiken ausliefern, absteigend nach Score, auf Top TOP begrenzt.
  const members = out.filter((m) => m && m.level !== 'niedrig')
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, TOP);

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, members: members, capped: capped }));
};
