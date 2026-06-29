'use strict';

/**
 * Studio-Antworten ins Postfach (Inhaber → Kunde).
 * ------------------------------------------------
 * Zwei Wege, gemeinsamer Kern:
 *   - Weg A (Inbound): Studio-Benachrichtigungen tragen ein getoktes Reply-To
 *     (pf.<token>@INBOUND_EMAIL_DOMAIN). Antwortet der Inhaber im Mailprogramm,
 *     empfängt api/inbound-email.js die Mail und ruft applyOwnerReply().
 *   - Weg B (Link): notifyStudio() hängt einen signierten „Im Postfach
 *     antworten"-Link an; api/studio-reply.js verifiziert ihn und ruft
 *     applyOwnerReply().
 * applyOwnerReply() schreibt die Antwort als „Team"-Nachricht ins Postfach UND
 * schickt sie dem Kunden per E-Mail.
 *
 * Token = memberId.vorgangId.HMAC(secret), konstantzeit-geprüft. Secret nur als
 * Env-Var (STUDIO_REPLY_SECRET, Fallback RECORD_SECRET).
 */

const crypto = require('node:crypto');
const M = require('./members');
const Inbox = require('./inbox');
const { sendMailRaw, hasMail } = require('./mail');
const { renderEmail, BASE } = require('./emailTemplate');
const { memberLink } = require('./magic');
const WA = require('./whatsapp');
const Push = require('./push');

const SECRET = process.env.STUDIO_REPLY_SECRET || process.env.RECORD_SECRET || 'fitinn-studio-reply';
const INBOUND_DOMAIN = (process.env.INBOUND_EMAIL_DOMAIN || '').trim().replace(/^@/, '');
const TO = process.env.MAIL_TO || 'info@fit-inn-trier.de';
const RESEND_KEY = process.env.RESEND_API_KEY;

// ── Token ──
// Signatur als Kleinbuchstaben-Hex: E-Mail-Systeme schreiben den lokalen Teil einer
// Adresse häufig komplett klein. Hex ([0-9a-f]) übersteht das unverändert –
// Base64url (case-sensitive) ging dabei kaputt. 32 Hex = 128 Bit.
function sign(mid, vid) {
  return crypto.createHmac('sha256', SECRET).update(String(mid) + ':' + String(vid)).digest('hex').slice(0, 32);
}
function replyToken(memberId, vorgangId) {
  const mid = String(memberId), vid = String(vorgangId);
  return mid + '.' + vid + '.' + sign(mid, vid);
}
function verifyReplyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const p = token.split('.');
  if (p.length !== 3 || !p[0] || !p[1]) return null;
  let ok = false;
  // p[2] case-insensitiv vergleichen (Adresse kann unterwegs kleingeschrieben werden).
  try { const a = Buffer.from(String(p[2]).toLowerCase()), b = Buffer.from(sign(p[0], p[1])); ok = a.length === b.length && crypto.timingSafeEqual(a, b); }
  catch (e) { ok = false; }
  return ok ? { memberId: p[0], vorgangId: p[1] } : null;
}

function inboundAddress(memberId, vorgangId) {
  if (!INBOUND_DOMAIN) return null;
  return 'pf.' + replyToken(memberId, vorgangId) + '@' + INBOUND_DOMAIN;
}
function studioReplyUrl(memberId, vorgangId) {
  return BASE + '/api/studio-reply?t=' + encodeURIComponent(replyToken(memberId, vorgangId));
}

// Token aus einer Inbound-Empfänger-Adresse "pf.<token>@domain" (auch in
// "Name <pf.x@d>" oder kommaseparierten Listen) extrahieren.
function tokenFromAddress(addr) {
  if (!addr) return null;
  const m = String(addr).match(/pf\.([A-Za-z0-9._=-]+)@/);
  return m ? m[1] : null;
}

