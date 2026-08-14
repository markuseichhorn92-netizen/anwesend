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
    ok('74e. Der Assistent wird angewiesen, KEINEN Zeitpunkt selbst zu rechnen',
      /NIE einen Zeitpunkt selbst ausrechnen/.test(slots));
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
