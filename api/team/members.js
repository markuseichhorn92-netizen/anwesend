'use strict';

/**
 * Team-Backend: Mitglieder.
 *   GET                 -> { ok, members:[…] }   Verzeichnis (alle, mit denen wir Vorgänge haben)
 *   GET ?q=<suche>      -> { ok, results:[…] }   Magicline-Suche (E-Mail / Nummer / Name)
 *   GET ?id=<memberId>  -> { ok, profile:{…} }   Vollprofil (Stammdaten, Vertrag, Termine, Historie)
 *
 * Hinweis: Ein vollständiges Mitglieder-Verzeichnis aus Magicline bräuchte den
 * Scope MEMBER_LIST_READ (bewusst nicht angefragt). Daher: Verzeichnis = Mitglieder
 * mit Vorgängen + gezielte Suche über CUSTOMER_READ.
 */

const TA = require('../../lib/teamAuth');
const Inbox = require('../../lib/inbox');
const M = require('../../lib/members');
const View = require('../../lib/teamView');

const ENRICH_CAP = 16;

function isCancelledAppt(a) {
  if (!a) return true;
  if (a.cancelled === true || a.canceled === true || a.deleted === true) return true;
  if (a.active === false) return true;
  const s = [a.status, a.appointmentStatus, a.bookingStatus, a.state].filter(Boolean).join(' ').toUpperCase();
  return /CANCEL|STORN|DELET|ABGESAGT|ABGELEHNT|NO_?SHOW|DECLIN/.test(s);
}

function mapSearch(c) {
  const name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
  const id = c.id != null ? String(c.id) : (c.customerId != null ? String(c.customerId) : null);
  return { id, name: name || 'Mitglied', nr: c.customerNumber || null, initials: View.initials(name || 'Mitglied'),
    email: c.email || null, phone: c.phonePrivate || c.phoneMobile || null };
}

// Magicline-Suche: E-Mail / Mitgliedsnummer / Name.
async function searchMembers(q) {
  q = String(q || '').trim();
  if (!q) return [];
  if (q.indexOf('@') >= 0) {
    try { const r = await M.ml('POST', '/customers/search', { email: q }); return Array.isArray(r.json) ? r.json : []; } catch (e) { return []; }
  }
  if (/^[0-9]{3,}$/.test(q)) {
    try { const r = await M.ml('GET', '/customers/by?customerNumber=' + encodeURIComponent(q)); if (r.status === 200 && r.json) return [r.json]; } catch (e) {}
    try { const r = await M.ml('POST', '/customers/search', { phoneNumber: q }); if (Array.isArray(r.json) && r.json.length) return r.json; } catch (e) {}
    return [];
  }
  const parts = q.split(/\s+/).filter(Boolean);
  const body = parts.length >= 2 ? { firstName: parts[0], lastName: parts.slice(1).join(' ') } : { lastName: parts[0] };
  try {
    let r = await M.ml('POST', '/customers/search', body);
    let arr = Array.isArray(r.json) ? r.json : [];
    if (!arr.length && parts.length === 1) { r = await M.ml('POST', '/customers/search', { firstName: parts[0] }); arr = Array.isArray(r.json) ? r.json : []; }
    return arr;
  } catch (e) { return []; }
}

// Verzeichnis aus den Vorgängen (Mitglieder, mit denen wir Kontakt hatten).
async function directory() {
  const all = await Inbox.listAll({ limit: 400 });
  // fehlende Snapshots gekappt nachladen + persistieren
  const need = []; const seen = {};
  for (const v of all) { const mid = v._memberId; if (mid && !seen[mid] && (!v.member || !v.member.name)) { seen[mid] = 1; need.push(mid); } }
  const snaps = {};
  await Promise.all(need.slice(0, ENRICH_CAP).map(async (mid) => {
    try { const mm = await M.getMember(mid); const s = View.snapshotFromMember(mm); if (s) snaps[mid] = s; } catch (e) {}
  }));
  const persists = [];
  for (const v of all) { if ((!v.member || !v.member.name) && snaps[v._memberId]) { v.member = snaps[v._memberId]; persists.push(Inbox.setMemberSnapshot(v._memberId, v.id, snaps[v._memberId]).catch(() => {})); } }
  if (persists.length) { try { await Promise.all(persists); } catch (e) {} }

  const by = {};
  for (const v of all) {
    const mid = v._memberId; if (!mid) continue;
    const g = by[mid] || (by[mid] = { memberId: mid, member: null, open: 0, total: 0, last: 0 });
    g.total++; if (v.teamStatus !== 'abgeschlossen') g.open++;
    if ((v.updatedAt || 0) > g.last) g.last = v.updatedAt || 0;
    if (!g.member && v.member && v.member.name) g.member = v.member;
  }
  return Object.keys(by).map((mid) => {
    const g = by[mid]; const mem = g.member || { name: 'Mitglied ' + mid, nr: null, initials: 'M' };
    return { memberId: mid, name: mem.name, nr: mem.nr || null, initials: mem.initials || 'M', openCount: g.open, total: g.total, lastActivity: g.last };
  }).sort((a, b) => b.lastActivity - a.lastActivity);
}

// Vollprofil eines Mitglieds.
async function profile(id) {
  const m = await M.getMember(id);
  if (!m) return null;
  const p = M.publicProfile(m) || {};
  let contract = null; try { contract = await M.getContract(id); } catch (e) {}
  let appointments = [];
  try {
    const r = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(id));
    const list = Array.isArray(r.json) ? r.json : [];
    appointments = list.filter((a) => !isCancelledAppt(a))
      .map((a) => ({ title: a.title || a.name || 'Termin', start: a.startDateTime || null, end: a.endDateTime || null }))
      .filter((a) => a.start).sort((x, y) => new Date(x.start) - new Date(y.start));
  } catch (e) {}
  let history = [];
  try {
    const hs = await Inbox.list(id);
    history = (hs || []).filter((v) => v.type !== 'willkommen').map((v) => ({
      key: id + ':' + v.id, id: v.id, type: v.type, subject: v.subject, ref: v.ref,
      teamStatus: v.teamStatus || 'neu', updatedAt: v.updatedAt || 0,
    }));
  } catch (e) {}
  const name = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
  const addr = [((p.street || '') + (p.houseNumber ? (' ' + p.houseNumber) : '')).trim(), ((p.zipCode || '') + ' ' + (p.city || '')).trim()].filter((s) => s).join(', ');
  return {
    id: String(id), name: name || 'Mitglied', initials: View.initials(name || 'Mitglied'),
    nr: p.customerNumber || null, email: p.email || null, phone: p.phonePrivate || null,
    birthday: p.dateOfBirth || null, address: addr || null, ibanMasked: p.ibanMasked || null,
    contract: contract, appointments: appointments, history: history,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  const q = url.searchParams.get('q');

  if (id) {
    const p = await profile(id);
    if (!p) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, profile: p }));
  }
  if (q != null && q.trim()) {
    const r = await searchMembers(q);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, results: r.map(mapSearch).filter((x) => x.id) }));
  }
  if (!Inbox.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, members: [] })); }
  const members = await directory();
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true, members }));
};
