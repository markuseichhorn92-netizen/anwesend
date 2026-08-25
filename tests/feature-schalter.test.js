'use strict';
// Abgeschaltete Bereiche: Training und Vital-Check.
//
// Etwas auszublenden heisst nicht, ein paar Kacheln wegzunehmen. In dieser App
// zeigen rund fuenfzehn Stellen auf die beiden Bereiche - Startseite, Coach,
// Ernaehrung, Profil, Suche, Leiste unten, Tour, Onboarding. Wird eine
// vergessen, fuehrt sie ins Leere.
//
// Deshalb steht die eigentliche Sperre in `nav()` und im Bildschirm-Verteiler:
// selbst ein uebersehener Verweis landet auf der Startseite statt in einem
// Bereich, den es nicht mehr geben soll. Der Test prueft beides - dass nichts
// sichtbar bleibt UND dass die Sperre dahinter greift.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Die Sperre selbst ──
// Ohne sie ist alles andere Kosmetik.
ok('1. Der Trainingsbereich ist in nav() gesperrt', /if\(!TRAIN_ON && s==='tag'\) s='home';/.test(html));
ok('1b. Der Vital-Check ebenso', /if\(!VITAL_ON && s==='morning'\) s='home';/.test(html));
ok('1c. … und zusaetzlich im Bildschirm-Verteiler',
  /if\(!TRAIN_ON && S\.screen==='tag'\) S\.screen='home';/.test(html)
  && /if\(!VITAL_ON && S\.screen==='morning'\) S\.screen='home';/.test(html));
// Kein versteckter Testmodus: der Vital-Check erhebt Gesundheitsdaten.
ok('2. Beide haengen am Server-Schalter, nicht an einem Geraete-Trick',
  /var TRAIN_ON = srvFlags\(\)\.train === true;/.test(html) && /var VITAL_ON = srvFlags\(\)\.vital === true;/.test(html));
const appInfo = fs.readFileSync(path.join(ROOT, 'api/app-info.js'), 'utf8');
ok('2b. Der Server liefert die Schalter aus',
  /train: flag\('FEATURE_TRAINING'\)/.test(appInfo) && /vital: flag\('FEATURE_VITAL'\)/.test(appInfo));
ok('2c. … und beide sind ohne Zutun AUS (opt-in)',
  /const flag = \(name\) => process\.env\[name\] === '1';/.test(appInfo));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden – die Oberflaeche wurde NICHT geprueft.');
    console.log(pass ? 'FEATURE-SCHALTER PASS (ohne Browser)' : 'FEATURE-SCHALTER FAIL');
    process.exit(pass ? 0 : 1);
  }

  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    if (u.indexOf('/api/') === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    const f = path.join(ROOT, u === '/' ? '/mitglieder.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;

  const b = await chromium.launch({ executablePath: bin });
  const oeffne = async function (flags) {
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await c.newPage();
    const fehler = [];
    p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    await p.addInitScript(function (fl) {
      try {
        localStorage.setItem('fi_member_token', 'test');
        localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
        localStorage.setItem('fi_flags_srv', JSON.stringify(Object.assign({ ern: true, social: false, demo: false, train: false, vital: false }, fl)));
        localStorage.setItem('fi_tour_v1', '1'); localStorage.setItem('fi_welcome_seen', '1');
      } catch (e) {}
    }, flags);
    await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1100);
    return { p: p, c: c, fehler: fehler };
  };
  const lies = (p) => p.evaluate(function () {
    return {
      leiste: Array.prototype.map.call(document.querySelectorAll('.btmnav [data-arg]'), function (e) { return e.getAttribute('data-arg'); }),
      tag: document.querySelectorAll('[data-act="nav"][data-arg="tag"]').length,
      morning: document.querySelectorAll('[data-act="nav"][data-arg="morning"]').length,
    };
  });

  // ── 3. Abgeschaltet ──
  let r = await oeffne({});
  let w = await lies(r.p);
  ok('3. Ohne Schalter fuehrt nirgends ein Weg ins Training', w.tag === 0, JSON.stringify(w));
  ok('3b. … und keiner in den Vital-Check', w.morning === 0, JSON.stringify(w));
  ok('3c. Die Leiste unten zeigt das Training nicht mehr',
    w.leiste.indexOf('tag') < 0 && w.leiste.length === 4, w.leiste.join(','));
  // Vier Plaetze, keiner doppelt - sonst steht "Termine" zweimal nebeneinander.
  ok('3d. … und kein Platz doppelt', new Set(w.leiste).size === w.leiste.length, w.leiste.join(','));

  // Andere Bereiche muessen ohne die beiden Teile weiterhin sauber zeichnen.
  for (const ziel of ['coach', 'fort', 'ern', 'profil', 'home']) {
    await r.p.evaluate(function (z) { const btn = document.querySelector('[data-act="nav"][data-arg="' + z + '"]'); if (btn) btn.click(); }, ziel);
    await r.p.waitForTimeout(600);
  }
  ok('4. Coach, Fortschritt, Ernaehrung und Profil zeichnen fehlerfrei',
    r.fehler.length === 0, r.fehler.join(' | '));

  // Die Suche darf nicht auf Bereiche zeigen, die es nicht gibt.
  await r.p.evaluate(function () { const btn = document.querySelector('[data-act="findOpen"]'); if (btn) btn.click(); });
  await r.p.waitForTimeout(400);
  const suche = await r.p.evaluate(function () {
    const t = document.body.innerText;
    return { training: /Plan & Einheiten/.test(t), vital: /Puls & Erholung/.test(t) };
  });
  ok('5. Die Suche bietet beides nicht mehr an', suche.training === false && suche.vital === false, JSON.stringify(suche));

  // Und der entscheidende Fall: ein uebersehener Verweis fuehrt trotzdem nicht hin.
  const gelandet = await r.p.evaluate(async function () {
    const btn = document.createElement('button');
    btn.setAttribute('data-act', 'nav'); btn.setAttribute('data-arg', 'tag');
    document.body.appendChild(btn); btn.click();
    await new Promise(function (res) { setTimeout(res, 500); });
    // Auf dem Trainings-Bildschirm gaebe es die Segment-Schalter.
    return { imTraining: !!document.querySelector('[data-act="trainSeg"]') };
  });
  ok('6. Selbst ein untergeschobener Verweis landet nicht im Training',
    gelandet.imTraining === false, JSON.stringify(gelandet));
  await r.c.close();

  // ── 4. Wieder angeschaltet ──
  r = await oeffne({ train: true, vital: true });
  w = await lies(r.p);
  ok('7. Mit Schalter ist das Training wieder da',
    w.tag > 0 && w.leiste.indexOf('tag') >= 0, JSON.stringify(w));
  ok('7b. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));
  await r.c.close();

  await b.close();
  server.close();
  console.log(pass ? 'FEATURE-SCHALTER PASS' : 'FEATURE-SCHALTER FAIL');
  process.exit(pass ? 0 : 1);
})();
