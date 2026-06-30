'use strict';

/**
 * POST /api/member/login-request   { email, dob, customerNumber?, deliver? }
 * Zweistufiger Login (Facebook-Stil):
 *   1) OHNE deliver  -> nachschauen:
 *        - mehrere Konten ohne eindeutige Mitgliedschaft -> { step:'number' }
 *        - sonst { step:'channel', channels:[{type:'email'|'whatsapp', hint:maskiert}] }
 *          (nur Kanäle, die am gewählten Konto wirklich hinterlegt sind)
 *   2) MIT deliver ('email'|'whatsapp') -> 6-stelligen Code über den Kanal senden,
 *        { step:'code', challenge, via }.
 * 0 Treffer / Rate-Limit: verhält sich wie ein normaler Ablauf (kein Enumeration-Leak
 * über die Existenz; nur ob eine WhatsApp-Option erscheint, hängt am Profil).
 */

const crypto = require('node:crypto');
const M = require('../../lib/members');
const WA = require('../../lib/whatsapp');
const { sendLoginCode } = require('../../lib/loginCode');

// Demo-/Reviewer-Zugang für die App-Store-/Play-Store-Prüfung: ein fester Test-Account
// mit festem Code – ohne echten E-Mail-/WhatsApp-Versand, damit der Prüfer reinkommt.
// Nur aktiv, wenn ALLE vier Env-Variablen gesetzt sind (sonst völlig wirkungslos).
const DEMO_EMAIL = String(process.env.DEMO_LOGIN_EMAIL || '').trim().toLowerCase();
const DEMO_DOB = String(process.env.DEMO_LOGIN_DOB || '').trim();
const DEMO_CODE = String(process.env.DEMO_LOGIN_CODE || '').trim();
const DEMO_CID = String(process.env.DEMO_CUSTOMER_ID || '').trim();
const hasDemoLogin = !!(DEMO_EMAIL && DEMO_DOB && DEMO_CODE && DEMO_CID);

function bareNum(s) { return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/^M-?/, ''); }
function maskEmail(e) {
  e = String(e || ''); const at = e.indexOf('@');
  if (at < 1) return e ? (e[0] + '•••') : '';
  return e[0] + '•••' + e.slice(at);
}
function maskPhone(p) { const d = String(p || '').replace(/[^\d]/g, ''); return d.length >= 4 ? ('•••• ' + d.slice(-4)) : '••••'; }

function send(res, obj) { res.statusCode = 200; return res.end(JSON.stringify(obj)); }

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
  const dob = d.dob;
  const num = String(d.customerNumber || '').trim();
  const deliver = (d.deliver === 'whatsapp' || d.deliver === 'email') ? d.deliver : null;
  let challenge = crypto.randomBytes(24).toString('hex');

  // Reviewer-/Demo-Zugang: direkt zur Code-Eingabe (fester Code, kein Versand).
  if (hasDemoLogin && email === DEMO_EMAIL && String(dob || '').trim() === DEMO_DOB) {
    await M.otpSave(challenge, { id: DEMO_CID, codeHash: M.hashCode(DEMO_CODE), exp: Date.now() + 600000, tries: 0 }, 600);
    return send(res, { ok: true, step: 'code', challenge: challenge, via: 'email' });
  }

  try {
    const emailOk = email ? await M.rateLimit('otpreq:e:' + email, 10, 1800) : false;
    if (emailOk) {
      const matches = await M.findAllByEmailDob(email, dob);

      // Konto bestimmen: per Nummer, eindeutig, oder automatisch das Mitgliedschaftskonto.
      let chosen = null;
      if (num) {
        chosen = matches.find((c) => bareNum(c.customerNumber) === bareNum(num)) || null;
        if (!chosen && matches.length) return send(res, { ok: true, step: 'number', numberMismatch: true });
      } else if (matches.length === 1) {
        chosen = matches[0];
      } else if (matches.length > 1) {
        chosen = await M.pickMembershipAccount(matches);
        if (!chosen) return send(res, { ok: true, step: 'number' });   // mehrdeutig -> Mitgliedsnummer
      }

      let phone = null; try { phone = await M.phoneByEmailDob(email, dob); } catch (e) {}

      if (!deliver) {
        // Nachschauen: verfügbare Kanäle (maskiert) zurückgeben.
        const channels = [];
        const emAddr = (chosen && chosen.email) || email;
        if (emAddr) channels.push({ type: 'email', hint: maskEmail(emAddr) });
        if (chosen && phone && WA.hasWaLogin) channels.push({ type: 'whatsapp', hint: maskPhone(phone) });
        if (!channels.length) channels.push({ type: 'email', hint: maskEmail(email) });
        return send(res, { ok: true, step: 'channel', channels: channels });
      }

      // Senden über den gewählten Kanal.
      if (chosen && chosen.id != null) {
        const r = await sendLoginCode(chosen, req.headers['host'], { channel: deliver, phone: deliver === 'whatsapp' ? phone : undefined });
        if (r && r.challenge) challenge = r.challenge;
      }
      return send(res, { ok: true, step: 'code', challenge: challenge, via: deliver });
    }
  } catch (e) { /* still respond normally to avoid leaking */ }

  // Fallback (0 Treffer / Rate-Limit pro E-Mail): wie ein normaler Ablauf aussehen lassen.
  if (!deliver) return send(res, { ok: true, step: 'channel', channels: [{ type: 'email', hint: maskEmail(email) }] });
  return send(res, { ok: true, step: 'code', challenge: challenge, via: deliver });
};
