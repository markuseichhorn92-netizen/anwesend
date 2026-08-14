'use strict';

/**
 * POST /api/phone/appointment
 *   { key, aktion: 'auskunft'|'stornieren'|'umbuchen',
 *     phone, lastname?, dateOfBirth?,      // Identitaet
 *     bookingId?, startDateTime? }         // fuer stornieren / umbuchen
 *
 * Termine eines Anrufers nachschlagen, verschieben oder absagen.
 *
 * ── Warum das heikel ist ────────────────────────────────────────────────────
 * Alle anderen Telefon-Endpunkte geben ausschliesslich oeffentliche Auskuenfte,
 * weil am Telefon niemand verifiziert ist. Hier geht es zum ersten Mal um Daten
 * einer bestimmten Person. Eine Rufnummer allein reicht dafuer NICHT: Anrufer-
 * kennungen lassen sich faelschen, und eine Nummer kennt jeder, der sie kennt.
 *
 * Deshalb ZWEI Merkmale, die zusammenpassen muessen:
 *   1. die Rufnummer (Kunde wird darueber gefunden)
 *   2. Nachname ODER Geburtsdatum (muss zum gefundenen Kunden passen)
 * Stimmt das zweite Merkmal nicht, antwortet der Endpunkt GENAUSO wie bei einer
 * unbekannten Nummer. Sonst waere er ein Orakel, mit dem sich Nachnamen zu einer
 * Rufnummer erraten liessen.
 *
 * ── Datensparsamkeit ────────────────────────────────────────────────────────
 * Zurueck gehen nur Terminart und Zeitpunkt, dazu der Vorname zur Ansprache.
 * KEINE E-Mail, keine Anschrift, keine Kundennummer, keine Vertrags- oder
 * Gesundheitsdaten - dafuer gibt es ueber die Leitung keinen Nachweis.
 *
 * ── Umbuchen ────────────────────────────────────────────────────────────────
 * Erst den neuen Termin buchen, DANN den alten absagen. Andersherum stuende der
 * Anrufer ohne Termin da, wenn der neue Slot zwischenzeitlich weg ist.
 */

const P = require('../../lib/phoneApi');
const M = require('../../lib/members');

const STUDIO_PHONE = '0651 308524';

// Eine Antwort fuer „Nummer unbekannt" UND „zweites Merkmal passt nicht".
// Bewusst identisch: der Unterschied waere sonst die Auskunft selbst.
const UNBEKANNT = {
  ok: false, error: 'not_found', termine: [],
  text: 'Dazu finde ich leider nichts. Damit ich den Termin zuordnen kann, brauche ich die Rufnummer, '
    + 'unter der gebucht wurde, und den Nachnamen. Sonst melde ich gern einen Rückruf an.',
};

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 80); }

// Namen vergleichbar machen: Gross/Klein, Umlaute, Bindestriche, Leerzeichen.
// Am Telefon kommt der Name aus einer Spracherkennung - „Müller" und „Mueller"
// sind dieselbe Person, und daran darf die Zuordnung nicht scheitern.
function normName(v) {
  return String(v == null ? '' : v).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z]/g, '');
}

// „04.05.1990“ und „1990-05-04“ sind dasselbe Datum.
function normDob(v) {
  const t = clean(v, 20);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) {
    const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
    if (d) m = [null, d[3], ('0' + d[2]).slice(-2), ('0' + d[1]).slice(-2)];
  }
  return m ? (m[1] + '-' + m[2] + '-' + m[3]) : '';
}

// Stornierte Buchungen liefert Magicline weiter mit - nur mit anderem Status.
// Feldnamen unterscheiden sich je nach API-Version, deshalb alle Varianten.
function isCancelled(a) {
  if (!a) return true;
  if (a.cancelled === true || a.canceled === true || a.deleted === true) return true;
  if (a.active === false) return true;
  const s = [a.status, a.appointmentStatus, a.bookingStatus, a.state]
    .filter(Boolean).join(' ').toUpperCase();
  return /CANCEL|STORN|DELET|ABGESAGT|ABGELEHNT|NO_?SHOW|DECLIN/.test(s);
}

