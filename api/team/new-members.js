'use strict';

/**
 * Team-Backend: „Neue Mitglieder" (zuletzt beigetreten).
 *   GET -> { ok, members:[{ id, joinedAt, name, customerNumber, firstName, lastName }], count, disabled? }
 *
 * Quelle: lib/newMembers.js merkt sich Beitritte aus dem Magicline-Webhook
 * (CONTRACT_CREATED = echter Vertragsabschluss, NICHT bloße Leads). Gespeichert wird
 * datensparsam nur ID + Zeitpunkt; Name/Nummer holen wir hier erst beim Anzeigen frisch
 * aus Magicline. Fällt eine Anreicherung aus (z. B. Rate-Limit), bleibt der Eintrag mit
 * Zeit + ID erhalten. Für Trainer/Studio-Team (Capability member.read).
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const NM = require('../../lib/newMembers');

const SHOW = 30;          // so viele Beitritte anzeigen
const ENRICH_MAX = 25;    // so viele davon per Magicline mit Name/Nummer anreichern

function nameOf(m) {
  if (!m) return null;
  const n = [m.firstName, m.lastName].filter(function (x) { return x && String(x).trim(); }).join(' ').trim();
  return n || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'member.read', res)) return;

  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  if (!NM || !require('../../lib/store').hasStore) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, disabled: true, members: [], count: 0 }));
  }

  let joins = [];
  try { joins = await NM.listJoins(SHOW); } catch (e) { joins = []; }

  // Name/Nummer frisch aus Magicline nachladen (gekappt, parallel; Fehler tolerant).
  const members = await Promise.all(joins.map(async function (j, i) {
    const base = { id: j.id, joinedAt: j.joinedAt || null, name: null, customerNumber: null, firstName: null, lastName: null };
    if (i >= ENRICH_MAX) return base;
    try {
      const m = await M.getMember(j.id);
      if (m) {
        base.name = nameOf(m);
        base.customerNumber = m.customerNumber || null;
        base.firstName = m.firstName || null;
        base.lastName = m.lastName || null;
      }
    } catch (e) {}
    return base;
  }));

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, members: members, count: members.length }));
};
