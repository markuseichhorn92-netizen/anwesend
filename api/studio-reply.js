'use strict';

/**
 * /api/studio-reply   (Weg B: Inhaber antwortet über einen Link)
 * --------------------------------------------------------------
 *   GET  ?t=<token>  -> Antwort-Seite (Vorgang + Textfeld), ohne Login
 *   POST t=<token>, text=…  -> Antwort anwenden (Postfach + E-Mail an Kunden)
 * Berechtigung = Besitz des signierten Tokens (steht nur in der Studio-Mail).
 * Liefert eine kleine, mobilfreundliche HTML-Seite im Studio-Look.
 */

const M = require('../lib/members');
const Inbox = require('../lib/inbox');
const SR = require('../lib/studioReply');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(bodyHtml) {
  return '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>Antworten · Fit-Inn Trier</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800;900&display=swap" rel="stylesheet">' +
    '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:22px;' +
    'font-family:Archivo,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;' +
    'background:linear-gradient(165deg,#0e6072 0%,#063540 100%);color:#15171B}' +
    '.card{width:100%;max-width:460px;background:#fffdfb;border-radius:22px;padding:28px 24px;box-shadow:0 18px 50px rgba(4,33,40,.28)}' +
    '.ic{width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px}' +
    'h1{font-size:21px;font-weight:900;letter-spacing:-.4px;color:#15171B;text-align:center}' +
    'p{font-size:14.5px;font-weight:500;color:#5d6b72;margin-top:9px;line-height:1.5}' +
    '.ref{text-align:center;font-size:12px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:#8a929a;margin-top:4px}' +
    '.quote{margin-top:16px;background:#f1f6f7;border-radius:13px;padding:14px 16px;font-size:14px;color:#42454b;line-height:1.5;white-space:pre-wrap;max-height:200px;overflow:auto}' +
    '.qh{font-size:11px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#8a929a;margin-bottom:6px}' +
    'label{display:block;margin-top:18px;font-size:13px;font-weight:700;color:#42454b}' +
    'textarea{width:100%;margin-top:8px;padding:13px 14px;border:1.5px solid #d6dee0;border-radius:12px;font-family:inherit;font-size:15px;color:#15171B;min-height:140px;resize:vertical;outline:none}' +
    'textarea:focus{border-color:#0a4958}' +
    'button{width:100%;margin-top:16px;padding:15px;border:none;border-radius:13px;font-family:inherit;font-weight:800;font-size:16px;cursor:pointer;background:#0a4958;color:#fff}' +
    '.foot{margin-top:18px;font-size:12px;color:#9aa6ab;font-weight:600;text-align:center}' +
    '</style></head><body><div class="card">' + bodyHtml +
    '<div class="foot">Fit-Inn Trier · interne Antwort-Seite</div>' +
    '</div></body></html>';
}

const MAIL = '<div class="ic" style="background:#0a4958"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg></div>';
const CHECK = '<div class="ic" style="background:#1d7a3e"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4 4 10-10"></path></svg></div>';
const INFO = '<div class="ic" style="background:#7C8A99"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg></div>';

function send(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(page(html));
}

function readForm(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e5) req.destroy(); });
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

function memberName(m) {
  if (!m) return 'das Mitglied';
  return (((m.firstName || '') + ' ' + (m.lastName || '')).trim()) || 'das Mitglied';
}
function lastFromMember(v) {
  const msgs = (v && v.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].from !== 'team') return msgs[i].text; }
  return msgs.length ? msgs[msgs.length - 1].text : '';
}

module.exports = async function handler(req, res) {
  if (!Inbox.hasStore) return send(res, 200, INFO + '<h1>Vorübergehend nicht verfügbar</h1><p>Bitte versuche es später erneut.</p>');

  try {
    if (req.method === 'POST') {
      const form = await readForm(req);
      const v = SR.verifyReplyToken(form.t);
      if (!v) return send(res, 200, INFO + '<h1>Link ungültig</h1><p>Dieser Antwort-Link ist nicht gültig.</p>');
      if (!(await M.rateLimit('studio-reply:' + v.memberId + ':' + v.vorgangId, 30, 3600))) {
        return send(res, 200, INFO + '<h1>Zu viele Versuche</h1><p>Bitte versuche es in einer Stunde erneut.</p>');
      }
      const text = String(form.text || '').trim();
      if (!text) return send(res, 200, INFO + '<h1>Keine Nachricht</h1><p>Bitte gib eine Antwort ein und sende erneut.</p>');
      const r = await SR.applyOwnerReply(v.memberId, v.vorgangId, text);
      if (!r.ok) return send(res, 200, INFO + '<h1>Vorgang nicht gefunden</h1><p>Der Vorgang existiert nicht mehr.</p>');
      let m = null; try { m = await M.getMember(v.memberId); } catch (e) {}
      return send(res, 200, CHECK + '<h1>Antwort gesendet ✓</h1><p>Deine Antwort ist jetzt im Postfach von <strong>' + esc(memberName(m)) + '</strong> und wurde zusätzlich per E-Mail verschickt.</p>');
    }

    // GET: Antwort-Seite
    let url; try { url = new URL(req.url, 'http://localhost'); } catch (e) { url = null; }
    const t = (url && url.searchParams.get('t')) || '';
    const v = SR.verifyReplyToken(t);
    if (!v) return send(res, 200, INFO + '<h1>Link ungültig</h1><p>Dieser Antwort-Link ist nicht gültig oder abgelaufen.</p>');
    const vorgang = await Inbox.get(v.memberId, v.vorgangId);
    if (!vorgang) return send(res, 200, INFO + '<h1>Vorgang nicht gefunden</h1><p>Dieser Vorgang existiert nicht mehr.</p>');
    let m = null; try { m = await M.getMember(v.memberId); } catch (e) {}
    const last = lastFromMember(vorgang);

    return send(res, 200, MAIL +
      '<h1>Antwort an ' + esc(memberName(m)) + '</h1>' +
      '<div class="ref">' + esc(vorgang.subject || 'Vorgang') + (vorgang.ref ? (' · ' + esc(vorgang.ref)) : '') + '</div>' +
      (last ? ('<div class="quote"><div class="qh">Letzte Nachricht</div>' + esc(String(last).slice(0, 800)) + '</div>') : '') +
      '<form method="POST" action="/api/studio-reply">' +
      '<input type="hidden" name="t" value="' + esc(t) + '">' +
      '<label for="text">Deine Antwort</label>' +
      '<textarea id="text" name="text" placeholder="Antwort an das Mitglied …" required></textarea>' +
      '<button type="submit">Antwort senden</button>' +
      '</form>' +
      '<p style="margin-top:14px;font-size:12.5px;color:#8a929a;text-align:center">Erscheint im Postfach des Mitglieds und geht ihm per E-Mail zu.</p>');
  } catch (e) {
    console.error('[studio-reply]', e.message);
    return send(res, 200, INFO + '<h1>Etwas ist schiefgelaufen</h1><p>Bitte versuche es später erneut.</p>');
  }
};
