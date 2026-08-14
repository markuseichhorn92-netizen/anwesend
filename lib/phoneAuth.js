'use strict';

/**
 * Wer ruft da an – und darf ich ihm SEINE Daten sagen?
 * -----------------------------------------------------------------------------
 * Bis hierher gab der Telefonassistent nur öffentliche Auskünfte und
 * Terminangaben heraus. Vertrag, Beitrag und Pause sind etwas anderes: Wer die
 * am Telefon erfährt, muss nachweislich das Mitglied sein.
 *
 * Der Maßstab liegt schon fest – die WhatsApp-KI (lib/waAuth.js) beantwortet
 * dieselben Fragen und verlangt dafür ZWEI Faktoren. Weniger darf es hier nicht
 * sein, nur weil die Leitung eine andere ist.
 *
 *  1. BESITZ – die anrufende Nummer gehört zu einem Kunden in Magicline.
 *     Notwendig, aber NICHT hinreichend: Rufnummern lassen sich fälschen,
 *     über VoIP-Strecken ohne großen Aufwand. Wer allein darauf baut, gibt
 *     Vertragsdaten an jeden heraus, der eine Nummer kennt und sie setzen kann.
 *
 *  2. WISSEN/ZUGRIFF – einer von zwei Wegen:
 *     a) Die Nummer ist über WhatsApp bereits verifiziert. Dann wurde für GENAU
 *        diese Nummer schon Geburtsdatum + E-Mail gegen Magicline geprüft und
 *        die Einwilligung erfasst. Im Gespräch ist dann nichts mehr zu tun –
 *        das ist der bequeme Fall, den wir uns zunutze machen.
 *     b) Sonst ein 6-stelliger Code an einen Kanal, der dem Mitglied gehört
 *        (E-Mail bzw. WhatsApp aus dem Magicline-Profil, siehe lib/loginCode).
 *        Der Anrufer liest ihn vor. Eine gefälschte Anruferkennung nützt dann
 *        nichts, weil der Code woanders ankommt.
 *
 * Gespeichert wird ausschließlich die Zuordnung Nummer↔Mitglied, der Zeitpunkt
 * und die Einwilligungsversion. Keine Codes im Klartext, keine Namen, keine
 * Gesundheits- oder Vertragsdaten.
 *
 * Fail-closed: ohne Speicher gibt es keine Verifizierung – und damit keine
 * persönlichen Auskünfte.
 */

const crypto = require('node:crypto');
const M = require('./members');
const WAAuth = require('./waAuth');
const { redisPipeline, hasStore } = require('./store');

// Gleitendes Fenster wie bei WhatsApp: bei Aktivität verlängert sich die
// Laufzeit, nach längerer Pause ist erneut zu bestätigen.
const VERIFY_TTL_DAYS = Math.max(1, parseInt(process.env.PHONE_VERIFY_TTL_DAYS || '60', 10));
const VERIFY_TTL = VERIFY_TTL_DAYS * 86400;
// Muss zur Laufzeit des Login-Codes passen, sonst zeigt die Klammer auf einen
// Code, den es nicht mehr gibt.
const CODE_TTL = 600;   // wie der Login-Code selbst (lib/loginCode.js)
const CODE_MAX_VERSUCHE = 4;
// Einwilligung für KI-Auskünfte zu eigenen Daten am Telefon. Ändert sich der
// Text, wird die Version hochgezählt und alle müssen erneut bestätigen.
const CONSENT_VERSION = process.env.PHONE_CONSENT_VERSION || 'tel-finn-2026-08';

function digits(p) { return String(p == null ? '' : p).replace(/[^\d]/g, ''); }
// Kanonisch wie in members.js: 0151… und +49151… sind dieselbe Nummer.
function key(phone) { const d = M.normDePhone(phone); return d ? ('phone:verify:' + d) : null; }

// Dieselbe Nummer in allen gaengigen Formen. Wird gebraucht, um in fremden
// Ablagen zu suchen, die nach rohen Ziffern schluesseln.
function schreibweisen(phone) {
  const d = digits(phone);
  if (!d || d.length < 6) return [];
  const set = new Set([d]);
  if (d.indexOf('49') === 0) { const nat = d.slice(2); set.add(nat).add('0' + nat).add('0049' + nat); }
  if (d.indexOf('0') === 0 && d.indexOf('00') !== 0) { const nat = d.slice(1); set.add(nat).add('49' + nat).add('0049' + nat); }
  if (d.indexOf('0049') === 0) { const nat = d.slice(4); set.add(nat).add('49' + nat).add('0' + nat); }
  return Array.from(set);
}

function hashCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }

/**
 * Verifizierungsstatus einer Rufnummer.
 * @returns {Promise<{verified:boolean, memberId:string|null, quelle:string|null, consentVersion:string|null}>}
 */
