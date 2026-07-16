'use strict';

/**
 * Team-Backend: Dubletten-Prüfung.
 *   GET                  -> scannt die bekannten Mitglieder (mit Vorgängen) und
 *                           meldet mögliche Doppel-Datensätze (gleiche E-Mail in
 *                           Magicline mehrfach vorhanden).
 *   GET ?email=<adresse> -> Einzelprüfung: alle Magicline-Datensätze zu dieser E-Mail.
 *
 * Hinweis: Ein vollständiger Magicline-weiter Scan bräuchte MEMBER_LIST_READ
 * (nicht angefragt). Daher wird über die Mitglieder geprüft, mit denen wir Kontakt
 * hatten – das deckt die praktisch relevanten Fälle ab. Zusammenführen erfolgt im
 * Magicline-Backend; hier nur Aufspüren/Anzeigen.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const Inbox = require('../../lib/inbox');
const M = require('../../lib/members');
const View = require('../../lib/teamView');

const SCAN_EMAIL_CAP = 40;     // Anzahl geprüfter E-Mails je Scan begrenzen
const ENRICH_CAP = 30;         // fehlende E-Mails aus Vollprofilen nachladen (gekappt)

function rec(c) {
  const id = c && (c.id != null ? String(c.id) : (c.customerId != null ? String(c.customerId) : null));
  const name = (((c.firstName || '') + ' ' + (c.lastName || '')).trim()) || '—';
  return {
    id: id, name: name, initials: View.initials(name),
    customerNumber: c.customerNumber || null,
    dob: M.isoDate(c.dateOfBirth) || null,
    email: c.email || null,
    phone: c.phonePrivate || c.phoneMobile || c.phoneBusiness || null,
  };
}

async function scan() {
  const all = await Inbox.listAll({ limit: 400 });
  const snap = {}; const ids = [];
  for (const v of all) {
    const mid = v._memberId;
    if (!mid || /^wa/.test(mid)) continue;          // Pseudo-Leads (noch ohne Magicline-ID) überspringen
    if (!(mid in snap)) { snap[mid] = v.member || null; ids.push(mid); }
  }
  // Fehlende E-Mails aus Vollprofilen nachladen (gekappt).
  const need = ids.filter((id) => !(snap[id] && snap[id].email)).slice(0, ENRICH_CAP);
  const loaded = {};
  await Promise.all(need.map(async (id) => { try { const m = await M.getMember(id); if (m && m.email) loaded[id] = m.email; } catch (e) {} }));

  const emailSet = {};
  for (const id of ids) { const e = (snap[id] && snap[id].email) || loaded[id]; if (e) emailSet[String(e).trim().toLowerCase()] = true; }
  const emails = Object.keys(emailSet);
  const checked = emails.slice(0, SCAN_EMAIL_CAP);

  const groups = [];
  await Promise.all(checked.map(async (e) => {
    let recs = []; try { recs = await M.searchByEmail(e); } catch (e2) {}
    if (Array.isArray(recs) && recs.length >= 2) {
      groups.push({ email: e, count: recs.length, records: recs.map(rec) });
    }
  }));
  groups.sort((a, b) => b.count - a.count);
  return { groups: groups, knownMembers: ids.length, emailsChecked: checked.length, capped: emails.length > SCAN_EMAIL_CAP };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'member.read', res)) return;
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  if (!Inbox.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, groups: [] })); }

  const url = new URL(req.url, 'http://x');
  const email = url.searchParams.get('email');
  if (email && email.trim()) {
    let recs = []; try { recs = await M.searchByEmail(email.trim()); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, email: email.trim().toLowerCase(), records: (recs || []).map(rec) }));
  }
  const r = await scan();
  res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ ok: true }, r)));
};
