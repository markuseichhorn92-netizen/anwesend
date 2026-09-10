'use strict';
// Partner Upfit: Ernaehrung protokollieren im Upfit-Portal von Fit-Inn.
//
// Seit September 2026 ist das EIGENE Ernaehrungsmodul aus: Der Tab „Ernaehrung"
// zeigt nur noch den Partner. Upfit ist ein fremdes Portal (Up Gesundheit GmbH),
// nicht einbettbar, ohne Schnittstelle - also ein Link. Was ein Link falsch
// machen kann, ist ueberschaubar, aber folgenreich:
//
//   - Daten in der Adresse. Eine E-Mail oder Kennung im Link waere eine
//     Datenuebermittlung an einen Dritten, von der niemand eingewilligt hat.
//   - Ein Link, der sich nicht abschalten laesst. Endet die Partnerschaft,
//     muss der Einstieg ohne Deployment verschwinden koennen.
//   - Ein javascript:-Link aus einem manipulierten Cache.
//   - Ein Rest des eigenen Moduls, der noch durchscheint - „Essen erfassen",
//     ein Tagesziel, ein Premium-Angebot fuer etwas, das es nicht mehr gibt.
//
// Und in der nativen App soll Upfit im In-App-Browser aufgehen (das Mitglied
// bleibt in der App), ohne dass die Seite selbst irgendwohin navigiert.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const frisch = (rel) => { delete require.cache[path.resolve(ROOT, rel)]; delete require.cache[path.resolve(ROOT, 'lib/features.js')]; return require(path.resolve(ROOT, rel)); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

const UPFIT = 'https://fit-inn-trier.upfit.io/';

// ── 1. Der Server: eine Adresse, ein Notaus, das eigene Modul opt-in ──
function appInfo() {
  const H = frisch('api/app-info.js');
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; return this; } };
  H({ method: 'GET', headers: {}, url: '/api/app-info' }, res);
  return JSON.parse(res.body);
}
delete process.env.UPFIT_URL; delete process.env.FEATURE_UPFIT; delete process.env.FEATURE_ERN;
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
ok('1f. Das eigene Ernaehrungsmodul ist ohne Zutun AUS', appInfo().features.ern === false && appInfo().features.vital === false);
process.env.FEATURE_ERN = '1';
ok('1g. … und kommt mit FEATURE_ERN=1 zurueck', appInfo().features.ern === true);
delete process.env.FEATURE_ERN;

