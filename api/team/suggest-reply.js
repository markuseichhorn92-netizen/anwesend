'use strict';

/**
 * KI-Smart-Reply fürs Team-Backend.
 *   POST { memberId, id }  ->  { ok:true, draft }  |  { ok:false, error, message? }
 *
 * Erzeugt einen freundlichen Antwort-ENTWURF an das Mitglied auf Basis des
 * Vorgangs-Verlaufs + der Hilfe-Artikel (lib/help.js). Der Entwurf wird im
 * Postfach nur ins Antwortfeld gesetzt – abgeschickt wird nichts automatisch.
 *
 * Graceful Degradation: ohne ANTHROPIC_API_KEY (AI.hasAI===false) liefert der
 * Endpoint { ok:false, error:'no_ai' } und wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Inbox = require('../../lib/inbox');
const M = require('../../lib/members');
const AI = require('../../lib/ai');
const HELP = require('../../lib/help');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  // Kein KI-Schlüssel -> Button blendet sich aus. Nie werfen.
  if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai' })); }

  if (!Inbox.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

  const body = await M.readBody(req);
  const memberId = body.memberId; const id = body.id;
  if (!memberId || !id) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

  // Sanfte Drosselung (analog anderer Team-Endpunkte). Ohne Store -> no-op.
  if (!(await M.rateLimit('team-suggest:' + memberId, 40, 3600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Zu viele KI-Entwürfe – bitte kurz warten.' }));
  }

  const v = await Inbox.get(memberId, id);
  if (!v) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

  // Letzte ~8 Nachrichten des Verlaufs als Kontext aufbereiten.
  const messages = (v.messages || []).slice(-8).map(function (m) {
    return { from: m.from, text: String(m.text || '') };
  });

  let r;
  try {
    r = await AI.draftReply({ member: v.member || {}, subject: v.subject, messages: messages, articles: HELP });
  } catch (e) {
    r = { ok: false, error: String(e && e.message) };
  }

  if (!r || !r.ok || !r.answer) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, error: (r && r.error) || 'ai_failed', message: 'KI-Entwurf konnte nicht erstellt werden.' }));
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, draft: r.answer }));
};
