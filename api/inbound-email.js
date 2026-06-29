'use strict';

/**
 * POST /api/inbound-email   (Weg A: Inhaber antwortet per E-Mail)
 * ---------------------------------------------------------------
 * Webhook für eingehende E-Mails. Unterstützt:
 *   - Resend Inbound (Event "email.received"): Payload = nur Metadaten + Svix-Signatur;
 *     der Body wird per API nachgeladen (lib/studioReply.fetchReceivedBody).
 *   - generischer/Cloudflare-Webhook: JSON/urlencoded mit Empfänger + Klartext-Body inline.
 *
 * Empfänger ist die getokte Adresse pf.<token>@INBOUND_EMAIL_DOMAIN. Token wird
 * verifiziert, die jüngste Antwort extrahiert und als Team-Nachricht ins Postfach
 * geschrieben + dem Kunden gemailt (lib/studioReply.applyOwnerReply).
 *
 * Sicherheit: bei gesetztem RESEND_WEBHOOK_SECRET wird die Svix-Signatur über den
 * rohen Body geprüft (sonst optional ?secret=/Bearer gegen INBOUND_WEBHOOK_SECRET).
 * Antwortet bewusst immer 200 bei „verworfen", damit der Provider nicht endlos retryt.
 */

const crypto = require('node:crypto');
const SR = require('../lib/studioReply');
const M = require('../lib/members');

const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';
const SHARED_SECRET = process.env.INBOUND_WEBHOOK_SECRET || process.env.RECORD_SECRET || '';
const STUDIO_ADDR = (process.env.MAIL_TO || 'info@fit-inn-trier.de').toLowerCase();

// Rohbody als String lesen (für Svix-Verifikation nötig – nicht vorparsen).
function readRaw(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

function parseBody(raw, ct) {
  if (/application\/json/i.test(ct || '')) { try { return JSON.parse(raw || '{}'); } catch (e) { return {}; } }
  // urlencoded
  const o = {};
  String(raw || '').split('&').forEach((kv) => { const i = kv.indexOf('='); if (i < 0) return; try { o[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch (e) {} });
  if (!Object.keys(o).length) { try { return JSON.parse(raw || '{}'); } catch (e) {} }
  return o;
}

// Svix-Signaturprüfung (Resend nutzt Svix). signed = id.ts.rawBody, HMAC-SHA256 mit
// dem base64-dekodierten Secret (Teil nach "whsec_"), base64-Vergleich, ~5 Min Toleranz.
function verifySvix(secret, headers, raw) {
  const id = headers['svix-id'], ts = headers['svix-timestamp'], sigHeader = headers['svix-signature'];
  if (!id || !ts || !sigHeader) return false;
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;
  let key; try { key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64'); } catch (e) { return false; }
  const expected = crypto.createHmac('sha256', key).update(id + '.' + ts + '.' + raw).digest('base64');
  const eb = Buffer.from(expected);
  return String(sigHeader).split(' ').some((part) => {
    const sig = part.indexOf(',') >= 0 ? part.split(',')[1] : part;
    try { const sb = Buffer.from(sig); return sb.length === eb.length && crypto.timingSafeEqual(sb, eb); } catch (e) { return false; }
  });
}

// Erste brauchbare Zeichenkette aus Kandidaten (deckt Provider-Varianten / Arrays ab).
function firstStr() {
  for (let i = 0; i < arguments.length; i++) {
    const x = arguments[i];
    if (typeof x === 'string' && x) return x;
    if (Array.isArray(x) && x.length) return x.map((e) => (typeof e === 'string' ? e : (e && (e.address || e.email)) || '')).join(', ');
    if (x && typeof x === 'object' && (typeof x.address === 'string' || typeof x.email === 'string')) return x.address || x.email;
  }
  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const raw = await readRaw(req);

  // Authentifizierung: bevorzugt Svix (Resend); sonst optionales Shared-Secret.
  if (RESEND_WEBHOOK_SECRET) {
    if (!verifySvix(RESEND_WEBHOOK_SECRET, req.headers, raw)) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'bad_signature' })); }
  } else if (SHARED_SECRET) {
    let url; try { url = new URL(req.url, 'http://x'); } catch (e) { url = { searchParams: { get: () => null } }; }
    const provided = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('secret') || '';
    if (provided !== SHARED_SECRET) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  }

  const body = parseBody(raw, req.headers['content-type']);
  const d = body.data || body;     // Resend nestet unter data; Cloudflare flach

  // Empfänger (= unsere getokte Adresse) aus to/received_for/cc zusammensuchen.
  const to = [firstStr(d.to, d.recipient, d.To, (body.envelope && body.envelope.to), d['to-address'], (d.headers && d.headers.to)),
    firstStr(d.received_for), firstStr(d.cc)].filter(Boolean).join(', ');
  const token = SR.tokenFromAddress(to);
  const v = token ? SR.verifyReplyToken(token) : null;
  if (!v) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, ignored: 'no_token' })); }

  // Body: inline (Cloudflare) bevorzugen, sonst per Resend-API nachladen (email_id).
  let text = firstStr(d.text, d['text/plain'], d['stripped-text'], d.plain, d.body, d['body-plain'], d.textBody);
  if (!text && d.email_id) { try { text = await SR.fetchReceivedBody(d.email_id); } catch (e) {} }
  if (!text) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, ignored: 'no_body' })); }

  // Richtung anhand des Absenders bestimmen – robust:
  //   Absender == E-Mail des Mitglieds      -> Mitglieder-Antwort (Kunde)
  //   jede andere Adresse (Inhaber/Team)    -> Team-Antwort
  // So kann der Inhaber von JEDER Adresse (info@, iCloud, Gmail …) antworten; nur die
  // E-Mail des Kunden selbst zählt als Mitglieder-Nachricht. Studio-Adresse immer Team.
  const from = firstStr(d.from, body.from, (d.headers && d.headers.from)).toLowerCase();
  let isOwner = true;
  try {
    const mem = await M.getMember(v.memberId);
    const memEmail = String((mem && mem.email) || '').toLowerCase().trim();
    if (memEmail && from.indexOf(memEmail) >= 0) isOwner = false;
  } catch (e) { /* getMember-Fehler -> Standard: als Team behandeln */ }
  if (STUDIO_ADDR && from.indexOf(STUDIO_ADDR) >= 0) isOwner = true;
  try {
    if (isOwner) await SR.applyOwnerReply(v.memberId, v.vorgangId, text);
    else await SR.applyMemberReply(v.memberId, v.vorgangId, text);
  } catch (e) { /* nie hart scheitern */ }
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true, direction: isOwner ? 'team' : 'member' }));
};
