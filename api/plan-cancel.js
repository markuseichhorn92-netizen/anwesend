'use strict';

/**
 * Vercel Serverless Function · /api/plan-cancel
 * ---------------------------------------------
 * Storno der heutigen Vormerkung über einen signierten Link aus der E-Mail – ohne Login.
 *   GET  ?t=<token>  -> Bestätigungsseite (storniert NICHT; Prefetch-sicher)
 *   POST t=<token>   -> storniert und zeigt die Erfolgsseite
 * Liefert eine kleine HTML-Seite (mobilfreundlich, im Studio-Look).
 */

const P = require('../lib/plans');

function fmtSlot(m) {
  if (m == null) return '';
  return (Math.floor(m / 60) < 10 ? '0' : '') + Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(bodyHtml) {
  return '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>Vormerkung · Fit-Inn Trier</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800;900&display=swap" rel="stylesheet">' +
    '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:22px;' +
    'font-family:Archivo,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;' +
    'background:linear-gradient(165deg,#0e6072 0%,#063540 100%);color:#15171B}' +
    '.card{width:100%;max-width:420px;background:#fffdfb;border-radius:22px;padding:30px 26px;box-shadow:0 18px 50px rgba(4,33,40,.28);text-align:center}' +
    '.ic{width:60px;height:60px;border-radius:17px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}' +
    'h1{font-size:22px;font-weight:900;letter-spacing:-.4px;color:#15171B}' +
    'p{font-size:15px;font-weight:500;color:#5d6b72;margin-top:10px;line-height:1.5}' +
    '.big{font-size:19px;font-weight:800;color:#0a4958}' +
    'button{width:100%;margin-top:22px;padding:15px;border:none;border-radius:13px;font-family:inherit;font-weight:800;font-size:16px;cursor:pointer}' +
    '.danger{background:#b53a2c;color:#fff}' +
    '.muted{display:inline-block;margin-top:16px;color:#8a929a;font-size:13px;font-weight:700;text-decoration:none}' +
    '.foot{margin-top:18px;font-size:12px;color:#9aa6ab;font-weight:600}' +
    '</style></head><body><div class="card">' + bodyHtml +
    '<div class="foot">Fit-Inn Trier · Auf Hirtenberg 8 · 54296 Trier</div>' +
    '</div></body></html>';
}

const CLOCK = '<div class="ic" style="background:#0a4958"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5l3 1.8"></path></svg></div>';
const CHECK = '<div class="ic" style="background:#1d7a3e"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4 4 10-10"></path></svg></div>';
const INFO = '<div class="ic" style="background:#7C8A99"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg></div>';

function send(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(page(html));
}

function readForm(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const o = {};
      String(b || '').split('&').forEach((kv) => {
        const i = kv.indexOf('='); if (i < 0) return;
        try { o[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch (e) {}
      });
      resolve(o);
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  if (!P.hasStore) return send(res, 200, INFO + '<h1>Vorübergehend nicht verfügbar</h1><p>Bitte versuche es später erneut.</p>');

  try {
    if (req.method === 'POST') {
      const form = await readForm(req);
      const r = await P.cancelByToken(form.t);
      if (!r.ok) return send(res, 200, INFO + '<h1>Link ungültig</h1><p>Dieser Storno-Link ist nicht gültig.</p>');
      if (r.slot == null) return send(res, 200, INFO + '<h1>Schon erledigt</h1><p>Diese Vormerkung war bereits storniert oder abgelaufen.</p>');
      return send(res, 200, CHECK + '<h1>Storniert ✓</h1><p>Deine Vormerkung für <span class="big">' + esc(fmtSlot(r.slot)) + ' Uhr</span> wurde storniert.</p>');
    }

    // GET: Bestätigungsseite (storniert NICHT)
    const url = new URL(req.url, 'http://localhost');
    const t = url.searchParams.get('t') || '';
    const info = await P.getPlanForToken(t);
    if (!info) return send(res, 200, INFO + '<h1>Link ungültig</h1><p>Dieser Storno-Link ist nicht gültig oder abgelaufen.</p>');
    if (info.slot == null) return send(res, 200, INFO + '<h1>Keine aktive Vormerkung</h1><p>Für diesen Link gibt es keine aktive Vormerkung mehr – sie wurde bereits storniert oder ist abgelaufen.</p>');

    return send(res, 200, CLOCK +
      '<h1>Vormerkung stornieren?</h1>' +
      '<p>Deine Vormerkung für heute um <span class="big">' + esc(fmtSlot(info.slot)) + ' Uhr</span> im Fit-Inn Trier.</p>' +
      '<form method="POST" action="/api/plan-cancel"><input type="hidden" name="t" value="' + esc(t) + '">' +
      '<button type="submit" class="danger">Jetzt stornieren</button></form>' +
      '<a class="muted" href="https://mitglieder.fit-inn-trier.de/mitglieder">Doch behalten</a>');
  } catch (e) {
    console.error('[plan-cancel]', e.message);
    return send(res, 200, INFO + '<h1>Etwas ist schiefgelaufen</h1><p>Bitte versuche es später erneut oder storniere im Mitgliederbereich.</p>');
  }
};
