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
// Das Konto wird über die Mitgliedsnummer (DEMO_CUSTOMER_NUMBER, z. B. M-2076) ODER
// die interne ID (DEMO_CUSTOMER_ID) bzw. notfalls über E-Mail+Geburtsdatum aufgelöst.
// Nur aktiv, wenn E-Mail, Geburtsdatum und Code gesetzt sind (sonst wirkungslos).
const DEMO_EMAIL = String(process.env.DEMO_LOGIN_EMAIL || '').trim().toLowerCase();
const DEMO_DOB = String(process.env.DEMO_LOGIN_DOB || '').trim();
const DEMO_CODE = String(process.env.DEMO_LOGIN_CODE || '').trim();
const DEMO_CID = String(process.env.DEMO_CUSTOMER_ID || '').trim();
const DEMO_NUM = String(process.env.DEMO_CUSTOMER_NUMBER || '').trim();
const hasDemoLogin = !!(DEMO_EMAIL && DEMO_DOB && DEMO_CODE);

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
  res.setHeader('Cache-Control', 'private, no-store');
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

  // Reviewer-/Demo-Zugang wie Benutzername + Passwort: allein die Demo-E-Mail
  // führt direkt zur Code-Eingabe (fester Code als "Passwort", kein Versand,
  // KEIN Geburtsdatum nötig – der App-Store-Prüfer bekommt nur E-Mail + Code).
  if (hasDemoLogin && email === DEMO_EMAIL) {
    let cid = DEMO_CID || null;
    if (!cid && DEMO_NUM) { try { const m = await M.findByNumberDob(DEMO_NUM, DEMO_DOB); if (m) cid = (m.id != null ? m.id : m.customerId); } catch (e) {} }
    if (!cid) { try { const m = await M.findByEmailDob(DEMO_EMAIL, DEMO_DOB); if (m) cid = (m.id != null ? m.id : m.customerId); } catch (e) {} }
    if (cid != null && String(cid) !== '') {
      await M.otpSave(challenge, { id: cid, codeHash: M.hashCode(DEMO_CODE), exp: Date.now() + 600000, tries: 0 }, 600);
      return send(res, { ok: true, step: 'code', challenge: challenge, via: 'email', demo: true });
    }
  }

  // Ohne Geburtsdatum (und kein Demo-Konto): dem Client sagen, dass das Datum fehlt.
  // Kein Enumeration-Leak – reiner UI-Hinweis, unabhängig davon, ob es das Konto gibt.
  if (!dob) { return send(res, { ok: true, step: 'needdob' }); }

  try {
    const emailOk = email ? await M.rateLimit('otpreq:e:' + email, 10, 1800) : false;
    if (emailOk) {
      const matches = await M.findAllByEmailDob(email, dob);

      // Kein Konto zu E-Mail + Geburtsdatum: klare Rückmeldung statt still weiter zum
      // Code-Schritt (früher wurde nie ein Code verschickt, obwohl die App „Code eingeben"
      // zeigte). E-Mail UND Geburtsdatum zusammen sind datenschutzunkritisch genug; der
      // Versuch bleibt rate-limitiert (oben 15/IP, hier 10/E-Mail) gegen Enumeration.
      if (!matches.length) return send(res, { ok: true, step: 'notfound' });

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

      // Senden über den gewählten Kanal (mit automatischem Fallback auf den anderen).
      // via = tatsächlich genutzter Weg; delivered=false, wenn die Zustellung nirgends griff
      // (dann kann die App „erneut senden / anderen Weg wählen" anbieten).
      if (chosen && chosen.id != null) {
        const r = await sendLoginCode(chosen, req.headers['host'], { channel: deliver, phone: deliver === 'whatsapp' ? phone : undefined });
        if (r && r.challenge) challenge = r.challenge;
        const actualVia = (r && r.channel) || null;
        return send(res, { ok: true, step: 'code', challenge: challenge, via: actualVia || deliver, delivered: !!actualVia });
      }
      return send(res, { ok: true, step: 'code', challenge: challenge, via: deliver, delivered: false });
    }
  } catch (e) { /* still respond normally to avoid leaking */ }

  // Fallback (0 Treffer / Rate-Limit pro E-Mail): wie ein normaler Ablauf aussehen lassen.
  if (!deliver) return send(res, { ok: true, step: 'channel', channels: [{ type: 'email', hint: maskEmail(email) }] });
  return send(res, { ok: true, step: 'code', challenge: challenge, via: deliver, delivered: false });
};
