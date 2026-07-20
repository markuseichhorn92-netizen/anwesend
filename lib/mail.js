'use strict';

/**
 * E-Mail-Versand über Resend (https://resend.com).
 * Benötigt RESEND_API_KEY (Vercel Env). Empfänger = MAIL_TO (Standard
 * info@fit-inn-trier.de). Absender = MAIL_FROM (Standard onboarding@resend.dev,
 * bis eine eigene Domain in Resend verifiziert ist).
 *
 * Zustell-Robustheit: jeder Versand läuft über postResend() mit Timeout
 * (MAIL_TIMEOUT_MS) und automatischem Retry bei TRANSIENTEN Fehlern
 * (Netz/Timeout/429/5xx) – wichtig, damit der Login-Code zuverlässig rausgeht.
 * Bei echten 4xx-Fehlern (z. B. ungültige Adresse) wird NICHT wiederholt.
 */

const KEY = process.env.RESEND_API_KEY;
// Absender mit garantiertem Anzeigenamen (z. B. „Fit-Inn Trier <noreply@…>").
// Ist MAIL_FROM nur eine nackte Adresse, wird der Name (MAIL_FROM_NAME) ergänzt,
// damit beim Empfänger immer ein Name statt nur der E-Mail-Adresse erscheint.
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Fit-Inn Trier';
const FROM_RAW = process.env.MAIL_FROM || 'noreply@mitglieder.fit-inn-trier.de';
const FROM = /</.test(FROM_RAW) ? FROM_RAW : (FROM_NAME + ' <' + FROM_RAW + '>');
const TO = process.env.MAIL_TO || 'info@fit-inn-trier.de';
// Antworten auf JEDE Mail sollen in einem echten Postfach landen (nicht bei der
// noreply-Absenderadresse). Standard: das Studio-Postfach (MAIL_TO).
const REPLY_TO = process.env.MAIL_REPLY_TO || TO;

const hasMail = Boolean(KEY);

const TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS || 8000);
const RETRIES = Math.max(0, Number(process.env.MAIL_RETRIES || 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Nur transiente Fehler wiederholen (Netz/Timeout, 408/425/429, 5xx).
function transient(status) { return status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599); }

async function postResend(payload) {
  if (!KEY) return { ok: false, error: 'no_mail_key' };
  let last = { ok: false, error: 'unknown' };
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(250 * attempt * attempt + 250);   // 0, 500, 1250 ms …
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const body = await r.text().catch(() => '');
      let id = null; try { const j = JSON.parse(body); id = (j && (j.id || (j.data && j.data.id))) || null; } catch (e) {}
      if (r.ok) return { ok: true, status: r.status, id: id, body: body.slice(0, 300), attempts: attempt + 1 };
      last = { ok: false, status: r.status, body: body.slice(0, 300), attempts: attempt + 1 };
      if (!transient(r.status)) return last;   // dauerhafter Fehler -> kein Retry
    } catch (e) {
      last = { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'fetch_error'), attempts: attempt + 1 };
    } finally { clearTimeout(timer); }
  }
  return last;
}

async function sendMail(subject, text, html) {
  const payload = { from: FROM, to: [TO], subject: subject, text: text, reply_to: REPLY_TO };
  if (html) payload.html = html;
  return postResend(payload);
}

// Allgemeiner Sender: beliebiger Empfänger + optional Anhänge (base64).
async function sendMailRaw(opts) {
  opts = opts || {};
  const payload = { from: FROM, to: [opts.to || TO], subject: opts.subject, text: opts.text, reply_to: opts.replyTo || REPLY_TO };
  if (opts.html) payload.html = opts.html;
  if (opts.attachments && opts.attachments.length) payload.attachments = opts.attachments;
  return postResend(payload);
}

module.exports = { sendMail, sendMailRaw, hasMail, TO };
