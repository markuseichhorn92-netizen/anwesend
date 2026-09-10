'use strict';
// Das Vitalalter ist weg - komplett, nicht ausgeblendet.
//
// Es war eine Schaetzung aus Besuchen, Einheiten, Koerperwerten und einer
// Lebensstil-Selbstauskunft. Mit Training und Ernaehrung ausserhalb der App war
// die Rechnung nur noch Fassade, und eine Zahl, die wie ein Befund aussieht, darf
// nicht auf Fassade stehen. Der Test prueft, dass nichts davon uebrig ist:
// keine Karte, keine Rechnung, keine Selbstauskunft, keine Erwaehnung - und dass
// die Bildschirme, auf denen es stand, ohne Fehler weiter zeichnen.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Im Quelltext ist nichts uebrig ──
ok('1. Keine Vitalalter-Rechnung mehr', !/function vitalAge\(|vitalAge\(/.test(html));
ok('1b. Keine Karten dafuer (Start, Fortschritt, Coach)', !/homeVitalCard|vitalAgeCard|coachVitalHero/.test(html));
ok('1c. Keine Lebensstil-Selbstauskunft mehr (sie speiste nur das Vitalalter)', !/vitalLifestyleForm|lsConsent|lsSet:function/.test(html));
ok('1d. Kein Aktivitaets-Alter in vitalsData', !/fitAge|Aktivitäts-Alter/.test(html));
ok('1e. Das Wort taucht nirgends mehr auf - auch nicht in Tour, Hub oder Suche', html.indexOf('Vitalalter') < 0 && html.indexOf('vitalalter') < 0 && !/#homeVital/.test(html));
// Der Einwilligungstext darf das Vitalalter nicht mehr versprechen - geprueft an
// den Feldern, die Mitglieder wirklich sehen (nicht am Quelltext samt Kommentaren).
const ls = require(path.join(ROOT, 'lib/privacy.js')).DEFINITIONS.lifestyle_health;
ok('1f. Der Einwilligungstext zur Lebensstil-Angabe nennt kein Vitalalter mehr',
  !!ls && !/Vitalalter/.test(ls.purpose) && !/Vitalalter/.test(ls.text) && /Wellness/.test(ls.text), JSON.stringify(ls && [ls.purpose, ls.text]));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.');
    console.log(pass ? 'VITALALTER-ENTFERNT PASS (ohne Browser)' : 'VITALALTER-ENTFERNT FAIL');
    process.exit(pass ? 0 : 1);
  }

  // Ein Mitglied MIT Geburtsdatum und Besuchen: frueher haette das die Karte mit der grossen Zahl gezeigt.
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    if (u === '/api/member/me') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, profile: { firstName: 'Mara', lastName: 'M', dateOfBirth: '1988-04-12' } })); }
    if (u === '/api/member/checkins') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, checkins: [{ in: new Date(Date.now() - 864e5).toISOString(), out: new Date(Date.now() - 864e5 + 3600e3).toISOString() }, { in: new Date(Date.now() - 4 * 864e5).toISOString() }] })); }
    if (u.indexOf('/api/') === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    const f = path.join(ROOT, u === '/' ? '/mitglieder.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;

  const b = await chromium.launch({ executablePath: bin });
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await c.newPage();
  const fehler = [];
  p.on('pageerror', function (e) { fehler.push(String(e.message)); });
  await p.addInitScript(function () {
    try {
      localStorage.setItem('fi_member_token', 'test');
      localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
      localStorage.setItem('fi_flags_srv', JSON.stringify({ ern: false, social: false, demo: false, train: false, vital: false, abo: false, upfit: 'https://fit-inn-trier.upfit.io/' }));
      localStorage.setItem('fi_tour_v1', '1'); localStorage.setItem('fi_welcome_seen', '1');
    } catch (e) {}
  });
  await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1100);
  const text = () => p.evaluate(function () { return document.body.innerText; });
  const geh = async function (ziel) { await p.evaluate(function (z) { const btn = document.querySelector('[data-act="nav"][data-arg="' + z + '"]'); if (btn) btn.click(); }, ziel); await p.waitForTimeout(700); };

  // ── 2. Die Bildschirme, auf denen es stand ──
  let t = await text();
  ok('2. Startseite: keine Vitalalter-Karte', !/Vitalalter/.test(t) && !(await p.$('#homeVital')));
  await geh('fort');
  t = await text();
  ok('3. Fortschritt: Rang, Punkte, Aktivitaet - kein Vitalalter, keine Lebensstil-Abfrage',
    /Vitalpunkte/.test(t) && /Deine Aktivität/.test(t) && !/Vitalalter|Lebensstil einbeziehen/.test(t), t.slice(0, 200));
  await geh('coach');
  t = await text();
  ok('4. Coach: kein Vitalalter', !/Vitalalter/.test(t));
  await geh('profil');
  t = await text();
  ok('5. Profil-Hub: „Fortschritt" heisst nicht mehr „Vitalitaet"', /Rang, Punkte & Aktivität/.test(t) && !/Vitalität|Vitalalter/.test(t), t.slice(0, 200));
  await geh('home');
  ok('6. … und alle vier Bildschirme zeichnen ohne Skriptfehler', fehler.length === 0, fehler.join(' | '));

  await c.close(); await b.close(); server.close();
  console.log(pass ? 'VITALALTER-ENTFERNT PASS' : 'VITALALTER-ENTFERNT FAIL');
  process.exit(pass ? 0 : 1);
})();
