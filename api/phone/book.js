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
 * Zuschnitt hier:
 *   • Pflicht sind nur Vorname, Nachname, Rufnummer und Termin.
 *   • Fehlt die E-Mail, setzen wir einen PLATZHALTER (siehe placeholderEmail).
 *   • Alles andere wird weggelassen statt erfunden. lib/connect.js reicht
 *     gender/dateOfBirth als `undefined` durch; eine erfundene Anschrift oder
 *     ein erfundenes Geburtsdatum stünde dagegen als scheinbar echte Angabe im
 *     Kundendatensatz – das machen wir nicht.
 *   • Lehnt Magicline die Buchung ab, meldet der Endpunkt das ehrlich und
 *     verweist auf den Rückruf, statt es zu vertuschen.
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

  const note = [
    'Telefonisch über den KI-Assistenten gebucht.',
    'Rückrufnummer: ' + phone,
    placeholder
      ? 'ACHTUNG: Keine E-Mail-Adresse genannt – die hinterlegte Adresse ist ein PLATZHALTER. Bitte beim Rückruf die echte Adresse erfragen und im Datensatz ersetzen.'
      : 'E-Mail wurde am Telefon genannt – bitte auf Hörfehler prüfen.',
    'Anschrift und Geburtsdatum wurden am Telefon NICHT erhoben.',
    'Werbeeinwilligung liegt NICHT vor.',
    clean(body.note, 200),
  ].filter(Boolean).join(' | ');

  const base = {
    firstname: firstname,
    lastname: lastname,
    email: email,
    phone: phone,
    // Nur durchreichen, was tatsächlich genannt wurde – nichts erfinden.
    gender: clean(body.gender, 10) || undefined,
    dateOfBirth: /^\d{4}-\d{2}-\d{2}$/.test(clean(body.dateOfBirth, 10)) ? clean(body.dateOfBirth, 10) : undefined,
    street: clean(body.street, 80) || undefined,
    houseNumber: clean(body.houseNumber, 20) || undefined,
    zip: clean(body.zip, 12) || undefined,
    city: clean(body.city, 60) || undefined,
    startDateTime: startDateTime,
    trainerRequired: !!body.trainerRequired,
    marketing: false,          // am Telefon nicht nachweisbar einholbar
    note: note,
  };

  const attempt = async (d) => { try { return await C.bookTrial(d); } catch (e) { return null; } };

  let r = await attempt(base);

  // Verlangt Magicline eine Anschrift, scheitert der erste Versuch. Dann ein
  // ZWEITER mit einer erkennbaren Platzhalter-Anschrift – „Telefonisch erfasst“
  // liest sich für niemanden wie eine echte Adresse, blockiert aber auch nicht
  // die Buchung. Ort und Postleitzahl sind die des Studios.
  let addrPlaceholder = false;
  const noAddress = !base.street || !base.zip || !base.city;
  if ((!r || !r.ok) && noAddress) {
    addrPlaceholder = true;
    r = await attempt(Object.assign({}, base, {
      street: 'Telefonisch erfasst',
      houseNumber: '-',
      zip: '54296',
      city: 'Trier',
      note: note + ' | Anschrift ist ein PLATZHALTER (am Telefon nicht erhoben) – bitte ersetzen.',
    }));
  }

  if (!r || !r.ok) {
    // Ehrlich bleiben: lieber ein Rückruf als eine Bestätigung, die nicht stimmt.
    // `hint` traegt die Rueckmeldung von Magicline ins fonio-Log – ohne sie ist
    // nicht zu erkennen, WELCHES Feld fehlt.
    const detail = String((r && (r.text || (r.json && JSON.stringify(r.json)))) || '').slice(0, 300);
    return P.json(res, 200, {
      ok: false, error: 'booking_failed', status: (r && r.status) || null,
      hint: detail || 'Magicline war nicht erreichbar.',
      triedAddressPlaceholder: addrPlaceholder,
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
