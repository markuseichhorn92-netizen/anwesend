'use strict';

/**
 * E-Mail-Versand über Resend (https://resend.com).
 * Benötigt RESEND_API_KEY (Vercel Env). Empfänger = MAIL_TO (Standard
 * info@fit-inn-trier.de). Absender = MAIL_FROM (Standard onboarding@resend.dev,
 * bis eine eigene Domain in Resend verifiziert ist).
 */

const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || 'Fit-Inn Mitglieder <onboarding@resend.dev>';
const TO = process.env.MAIL_TO || 'info@fit-inn-trier.de';

const hasMail = Boolean(KEY);

async function sendMail(subject, text) {
  if (!KEY) return { ok: false, error: 'no_mail_key' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [TO], subject: subject, text: text }),
    });
    const body = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: body.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendMail, hasMail, TO };
