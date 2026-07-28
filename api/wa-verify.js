'use strict';

/**
 * Bestätigungs-Endpunkt für die WhatsApp-Verifizierung (2. Faktor).
 * KEIN Login – Zugang nur über den per WhatsApp verschickten Einmal-Token.
 *
 *   GET  ?token=…                         -> { ok, valid, studio }   (nur Gültigkeit prüfen)
 *   POST { token, dob, email, consent }   -> { ok } | { ok:false, error }
 *
 * Erfolgreich ist die Bestätigung nur, wenn Geburtsdatum + E-Mail in Magicline
 * zu GENAU dem Mitglied gehören, das der Nummer zugeordnet ist (Token-Bindung),
 * und die Einwilligung gesetzt ist. Fail-closed, generische Fehlermeldung (kein
 * Rückschluss auf einzelne Felder). Cache-Control: no-store.
 */

const M = require('../lib/members');
const WA = require('../lib/whatsapp');
const WAAuth = require('../lib/waAuth');

const STUDIO = { name: 'Fit-Inn Trier', tel: '0651 308524', mail: 'info@fit-inn-trier.de' };

function j(res, code, obj) { res.statusCode = code; res.end(JSON.stringify(obj)); }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown'; }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    let token = ''; try { token = new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch (e) {}
    if (!token) return j(res, 400, { ok: false, error: 'no_token' });
    const chal = await WAAuth.getChallenge(token);
    return j(res, 200, { ok: true, valid: !!chal, studio: STUDIO });
  }

  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });

  const ip = clientIp(req);
  if (!(await M.rateLimit('wa-verify:' + ip, 20, 3600))) {
    return j(res, 429, { ok: false, error: 'rate_limited', message: 'Zu viele Versuche – bitte später erneut.' });
  }

  let body = {}; try { body = await M.readBody(req); } catch (e) { body = {}; }
  const token = String(body.token || '').trim();
  const dob = String(body.dob || '').trim();
  const email = String(body.email || '').trim();
  const consent = body.consent === true || body.consent === 'true' || body.consent === 1;
  if (!token || !dob || !email) return j(res, 200, { ok: false, error: 'incomplete', message: 'Bitte Geburtsdatum und E-Mail angeben.' });
  if (!consent) return j(res, 200, { ok: false, error: 'consent_required', message: 'Bitte bestätige die Einwilligung, damit FINN dir über WhatsApp antworten darf.' });

  const chal = await WAAuth.getChallenge(token);
  if (!chal || !chal.memberId) return j(res, 200, { ok: false, error: 'expired', message: 'Der Bestätigungs-Link ist abgelaufen. Schreib uns kurz erneut auf WhatsApp, dann schicken wir dir einen neuen.' });

  // Zusätzliche Drosselung pro Token (Brute-Force auf Geburtsdatum/E-Mail verhindern).
  if (!(await M.rateLimit('wa-verify-tok:' + token, 6, 3600))) {
    return j(res, 429, { ok: false, error: 'rate_limited', message: 'Zu viele Versuche – bitte später erneut.' });
  }

  let member = null;
  try { member = await M.findByEmailDob(email, dob); } catch (e) { member = null; }
  const okMatch = member && member.id != null && String(member.id) === String(chal.memberId);
  if (!okMatch) {
    return j(res, 200, { ok: false, error: 'mismatch', message: 'Die Angaben passen nicht zu deinem WhatsApp-Kontakt. Bitte prüfe Geburtsdatum und E-Mail.' });
  }

  const set = await WAAuth.setVerified(chal.phone, chal.memberId, WAAuth.CONSENT_VERSION);
  if (!set) return j(res, 200, { ok: false, error: 'store', message: 'Das hat gerade nicht geklappt – bitte später erneut.' });
  try { await WAAuth.consumeChallenge(token); } catch (e) {}

  // Bestätigung zurück auf WhatsApp (best effort; wir sind im 24h-Fenster).
  try {
    if (WA.hasWhatsApp) await WA.sendText(chal.phone, 'Alles klar, du bist bestätigt ✓ Du kannst mir jetzt hier direkt deine Fragen stellen – zu Vertrag, Terminen, Training oder Ernährung. 💪');
  } catch (e) {}

  return j(res, 200, { ok: true });
};
