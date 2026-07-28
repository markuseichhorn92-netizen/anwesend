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
const LF = require('../lib/leadflow');

const STUDIO = { name: 'Fit-Inn Trier', tel: '0651 308524', mail: 'info@fit-inn-trier.de' };

function j(res, code, obj) { res.statusCode = code; res.end(JSON.stringify(obj)); }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown'; }
// Diagnose OHNE Personenbezug: nur der Grund (kein Geburtsdatum/E-Mail/Telefon).
function vLog(reason) { try { console.log('[wa-verify]', JSON.stringify({ reason: reason })); } catch (e) {} }
function idOf(c) { return c && (c.id != null ? c.id : c.customerId); }

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

  // Identität ZUERST über E-Mail + Geburtsdatum (verlässlich) – nicht über die
  // unscharfe Telefonsuche. Magicline hat oft Dubletten, daher ALLE passenden
  // Datensätze holen.
  let all = [];
  try { all = await M.findAllByEmailDob(email, dob); } catch (e) { all = []; }
  if (!all.length) {
    vLog('no_member');   // Geburtsdatum/E-Mail passen zu keinem Mitglied (falsche/andere Angaben)
    return j(res, 200, { ok: false, error: 'mismatch', message: 'Die Angaben passen nicht. Bitte nutze das Geburtsdatum und die E-Mail-Adresse, die bei uns hinterlegt sind.' });
  }

  // Besitz-Faktor: Gehört die WhatsApp-Nummer zu einem dieser (E-Mail+Geburtsdatum-)
  // Datensätze? Das bindet beide Faktoren an dieselbe Person – robust gegen Dubletten
  // und die unscharfe Telefonsuche. Suchergebnisse haben oft keine Telefonfelder ->
  // Vollprofil laden.
  const target = M.normDePhone(chal.phone);
  let bound = null;
  for (const c of all) {
    let full = c;
    if (!M.customerPhoneSet(full).has(target)) { try { full = (await M.getMember(idOf(c))) || c; } catch (e) {} }
    if (M.customerPhoneSet(full).has(target)) { bound = full; break; }
  }
  // Fallback: die ursprünglich per Telefon gefundene ID gehört zu genau dieser Person.
  if (!bound) { const hit = all.find((c) => String(idOf(c)) === String(chal.memberId)); if (hit) bound = hit; }
  if (!bound) {
    vLog('phone_not_on_record');   // Identität ok, aber die Nummer steht auf keinem Datensatz dieser Person
    return j(res, 200, { ok: false, error: 'mismatch', message: 'Die Angaben passen nicht zu deiner WhatsApp-Nummer. Ist diese Nummer bei uns hinterlegt? Sonst melde dich kurz beim Team.' });
  }

  const memberId = String(idOf(bound));
  const set = await WAAuth.setVerified(chal.phone, memberId, WAAuth.CONSENT_VERSION);
  if (!set) return j(res, 200, { ok: false, error: 'store', message: 'Das hat gerade nicht geklappt – bitte später erneut.' });
  // Nummer fest ans Mitglied binden -> künftige Nachrichten werden zuverlässig
  // erkannt (resolveKnownLead), unabhängig von der unscharfen Telefonsuche.
  try {
    const nm = ((bound.firstName || '') + ' ' + (bound.lastName || '')).trim();
    await LF.linkPhone(chal.phone, { id: memberId, name: nm, nr: bound.customerNumber || null });
  } catch (e) {}
  vLog('ok');
  try { await WAAuth.consumeChallenge(token); } catch (e) {}

  // Bestätigung zurück auf WhatsApp (best effort; wir sind im 24h-Fenster).
  try {
    if (WA.hasWhatsApp) await WA.sendText(chal.phone, 'Alles klar, du bist bestätigt ✓ Du kannst mir jetzt hier direkt deine Fragen stellen – zu Vertrag, Terminen, Training oder Ernährung. 💪');
  } catch (e) {}

  return j(res, 200, { ok: true });
};
