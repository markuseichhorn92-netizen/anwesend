'use strict';

/**
 * WhatsApp – Senden + Webhook-Helfer für ZWEI Anbieter:
 *   - Twilio (BSP): einfache Einrichtung, Sandbox zum Testen.
 *       Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 *            (z. B. "whatsapp:+14155238886" – Sandbox – oder die echte Sendernummer).
 *            optional TWILIO_WEBHOOK_URL (exakte Webhook-URL für die Signaturprüfung).
 *   - Meta Cloud API (direkt):
 *       Env: WA_TOKEN, WA_PHONE_NUMBER_ID, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_GRAPH_VERSION.
 *
 * Senden geht über Twilio, sobald dessen Variablen gesetzt sind, sonst über Meta.
 * Nur `fetch`, keine Dependency. „Schläft" (hasWhatsApp=false), bis ein Anbieter konfiguriert ist.
 */

const crypto = require('node:crypto');

// ── Meta ──
const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const VER = process.env.WA_GRAPH_VERSION || 'v21.0';
const APP_SECRET = process.env.WA_APP_SECRET || '';
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || '';
const hasMeta = !!(TOKEN && PHONE_ID);

// ── Twilio ──
const TW_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TW_FROM_RAW = process.env.TWILIO_WHATSAPP_FROM || '';
const hasTwilio = !!(TW_SID && TW_TOKEN && TW_FROM_RAW);

const hasWhatsApp = hasTwilio || hasMeta;

// Login-Code-Vorlage (Authentifizierung): Twilio Content-SID ODER Meta-Template-Name.
// Pflicht, weil außerhalb des 24h-Fensters nur genehmigte Vorlagen zustellbar sind.
const TW_LOGIN_SID = process.env.TWILIO_LOGIN_CONTENT_SID || '';
const WA_LOGIN_TPL = process.env.WA_LOGIN_TEMPLATE || '';
const hasWaLogin = !!((hasTwilio && TW_LOGIN_SID) || (hasMeta && WA_LOGIN_TPL));

// Freitext-Vorlage (business-initiiert außerhalb des 24h-Fensters): genehmigte Vorlage
// mit EINER Body-Variable {{1}} = der frei getippte Text. Twilio Content-SID ODER Meta-
// Template-Name. Ohne Konfiguration „schläft" der WhatsApp-Weg (hasWaText=false).
const TW_TEXT_SID = process.env.TWILIO_TEXT_CONTENT_SID || '';
const WA_TEXT_TPL = process.env.WA_TEXT_TEMPLATE || '';
const hasWaText = !!((hasTwilio && TW_TEXT_SID) || (hasMeta && WA_TEXT_TPL));

// In E.164 ohne '+' bringen: nur Ziffern; deutsche Eingaben (0049…, 0151…) -> 49…
function toWaNumber(num) {
  let d = String(num || '').replace(/[^\d]/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.indexOf('0') === 0) d = '49' + d.slice(1);
  return d;
}

// ───────────────────────── Meta senden ─────────────────────────
async function metaSend(payload) {
  try {
    const r = await fetch('https://graph.facebook.com/' + VER + '/' + PHONE_ID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ messaging_product: 'whatsapp' }, payload)),
    });
    const body = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: body.slice(0, 300) };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function send(payload) {
  if (!hasMeta) return { ok: false, error: 'no_meta' };
  return metaSend(payload);
}

