'use strict';

/**
 * TEMPORÄR – Sende-Diagnose. Löst einen ECHTEN Test-Versand aus und gibt die
 * Roh-Antwort des Providers (Twilio/Meta/Resend, inkl. Fehlercode) zurück, um zu
 * sehen, WARUM Nachrichten nicht zugestellt werden. Per Geheim-Schlüssel (?k=)
 * geschützt. Wird nach der Prüfung wieder entfernt.
 */

const Inbox = require('../lib/inbox');
const WA = require('../lib/whatsapp');
const Mail = require('../lib/mail');

const SECRET = 'dbg7392xk';
function maskPhone(p) { p = String(p || ''); return p.length > 5 ? (p.slice(0, 4) + '***' + p.slice(-2)) : '***'; }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('k') !== SECRET) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }

  const out = { config: { hasWhatsApp: WA.hasWhatsApp, hasTwilio: WA.hasTwilio, hasMeta: WA.hasMeta, hasWaText: WA.hasWaText, hasMail: Mail.hasMail } };

  // ── WhatsApp: Nummer aus ?phone= oder jüngstem WhatsApp-Vorgang ──
  let phone = u.searchParams.get('phone');
  if (!phone && u.searchParams.get('latest') === '1') {
    try { const all = await Inbox.listAll({ limit: 30 }); const wv = (all || []).find((v) => v.channel === 'whatsapp' && v.phone); if (wv) phone = wv.phone; } catch (e) {}
  }
  if (phone) {
    out.phone = maskPhone(phone);
    try { out.sendText = await WA.sendText(phone, 'Fit-Inn Status-Test (Session-Freitext).'); } catch (e) { out.sendText = { error: String(e && e.message) }; }
    try { out.sendFreeText = await WA.sendFreeText(phone, 'Fit-Inn Status-Test (genehmigte Vorlage).'); } catch (e) { out.sendFreeText = { error: String(e && e.message) }; }
  }

  // ── Echten Antwort-Pfad testen: applyOwnerReply auf den jüngsten WhatsApp-Vorgang ──
  if (u.searchParams.get('reply') === '1') {
    const SR = require('../lib/studioReply');
    try {
      const all = await Inbox.listAll({ limit: 30 });
      const wv = (all || []).find((v) => v.channel === 'whatsapp' && v.phone);
      if (!wv) { out.replyTest = { error: 'no_whatsapp_vorgang' }; }
      else {
        const r = await SR.applyOwnerReply(wv._memberId, wv.id, 'Status-Test-Antwort ' + Date.now(), { author: 'Debug' });
        const fresh = await Inbox.get(wv._memberId, wv.id);
        const tm = (fresh && (fresh.messages || []).slice().reverse().find((m) => m && m.from === 'team')) || {};
        out.replyTest = { applyOk: !!(r && r.ok), channelUsed: (r && r.channel) || null, msgSt: tm.st || null, msgCh: tm.ch || null };
      }
    } catch (e) { out.replyTest = { error: String(e && e.message) }; }
  }

  // ── E-Mail: Adresse aus ?email= ──
  const email = u.searchParams.get('email');
  if (email) {
    out.email = String(email).replace(/(.).*(@.*)/, '$1***$2');
    try { out.mail = await Mail.sendMailRaw({ to: email, subject: 'Fit-Inn Status-Test', text: 'Test.' }); } catch (e) { out.mail = { error: String(e && e.message) }; }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(out, null, 2));
};
