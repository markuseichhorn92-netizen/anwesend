'use strict';

/**
 * Mitglieder-Self-Service: Dubletten-Hinweis + Zusammenführungs-Anfrage.
 *   GET  -> { ok, hasDuplicates, count, requested }
 *           (prüft, ob es zur E-Mail+Geburtsdatum des eingeloggten Mitglieds
 *            mehrere Magicline-Datensätze gibt)
 *   POST { action:'merge' } -> legt einen Vorgang „Konten zusammenführen" im
 *           Team-Posteingang an (echtes Merge macht das Team im Magicline-Backend,
 *           da die API kein Zusammenführen kann) und benachrichtigt das Studio.
 */

const M = require('../../lib/members');
const Inbox = require('../../lib/inbox');
const SR = require('../../lib/studioReply');
const View = require('../../lib/teamView');

const MERGE_SUBJECT = 'Konten zusammenführen';

function recordLine(c) {
  const id = c && (c.id != null ? c.id : c.customerId);
  return (c.customerNumber || 'ohne Nr.') + ' (ID ' + (id != null ? id : '?') + ')';
}
function openMergeVorgang(list) {
  return (list || []).find((v) => v.subject === MERGE_SUBJECT && v.teamStatus !== 'abgeschlossen') || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

  let matches = [];
  try { matches = await M.findAllByEmailDob(m.email, m.dateOfBirth); } catch (e) {}
  const hasDuplicates = matches.length > 1;

  if (req.method === 'GET') {
    let requested = false;
    try { requested = !!openMergeVorgang(await Inbox.list(sess.id)); } catch (e) {}
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, hasDuplicates: hasDuplicates, count: matches.length, requested: requested }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  if (body.action !== 'merge') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' })); }
  if (!hasDuplicates) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Es wurden keine Dubletten gefunden.' })); }
  if (!(await M.rateLimit('merge-req:' + sess.id, 3, 86400))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Anfrage läuft bereits.' }));
  }

  // Schon angefragt? -> nicht doppelt anlegen.
  let list = [];
  try { list = await Inbox.list(sess.id); } catch (e) {}
  const existing = openMergeVorgang(list);
  if (existing) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, requested: true, already: true })); }

  const snap = View.snapshotFromMember(m) || undefined;
  const v = await Inbox.addVorgang(sess.id, {
    type: 'allgemein', channel: 'portal', priority: 'mittel', member: snap, subject: MERGE_SUBJECT,
    systemText: 'Du hast die Zusammenführung deiner Konten angefragt. Wir prüfen das und melden uns bei dir.',
  });
  if (!v) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Anfrage konnte nicht gespeichert werden.' })); }

  // Interne Notiz mit den betroffenen Datensätzen (fürs manuelle Zusammenführen).
  try {
    await Inbox.addNote(sess.id, v.id, { author: 'System',
      text: 'Mitglied bittet um Zusammenführung. Betroffene Datensätze: ' + matches.map(recordLine).join(', ') + '. Bitte im Magicline-Backend zusammenführen.' });
  } catch (e) {}

  // Studio benachrichtigen.
  try {
    await SR.notifyStudio({ member: m, vorgang: v,
      subject: '🔀 Zusammenführung angefragt – ' + ((m.firstName || '') + ' ' + (m.lastName || '')).trim() + ' · ' + (v.ref || ''),
      text: 'Ein Mitglied hat im Portal die Zusammenführung seiner Konten angefragt.\n\n'
        + 'Mitglied: ' + ((m.firstName || '') + ' ' + (m.lastName || '')).trim() + (m.email ? (' · ' + m.email) : '')
        + '\nBetroffene Datensätze:\n  - ' + matches.map(recordLine).join('\n  - ')
        + '\n\nBitte im Magicline-Backend zusammenführen.' });
  } catch (e) {}

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, requested: true, vorgang: { id: v.id, ref: v.ref } }));
};
