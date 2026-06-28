'use strict';

/**
 * Postfach-API (Authorization: Bearer <token>)
 *   GET  /api/member/inbox            -> { ok, vorgaenge:[…], unread }
 *   GET  /api/member/inbox?id=<id>    -> { ok, vorgang } (markiert gelesen)
 *   POST { action:'reply',   id, text } -> Nachricht anhängen + E-Mail ans Studio
 *   POST { action:'resolve', id }       -> Vorgang als erledigt markieren
 *   POST { action:'read',    id }       -> als gelesen markieren
 *
 * Studio-Antworten direkt im Postfach (CRM) folgen später – bis dahin gehen
 * Mitglieder-Antworten per E-Mail ans Studio (replyTo = Mitglied).
 */

const M = require('../../lib/members');
const Inbox = require('../../lib/inbox');
const { sendMail, hasMail } = require('../../lib/mail');

function who(m) {
  return ((m.firstName || '') + ' ' + (m.lastName || '')).trim()
    + (m.customerNumber ? ' (' + m.customerNumber + ')' : '')
    + (m.email ? ' · ' + m.email : '');
}

async function seedWelcome(memberId, firstName) {
  return Inbox.addVorgang(memberId, {
    type: 'willkommen',
    subject: 'Willkommen bei Fit-Inn Trier',
    status: 'abgeschlossen',
    teamText: 'Herzlich willkommen' + (firstName ? (', ' + firstName) : '') + '! Schön, dass du dabei bist. '
      + 'Hier in deinem Postfach findest du künftig alle Vorgänge – Kündigungen, Änderungen, Anfragen – an einem Ort und kannst uns direkt antworten. '
      + 'Tipp: Buch dir dein kostenloses Einführungstraining unter „Termine".',
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Inbox.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, vorgaenge: [], unread: 0, disabled: true })); }

  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (id) {
      const v = await Inbox.markRead(sess.id, id);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: !!v, vorgang: v || null }));
    }
    let vorgaenge = await Inbox.list(sess.id);
    if (!vorgaenge.length) {
      await seedWelcome(sess.id, m.firstName);
      vorgaenge = await Inbox.list(sess.id);
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, vorgaenge: vorgaenge, unread: vorgaenge.filter((v) => v.unread).length }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const id = body.id;

  if (body.action === 'read') {
    const v = await Inbox.markRead(sess.id, id);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: !!v, vorgang: v || null }));
  }

  if (body.action === 'resolve') {
    const v = await Inbox.resolve(sess.id, id);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: !!v, vorgang: v || null }));
  }

  if (body.action === 'reply') {
    if (!(await M.rateLimit('inbox-reply:' + sess.id, 30, 3600))) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Nachrichten – bitte versuche es später erneut.' }));
    }
    const text = String(body.text || '').trim();
    if (!text) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte gib eine Nachricht ein.' })); }
    const v = await Inbox.reply(sess.id, id, text);
    if (!v) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

    if (hasMail) {
      try {
        await sendMail('💬 Postfach-Antwort – ' + who(m) + ' · ' + (v.ref || ''),
          'Ein Mitglied hat im Postfach auf einen Vorgang geantwortet.\n\n'
          + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
          + '\nVorgang: ' + (v.subject || '—') + ' (' + (v.ref || '') + ')'
          + '\nStatus: ' + (v.status || '—')
          + '\n\nNachricht des Mitglieds:\n' + text
          + '\n\nBitte dem Mitglied antworten (per E-Mail an ' + (m.email || '—') + ').');
      } catch (e) {}
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, vorgang: v }));
  }

  res.statusCode = 400;
  return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