// Zitierte Historie / Signatur aus einer E-Mail-Antwort entfernen (best effort).
function extractLatestReply(raw) {
  const s = String(raw || '').replace(/\r\n/g, '\n');
  const lines = s.split('\n');
  const markers = [
    /^\s*>/,                                       // zitierte Zeile
    /^\s*Am\s.+\sschrieb(\s.*)?:/i,                // "Am … schrieb …:"
    /^\s*On\s.+\swrote:/i,                         // "On … wrote:"
    /^-{2,}\s*Original(\s|-).*/i,                  // "----- Original Message"
    /^\s*(Von|From|Gesendet|Sent|Betreff|Subject):\s/i, // Header-Block der zitierten Mail
    /^\s*_{5,}\s*$/, /^\s*-{5,}\s*$/,              // lange Trennlinien
  ];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^--\s?$/.test(ln)) break;                 // Signatur-Trenner "-- "
    let hit = false;
    for (let j = 0; j < markers.length; j++) { if (markers[j].test(ln)) { hit = true; break; } }
    if (hit) break;
    out.push(ln);
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text || s.trim();   // Fallback: ganzer Text, falls Heuristik alles entfernt
}

// Body einer empfangenen Resend-Mail nachladen (der email.received-Webhook liefert
// nur Metadaten). GET /emails/receiving/{id}; bevorzugt Klartext, sonst HTML entkernt.
async function fetchReceivedBody(emailId) {
  if (!RESEND_KEY || !emailId) return '';
  try {
    const r = await fetch('https://api.resend.com/emails/receiving/' + encodeURIComponent(emailId), {
      headers: { Authorization: 'Bearer ' + RESEND_KEY },
    });
    if (!r.ok) return '';
    const j = await r.json().catch(function () { return null; });
    if (!j) return '';
    if (j.text) return String(j.text);
    if (j.html) return String(j.html)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return '';
  } catch (e) { return ''; }
}

// Studio-Benachrichtigung über eine Mitglieder-Nachricht: an MAIL_TO, mit
// Inbound-Reply-To (Weg A, falls konfiguriert) + Antworten-Link (Weg B).
async function notifyStudio(o) {
  if (!hasMail) return { ok: false, error: 'no_mail' };
  o = o || {};
  const v = o.vorgang || {};
  const m = o.member || {};
  const mid = m.id != null ? m.id : m.customerId;
  const haveCtx = mid != null && v.id != null;
  const replyTo = haveCtx ? inboundAddress(mid, v.id) : null;
  const link = haveCtx ? studioReplyUrl(mid, v.id) : null;
  const text = String(o.text || '') + (link
    ? ('\n\n— So antwortest du dem Mitglied —\n'
        + (replyTo ? 'Antworte einfach direkt auf diese E-Mail – deine Antwort erscheint automatisch im Postfach des Mitglieds und geht ihm zusätzlich per E-Mail zu.\n\n' : '')
        + 'Oder direkt im Postfach antworten:\n' + link)
    : '');
  return sendMailRaw({ to: TO, subject: o.subject, text: text, replyTo: replyTo || undefined, attachments: o.attachments });
}

