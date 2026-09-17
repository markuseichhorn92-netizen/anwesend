'use strict';
// FINN-Chat: Eingabe-Stabilität und Antwortvorschläge.
//  - Der Chat lebt in #finnhost: ein Hintergrund-Render (verzögerte Gedächtnis-Antwort) darf
//    weder das Eingabefeld ersetzen noch getippten Text oder den Fokus verlieren.
//  - Antwortvorschläge (choices) erscheinen über der Eingabe, ein Tipp sendet den Text,
//    sie verschwinden während FINN schreibt und bei offener Bestätigung, überleben ein Neuladen.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

ok('1. Chat-Host außerhalb von #app, render() baut den Chat nicht mehr', /<div id="finnhost"><\/div>/.test(html) && !/if\(S\.finnOpen\) html\+=finnOverlayHtml\(\);/.test(html) && /finnMount\(\);/.test(html));
ok('1a. Vorschläge: Zeile, Handler, Persistenz', /id="finn_quick"/.test(html) && /finnChoice:function/.test(html) && /choices:m\.choices\|\|null/.test(html));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) { console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.'); console.log(pass ? 'FINN-CHAT-FLUID PASS (ohne Browser)' : 'FINN-CHAT-FLUID FAIL'); process.exit(pass ? 0 : 1); }

  const srv = { posts: [] };
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    const J = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const readBody = (cb) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { let j = {}; try { j = JSON.parse(b || '{}'); } catch (e) {} cb(j); }); };
    if (u === '/api/member/me') return J({ ok: true, profile: { firstName: 'Mara', lastName: 'M' }, contract: { rateName: 'Flex 12', active: true } });
    if (u === '/api/member/coach' && req.method === 'POST') {
      return readBody((b) => {
        srv.posts.push(b);
        if (b.action === 'memory-get') return setTimeout(() => J({ ok: true, on: false, decided: false, items: [] }), 900);   // kommt verzögert -> Hintergrund-Render
        if (b.action === 'decline') return J({ ok: true, answer: 'Okay, ich habe nichts geändert.', declined: true, choices: [{ label: 'Freie Termine zeigen' }, { label: 'Meine Termine' }] });
        if (b.action === 'confirm') return J({ ok: true, answer: 'Erledigt ✓', done: true, choices: [{ label: 'Meine Termine' }] });
        if (/stornier/i.test(b.question || '')) return J({ ok: true, answer: 'Soll ich das so machen?\n→ Termin stornieren: Einführungstraining', confirm: { id: 'cf_med_00001', preview: 'Termin stornieren: Einführungstraining', risk: 'MEDIUM' }, choices: [] });
        if (/team/i.test(b.question || '')) return J({ ok: true, answer: 'Ich habe es ans Team übergeben.', choices: [{ label: 'Postfach öffnen', screen: 'postfach' }] });
        if (/stoffwechsel/i.test(b.question || '')) return J({ ok: true, answer: 'Wann passt es dir?', choices: [{ label: 'Morgen 10:00' }, { label: 'Freitag 16:00' }, { label: 'Andere Zeit' }] });
        // Erste Antwort kommt mit Verzögerung, damit der „FINN schreibt"-Zustand prüfbar ist.
        return setTimeout(() => J({ ok: true, answer: 'Welche Terminart möchtest du?', choices: [{ label: 'Stoffwechselanalyse' }, { label: 'Einführungstraining' }, { label: 'Trainingsplanung' }] }), 450);
      });
    }
    if (u === '/api/member/coach') return J({ ok: true, message: 'Tipp', ai: false });
    if (u === '/api/member/inbox') return J({ ok: true, vorgaenge: [], items: [] });
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
  await p.addInitScript(function () {
    try {
      localStorage.setItem('fi_member_token', 'test');
      localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
      localStorage.setItem('fi_flags_srv', JSON.stringify({ ern: false, social: false, demo: false, train: false, vital: false, abo: false, upfit: 'https://fit-inn-trier.upfit.io/' }));
      ['fi_tour_v1', 'fi_welcome_seen', 'fi_tour_coach_v1', 'fi_geoci_v1'].forEach(function (k) { localStorage.setItem(k, '1'); });
    } catch (e) {}
  });
  await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  const click = (sel) => p.evaluate(function (s) { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  const type = (txt) => p.evaluate(function (t) { const el = document.getElementById('finn_q'); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, txt);

  // ── 2. Eingabe-Stabilität: tippen, dann kommt die verzögerte Gedächtnis-Antwort (Render) ──
  await click('[data-act="openFinn"]'); await p.waitForTimeout(150);
  await p.evaluate(function () { const el = document.getElementById('finn_q'); el.__mark = 'A'; document.querySelector('.finnPanel').__mark = 'P'; });
  await type('Hallo, ich hab'); await p.waitForTimeout(1200);   // > 900 ms: memory-get ist da, render() lief
  const st = await p.evaluate(function () { const el = document.getElementById('finn_q'); return { same: el && el.__mark === 'A', panel: document.querySelector('.finnPanel').__mark === 'P', value: el && el.value, focused: document.activeElement === el, mem: !!document.querySelector('#finn_hello .fcMem'), inApp: !!document.querySelector('#app .finnPanel'), inHost: !!document.querySelector('#finnhost .finnPanel') }; });
  ok('2. Getippter Text, Fokus und dasselbe Eingabefeld überleben den Hintergrund-Render; Gedächtnis-Frage erschien trotzdem', st.same && st.panel && st.value === 'Hallo, ich hab' && st.focused && st.mem && st.inHost && !st.inApp, JSON.stringify(st));

  // ── 3. Vorschläge nach einer Antwort; Tipp sendet den Text ──
  await type('Ich möchte einen Termin'); await click('#finn_send'); await p.waitForTimeout(150);
  const busy = await p.evaluate(function () { return { chips: document.querySelectorAll('.fcQChip').length, think: !!document.getElementById('finn_think') }; });
  ok('3. Während FINN schreibt: keine Vorschläge', busy.chips === 0 && busy.think, JSON.stringify(busy));
  await p.waitForTimeout(600);
  const chips = await p.evaluate(function () { return Array.from(document.querySelectorAll('.fcQChip')).map(function (b) { return { t: b.textContent, h: b.getBoundingClientRect().height }; }); });
  ok('3a. Drei Vorschläge aus der Antwort, Tippfläche ≥ 38 px', chips.length === 3 && chips[0].t === 'Stoffwechselanalyse' && chips.every(function (x) { return x.h >= 38; }), JSON.stringify(chips));
  await click('.fcQChip'); await p.waitForTimeout(700);
  const after = await p.evaluate(function () { const me = Array.from(document.querySelectorAll('.fcMsg.me .fcB')).map(function (e) { return e.innerText; }); return { me: me, chips: Array.from(document.querySelectorAll('.fcQChip')).map(function (b) { return b.textContent; }) }; });
  ok('3b. Tipp auf Vorschlag: Text als eigene Nachricht gesendet, neue Vorschläge folgen', after.me[after.me.length - 1] === 'Stoffwechselanalyse' && srv.posts.some(function (x) { return x.question === 'Stoffwechselanalyse'; }) && after.chips.length === 3 && after.chips[0] === 'Morgen 10:00', JSON.stringify(after));

  // ── 4. Offene Bestätigung: Karte statt Vorschläge; nach „Abbrechen" wieder Vorschläge ──
  await type('Storniere mein Einführungstraining'); await click('#finn_send'); await p.waitForTimeout(700);
  const cf = await p.evaluate(function () { return { card: !!document.querySelector('.fcMsg.fcCf'), chips: document.querySelectorAll('.fcQChip').length }; });
  ok('4. Bei offener Bestätigung keine Vorschläge (die Karte hat ihre Knöpfe)', cf.card && cf.chips === 0, JSON.stringify(cf));
  await p.evaluate(function () { document.getElementById('finn_q').__mark = 'B'; });
  await click('[data-act="finnDecline"]'); await p.waitForTimeout(700);
  const dec = await p.evaluate(function () { const el = document.getElementById('finn_q'); return { same: el && el.__mark === 'B', state: (document.querySelector('.fcCfState') || {}).textContent, chips: Array.from(document.querySelectorAll('.fcQChip')).map(function (b) { return b.textContent; }) }; });
  ok('4a. Abbrechen ohne Voll-Render: Eingabefeld bleibt, Karte „Abgebrochen", Vorschläge zurück', dec.same && dec.state === 'Abgebrochen' && dec.chips.length === 2, JSON.stringify(dec));

  // ── 5. Neuladen: Vorschläge der letzten Antwort sind wieder da ──
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900);
  await click('[data-act="openFinn"]'); await p.waitForTimeout(300);
  const re = await p.evaluate(function () { return Array.from(document.querySelectorAll('.fcQChip')).map(function (b) { return b.textContent; }); });
  ok('5. Nach Neuladen: Vorschläge der letzten Antwort wiederhergestellt', re.length === 2 && re[0] === 'Freie Termine zeigen', JSON.stringify(re));

  // ── 6. Vorschlag mit Bereich: öffnet den Bereich statt zu senden ──
  await type('Bitte ans Team'); await click('#finn_send'); await p.waitForTimeout(700);
  await click('.fcQChip'); await p.waitForTimeout(500);
  const nav = await p.evaluate(function () { return { panel: !!document.querySelector('.finnPanel'), post: /Postfach/i.test(document.body.innerText) }; });
  ok('6. „Postfach öffnen" schließt den Chat und öffnet den Bereich', !nav.panel && nav.post, JSON.stringify(nav));
  ok('7. Keine Skriptfehler', fehler.length === 0, fehler.join(' | '));

  await c.close(); await b.close(); server.close();
  console.log(pass ? 'FINN-CHAT-FLUID PASS' : 'FINN-CHAT-FLUID FAIL');
  process.exit(pass ? 0 : 1);
})();
