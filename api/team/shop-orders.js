'use strict';

/**
 * Team-Backend: Bestellungen aus dem Online-Shop verwalten.
 *
 *   GET                                  -> { ok, bestellungen, zaehler }
 *   POST { action:'update', extId, status?, versand?, notiz? }
 *   POST { action:'note',   extId, notiz }
 *
 * Der Shop bleibt Herr ueber Betrag und Positionen - das Team ueber
 * Bearbeitungsstand, Sendungsnummer und interne Notiz. Sonst laufen zwei
 * Wahrheiten nebeneinander her, und beim naechsten Statuswechsel aus dem Shop
 * ist die Handarbeit weg.
 *
 * Der Name des Mitglieds wird beim Lesen frisch nachgeschlagen und NICHT
 * mitgespeichert: eine Namensaenderung soll nicht in alten Bestellungen
 * weiterleben, und eine geloeschte Person taucht nicht wieder auf.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const SL = require('../../lib/shopLink');
const { hasStore } = require('../../lib/store');

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

// Namen in EINEM Rutsch nachschlagen: bei 100 Bestellungen waeren es sonst
// 100 Magicline-Aufrufe hintereinander.
async function namen(ids) {
  const out = {};
  const eindeutig = Array.from(new Set(ids.filter(function (x) { return x != null; }).map(String)));
  await Promise.all(eindeutig.map(async function (id) {
    try {
      const m = await M.getMember(id);
      out[id] = m ? { name: ((m.firstName || '') + ' ' + (m.lastName || '')).trim() || null, nummer: m.customerNumber || null } : null;
    } catch (e) { out[id] = null; }
  }));
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  const sess = await TA.requireTeam(req);
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!Cap.requireCap(sess, 'member.read', res)) return;
  if (!hasStore) return j(res, 200, { ok: true, available: false, bestellungen: [] });

  if (req.method === 'GET') {
    const liste = await SL.alleOrders(200);
    const info = await namen(liste.map(function (b) { return b.memberId; }));
    const zaehler = {};
    liste.forEach(function (b) { zaehler[b.status] = (zaehler[b.status] || 0) + 1; });
    return j(res, 200, {
      ok: true, available: true,
      zaehler: zaehler,
      status: SL.STATUS,
      bestellungen: liste.map(function (b) {
        const p = info[String(b.memberId)] || null;
        return Object.assign({}, b, { memberId: undefined, mitglied: p && p.name, mitgliedsnummer: p && p.nummer });
      }),
    });
  }

  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });
  // Bearbeiten ist mehr als Lesen.
  if (!Cap.requireCap(sess, 'member.write', res)) return;

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const action = String((body && body.action) || '');
  const extId = String((body && body.extId) || '').trim();
  if (!extId) return j(res, 200, { ok: false, message: 'Keine Bestellung angegeben.' });

  if (action !== 'update' && action !== 'note') return j(res, 200, { ok: false, error: 'unknown_action' });

  const wer = String((sess && sess.user) || 'Team');
  const r = await SL.teamUpdate(extId, {
    status: action === 'update' ? body.status : undefined,
    versand: action === 'update' ? body.versand : undefined,
    notiz: body.notiz,
  }, wer);
  if (!r.ok) return j(res, 200, { ok: false, error: r.error });

  const info = await namen([r.bestellung.memberId]);
  const p = info[String(r.bestellung.memberId)] || null;
  return j(res, 200, { ok: true, bestellung: Object.assign({}, r.bestellung, { memberId: undefined, mitglied: p && p.name, mitgliedsnummer: p && p.nummer }) });
};
