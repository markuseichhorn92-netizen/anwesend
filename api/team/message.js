'use strict';

/**
 * Team-Backend: Direktnachricht an ein einzelnes Mitglied.
 *   POST { memberId, title?, body, channels:{push?, email?, whatsapp?} } -> { ok, via }
 *
 * Legt einen Inbox-Vorgang an (erscheint im Postfach), sendet Push (pushPostfach),
 * optional E-Mail und optional WhatsApp (Freitext-Vorlage) – alles best-effort in
 * lib/outreach.sendDirect (wirft nie, respektiert Einwilligung + hinterlegte Adresse/
 * Nummer). via kann 'inbox' | 'push' | 'email' | 'whatsapp' enthalten. 405 für andere Methoden.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');
const Outreach = require('../../lib/outreach');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const b = await M.readBody(req);
  const memberId = String(b.memberId || '').trim();
  const title = b.title != null ? String(b.title).trim() : '';
  const body = String(b.body || '').trim();
  const channels = (b.channels && typeof b.channels === 'object') ? b.channels : {};
  if (!memberId) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Kein Mitglied angegeben.' })); }
  if (!body) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte eine Nachricht eingeben.' })); }

  // Anti-Spam: max. 30 Direktnachrichten je Mitglied pro Stunde.
  if (!(await M.rateLimit('team-msg:' + memberId, 30, 3600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Nachrichten an dieses Mitglied – bitte kurz warten.' }));
  }

  const r = await Outreach.sendDirect(memberId, { title: title, body: body, channels: channels });
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: !!(r && r.ok), via: (r && r.via) || [] }));
};
