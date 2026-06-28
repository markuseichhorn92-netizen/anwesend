'use strict';

/**
 * POST /api/member/contact   (Authorization: Bearer <token>)
 *
 *   { action: "ask",  question }
 *     -> KI-Antwort auf Basis unserer Hilfe-Artikel  { ok, answer } | { ok:false }
 *
 *   { action: "send", question, message, answer?, helpful? }
 *     -> Kontaktanfrage per E-Mail ans Studio + Bestätigung ans Mitglied
 *
 * Ablauf im Frontend: Mitglied tippt Frage -> KI schlägt Antwort vor -> war sie
 * NICHT hilfreich, wird das Kontaktformular abgeschickt (FAQ-Deflection).
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');
const HELP = require('../../lib/help');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail, BASE } = require('../../lib/emailTemplate');

function who(m) {
  return ((m.firstName || '') + ' ' + (m.lastName || '')).trim()
    + (m.customerNumber ? ' (' + m.customerNumber + ')' : '')
    + (m.email ? ' · ' + m.email : '');
}

// Bestätigung ans Mitglied (best effort) – mit persönlichem Werben-Link im Promo.
async function sendMemberContactMail(m, question) {
  if (!hasMail || !m.email) return;
  try {
    var cm = renderEmail({
      preheader: 'Deine Nachricht ist bei uns eingegangen.',
      name: m.firstName || '',
      eyebrow: 'Nachricht eingegangen',
      headline: 'Wir haben deine Nachricht erhalten',
      intro: [
        'Danke für deine Nachricht! Unser Team schaut sie sich an und meldet sich so schnell wie möglich persönlich bei dir – in der Regel innerhalb eines Werktags.',
        'Brauchst du es dringend? Ruf uns gerne direkt an unter 0651 308524.',
      ],
      panel: question ? [{ label: 'Deine Frage', value: String(question).slice(0, 120) }] : null,
      button: { label: 'Zum Mitgliederbereich', href: BASE + '/mitglieder' },
      promo: true,
      referral: { code: m.referralCode, firstName: m.firstName },
      footer: 'member',
    });
    await sendMailRaw({ to: m.email, subject: 'Deine Nachricht ist eingegangen – Fit-Inn Trier', text: cm.text, html: cm.html });
  } catch (e) { /* Mitglied-Mail ist optional */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  const body = await M.readBody(req);
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

  // ── 1) KI-Antwort vorschlagen ──────────────────────────────────────────
  if (body.action === 'ask') {
    if (!(await M.rateLimit('contact-ask:' + sess.id, 20, 3600))) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Zu viele Anfragen – bitte sende uns deine Frage direkt.' }));
    }
    const question = String(body.question || '').trim();
    if (question.length < 3) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty_question' })); }
    const r = await AI.askHelp(question, HELP);
    res.statusCode = 200;
    if (r.ok) return res.end(JSON.stringify({ ok: true, answer: r.answer }));
    return res.end(JSON.stringify({ ok: false, error: r.error || 'ai_failed' }));
  }

  // ── 2) Kontaktanfrage ans Studio senden ────────────────────────────────
  if (body.action === 'send') {
    if (!(await M.rateLimit('contact-send:' + sess.id, 10, 3600))) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Anfragen. Bitte versuche es später erneut.' }));
    }
    const question = String(body.question || '').trim();
    const message = String(body.message || '').trim();
    const replyTo = (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email || '')) ? String(body.email).trim() : (m.email || ''));
    if (!question && !message) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte schreib uns kurz dein Anliegen.' })); }

    if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand ist noch nicht eingerichtet.' })); }

    const text = 'Kontaktanfrage über den Mitgliederbereich\n\n'
      + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
      + '\nAntwort-Adresse: ' + (replyTo || '—')
      + '\n\nFrage des Mitglieds:\n' + (question || '—')
      + '\n\nNachricht:\n' + (message || '—')
      + (body.answer ? ('\n\n— Vorgeschlagene KI-Antwort (war nicht ausreichend) —\n' + String(body.answer).slice(0, 1200)) : '')
      + '\n\nBitte dem Mitglied persönlich antworten.';

    const mail = await sendMailRaw({ subject: '✉️ Kontaktanfrage – ' + who(m), text: text, replyTo: replyTo || undefined });
    if (mail.ok) await sendMemberContactMail(m, question);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: mail.ok,
      message: mail.ok
        ? 'Deine Nachricht ist eingegangen. Wir melden uns so schnell wie möglich bei dir.'
        : 'Übermittlung fehlgeschlagen – bitte später erneut.',
    }));
  }

  res.statusCode = 400;
  return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
