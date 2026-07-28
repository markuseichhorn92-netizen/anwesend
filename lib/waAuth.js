'use strict';

/**
 * WhatsApp-Verifizierung („2 Faktoren"), damit die WhatsApp-KI Fragen eines
 * Mitglieds zu SEINEN Daten beantworten darf.
 * -----------------------------------------------------------------------------
 *  1. Faktor – Besitz: Die eingehende WhatsApp-Nummer muss zu einer in Magicline
 *     hinterlegten Nummer gehören (Zuordnung passiert im Webhook via M.findByPhone).
 *  2. Faktor – Wissen: Das Mitglied bestätigt über einen Link Geburtsdatum + E-Mail
 *     (Prüfung serverseitig gegen Magicline). Erst danach ist die Nummer
 *     „verifiziert" – zeitlich befristet (Re-Check nach längerer Inaktivität).
 *
 * Alles serverseitig (Upstash), fail-closed ohne Store. Es werden KEINE
 * Klartext-Geheimnisse, Prompts oder Gesundheitsdaten gespeichert – nur die
 * Zuordnung Nummer↔Mitglied, Zeitstempel und die Einwilligungsversion.
 */

const crypto = require('crypto');
const { redisPipeline, hasStore } = require('./store');

// Verifizierung gilt als „gleitendes Fenster": bei jeder Aktivität wird die
// Restlaufzeit erneuert. Läuft sie ab (längere Pause) -> erneute Bestätigung.
const VERIFY_TTL_DAYS = Math.max(1, parseInt(process.env.WA_VERIFY_TTL_DAYS || '60', 10));
const VERIFY_TTL = VERIFY_TTL_DAYS * 86400;
const CHAL_TTL = 30 * 60;                 // Bestätigungs-Link: 30 Minuten gültig
// Version der Einwilligung (KI-Antworten inkl. Trainings-/Ernährungsdaten über WhatsApp).
const CONSENT_VERSION = process.env.WA_CONSENT_VERSION || 'wa-finn-2026-07';

function normPhone(p) { return String(p == null ? '' : p).replace(/[^\d]/g, ''); }
const vKey = (phone) => 'wa:verify:' + normPhone(phone);
const cKey = (token) => 'wa:chal:' + String(token || '');
const cForKey = (phone) => 'wa:chalfor:' + normPhone(phone);

// ── Verifizierungsstatus ──
async function getVerified(phone) {
  const digits = normPhone(phone);
  if (!hasStore || !digits) return null;
  try { const [v] = await redisPipeline([['GET', vKey(digits)]]); return v ? (typeof v === 'string' ? JSON.parse(v) : v) : null; }
  catch (e) { return null; }
}
// „Am Leben halten": bei jeder verifizierten Nachricht die Restlaufzeit erneuern.
async function touch(phone) {
  const digits = normPhone(phone);
  if (!hasStore || !digits) return;
  try { await redisPipeline([['EXPIRE', vKey(digits), String(VERIFY_TTL)]]); } catch (e) {}
}
async function setVerified(phone, memberId, consentVersion) {
  const digits = normPhone(phone);
  if (!hasStore || !digits || memberId == null) return false;
  const rec = { memberId: String(memberId), verifiedAt: Date.now(), consentVersion: String(consentVersion || CONSENT_VERSION) };
  try { await redisPipeline([['SET', vKey(digits), JSON.stringify(rec), 'EX', String(VERIFY_TTL)]]); return true; }
  catch (e) { return false; }
}
async function clearVerified(phone) {
  const digits = normPhone(phone);
  if (!hasStore || !digits) return;
  try { await redisPipeline([['DEL', vKey(digits)]]); } catch (e) {}
}

// ── Bestätigungs-Challenge (Link) ──
// Bindet Token -> Nummer + erwartetes Mitglied. Pro Nummer ist nur EINE offene
// Challenge aktiv (verhindert Link-Spam); innerhalb der Laufzeit wird sie wiederverwendet.
async function createChallenge(phone, memberId) {
  const digits = normPhone(phone);
  if (!hasStore || !digits || memberId == null) return null;
  try {
    const [existing] = await redisPipeline([['GET', cForKey(digits)]]);
    if (existing) {
      const [rec] = await redisPipeline([['GET', cKey(existing)]]);
      if (rec) return { token: String(existing), reused: true };
    }
  } catch (e) {}
  const token = crypto.randomBytes(24).toString('hex');
  const rec = { phone: digits, memberId: String(memberId), createdAt: Date.now() };
  try {
    await redisPipeline([
      ['SET', cKey(token), JSON.stringify(rec), 'EX', String(CHAL_TTL)],
      ['SET', cForKey(digits), token, 'EX', String(CHAL_TTL)],
    ]);
    return { token: token, reused: false };
  } catch (e) { return null; }
}
async function getChallenge(token) {
  if (!hasStore || !token) return null;
  try { const [v] = await redisPipeline([['GET', cKey(token)]]); return v ? (typeof v === 'string' ? JSON.parse(v) : v) : null; }
  catch (e) { return null; }
}
async function consumeChallenge(token) {
  if (!hasStore || !token) return;
  let rec = null; try { rec = await getChallenge(token); } catch (e) {}
  const cmds = [['DEL', cKey(token)]];
  if (rec && rec.phone) cmds.push(['DEL', cForKey(rec.phone)]);
  try { await redisPipeline(cmds); } catch (e) {}
}

// Idempotenz: Meta stellt Webhooks bei Verzögerung erneut zu. Liefert true, wenn
// diese Nachrichten-ID zum ERSTEN Mal gesehen wird (und merkt sie kurz vor). Ohne
// Store/ID nicht blockieren (true), damit im Zweifel nicht geschluckt wird.
async function firstSeen(msgId) {
  if (!hasStore || !msgId) return true;
  try { const [r] = await redisPipeline([['SET', 'wa:seen:' + String(msgId), '1', 'NX', 'EX', '3600']]); return r === 'OK' || r === true; }
  catch (e) { return true; }
}

module.exports = {
  VERIFY_TTL_DAYS, VERIFY_TTL, CHAL_TTL, CONSENT_VERSION, normPhone,
  getVerified, touch, setVerified, clearVerified,
  createChallenge, getChallenge, consumeChallenge, firstSeen,
};
