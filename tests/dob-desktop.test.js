'use strict';
// Getipptes Geburtsdatum (Desktop).
//
// Auf dem Desktop wird das Datum getippt statt an einem Rad gedreht. Die
// gefaehrliche Stelle ist das Parsen: Ein still akzeptiertes Unsinnsdatum
// bedeutet, dass der Login fehlschlaegt, ohne dass jemand versteht warum -
// Magicline vergleicht dann gegen ein Datum, das es nicht gibt.
//
// Die Funktionen leben im Inline-Skript von mitglieder.html. Herausgeschnitten
// und ausgefuehrt statt nachgebaut: eine Kopie hier wuerde still auseinander-
// laufen, sobald die Seite sich aendert.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

function schneide(name) {
  const start = html.indexOf('function ' + name + '(');
  ok('0. ' + name + ' gefunden', start >= 0);
  if (start < 0) return '';
  // Bis zur schliessenden Klammer auf Spaltenebene zaehlen.
  let tiefe = 0, i = html.indexOf('{', start);
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') tiefe++;
    else if (html[j] === '}') { tiefe--; if (tiefe === 0) return html.slice(start, j + 1); }
  }
  return '';
}

const quelle = schneide('dpDaysIn') + '\n' + schneide('dpParseDE');
// eslint-disable-next-line no-new-func
const { dpParseDE, dpDaysIn } = new Function(quelle + '\nreturn { dpParseDE: dpParseDE, dpDaysIn: dpDaysIn };')();

const heuer = new Date().getFullYear();