function sprechDatum(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long',
    hour: 'numeric', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
  const uhr = (p.minute === '00') ? (p.hour + ' Uhr') : (p.hour + ' Uhr ' + p.minute);
  return p.weekday + ', ' + p.day + '. ' + p.month + ' um ' + uhr;
}

// Kommende Termine des Kunden, aufsteigend. Vergangenes interessiert am Telefon
// niemanden und waere nur zusaetzliche Preisgabe.
async function kommendeTermine(customerId) {
  let r = null;
  try { r = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(customerId)); }
  catch (e) { return null; }
  if (!r || r.status !== 200 || !Array.isArray(r.json)) return null;
  const jetzt = Date.now();
  return r.json
    .filter(function (a) { return !isCancelled(a); })
    .map(function (a) {
      return {
        bookingId: a.bookingId != null ? String(a.bookingId) : null,
        title: clean(a.title || a.name, 60) || 'Termin',
        start: a.startDateTime || null,
        end: a.endDateTime || null,
        // Fuer das Umbuchen: dieselbe Terminart wieder buchen.
        bookableAppointmentId: a.bookableAppointmentId != null ? String(a.bookableAppointmentId)
          : (a.appointmentId != null ? String(a.appointmentId) : null),
      };
    })
    .filter(function (a) { const t = Date.parse(a.start); return a.start && !isNaN(t) && t > jetzt; })
    .sort(function (x, y) { return Date.parse(x.start) - Date.parse(y.start); });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return P.json(res, 405, { ok: false, error: 'method_not_allowed' });
  const body = await P.readBody(req);
  // Enger gedeckelt als die Auskunft: hier liesse sich sonst ein zweites Merkmal
  // durchprobieren.
  const g = await P.guard(req, body, 20);
  if (!g.ok) return P.json(res, g.code, g.body);

  const aktion = clean(body.aktion || body.action, 20).toLowerCase();
  const phone = clean(body.phone, 40);
  const lastname = clean(body.lastname, 60);
  const dob = normDob(body.dateOfBirth);

  if (phone.replace(/[^\d]/g, '').length < 6) {
    return P.json(res, 200, { ok: false, error: 'missing',
      text: 'Dafür brauche ich die Rufnummer, unter der der Termin gebucht wurde.' });
  }
  if (!lastname && !dob) {
    return P.json(res, 200, { ok: false, error: 'missing_factor',
      text: 'Zur Sicherheit brauche ich dazu noch den Nachnamen oder das Geburtsdatum.' });
  }

  // Zweites Merkmal duerfte man sonst durchprobieren - also hart begrenzen,
  // zusaetzlich zur Begrenzung pro IP im Torwaechter.
  try {
    const okR = await M.rateLimit('phoneappt:' + M.normDePhone(phone), 8, 900);
    if (okR === false) return P.json(res, 200, { ok: false, error: 'rate_limited',
      text: 'Das hat gerade nicht geklappt. Bitte melden Sie sich direkt unter ' + STUDIO_PHONE + '.' });
  } catch (e) { /* Begrenzung darf den Anruf nicht verhindern */ }

  // Die Nummernsuche fragt mehrere Schreibweisen nacheinander ab und laedt im
  // Zweifel Profile nach - das kann dauern. fonio bricht nach 5 Sekunden ab, und
  // ein abgebrochener Aufruf ist im Gespraech das Schlimmste: der Assistent haengt
  // und denkt sich dann etwas aus. Lieber ehrlich einen Rueckruf anbieten.
  let kunde = null, langsam = false;
  try {
    kunde = await Promise.race([
      M.findByPhone(phone).catch(function () { return null; }),
      new Promise(function (r) { setTimeout(function () { langsam = true; r(null); }, 3500); }),
    ]);
  } catch (e) { kunde = null; }
  if (langsam && !kunde) {
    P.logAttempt({ schritt: 'appointment', aktion: aktion || 'auskunft', ok: false, status: 'suche_zu_langsam' });
    return P.json(res, 200, { ok: false, error: 'timeout',
      text: 'Das dauert mir gerade zu lange. Ich notiere einen Rückruf, dann meldet sich das Team – '
        + 'oder Sie erreichen uns direkt unter ' + STUDIO_PHONE + '.' });
  }

  // Zweites Merkmal pruefen. Passt es nicht, ist die Antwort dieselbe wie bei
  // einer unbekannten Nummer - siehe Kopfkommentar.
  let passt = false;
  if (kunde) {
    const nameOk = !!lastname && normName(kunde.lastName || kunde.lastname) === normName(lastname);
    const dobOk = !!dob && String(kunde.dateOfBirth || '').slice(0, 10) === dob;
    passt = nameOk || dobOk;
  }
  if (!kunde || !passt) {
    P.logAttempt({ schritt: 'appointment', aktion: aktion || 'auskunft', ok: false,
      status: kunde ? 'merkmal_passt_nicht' : 'nummer_unbekannt' });
    return P.json(res, 200, UNBEKANNT);
  }

  const vorname = clean(kunde.firstName || kunde.firstname, 40);
  const termine = await kommendeTermine(kunde.id != null ? kunde.id : kunde.customerId);
  if (termine === null) {
    return P.json(res, 200, { ok: false, error: 'unavailable',
      text: 'Die Termine kann ich gerade nicht abrufen. Ich notiere gern einen Rückruf, dann meldet sich das Team.' });
  }

  const alsAntwort = termine.slice(0, 5).map(function (t) {
    return { bookingId: t.bookingId, titel: t.title, startDateTime: t.start, gesprochen: sprechDatum(t.start) };
  });

  // ── Auskunft ───────────────────────────────────────────────────────────────
  if (!aktion || aktion === 'auskunft' || aktion === 'info' || aktion === 'abrufen') {
    let text;
    if (!alsAntwort.length) {
      text = (vorname ? ('Hallo ' + vorname + '. ') : '') + 'Ich sehe aktuell keinen kommenden Termin. Soll ich einen buchen?';
    } else if (alsAntwort.length === 1) {
      text = (vorname ? ('Hallo ' + vorname + '. ') : '') + 'Ihr Termin: '
        + alsAntwort[0].titel + ' am ' + alsAntwort[0].gesprochen + '.';
    } else {
      text = (vorname ? ('Hallo ' + vorname + '. ') : '') + 'Sie haben ' + alsAntwort.length + ' Termine: '
        + alsAntwort.map(function (t) { return t.titel + ' am ' + t.gesprochen; }).join(', ') + '.';
    }
    P.logAttempt({ schritt: 'appointment', aktion: 'auskunft', ok: true, anzahl: alsAntwort.length });
    return P.json(res, 200, { ok: true, termine: alsAntwort, text: text,
      naechsterSchritt: 'Zum Absagen oder Verschieben diese Aktion erneut aufrufen - mit aktion=stornieren '
        + 'bzw. aktion=umbuchen und der bookingId aus dieser Antwort.' });
  }

  // Ab hier wird etwas veraendert - also muss klar sein, WELCHER Termin gemeint ist.
  if (!alsAntwort.length) {
    return P.json(res, 200, { ok: false, error: 'no_appointment', termine: [],
      text: 'Ich sehe keinen kommenden Termin, den ich ändern könnte.' });
  }
  const wunschId = clean(body.bookingId, 60);
  const treffer = wunschId
    ? termine.filter(function (t) { return String(t.bookingId) === wunschId; })[0]
    : (termine.length === 1 ? termine[0] : null);
  if (!treffer) {
    return P.json(res, 200, { ok: false, error: 'ambiguous', termine: alsAntwort,
      text: 'Sie haben mehrere Termine. Welchen meinen Sie: '
        + alsAntwort.map(function (t) { return t.gesprochen; }).join(', ') + '?',
      naechsterSchritt: 'Erneut aufrufen und die bookingId des gemeinten Termins mitgeben.' });
  }

  // ── Stornieren ─────────────────────────────────────────────────────────────
  if (aktion === 'stornieren' || aktion === 'absagen' || aktion === 'storno' || aktion === 'cancel') {
    let r = null;
    try { r = await M.ml('DELETE', '/appointments/booking/' + encodeURIComponent(treffer.bookingId)); }
    catch (e) { r = null; }
    const ok = !!(r && r.status >= 200 && r.status < 300);
    P.logAttempt({ schritt: 'appointment', aktion: 'stornieren', ok: ok, status: (r && r.status) || null });
    return P.json(res, 200, {
      ok: ok, bookingId: treffer.bookingId,
      text: ok
        ? ('Der Termin am ' + sprechDatum(treffer.start) + ' ist abgesagt. Möchten Sie gleich einen neuen?')
        : ('Das Absagen hat gerade nicht geklappt. Bitte melden Sie sich kurz unter ' + STUDIO_PHONE + ', dann erledigt das Team das sofort.'),
    });
  }

  // ── Umbuchen ───────────────────────────────────────────────────────────────
  if (aktion === 'umbuchen' || aktion === 'verschieben' || aktion === 'aendern' || aktion === 'ändern') {
    const neu = clean(body.startDateTime, 40);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(neu)) {
      return P.json(res, 200, { ok: false, error: 'missing_start', termine: alsAntwort,
        text: 'Auf wann soll ich den Termin verschieben?',
        naechsterSchritt: 'Zuerst /api/phone/slots aufrufen und einen startDateTime-Wert UNVERAENDERT von dort uebernehmen.' });
    }
    if (!treffer.bookableAppointmentId) {
      // Ohne Terminart koennen wir nicht neu buchen. Dann NICHT den alten Termin
      // absagen - lieber bleibt er stehen und das Team verschiebt ihn.
      return P.json(res, 200, { ok: false, error: 'reschedule_unsupported', termine: alsAntwort,
        text: 'Diesen Termin kann ich am Telefon nicht selbst verschieben. Ich notiere den Wunsch, das Team meldet sich – '
          + 'oder Sie erreichen uns direkt unter ' + STUDIO_PHONE + '.' });
    }

    // Reihenfolge ist entscheidend: ERST den neuen Termin sichern.
    const dauer = (Date.parse(treffer.end) - Date.parse(treffer.start)) || 3600000;
    const ende = new Date(Date.parse(neu) + dauer).toISOString();
    let b = null;
    try {
      b = await M.ml('POST', '/appointments/booking/book', {
        customerId: Number(kunde.id != null ? kunde.id : kunde.customerId),
        bookableAppointmentId: Number(treffer.bookableAppointmentId),
        startDateTime: neu,
        endDateTime: ende,
      });
    } catch (e) { b = null; }
    const gebucht = !!(b && b.status >= 200 && b.status < 300);
    if (!gebucht) {
      P.logAttempt({ schritt: 'appointment', aktion: 'umbuchen', ok: false, status: (b && b.status) || null,
        magicline: String((b && (b.text || (b.json && JSON.stringify(b.json)))) || '').slice(0, 200) });
      return P.json(res, 200, { ok: false, error: 'new_slot_failed', termine: alsAntwort,
        text: 'Der neue Zeitpunkt ist leider nicht buchbar. Ihr bisheriger Termin am '
          + sprechDatum(treffer.start) + ' bleibt bestehen. Soll ich nach anderen Zeiten schauen?' });
    }

    // Neuer Termin steht - jetzt erst den alten weg. Scheitert das, hat der
    // Anrufer zwei Termine. Das ist unschoen, aber besser als gar keiner, und
    // das Team sieht es im Kalender.
    let d = null;
    try { d = await M.ml('DELETE', '/appointments/booking/' + encodeURIComponent(treffer.bookingId)); }
    catch (e) { d = null; }
    const altWeg = !!(d && d.status >= 200 && d.status < 300);
    P.logAttempt({ schritt: 'appointment', aktion: 'umbuchen', ok: true, status: (b && b.status) || null,
      magicline: altWeg ? 'alter Termin storniert' : 'alter Termin NICHT storniert - Team pruefen' });
    return P.json(res, 200, {
      ok: true, altStorniert: altWeg, startDateTime: neu,
      text: 'Der Termin ist jetzt am ' + sprechDatum(neu) + '.'
        + (altWeg ? '' : ' Den alten Termin nimmt das Team noch heraus – gebucht sind Sie in jedem Fall.'),
    });
  }

  return P.json(res, 200, { ok: false, error: 'unknown_action', termine: alsAntwort,
    text: 'Das habe ich nicht verstanden. Ich kann den Termin nennen, absagen oder verschieben.' });
};
