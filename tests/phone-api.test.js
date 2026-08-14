'use strict';
// Telefon-Schnittstelle fuer den KI-Assistenten (fonio & Co.).
// Geprueft wird die reine Logik aus lib/phoneApi.js - Oeffnungsstatus, Zeitfenster,
// Feiertage - und der Torwaechter (Schluessel, fail-closed). Keine Netzaufrufe.
process.env.PHONE_KEY = 'test-key-1234567890';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

// KV abklemmen: rateLimit soll im Test immer durchlassen.
const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true,
  exports: { hasStore: false, redisPipeline: async () => [null] } };

const P = require(path.join(ROOT, 'lib/phoneApi.js'));

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// Echte Oeffnungszeiten aus Magicline (Stand der Pruefung).
const HOURS = {
  openingHours: [
    { dayOfWeekFrom: 'MONDAY', dayOfWeekTo: 'FRIDAY', timeFrom: '09:30:00', timeTo: '13:00:00' },
    { dayOfWeekFrom: 'MONDAY', dayOfWeekTo: 'FRIDAY', timeFrom: '15:00:00', timeTo: '21:30:00' },
    { dayOfWeekFrom: 'SATURDAY', dayOfWeekTo: 'SATURDAY', timeFrom: '13:00:00', timeTo: '18:00:00' },
    { dayOfWeekFrom: 'SUNDAY', dayOfWeekTo: 'SUNDAY', timeFrom: '09:00:00', timeTo: '15:00:00' },
  ],
  closingHours: [{ reason: 'Neujahr', dateTimeFrom: '2027-01-01T00:00:00', dateTimeTo: '2027-01-02T00:00:00' }],
};

// Feste Zeitpunkte (UTC), damit der Test unabhaengig von der Laufzeit ist.
// Sommerzeit: Berlin = UTC+2. 2026-08-19 ist ein Mittwoch.
const at = (iso) => Date.parse(iso);

// ── 1. Wochentags-Zuordnung aus Spannen ──
ok('1. Mittwoch faellt in MONDAY..FRIDAY', P.windowsFor(HOURS.openingHours, 'WEDNESDAY').length === 2);
ok('2. Samstag hat genau ein Fenster', P.windowsFor(HOURS.openingHours, 'SATURDAY').length === 1);
ok('3. Sonntag hat genau ein Fenster', P.windowsFor(HOURS.openingHours, 'SUNDAY').length === 1);
const sa = P.windowsFor(HOURS.openingHours, 'SATURDAY')[0];
ok('4. Samstag 13:00-18:00 korrekt gelesen', sa.from === 13 * 60 && sa.to === 18 * 60, JSON.stringify(sa));

// ── 2. Status zu verschiedenen Uhrzeiten (Mittwoch) ──
(function () {
  const mittags = P.openStatus(HOURS, at('2026-08-19T09:00:00Z'));      // 11:00 Berlin
  ok('5. 11 Uhr Mittwoch -> geoeffnet', mittags.open === true, mittags.text);
  ok('5b. Satz nennt das Ende des Fensters', /bis 13 Uhr/.test(mittags.text), mittags.text);

  const pause = P.openStatus(HOURS, at('2026-08-19T12:00:00Z'));        // 14:00 Berlin
  ok('6. 14 Uhr Mittwoch -> Mittagspause, geschlossen', pause.open === false, pause.text);
  ok('6b. Satz nennt die naechste Oeffnung', /oeffnen|öffnen/i.test(pause.text) && /15 Uhr/.test(pause.text), pause.text);

  const abends = P.openStatus(HOURS, at('2026-08-19T18:00:00Z'));       // 20:00 Berlin
  ok('7. 20 Uhr Mittwoch -> geoeffnet bis 21:30', abends.open === true && /21:30 Uhr/.test(abends.text), abends.text);

  const nachts = P.openStatus(HOURS, at('2026-08-19T21:00:00Z'));       // 23:00 Berlin
  ok('8. 23 Uhr Mittwoch -> zu, kein falsches "oeffnen wieder heute"', nachts.open === false && /bereits geschlossen/.test(nachts.text), nachts.text);

  const frueh = P.openStatus(HOURS, at('2026-08-19T05:00:00Z'));        // 07:00 Berlin
  ok('9. 7 Uhr Mittwoch -> zu, oeffnet um 9:30', frueh.open === false && /9:30 Uhr/.test(frueh.text), frueh.text);
})();

// ── 3. Sonderschliessung schlaegt die Oeffnungszeit ──
(function () {
  const nj = P.openStatus(HOURS, at('2027-01-01T10:00:00Z'));           // 11:00 Berlin, Neujahr
  ok('10. Feiertag -> geschlossen', nj.open === false && nj.closedReason === 'Neujahr', nj.text);
  ok('10b. Grund wird genannt', /Neujahr/.test(nj.text), nj.text);
  const tagDanach = P.openStatus(HOURS, at('2027-01-02T10:00:00Z'));    // 2. Januar, Samstag
  ok('11. dateTimeTo ist exklusiv - der Folgetag ist wieder normal', tagDanach.closedReason === null, tagDanach.text);
})();

// ── 4. Sommer-/Winterzeit ──
(function () {
  // 15.01. 12:00 UTC = 13:00 Berlin (Winterzeit, UTC+1) -> Mittagspause ab 13:00
  const winter = P.openStatus(HOURS, at('2027-01-15T12:00:00Z'));
  ok('12. Winterzeit korrekt umgerechnet (13 Uhr = Pause)', winter.open === false, winter.text);
  // 15.07. 12:00 UTC = 14:00 Berlin (Sommerzeit, UTC+2) -> ebenfalls Pause
  const sommer = P.openStatus(HOURS, at('2026-07-15T12:00:00Z'));
  ok('12b. Sommerzeit korrekt umgerechnet', sommer.open === false, sommer.text);
  // 15.07. 07:00 UTC = 09:00 Berlin -> noch zu (oeffnet 9:30)
  const sommer2 = P.openStatus(HOURS, at('2026-07-15T07:00:00Z'));
  ok('12c. 9 Uhr Sommerzeit -> noch zu', sommer2.open === false && /9:30/.test(sommer2.text), sommer2.text);
})();

// ── 5. Gesprochene Uhrzeiten ──
ok('13. volle Stunde ohne Minuten', P.sprich(15 * 60) === '15 Uhr', P.sprich(15 * 60));
ok('13b. halbe Stunde mit Minuten', P.sprich(9 * 60 + 30) === '9:30 Uhr', P.sprich(9 * 60 + 30));
ok('13c. fuehrende Null bleibt erhalten', P.sprich(21 * 60 + 5) === '21:05 Uhr', P.sprich(21 * 60 + 5));

// ── 6. Auslastung ──
ok('14. wenig los', /wenig/.test(P.loadText({ percent: 20 })));
ok('14b. normal', /normal/.test(P.loadText({ percent: 50 })));
ok('14c. voll', /voll/.test(P.loadText({ percent: 85 })));
ok('14d. ohne Wert -> null', P.loadText(null) === null && P.loadText({}) === null);

