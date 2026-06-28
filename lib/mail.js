'use strict';

/**
 * E-Mail-Versand über Resend (https://resend.com).
 * Benötigt RESEND_API_KEY (Vercel Env). Empfänger = MAIL_TO (Standard
 * info@fit-inn-trier.de). Absender = MAIL_FROM (Standard onboarding@resend.dev,
 * bis eine eigene Domain in Resend verifiziert ist).
 */

const KEY = process.env.RESEND_API_KEY;
// Absender mit garantiertem Anzeigenamen (z. B. „Fit-Inn Trier <noreply@…>").
// Ist MAIL_FROM nur eine nackte Adresse, wird der Name (MAIL_FROM_NAME) ergänzt,
// damit beim Empfänger immer ein Name statt nur der E-Mail-Adresse erscheint.
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Fit-Inn Trier';
const FROM_RAW = process.env.MAIL_FROM || 'noreply@mitglieder.fit-inn-trier.de';
const FROM = /</.test(FROM_RAW) ? FROM_RAW : (FROM_NAME + ' <' + FROM_RAW + '>');
const TO = process.env.MAIL_TO || 'info@fit-inn-trier.de';

const hasMail = Boolean(KEY);

async function sendMail(subject, text, html) {
  if (!KEY) return { ok: false, error: 'no_mail_key' };
  try {
    const payload = { from: FROM, to: [TO], subject: subject, text: text };
    if (html) payload.html = html;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: body.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Allgemeiner Sender: beliebiger Empfänger + optional Anhänge (base64).
async function sendMailRaw(opts) {
  if (!KEY) return { ok: false, error: 'no_mail_key' };
  try {
    const payload = { from: FROM, to: [opts.to || TO], subject: opts.subject, text: opts.text };
    if (opts.html) payload.html = opts.html;
    if (opts.replyTo) payload.reply_to = opts.replyTo;
    if (opts.attachments && opts.attachments.length) payload.attachments = opts.attachments;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: body.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendMail, sendMailRaw, hasMail, TO };