(function () {
  // ── 1. Gueltige Eingaben ──
  ok('1. 28.12.1992 wird erkannt', dpParseDE('28121992') === '1992-12-28', dpParseDE('28121992'));
  ok('1b. Punkte im Text stoeren nicht', dpParseDE('28.12.1992') === '1992-12-28');
  ok('1c. Erster Tag im Monat', dpParseDE('01011990') === '1990-01-01');
  ok('1d. Letzter Tag im Dezember', dpParseDE('31122000') === '2000-12-31');

  // ── 2. Schaltjahre ──
  // Der Klassiker, an dem selbstgeschriebene Datumspruefungen scheitern.
  ok('2. 29.02.2000 gibt es (Schaltjahr)', dpParseDE('29022000') === '2000-02-29');
  ok('2b. 29.02.1996 gibt es', dpParseDE('29021996') === '1996-02-29');
  ok('2c. 29.02.1900 gibt es NICHT (keine 400er-Regel)', dpParseDE('29021900') === '', dpParseDE('29021900'));
  ok('2d. 29.02.1999 gibt es nicht', dpParseDE('29021999') === '', dpParseDE('29021999'));
  ok('2e. 30.02. gibt es nie', dpParseDE('30022000') === '');

  // ── 3. Monatslaengen ──
  ok('3. 31.04. gibt es nicht', dpParseDE('31041990') === '', dpParseDE('31041990'));
  ok('3b. 30.04. gibt es', dpParseDE('30041990') === '1990-04-30');
  ok('3c. 31.11. gibt es nicht', dpParseDE('31111990') === '');

  // ── 4. Unsinn wird abgewiesen ──
  ok('4. Monat 13 wird abgewiesen', dpParseDE('01131990') === '');
  ok('4b. Monat 00 wird abgewiesen', dpParseDE('01001990') === '');
  ok('4c. Tag 00 wird abgewiesen', dpParseDE('00121990') === '');
  ok('4d. Tag 32 wird abgewiesen', dpParseDE('32121990') === '');

  // ── 5. Unvollstaendiges bleibt leer ──
  // Wichtig: Waehrend des Tippens darf NICHT halb geraten werden.
  ok('5. Nach zwei Ziffern noch kein Datum', dpParseDE('28') === '');
  ok('5b. Nach vier Ziffern noch kein Datum', dpParseDE('2812') === '');
  ok('5c. Nach sieben Ziffern noch kein Datum', dpParseDE('2812199') === '');
  ok('5d. Leer bleibt leer', dpParseDE('') === '' && dpParseDE(null) === '' && dpParseDE(undefined) === '');
  ok('5e. Buchstaben ergeben nichts', dpParseDE('abcdefgh') === '');
  ok('5f. Zu viele Ziffern ergeben nichts', dpParseDE('281219921') === '');

  // ── 6. Jahresgrenzen ──
  // Ein Geburtsdatum in der Zukunft ist immer ein Tippfehler.
  ok('6. Naechstes Jahr wird abgewiesen', dpParseDE('0101' + (heuer + 1)) === '', dpParseDE('0101' + (heuer + 1)));
  ok('6b. Dieses Jahr ist erlaubt', dpParseDE('0101' + heuer) === heuer + '-01-01');
  ok('6c. 1899 wird abgewiesen', dpParseDE('01011899') === '');
  ok('6d. 1900 ist erlaubt', dpParseDE('01011900') === '1900-01-01');
  // Vertippte Jahre wie „0192" statt „1992" duerfen nicht durchgehen.
  ok('6e. Vertipptes Jahr 0192 wird abgewiesen', dpParseDE('28120192') === '');

  // ── 7. Rueckgabeform ──
  // Der Login schickt das Feld unveraendert an Magicline - es MUSS ISO sein.
  const r = dpParseDE('05061990');
  ok('7. Rueckgabe ist ISO mit fuehrenden Nullen', r === '1990-06-05', r);
  ok('7b. … und laesst sich zurueckrechnen',
    new Date(r + 'T12:00:00Z').getUTCDate() === 5 && new Date(r + 'T12:00:00Z').getUTCMonth() === 5);

  // ── 8. Das Feld selbst ──
  // Zwei Wege, ein Wert: am Schreibtisch getippt, auf dem Telefon die Auswahl
  // des Geraets. Der Rad-Ausloeser darf nirgends mehr auftauchen.
  const feld = html.slice(html.indexOf('function dpField()'), html.indexOf('function dpDesktop()'));
  ok('8. Das Feld hat einen Desktop-Zweig', /dpDesktop\(\)/.test(feld));
  // Grenze der beiden Zweige: die schliessende Klammer des if auf ihrer Ebene.
  // (Nicht die erste `}` im Text suchen - die steckt in einem regulaeren Ausdruck.)
  const schnitt = feld.indexOf('\n    }');
  const desktopZweig = feld.slice(feld.indexOf('if(dpDesktop())'), schnitt);
  ok('8b. … der ein Eingabefeld liefert', /<input id="li_dob"/.test(desktopZweig), desktopZweig.slice(0, 120));
  ok('8c. … und KEINEN Rad-Ausloeser', !/dpTrigger|dpOpen/.test(desktopZweig), desktopZweig.slice(0, 200));
  ok('8d. … mit dem gleichen Eingabestil wie die Nachbarfelder',
    /class="inp"/.test(desktopZweig), desktopZweig.slice(0, 200));
  ok('8e. … und einem Format-Hinweis', /TT\.MM\.JJJJ/.test(desktopZweig));

  // Ein Neuzeichnen mitten im Tippen darf die Eingabe nicht wegreissen. Die
  // Nachbarfelder halten ihren Rohtext im Zustand - dieses muss das auch.
  ok('8f. Der Rohtext liegt im Zustand', /liDobText:''/.test(html));
  ok('8g. … wird beim Tippen mitgeschrieben', /S\.liDobText=el\.value/.test(html));
  ok('8h. … und beim Aufbau bevorzugt', /S\.liDobText\|\|\(mm\?/.test(desktopZweig), desktopZweig.slice(0, 300));

  // Wird das Datum zurueckgesetzt (Aktions-Link-Login), muss der Rohtext mitgehen -
  // sonst steht im Feld noch die alte Eingabe, obwohl der Wert weg ist.
  const resets = (html.match(/S\.liDob='';/g) || []).length;
  const resetsMitText = (html.match(/S\.liDob=''; S\.liDobText='';/g) || []).length;
  ok('8i. Jedes Zuruecksetzen raeumt auch den Rohtext',
    resets > 0 && resets === resetsMitText, resets + ' vs ' + resetsMitText);

  // Die Weiche darf nicht am Betriebssystem haengen, sondern am Zeigegeraet:
  // ein iPad mit Tastatur ist Touch, ein Windows-Rechner mit Touchscreen nicht.
  const weiche = html.slice(html.indexOf('function dpDesktop()'), html.indexOf('function dpParseDE'));
  ok('9. Die Weiche fragt das Zeigegeraet ab',
    /hover:hover/.test(weiche) && /pointer:fine/.test(weiche), weiche.slice(0, 200));
  ok('9b. … und faellt bei Unklarheit auf Touch zurueck',
    /return false;\s*\}\s*catch/.test(weiche) || /catch\(e\)\{ return false; \}/.test(weiche), weiche);

  // ── 10. Auf dem Telefon die Auswahl des Geraets ──
  // Nachgebaute Datumsauswahlen laufen dem System immer hinterher: sie kennen
  // die Wischgesten nicht, brechen mit jeder neuen Systemversion anders und
  // muessen Barrierefreiheit einzeln nachruesten. Also gar nicht erst nachbauen.
  const touchZweig = feld.slice(schnitt);
  ok('10. Der Telefon-Zweig nutzt die Systemauswahl',
    /type="date"/.test(touchZweig), touchZweig.slice(0, 220));
  ok('10b. … mit Grenzen, die kein Geburtsdatum in der Zukunft zulassen',
    /min="1900-01-01"/.test(touchZweig) && /max="'\+esc\(isoToday\(\)\)\+'"/.test(touchZweig), touchZweig.slice(0, 320));
  ok('10c. … und schreibt den Wert in denselben Zustand',
    /window\.__setDobISO/.test(touchZweig) && /window\.__setDobISO=function/.test(html), touchZweig.slice(0, 320));

  // Das Rad ist raus - samt Zustand, Aktionen und CSS. Bliebe es als toter Code
  // stehen, waere beim naechsten Anfassen unklar, welcher Weg denn nun gilt.
  ok('11. Kein Rad mehr im Code',
    !/wheelOverlay|dpUseWheel|dpMount|dpSettle|dpColHtml/.test(html));
  ok('11b. … kein Ausloeser und kein Zustand dafuer',
    !/dpTrigger|data-act="dpOpen"|dp:null/.test(html));
  ok('11c. … und kein verwaistes CSS', !/\.dpSheet|\.dpItem|\.dpSelWrap/.test(html));

  console.log(pass ? 'DOB-DESKTOP PASS' : 'DOB-DESKTOP FAIL');
  process.exit(pass ? 0 : 1);
})();
