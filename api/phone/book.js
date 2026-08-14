'use strict';

/**
 * POST /api/phone/book
 *   { key, firstname, lastname, phone, startDateTime,
 *     email?, gender?, dateOfBirth?, street?, houseNumber?, zip?, city?, note? }
 *
 * Bucht ein Probetraining aus dem Telefonat heraus.
 *
 * Der Unterschied zu /api/trial/book (Website): dort sind elf Felder Pflicht,
 * weil das Formular sie ohnehin abfragt. Am Telefon ist das nicht praktikabel –
 * eine Anschrift und eine E-Mail zu diktieren dauert und geht schief.
 *
 * Was Magicline WIRKLICH verlangt (am 14.08. gegen die Connect-API ausgemessen,
 * jeweils mit ungültigem Termin, damit nichts gebucht wird):
 *   firstname, lastname, email, phone, gender, dateOfBirth
 *   und eine Anschrift MIT Hausnummer (ohne houseNumber -> Ablehnung).
 *   gender kennt nur MALE, FEMALE, UNISEX – „UNKNOWN“ wird abgelehnt.
 *   note ist auf 300 Zeichen begrenzt – daran ist die erste echte Buchung gescheitert.
 *
 * Zuschnitt hier:
 *   • Am Telefon erfragt werden Vorname, Nachname, Rufnummer, Termin und
 *     GEBURTSDATUM. Das Geburtsdatum lässt sich nicht ersetzen: eine erfundene
 *     Angabe könnte eine minderjährige Person als volljährig führen.
 *   • E-Mail: Platzhalter, falls nicht genannt (siehe placeholderEmail).
 *   • Anschrift: erkennbarer Platzhalter, falls nicht genannt. „Telefonisch
 *     erfasst“ liest niemand als echte Straße.
 *   • Geschlecht: UNISEX, falls nicht genannt – ein von Magicline erlaubter
 *     Wert, keine erfundene Eigenschaft.
 *   • Lehnt Magicline trotzdem ab, meldet der Endpunkt das ehrlich samt
 *     Originalmeldung und verweist auf den Rückruf.
 *
 * Werbeeinwilligung ist IMMER false. Am Telefon lässt sich keine nachweisbare
 * Einwilligung einholen; die holt das Team beim Rückruf oder vor Ort.
 */

const crypto = require('node:crypto');
const P = require('../../lib/phoneApi');
const C = require('../../lib/connect');

const STUDIO_PHONE = '0651 308524';

/**
 * Platzhalter-Adresse, wenn der Anrufer keine E-Mail nennt.
 *
 * Zwei Bedingungen, die sich beissen: Magicline braucht eine Adresse, und die
 * Bestätigungsmail soll nicht ins Leere laufen. Deshalb per Voreinstellung eine
 * PLUS-Adresse auf dem Studio-Postfach: pro Lead eindeutig (Magicline führt sonst
 * verschiedene Anrufer unter derselben Adresse zusammen), aber zustellbar an das
 * Team, das den Fall ohnehin nachfassen muss.
 *
 * Über PHONE_LEAD_EMAIL überschreibbar; `{id}` wird ersetzt. Unterstützt das
 * Postfach kein Plus-Adressieren, hier eine eigene Sammeladresse eintragen.
 */
function placeholderEmail() {
  const id = crypto.randomBytes(4).toString('hex');
  const pattern = String(process.env.PHONE_LEAD_EMAIL || '').trim();
  if (pattern && pattern.indexOf('@') > 0) return pattern.replace('{id}', id);
  const box = String(process.env.MAIL_TO || 'info@fit-inn-trier.de').trim();
  const at = box.indexOf('@');
  if (at <= 0) return 'telefon-' + id + '@fit-inn-trier.de';
  return box.slice(0, at) + '+tel-' + id + box.slice(at);
}

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 80); }

