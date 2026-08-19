'use strict';

/**
 * Team-Backend: Verfügbarkeiten für den Schichtplaner.
 *   GET  ?employeeId=…   -> { ok, employeeId, name, days:{mo..so} }
 *        Trainer bekommt (nur) die eigene; Admin darf jede abrufen.
 *   POST { employeeId?, days, name? }
 *        Trainer speichert nur sich selbst; Admin jeden (employeeId nötig).
 *
 * Werte je Tag: 'frueh' | 'spaet' | 'egal' | 'frei' (Default 'egal').
 * Ohne Store Default-Antwort bzw. ehrliche Rückmeldung, wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const SH = require('../../lib/shifts');
const M = require('../../lib/members');   // readBody

function ident(sess) {
  const employeeId = (sess && sess.employeeId != null && String(sess.employeeId).trim() !== '')
    ? String(sess.employeeId).trim() : null;
  // Ohne Rollenfeld gilt die kleinere Berechtigung – sonst laese eine
  // Angestellte durch einen Schreibfehler die Zeiten des ganzen Teams.
  return { employeeId: employeeId, name: String((sess && sess.user) || 'Team'), role: TA.roleOf(sess) || 'trainer' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'shifts.manage', res)) return;
  const me = ident(sess);

  if (req.method === 'GET') {
    let q = null;
    try { q = new URL(req.url, 'http://x').searchParams.get('employeeId'); } catch (e) {}
    const target = (q && String(q).trim()) || me.employeeId;
    if (!target) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Mitarbeiter wählen.' })); }
    if (me.role !== 'admin' && target !== me.employeeId) {
      res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
    }
    const av = await SH.getAvailability(target);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, employeeId: target, name: av.name, days: av.days, updatedAt: av.updatedAt }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }

  const target = (body.employeeId != null && String(body.employeeId).trim() !== '')
    ? String(body.employeeId).trim() : me.employeeId;
  if (!target) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Mitarbeiter wählen.' })); }
  if (me.role !== 'admin' && target !== me.employeeId) {
    res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
  }

  if (!SH.hasStore) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, disabled: true, message: 'Speicher nicht verfügbar – Verfügbarkeit kann nicht gesichert werden.' }));
  }

  // Name mitpflegen: Trainer = eigener Session-Name; Admin darf ihn mitgeben
  // (Fallback: bereits gespeicherter Name).
  let name = (target === me.employeeId) ? me.name : String(body.name || '').trim();
  if (!name) { try { name = (await SH.getAvailability(target)).name || ''; } catch (e) {} }

  const av = await SH.setAvailability(target, name, body.days);
  if (!av) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Verfügbarkeit konnte nicht gespeichert werden.' })); }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, employeeId: target, name: av.name, days: av.days, updatedAt: av.updatedAt }));
};
