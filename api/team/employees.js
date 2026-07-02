'use strict';

/**
 * GET /api/team/employees   (Bearer Team-Token)
 * Mitarbeiterliste aus Magicline (Scope EMPLOYEE_READ) für die
 * „Zuständig"-Auswahl im Posteingang.
 *
 * Degradiert sauber: Fehlt der Scope (403) oder schlägt der Abruf fehl,
 * antworten wir mit { ok:true, available:false } – die UI blendet die
 * Auswahl dann einfach aus, statt einen Fehler zu zeigen.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');

const MAX_PAGES = 3;   // Sicherheitskappe – kleines Studio-Team, mehr braucht es nicht

function mapEmployee(e) {
  if (!e || e.id == null) return null;
  const first = String(e.firstName || '').trim();
  const last = String(e.lastName || '').trim();
  let name = (first + ' ' + last).trim();
  if (!name) name = String(e.publicName || e.name || '').trim();
  if (!name) name = 'Mitarbeiter ' + e.id;
  return { id: String(e.id), firstName: first || null, lastName: last || null, name };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const employees = [];
  let available = false;
  try {
    let offset = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await M.ml('GET', '/employees?sliceSize=50' + (offset ? ('&offset=' + encodeURIComponent(offset)) : ''));
      if (r.status !== 200 || !r.json) break;   // 403 = Scope fehlt -> available bleibt false
      available = true;
      const list = Array.isArray(r.json.result) ? r.json.result : (Array.isArray(r.json) ? r.json : []);
      list.forEach((e) => { const m = mapEmployee(e); if (m) employees.push(m); });
      if (!r.json.hasNext || !list.length) break;
      offset = r.json.offset || null;
      if (!offset) break;
    }
  } catch (e) {}

  res.statusCode = 200;
  if (!available) return res.end(JSON.stringify({ ok: true, available: false }));
  employees.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return res.end(JSON.stringify({ ok: true, available: true, employees }));
};
