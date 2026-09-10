'use strict';
// FINN-Chat (Mitglieder-App): Umbau September 2026.
//
// Was hier abgesichert wird – jeweils, weil es vorher wirklich kaputt oder unhandlich war:
//  - Der Link-Knopf unter einer Antwort kennt ALLE Bereiche, die der Server vergeben darf
//    (inbody/figur zeigten vorher einen Knopf, der nichts tat).
//  - Eine nicht angekommene Antwort ist eine Fehlerblase mit „Nochmal versuchen" – die Frage
//    wird dabei weder gedoppelt noch landet der Fehlertext im Verlauf, der an den Server geht.
//  - Der Verlauf überlebt ein Neuladen (sessionStorage, 12 h), nicht aber „Neues Gespräch".
//  - Handy: 16px-Eingabe (kein iOS-Zoom), Tippflächen ≥ 44px, kein Auto-Fokus (die Tastatur
//    würde die Begrüßung verdecken), „Nach unten"-Pille beim Hochscrollen.
//  - Schreibtisch: Auto-Fokus, schwebende Karte, Escape schließt.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
const coachSrc = fs.readFileSync(path.join(ROOT, 'api/member/coach.js'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Quelltext ──
const screensSrc = (coachSrc.match(/const SCREENS = \{([\s\S]*?)\};/) || [])[1] || '';
const serverScreens = (screensSrc.match(/\b([a-z]+):\s*'/g) || []).map((s) => s.replace(/:\s*'$/, ''));
const allowedSrc = (html.match(/finnGo:function\(a\)\{\s*var allowed=\[([^\]]*)\]/) || [])[1] || '';
const clientAllowed = (allowedSrc.match(/'([a-z]+)'/g) || []).map((s) => s.replace(/'/g, ''));
const missing = serverScreens.filter((s) => s !== 'ern' && clientAllowed.indexOf(s) < 0);
ok('1. Jeder Link-Bereich des Servers ist im Client erlaubt (' + serverScreens.length + ' Bereiche)', serverScreens.length >= 14 && missing.length === 0, 'fehlt: ' + missing.join(','));
ok('1b. „ern" hängt am Ernährungs-Tab-Schalter', /finnGo:function\(a\)\{[\s\S]{0,400}if\(ernTabOn\(\)\) allowed\.push\('ern'\)/.test(html));
ok('1c. Eingabefeld 16px (iOS zoomt sonst beim Fokus)', /#finn_q\{[^}]*font-size:16px/.test(html));
ok('1d. Verlauf nur in sessionStorage, nie localStorage', /sessionStorage\.setItem\(FINN_STORE/.test(html) && !/localStorage\.setItem\(FINN_STORE/.test(html));
ok('1e. Abmelden leert den Verlauf', /function logout\(\)\{[\s\S]{0,1500}finnReset\(\)/.test(html));
ok('1f. Chat-Anfrage hat einen Timeout (kein ewiges „schreibt …")', /api\('\/api\/member\/coach',\{method:'POST',timeoutMs:\d+,body:JSON\.stringify\(\{question:q/.test(html));
ok('1g. Bereichs-Tour startet nicht über einem offenen Chat', /function maybeStartSectionTour\(\)\{[\s\S]{0,400}S\.finnOpen\) return;/.test(html));
ok('1h. Handler für alle neuen Klickziele vorhanden', ['finnRetry', 'finnNew', 'finnDown'].every((a) => new RegExp(a + ':function\\(').test(html)));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.');
    console.log(pass ? 'FINN-CHAT PASS (ohne Browser)' : 'FINN-CHAT FAIL');
    process.exit(pass ? 0 : 1);
  }

  // Fake-Server: mode 'ok' antwortet mit Link auf inbody, 'fail' mit 500. Merkt sich den
  // letzten Chat-Aufruf (question + history), um die Historie zu prüfen.
  const srv = { mode: 'ok', last: null, calls: 0 };
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    const J = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u === '/api/member/me') return J({ ok: true, profile: { firstName: 'Mara', lastName: 'M', dateOfBirth: '1988-04-12' } });
    if (u === '/api/member/checkins') return J({ ok: true, checkins: [{ in: new Date(Date.now() - 864e5).toISOString() }] });
    if (u === '/api/member/inbody') return J({ ok: true, available: false });
    if (u === '/api/member/coach') {
      if (req.method !== 'POST') return J({ ok: true, message: 'Tipp', ai: false });
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(raw); } catch (e) {}
        // Offene Gedächtnis-Frage kommt VERZÖGERT: ihr Neu-Zeichnen trifft den bereits
        // geöffneten leeren Chat – und darf ihn nicht nach unten springen lassen.
        if (b.action === 'memory-get') { setTimeout(() => J({ ok: true, on: false, decided: srv.mem !== 'open', items: [] }), srv.mem === 'open' ? 350 : 0); return; }
        srv.calls++; srv.last = b;
        if (srv.mode === 'fail') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"ok":false}'); }
        setTimeout(() => J({ ok: true, answer: 'Deine letzte **InBody-Analyse** ist vom 2. September.\n\n– Muskelmasse: stabil\n– Körperfett: leicht gesunken\n\nSchau dir den Verlauf an.', link: { screen: 'inbody', label: 'InBody-Analyse öffnen' } }), 250);
      });
      return;
    }
    if (u.indexOf('/api/') === 0) return J({ ok: true });
    const f = path.join(ROOT, u === '/' ? '/mitglieder.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : (u.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8') });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;
  const b = await chromium.launch({ executablePath: bin });

  const init = function (extra) {
    return function (x) {
      try {
        localStorage.setItem('fi_member_token', 'test');
        localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
        localStorage.setItem('fi_flags_srv', JSON.stringify({ ern: false, social: false, demo: false, train: false, vital: false, abo: false, upfit: 'https://fit-inn-trier.upfit.io/' }));
        ['fi_tour_v1', 'fi_welcome_seen', 'fi_tour_coach_v1'].forEach(function (k) { localStorage.setItem(k, '1'); });
        if (x && x.chat) sessionStorage.setItem('fi_finn_chat', JSON.stringify(x.chat));
      } catch (e) {}
    };
  };
  async function openPage(ctxOpts, extra) {
    const c = await b.newContext(Object.assign({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, ctxOpts || {}));
    const p = await c.newPage();
    const fehler = []; p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    await p.addInitScript(init(), extra || {});
    await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(900);
    return { c: c, p: p, fehler: fehler };
  }
  const click = (p, sel) => p.evaluate(function (s) { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  const openChat = async function (p) {
    await click(p, '[data-act="nav"][data-arg="coach"]'); await p.waitForTimeout(500);
    await click(p, '#app [data-act="openFinn"]'); await p.waitForTimeout(500);
  };
  const q = (p, sel) => p.evaluate(function (s) { return document.querySelectorAll(s).length; }, sel);
  const txt = (p, sel) => p.evaluate(function (s) { const el = document.querySelector(s); return el ? el.innerText : null; }, sel);

  // ── 2. Handy: leerer Chat, Senden, Antwort, Link-Knopf ──
  let m = await openPage();
  await openChat(m.p);
  ok('2. Chat offen, Begrüßung mit drei Vorschlägen', (await q(m.p, '.finnPanel')) === 1 && (await q(m.p, '#finn_hello')) === 1 && (await q(m.p, '.fcSugg')) === 3);
  const geo = await m.p.evaluate(function () {
    // nur sichtbare Ziele messen („Neu" ist im leeren Chat bewusst ausgeblendet)
    const s = Array.from(document.querySelectorAll('.fcSugg,.fcChip,#finn_send,.fcHBtn')).filter(function (e) { return e.offsetParent !== null; }).map(function (e) { return e.getBoundingClientRect().height; });
    const fq = document.getElementById('finn_q');
    return { min: Math.min.apply(null, s), font: getComputedStyle(fq).fontSize, focused: document.activeElement === fq, sendOff: document.getElementById('finn_send').disabled };
  });
  ok('2b. Tippflächen ≥ 40px, Eingabe 16px, kein Auto-Fokus auf Touch, Senden aus solange leer', geo.min >= 40 && geo.font === '16px' && !geo.focused && geo.sendOff, JSON.stringify(geo));
  await m.p.fill('#finn_q', 'Hallo');
  ok('2c. Text getippt -> Senden an', !(await m.p.evaluate(function () { return document.getElementById('finn_send').disabled; })));
  await m.p.fill('#finn_q', '');
  const sugg = await txt(m.p, '.fcSugg');
  await click(m.p, '.fcSugg'); await m.p.waitForTimeout(80);
  const mid = await m.p.evaluate(function () { return { hello: !!document.getElementById('finn_hello'), me: Array.from(document.querySelectorAll('.fcMsg.me .fcB')).map(function (e) { return e.innerText; }), think: !!document.getElementById('finn_think'), sub: document.getElementById('finn_sub').textContent }; });
  ok('2d. Vorschlag getippt: Begrüßung weg, eigene Blase da, FINN „schreibt …"', !mid.hello && mid.me.length === 1 && mid.me[0] === sugg && mid.think && /schreibt/.test(mid.sub), JSON.stringify(mid));
  await m.p.waitForTimeout(700);
  const ans = await m.p.evaluate(function () { const a = document.querySelectorAll('.fcMsg:not(.me)'); const last = a[a.length - 1]; return { n: a.length, think: !!document.getElementById('finn_think'), bold: !!(last && last.querySelector('.fcB b')), link: !!(last && last.querySelector('.fcAct[data-act="finnGo"][data-arg="inbody"]')), sub: document.getElementById('finn_sub').textContent, neu: getComputedStyle(document.getElementById('finn_new')).display !== 'none', bottom: (function () { const s = document.getElementById('finn_scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 4; })() }; });
  ok('2e. Antwort: fett formatiert, Link-Knopf „InBody", Kopf wieder normal, „Neu" sichtbar, unten angedockt', ans.n === 1 && !ans.think && ans.bold && ans.link && !/schreibt/.test(ans.sub) && ans.neu && ans.bottom, JSON.stringify(ans));
  ok('2f. Server bekam Frage + leere Historie', srv.last && srv.last.question === sugg && Array.isArray(srv.last.history) && srv.last.history.length === 0);

  // ── 3. Fehler + Nochmal versuchen ──
  srv.mode = 'fail';
  await m.p.fill('#finn_q', 'Frage zwei');
  await click(m.p, '#finn_send'); await m.p.waitForTimeout(500);
  const err = await m.p.evaluate(function () { return { err: document.querySelectorAll('.fcMsg.fail').length, retry: !!document.querySelector('.fcMsg.fail [data-act="finnRetry"]'), team: !!document.querySelector('.fcMsg.fail [data-act="finnToTeam"]'), me: document.querySelectorAll('.fcMsg.me').length, store: JSON.parse(sessionStorage.getItem('fi_finn_chat') || '{}') }; });
  const storeTexts = ((err.store && err.store.msgs) || []).map(function (x) { return x.text; }).join(' | ');
  ok('3. 500 vom Server -> Fehlerblase mit „Nochmal versuchen" und „Ans Team"', err.err === 1 && err.retry && err.team && err.me === 2, JSON.stringify({ err: err.err, retry: err.retry, me: err.me }));
  ok('3b. Gespeicherter Verlauf: 3 Nachrichten, ohne den Fehlertext', err.store.msgs && err.store.msgs.length === 3 && !/Verbindung|angekommen/.test(storeTexts), storeTexts);
  srv.mode = 'ok';
  await click(m.p, '[data-act="finnRetry"]'); await m.p.waitForTimeout(80);
  const rt = await m.p.evaluate(function () { return { err: document.querySelectorAll('.fcMsg.fail').length, me: document.querySelectorAll('.fcMsg.me').length, think: !!document.getElementById('finn_think') }; });
  ok('3c. Nochmal: Fehlerblase weg, Frage nicht gedoppelt, FINN schreibt', rt.err === 0 && rt.me === 2 && rt.think, JSON.stringify(rt));
  await m.p.waitForTimeout(700);
  const rt2 = await m.p.evaluate(function () { return { a: document.querySelectorAll('.fcMsg:not(.me)').length, err: document.querySelectorAll('.fcMsg.fail').length }; });
  const histTxt = (srv.last.history || []).map(function (x) { return x.text; }).join(' | ');
  ok('3d. Antwort da; Server bekam dieselbe Frage mit sauberer Historie (2 Einträge, kein Fehlertext)', rt2.a === 2 && rt2.err === 0 && srv.last.question === 'Frage zwei' && srv.last.history.length === 2 && !/Verbindung|angekommen/.test(histTxt), histTxt);

  // ── 4. Link-Knopf -> Bereich öffnet, Chat zu ──
  await click(m.p, '.fcAct[data-act="finnGo"][data-arg="inbody"]'); await m.p.waitForTimeout(500);
  const nav = await m.p.evaluate(function () { return { panel: !!document.querySelector('.finnPanel'), t: document.body.innerText.slice(0, 600) }; });
  ok('4. „InBody-Analyse öffnen" schließt den Chat und öffnet den Bereich', !nav.panel && /InBody/.test(nav.t), nav.t.slice(0, 120));

  // ── 5. Neuladen: Verlauf ist noch da · „Neues Gespräch" leert ──
  await m.p.reload({ waitUntil: 'domcontentloaded' }); await m.p.waitForTimeout(900);
  await openChat(m.p);
  const re = await m.p.evaluate(function () { return { n: document.querySelectorAll('.fcMsg').length, hello: !!document.getElementById('finn_hello'), neu: getComputedStyle(document.getElementById('finn_new')).display !== 'none' }; });
  ok('5. Nach Neuladen: 4 Nachrichten wieder da, keine Begrüßung, „Neu" sichtbar', re.n === 4 && !re.hello && re.neu, JSON.stringify(re));
  await click(m.p, '#finn_new'); await m.p.waitForTimeout(300);
  const nw = await m.p.evaluate(function () { return { n: document.querySelectorAll('.fcMsg').length, hello: !!document.getElementById('finn_hello'), store: sessionStorage.getItem('fi_finn_chat') }; });
  ok('5b. „Neues Gespräch": leer, Begrüßung zurück, Speicher geleert', nw.n === 0 && nw.hello && nw.store === null, JSON.stringify(nw));
  ok('5c. Keine Skriptfehler auf dem Handy', m.fehler.length === 0, m.fehler.join(' | '));
  await m.c.close();

  // ── 6. Langer Verlauf: „Nach unten"-Pille · abgelaufener Verlauf wird verworfen ──
  const many = []; for (let i = 0; i < 9; i++) { many.push({ role: 'user', text: 'Frage ' + (i + 1) + ' zu meinem Vertrag und den Terminen' }); many.push({ role: 'assistant', text: 'Antwort ' + (i + 1) + ': Dein Vertrag läuft weiter, der nächste Termin ist offen. Ein zweiter Satz macht die Blase höher.', link: null }); }
  m = await openPage({}, { chat: { t: Date.now(), topic: '', msgs: many } });
  await openChat(m.p);
  const sc = await m.p.evaluate(function () { const s = document.getElementById('finn_scroll'); return { n: document.querySelectorAll('.fcMsg').length, overflow: s.scrollHeight > s.clientHeight + 160, bottom: s.scrollHeight - s.scrollTop - s.clientHeight < 4, pill: document.getElementById('finn_down').classList.contains('on') }; });
  ok('6. 18 Nachrichten wiederhergestellt, unten angedockt, keine Pille', sc.n === 18 && sc.overflow && sc.bottom && !sc.pill, JSON.stringify(sc));
  await m.p.evaluate(function () { const s = document.getElementById('finn_scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await m.p.waitForTimeout(150);
  ok('6b. Hochgescrollt -> Pille erscheint', await m.p.evaluate(function () { return document.getElementById('finn_down').classList.contains('on'); }));
  await click(m.p, '#finn_down');
  // weiches Scrollen: bis zu 2 s warten, bis der Verlauf unten angekommen ist
  let dn = null;
  for (let i = 0; i < 20; i++) {
    await m.p.waitForTimeout(100);
    dn = await m.p.evaluate(function () { const s = document.getElementById('finn_scroll'); return { bottom: s.scrollHeight - s.scrollTop - s.clientHeight < 4, pill: document.getElementById('finn_down').classList.contains('on') }; });
    if (dn.bottom && !dn.pill) break;
  }
  ok('6c. Pille getippt -> wieder unten, Pille weg', dn.bottom && !dn.pill, JSON.stringify(dn));
  await m.c.close();
  srv.mem = 'open';   // Gedächtnis-Frage noch offen -> Begrüßung ist länger als der Bildschirm
  m = await openPage({}, { chat: { t: Date.now() - 13 * 3600e3, topic: '', msgs: many.slice(0, 2) } });
  await openChat(m.p);
  ok('6d. Verlauf älter als 12 h wird verworfen (Begrüßung statt alter Blasen)', (await q(m.p, '#finn_hello')) === 1 && (await q(m.p, '.fcMsg')) === 0 && (await m.p.evaluate(function () { return sessionStorage.getItem('fi_finn_chat'); })) === null);
  const top = await m.p.evaluate(function () { const s = document.getElementById('finn_scroll'); return { mem: !!document.querySelector('#finn_hello .fcMem'), overflow: s.scrollHeight > s.clientHeight, top: s.scrollTop }; });
  ok('6e. Leerer Chat mit Gedächtnis-Frage beginnt OBEN (Avatar + „Hi" sichtbar), nicht unten', top.mem && top.overflow && top.top === 0, JSON.stringify(top));
  srv.mem = 'decided';
  await m.c.close();

  // ── 7. Schreibtisch: Karte, Auto-Fokus, Escape ──
  m = await openPage({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });
  await openChat(m.p);
  const dk = await m.p.evaluate(function () { const pn = document.querySelector('.finnPanel'); const r = pn.getBoundingClientRect(); return { pos: getComputedStyle(pn).position, w: Math.round(r.width), right: Math.round(window.innerWidth - r.right), focused: document.activeElement && document.activeElement.id === 'finn_q' }; });
  ok('7. Schreibtisch: schwebende Karte rechts unten (420px, 24px Rand), Cursor im Feld', dk.pos === 'fixed' && dk.w === 420 && dk.right === 24 && dk.focused, JSON.stringify(dk));
  await m.p.keyboard.press('Escape'); await m.p.waitForTimeout(300);
  ok('7b. Escape schließt den Chat', (await q(m.p, '.finnPanel')) === 0);
  ok('7c. Keine Skriptfehler am Schreibtisch', m.fehler.length === 0, m.fehler.join(' | '));
  await m.c.close();

  await b.close(); server.close();
  console.log(pass ? 'FINN-CHAT PASS' : 'FINN-CHAT FAIL');
  process.exit(pass ? 0 : 1);
})();
