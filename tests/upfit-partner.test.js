'use strict';
// Partner Upfit: Ernaehrung protokollieren im Upfit-Portal von Fit-Inn.
//
// Upfit ist ein fremdes Portal (Up Gesundheit GmbH). Es laesst sich nicht
// einbetten und hat keine Schnittstelle zu uns - also ein Link. Was ein Link
// falsch machen kann, ist ueberschaubar, aber folgenreich:
//
//   - Daten in der Adresse. Eine E-Mail oder Kennung im Link waere eine
//     Datenuebermittlung an einen Dritten, von der niemand eingewilligt hat.
//   - Ein Link, der sich nicht abschalten laesst. Endet die Partnerschaft,
//     muss der Einstieg ohne Deployment verschwinden koennen.
//   - Ein javascript:-Link aus einem manipulierten Cache.
//
// Der Test prueft genau das - und dass der Einstieg an allen vier Stellen
// steht, an denen jemand „protokollieren" will.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const frisch = (rel) => { delete require.cache[path.resolve(ROOT, rel)]; return require(path.resolve(ROOT, rel)); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

const UPFIT = 'https://fit-inn-trier.upfit.io/';

// ── 1. Der Server: eine Adresse, ein Notaus ──
function appInfo() {
  const H = frisch('api/app-info.js');
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; return this; } };
  H({ method: 'GET', headers: {}, url: '/api/app-info' }, res);
  return JSON.parse(res.body);
}
delete process.env.UPFIT_URL; delete process.env.FEATURE_UPFIT;
ok('1. Ohne Variable gilt die Partneradresse', appInfo().partner.upfit === UPFIT, JSON.stringify(appInfo().partner));
process.env.FEATURE_UPFIT = '0';
ok('1b. FEATURE_UPFIT=0 schaltet den Einstieg ab', appInfo().partner.upfit === null, JSON.stringify(appInfo().partner));
delete process.env.FEATURE_UPFIT;
process.env.UPFIT_URL = 'https://beispiel.invalid/portal';
ok('1c. UPFIT_URL ueberschreibt die Adresse', appInfo().partner.upfit === 'https://beispiel.invalid/portal');
process.env.UPFIT_URL = 'http://unsicher.invalid/';
ok('1d. Eine http-Adresse wird nicht uebernommen', appInfo().partner.upfit === UPFIT, appInfo().partner.upfit);
process.env.UPFIT_URL = 'javascript:alert(1)';
ok('1e. Ein javascript:-Wert erst recht nicht', appInfo().partner.upfit === UPFIT, appInfo().partner.upfit);
delete process.env.UPFIT_URL;
ok('1f. Die uebrigen Schalter bleiben unberuehrt', appInfo().features.ern === true && appInfo().features.vital === false);

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.');
    console.log(pass ? 'UPFIT-PARTNER PASS (ohne Browser)' : 'UPFIT-PARTNER FAIL');
    process.exit(pass ? 0 : 1);
  }

  // Der Testserver spielt /api/member/nutrition: einmal eingerichtet, einmal nicht.
  let onboarded = true;
  const heute = (function () { const d = new Date(); const z = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); })();
  const nutri = () => JSON.stringify({
    ok: true, available: true, onboarded: onboarded,
    profile: onboarded ? { goal: 'halten', sex: 'w', height: 170, weight: 70, age: 30, activity: 'moderat', diet: 'omnivor' } : null,
    targets: { kcal: 2000, protein: 120, carbs: 220, fat: 70, water: 2 },
    today: { date: heute, isToday: true, entries: [], totals: { kcal: 0, p: 0, c: 0, f: 0 }, water: 0, waterGoal: 8 },
    streak: 0, pointsToday: 0, vitalPoints: 0, vitalLedger: [], fasting: null, premium: false, tier: 'free',
  });
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    if (u === '/api/member/nutrition') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(nutri()); }
    if (u.indexOf('/api/') === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    const f = path.join(ROOT, u === '/' ? '/mitglieder.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;

  const b = await chromium.launch({ executablePath: bin });
  const oeffne = async function (upfit) {
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await c.newPage();
    const fehler = [];
    p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    await p.addInitScript(function (up) {
      try {
        localStorage.setItem('fi_member_token', 'geheimes-token-1234');
        localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
        localStorage.setItem('fi_flags_srv', JSON.stringify({ ern: true, social: false, demo: false, train: false, vital: false, upfit: up }));
        localStorage.setItem('fi_tour_v1', '1'); localStorage.setItem('fi_welcome_seen', '1');
      } catch (e) {}
    }, upfit);
    await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(900);
    await p.evaluate(function () { const btn = document.querySelector('[data-act="nav"][data-arg="ern"]'); if (btn) btn.click(); });
    await p.waitForTimeout(900);
    return { p: p, c: c, fehler: fehler };
  };
  // Alle Upfit-Links auf der Seite, mit dem, was an ihnen haengt.
  const links = (p) => p.evaluate(function () {
    return Array.prototype.map.call(document.querySelectorAll('[data-upfit]'), function (el) {
      const a = el.tagName === 'A' ? el : el.querySelector('a');
      return { wo: el.getAttribute('data-upfit'), href: a ? a.getAttribute('href') : null, target: a ? a.getAttribute('target') : null, rel: a ? a.getAttribute('rel') : null };
    });
  });

  // ── 2. Eingerichtet: Karte unter dem Protokoll, Zeile im Erfassen-Sheet ──
  let r = await oeffne(UPFIT);
  let l = await links(r.p);
  const dash = l.filter((x) => x.wo === 'dash')[0];
  ok('2. Im „Heute"-Tab steht die Partner-Karte', !!dash, JSON.stringify(l));
  ok('2b. … mit genau der Partneradresse - nichts angehaengt', dash && dash.href === UPFIT, dash && dash.href);
  ok('2c. … die sich in einem neuen Fenster oeffnet', dash && dash.target === '_blank' && /noopener/.test(dash.rel || ''), JSON.stringify(dash));
  ok('2d. Der leere Tag bietet Upfit als Zweitweg an', l.some((x) => x.wo === 'empty' && x.href === UPFIT), JSON.stringify(l));
  ok('2e. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));

  await r.p.evaluate(function () { const btn = document.querySelector('[data-act="ernOpenCapture"]'); if (btn) btn.click(); });
  await r.p.waitForTimeout(500);
  l = await links(r.p);
  const row = l.filter((x) => x.wo === 'row')[0];
  ok('3. Im Erfassen-Sheet steht Upfit neben Foto, Sprache und Barcode', !!row && row.href === UPFIT, JSON.stringify(l));

  // Der Kern: kein einziger Link traegt etwas, das ein Mitglied identifiziert.
  const alleHrefs = l.map((x) => String(x.href || ''));
  ok('4. Kein Link enthaelt Token, E-Mail oder Kennung',
    alleHrefs.every((h) => h === UPFIT), alleHrefs.join(' | '));
  const seite = await r.p.content();
  ok('4b. Das Anmelde-Token steht nirgends in einem Upfit-Link',
    !/upfit\.io[^"']*geheimes-token/.test(seite));

  // „Meine Daten" und die Datenschutzerklaerung nennen den Partner - mit dem
  // richtigen Verantwortlichen. Der Weg dorthin ist der des Mitglieds:
  // Heute -> Mehr -> Meine Daten & Datenschutz -> Datenschutzerklaerung.
  await r.p.evaluate(function () { const btn = document.querySelector('[data-act="ernCloseCapture"]'); if (btn) btn.click(); });
  await r.p.waitForTimeout(300);
  await r.p.evaluate(function () { const btn = document.querySelector('[data-act="ernMoreToggle"]'); if (btn) btn.click(); });
  await r.p.waitForTimeout(300);
  await r.p.evaluate(function () { const btn = document.querySelector('[data-act="ernDataOpen"]'); if (btn) btn.click(); });
  await r.p.waitForTimeout(500);
  const meine = await r.p.evaluate(function () { return document.body.innerText; });
  ok('5. „Meine Daten" nennt den Partner und dessen Verantwortlichen',
    /Partner Upfit/.test(meine) && /Up Gesundheit GmbH/.test(meine) && /nichts/.test(meine), meine.slice(0, 160));
  await r.p.evaluate(function () { const btn = document.querySelector('[data-act="nav"][data-arg="datenschutz"]'); if (btn) btn.click(); });
  await r.p.waitForTimeout(600);
  const recht = await r.p.evaluate(function () { return document.body.innerText; });
  ok('5b. Die Datenschutzerklaerung hat eine eigene Karte dafuer',
    /Partner Upfit \(Ernährung\)/.test(recht) && /Up Gesundheit GmbH/.test(recht) && /keine Daten an Upfit/.test(recht), recht.slice(0, 160));
  await r.c.close();

  // ── 3. Nicht eingerichtet: der Partner-Weg kommt VOR der Einwilligung ──
  onboarded = false;
  r = await oeffne(UPFIT);
  l = await links(r.p);
  const setup = l.filter((x) => x.wo === 'setup')[0];
  ok('6. Im Onboarding gibt es den Weg zu Upfit, bevor jemand uns Gesundheitsdaten gibt',
    !!setup && setup.href === UPFIT && setup.target === '_blank', JSON.stringify(l));
  ok('6b. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));
  await r.c.close();

  // ── 4. Abgeschaltet: nirgends eine Spur ──
  onboarded = true;
  r = await oeffne(null);
  l = await links(r.p);
  await r.p.evaluate(function () { const btn = document.querySelector('[data-act="ernOpenCapture"]'); if (btn) btn.click(); });
  await r.p.waitForTimeout(400);
  const l2 = await links(r.p);
  ok('7. Ohne Adresse vom Server erscheint Upfit nirgends', l.length === 0 && l2.length === 0, JSON.stringify(l.concat(l2)));
  // Sichtbarer Text, nicht der Quelltext - im Skript steht das Wort natuerlich.
  const textAus = await r.p.evaluate(function () { return document.body.innerText; });
  ok('7b. … auch nicht im sichtbaren Text', !/Upfit/.test(textAus));
  await r.c.close();

  // ── 5. Ein manipulierter Cache darf keinen javascript:-Link erzeugen ──
  r = await oeffne('javascript:alert(1)');
  l = await links(r.p);
  ok('8. Ein javascript:-Wert im Cache wird nicht zum Link', l.length === 0, JSON.stringify(l));
  await r.c.close();

  await b.close();
  server.close();
  console.log(pass ? 'UPFIT-PARTNER PASS' : 'UPFIT-PARTNER FAIL');
  process.exit(pass ? 0 : 1);
})();
