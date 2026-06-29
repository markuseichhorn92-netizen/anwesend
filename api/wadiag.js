'use strict';

/**
 * TEMPORÄRER Diagnose-Endpunkt für den WhatsApp-Login-Code.
 *   GET /api/wadiag?key=<TEAM_PASSWORD>&email=<mail>&dob=<YYYY-MM-DD>&to=<Handynummer>
 *
 * Zeigt:
 *  - Konfiguration (WhatsApp-Login aktiv? Absender? Content-SID gesetzt?)
 *  - bei email+dob: ALLE passenden Magicline-Datensätze (Dubletten!) und ob/wo eine
 *    Telefonnummer hängt (maskiert) -> erklärt „WhatsApp-Code kommt nicht".
 *  - bei to: echter Template-Versand + Twilios exakte Antwort (Status + Body).
 *
 * Geschützt mit dem Team-Passwort. NACH der Analyse wieder entfernen.
 */

const TA = require('../lib/teamAuth');
const WA = require('../lib/whatsapp');
const M = require('../lib/members');

function mask(s) { return String(s || '').replace(/\d(?=\d{2})/g, '•'); }
function phoneOf(c) { return (c && (c.phonePrivate || c.phoneMobile || c.phoneBusiness)) || null; }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  let q = {}; try { const u = new URL(req.url, 'http://x'); u.searchParams.forEach((v, k) => { q[k] = v; }); } catch (e) {}
  if (!TA.verifyPassword(q.key || '')) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }

  const info = {
    hasWaLogin: WA.hasWaLogin, hasTwilio: WA.hasTwilio, hasMeta: WA.hasMeta,
    from: mask(process.env.TWILIO_WHATSAPP_FROM || ''),
    contentSidSet: !!process.env.TWILIO_LOGIN_CONTENT_SID,
    contentSidPrefix: String(process.env.TWILIO_LOGIN_CONTENT_SID || '').slice(0, 4),
  };

  // Dubletten-/Telefon-Analyse für ein Konto
  if (q.email && q.dob) {
    try {
      const matches = await M.findAllByEmailDob(q.email, q.dob);
      info.matchCount = matches.length;
      const fulls = await Promise.all(matches.slice(0, 10).map(async (c) => {
        const id = c.id != null ? c.id : c.customerId;
        let full = null; try { full = await M.getMember(id); } catch (e) {}
        const ph = phoneOf(c) || phoneOf(full);
        return {
          id: id != null ? String(id) : null,
          customerNumber: (full && full.customerNumber) || c.customerNumber || null,
          hasPhone: !!ph, phone: ph ? mask(ph) : null,
          hasEmail: !!((full && full.email) || c.email),
        };
      }));
      info.records = fulls;
      const phone = await M.phoneByEmailDob(q.email, q.dob);
      info.resolvedPhone = phone ? mask(phone) : null;
    } catch (e) { info.lookupError = e && e.message; }
  }

  // Echter Template-Versand
  if (q.to) { info.to = mask(q.to); info.send = await WA.sendLoginTemplate(q.to, '123456'); }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, info: info }, null, 2));
};
