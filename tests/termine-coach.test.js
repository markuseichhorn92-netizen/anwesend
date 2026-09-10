'use strict';
// Termine-Screen und Coach-Hub (Design-Durchgang September 2026).
//  - Termine: gebuchte Termine stehen über dem Buchen-Abschnitt, „Stornieren" läuft nicht
//    mehr in lange Titel („Einführungstraining"), der Buchen-Abschnitt ist benannt.
//  - Coach-Hub: eine Aussage, ein Knopf, Schnellfragen; Analyse als Nebensache, kein Emoji.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Quelltext ──
ok('1. Coach-Hub ohne Roboter-Emoji und ohne die zwei Zusatzlabels', !/🤖/.test(html.slice(html.indexOf('function coachFinnHub'), html.indexOf('function coachFinnHub') + 3500)) && !/KI · rund um die Uhr für dich da/.test(html) && !/FINN · Dein Blick für heute/.test(html));
ok('1b. Termine: „Meine Termine" kommt vor dem Buchen (mine+out)', /return subHeader\('Termine','Buchen & verwalten'\)\+mine\+out;/.test(html));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.');
    console.log(pass ? 'TERMINE-COACH PASS (ohne Browser)' : 'TERMINE-COACH FAIL');
    process.exit(pass ? 0 : 1);
  }
  const iso = (d) => new Date(Date.now() + d * 864e5).toISOString();
  const srv = { appts: [{ id: 'a1', title: 'Einführungstraining', start: iso(3), startDateTime: iso(3) }, { id: 'a2', title: 'Stoffwechselanalyse', start: iso(12), startDateTime: iso(12) }] };
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    const J = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u === '/api/member/me') return J({ ok: true, profile: { firstName: 'Mara', lastName: 'M' }, contract: { rateName: 'Flex 12', active: true } });
    if (u === '/api/member/appointments') return J({ ok: true, appointments: srv.appts });
    if (u === '/api/member/bookable') return J({ ok: true, types: [{ id: 'a', title: 'Stoffwechselanalyse', duration: 30 }, { id: 'b', title: 'Einführungstraining', duration: 60 }] });
    if (u === '/api/member/checkins') return J({ ok: true, checkins: [{ in: new Date(Date.now() - 864e5).toISOString() }] });
    if (u === '/api/member/coach') return J({ ok: true, message: 'Tipp', ai: false });
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
        ['fi_tour_v1', 'fi_welcome_seen', 'fi_tour_coach_v1', 'fi_geoci_v1'].forEach(function (k) { localStorage.setItem(k, '1'); });
      } catch (e) {}
    });
    await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    return { c: c, p: p, fehler: fehler };
  }
  const click = (p, sel) => p.evaluate(function (s) { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);

  // ── 2. Termine mit gebuchten Terminen (iPhone SE – schmal, damit lange Titel wirklich eng werden) ──
  let m = await openPage({ width: 375, height: 667 });
  await click(m.p, '[data-act="nav"][data-arg="appt"]'); await m.p.waitForTimeout(700);
  const ap = await m.p.evaluate(function () {
    const mine = document.querySelector('[data-appt="mine"]');
    const book = Array.from(document.querySelectorAll('#app div')).find(function (d) { return /^Termin buchen$/.test(d.textContent.trim()); });
    const rows = Array.from(document.querySelectorAll('[data-appt="row"]')).map(function (r) {
      const t = r.querySelector('[data-appt="title"]'), c = r.querySelector('[data-act="cancelAppt"]');
      const tr = t.getBoundingClientRect(), cr = c ? c.getBoundingClientRect() : null;
      return { title: t.textContent, overlap: cr ? !(cr.left >= tr.right - 1 || cr.top >= tr.bottom - 1 || cr.right <= tr.left + 1 || cr.bottom <= tr.top + 1) : false, cut: t.scrollWidth > t.clientWidth + 1, cancelH: cr ? cr.height : 0 };
    });
    return { mineFirst: !!(mine && book) && (mine.compareDocumentPosition(book) & Node.DOCUMENT_POSITION_FOLLOWING) === Node.DOCUMENT_POSITION_FOLLOWING, rows: rows, zeit: /\d{2}:\d{2}/.test(mine ? mine.innerText : '') };
  });
  ok('2. Gebuchte Termine stehen über „Termin buchen"', ap.mineFirst, JSON.stringify({ mineFirst: ap.mineFirst }));
  ok('2b. Zwei Termine mit Titel und Uhrzeit', ap.rows.length === 2 && ap.zeit && /Einführungstraining/.test(ap.rows[0].title), JSON.stringify(ap.rows));
  ok('2c. „Stornieren" überlappt den Titel nicht, Titel nicht abgeschnitten, Knopf ≥ 36 px', ap.rows.every(function (r) { return !r.overlap && !r.cut && r.cancelH >= 36; }), JSON.stringify(ap.rows));
  // Stornieren fragt nach – abgelehnt bleibt der Termin.
  m.p.once('dialog', function (d) { d.dismiss().catch(function () {}); });
  await click(m.p, '[data-act="cancelAppt"]'); await m.p.waitForTimeout(400);
  ok('2d. Rückfrage vor dem Stornieren – abgelehnt bleibt der Termin stehen', (await m.p.evaluate(function () { return document.querySelectorAll('[data-appt="row"]').length; })) === 2);
  ok('2e. Keine Skriptfehler', m.fehler.length === 0, m.fehler.join(' | '));
  await m.c.close();

  // ── 3. Termine ohne Buchungen: Buchen zuerst, leerer Hinweis darunter ──
  srv.appts = [];
  m = await openPage();
  await click(m.p, '[data-act="nav"][data-arg="appt"]'); await m.p.waitForTimeout(700);
  // innerText liefert die CSS-Großschreibung der Labels mit -> ohne Groß/Klein vergleichen.
  const ap2 = await m.p.evaluate(function () { const t = document.body.innerText.toLowerCase(); return { mine: !!document.querySelector('[data-appt="mine"]'), order: t.indexOf('termin buchen') >= 0 && t.indexOf('termin buchen') < t.indexOf('noch keine termine') }; });
  ok('3. Ohne Termine: „Termin buchen" zuerst, „Noch keine Termine" darunter', !ap2.mine && ap2.order, JSON.stringify(ap2));

  // ── 4. Coach-Hub ──
  await click(m.p, '[data-act="nav"][data-arg="coach"]'); await m.p.waitForTimeout(600);
  const hub = await m.p.evaluate(function () {
    const h = document.querySelector('[data-coach="hub"]'); if (!h) return null;
    const t = h.innerText;
    return { title: /Dein Coach FINN/.test(t), blick: (h.querySelector('[data-coach="blick"]') || {}).textContent || '', cta: !!h.querySelector('[data-act="openFinn"]'), ctaH: h.querySelector('[data-act="openFinn"]').getBoundingClientRect().height, chips: h.querySelectorAll('[data-act="finnQuick"]').length, analyse: !!h.querySelector('[data-act="coachFinn"]'), emoji: /[\u{1F300}-\u{1FAFF}]/u.test(t), labels: (t.match(/RUND UM DIE UHR|BLICK FÜR HEUTE/gi) || []).length };
  });
  ok('4. Coach-Hub: Titel, eine Aussage, Chat-Knopf ≥ 44 px, drei Schnellfragen, Analyse-Link – kein Emoji, keine Zusatzlabels', !!hub && hub.title && hub.blick.length > 10 && hub.cta && hub.ctaH >= 44 && hub.chips === 3 && hub.analyse && !hub.emoji && hub.labels === 0, JSON.stringify(hub));
  ok('4b. Keine Skriptfehler', m.fehler.length === 0, m.fehler.join(' | '));
  await m.c.close();

  await b.close(); server.close();
  console.log(pass ? 'TERMINE-COACH PASS' : 'TERMINE-COACH FAIL');
  process.exit(pass ? 0 : 1);
})();
