'use strict';

/**
 * GET /api/team/messages?id=<memberId>   (Team-Session erforderlich)
 * Flacher, chronologischer Nachrichtenverlauf mit EINEM Mitglied – über alle
 * Vorgänge hinweg zusammengeführt. Zeigt, was das Team gesendet hat (from:'team'),
 * was das Mitglied schreibt (from:'member') und System-Ereignisse (from:'system').
 *
 * Datengrundlage: lib/inbox (Vorgänge mit messages[]). Direktnachrichten,
 * Postfach-Antworten und WhatsApp-Konversationen laufen alle darüber. Begrüßungs-
 * Vorgänge (type 'willkommen') werden ausgeblendet. Wirft nie.
 *   -> { ok:true, messages:[{ at, from, text, author, key, ref, subject, type, channel }], total }
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const Inbox = require('../../lib/inbox');

const MAX_MSGS = 400;   // Sicherheitskappe (neueste behalten)

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'conversations.manage', res)) return;
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
  if (!Inbox.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, messages: [], total: 0 })); }

  try {
    const list = await Inbox.list(id);
    const msgs = [];
    for (const v of (list || [])) {
      if (!v || v.type === 'willkommen') continue;         // Begrüßung ausblenden
      const key = String(id) + ':' + v.id;
      const ms = Array.isArray(v.messages) ? v.messages : [];
      for (const m of ms) {
        if (!m || !m.text) continue;
        const from = (m.from === 'team' || m.from === 'member') ? m.from : 'system';
        msgs.push({
          at: m.at || v.createdAt || 0,
          from: from,
          text: String(m.text).slice(0, 4000),
          author: m.author ? String(m.author).slice(0, 80) : null,
          key: key,
          ref: v.ref || null,
          subject: v.subject || null,
          type: v.type || 'allgemein',
          channel: v.channel || 'portal',
        });
      }
    }
    msgs.sort((a, b) => (a.at || 0) - (b.at || 0));         // chronologisch (Chat-Reihenfolge)
    const total = msgs.length;
    const trimmed = total > MAX_MSGS ? msgs.slice(total - MAX_MSGS) : msgs;
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, messages: trimmed, total: total }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, messages: [], total: 0 }));
  }
};