// Geburtsdatum aus dem Gespräch: die Erkennung liefert mal „1990-05-04“, mal
// „04.05.1990“, mal „4.5.1990“. Alles drei wird zu YYYY-MM-DD.
function birthDate(v) {
  const t = clean(v, 20);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) {
    const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
    if (d) m = [null, d[3], ('0' + d[2]).slice(-2), ('0' + d[1]).slice(-2)];
  }
  if (!m) return '';
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), da = parseInt(m[3], 10);
  const now = new Date().getFullYear();
  if (!(y >= 1900 && y <= now && mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return '';
  return m[1] + '-' + m[2] + '-' + m[3];
}

// Magicline erlaubt genau diese drei Werte.
const GENDERS = { MALE: 1, FEMALE: 1, UNISEX: 1 };
function genderOf(v) {
  const t = clean(v, 12).toUpperCase();
  if (GENDERS[t]) return t;
  if (/^(M|HERR|MANN|MAENNLICH|MÄNNLICH)$/.test(t)) return 'MALE';
  if (/^(W|F|FRAU|WEIBLICH)$/.test(t)) return 'FEMALE';
  return 'UNISEX';   // nicht genannt – erlaubter Wert, keine erfundene Eigenschaft
}

// Vorname zum Ansprechen im Bestätigungssatz.
function firstWord(s) { return String(s || '').trim().split(/\s+/)[0] || ''; }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return P.json(res, 405, { ok: false, error: 'method_not_allowed' });
  const body = await P.readBody(req);
  const g = await P.guard(req, body, 20);
  if (!g.ok) return P.json(res, g.code, g.body);

  const firstname = clean(body.firstname, 60);
  const lastname = clean(body.lastname, 60);
  const phone = clean(body.phone, 40);
  const startDateTime = clean(body.startDateTime, 40);

  const missing = [];
  if (!firstname) missing.push('Vorname');
  if (!lastname) missing.push('Nachname');
  if (phone.replace(/[^\d]/g, '').length < 6) missing.push('Rufnummer');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startDateTime)) missing.push('Termin');
  // Magicline verlangt das Geburtsdatum. Es laesst sich nicht ersetzen: eine
  // erfundene Angabe koennte eine minderjaehrige Person als volljaehrig fuehren.
  const dob = birthDate(body.dateOfBirth);
  if (!dob) missing.push('Geburtsdatum');
  if (missing.length) {
    return P.json(res, 200, {
      ok: false, error: 'missing', missing: missing,
      text: 'Dafür brauche ich noch: ' + missing.join(', ') + '.',
    });
  }

  // E-Mail: die echte, wenn sie genannt wurde – sonst der Platzhalter.
  const given = clean(body.email, 120);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(given);
  const email = emailOk ? given : placeholderEmail();
  const placeholder = !emailOk;
  const emailPlaceholderUsed = placeholder;

  // Magicline deckelt die Notiz auf 300 Zeichen ("note: size must be between 0
  // and 300"). Genau daran ist die erste echte Buchung gescheitert. Fremde Limits
  // halten wir selbst ein, statt uns auf eine hilfreiche Fehlermeldung zu verlassen:
  // knapp formulieren UND am Ende hart kappen.
  const NOTE_MAX = 300;

  // Anschrift: die genannte, sonst ein erkennbarer Platzhalter. Magicline lehnt
  // ohne Anschrift (inkl. Hausnummer) ab - ausgemessen, siehe Kopfkommentar.
  const hasAddr = clean(body.street, 80) && clean(body.zip, 12) && clean(body.city, 60);
  const addrPlaceholder = !hasAddr;
  const address = hasAddr
    ? { street: clean(body.street, 80), houseNumber: clean(body.houseNumber, 20) || '-',
        zip: clean(body.zip, 12), city: clean(body.city, 60) }
    : { street: 'Telefonisch erfasst', houseNumber: '-', zip: '54296', city: 'Trier' };

  // Kurz und in der Reihenfolge der Wichtigkeit - was hinten abgeschnitten wird,
  // ist am ehesten verzichtbar.
  const flags = [];
  if (placeholder) flags.push('E-Mail');
  if (addrPlaceholder) flags.push('Anschrift');
  const note = [
    'Telefonisch per KI-Assistent gebucht.',
    'Rückruf: ' + phone + '.',
    flags.length ? ('PLATZHALTER: ' + flags.join(' + ') + ' - bitte ersetzen.') : '',
    // Eine am Telefon aufgenommene Adresse ist NIE geprüft: Spracherkennung
    // verhört sich, und ein Sprachassistent ergänzt im Zweifel selbst etwas.
    // Das Team muss sie also gegenprüfen, bevor daran etwas verschickt wird.
    placeholder ? '' : 'E-Mail ungeprüft (Telefon) - bitte bestätigen.',
    'Keine Werbeeinwilligung.',
    clean(body.note, 120),
  ].filter(Boolean).join(' ').slice(0, NOTE_MAX);

  let r = null;
  try {
    r = await C.bookTrial({
      firstname: firstname,
      lastname: lastname,
      email: email,
      phone: phone,
      gender: genderOf(body.gender),
      dateOfBirth: dob,
      street: address.street,
      houseNumber: address.houseNumber,
      zip: address.zip,
      city: address.city,
      startDateTime: startDateTime,
      trainerRequired: !!body.trainerRequired,
      marketing: false,          // am Telefon nicht nachweisbar einholbar
      note: note,
    });
  } catch (e) { r = null; }

  // Diagnose: was kam an, was sagte Magicline. Ohne Namen, Nummer, Geburtsdatum -
  // nur ob die Felder gefuellt waren.
  const spur = {
    schritt: 'book',
    ok: !!(r && r.ok),
    status: (r && r.status) || null,
    felder: {
      firstname: !!firstname, lastname: !!lastname, phone: !!phone,
      dateOfBirth: !!dob, gender: genderOf(body.gender),
      emailGenannt: !emailPlaceholderUsed, anschriftGenannt: !addrPlaceholder,
    },
    startDateTime: startDateTime,
    magicline: String((r && (r.text || (r.json && JSON.stringify(r.json)))) || '').slice(0, 300),
    empfangen: Object.keys(body || {}).filter(function (k) { return k !== 'key' && k !== 'apiKey'; }).slice(0, 20),
  };
  P.logAttempt(spur);

  if (!r || !r.ok) {
    // Ehrlich bleiben: lieber ein Rückruf als eine Bestätigung, die nicht stimmt.
    // `hint` traegt die Rueckmeldung von Magicline ins fonio-Log – ohne sie ist
    // nicht zu erkennen, WELCHES Feld fehlt.
    const detail = String((r && (r.text || (r.json && JSON.stringify(r.json)))) || '').slice(0, 300);
    return P.json(res, 200, {
      ok: false, error: 'booking_failed', status: (r && r.status) || null,
      hint: detail || 'Magicline war nicht erreichbar.',
      text: 'Die Buchung hat gerade nicht geklappt. Ich notiere den Wunsch, dann meldet sich das Team – oder Sie erreichen uns direkt unter ' + STUDIO_PHONE + '.',
    });
  }

  const when = (function () {
    try {
      const d = new Date(startDateTime);
      const p = new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long',
        hour: 'numeric', minute: '2-digit', hour12: false,
      }).formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
      const uhr = (p.minute === '00') ? (p.hour + ' Uhr') : (p.hour + ' Uhr ' + p.minute);
      return p.weekday + ', ' + p.day + '. ' + p.month + ' um ' + uhr;
    } catch (e) { return null; }
  })();

  const hallo = firstWord(firstname);
  return P.json(res, 200, {
    ok: true,
    emailPlaceholder: placeholder,
    addressPlaceholder: addrPlaceholder,
    text: 'Der Termin steht' + (when ? (': ' + when) : '') + '. '
      + (hallo ? ('Bis dahin, ' + hallo + '! ') : '')
      + (placeholder
        ? 'Eine Bestätigung per E-Mail kann ich ohne Adresse nicht schicken – das Team meldet sich noch einmal unter Ihrer Rufnummer.'
        : 'Die Bestätigung kommt gleich per E-Mail.'),
    startDateTime: startDateTime,
  });
};
