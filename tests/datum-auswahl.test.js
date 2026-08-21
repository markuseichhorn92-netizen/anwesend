'use strict';
// Welche Datumsauswahl erscheint wo?
//
// Regel: auf dem Telefon die Auswahl des Geraets, am Schreibtisch unsere.
// Nachgebaute Datumsauswahlen laufen dem System hinterher - sie kennen die
// Wischgesten nicht, brechen mit jeder Systemversion anders und muessen
// Barrierefreiheit einzeln nachruesten. Umgekehrt ist das native Feld mit Maus
// und Tastatur umstaendlich; dort ist Tippen bzw. ein Monatsraster schneller.
//
// Das laesst sich NICHT am Text der Datei pruefen: die Weiche fragt
// `matchMedia('(hover:hover) and (pointer:fine)')`. Also im echten Browser,
// einmal als Schreibtisch und einmal als Telefon.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden – die Datumsauswahl wurde NICHT geprueft.');
    console.log('DATUM-AUSWAHL PASS (ohne Browser)');
    process.exit(0);
  }

  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    const f = path.join(ROOT, u === '/' ? '/mitglieder.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;

  const b = await chromium.launch({ executablePath: bin });
  const SCHREIBTISCH = { viewport: { width: 1280, height: 900 } };
  const TELEFON = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

  // Eine Seite oeffnen und darin etwas auswerten. Liefert { wert, fehler }.
  const inSeite = async function (datei, opts, fn) {
    const c = await b.newContext(opts);
    const p = await c.newPage();
    const fehler = [];
    p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    await p.goto(basis + datei, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(700);
    let wert = null, geworfen = null;
    try { wert = await p.evaluate(fn); } catch (e) { geworfen = String(e && e.message); }
    await c.close();
    return { wert: wert, fehler: fehler, geworfen: geworfen };
  };

  // ── 1. Mitgliederbereich: das Geburtsdatum beim Anmelden ──
  const dobFeld = function () {
    const f = document.querySelector('#li_dob');
    return f ? { typ: f.getAttribute('type'), rad: !!document.querySelector('.dpTrigger,[data-act="dpOpen"]') } : null;
  };
  let r = await inSeite('/mitglieder.html', TELEFON, dobFeld);
  ok('1. Telefon: das Geburtsdatum nutzt die Systemauswahl',
    r.wert && r.wert.typ === 'date', JSON.stringify(r.wert) + ' ' + (r.geworfen || ''));
  ok('1b. … und nirgends steckt noch ein Rad-Ausloeser', r.wert && r.wert.rad === false, JSON.stringify(r.wert));
  ok('1c. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));

  r = await inSeite('/mitglieder.html', SCHREIBTISCH, dobFeld);
  ok('2. Schreibtisch: dort wird getippt (unsere Variante)',
    r.wert && r.wert.typ === 'text', JSON.stringify(r.wert) + ' ' + (r.geworfen || ''));
  ok('2b. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));

  // ── 2. Team-Backend: dieselbe Regel, andere Umsetzung ──
  // Die Felder liegen hinter der Anmeldung; geprueft wird deshalb der Bauplan.
  const teamFeld = function () {
    const d = document.createElement('div');
    d.innerHTML = dateFieldHTML('probe', '2026-08-21', 'Datum wählen', true);
    const e = d.firstElementChild;
    return { touch: dpTouch(), tag: e.tagName, typ: e.getAttribute('type'), wert: e.getAttribute('value') };
  };
  r = await inSeite('/team-backend.html', TELEFON, teamFeld);
  ok('3. Telefon: das Team-Backend nutzt die Systemauswahl',
    r.wert && r.wert.tag === 'INPUT' && r.wert.typ === 'date', JSON.stringify(r.wert) + ' ' + (r.geworfen || ''));
  ok('3b. … mit dem vorhandenen Datum darin', r.wert && r.wert.wert === '2026-08-21', JSON.stringify(r.wert));

  r = await inSeite('/team-backend.html', SCHREIBTISCH, teamFeld);
  ok('4. Schreibtisch: dort bleibt der Kalender-Popover',
    r.wert && r.wert.tag === 'BUTTON' && r.wert.touch === false, JSON.stringify(r.wert) + ' ' + (r.geworfen || ''));

  // ── 3. Beide Wege liefern dasselbe zurueck ──
  // Sonst haengt an der Geraeteklasse plötzlich ein anderes Datenformat.
  r = await inSeite('/team-backend.html', TELEFON, function () {
    const d = document.createElement('div');
    d.innerHTML = dateFieldHTML('probe', '', 'Datum wählen', true);
    const e = d.firstElementChild;
    document.body.appendChild(e);
    let bekommen = null;
    wireDateField(e, { value: '', min: '2026-01-01', max: '2026-12-31', onPick: function (iso) { bekommen = iso; } });
    e.value = '2026-03-05';
    e.dispatchEvent(new Event('change'));
    return { bekommen: bekommen, min: e.getAttribute('min'), max: e.getAttribute('max') };
  });
  ok('5. Die Systemauswahl meldet das Datum in ISO-Form zurueck',
    r.wert && r.wert.bekommen === '2026-03-05', JSON.stringify(r.wert) + ' ' + (r.geworfen || ''));
  ok('5b. … und die Grenzen kommen am Feld an',
    r.wert && r.wert.min === '2026-01-01' && r.wert.max === '2026-12-31', JSON.stringify(r.wert));

  await b.close();
  server.close();
  console.log(pass ? 'DATUM-AUSWAHL PASS' : 'DATUM-AUSWAHL FAIL');
  process.exit(pass ? 0 : 1);
})();
