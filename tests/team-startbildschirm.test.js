'use strict';
// Der Team-Bereich aufs Handy.
//
// In die Technogym-App laesst sich nichts einbauen - die gehoert Technogym.
// Denselben Zweck erfuellt ein eigenes Symbol auf dem Startbildschirm: dann ist
// der Team-Bereich aus JEDER App einen Druck auf die Home-Taste entfernt, statt
// ueber eine getippte Adresse.
//
// Damit das ueberhaupt geht, muss dreierlei stimmen: das Manifest, die Symbole
// (iOS liest kein Manifest, sondern apple-touch-icon) und ein Hinweis, der den
// Weg zeigt - ohne ihn findet die Funktion niemand. Und: wer ueber den
// versteckten Griff in der App hier landet, braucht einen Weg zurueck.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'team-backend.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Das Manifest ──
let mf = null;
try { mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/team.webmanifest'), 'utf8')); } catch (e) { mf = null; }
ok('1. Es gibt ein lesbares Manifest', !!mf);
ok('1b. … das direkt im Team-Bereich startet', mf && mf.start_url === '/team', mf && mf.start_url);
ok('1c. … und ohne Browserleiste laeuft', mf && mf.display === 'standalone', mf && mf.display);
ok('1d. … mit eigenem Namen (nicht „Mitglieder")',
  mf && /team/i.test(String(mf.name)) && /team/i.test(String(mf.short_name)), JSON.stringify(mf && [mf.name, mf.short_name]));

// Android maskiert Symbole rund. Ohne ein „maskable" wird das Bild beschnitten.
const groessen = (mf && mf.icons || []).map((i) => i.sizes);
ok('2. Symbole in beiden Pflichtgroessen',
  groessen.indexOf('192x192') >= 0 && groessen.indexOf('512x512') >= 0, groessen.join(','));
ok('2b. … eines davon fuer runde Zuschnitte',
  (mf && mf.icons || []).some((i) => String(i.purpose || '').indexOf('maskable') >= 0));
(mf && mf.icons || []).forEach(function (i) {
  const p = path.join(ROOT, String(i.src).replace(/^\//, ''));
  ok('2c. Symbol vorhanden: ' + i.src, fs.existsSync(p) && fs.statSync(p).size > 1000, p);
});

// ── 2. Die Seite verweist darauf ──
ok('3. Die Seite bindet das Manifest ein', /rel="manifest" href="\/assets\/team\.webmanifest"/.test(html));
// iOS liest kein Manifest - ohne apple-touch-icon nimmt es einen Bildschirmausschnitt.
ok('3b. … und hat ein Symbol fuer iOS', /rel="apple-touch-icon" href="\/assets\/team-icon-180\.png"/.test(html));
ok('3c. … laeuft auf iOS ohne Browserleiste', /apple-mobile-web-app-capable" content="yes"/.test(html));
ok('3d. … und heisst dort nicht „Team-Backend"', /apple-mobile-web-app-title" content="Fit-Inn Team"/.test(html));
const applePng = path.join(ROOT, 'assets/team-icon-180.png');
ok('3e. Das iOS-Symbol ist undurchsichtig (iOS legt sonst Schwarz dahinter)',
  (function () { try { return fs.readFileSync(applePng).slice(24, 26)[1] === 2; } catch (e) { return false; } })());

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden – Hinweis und Rueckweg (4–6) wurden NICHT geprueft.');
    console.log(pass ? 'TEAM-STARTBILDSCHIRM PASS (ohne Browser)' : 'TEAM-STARTBILDSCHIRM FAIL');
    process.exit(pass ? 0 : 1);
  }

  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    const f = path.join(ROOT, u === '/team' ? '/team-backend.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    const typ = u.endsWith('.png') ? 'image/png' : (u.endsWith('.webmanifest') ? 'application/manifest+json'
      : (u.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8'));
    res.writeHead(200, { 'Content-Type': typ });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;

  const b = await chromium.launch({ executablePath: bin });
  const oeffne = async function (opts, vorab) {
    const c = await b.newContext(opts);
    const p = await c.newPage();
    const fehler = [];
    p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    if (vorab) await p.addInitScript(vorab);
    await p.goto(basis + '/team', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(500);
    const w = await p.evaluate(function () {
      const t = document.body.innerText;
      return {
        hinweis: /aufs Handy legen/.test(t),
        schritteIos: /Zum Home-Bildschirm/.test(t),
        schritteAndroid: /App installieren/.test(t),
        zurueck: !!Array.prototype.filter.call(document.querySelectorAll('a'), function (a) { return a.getAttribute('href') === '/mitglieder'; }).length,
        zu: !!document.querySelector('[data-hometipoff]'),
      };
    });
    return { p: p, c: c, w: w, fehler: fehler };
  };

  const IPHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
  const ANDROID = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' };
  const SCHREIBTISCH = { viewport: { width: 1280, height: 900 } };

  // ── 3. Der Hinweis erscheint da, wo er etwas bringt ──
  let r = await oeffne(IPHONE);
  ok('4. iPhone: der Weg auf den Startbildschirm wird gezeigt',
    r.w.hinweis && r.w.schritteIos && !r.w.schritteAndroid, JSON.stringify(r.w));
  ok('4b. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));
  // Wer ueber den versteckten Griff in der App landet, braucht einen Weg zurueck.
  ok('4c. … und es geht zurueck in den Mitgliederbereich', r.w.zurueck === true, JSON.stringify(r.w));
  await r.c.close();

  r = await oeffne(ANDROID);
  ok('5. Android: dieselbe Sache, andere Schritte',
    r.w.hinweis && r.w.schritteAndroid && !r.w.schritteIos, JSON.stringify(r.w));
  await r.c.close();

  r = await oeffne(SCHREIBTISCH);
  ok('6. Am Schreibtisch stoert der Hinweis nicht', r.w.hinweis === false, JSON.stringify(r.w));
  await r.c.close();

  // Liegt der Team-Bereich schon als Symbol auf dem Handy, ist der Hinweis
  // erledigt - und der Weg „zurueck zum Mitgliederbereich" wuerde aus der
  // eigenen App herausfuehren.
  r = await oeffne(IPHONE, function () { try { Object.defineProperty(navigator, 'standalone', { get: function () { return true; } }); } catch (e) {} });
  ok('7. Schon installiert: kein Hinweis mehr', r.w.hinweis === false, JSON.stringify(r.w));
  ok('7b. … und kein Weg aus der eigenen App heraus', r.w.zurueck === false, JSON.stringify(r.w));
  await r.c.close();

  // In der nativen Huelle (Mitglieder-App) ist der Hinweis sinnlos - der
  // Rueckweg dagegen genau dort am noetigsten.
  r = await oeffne(IPHONE, function () { window.Capacitor = { platform: 'ios' }; });
  ok('8. In der App: kein Hinweis, aber ein Rueckweg',
    r.w.hinweis === false && r.w.zurueck === true, JSON.stringify(r.w));
  await r.c.close();

  // ── 4. Einmal weggetippt bleibt weg ──
  r = await oeffne(IPHONE);
  await r.p.click('[data-hometipoff]');
  await r.p.waitForTimeout(200);
  const nachher = await r.p.evaluate(function () { return /aufs Handy legen/.test(document.body.innerText); });
  await r.p.reload({ waitUntil: 'domcontentloaded' });
  await r.p.waitForTimeout(400);
  const nachNeuladen = await r.p.evaluate(function () { return /aufs Handy legen/.test(document.body.innerText); });
  ok('9. Weggetippt ist weg', nachher === false, String(nachher));
  ok('9b. … auch nach dem Neuladen', nachNeuladen === false, String(nachNeuladen));
  await r.c.close();

  await b.close();
  server.close();
  console.log(pass ? 'TEAM-STARTBILDSCHIRM PASS' : 'TEAM-STARTBILDSCHIRM FAIL');
  process.exit(pass ? 0 : 1);
})();
