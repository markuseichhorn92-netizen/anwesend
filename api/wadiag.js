'use strict';

/**
 * TEMPORÄRER Diagnose-Endpunkt für den WhatsApp-Login-Code.
 *   GET /api/wadiag?key=<TEAM_PASSWORD>&to=<Handynummer>
 *
 * Schickt eine echte Login-Vorlage an <to> und gibt Twilios EXAKTE Antwort
 * (Status + Body) zurück, damit sich „Code kommt nicht" eindeutig diagnostizieren
 * lässt. Geschützt mit dem Team-Passwort (kein Secret im Repo).
 *
 * NACH der Analyse wieder entfernen.
 */

const TA = require('../lib/teamAuth');
const WA = require('../lib/whatsapp');

function mask(s) { return String(s || '').replace(/\d(?=\d{2})/g, '•'); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  let q = {}; try { const u = new URL(req.url, 'http://x'); u.searchParams.forEach((v, k) => { q[k] = v; }); } catch (e) {}
  if (!TA.verifyPassword(q.key || '')) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }

  const info = {
    hasWaLogin: WA.hasWaLogin,
    hasTwilio: WA.hasTwilio,
    hasMeta: WA.hasMeta,
    from: mask(process.env.TWILIO_WHATSAPP_FROM || ''),
    contentSidSet: !!process.env.TWILIO_LOGIN_CONTENT_SID,
    contentSidPrefix: String(process.env.TWILIO_LOGIN_CONTENT_SID || '').slice(0, 4),
  };
  if (q.to) {
    info.to = mask(q.to);
    info.send = await WA.sendLoginTemplate(q.to, '123456');   // Twilios Status + Body
  }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, info: info }, null, 2));
};