// Beide Wege münden hier: Team-Antwort ins Postfach + Zustellung an den Kunden.
// opts.channel ('whatsapp' | 'email') erzwingt den Kanal; sonst wird der Herkunfts-
// kanal des Vorgangs genutzt. Ist der gewünschte Kanal nicht möglich (keine Nummer/
// keine Mail/24h-Fenster zu), wird automatisch auf den anderen ausgewichen.
// Liefert { ok, vorgang, channel } – channel = tatsächlich genutzter Kanal (oder null).
async function applyOwnerReply(memberId, vorgangId, rawText, opts) {
  opts = opts || {};
  const text = extractLatestReply(rawText);
  if (!text) return { ok: false, error: 'empty' };
  const v = await Inbox.teamReply(memberId, vorgangId, text, { author: opts.author });
  if (!v) return { ok: false, error: 'not_found' };

  let m = null; try { m = await M.getMember(memberId); } catch (e) {}
  const email = (m && m.email) || (v.member && v.member.email) || null;
  const phone = v.phone || (v.member && v.member.phone) || (m && (m.phonePrivate || m.phoneMobile || m.phoneBusiness)) || null;

  let want = opts.channel;
  if (want !== 'email' && want !== 'whatsapp') want = (v.channel === 'whatsapp') ? 'whatsapp' : 'email';

  async function viaWhatsApp() {
    if (!(WA.hasWhatsApp && phone)) return false;
    try { const r = await WA.sendText(phone, text); return !!(r && r.ok !== false); } catch (e) { return false; }
  }
  async function viaEmail() {
    if (!(hasMail && email)) return false;
    try {
      const portal = await memberLink(memberId, 'postfach');
      const em = renderEmail({
        preheader: 'Neue Antwort von Fit-Inn Trier zu „' + (v.subject || 'deinem Anliegen') + '".',
        name: (m && m.firstName) || (v.member && String(v.member.name || '').split(' ')[0]) || '',
        eyebrow: 'Antwort vom Team',
        headline: 'Wir haben dir geantwortet',
        intro: text.split(/\n{2,}/).map(function (s) { return s.trim(); }).filter(Boolean),
        panel: v.ref ? [{ label: 'Vorgang', value: ((v.subject || '') + ' · ' + v.ref).trim() }] : null,
        button: { label: 'Im Postfach ansehen', href: portal },
        footer: 'member',
      });
      // Reply-To = getokte Inbound-Adresse: antwortet der Kunde auf diese Mail,
      // landet seine Antwort wieder im selben Vorgang im Postfach.
      await sendMailRaw({ to: email, subject: 'Antwort von Fit-Inn Trier' + (v.ref ? (' · ' + v.ref) : ''), text: em.text, html: em.html, replyTo: inboundAddress(memberId, vorgangId) || undefined });
      return true;
    } catch (e) { return false; }
  }

  let used = null;
  if (want === 'whatsapp') { if (await viaWhatsApp()) used = 'whatsapp'; else if (await viaEmail()) used = 'email'; }
  else { if (await viaEmail()) used = 'email'; else if (await viaWhatsApp()) used = 'whatsapp'; }

  // Zusätzlich Push an die eigene App (best effort; schläft, bis FCM konfiguriert ist).
  try {
    if (Push.hasPush) await Push.sendToMember(memberId, {
      title: 'Antwort vom Team',
      body: (v.subject ? ('„' + v.subject + '": ') : '') + String(text).replace(/\s+/g, ' ').slice(0, 120),
      url: '/mitglieder?go=postfach',
      data: { vorgang: String(vorgangId) },
    });
  } catch (e) { /* Push ist optional */ }

  return { ok: true, vorgang: v, channel: used };
}

function who(m) {
  m = m || {};
  return ((((m.firstName || '') + ' ' + (m.lastName || '')).trim()) || 'Mitglied')
    + (m.customerNumber ? ' (' + m.customerNumber + ')' : '');
}

// Antwort des KUNDEN per E-Mail: als Mitglieder-Nachricht in den Vorgang hängen
// (Inbox.reply) und das Studio benachrichtigen (mit Inbound-Reply-To + Link, sodass
// der Inhaber direkt weiter antworten kann). So sind E-Mail- UND Portal-Nachrichten
// vollständig im Postfach des Kunden.
async function applyMemberReply(memberId, vorgangId, rawText) {
  const text = extractLatestReply(rawText);
  if (!text) return { ok: false, error: 'empty' };
  const v = await Inbox.reply(memberId, vorgangId, text);
  if (!v) return { ok: false, error: 'not_found' };
  try {
    let m = null; try { m = await M.getMember(memberId); } catch (e) {}
    const via = v.channel === 'whatsapp' ? 'WhatsApp' : 'E-Mail';
    await notifyStudio({ member: m || { id: memberId }, vorgang: v,
      subject: '💬 Antwort per ' + via + ' – ' + who(m) + ' · ' + (v.ref || ''),
      text: 'Das Mitglied hat per ' + via + ' auf einen Vorgang geantwortet.\n\n'
        + 'Mitglied: ' + who(m) + (m && m.email ? (' · ' + m.email) : '')
        + '\nVorgang: ' + (v.subject || '—') + ' (' + (v.ref || '') + ')'
        + '\n\nNachricht des Mitglieds:\n' + text });
  } catch (e) { /* Studio-Benachrichtigung ist best effort */ }
  return { ok: true, vorgang: v };
}

module.exports = {
  replyToken, verifyReplyToken, inboundAddress, studioReplyUrl,
  tokenFromAddress, extractLatestReply, fetchReceivedBody, notifyStudio,
  applyOwnerReply, applyMemberReply,
};