async function status(phone) {
  const leer = { verified: false, memberId: null, quelle: null, consentVersion: null };
  if (!hasStore) return leer;                 // fail-closed

  // 1. Eigene Telefon-Verifizierung.
  const k = key(phone);
  if (k) {
    try {
      const [v] = await redisPipeline([['GET', k]]);
      if (v) {
        const rec = (typeof v === 'string') ? JSON.parse(v) : v;
        if (rec && rec.memberId != null) {
          return { verified: true, memberId: String(rec.memberId), quelle: 'telefon',
            consentVersion: rec.consentVersion || null };
        }
      }
    } catch (e) { /* weiter zu WhatsApp */ }
  }

  // 2. Bereits über WhatsApp verifiziert? Dann wurden für DIESE Nummer schon
  //    zwei Faktoren geprüft und die Einwilligung erfasst. Ein zweites Mal
  //    danach zu fragen wäre reine Schikane.
  //
  //    ACHTUNG, hier liegt eine Falle: waAuth schlüsselt nach den ROHEN Ziffern,
  //    so wie die Nummer dort ankam. WhatsApp liefert international („4915…"),
  //    am Telefon nennt derselbe Mensch sie national („0151…"). Ohne die
  //    Schreibweisen durchzuprobieren fände man den Eintrag nie – und das
  //    Mitglied müsste sich grundlos ein zweites Mal ausweisen.
  for (const v of schreibweisen(phone)) {
    try {
      const wa = await WAAuth.getVerified(v);
      if (wa && wa.memberId != null) {
        return { verified: true, memberId: String(wa.memberId), quelle: 'whatsapp',
          consentVersion: wa.consentVersion || null };
      }
    } catch (e) { /* nächste Schreibweise */ }
  }

  return leer;
}

// Laufzeit verlängern, solange die Nummer aktiv genutzt wird.
async function touch(phone) {
  const k = key(phone);
  if (!hasStore || !k) return;
  try { await redisPipeline([['EXPIRE', k, String(VERIFY_TTL)]]); } catch (e) { /* egal */ }
}

async function setVerified(phone, memberId, consentVersion) {
  const k = key(phone);
  if (!hasStore || !k || memberId == null) return false;
  try {
    const rec = JSON.stringify({ memberId: String(memberId), verifiedAt: Date.now(),
      consentVersion: String(consentVersion || CONSENT_VERSION) });
    await redisPipeline([['SET', k, rec, 'EX', String(VERIFY_TTL)]]);
    return true;
  } catch (e) { return false; }
}

async function clearVerified(phone) {
  const k = key(phone);
  if (!hasStore || !k) return false;
  try { await redisPipeline([['DEL', k]]); return true; } catch (e) { return false; }
}

/**
 * Den Code selbst verwaltet der bestehende Login-Weg (lib/loginCode.js): er
 * erzeugt ihn, speichert NUR den Hash und stellt ihn über E-Mail oder WhatsApp
 * zu. Hier einen zweiten Code-Mechanismus danebenzustellen hiesse, denselben
 * sicherheitskritischen Code ein zweites Mal zu schreiben - mit einer zweiten
 * Gelegenheit, ihn falsch zu machen.
 *
 * Was fehlt, ist nur die Klammer: Am Telefon kann der Anrufer keinen
 * Challenge-Token festhalten. Also merken wir uns, welche Challenge zu welcher
 * Rufnummer gehört.
 */
function chalKey(phone) { const d = M.normDePhone(phone); return d ? ('phone:chal:' + d) : null; }

async function saveChallenge(phone, challenge) {
  const k = chalKey(phone);
  if (!hasStore || !k || !challenge) return false;
  try { await redisPipeline([['SET', k, String(challenge), 'EX', String(CODE_TTL)]]); return true; }
  catch (e) { return false; }
}

/**
 * Vorgelesenen Code prüfen.
 *
 * Fehlversuche werden mitgezählt und der Code danach verworfen – sechs Stellen
 * sind sonst am Telefon in Ruhe durchprobierbar. Die Antwort unterscheidet
 * NICHT zwischen „falsch" und „abgelaufen": beides würde verraten, ob überhaupt
 * ein Code unterwegs ist.
 *
 * @returns {Promise<{ok:boolean, memberId:string|null, grund:string}>}
 */
async function checkCode(phone, eingabe) {
  const k = chalKey(phone);
  const nein = { ok: false, memberId: null, grund: 'ungueltig' };
  if (!hasStore || !k) return nein;
  const code = digits(eingabe);
  if (code.length !== 6) return nein;

  let chal = null;
  try { const [v] = await redisPipeline([['GET', k]]); chal = v ? String(v) : null; } catch (e) { return nein; }
  if (!chal) return nein;

  const otp = await M.otpGet(chal);
  if (!otp || !otp.codeHash) return nein;

  otp.tries = (otp.tries || 0) + 1;
  if (otp.tries > CODE_MAX_VERSUCHE) {
    try { await M.otpDel(chal); await redisPipeline([['DEL', k]]); } catch (e) { /* egal */ }
    return { ok: false, memberId: null, grund: 'zu_viele_versuche' };
  }

  if (M.hashCode(code) !== otp.codeHash) {
    // Zählerstand behalten, Restlaufzeit nicht verlängern.
    const rest = Math.max(1, Math.floor(((otp.exp || 0) - Date.now()) / 1000));
    try { await M.otpSave(chal, otp, rest); } catch (e) { /* egal */ }
    return nein;
  }

  // Einmal benutzt – danach wertlos.
  try { await M.otpDel(chal); await redisPipeline([['DEL', k]]); } catch (e) { /* egal */ }
  return { ok: true, memberId: String(otp.id), grund: 'ok' };
}

module.exports = {
  status, touch, setVerified, clearVerified,
  saveChallenge, checkCode, hashCode, schreibweisen,
  VERIFY_TTL_DAYS, VERIFY_TTL, CODE_TTL, CODE_MAX_VERSUCHE, CONSENT_VERSION,
};
