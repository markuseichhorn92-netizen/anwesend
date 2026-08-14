'use strict';

/**
 * POST /api/phone/appointment
 *   { key, aktion: 'arten'|'auskunft'|'termine'|'buchen'|'stornieren'|'umbuchen',
 *     phone, lastname?, dateOfBirth?,      // Identitaet
 *     bookingId?, startDateTime?,          // fuer stornieren / umbuchen
 *     art?, datum?, wochentag?, woche?, tageszeit? }   // fuer termine / buchen
 *
 * Termine eines Anrufers nachschlagen, buchen, verschieben oder absagen.
 *
 * Neben dem Probetraining (das laeuft ueber /api/phone/book und die oeffentliche
 * Connect-API) gibt es die buchbaren Terminarten des Studios: Stoffwechsel-
 * beratung, Einweisung, Trainingsplanung. Die gehoeren einem BESTEHENDEN Kunden
 * und laufen ueber die authentifizierte Open API - ohne Zuordnung geht nichts.
 * Deshalb stehen sie hier, hinter der Identitaetspruefung, und nicht in /slots.
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
const Leads = require('../../lib/leadflow');
const B = require('../../lib/bookable');

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

// Ortszeit-Stunde. Die Slots kommen in UTC - „nachmittags" waere sonst verschoben.
function berlinStunde(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return -1;
  return parseInt(new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false,
  }).format(d), 10);
}

// Dieselben Grenzen wie in /api/phone/slots - „nachmittags" muss ueberall
// dasselbe bedeuten, sonst widerspricht sich der Assistent im selben Gespraech.
function tageszeit(v) {
  const t = String(v == null ? '' : v).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ü/g, 'ue').replace(/[^a-z]/g, '');
  if (!t) return null;
  if (t.indexOf('nachmittag') >= 0) return { name: 'nachmittag', test: function (h) { return h >= 12 && h < 17; } };
  if (t.indexOf('vormittag') >= 0 || t.indexOf('morgens') >= 0) return { name: 'vormittag', test: function (h) { return h < 12; } };
  if (t.indexOf('abend') >= 0 || t.indexOf('spaet') >= 0) return { name: 'abend', test: function (h) { return h >= 17; } };
  if (t.indexOf('mittag') >= 0) return { name: 'mittag', test: function (h) { return h >= 11 && h < 14; } };
  return null;
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

  // ── Welche Termine gibt es ueberhaupt? ─────────────────────────────────────
  // Die einzige Aktion ohne Identitaet: „Was bietet ihr an?" ist eine
  // oeffentliche Auskunft. Jemanden dafuer erst seinen Nachnamen buchstabieren
  // zu lassen, waere unsinnig.
  if (aktion === 'arten' || aktion === 'terminarten' || aktion === 'angebot') {
    const arten = await B.listTypes();
    if (!arten.length) {
      return P.json(res, 200, { ok: false, error: 'unavailable',
        text: 'Die Terminarten kann ich gerade nicht abrufen. Ich notiere gern einen Rückruf.' });
    }
    const namen = arten.map(function (t) { return t.title; });
    return P.json(res, 200, {
      ok: true,
      arten: arten.map(function (t) {
        return { titel: t.title, dauer: t.duration ? (t.duration + ' Minuten') : null, id: t.id };
      }),
      text: 'Buchbar sind: ' + (namen.length > 1
        ? (namen.slice(0, -1).join(', ') + ' und ' + namen[namen.length - 1]) : namen[0]) + '.',
      naechsterSchritt: 'Fuer freie Zeiten diese Aktion mit aktion=termine und art=<Name> aufrufen. '
        + 'Dafuer werden Rufnummer und Nachname bzw. Geburtsdatum gebraucht, weil der Termin '
        + 'einem bestehenden Kunden gehoert.',
    });
  }

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

  // ── Wer ruft an? ───────────────────────────────────────────────────────────
  // Gebucht wird ueber ganz verschiedene Wege: am Telefon, ueber die Website,
  // vom Team, oder direkt in Magicline. Wer danach anruft und absagen will, nennt
  // nur seine Rufnummer. Also drei Wege, vom schnellsten und sichersten zum
  // langsamsten - der erste Treffer gewinnt.
  let kunde = null, langsam = false, quelle = null;

  // 1. Eigener Merker aus einer Buchung ueber uns (Telefon oder Website).
  //    Ein Probetraining legt in Magicline einen LEAD an, und die Kundensuche
  //    findet vor allem Mitglieder - genau deshalb blieb der Termin bisher
  //    unauffindbar. Beim Buchen kannten wir die Zuordnung dagegen sicher.
  const merker = await P.lookupLead(phone);
  if (merker && merker.customerId) {
    try { kunde = await M.getMember(merker.customerId); } catch (e) { kunde = null; }
    if (kunde) quelle = 'merker';
  }

  // 2. Der Interessenten-Bestand. Er wird ueber die Magicline-Webhooks gefuellt,
  //    also auch fuer Buchungen, die NIE ueber uns liefen. Ein Lesezugriff.
  if (!kunde) {
    let lead = null;
    try { lead = await Leads.getLeadByPhone(phone); } catch (e) { lead = null; }
    if (lead && lead.customerId) {
      try { kunde = await M.getMember(lead.customerId); } catch (e) { kunde = null; }
      if (kunde) quelle = 'lead';
    }
  }

  // 3. Magiclines Kundensuche - fuer alle, die laengst Mitglied sind. Sie fragt
  //    mehrere Schreibweisen nacheinander ab und laedt im Zweifel Profile nach,
  //    kann also dauern. fonio bricht nach 5 Sekunden ab, und ein abgebrochener
  //    Aufruf ist im Gespraech das Schlimmste: der Assistent haengt und denkt
  //    sich dann etwas aus.
  if (!kunde) {
    try {
      kunde = await Promise.race([
        M.findByPhone(phone).catch(function () { return null; }),
        new Promise(function (r) { setTimeout(function () { langsam = true; r(null); }, 3500); }),
      ]);
    } catch (e) { kunde = null; }
    if (kunde) quelle = 'suche';
  }
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
    // Die Spur unterscheidet die drei Faelle, die im Gespraech gleich klingen:
    // Nummer nicht gefunden, Merkmal passt nicht, oder gar kein Merker vorhanden.
    // Ohne das ist nach einem gescheiterten Anruf nicht zu sagen, WORAN es lag.
    P.logAttempt({ schritt: 'appointment', aktion: aktion || 'auskunft', ok: false,
      status: kunde ? 'merkmal_passt_nicht' : 'nummer_unbekannt',
      quelle: quelle, merker: !!(merker && merker.customerId) });
    return P.json(res, 200, UNBEKANNT);
  }

  const vorname = clean(kunde.firstName || kunde.firstname, 40);
  const kundeId = kunde.id != null ? kunde.id : kunde.customerId;

  // ── Freie Zeiten und Buchen einer Terminart ────────────────────────────────
  // Stoffwechselberatung, Einweisung, Trainingsplanung … Anders als beim
  // Probetraining gehoert so ein Termin einem bestehenden Kunden - deshalb
  // steht das hier, hinter der Identitaetspruefung, und nicht in /slots.
  const willTermine = (aktion === 'termine' || aktion === 'zeiten' || aktion === 'freie');
  const willBuchen = (aktion === 'buchen' || aktion === 'neu' || aktion === 'vereinbaren');
  if (willTermine || willBuchen) {
    const arten = await B.listTypes();
    const m = B.matchType(arten, body.art || body.terminart || body.titel);
    if (!m.type) {
      // Lieber nachfragen als die falsche Terminart buchen.
      const namen = (m.kandidaten.length ? m.kandidaten : arten).map(function (t) { return t.title; });
      return P.json(res, 200, {
        ok: false, error: 'art_unklar',
        arten: namen,
        text: namen.length
          ? ('Welchen Termin möchten Sie: ' + (namen.length > 1
              ? (namen.slice(0, -1).join(', ') + ' oder ' + namen[namen.length - 1]) : namen[0]) + '?')
          : 'Ich kann gerade nicht sehen, welche Termine buchbar sind. Ich notiere gern einen Rückruf.',
        naechsterSchritt: 'Erneut aufrufen und art auf einen dieser Namen setzen - unveraendert uebernehmen.',
      });
    }

    const w = P.slotWindow({
      datum: body.datum, ab: body.ab, tage: body.tage,
      wochentag: body.wochentag, woche: body.woche,
    }, Date.now());
    const frei = await B.freeSlots(m.type.id, kundeId, w.start, 21);
    if (!frei.length) {
      return P.json(res, 200, { ok: false, error: 'keine_zeiten', terminart: m.type.title,
        text: 'Für ' + m.type.title + ' sehe ich in den nächsten Wochen leider keinen freien Termin. '
          + 'Ich notiere gern einen Rückruf, dann meldet sich das Team.' });
    }

    // Wunschtag/Tageszeit nur als Filter - nie als Grund fuer eine leere Antwort.
    const starts = frei.map(function (s) { return s.start; });
    const amTag = w.exactDay ? frei.filter(function (s) { return s.start.slice(0, 10) === w.exactDay; }) : frei;
    const tz = tageszeit(body.tageszeit);
    const passend = tz ? amTag.filter(function (s) { return tz.test(berlinStunde(s.start)); }) : amTag;
    const zeige = (passend.length ? passend : (amTag.length ? amTag : frei)).slice(0, 5);

    // ── Nur nach Zeiten gefragt ──
    if (willTermine) {
      const gesprochen = zeige.map(function (s) { return sprechDatum(s.start); }).filter(Boolean);
      return P.json(res, 200, {
        ok: true, terminart: m.type.title, terminartId: m.type.id,
        termine: zeige.map(function (s) {
          return { gesprochen: sprechDatum(s.start), startDateTime: s.start, trainer: s.instructor || null };
        }),
        hinweis: P.UTC_HINWEIS,
        text: 'Für ' + m.type.title + ' wäre frei: ' + (gesprochen.length > 1
          ? (gesprochen.slice(0, -1).join(', ') + ' oder ' + gesprochen[gesprochen.length - 1]) : gesprochen[0]) + '.',
        naechsterSchritt: 'Zum Buchen diese Aktion erneut mit aktion=buchen, derselben art und '
          + 'startDateTime UNVERAENDERT aus dieser Antwort aufrufen. Endzeit und Trainer ergaenzt der Server.',
      });
    }

    // ── Buchen ──
    let gewuenscht = clean(body.startDateTime, 40);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(gewuenscht)) {
      return P.json(res, 200, { ok: false, error: 'missing_start', terminart: m.type.title,
        text: 'Wann soll der Termin sein?',
        naechsterSchritt: 'Zuerst dieselbe Aktion mit aktion=termine aufrufen und startDateTime von dort uebernehmen.' });
    }
    // Dieselbe Falle wie beim Probetraining: gesprochene Ortszeit als UTC.
    if (starts.indexOf(gewuenscht) < 0) {
      const rep = P.fixLocalAsUtc(gewuenscht, starts);
      if (rep) {
        P.logAttempt({ schritt: 'appointment', aktion: 'buchen', ok: true, status: 'ortszeit_korrigiert' });
        gewuenscht = rep;
      }
    }
    const slot = frei.filter(function (s) { return s.start === gewuenscht; })[0];
    if (!slot) {
      const alt = zeige.map(function (s) { return sprechDatum(s.start); }).filter(Boolean).slice(0, 3);
      P.logAttempt({ schritt: 'appointment', aktion: 'buchen', ok: false, status: 'slot_ungueltig' });
      return P.json(res, 200, { ok: false, error: 'slot_unavailable', terminart: m.type.title,
        freieSlots: zeige.map(function (s) { return { gesprochen: sprechDatum(s.start), startDateTime: s.start }; }),
        hinweis: P.UTC_HINWEIS,
        text: 'Dieser Termin ist leider nicht buchbar. Frei wäre: ' + alt.join(', ') + '. Welcher passt?' });
    }

    const r = await B.book(kundeId, m.type.id, slot);
    P.logAttempt({ schritt: 'appointment', aktion: 'buchen', ok: r.ok, status: r.status,
      quelle: quelle, magicline: r.ok ? null : r.text });
    if (!r.ok) {
      return P.json(res, 200, { ok: false, error: 'booking_failed', terminart: m.type.title, hint: r.text,
        text: 'Die Buchung hat gerade nicht geklappt. Ich notiere den Wunsch, dann meldet sich das Team – '
          + 'oder Sie erreichen uns direkt unter ' + STUDIO_PHONE + '.' });
    }
    // Manche Terminarten muessen vom Studio noch bestaetigt werden. Das gehoert
    // in den Satz - sonst haelt der Anrufer einen Vorschlag fuer eine Zusage.
    const offen = r.bookingStatus === 'BOOKED_WITH_CONFIRMATION_REQUIRED';
    return P.json(res, 200, {
      ok: true, terminart: m.type.title, startDateTime: slot.start, status: r.bookingStatus,
      text: offen
        ? (m.type.title + ' am ' + sprechDatum(slot.start) + ' ist eingetragen – das Team bestätigt den Termin noch.')
        : (m.type.title + ' am ' + sprechDatum(slot.start) + ' ist gebucht.'
           + (slot.instructor ? (' Betreut wird der Termin von ' + slot.instructor + '.') : '')),
    });
  }

  const termine = await kommendeTermine(kundeId);
  if (termine === null) {
    return P.json(res, 200, { ok: false, error: 'unavailable',
      text: 'Die Termine kann ich gerade nicht abrufen. Ich notiere gern einen Rückruf, dann meldet sich das Team.' });
  }

  const alsAntwort = termine.slice(0, 5).map(function (t) {
    return { gesprochen: sprechDatum(t.start), titel: t.title, bookingId: t.bookingId, startDateTime: t.start };
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
    P.logAttempt({ schritt: 'appointment', aktion: 'auskunft', ok: true,
      anzahl: alsAntwort.length, quelle: quelle });
    return P.json(res, 200, { ok: true, termine: alsAntwort, text: text, hinweis: P.UTC_HINWEIS,
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
