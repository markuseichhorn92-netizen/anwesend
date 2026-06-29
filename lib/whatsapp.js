'use strict';

/**
 * WhatsApp Cloud API (Meta) – Senden + Webhook-Helfer.
 * Nur `fetch`, keine Dependency. Inaktiv (hasWhatsApp=false), solange die
 * Env-Variablen fehlen – die Anbindung „schläft" also bis zum Meta-Setup.
 *
 * Env: WA_TOKEN (dauerhafter System-User-Token), WA_PHONE_NUMBER_ID,
 *      WA_APP_SECRET (Webhook-Signatur), WA_VERIFY_TOKEN (Webhook-GET-Verify),
 *      WA_GRAPH_VERSION (Standard v21.0).
 */

const crypto = require('node:crypto');

const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const VER = process.env.WA_GRAPH_VERSION || 'v21.0';
const APP_SECRET = process.env.WA_APP_SECRET || '';
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || '';

const hasWhatsApp = !!(TOKEN && PHONE_ID);

// In das von der Graph API erwartete Format bringen: nur Ziffern, E.164 ohne '+'.
// Deutsche Eingaben (0049…, 0151…) werden auf 49… normalisiert.
function toWaNumber(num) {
  let d = String(num || '').replace(/[^\d]/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.indexOf('0') === 0) d = '49' + d.slice(1);
  return d;
}

async function send(payload) {
  if (!hasWhatsApp) return { ok: false, error: 'no_whatsapp' };
  try {
    const r = await fetch('https://graph.facebook.com/' + VER + '/' + PHONE_ID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ messaging_product: 'whatsapp' }, payload)),
    });
    const body = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: body.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Freitext (nur innerhalb des 24-Stunden-Servicefensters erlaubt).
async function sendText(toNum, text) {
  return send({ to: toWaNumber(toNum), type: 'text', text: { preview_url: false, body: String(text || '').slice(0, 4096) } });
}

// Genehmigte Vorlage (für vom Studio initiierte/automatische Nachrichten, Phase 2).
async function sendTemplate(toNum, name, lang, bodyParams) {
  const components = (bodyParams && bodyParams.length)
    ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }]
    : undefined;
  return send({ to: toWaNumber(toNum), type: 'template', template: { name: name, language: { code: lang || 'de' }, components: components } });
}

// Webhook-GET-Verifizierung (Meta sendet hub.mode/hub.verify_token/hub.challenge).
function verifyChallenge(query) {
  query = query || {};
  if (query['hub.mode'] === 'subscribe' && VERIFY_TOKEN && query['hub.verify_token'] === VERIFY_TOKEN) {
    return String(query['hub.challenge'] || '');
  }
  return null;
}

// X-Hub-Signature-256 über den ROHEN Body prüfen (HMAC-SHA256 mit App-Secret).
// Ohne gesetztes WA_APP_SECRET wird nicht erzwungen (Setup-/Testphase).
function verifySignature(rawBody, header) {
  if (!APP_SECRET) return true;
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody || '', 'utf8').digest('hex');
  try { const a = Buffer.from(header), b = Buffer.from(expected); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  catch (e) { return false; }
}

// Eingehende Textnachrichten aus dem Webhook-Payload extrahieren.
// -> [{ from, text, name, id }]
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

module.exports = {
  hasWhatsApp, toWaNumber, send, sendText, sendTemplate,
  verifyChallenge, verifySignature, parseInbound, VERIFY_TOKEN, APP_SECRET,
};