// ───────────────────────── Twilio senden ─────────────────────────
function twFrom() {
  const f = String(TW_FROM_RAW).trim();
  if (f.indexOf('whatsapp:') === 0) return f;
  return 'whatsapp:+' + toWaNumber(f);
}
function twTo(num) { return 'whatsapp:+' + toWaNumber(num); }
async function twilioSendText(toNum, text) {
  try {
    const url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(TW_SID) + '/Messages.json';
    const body = new URLSearchParams({ From: twFrom(), To: twTo(toNum), Body: String(text || '').slice(0, 1600) }).toString();
    const auth = Buffer.from(TW_SID + ':' + TW_TOKEN).toString('base64');
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
    const t = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: t.slice(0, 300) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Freitext (innerhalb des 24-Stunden-Servicefensters). Anbieter-bewusst.
async function sendText(toNum, text) {
  if (hasTwilio) return twilioSendText(toNum, text);
  if (hasMeta) return metaSend({ to: toWaNumber(toNum), type: 'text', text: { preview_url: false, body: String(text || '').slice(0, 4096) } });
  return { ok: false, error: 'no_whatsapp' };
}

// Twilio Content-Vorlage senden (für genehmigte Templates, z. B. Login-Code).
async function twilioSendTemplate(toNum, contentSid, vars) {
  try {
    const url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(TW_SID) + '/Messages.json';
    const params = { From: twFrom(), To: twTo(toNum), ContentSid: contentSid };
    if (vars) params.ContentVariables = JSON.stringify(vars);
    const auth = Buffer.from(TW_SID + ':' + TW_TOKEN).toString('base64');
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    const t = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: t.slice(0, 300) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Login-Code per genehmigter Authentifizierungs-Vorlage zustellen. Anbieter-bewusst.
// Variable {{1}} = der 6-stellige Code.
async function sendLoginTemplate(toNum, code) {
  if (hasTwilio && TW_LOGIN_SID) return twilioSendTemplate(toNum, TW_LOGIN_SID, { 1: String(code) });
  if (hasMeta && WA_LOGIN_TPL) return sendTemplate(toNum, WA_LOGIN_TPL, 'de', [String(code)]);
  return { ok: false, error: 'no_wa_login' };
}

// Frei getippten Text als genehmigte Vorlage zustellen (business-initiiert, außerhalb des
// 24h-Fensters). Variable {{1}} = der Text (auf ~1000 Zeichen gekappt). Anbieter-bewusst.
async function sendFreeText(toNum, text) {
  const t = String(text || '').slice(0, 1000);
  if (hasTwilio && TW_TEXT_SID) return twilioSendTemplate(toNum, TW_TEXT_SID, { 1: t });
  if (hasMeta && WA_TEXT_TPL) return sendTemplate(toNum, WA_TEXT_TPL, 'de', [t]);
  return { ok: false, error: 'no_wa_text' };
}

// Genehmigte Vorlage (Meta; Twilio-Templates folgen via Content API in Phase 2).
async function sendTemplate(toNum, name, lang, bodyParams) {
  if (!hasMeta) return { ok: false, error: 'no_meta_template' };
  const components = (bodyParams && bodyParams.length)
    ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }]
    : undefined;
  return metaSend({ to: toWaNumber(toNum), type: 'template', template: { name: name, language: { code: lang || 'de' }, components: components } });
}

// ───────────────────────── Meta-Webhook ─────────────────────────
function verifyChallenge(query) {
  query = query || {};
  if (query['hub.mode'] === 'subscribe' && VERIFY_TOKEN && query['hub.verify_token'] === VERIFY_TOKEN) {
    return String(query['hub.challenge'] || '');
  }
  return null;
}
function verifySignature(rawBody, header) {
  if (!APP_SECRET) return true;
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody || '', 'utf8').digest('hex');
  try { const a = Buffer.from(header), b = Buffer.from(expected); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  catch (e) { return false; }
}
function parseInbound(body) {
  const out = [];
  const entries = (body && body.entry) || [];
  for (const e of entries) {
    const changes = (e && e.changes) || [];
    for (const c of changes) {
      const value = (c && c.value) || {};
      const contacts = value.contacts || [];
      const nameOf = (waId) => { const ct = contacts.find((x) => x && x.wa_id === waId); return (ct && ct.profile && ct.profile.name) || ''; };
      const msgs = value.messages || [];
      for (const m of msgs) {
        let text = '';
        if (m.type === 'text' && m.text) text = m.text.body || '';
        else if (m.type === 'button' && m.button) text = m.button.text || '';
        else if (m.type === 'interactive' && m.interactive) {
          const it = m.interactive;
          text = (it.button_reply && it.button_reply.title) || (it.list_reply && it.list_reply.title) || '';
        }
        if (m.from && text) out.push({ from: m.from, text: text, name: nameOf(m.from), id: m.id });
      }
    }
  }
  return out;
}

// ───────────────────────── Twilio-Webhook ─────────────────────────
// X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sortierte (key+value) der POST-Felder)).
// Ohne TWILIO_AUTH_TOKEN nicht erzwungen; mit TWILIO_SKIP_VALIDATION='1' abschaltbar (nur Setup).
function verifyTwilioSignature(fullUrl, params, header) {
  if (!TW_TOKEN || process.env.TWILIO_SKIP_VALIDATION === '1') return true;
  if (!header) return false;
  let data = String(fullUrl || '');
  Object.keys(params || {}).sort().forEach((k) => { data += k + params[k]; });
  const expected = crypto.createHmac('sha1', TW_TOKEN).update(data, 'utf8').digest('base64');
  try { const a = Buffer.from(expected), b = Buffer.from(String(header)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  catch (e) { return false; }
}
// Twilio liefert genau eine Nachricht je Webhook (form-urlencoded).
function parseTwilioInbound(params) {
  params = params || {};
  const from = String(params.From || '').replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/[^\d]/g, '');
  const text = String(params.Body || '');
  const name = params.ProfileName || '';
  const out = [];
  if (from && text) out.push({ from: from, text: text, name: name, id: params.MessageSid || '' });
  return out;
}

module.exports = {
  hasWhatsApp, hasTwilio, hasMeta, hasWaLogin, hasWaText, toWaNumber, send, sendText, sendTemplate,
  twilioSendTemplate, sendLoginTemplate, sendFreeText,
  verifyChallenge, verifySignature, parseInbound,
  verifyTwilioSignature, parseTwilioInbound,
  VERIFY_TOKEN, APP_SECRET,
};
