'use strict';

/**
 * POST /api/member/login-request   { email, dob, channel?, customerNumber? }
 * Schritt 1 des Logins: Mitglied über E-Mail + Geburtsdatum suchen.
 *   - genau 1 Treffer  -> 6-stelligen Einmal-Code senden ({ step:'code', challenge })
 *   - mehrere Treffer  -> Mitgliedsnummer zur Eindeutigkeit anfordern ({ step:'number' })
 *                         (mit customerNumber erneut aufrufen -> exakter Datensatz)
 *   - 0 Treffer        -> tut so, als wäre ein Code unterwegs (kein Enumeration-Leak)
 */

const crypto = require('node:crypto');
const M = require('../../lib/members');
const { sendLoginCode } = require('../../lib/loginCode');

// Mitgliedsnummern locker vergleichen ("M-1146" == "1146" == "m1146").
function bareNum(s) { return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/^M-?/, ''); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!M.hasStore) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'no_store' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('otpreq:ip:' + ip, 15, 600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ error: 'rate_limited' }));
  }

  const d = await M.readBody(req);
  const email = String(d.email || '').trim().toLowerCase();
  const via = d.channel === 'whatsapp' ? 'whatsapp' : 'email';
  const num = String(d.customerNumber || '').trim();
  let challenge = crypto.randomBytes(24).toString('hex');

  try {
    // Pro E-Mail begrenzen (Mail-Bombing verhindern) – ohne nach außen zu verraten
    const emailOk = email ? await M.rateLimit('otpreq:e:' + email, 10, 1800) : false;
    if (emailOk) {
      const matches = await M.findAllByEmailDob(email, d.dob);   // alle Datensätze zu E-Mail+Geburtsdatum
      let chosen = null;
      if (num) {
        // Mit Mitgliedsnummer eingegrenzt.
        chosen = matches.find((c) => bareNum(c.customerNumber) === bareNum(num)) || null;
        if (!chosen && matches.length) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, step: 'number', numberMismatch: true })); }
      } else if (matches.length === 1) {
        chosen = matches[0];
      } else if (matches.length > 1) {
        // Mehrere Konten -> automatisch das Mitgliedschaftskonto wählen; nur wenn
        // das mehrdeutig ist (0/mehrere mit Vertrag), die Mitgliedsnummer abfragen.
        chosen = await M.pickMembershipAccount(matches);
        if (!chosen) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, step: 'number' })); }
      }
      if (chosen && chosen.id != null) {
        let phone; if (via === 'whatsapp') { try { phone = await M.phoneByEmailDob(email, d.dob); } catch (e) {} }
        const r = await sendLoginCode(chosen, req.headers['host'], { channel: via, phone: phone });
        if (r && r.challenge) challenge = r.challenge;
      }
      // 0 Treffer: nichts senden, aber unten so antworten, als wäre ein Code unterwegs.
    }
  } catch (e) { /* still return ok to avoid leaking */ }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, step: 'code', challenge: challenge, via: via }));
};
