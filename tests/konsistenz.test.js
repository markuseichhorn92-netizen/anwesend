'use strict';
// Konsistenz-Durchgang (September 2026): keine doppelten Kopfzeilen, Linien-Icons in der
// Suche, Rechtsfußzeile nur wo man sie sucht, reCAPTCHA nur wo es läuft, ruhigere Typografie.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };
const count = (re) => (html.match(re) || []).length;

// ── 1. Quelltext ──
ok('1. Mitgliedskarte und Blog-Liste ohne zweite Kopfzeile (backHd) – die App-Leiste trägt Titel + Zurück', !/backHd\('Mitgliedskarte'\)/.test(html) && !/backHd\('Blog'\)\+/.test(html));
ok('1b. reCAPTCHA-Script nicht mehr statisch im <head>, sondern per rcEnsure() bei Bedarf', !/<script src="https:\/\/www\.google\.com\/recaptcha/.test(html) && /function rcEnsure\(\)/.test(html) && /function rcToken\(\)\{ return rcEnsure\(\)/.test(html));
ok('1c. Vertrags-Screen und Vertrags-Assistent laden reCAPTCHA vor und zeigen den Google-Hinweis', /function scrContract\(\)\{[\s\S]{0,200}rcEnsure\(\)/.test(html) && /loadPauseInfo\(\); loadCancelReasons\(\); rcEnsure\(\);/.test(html) && count(/rcNoteHtml\(\)/g) >= 3);
ok('1d. Leistentitel „Vertrag" statt „Vertragsverwal…"', /contract:'Vertrag'/.test(html));
ok('1e. Suche rendert Linien-Icons (FIND_IC), keine Emoji-Kacheln mehr', /svg\(FIND_IC\[it\.arg\]\|\|IC\.help/.test(html) && !/font-size:20px;flex-shrink:0">'\+it\.e\+'/.test(html));
// Typografie: 900 nur noch für Titel/Zahlen. Vor dem Durchgang: 716 Stellen mit 900,
// davon 61 Uppercase-Labels. Die Zahl darf nicht wieder hochwandern.
const inline = html.slice(html.indexOf('</style>'));
const n900 = (inline.match(/font-weight:900/g) || []).length;
const upper900 = (inline.match(/style="[^"]*font-weight:900[^"]*text-transform:uppercase[^"]*"/g) || []).length + (inline.match(/style="[^"]*text-transform:uppercase[^"]*font-weight:900[^"]*"/g) || []).length;
ok('1f. Inline-Gewicht 900 bleibt selten (' + n900 + ' Stellen, Grenze 400) und nie auf Uppercase-Labels (' + upper900 + ')', n900 <= 400 && upper900 === 0);
ok('1g. Fußzeilen-Trennpunkte und reCAPTCHA-Hinweis nutzen Tokens, keine festen Grautöne', /\.legalfoot span\{color:var\(--text-soft\)/.test(html) && /\.rc-note\{[^}]*color:var\(--text-soft\)/.test(html));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.');
    console.log(pass ? 'KONSISTENZ PASS (ohne Browser)' : 'KONSISTENZ FAIL');
    process.exit(pass ? 0 : 1);
  }
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    const J = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u === '/api/member/me') return J({ ok: true, profile: { firstName: 'Mara', lastName: 'M', customerNumber: '10234' }, contract: { rateName: 'Flex 12', active: true, startDate: '1. April 2025', endDate: '31. März 2027', nextCancellationDate: '31. März 2027' } });
    if (u.indexOf('/api/') === 0) return J({ ok: true });
    const f = path.join(ROOT, u === '/' ? '/mitglieder.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : (u.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8') });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;
  const b = await chromium.launch({ executablePath: bin });
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await c.newPage();
  const fehler = []; p.on('pageerror', function (e) { fehler.push(String(e.message)); });
  const google = []; await p.route(/google\.com|gstatic|recaptcha/, function (r) { google.push(r.request().url()); r.abort().catch(function () {}); });
  await p.addInitScript(function () {
    try {
      localStorage.setItem('fi_member_token', 'test');
      localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
      localStorage.setItem('fi_flags_srv', JSON.stringify({ ern: false, social: false, demo: false, train: false, vital: false, abo: false, upfit: 'https://fit-inn-trier.upfit.io/' }));
      ['fi_tour_v1', 'fi_welcome_seen', 'fi_tour_coach_v1', 'fi_geoci_v1'].forEach(function (k) { localStorage.setItem(k, '1'); });
    } catch (e) {}
  });
  await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1000);
  const click = (sel) => p.evaluate(function (s) { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  const vis = (sel) => p.evaluate(function (s) { const el = document.querySelector(s); return !!el && el.offsetParent !== null; }, sel);

  ok('2. Startseite: kein reCAPTCHA geladen, keine Rechtsfußzeile', google.length === 0 && !(await vis('.legalfoot')), google.join(','));
  await click('[data-act="avatarTap"]'); await p.waitForTimeout(500);
  const pf = await p.evaluate(function () { const lf = document.querySelector('.legalfoot'); const hs = Array.from(document.querySelectorAll('.legalfoot a')).filter(function (a) { return a.offsetParent !== null; }).map(function (a) { return Math.round(a.getBoundingClientRect().height); }); return { vis: !!lf && lf.offsetParent !== null, legalOn: document.body.classList.contains('legalOn'), screen: document.querySelector('#appbar .ab-title') ? document.querySelector('#appbar .ab-title').textContent : null, minH: hs.length ? Math.min.apply(null, hs) : 0 }; });
  ok('2b. Profil-Hub: Rechtsfußzeile sichtbar, Links ≥ 36 px hoch', pf.vis && pf.minH >= 36, JSON.stringify(pf));
  await click('[data-act="nav"][data-arg="card"]'); await p.waitForTimeout(500);
  const card = await p.evaluate(function () { return { hd: document.querySelectorAll('#app .hd').length, title: (document.querySelector('#appbar .ab-title') || {}).textContent, foot: !!document.querySelector('.legalfoot') && document.querySelector('.legalfoot').offsetParent !== null, t: document.body.innerText }; });
  ok('2c. Mitgliedskarte: nur EINE Kopfzeile (App-Leiste), Untertitel statt zweitem Titel, keine Fußzeile', card.hd === 0 && card.title === 'Mitgliedskarte' && /Dein digitaler Ausweis/.test(card.t) && !card.foot, JSON.stringify({ hd: card.hd, title: card.title, foot: card.foot }));
  await click('[data-act="nav"][data-arg="contract"]'); await p.waitForTimeout(700);
  const ct = await p.evaluate(function () { return { title: (document.querySelector('#appbar .ab-title') || {}).textContent, note: /Geschützt durch reCAPTCHA/.test(document.body.innerText), script: !!document.querySelector('script[src*="recaptcha"]') }; });
  ok('2d. Vertrag: Leiste „Vertrag", reCAPTCHA jetzt angefordert und Google-Hinweis auf dem Screen', ct.title === 'Vertrag' && ct.note && ct.script && google.length >= 1, JSON.stringify(ct));
  await click('[data-act="findOpen"]'); await p.waitForTimeout(400);
  const find = await p.evaluate(function () { const rows = Array.from(document.querySelectorAll('[data-act="findGo"]')); return { n: rows.length, svg: rows.filter(function (r) { return !!r.querySelector('svg'); }).length, emoji: rows.filter(function (r) { return /[\u{1F300}-\u{1FAFF}☀-➿]/u.test(r.textContent); }).length }; });
  ok('2e. Suche: jede Zeile mit Linien-Icon, keine Emoji', find.n >= 5 && find.svg === find.n && find.emoji === 0, JSON.stringify(find));
  ok('2f. Keine Skriptfehler', fehler.length === 0, fehler.join(' | '));
  await c.close(); await b.close(); server.close();
  console.log(pass ? 'KONSISTENZ PASS' : 'KONSISTENZ FAIL');
  process.exit(pass ? 0 : 1);
})();
