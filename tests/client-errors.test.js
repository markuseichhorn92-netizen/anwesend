'use strict';
// Fehlermeldungen aus der App duerfen nichts Personenbezogenes oder Geheimes in die
// Logs tragen (docs/KI-GOVERNANCE.md: keine Prompts, Antworten oder Gesundheitsdaten).
// Hier wird belegt, dass die Aufbereitung genau das verhindert - und trotzdem etwas
// Brauchbares uebrig laesst.
const CE = require('../lib/clientErrors');

function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── Was auf keinen Fall durchkommen darf ──
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  ok('1. JWT wird maskiert', CE.maskiere('Fehler bei ' + jwt).indexOf('eyJ') < 0, CE.maskiere(jwt));
  // Der Beispielschluessel aus der AWS-Doku wird zur Laufzeit zusammengesetzt: als Literal
  // wuerde ihn der Secret-Scan (npm run scan) zu Recht als moegliches Secret melden.
  const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
  ok('2. AWS-Schluessel wird maskiert', CE.maskiere(awsKey + ' kaputt').indexOf('AKIA') < 0);
  ok('3. Bearer-Token wird maskiert', /Bearer \[token\]/.test(CE.maskiere('Authorization: Bearer abc123def456ghi789')));
  ok('4. Stripe-Schluessel wird maskiert', CE.maskiere('sk_live_abc123XYZ789').indexOf('sk_live_abc') < 0);
  ok('5. E-Mail wird maskiert', CE.maskiere('anna.mueller@example.com meldet').indexOf('@example.com') < 0);
  ok('6. IBAN wird maskiert', CE.maskiere('DE89 3704 0044 0532 0130 00').indexOf('3704') < 0);
  ok('7. Telefonnummer wird maskiert', CE.maskiere('Ruf 0651 308524 an').indexOf('308524') < 0);
  ok('8. Mitgliedsnummer wird maskiert', CE.maskiere('Kunde 1004537 fehlt').indexOf('1004537') < 0);
  ok('9. eingebettetes Foto wird maskiert', CE.maskiere('img data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==').indexOf('iVBOR') < 0);

  // ── Was erhalten bleiben muss, sonst ist das Log wertlos ──
  const m = CE.maskiere('TypeError: ernShopItemFetch is not a function');
  ok('10. Funktionsname bleibt lesbar', /ernShopItemFetch/.test(m), m);
  ok('11. Fehlertyp bleibt lesbar', /TypeError/.test(m));
  ok('12. kurze Zahlen bleiben (Zeilennummern o.ä.)', /42/.test(CE.maskiere('Zeile 42 kaputt')));

  // ── Aufbereitung ──
  const rec = CE.aufbereiten({
    type: 'fehler', message: 'TypeError: x is not a function bei anna@example.com',
    source: 'https://mitglieder.fit-inn-trier.de/mitglieder.html?go=ern&code=GEHEIM123',
    line: 7421, col: 33, screen: 'ern', version: 'Version 2026-07-22', ua: 'Mozilla/5.0 (Linux; Android 15; SM-A566B)',
    stack: 'at ernShopItemFetch (mitglieder.html:7421:33)',
  });
  ok('13. Datensatz entsteht', !!rec);
  ok('14. E-Mail auch im Datensatz weg', rec && rec.message.indexOf('@example.com') < 0, rec && rec.message);
  ok('15. Adresszeile ohne Parameter', rec && rec.quelle.indexOf('code=') < 0 && rec.quelle.indexOf('?') < 0, rec && rec.quelle);
  ok('16. Zeile/Spalte erhalten', rec && rec.zeile === 7421 && rec.spalte === 33);
  ok('17. Screen erhalten', rec && rec.screen === 'ern');
  ok('18. Geraet erkennbar (fuer Android-Fehler wichtig)', rec && /SM-A566B/.test(rec.ua), rec && rec.ua);
  // Die Versionsangabe kommt aus unserem Build-Vermerk. Wuerde sie durch die Maskierung
  // laufen, verschluckte die Telefonnummer-Regel das Datum - und man wuesste nicht mehr,
  // welchen Stand das Geraet hat.
  ok('18b. Versionsdatum bleibt lesbar', rec && /2026-07-22/.test(rec.version), rec && rec.version);
  ok('18c. Version wird auf harmlose Zeichen begrenzt',
    CE.aufbereiten({ message: 'x', version: 'v1 <script>alert(1)</script>' }).version.indexOf('<') < 0);

  // ── Grenzen und Missbrauch ──
  const lang = CE.aufbereiten({ message: 'A'.repeat(5000) });
  ok('19. Meldung wird gekappt', lang && lang.message.length <= CE.MAX_MSG, lang && String(lang.message.length));
  ok('20. leere Meldung -> nichts loggen', CE.aufbereiten({ message: '   ' }) === null);
  ok('21. fehlender Body -> nichts loggen', CE.aufbereiten(undefined) === null && CE.aufbereiten(null) === null);
  const boes = CE.aufbereiten({ message: 'x', screen: '<script>alert(1)</script>', line: 'abc', col: -5, type: 'beliebig' });
  ok('22. Screen wird auf harmlose Zeichen begrenzt', boes && boes.screen === 'scriptalert1script', boes && boes.screen);
  ok('23. unbrauchbare Zeile -> 0', boes && boes.zeile === 0 && boes.spalte === 0);
  ok('24. unbekannter Typ -> Standardwert', boes && boes.typ === 'fehler', boes && boes.typ);

  // ── Logzeile ──
  const zeile = CE.alsLogZeile(rec);
  ok('25. Logzeile ist einzeilig', zeile.indexOf('\n') < 0);
  ok('26. Logzeile klar erkennbar', zeile.indexOf('[client-fehler]') === 0);
  ok('27. Logzeile traegt keine E-Mail', zeile.indexOf('@example.com') < 0);
  ok('28. Logzeile ohne Datensatz bleibt leer', CE.alsLogZeile(null) === '');

  // Der Endpunkt darf die Mitglieds-ID nicht mitloggen: pruefen, dass die Aufbereitung
  // gar kein Feld dafuer anbietet.
  ok('29. kein Feld fuer Mitglieds-ID im Datensatz', rec && !('memberId' in rec) && !('id' in rec));

  console.log(pass ? 'CLIENT-ERRORS PASS' : 'CLIENT-ERRORS FAIL');
  process.exit(pass ? 0 : 1);
}
run();