// Die Crons und der WhatsApp-Agent haengen am selben Schalter - sonst schickt
// der Cron Ernaehrungs-Pushes zu einem Bereich, den die App nicht mehr zeigt.
//
// Beweiskraeftig nur so: Session und fetch werden nachgestellt, und gezaehlt
// wird, ob das Ernaehrungs-API ueberhaupt gerufen wird. „handled:false" allein
// beweist nichts - das liefert auch ein fehlendes Token.
(async function serverseite() {
  const rufe = [];
  const mPfad = path.resolve(ROOT, 'lib/members.js');
  const echtM = require.cache[mPfad];
  require.cache[mPfad] = { id: mPfad, filename: mPfad, loaded: true, exports: { createSession: async () => 'sitzung-1', rateLimit: async () => true, readBody: async () => ({}) } };
  const echtFetch = global.fetch;
  global.fetch = async function (url) {
    rufe.push(String(url));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, items: [{ name: 'Apfel', kcal: 52 }], added: [] }), text: async () => '{"ok":true}' };
  };
  try {
    delete process.env.FEATURE_ERN;
    const WA = frisch('lib/waAgent.js');
    const namen = (WA.ACTION_TOOLS || []).map((t) => t.name);
    ok('1h. Der WhatsApp-Agent kennt die Ernaehrungs-Werkzeuge weiterhin (fuer FEATURE_ERN=1)', namen.indexOf('log_food') >= 0);
    const foto = await WA.logFoodPhoto({ req: { headers: { host: 'x' } }, memberId: 'm1', base64: 'abc' });
    ok('1i. Ohne Modul geht kein Foto ins Tagebuch - kein einziger Aufruf ans Ernaehrungs-API',
      foto && foto.handled === false && rufe.length === 0, JSON.stringify({ foto: foto, rufe: rufe }));
    process.env.FEATURE_ERN = '1';
    await WA.logFoodPhoto({ req: { headers: { host: 'x' } }, memberId: 'm1', base64: 'abc' });
    ok('1j. … mit FEATURE_ERN=1 dagegen schon (der Stub greift also)', rufe.some((u) => /\/api\/member\/nutrition/.test(u)), rufe.join(' | '));
  } finally {
    delete process.env.FEATURE_ERN;
    global.fetch = echtFetch;
    if (echtM) require.cache[mPfad] = echtM; else delete require.cache[mPfad];
  }
})();

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
  // opts: { upfit, ern, nativ, fensterStub }
  const oeffne = async function (opts) {
    opts = opts || {};
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await c.newPage();
    const fehler = [];
    p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    await p.addInitScript(function (o) {
      try {
        localStorage.setItem('fi_member_token', 'geheimes-token-1234');
        localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
        localStorage.setItem('fi_flags_srv', JSON.stringify({ ern: !!o.ern, social: false, demo: false, train: false, vital: false, upfit: o.upfit }));
        localStorage.setItem('fi_tour_v1', '1'); localStorage.setItem('fi_welcome_seen', '1');
      } catch (e) {}
      // Native Huelle nachgestellt: nur das Browser-Plugin, sonst nichts.
      if (o.nativ) {
        window.Capacitor = {
          isNativePlatform: function () { return true; },
          getPlatform: function () { return 'ios'; },
          isPluginAvailable: function (n) { return n === 'Browser'; },
          registerPlugin: function (n) { return { open: function (a) { window.__geoeffnet = { plugin: n, url: a.url, toolbar: a.toolbarColor }; return Promise.resolve(); } }; },
          Plugins: {},
        };
      }
      if (o.fensterStub) { window.open = function (u, t) { window.__geoeffnet = { fenster: true, url: u, target: t }; return {}; }; }
    }, opts);
    await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(900);
    return { p: p, c: c, fehler: fehler };
  };
  const zuErn = async function (p) {
    await p.evaluate(function () { const btn = document.querySelector('[data-act="nav"][data-arg="ern"]'); if (btn) btn.click(); });
    await p.waitForTimeout(900);
  };
  const klick = async function (p, sel, ms) {
    await p.evaluate(function (s) { const el = document.querySelector(s); if (el) el.click(); }, sel);
    await p.waitForTimeout(ms || 400);
  };
  const text = (p) => p.evaluate(function () { return document.body.innerText; });
  // Alle Upfit-Links auf der Seite, mit dem, was an ihnen haengt.
  const links = (p) => p.evaluate(function () {
    return Array.prototype.map.call(document.querySelectorAll('[data-upfit]'), function (el) {
      const a = el.tagName === 'A' ? el : el.querySelector('a');
      return { wo: el.getAttribute('data-upfit'), href: a ? a.getAttribute('href') : null, target: a ? a.getAttribute('target') : null, rel: a ? a.getAttribute('rel') : null, act: a ? a.getAttribute('data-act') : null };
    });
  });

  // ── A. Eigenes Modul AN (FEATURE_ERN=1) + Upfit: beides nebeneinander ──
  let r = await oeffne({ upfit: UPFIT, ern: true });
  await zuErn(r.p);
  let l = await links(r.p);
  const dash = l.filter((x) => x.wo === 'dash')[0];
  ok('2. Mit eigenem Modul steht die Partner-Karte im „Heute"-Tab', !!dash, JSON.stringify(l));
  ok('2b. … mit genau der Partneradresse - nichts angehaengt', dash && dash.href === UPFIT, dash && dash.href);
  ok('2c. … in neuem Fenster, mit Handler fuer den In-App-Browser', dash && dash.target === '_blank' && /noopener/.test(dash.rel || '') && dash.act === 'upfitOpen', JSON.stringify(dash));
  ok('2d. Der leere Tag bietet Upfit als Zweitweg an', l.some((x) => x.wo === 'empty' && x.href === UPFIT), JSON.stringify(l));
  await klick(r.p, '[data-act="ernOpenCapture"]', 500);
  l = await links(r.p);
  ok('3. Im Erfassen-Sheet steht Upfit neben Foto, Sprache und Barcode', l.some((x) => x.wo === 'row' && x.href === UPFIT), JSON.stringify(l));
  ok('4. Kein Link enthaelt Token, E-Mail oder Kennung', l.every((x) => x.href === UPFIT), l.map((x) => x.href).join(' | '));
  ok('4b. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));
  await r.c.close();

  onboarded = false;
  r = await oeffne({ upfit: UPFIT, ern: true });
  await zuErn(r.p);
  l = await links(r.p);
  ok('5. Im Onboarding gibt es den Weg zu Upfit, bevor jemand uns Gesundheitsdaten gibt',
    l.some((x) => x.wo === 'setup' && x.href === UPFIT && x.target === '_blank'), JSON.stringify(l));
  await r.c.close();
  onboarded = true;

  // ── B. Der Regelfall seit September 2026: eigenes Modul AUS, nur Upfit ──
  r = await oeffne({ upfit: UPFIT, ern: false });
  const tab = await r.p.evaluate(function () { return !!document.querySelector('.btmnav [data-act="nav"][data-arg="ern"]'); });
  ok('6. Der Tab „Ernaehrung" bleibt in der Leiste', tab === true);
  const home = await links(r.p);
  ok('6b. Die Startseite zeigt den Partner kompakt', home.some((x) => x.wo === 'home' && x.href === UPFIT), JSON.stringify(home));
  await zuErn(r.p);
  l = await links(r.p);
  const hero = l.filter((x) => x.wo === 'hero')[0];
  ok('7. Der Tab zeigt NUR den Partner', !!hero && hero.href === UPFIT && hero.act === 'upfitOpen', JSON.stringify(l));
  // Der Kern dieses Modus: nichts vom eigenen Modul scheint durch.
  const eigenes = await r.p.evaluate(function () {
    return {
      erfassen: document.querySelectorAll('[data-act="ernOpenCapture"]').length,
      tabs: document.querySelectorAll('[data-act="ernTab"]').length,
      wasser: document.querySelectorAll('[data-act="ernWater"]').length,
    };
  });
  let t = await text(r.p);
  ok('7b. Kein „Essen erfassen", kein Tagesziel, kein Wasser, keine Reiter',
    eigenes.erfassen === 0 && eigenes.tabs === 0 && eigenes.wasser === 0 && !/Essen erfassen|Tagesziel|Heute gegessen|Intervallfasten/.test(t), JSON.stringify(eigenes));
  ok('7c. … aber der Hinweis, dass nichts an Upfit geht', /keine Daten an Upfit/.test(t));
  ok('7d. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));

  // Das Plus-Menue: „Ernaehrung protokollieren" fuehrt zu Upfit, nicht ins eigene Erfassen.
  await klick(r.p, '.btmnav [data-act="qaOpen"]', 400);
  const plus = await r.p.evaluate(function () {
    return { upfit: !!document.querySelector('[data-act="qaGo"][data-arg="upfit"]'), erfassen: !!document.querySelector('[data-act="qaGo"][data-arg="erfassen"]') };
  });
  ok('8. Im Plus-Menue fuehrt „Ernaehrung" zu Upfit statt ins eigene Erfassen', plus.upfit === true && plus.erfassen === false, JSON.stringify(plus));
  await klick(r.p, '[data-act="qaClose"]', 300);

  // Die alten Daten bleiben erreichbar - Export und Loeschung sind Pflicht, auch
  // wenn das Modul weg ist. Ein Premium-Angebot dafuer gibt es aber nicht mehr.
  await klick(r.p, '[data-act="ernDataOpen"]', 500);
  const daten = await r.p.evaluate(function () {
    return { exportieren: !!document.querySelector('[data-act="ernDataExport"]'), loeschen: !!document.querySelector('[data-act="ernDelAll"]') };
  });
  t = await text(r.p);
  ok('9. Fruehere Daten lassen sich weiterhin exportieren und loeschen', daten.exportieren === true && daten.loeschen === true, JSON.stringify(daten));
  ok('9b. … ohne Premium-Angebot fuer ein Modul, das es nicht mehr gibt', !/Premium holen|testen/.test(t), t.slice(0, 200));
  await klick(r.p, '[data-act="ernDataClose"]', 500);
  l = await links(r.p);
  ok('9c. Zurueck landet man wieder beim Partner', l.some((x) => x.wo === 'hero'), JSON.stringify(l));
  ok('9d. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));
  await r.c.close();

  // ── C. In-App-Browser in der nativen Huelle ──
  r = await oeffne({ upfit: UPFIT, ern: false, nativ: true });
  await zuErn(r.p);
  const vorher = r.p.url();
  await klick(r.p, '[data-upfit="hero"] a', 400);
  const nativ = await r.p.evaluate(function () { return window.__geoeffnet || null; });
  ok('10. In der App oeffnet der Knopf den In-App-Browser', !!nativ && nativ.plugin === 'Browser' && nativ.url === UPFIT, JSON.stringify(nativ));
  ok('10b. … in Markenfarbe', nativ && nativ.toolbar === '#0a4958', JSON.stringify(nativ));
  ok('10c. … und die Seite selbst bleibt, wo sie ist', r.p.url() === vorher, r.p.url());
  t = await text(r.p);
  ok('10d. Der Hinweis sagt „in der App"', /Öffnet sich in der App/.test(t));
  ok('10e. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));
  await r.c.close();

  // Ohne Huelle: ein neues Fenster, mit derselben Adresse.
  r = await oeffne({ upfit: UPFIT, ern: false, fensterStub: true });
  await zuErn(r.p);
  await klick(r.p, '[data-upfit="hero"] a', 400);
  const web = await r.p.evaluate(function () { return window.__geoeffnet || null; });
  ok('11. Im Web oeffnet sich ein neues Fenster mit genau der Adresse', !!web && web.fenster === true && web.url === UPFIT && web.target === '_blank', JSON.stringify(web));
  await r.c.close();

  // ── D. Abgeschaltet: nirgends eine Spur ──
  r = await oeffne({ upfit: null, ern: false });
  const ohne = await r.p.evaluate(function () {
    return { tab: !!document.querySelector('.btmnav [data-act="nav"][data-arg="ern"]'), termine: !!document.querySelector('.btmnav [data-act="nav"][data-arg="appt"]'), upfit: document.querySelectorAll('[data-upfit]').length };
  });
  t = await text(r.p);
  ok('12. Ohne Partner UND ohne Modul rueckt „Termine" in die Leiste', ohne.tab === false && ohne.termine === true && ohne.upfit === 0, JSON.stringify(ohne));
  ok('12b. … und Upfit steht nirgends im sichtbaren Text', !/Upfit/.test(t));
  await r.c.close();

  r = await oeffne({ upfit: null, ern: true });
  await zuErn(r.p);
  await klick(r.p, '[data-act="ernOpenCapture"]', 400);
  ok('12c. Ohne Partneradresse erscheint Upfit auch im eigenen Modul nirgends', (await links(r.p)).length === 0);
  await r.c.close();

  // ── E. Ein manipulierter Cache darf keinen javascript:-Link erzeugen ──
  r = await oeffne({ upfit: 'javascript:alert(1)', ern: false });
  const js = await r.p.evaluate(function () { return { tab: !!document.querySelector('.btmnav [data-act="nav"][data-arg="ern"]'), links: document.querySelectorAll('[data-upfit]').length }; });
  ok('13. Ein javascript:-Wert im Cache wird weder Link noch Tab', js.tab === false && js.links === 0, JSON.stringify(js));
  await r.c.close();

  await b.close();
  server.close();
  console.log(pass ? 'UPFIT-PARTNER PASS' : 'UPFIT-PARTNER FAIL');
  process.exit(pass ? 0 : 1);
})();
