'use strict';
// Startseite (Umbau September 2026): eine Begrüßung, Einchecken im Hero, Standort-Frage
// schmal darunter, FINN-Tipp genau einmal in der App.
//
// Warum das abgesichert ist: Die Begrüßung stand zweimal untereinander (Leiste + Hero),
// die Standort-Bitte war die erste Karte und füllte auf kleinen Handys den Bildschirm,
// und die Hauptaktion einer Studio-App – Einchecken – war nur im Plus-Menü versteckt.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Quelltext ──
ok('1. Leiste auf der Startseite zeigt nur das Datum (keine ab-greet-Zeile mehr)', !/class="ab-greet"/.test(html) && /data-ab="date"/.test(html));
ok('1b. Hero ist kein <button> um alles (verschachtelte Knöpfe wären ungültig)', /<div data-hero="home"/.test(html) && !/<button[^>]*data-hero="home"/.test(html));
ok('1c. Standort-Frage steht NACH dem Hero, nicht davor', /homeContextHero\(\)\+[^\n]*\n\s*geoAskRow\(\)\+/.test(html));
ok('1d. Fortschritt ohne FINN-Tipp-Streifen', !/subHeader\('Fortschritt'[^\n]*coachTipStrip\(\)/.test(html));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.');
    console.log(pass ? 'STARTSEITE PASS (ohne Browser)' : 'STARTSEITE FAIL');
    process.exit(pass ? 0 : 1);
  }

  const in3 = new Date(Date.now() + 3 * 864e5);
  // Die Besuchsliste ist beim echten Server die Wahrheit: nach einem Check-in taucht er darin
  // auf (sonst räumt ciSyncFromHistory den lokalen Zustand wieder ab). Der Fake macht das nach.
  const srv = { checkins: 0, list: [{ in: new Date(Date.now() - 2 * 864e5).toISOString() }] };
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    const J = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u === '/api/member/me') return J({ ok: true, profile: { firstName: 'Mara', lastName: 'M' }, contract: { rateName: 'Flex 12', active: true } });
    if (u === '/api/member/appointments') return J({ ok: true, appointments: [{ id: 'a1', title: 'Einführungstraining', startDateTime: in3.toISOString() }] });
    if (u === '/api/member/checkins') return J({ ok: true, checkins: srv.list.slice() });
    if (u === '/api/member/checkin' && req.method === 'POST') { srv.checkins++; const at = new Date().toISOString(); srv.list.unshift({ in: at }); return J({ ok: true, at: at }); }
    if (u === '/api/member/checkout' && req.method === 'POST') { if (srv.list[0] && !srv.list[0].out) srv.list[0].out = new Date().toISOString(); return J({ ok: true }); }
    if (u === '/api/member/coach') return J({ ok: true, message: 'Zwei Besuche diese Woche – einer noch.', ai: false });
    if (u.indexOf('/api/') === 0) return J({ ok: true });
    const f = path.join(ROOT, u === '/' ? '/mitglieder.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : (u.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8') });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;
  const b = await chromium.launch({ executablePath: bin });

  async function openPage(vp) {
    const c = await b.newContext({ viewport: vp || { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await c.newPage();
    const fehler = []; p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    await p.addInitScript(function () {
      try {
        localStorage.setItem('fi_member_token', 'test');
        localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
        localStorage.setItem('fi_flags_srv', JSON.stringify({ ern: false, social: false, demo: false, train: false, vital: false, abo: false, upfit: 'https://fit-inn-trier.upfit.io/' }));
        ['fi_tour_v1', 'fi_welcome_seen', 'fi_tour_coach_v1'].forEach(function (k) { localStorage.setItem(k, '1'); });
      } catch (e) {}
    });
    await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1100);
    return { c: c, p: p, fehler: fehler };
  }
  const click = (p, sel) => p.evaluate(function (s) { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);

  // ── 2. Handy 390 px ──
  let m = await openPage();
  const st = await m.p.evaluate(function () {
    const body = document.body.innerText;
    const ab = document.querySelector('#appbar [data-ab="date"]');
    const hero = document.querySelector('[data-hero="home"]');
    const ci = document.querySelector('[data-hero="checkin"]');
    const geo = document.querySelector('[data-home="geo"]');
    const order = hero && geo ? (hero.compareDocumentPosition(geo) & Node.DOCUMENT_POSITION_FOLLOWING) === Node.DOCUMENT_POSITION_FOLLOWING : false;
    return {
      greetings: (body.match(/Guten (Morgen|Tag|Abend)|Gute Nacht/g) || []).length,
      abText: ab ? ab.textContent : null,
      abTitleInAppbar: !!(document.querySelector('#appbar') && /Guten|Gute Nacht/.test(document.querySelector('#appbar').textContent)),
      ciH: ci ? ci.getBoundingClientRect().height : 0,
      ciTop: ci ? ci.getBoundingClientRect().top : 9999,
      appt: (function () { const a = document.querySelector('[data-hero="appt"]'); return a ? a.innerText : ''; })(),
      nested: document.querySelectorAll('[data-hero="home"] button button').length,
      geoAfterHero: order,
      geoH: geo ? geo.getBoundingClientRect().height : 0,
      tips: (body.match(/Tipp des Tages/gi) || []).length,
    };
  });
  ok('2. Genau EINE Begrüßung auf der Startseite (im Hero), Leiste zeigt das Datum', st.greetings === 1 && !st.abTitleInAppbar && /^(Sonntag|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag), \d{1,2}\.\d{1,2}\.$/.test(st.abText || ''), JSON.stringify({ g: st.greetings, ab: st.abText }));
  ok('2b. „Einchecken" steht im Hero, ≥ 44 px hoch und ohne Scrollen sichtbar', st.ciH >= 44 && st.ciTop < 700, JSON.stringify({ h: st.ciH, top: st.ciTop }));
  ok('2c. Nächster Termin steht im Hero (Titel + Tag), ohne „Uhr"', /Einführungstraining/.test(st.appt) && /\d{1,2}\.\d{1,2}\./.test(st.appt) && !/Uhr/.test(st.appt), st.appt);
  ok('2d. Keine verschachtelten Knöpfe im Hero', st.nested === 0);
  ok('2e. Standort-Frage kommt NACH dem Hero und ist schmal (< 140 px)', st.geoAfterHero && st.geoH > 0 && st.geoH < 140, JSON.stringify({ after: st.geoAfterHero, h: st.geoH }));
  ok('2f. „Tipp des Tages" genau einmal auf der Startseite', st.tips === 1, String(st.tips));
  // Einchecken aus dem Hero löst den Check-in aus (Browser: ohne Biometrie direkt).
  await click(m.p, '[data-hero="checkin"]'); await m.p.waitForTimeout(500);
  const after = await m.p.evaluate(function () { return { ci: !!document.querySelector('[data-hero="checkin"]'), timer: !!document.getElementById('ci_timer'), geo: !!document.querySelector('[data-home="geo"]') }; });
  ok('2g. Tipp auf „Einchecken": Check-in beim Server, Timer-Karte da, Hero-Knopf und Standort-Frage weg', srv.checkins === 1 && !after.ci && after.timer && !after.geo, JSON.stringify(after));
  await click(m.p, '[data-act="doCheckout"]'); await m.p.waitForTimeout(400);
  // „Später" blendet die Standort-Frage aus – dauerhaft.
  await click(m.p, '[data-act="geoCiDeny"]'); await m.p.waitForTimeout(300);
  ok('2h. „Später" merkt sich die Entscheidung', !(await m.p.evaluate(function () { return !!document.querySelector('[data-home="geo"]'); })) && (await m.p.evaluate(function () { return localStorage.getItem('fi_geoci_v1'); })) === '0');
  // Fortschritt: kein Tipp-Streifen mehr.
  await click(m.p, '[data-act="nav"][data-arg="coach"]'); await m.p.waitForTimeout(400);
  await m.p.evaluate(function () { const el = document.querySelector('[data-act="avatarTap"]'); if (el) el.click(); }); await m.p.waitForTimeout(400);
  await click(m.p, '[data-act="nav"][data-arg="fort"]'); await m.p.waitForTimeout(500);
  const fort = await m.p.evaluate(function () { return document.body.innerText; });
  // innerText liefert CSS-Großschreibung mit -> unabhängig von Groß/Klein prüfen.
  ok('3. Fortschritt zeigt Vitalpunkte, aber keinen „Tipp des Tages"', /Vitalpunkte/i.test(fort) && !/Tipp des Tages/i.test(fort));
  ok('3b. Keine Skriptfehler', m.fehler.length === 0, m.fehler.join(' | '));
  await m.c.close();

  // ── 4. iPhone SE (375 × 667): Datum nicht abgeschnitten, Einchecken ohne Scrollen ──
  m = await openPage({ width: 375, height: 667 });
  const se = await m.p.evaluate(function () {
    const ab = document.querySelector('#appbar [data-ab="date"]');
    const ci = document.querySelector('[data-hero="checkin"]');
    return { cut: ab ? ab.scrollWidth > ab.clientWidth + 1 : true, ciTop: ci ? ci.getBoundingClientRect().bottom : 9999 };
  });
  ok('4. iPhone SE: Datum passt in die Leiste, „Einchecken" liegt über der Falz', !se.cut && se.ciTop < 667, JSON.stringify(se));
  await m.c.close();

  await b.close(); server.close();
  console.log(pass ? 'STARTSEITE PASS' : 'STARTSEITE FAIL');
  process.exit(pass ? 0 : 1);
})();
