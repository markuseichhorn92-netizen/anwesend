'use strict';

/**
 * POST /api/inbound-email   (Weg A: Inhaber antwortet per E-Mail)
 * ---------------------------------------------------------------
 * Webhook für eingehende E-Mails. Provider-tolerant: erwartet JSON (z. B. von
 * einem Cloudflare Email Worker) mit Empfänger + Klartext-Body; urlencoded als
 * Fallback. Der Empfänger ist die getokte Adresse pf.<token>@INBOUND_EMAIL_DOMAIN.
 * Token wird verifiziert, die jüngste Antwort extrahiert und als Team-Nachricht
 * ins Postfach geschrieben + dem Kunden gemailt (lib/studioReply.applyOwnerReply).
 *
 * Optionaler Schutz: INBOUND_WEBHOOK_SECRET (Bearer oder ?secret=).
 * Antwortet bewusst immer 200, damit der Provider nicht endlos retryt.
 */

const SR = require('../lib/studioReply');

const SECRET = process.env.INBOUND_WEBHOOK_SECRET || process.env.RECORD_SECRET || '';

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => {
      const ct = String(req.headers['content-type'] || '');
      if (/application\/json/i.test(ct)) { try { return resolve(JSON.parse(b || '{}')); } catch (e) { return resolve({}); } }
      const o = {};
      String(b || '').split('&').forEach((kv) => { const i = kv.indexOf('='); if (i < 0) return; try { o[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch (e) {} });
      if (!Object.keys(o).length) { try { return resolve(JSON.parse(b || '{}')); } catch (e) {} }
      resolve(o);
    });
    req.on('error', () => resolve({}));
  });
}

// Erste brauchbare Zeichenkette aus mehreren Kandidaten (deckt Provider-Varianten ab).
function firstStr() {
  for (let i = 0; i < arguments.length; i++) {
    const x = arguments[i];
    if (typeof x === 'string' && x) return x;
    if (Array.isArray(x) && x.length) { if (typeof x[0] === 'string') return x[0]; if (x[0] && typeof x[0].address === 'string') return x[0].address; }
    if (x && typeof x === 'object' && typeof x.address === 'string') return x.address;
  }
  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  if (SECRET) {
    let url; try { url = new URL(req.url, 'http://x'); } catch (e) { url = { searchParams: { get: function () { return null; } } }; }
    const auth = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const provided = auth || url.searchParams.get('secret') || '';
    if (provided !== SECRET) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  }

  const b = await readBody(req);
  const env = b.envelope || {};
  const to = firstStr(b.to, b.recipient, b.To, env.to, b['to-address'], (b.headers && b.headers.to));
  const body = firstStr(b.text, b['text/plain'], b['stripped-text'], b.plain, b.body, b['body-plain'], b.textBody, b.html);
  const token = SR.tokenFromAddress(to);
  const v = token ? SR.verifyReplyToken(token) : null;

  if (!v || !body) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, ignored: true })); }
  try { await SR.applyOwnerReply(v.memberId, v.vorgangId, body); } catch (e) { /* nie hart scheitern */ }
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true }));
};