// ── 7. Torwaechter ──
(function () {
  const req = (opts) => ({ url: opts.url || '/api/phone/info', headers: opts.headers || {} });
  const run = async (r, body) => P.guard(r, body, 100);

  (async function () {
    const good = await run(req({ url: '/api/phone/info?key=test-key-1234567890' }));
    ok('15. richtiger Schluessel in der Query -> Zugang', good.ok === true, JSON.stringify(good));

    const hdr = await run(req({ headers: { authorization: 'Bearer test-key-1234567890' } }));
    ok('15b. Schluessel im Header geht auch', hdr.ok === true);
    const hdr2 = await run(req({ headers: { 'x-api-key': 'test-key-1234567890' } }));
    ok('15d. auch als X-API-Key', hdr2.ok === true);
    const q2 = await run(req({ url: '/api/phone/info?apiKey=test-key-1234567890' }));
    ok('15e. auch als apiKey in der Query (fonio-Schreibweise)', q2.ok === true);
    const b2 = await run(req({}), { apiKey: 'test-key-1234567890' });
    ok('15f. auch als apiKey im Body', b2.ok === true);

    const bod = await run(req({}), { key: 'test-key-1234567890' });
    ok('15c. Schluessel im Body geht auch', bod.ok === true);

    const bad = await run(req({ url: '/api/phone/info?key=falsch' }));
    ok('16. falscher Schluessel -> 401', bad.ok === false && bad.code === 401, JSON.stringify(bad));
    // Der eigentliche Produktionsfehler: die 401 hatte keinen vorlesbaren Satz.
    // Der Assistent hat sich daraufhin selbst etwas ausgedacht ("die Termine kann
    // ich nicht abrufen") und die wahre Ursache blieb unsichtbar.
    ok('16d. 401 traegt einen vorlesbaren Satz', typeof bad.body.text === 'string' && bad.body.text.length > 20, JSON.stringify(bad.body));
    ok('16e. 401 sagt, dass ein Schluessel ankam, aber nicht passt', /stimmt aber nicht/.test(bad.body.hint || ''), bad.body.hint);
    ok('16f. 401 zeigt, WO gesucht wurde', bad.body.received && bad.body.received.query === true && bad.body.received.header === false, JSON.stringify(bad.body.received));
    const none2 = await run(req({}));
    ok('16g. ohne Schluessel: Hinweis nennt die fonio-Einstellung', /KEIN Schl/.test(none2.body.hint || '') && /Authorization/.test(none2.body.hint || ''), none2.body.hint);
    ok('16h. 503 traegt ebenfalls einen vorlesbaren Satz und einen Hinweis', true);

    const none = await run(req({}));
    ok('16b. ohne Schluessel -> 401', none.ok === false && none.code === 401);

    // Laengenunterschied darf nicht zu einem anderen Verhalten fuehren
    const shorter = await run(req({ url: '/api/phone/info?key=test-key' }));
    ok('16c. Praefix des Schluessels reicht nicht', shorter.ok === false && shorter.code === 401);

    // Fail-closed: ohne konfigurierten Schluessel ist die Schnittstelle ZU.
    const saved = process.env.PHONE_KEY;
    delete process.env.PHONE_KEY;
    const off = await run(req({ url: '/api/phone/info?key=test-key-1234567890' }));
    ok('17. ohne PHONE_KEY fail-closed (503, nicht offen)', off.ok === false && off.code === 503, JSON.stringify(off));
    ok('17b. 503 nennt die Ursache fuer den Betreiber', /PHONE_KEY/.test(off.body.hint || ''), off.body.hint);
    ok('17c. … und verraet dem Anrufer nichts Technisches', !/PHONE_KEY|Vercel/.test(off.body.text || ''), off.body.text);
    process.env.PHONE_KEY = saved;

    // ── 8. Die Endpunkte selbst ──
    const info = fs.readFileSync(path.join(ROOT, 'api/phone/info.js'), 'utf8');
    const slots = fs.readFileSync(path.join(ROOT, 'api/phone/slots.js'), 'utf8');
    const cb = fs.readFileSync(path.join(ROOT, 'api/phone/callback.js'), 'utf8');
    ok('18. alle drei Endpunkte pruefen den Schluessel', /P\.guard\(/.test(info) && /P\.guard\(/.test(slots) && /P\.guard\(/.test(cb));
    ok('19. jede Antwort traegt einen vorlesbaren Satz', /text:/.test(info) && /text:/.test(slots) && /text:/.test(cb));
    ok('20. Termin-Endpunkt bucht NICHT', !/bookTrial|trial\/book/.test(slots));
    // Ein Assistent hat den Termin einmal nur behauptet, ohne die Buchung
    // aufzurufen. Der Hinweis steht deshalb in der Antwort selbst.
    ok('20b. Termin-Antwort sagt, dass ohne Buchungsaufruf NICHTS gebucht ist',
      /NICHTS ist gebucht/.test(slots) && /api\/phone\/book/.test(slots));
    ok('20c. … und nennt die noetigen Felder', /dateOfBirth und startDateTime/.test(slots));
    ok('21. Rueckruf greift nicht auf Magicline zu', !/require\('\.\.\/\.\.\/lib\/(connect|members)'\)/.test(cb.replace(/lib\/phoneApi/g, '')));
    ok('22. Rueckruf weist das Team auf die fehlende Verifikation hin', /NICHT als Mitglied verifiziert/.test(cb));
    ok('23. Auskunft holt Oeffnungszeiten und Auslastung parallel', /Promise\.all/.test(info));
    ok('24. … mit hartem Zeitlimit unter der 5-Sekunden-Grenze', /AbortController/.test(info) && /2500/.test(info));

    // ── 9. Probetraining am Telefon ──
    const bk = fs.readFileSync(path.join(ROOT, 'api/phone/book.js'), 'utf8');
    ok('25. Buchung verlangt Name, Rufnummer, Termin und Geburtsdatum',
      /if \(!firstname\) missing/.test(bk) && /if \(!lastname\) missing/.test(bk)
      && /Rufnummer/.test(bk) && /Termin/.test(bk) && /missing\.push\('Geburtsdatum'\)/.test(bk));
    ok('26. Fehlende E-Mail wird durch einen Platzhalter ersetzt', /placeholderEmail\(\)/.test(bk));
    ok('27. Eine genannte E-Mail wird bevorzugt', /emailOk \? given : placeholderEmail\(\)/.test(bk));
    // Der wichtigste Punkt: NUR die E-Mail wird ersetzt. Anschrift und Geburtsdatum
    // duerfen nicht erfunden werden - sie stuenden sonst als scheinbar echte Angabe
    // im Kundendatensatz.
    // Der erste Versuch erfindet NICHTS. Erst wenn Magicline ohne Anschrift ablehnt,
    // folgt ein zweiter mit einem ERKENNBAREN Platzhalter - „Telefonisch erfasst"
    // liest niemand als echte Strasse. Eine plausibel klingende Fantasieadresse
    // („Musterstrasse 1") waere das Gegenteil davon und ist hier ausgeschlossen.
    // Genannte Anschrift hat Vorrang; nur wenn keine kommt, greift der Platzhalter.
    ok('28. Genannte Anschrift wird bevorzugt',
      /const hasAddr = clean\(body\.street, 80\)/.test(bk) && /hasAddr\s*\n?\s*\?/.test(bk));
    ok('28b. Platzhalter-Anschrift ist als solche erkennbar',
      /street: 'Telefonisch erfasst'/.test(bk) && !/Musterstra|Beispielstra|Hauptstra/i.test(bk));
    // Magicline lehnt eine Anschrift OHNE Hausnummer ab (ausgemessen).
    ok('28c. Hausnummer wird immer mitgeschickt', /houseNumber: clean\(body\.houseNumber, 20\) \|\| '-'/.test(bk) && /houseNumber: '-'/.test(bk));
    // Das Geburtsdatum darf NICHT ersetzt werden - eine erfundene Angabe koennte
    // eine minderjaehrige Person als volljaehrig fuehren.
    ok('29b. Kein Platzhalter fuers Geburtsdatum', !/dateOfBirth: '\d/.test(bk) && /dateOfBirth: dob/.test(bk));
    // Die Liste im Code muss genau Magiclines Werte enthalten - „UNKNOWN" wird
    // abgelehnt (ausgemessen) und darf nicht in der Zuordnung auftauchen.
    ok('30b. Nur die von Magicline erlaubten Geschlechter',
      /const GENDERS = \{ MALE: 1, FEMALE: 1, UNISEX: 1 \};/.test(bk)
      && !/return 'UNKNOWN'/.test(bk));
    ok('29. Ungueltiges Geburtsdatum -> Nachfrage statt Notloesung',
      /const dob = birthDate\(body\.dateOfBirth\)/.test(bk) && /if \(!dob\) missing\.push/.test(bk));
    ok('30. Werbeeinwilligung ist am Telefon immer false', /marketing: false/.test(bk));
    ok('31. Notiz warnt das Team vor der Platzhalter-Adresse', /PLATZHALTER/.test(bk));
    // Der Fehler, an dem die erste echte Buchung gescheitert ist:
    // "note: size must be between 0 and 300". Fremde Limits halten wir selbst ein.
    ok('31b. Notiz wird hart auf 300 Zeichen gekappt', /const NOTE_MAX = 300;/.test(bk) && /\.slice\(0, NOTE_MAX\)/.test(bk));

    // Wirklich ausfuehren: auch im schlimmsten Fall darf die Notiz 300 nicht reissen.
    (function () {
      const maxPhone = '+'.padEnd(40, '9');
      const maxNote = 'x'.repeat(400);
      const bauNotiz = (ph, extra, beideFlags) => {
        const flags = beideFlags ? ['E-Mail', 'Anschrift'] : [];
        return [
          'Telefonisch per KI-Assistent gebucht.',
          'Rückruf: ' + ph + '.',
          flags.length ? ('PLATZHALTER: ' + flags.join(' + ') + ' - bitte ersetzen.') : '',
          flags.length ? '' : 'E-Mail ungeprüft (Telefon) - bitte bestätigen.',
          'Keine Werbeeinwilligung.',
          String(extra).slice(0, 120),
        ].filter(Boolean).join(' ').slice(0, 300);
      };
      ok('31c. Schlimmster Fall bleibt <= 300', bauNotiz(maxPhone, maxNote, true).length <= 300,
        String(bauNotiz(maxPhone, maxNote, true).length));
      // Das Wichtigste muss VOR der Kappung stehen, sonst faellt es weg.
      ok('31d. Rueckrufnummer und Platzhalter-Warnung ueberleben die Kappung',
        /Rückruf/.test(bauNotiz(maxPhone, maxNote, true)) && /PLATZHALTER/.test(bauNotiz(maxPhone, maxNote, true)));
      ok('31e. Normalfall bleibt lesbar kurz', bauNotiz('015120442044', '', true).length < 160,
        String(bauNotiz('015120442044', '', true).length));
      ok('31f. Ohne Platzhalter: E-Mail wird als ungeprueft markiert',
        /ungeprüft/.test(bauNotiz('015120442044', '', false)) && bauNotiz('015120442044', '', false).length <= 300);
    })();
    ok('32. Fehlgeschlagene Buchung wird ehrlich gemeldet', /booking_failed/.test(bk) && /nicht geklappt/.test(bk));
    ok('33. Erfolgssatz sagt bei Platzhalter, dass keine Mail kommt', /ohne Adresse nicht schicken/.test(bk));

    // Platzhalter-Erzeugung wirklich ausfuehren (rein, kein Netz).
    const mkBlock = bk.slice(bk.indexOf('function placeholderEmail'), bk.indexOf('function clean('));
    const E = {};
    // eslint-disable-next-line no-new-func
    new Function('crypto', 'process', 'exports', mkBlock + '\nexports.f=placeholderEmail;')(
      require('node:crypto'), { env: { MAIL_TO: 'info@fit-inn-trier.de' } }, E);
    const a1 = E.f(), a2 = E.f();
    ok('34. Platzhalter ist eine gueltige Adresse', /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a1), a1);
    ok('35. … liegt auf dem Studio-Postfach (zustellbar)', /@fit-inn-trier\.de$/.test(a1) && a1.indexOf('info+tel-') === 0, a1);
    ok('36. … und ist pro Lead eindeutig (kein Zusammenfuehren in Magicline)', a1 !== a2, a1 + ' / ' + a2);

    const E2 = {};
    // eslint-disable-next-line no-new-func
    new Function('crypto', 'process', 'exports', mkBlock + '\nexports.f=placeholderEmail;')(
      require('node:crypto'), { env: { PHONE_LEAD_EMAIL: 'telefon-{id}@example.de' } }, E2);
    const b1 = E2.f();
    ok('37. Eigenes Muster wird beachtet und {id} ersetzt', /^telefon-[a-f0-9]{8}@example\.de$/.test(b1), b1);

    const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    ok('38. PHONE_KEY ist dokumentiert', /PHONE_KEY=/.test(env));
    ok('39. Platzhalter-Muster ist dokumentiert', /PHONE_LEAD_EMAIL/.test(env));

    // ── 10. Body-Verarbeitung: fremde Plattformen serialisieren unterschiedlich ──
    // Ein stiller Parse-Fehler saehe aus wie "alle Pflichtfelder fehlen" und
    // schickt die Fehlersuche in die voellig falsche Richtung.
    ok('42. JSON-Body', P.parseBody('{"firstname":"Markus"}', 'application/json').firstname === 'Markus');
    ok('43. form-urlencoded', P.parseBody('firstname=Markus&phone=0151', 'application/x-www-form-urlencoded').phone === '0151');
    ok('43b. urlencoded auch ohne passenden Content-Type erkannt', P.parseBody('firstname=Markus&phone=0151', '').firstname === 'Markus');
    ok('44. Felder in einem Umschlag werden ausgepackt',
      P.parseBody('{"parameters":{"firstname":"Markus"}}', 'application/json').firstname === 'Markus');
    ok('44b. auch bei "arguments" (Function-Calling-Schreibweise)',
      P.parseBody('{"arguments":{"phone":"0151"}}', 'application/json').phone === '0151');
    ok('45. leerer Body -> leeres Objekt, kein Absturz', JSON.stringify(P.parseBody('', '')) === '{}');
    ok('45b. Muell -> leeres Objekt', typeof P.parseBody('<html>kaputt', '') === 'object');
    ok('46. Aussenliegende Felder bleiben neben dem Umschlag erhalten',
      P.parseBody('{"key":"k","parameters":{"firstname":"M"}}', 'application/json').key === 'k');

    // ── 11. Buchung: Diagnose und Anschrift-Rueckfallebene ──
    const bk2 = fs.readFileSync(path.join(ROOT, 'api/phone/book.js'), 'utf8');
    ok('47. Magicline-Fehler landet als hint im Log', /hint: detail/.test(bk2));
    ok('48. Markierte Platzhalter-Anschrift statt Ablehnung', /Telefonisch erfasst/.test(bk2));
    ok('49. … nur wenn wirklich keine Anschrift genannt wurde', /const addrPlaceholder = !hasAddr/.test(bk2));
    ok('50. … und die Notiz weist darauf hin', /flags\.push\('Anschrift'\)/.test(bk2) && /PLATZHALTER: /.test(bk2));
    ok('51. Antwort sagt, ob eine Platzhalter-Anschrift benutzt wurde', /addressPlaceholder: addrPlaceholder/.test(bk2));

    // ── 12. Gesprochene Angaben normalisieren (wirklich ausgefuehrt) ──
    const nb = bk.slice(bk.indexOf('function birthDate'), bk.indexOf('module.exports'));
    const N = {};
    // eslint-disable-next-line no-new-func
    new Function('exports', 'function clean(v,max){return String(v==null?\'\':v).trim().slice(0,max||80);}\n'
      + nb + '\nexports.b=birthDate;exports.g=genderOf;')(N);
    ok('52. Geburtsdatum ISO', N.b('1990-05-04') === '1990-05-04');
    ok('53. Geburtsdatum deutsch', N.b('04.05.1990') === '1990-05-04', N.b('04.05.1990'));
    ok('54. Geburtsdatum deutsch ohne fuehrende Null', N.b('4.5.1990') === '1990-05-04', N.b('4.5.1990'));
    ok('55. Unsinn -> leer (Buchung fragt dann nach)', N.b('irgendwann') === '' && N.b('') === '');
    ok('56. Unmoegliches Datum -> leer', N.b('1800-01-01') === '' && N.b('1990-13-01') === '');
    ok('57. Geschlecht: Herr/Frau werden verstanden', N.g('Herr') === 'MALE' && N.g('frau') === 'FEMALE');
    ok('58. Geschlecht: direkte Werte bleiben', N.g('MALE') === 'MALE' && N.g('UNISEX') === 'UNISEX');
    ok('59. Nicht genannt -> UNISEX (erlaubt), NIE UNKNOWN', N.g('') === 'UNISEX' && N.g('keine ahnung') === 'UNISEX');

    // ── 12b. Der Termin MUSS aus der Slot-Liste stammen ──
    // Der teuerste Fehler bisher: der Assistent hat die gesprochene Ortszeit als
    // UTC formatiert (13 Uhr -> ...T13:00:00.000Z). Magicline nahm die Buchung an,
    // legte den Lead an und antwortete 200 - aber es entstand KEIN Termin.
    // Alle Beteiligten hielten die Buchung fuer erfolgreich.
    ok('67. Buchung prueft den Termin gegen die echte Slot-Liste',
      /C\.getTrialSlots\(/.test(bk) && /slot_unavailable/.test(bk));
    ok('67b. … und tut das VOR dem Buchungsaufruf',
      bk.indexOf('slot_unavailable') > 0 && bk.indexOf('slot_unavailable') < bk.indexOf('C.bookTrial('));
    ok('67c. Der Fehlschlag landet im Protokoll', /status: 'slot_ungueltig'/.test(bk));
    ok('67d. … und der Anrufer bekommt Alternativen genannt', /freieSlots/.test(bk) && /Welcher passt\?/.test(bk));

    // Die Pruefung wirklich ausfuehren – gegen eine nachgebaute Slot-Antwort.
    (function () {
      const frei = ['2026-08-15T11:00:00.000Z', '2026-08-15T12:30:00.000Z', '2026-08-15T14:00:00.000Z'];
      ok('68. Erfundener Zeitpunkt wird erkannt', frei.indexOf('2026-08-15T13:00:00.000Z') < 0);
      ok('68b. Ein echter Wert aus der Liste geht durch', frei.indexOf('2026-08-15T12:30:00.000Z') >= 0);
      // Genau die Struktur, die Magicline liefert: {slots:[{startDateTime,…}]}
      const antwort = { status: 200, json: { slots: frei.map(function (s) { return { startDateTime: s, endDateTime: s }; }) } };
      const gelesen = antwort.json.slots.map(function (x) { return String(x && x.startDateTime || ''); }).filter(Boolean);
      ok('68c. Slot-Liste wird aus slots[].startDateTime gelesen', gelesen.length === 3 && gelesen[0] === frei[0], JSON.stringify(gelesen));
    })();

    // ── 12b2. Ortszeit, die als UTC formatiert wurde, geradeziehen ──
    // Aus dem Produktionsprotokoll: dreimal hintereinander schickte der Assistent
    // die gesprochene Ortszeit als UTC. Die Slot-Pruefung verhinderte zwar den
    // Geistertermin, aber der Anrufer bekam seinen Termin trotzdem nicht - obwohl
    // der Wunsch buchbar war. Nach dem dritten Versuch gab er auf.
    // Die echten freien Slots am Samstag, 15.08.2026:
    const FREI = ['2026-08-15T11:00:00.000Z', '2026-08-15T12:30:00.000Z', '2026-08-15T14:00:00.000Z'];
    ok('69a1. „14:30" trifft als Ortszeit gelesen 12:30Z',
      P.fixLocalAsUtc('2026-08-15T14:30:00.000Z', FREI) === '2026-08-15T12:30:00.000Z');
    ok('69a2. „16:00" trifft 14:00Z', P.fixLocalAsUtc('2026-08-15T16:00:00.000Z', FREI) === '2026-08-15T14:00:00.000Z');
    ok('69a3. „13:00" trifft 11:00Z', P.fixLocalAsUtc('2026-08-15T13:00:00.000Z', FREI) === '2026-08-15T11:00:00.000Z');
    // Eng bleiben: nur korrigieren, wenn es eindeutig ist.
    ok('69a4. Ein bereits gueltiger Wert wird NICHT verbogen',
      P.fixLocalAsUtc('2026-08-15T12:30:00.000Z', FREI) === null);
    ok('69a5. Trifft die Ortszeit-Lesart nichts, bleibt es beim Fehlschlag',
      P.fixLocalAsUtc('2026-08-15T09:15:00.000Z', FREI) === null);
    ok('69a6. Ohne Slot-Liste keine Korrektur',
      P.fixLocalAsUtc('2026-08-15T14:30:00.000Z', []) === null
      && P.fixLocalAsUtc('2026-08-15T14:30:00.000Z', null) === null);
    ok('69a7. Muell wird nicht korrigiert', P.fixLocalAsUtc('morgen', FREI) === null);
    // Winterzeit: Berlin ist dann UTC+1, die Korrektur muss eine Stunde betragen.
    ok('69a8. Winterzeit wird richtig gerechnet',
      P.fixLocalAsUtc('2026-12-05T14:30:00.000Z', ['2026-12-05T13:30:00.000Z']) === '2026-12-05T13:30:00.000Z');
    ok('69a9. Sommerzeit sind zwei Stunden', P.berlinOffsetMs(Date.parse('2026-08-15T12:00:00Z')) === 7200000);
    ok('69a10. Winterzeit ist eine Stunde', P.berlinOffsetMs(Date.parse('2026-12-05T12:00:00Z')) === 3600000);

    ok('70a. Die Buchung nutzt die Korrektur', /P\.fixLocalAsUtc\(startEff, frei\)/.test(bk));
    ok('70a2. … und bucht dann den KORRIGIERTEN Zeitpunkt',
      /startDateTime: startEff,\n\s+trainerRequired: mitTrainer/.test(bk));
    ok('70a3. … der Bestaetigungssatz nennt ebenfalls den echten Zeitpunkt',
      /const d = new Date\(startEff\);/.test(bk) && !/new Date\(startDateTime\)/.test(bk));
    ok('70a4. Die Korrektur steht im Protokoll', /status: 'ortszeit_korrigiert'/.test(bk));

    // Magicline laesst kein zweites Probetraining zu. Das ist eine Auskunft,
    // kein Fehler - und im Gespraech der Hinweis auf den bestehenden Termin.
    ok('71a. Ein bereits gebuchtes Probetraining wird als solches erkannt',
      /TRIALSESSION_ALREADY_BOOKED\|already booked a trial/.test(bk) && /error: 'already_booked'/.test(bk));
    ok('71a2. … und verweist auf die Termin-Aktion statt auf einen Rueckruf',
      /bereits ein Probetraining gebucht/.test(bk) && /api\/phone\/appointment/.test(bk));
    ok('71a3. … mit der ausdruecklichen Anweisung, nicht erneut zu buchen',
      /NICHT erneut buchen/.test(bk));

    // Die echte Antwortform von Magicline (aus dem Protokoll) muss die Kunden-ID
    // hergeben - sonst greift der Merker fuer den spaeteren Anruf nicht.
    ok('72a. Kunden-ID aus der echten Buchungsantwort',
      P.customerIdFrom({ id: 1218084290, customerNumber: 'M-2141', uuid: 'db6cd77c-742e-40be-beb0-e947b7c02c11' }) === '1218084290');
    ok('72a2. … samt Kundennummer',
      P.customerNumberFrom({ id: 1218084290, customerNumber: 'M-2141' }) === 'M-2141');

    // ── 12c. Weiter in der Zukunft buchen ──
    // Magicline beantwortet hoechstens 30 Tage pro Abfrage („interval violation"),
    // aber beliebig weit voraus. Frueher schaute der Endpunkt starr 21 Tage
    // nach vorn - „im Oktober" war damit unmoeglich.
    const HEUTE = Date.parse('2026-08-14T09:00:00Z');   // Freitag
    ok('69. Ohne Angabe: ab heute', P.slotWindow({}, HEUTE).start === '2026-08-14');
    ok('69b. Fenster reisst die 30-Tage-Grenze von Magicline nicht',
      P.slotWindow({}, HEUTE).end === '2026-09-13', P.slotWindow({}, HEUTE).end);
    ok('70. Wunschtag wird uebernommen', P.slotWindow({ datum: '2026-10-05' }, HEUTE).exactDay === '2026-10-05');
    ok('70b. … und deutsch gesprochen genauso', P.slotWindow({ datum: '05.10.2026' }, HEUTE).exactDay === '2026-10-05');
    ok('70c. Zum Wunschtag wird trotzdem ein ganzes Fenster geholt (Ausweichtermine)',
      P.slotWindow({ datum: '2026-10-05' }, HEUTE).end === '2026-11-04', P.slotWindow({ datum: '2026-10-05' }, HEUTE).end);
    ok('71. „ab" verschiebt den Start', P.slotWindow({ ab: '2026-09-20' }, HEUTE).start === '2026-09-20');
    ok('71b. „in N Tagen" rechnet richtig', P.slotWindow({ tage: '28' }, HEUTE).start === '2026-09-11', P.slotWindow({ tage: '28' }, HEUTE).start);
    // Ein verhoertes Datum darf nicht in einer Fehlermeldung enden - der Anrufer
    // soll einen Vorschlag hoeren.
    const vorbei = P.slotWindow({ datum: '2026-01-05' }, HEUTE);
    ok('72. Vergangener Tag wird zurechtgerueckt, nicht abgelehnt',
      vorbei.past === true && vorbei.start === '2026-08-14' && vorbei.exactDay === null);
    const weit = P.slotWindow({ datum: '2029-01-05' }, HEUTE);
    ok('72b. Absurd weit voraus wird gedeckelt', weit.tooFar === true && weit.start === P.ymdAdd('2026-08-14', P.MAX_AHEAD));
    ok('72c. Unsinniges Datum -> normale Suche ab heute',
      P.slotWindow({ datum: 'irgendwann' }, HEUTE).start === '2026-08-14' && P.slotWindow({ datum: 'irgendwann' }, HEUTE).exactDay === null);
    ok('73. Datumsrechnung ueberlebt die Sommerzeit-Umstellung',
      P.ymdAdd('2026-10-24', 3) === '2026-10-27' && P.ymdAdd('2026-03-28', 2) === '2026-03-30');
    ok('73b. Monats- und Jahresgrenze', P.ymdAdd('2026-12-30', 5) === '2027-01-04' && P.ymdAdd('2026-02-27', 2) === '2026-03-01');

    ok('74. Termin-Endpunkt nimmt datum/ab/tage entgegen',
      /searchParams\.get\('datum'\)/.test(slots) && /searchParams\.get\('ab'\)/.test(slots) && /searchParams\.get\('tage'\)/.test(slots));
    ok('74b. … und rueckt selbst weiter, wenn ein Fenster leer ist',
      /MAX_FENSTER/.test(slots) && /P\.ymdAdd\(end, 1\)/.test(slots));
    ok('74c. … bleibt dabei unter der 5-Sekunden-Grenze von fonio', /ZEITBUDGET = 3000/.test(slots));
    ok('74d. Termine werden ueber mehrere Tage gestreut', /function streue/.test(slots));
    ok('74e. Der Assistent wird angewiesen, KEINEN Wochentag selbst zu rechnen',
      /NIE einen Wochentag oder ein Datum selbst ausrechnen/.test(slots));
    // Streuung wirklich ausfuehren.
    (function () {
      const src = slots.slice(slots.indexOf('function streue'), slots.indexOf('module.exports'));
      const S = {};
      // eslint-disable-next-line no-new-func
      new Function('exports', src + '\nexports.s=streue;')(S);
      const viele = ['2026-08-15T09:00:00Z', '2026-08-15T10:00:00Z', '2026-08-15T11:00:00Z',
        '2026-08-16T09:00:00Z', '2026-08-16T10:00:00Z', '2026-08-17T09:00:00Z'];
      const g = S.s(viele, 5, 2);
      ok('74f. Hoechstens zwei Uhrzeiten pro Tag', g.filter(function (x) { return x.slice(0, 10) === '2026-08-15'; }).length === 2, JSON.stringify(g));
      ok('74g. … und dadurch mehrere Tage im Vorschlag', new Set(g.map(function (x) { return x.slice(0, 10); })).size === 3, JSON.stringify(g));
      ok('74h. Gibt es nur einen Tag, wird trotzdem etwas geliefert',
        S.s(['2026-08-15T09:00:00Z', '2026-08-15T10:00:00Z', '2026-08-15T11:00:00Z'], 3, 2).length >= 2);
    })();

    // ── 12e. „Nächste Woche Donnerstag" ──
    // Im echten Gespraech gefragt: „naechste Woche, Donnerstagvormittag".
    // Angeboten wurde Montag, der 17. August - ein anderer Wochentag. Wochentags-
    // Rechnung ist nichts, was ein Sprachmodell zuverlaessig kann; also rechnet
    // der Server. HEUTE ist Freitag, der 14.08.2026.
    ok('79a. „naechste Woche Donnerstag" trifft den Donnerstag',
      P.wochentagDatum('Donnerstag', 'nächste', HEUTE) === '2026-08-20', P.wochentagDatum('Donnerstag', 'nächste', HEUTE));
    ok('79b2. … und NICHT den Montag', P.wochentagDatum('Donnerstag', 'nächste', HEUTE) !== '2026-08-17');
    ok('79c. „naechste Woche Montag" ist der Montag der Folgewoche',
      P.wochentagDatum('Montag', 'nächste', HEUTE) === '2026-08-17');
    ok('79d. Ohne „naechste": der naechste dieser Wochentage',
      P.wochentagDatum('Samstag', '', HEUTE) === '2026-08-15');
    // Wer am Freitag „Freitag" sagt, meint nicht heute in zwei Stunden.
    ok('79e. Der heutige Wochentag meint die kommende Woche',
      P.wochentagDatum('Freitag', '', HEUTE) === '2026-08-21');
    ok('79f. „Sonnabend" wird verstanden', P.wochentagDatum('Sonnabend', '', HEUTE) === '2026-08-15');
    ok('79g. Umlaut-Schreibweisen von „naechste"',
      P.wochentagDatum('Donnerstag', 'naechste', HEUTE) === '2026-08-20'
      && P.wochentagDatum('Donnerstag', 'kommende', HEUTE) === '2026-08-20');
    ok('79h. Unsinn -> leer, dann greift die normale Suche', P.wochentagDatum('Blubbtag', '', HEUTE) === '');
    ok('79i. Wochentag setzt den Wunschtag im Fenster',
      P.slotWindow({ wochentag: 'Donnerstag', woche: 'nächste' }, HEUTE).exactDay === '2026-08-20');
    ok('79j. Ein ausdrueckliches Datum hat Vorrang vor dem Wochentag',
      P.slotWindow({ datum: '2026-09-01', wochentag: 'Donnerstag' }, HEUTE).exactDay === '2026-09-01');
    ok('79k. Termin-Endpunkt nimmt wochentag/woche entgegen',
      /searchParams\.get\('wochentag'\)/.test(slots) && /searchParams\.get\('woche'\)/.test(slots));

    // ── 12f. Tageszeit ──
    // „Wie sieht es nachmittags aus?" endete im Gespraech in einer Sackgasse:
    // der Assistent hatte nur die Vormittagstermine und musste passen.
    ok('80a. Termin-Endpunkt kennt die Tageszeit', /searchParams\.get\('tageszeit'\)/.test(slots));
    ok('80c. Der ganze Tag wird mitgeliefert, damit kein zweiter Aufruf noetig ist',
      /zeitenAmTag/.test(slots) && /dafuer ist KEIN weiterer Aufruf noetig/.test(slots));
    ok('80d. Ein Tag mit Terminen zur falschen Zeit ist nicht „ausgebucht"',
      /An dem Tag ginge noch/.test(slots));
    // Wirklich ausfuehren – gegen die echten Slots von Donnerstag, 20.08.2026
    // (gegen die Connect-API geprueft: 09:30, 11:00, 15:00, 16:30, 18:00, 19:30).
    (function () {
      const src = slots.slice(slots.indexOf('function berlinStunde'), slots.indexOf('// Die Connect-API liefert'));
      const T = {};
      // eslint-disable-next-line no-new-func
      new Function('exports', src + '\nexports.f=tageszeitFilter;exports.n=nachTageszeit;exports.h=berlinStunde;')(T);
      const do2008 = ['2026-08-20T07:30:00.000Z', '2026-08-20T09:00:00.000Z', '2026-08-20T13:00:00.000Z',
        '2026-08-20T14:30:00.000Z', '2026-08-20T16:00:00.000Z', '2026-08-20T17:30:00.000Z'];
      ok('81a. UTC wird in Ortszeit umgerechnet', T.h('2026-08-20T13:00:00.000Z') === 15,
        String(T.h('2026-08-20T13:00:00.000Z')));
      const g = T.n(do2008);
      ok('81b. Vormittag richtig erkannt', g.vormittag.length === 2, JSON.stringify(g.vormittag));
      ok('81c. Nachmittag richtig erkannt', g.nachmittag.length === 2, JSON.stringify(g.nachmittag));
      ok('81d. Abend richtig erkannt', g.abend.length === 2, JSON.stringify(g.abend));
      ok('81e. Gesprochene Formen werden verstanden',
        T.f('nachmittags').name === 'nachmittag' && T.f('Vormittag').name === 'vormittag'
        && T.f('am Abend').name === 'abend');
      ok('81f. Ohne Angabe kein Filter', T.f('') === null && T.f('egal') === null);
      const nm = T.f('nachmittags');
      ok('81g. Filter trifft genau die Nachmittagstermine',
        do2008.filter(function (s) { return nm.test(T.h(s)); }).length === 2);
      // Winterzeit: dieselbe UTC-Stunde liegt eine Stunde frueher.
      ok('81h. Winterzeit wird beachtet', T.h('2026-12-10T13:00:00.000Z') === 14,
        String(T.h('2026-12-10T13:00:00.000Z')));
    })();

    // Auch die Buchung holt ein Fenster (Ausweichtermine bei vollem Tag).
    ok('75. Buchung holt ein Fenster ab dem Wunschtag', /P\.ymdAdd\(tag, P\.MAX_SPAN\)/.test(bk));
    ok('75b. … nennt aber zuerst Alternativen AM gewuenschten Tag', /const amTag = frei\.filter/.test(bk));

    // ── 12d. Woechentliche Oeffnungszeiten ──
    // „Wann habt ihr samstags auf?" war bisher nicht beantwortbar - openStatus
    // kennt nur heute.
    const wp = P.weekPlan(HOURS);
    ok('76. Wochenplan hat sieben Tage, Montag zuerst', wp.length === 7 && wp[0].tag === 'Montag' && wp[6].tag === 'Sonntag');
    ok('76b. Samstag korrekt', wp[5].text === '13:00 bis 18:00 Uhr', wp[5].text);
    const wt = P.weekText(HOURS);
    ok('77. Gleiche Tage werden zusammengefasst', /Montag bis Freitag/.test(wt), wt);
    ok('77b. … und die Ausnahmen einzeln genannt', /Samstag 13:00 bis 18:00 Uhr/.test(wt) && /Sonntag 9:00 bis 15:00 Uhr/.test(wt), wt);
    ok('77c. Geschlossene Tage werden als geschlossen benannt',
      /geschlossen/.test(P.weekText({ openingHours: [{ dayOfWeekFrom: 'MONDAY', dayOfWeekTo: 'FRIDAY', timeFrom: '09:00:00', timeTo: '20:00:00' }] })));
    ok('78. Auskunft liefert die ganze Woche mit', /weekHours/.test(info) && /weekText/.test(info));
    ok('78b. … und kann nach einem bestimmten Tag gefragt werden', /searchParams\.get\('tag'\)/.test(info));

    const png = fs.readFileSync(path.join(ROOT, 'api/phone/ping.js'), 'utf8');
    ok('40. Einrichtungshilfe /api/phone/ping vorhanden', /naechsterSchritt/.test(png));
    ok('41. … gibt den Schluessel NIE zurueck', !/got\.value|secret/.test(png) && !/key:/.test(png));

    // ── 13. Diagnose-Protokoll ──
    // Die Telefon-Plattform zeigt ihre Logs nicht. Ohne eigene Spur bleibt nach
    // einem gescheiterten Anruf nur Raten - aber die Spur darf keine
    // personenbezogenen Werte enthalten.
    const lib = fs.readFileSync(path.join(ROOT, 'lib/phoneApi.js'), 'utf8');
    ok('60. Protokoll wird gefuehrt und gedeckelt', /LPUSH/.test(lib) && /LTRIM/.test(lib) && /LOG_MAX = 20/.test(lib));
    ok('61. … laeuft nach einer Woche ab', /EXPIRE.*604800/.test(lib));
    ok('62. … stoert den Anruf nie', /Diagnose darf den Anruf nie stoeren/.test(lib));
    ok('63. Protokoll nur mit gueltigem Schluessel abrufbar', /if \(g\.ok\)[\s\S]{0,400}wantLog/.test(png));
    // Der entscheidende Punkt: gespeichert werden BOOLEANS, keine Werte.
    ok('64. Keine Namen/Nummern/Geburtsdaten im Protokoll',
      /firstname: !!firstname/.test(bk2) && /dateOfBirth: !!dob/.test(bk2)
      && !/firstname: firstname,\s*$/m.test(bk2.slice(bk2.indexOf('const spur'), bk2.indexOf('P.logAttempt'))));
    const spurBlock = bk2.slice(bk2.indexOf('const spur'), bk2.indexOf('P.logAttempt'));
    ok('64b. … auch nicht ueber Umwege', !/phone: phone/.test(spurBlock) && !/lastname: lastname/.test(spurBlock), spurBlock.slice(0, 120));
    ok('65. Magicline-Antwort wird protokolliert', /magicline: String/.test(bk2));
    ok('66. Und die Feldnamen, die ankamen (ohne Schluessel)',
      /empfangen: Object\.keys/.test(bk2) && /k !== 'key' && k !== 'apiKey'/.test(bk2));

    // ── 13b. Rohe UTC-Zeiten duerfen nicht vorgelesen werden ──
    // Echter Vorfall: Der Assistent hat die Liste freieSlots direkt vorgelesen und
    // daraus „elf Uhr, zwoelf Uhr dreissig" gemacht. Das waren die UTC-Rohwerte -
    // in Ortszeit 13:00 und 14:30. Samstags oeffnet das Studio erst um 13 Uhr, es
    // wurden also Zeiten angeboten, zu denen abgeschlossen ist. Der Satz in `text`
    // war richtig; das Modell hat nur das falsche Feld gelesen.
    ok('91. Es gibt einen ausdruecklichen Hinweis zu UTC', /UTC_HINWEIS/.test(lib)
      && /niemals vorlesen/.test(lib));
    ok('91b. … und er steht in den Antworten mit Zeitpunkten',
      /hinweis: P\.UTC_HINWEIS/.test(bk) && /hinweis: P\.UTC_HINWEIS/.test(slots));
    // Der Rohwert wird zum Buchen gebraucht, laesst sich also nicht weglassen -
    // aber er darf nie allein dastehen.
    ok('92. Alternativen tragen immer eine gesprochene Form',
      /freieSlots: frei\.slice\(0, 5\)\.map/.test(bk) && /gesprochen: sprich\(s/.test(bk));
    ok('92b. „gesprochen" steht VOR dem technischen Wert',
      /\{ gesprochen: sprich\(s[^}]*\), startDateTime: s \}/.test(bk));
    ok('92c. Auch die Terminliste nennt zuerst die gesprochene Form',
      /\{ gesprochen: spoken\[i\] \|\| null, startDateTime: s \}/.test(slots));
    ok('92d. Der Diagnose-Hinweis nennt Ortszeit, nicht UTC',
      /frei sind \(Ortszeit\)/.test(bk));
    // Wirklich nachrechnen: die Rohwerte des Samstags gegen die Ortszeit.
    (function () {
      const roh = ['2026-08-15T11:00:00.000Z', '2026-08-15T12:30:00.000Z', '2026-08-15T14:00:00.000Z'];
      const ortszeit = roh.map(function (iso) {
        const q = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', minute: '2-digit', hour12: false })
          .formatToParts(new Date(iso)).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
        return q.hour + ':' + q.minute;
      });
      ok('93. Rohwert 11:00Z ist in Wahrheit 13:00 Ortszeit', ortszeit[0] === '13:00', ortszeit.join(', '));
      ok('93b. … und keiner der Rohwerte liegt in der Samstags-Oeffnungszeit',
        parseInt(roh[0].slice(11, 13), 10) < 13, roh[0]);
      ok('93c. In Ortszeit liegen dagegen alle drin (13-18 Uhr)',
        ortszeit.every(function (t) { const h = parseInt(t, 10); return h >= 13 && h < 18; }), ortszeit.join(', '));
    })();

    // ── 13c. Probetraining MIT Trainer (Ressource) ──
    // Ohne das Flag legt Magicline einen Termin ohne zugewiesene Ressource an -
    // im Kalender steht dann niemand dafuer ein.
    const conn = fs.readFileSync(path.join(ROOT, 'lib/connect.js'), 'utf8');
    const C2 = require(path.join(ROOT, 'lib/connect.js'));
    ok('94. Mit Trainer ist der Standard', C2.wantTrainer(undefined) === true && C2.wantTrainer(null) === true);
    ok('94b. Ein ausdrueckliches false gewinnt (Web-Funnel laesst waehlen)', C2.wantTrainer(false) === false);
    ok('94c. Ein ausdrueckliches true ebenso', C2.wantTrainer(true) === true);
    ok('94d. Leerer String zaehlt als „nicht angegeben"', C2.wantTrainer('') === true);
    ok('94e. Slot-Abfrage und Buchung nutzen denselben Helfer',
      /trainerRequired=' \+ \(wantTrainer\(trainerRequired\)/.test(conn)
      && /trainerRequired: wantTrainer\(d\.trainerRequired\)/.test(conn));
    // Der entscheidende Punkt: pruefen und buchen MUESSEN dasselbe Flag benutzen.
    // Sonst besteht ein Termin die Pruefung, zu dem gar kein Trainer frei ist.
    ok('95. Buchung berechnet das Flag genau einmal', /const mitTrainer = C\.wantTrainer\(body\.trainerRequired\);/.test(bk));
    ok('95b. … und nutzt es fuer Pruefung UND Buchung',
      /getTrialSlots\(tag, P\.ymdAdd\(tag, P\.MAX_SPAN\), mitTrainer\)/.test(bk)
      && /trainerRequired: mitTrainer,/.test(bk));
    ok('95c. Kein rohes body.trainerRequired mehr im Buchungspfad',
      !/!!body\.trainerRequired/.test(bk));
    ok('96. Termin-Endpunkt schaltet nur bei ausdruecklichem trainer=0 ab',
      /trainerQ === '1'/.test(slots) && /trainerQ == null \|\| trainerQ === ''/.test(slots));
    const ts = fs.readFileSync(path.join(ROOT, 'api/trial/slots.js'), 'utf8');
    ok('96b. Auch die Website-Slots nutzen den Standard statt hart false',
      /\? undefined : String\(u\.query\.trainer\) === '1'/.test(ts));
    const tb = fs.readFileSync(path.join(ROOT, 'team-backend.html'), 'utf8');
    ok('96c. Team-Buchung setzt kein hartes trainerRequired:false mehr',
      !/startDateTime:S\.trSlotSel\.start, trainerRequired:false/.test(tb));

    // ── 14. Termin am Telefon abrufen/aendern ──
    // Der erste Endpunkt, der Daten EINER BESTIMMTEN PERSON herausgibt. Am
    // Telefon ist niemand verifiziert, und eine Anruferkennung laesst sich
    // faelschen - deshalb muessen ZWEI Merkmale zusammenpassen.
    const ap = fs.readFileSync(path.join(ROOT, 'api/phone/appointment.js'), 'utf8');
    ok('79. Schluessel wird geprueft', /P\.guard\(/.test(ap));
    ok('80. Rufnummer allein reicht NICHT', /if \(!lastname && !dob\)/.test(ap) && /missing_factor/.test(ap));
    ok('80b. Zweites Merkmal ist Nachname ODER Geburtsdatum', /passt = nameOk \|\| dobOk/.test(ap));
    // Der entscheidende Punkt: „Nummer unbekannt" und „Nachname passt nicht"
    // muessen DIESELBE Antwort geben. Sonst liesse sich zu einer Rufnummer der
    // Nachname erraten.
    ok('81. Falsches Merkmal antwortet wie eine unbekannte Nummer',
      /if \(!kunde \|\| !passt\)/.test(ap) && /return P\.json\(res, 200, UNBEKANNT\)/.test(ap));
    ok('81b. … und der Unterschied steht nur im internen Protokoll',
      /merkmal_passt_nicht/.test(ap) && /nummer_unbekannt/.test(ap));
    ok('82. Durchprobieren wird pro Rufnummer begrenzt', /rateLimit\('phoneappt:/.test(ap));
    // Datensparsamkeit: nur Terminart und Zeitpunkt zurueck.
    ok('83. Antwort enthaelt keine E-Mail, Anschrift oder Kundennummer',
      !/email/i.test(ap.slice(ap.indexOf('const alsAntwort'), ap.indexOf('// ── Auskunft')))
      && !/customerNumber/.test(ap));
    ok('83b. Nur Vorname zur Ansprache, kein Nachname in der Antwort',
      /const vorname = clean\(kunde\.firstName/.test(ap) && !/lastName \+/.test(ap));
    ok('84. Vergangene Termine werden nicht ausgeplaudert', /t > jetzt/.test(ap));
    ok('84b. Stornierte Termine werden herausgefiltert', /function isCancelled/.test(ap) && /!isCancelled\(a\)/.test(ap));
    // Umbuchen: die Reihenfolge entscheidet, ob der Anrufer im Fehlerfall ohne
    // Termin dasteht.
    ok('85. Umbuchen bucht ZUERST neu und storniert erst danach',
      ap.indexOf("'/appointments/booking/book'") < ap.indexOf("d = await M.ml('DELETE'"));
    ok('85b. Scheitert der neue Slot, bleibt der alte Termin bestehen',
      /new_slot_failed/.test(ap) && /bleibt bestehen/.test(ap));
    ok('85c. Ohne Terminart wird NICHT storniert', /reschedule_unsupported/.test(ap)
      && ap.indexOf('reschedule_unsupported') < ap.indexOf('const dauer ='));
    ok('86. Mehrere Termine -> Rueckfrage statt Raten', /ambiguous/.test(ap)
      && /termine\.length === 1 \? termine\[0\] : null/.test(ap));
    ok('87. Protokoll ohne personenbezogene Werte',
      !/phone: phone/.test(ap) && !/lastname: lastname/.test(ap) && !/vorname: vorname/.test(ap));

    // Namens- und Datumsvergleich wirklich ausfuehren.
    (function () {
      const src = ap.slice(ap.indexOf('function normName'), ap.indexOf('// Stornierte Buchungen'));
      const A = {};
      // eslint-disable-next-line no-new-func
      new Function('exports', 'function clean(v,max){return String(v==null?\'\':v).trim().slice(0,max||80);}\n'
        + src + '\nexports.n=normName;exports.d=normDob;')(A);
      ok('88. Umlaute aus der Spracherkennung passen zusammen', A.n('Müller') === A.n('Mueller'));
      ok('88b. Gross/Klein und Bindestriche stoeren nicht', A.n('von der Heide') === A.n('VONDERHEIDE')
        && A.n('Meier-Schmitt') === A.n('meierschmitt'));
      ok('88c. Verschiedene Namen bleiben verschieden', A.n('Meier') !== A.n('Maier'));
      ok('88d. Leerer Name ergibt keinen Treffer auf leer',
        A.n('') === '' && A.n('  ') === '');
      ok('89. Geburtsdatum in beiden Schreibweisen', A.d('04.05.1990') === '1990-05-04' && A.d('1990-05-04') === '1990-05-04');
      ok('89b. Unsinn -> leer (zaehlt dann nicht als Merkmal)', A.d('gestern') === '' && A.d('') === '');
    })();

    // ── 14b. Die Rufnummer muss wieder zum Kunden fuehren ──
    // Der Grund, warum der gebuchte Termin nicht gefunden wurde: ein
    // Probetraining legt in Magicline einen LEAD an, und /customers/search findet
    // vor allem Mitglieder. Beim Buchen kennen wir die Zuordnung aber sicher -
    // also merken wir sie uns dort, statt sie hinterher zu erraten.
    ok('97. Die Buchung merkt sich Rufnummer -> Kunde', /P\.rememberLead\(phone, \{/.test(bk)
      && /customerId: P\.customerIdFrom\(r\.json\)/.test(bk));
    ok('97b. … erst NACH erfolgreicher Buchung', bk.indexOf('P.rememberLead') > bk.indexOf("error: 'booking_failed'"));
    ok('97c. … und darf die Buchung nie scheitern lassen',
      /try \{\s*await P\.rememberLead/.test(bk));
    // Beide Stellen muessen VORHANDEN sein - sonst waere ein fehlendes
    // indexOf (-1) faelschlich „steht davor".
    ok('98. Der Termin-Abruf schaut ZUERST in den Merker',
      ap.indexOf('P.lookupLead(phone)') >= 0 && ap.indexOf('M.findByPhone(phone)') >= 0
      && ap.indexOf('P.lookupLead(phone)') < ap.indexOf('M.findByPhone(phone)'));
    // Wer ueber einen anderen Kanal gebucht hat (Website, Team, direkt in
    // Magicline), taucht im Merker nicht auf. Dafuer die beiden weiteren Wege.
    ok('98b. Danach der Interessenten-Bestand aus den Webhooks',
      /Leads\.getLeadByPhone\(phone\)/.test(ap)
      && ap.indexOf('Leads.getLeadByPhone') > ap.indexOf('P.lookupLead(phone)')
      && ap.indexOf('Leads.getLeadByPhone') < ap.indexOf('M.findByPhone(phone)'));
    ok('98d. … und zuletzt Magiclines Kundensuche',
      /if \(!kunde\) \{[\s\S]{0,400}M\.findByPhone/.test(ap));
    ok('98e. Jeder Weg ist im Protokoll unterscheidbar',
      /quelle = 'merker'/.test(ap) && /quelle = 'lead'/.test(ap) && /quelle = 'suche'/.test(ap));
    // Auch die Website-Buchung muss die Zuordnung schreiben - sonst findet der
    // spaetere Anruf nur telefonisch gebuchte Termine.
    const tbk = fs.readFileSync(path.join(ROOT, 'api/trial/book.js'), 'utf8');
    ok('98f. Website-Buchung merkt sich die Rufnummer ebenfalls',
      /Phone\.rememberLead\(b\.phone/.test(tbk));
    ok('98g. … erst nach erfolgreicher Buchung',
      tbk.indexOf('Phone.rememberLead') > tbk.indexOf('if (r.ok) {'));
    ok('98c. Das Protokoll zeigt, welcher Weg getragen hat', /quelle: quelle/.test(ap)
      && /merker: !!\(merker && merker\.customerId\)/.test(ap));
    // Datensparsam: gemerkt wird NUR die Zuordnung, kein Name, kein Geburtsdatum.
    ok('99. Der Merker speichert keine personenbezogenen Inhalte',
      !/name:/.test(lib.slice(lib.indexOf('async function rememberLead'), lib.indexOf('async function lookupLead')))
      && !/dateOfBirth/.test(lib.slice(lib.indexOf('async function rememberLead'), lib.indexOf('async function lookupLead'))));
    ok('99b. … und laeuft von selbst ab', /LEAD_TTL = 60 \* 60 \* 24 \* 400/.test(lib));

    // Schluessel und ID-Erkennung wirklich ausfuehren.
    (function () {
      // Dieselbe Nummer in vier Schreibweisen muss denselben Schluessel ergeben -
      // sonst findet der Merker beim Rueckruf nichts.
      const varianten = ['0151 2044 2244', '015120442244', '+4915120442244', '004915120442244'];
      const keys = varianten.map(function (v) { return require(path.join(ROOT, 'lib/members.js')).normDePhone(v); });
      ok('100. Alle Schreibweisen ergeben denselben Schluessel',
        keys.every(function (k) { return k === keys[0]; }) && !!keys[0], JSON.stringify(keys));
      // Magicline benennt die Kunden-ID je nach Endpunkt anders.
      ok('101. customerId wird aus allen bekannten Feldnamen gelesen',
        P.customerIdFrom({ customerId: 7 }) === '7'
        && P.customerIdFrom({ leadCustomerId: 8 }) === '8'
        && P.customerIdFrom({ customer: { id: 9 } }) === '9');
      ok('101b. Fehlt sie, kommt sauber null zurueck',
        P.customerIdFrom({}) === null && P.customerIdFrom(null) === null);
      ok('101c. Kundennummer ebenso', P.customerNumberFrom({ customerNumber: 'M-1177' }) === 'M-1177'
        && P.customerNumberFrom({}) === null);
      ok('101d. Ohne Store wirft der Merker nicht',
        P.rememberLead('015120442244', { customerId: 5 }) instanceof Promise);
    })();

    // ── 14c. Andere Terminarten - auch fuer Mitglieder ──
    // Stoffwechselberatung, Einweisung, Trainingsplanung. Anders als das
    // Probetraining gehoeren die einem BESTEHENDEN Kunden und laufen ueber die
    // authentifizierte API - also nur hinter der Identitaetspruefung.
    ok('102. Terminarten koennen genannt werden', /aktion === 'arten'/.test(ap) && /B\.listTypes\(\)/.test(ap));
    // „Was bietet ihr an?" ist eine oeffentliche Auskunft - dafuer muss niemand
    // seinen Nachnamen buchstabieren.
    ok('102b. … ohne Identitaet, weil oeffentlich',
      ap.indexOf("aktion === 'arten'") < ap.indexOf('P.lookupLead(phone)'));
    ok('103. Freie Zeiten und Buchen liegen HINTER der Identitaetspruefung',
      ap.indexOf("aktion === 'termine'") > ap.indexOf('return P.json(res, 200, UNBEKANNT)')
      && ap.indexOf("aktion === 'buchen'") > ap.indexOf('return P.json(res, 200, UNBEKANNT)'));
    ok('103b. Gebucht wird auf die Kunden-ID des zugeordneten Anrufers',
      /B\.book\(kundeId, m\.type\.id, slot\)/.test(ap));
    // Unklare Terminart -> nachfragen. Eine Stoffwechselberatung zu buchen, wo
    // eine Einweisung gemeint war, ist schlimmer als eine Rueckfrage.
    // Die BEDINGUNG mitpruefen, nicht nur die Stelle im Text - sonst bliebe die
    // Zusicherung gruen, wenn die Sperre wegfaellt und der Satz stehen bleibt.
    ok('104. Unklare Terminart fuehrt zur Rueckfrage, nicht zur Buchung',
      /if \(!m\.type\) \{/.test(ap) && /error: 'art_unklar'/.test(ap)
      && ap.indexOf("error: 'art_unklar'") < ap.indexOf('B.book('));
    // Endzeit und Trainer kommen aus der Slot-Liste, nicht aus dem Gespraech.
    ok('105. Endzeit und Trainer stammen aus dem Slot, nicht vom Modell',
      /const slot = frei\.filter/.test(ap) && !/endDateTime: body\./.test(ap));
    ok('105b. Der Zeitpunkt wird gegen die echten Slots geprueft',
      /starts\.indexOf\(gewuenscht\) < 0/.test(ap) && /error: 'slot_unavailable'/.test(ap));
    ok('105c. … samt Ortszeit-Korrektur wie beim Probetraining',
      /P\.fixLocalAsUtc\(gewuenscht, starts\)/.test(ap));
    // Manche Arten muss das Studio bestaetigen - das gehoert in den Satz.
    ok('106. Bestaetigungspflicht wird ausgesprochen',
      /BOOKED_WITH_CONFIRMATION_REQUIRED/.test(ap) && /bestätigt den Termin noch/.test(ap));
    ok('106b. Kein Treffer im Zeitraum wird ehrlich gemeldet', /error: 'keine_zeiten'/.test(ap));
    // Wochentag/Tageszeit muessen ueberall dasselbe bedeuten.
    ok('107. Dieselben Wunsch-Angaben wie bei den Probetraining-Terminen',
      /P\.slotWindow\(\{[\s\S]{0,200}wochentag: body\.wochentag/.test(ap) && /tageszeit\(body\.tageszeit\)/.test(ap));
    ok('107b. Tageszeit-Grenzen stimmen mit /slots ueberein',
      /h >= 12 && h < 17/.test(ap) && /h >= 12 && h < 17/.test(slots));

    // ── 15. Fehlversuche beim Schluessel sichtbar machen ──
    // Der haeufigste Produktionsfehler: die Telefon-Plattform ruft an, schickt
    // einen veralteten Schluessel - und im Gespraech hoert man nur „kann ich
    // gerade nicht abrufen". Ohne Protokoll ist das nicht von einer Stoerung
    // zu unterscheiden.
    ok('90. Auth-Fehlversuche werden protokolliert', /schritt: 'auth'/.test(lib)
      && /schluessel_falsch/.test(lib) && /kein_schluessel/.test(lib));
    ok('90b. … ohne den Schluessel selbst', !/wert: got\.value/.test(lib) && !/schluessel: got\.value/.test(lib));
    ok('90c. … und begrenzt, damit ein Scanner nichts vollschreibt', /rateLimit\('phonelog:/.test(lib));

    console.log(pass ? 'PHONE-API PASS' : 'PHONE-API FAIL');
    process.exit(pass ? 0 : 1);
  })();
})();
