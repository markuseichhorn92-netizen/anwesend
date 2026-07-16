'use strict';

/**
 * Aktions-Link erstellen & ans Mitglied senden (Team).   Authorization: Bearer <team-token>
 *
 *   POST { memberId, action, memberName?, email?, whatsapp?, send? }
 *        -> { ok, url, action, label, sent, via, expiresAt }
 *
 * „action" ∈ payment | address | contract | pause | cancel | documents (lib/actionlink).
 * Erzeugt einen geburtsdatum-gesicherten Auto-Login-Deeplink und schickt ihn
 * (Postfach immer + optional E-Mail/WhatsApp) über lib/outreach ans Mitglied.
 * send:false erzeugt den Link nur (zum Kopieren), ohne zu senden.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const AL = require('../../lib/actionlink');
const Outreach = require('../../lib/outreach');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'member.write', res)) return;
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const memberId = String(body.memberId || '').trim();
  const action = String(body.action || '').trim();
  if (!memberId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_member' })); }
  const meta = AL.actionMeta(action);
  if (!meta) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'bad_action' })); }

  // Anti-Spam pro Mitglied.
  if (!(await M.rateLimit('actlink:' + memberId, 8, 3600))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Zu viele Links an dieses Mitglied – bitte kurz warten.' }));
  }

  const created = await AL.create({ memberId: memberId, action: action, createdBy: sess.user || '' });
  if (!created.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: created.error || 'create_failed' })); }
  const url = created.url;

  // Anrede aus dem echten Namen (falls verfügbar).
  let name = String(body.memberName || '');
  try { const m = await M.getMember(memberId); if (m) { const nm = ((m.firstName || '') + ' ' + (m.lastName || '')).trim(); if (nm) name = nm; } } catch (e) {}
  const first = (name.split(' ')[0] || '').trim();

  const doSend = body.send !== false;   // Standard: senden
  let sent = { ok: false, via: [] };
  if (doSend) {
    const channels = { push: true };
    if (body.email) channels.email = true;
    if (body.whatsapp) channels.whatsapp = true;
    const bodyText = (first ? ('Hallo ' + first + ',\n\n') : 'Hallo,\n\n')
      + 'über diesen sicheren Link kommst du direkt in deinen Mitgliederbereich zu: ' + meta.label + '.\n\n'
      + url + '\n\n'
      + 'Zur Sicherheit fragen wir beim Öffnen einmal dein Geburtsdatum ab – danach bist du automatisch angemeldet. '
      + 'Der Link ist ' + AL.TTL_DAYS + ' Tage gültig.\n\nDein Fit-Inn Team';
    try { sent = await Outreach.sendDirect(memberId, { title: meta.label, body: bodyText, channels: channels }); } catch (e) {}
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true, url: url, action: action, label: meta.label,
    sent: !!(sent && sent.ok), via: (sent && sent.via) || [], expiresAt: created.expiresAt,
  }));
};
