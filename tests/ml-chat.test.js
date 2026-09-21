'use strict';
// Magicline-Mitglieder-Chatbot (Testbetrieb) statt FINN-Chat.
//  Server: /api/app-info liefert die Widget-Adresse (fest gebaut aus Tenant + UUID);
//          FEATURE_ML_CHAT=0 schaltet ab; eine ungültige UUID fällt auf die feste Id zurück.
//  Client: Skript erst nach der Anmeldung; alle FINN-Einstiege klicken die Blase im Widget-
//          iframe statt unseren Chat zu öffnen; Blase über der Bottom-Nav; ein manipulierter
//          Cache mit fremder Adresse lädt NICHTS; ohne Adresse läuft der FINN-Chat wie bisher.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };
const fresh = (rel) => { const p = path.resolve(ROOT, rel); delete require.cache[p]; delete require.cache[path.resolve(ROOT, 'lib/features.js')]; return require(p); };
function res0() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, body: null, end(s) { this.body = s; } }; }
const appInfo = () => { const r = res0(); fresh('api/app-info.js')({}, r); return JSON.parse(r.body); };

const URL_OK = 'https://fit-inn-trier.web.magicline.com/chatbot/widget/widget.js?uuid=a48084fc-8418-4bb1-b987-4bf4d852398f';

// ── 1. Server ──
delete process.env.FEATURE_ML_CHAT; delete process.env.ML_CHATBOT_UUID; delete process.env.ML_TENANT;
ok('1. Ohne Variable: Widget-Adresse der Fit-Inn-Konfiguration', appInfo().partner.mlchat === URL_OK, JSON.stringify(appInfo().partner));
process.env.FEATURE_ML_CHAT = '0';
ok('1a. FEATURE_ML_CHAT=0 -> null (FINN-Chat)', appInfo().partner.mlchat === null);
delete process.env.FEATURE_ML_CHAT;
process.env.ML_CHATBOT_UUID = '11111111-2222-3333-4444-555555555555';
ok('1b. ML_CHATBOT_UUID überschreibt die Konfigurations-Id', /uuid=11111111-2222-3333-4444-555555555555$/.test(appInfo().partner.mlchat));
process.env.ML_CHATBOT_UUID = 'https://evil.example/x.js';
ok('1c. Ungültige UUID -> feste Id, nie eine fremde Adresse', appInfo().partner.mlchat === URL_OK, appInfo().partner.mlchat);
delete process.env.ML_CHATBOT_UUID;
process.env.ML_TENANT = 'evil.example/';
ok('1d. Ungültiger Tenant -> aus statt fremder Host', appInfo().partner.mlchat === null, appInfo().partner.mlchat);
delete process.env.ML_TENANT;
ok('1e. Client prüft die Adresse strikt (Muster) und lädt das Skript erst nach der Anmeldung', /ML_CHAT_RE=\/\^https:\\\/\\\/\[a-z0-9-\]\+\\\.web\\\.magicline\\\.com/.test(html) && /function mlChatOn\(\)\{ return !!TOKEN && !!mlChatUrl\(\); \}/.test(html));
ok('1f. CSP (Report-Only) kennt Widget-, Übersetzungs- und WAF-Hosts', (function () { const v = JSON.stringify(require(path.join(ROOT, 'vercel.json'))); return /script-src[^"]*https:\/\/\*\.web\.magicline\.com https:\/\/\*\.awswaf\.com/.test(v) && /connect-src 'self' https:\/\/\*\.web\.magicline\.com https:\/\/intl\.sportalliance\.com/.test(v); })());

// ── 2. Browser ──
(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) { console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.'); console.log(pass ? 'ML-CHAT PASS (ohne Browser)' : 'ML-CHAT FAIL'); process.exit(pass ? 0 : 1); }

  // Nachgebautes Widget mit demselben Gerüst wie das echte: iframe mit fester Id und Inline-Lage,
  // darin die Blase [data-role="chatbot-bubble"]; Klick -> Vollbild (width 100%), Schließen -> 65px.
  const FAKE_WIDGET = "(function(){var s=document.getElementById('ml-member-chatbot-widget-script');window.__mlSrc=s&&s.src;var t=document.createElement('iframe');t.id='ml-member-chatbot-widget-iframe';Object.assign(t.style,{border:'none',width:'65px',height:'100px',position:'fixed',bottom:'20px',right:'20px',zIndex:'9999'});document.body.appendChild(t);var d=t.contentDocument;d.open();d.write('<!DOCTYPE html><html><body><div data-role=\"chatbot-cta\"><div data-role=\"chatbot-bubble\" role=\"button\" style=\"width:60px;height:60px;background:#0a4958;border-radius:50%\"></div></div><button data-role=\"chatbot-close-button\">x</button></body></html>');d.close();window.__mlClicks=0;d.querySelector('[data-role=\"chatbot-bubble\"]').addEventListener('click',function(){window.__mlClicks++;Object.assign(t.style,{top:'0px',left:'0px',width:'100%',height:'844px',bottom:'auto',right:'auto'});});d.querySelector('[data-role=\"chatbot-close-button\"]').addEventListener('click',function(){Object.assign(t.style,{bottom:'20px',right:'20px',width:'65px',height:'100px',top:'auto',left:'auto'});});})();";
  const srv = { mlchat: URL_OK, widgetHits: 0 };
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    const J = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u === '/api/app-info') return J({ ios: null, android: null, features: { ern: false, social: false, demo: false, train: false, vital: false, abo: false }, partner: { upfit: 'https://fit-inn-trier.upfit.io/', mlchat: srv.mlchat } });
    if (u === '/api/member/me') return J({ ok: true, profile: { firstName: 'Mara', lastName: 'M' }, contract: { rateName: 'Flex 12', active: true } });
    if (u === '/api/member/coach') return J({ ok: true, message: 'Tipp', ai: false, answer: 'Hallo.' });
    if (u.indexOf('/api/') === 0) return J({ ok: true });
    const f = path.join(ROOT, u === '/' ? '/mitglieder.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : (u.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8') });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;
  const b = await chromium.launch({ executablePath: bin });

  async function openPage(o) {
    o = o || {};
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    // Das echte Widget-Skript wird abgefangen (kein Netz) und durch das nachgebaute ersetzt.
    await c.route('https://**.web.magicline.com/**', function (route) { srv.widgetHits++; route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_WIDGET }); });
    await c.route('https://evil.example/**', function (route) { srv.evilHits = (srv.evilHits || 0) + 1; route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.__EVIL=1;' }); });
    const p = await c.newPage();
    const fehler = []; p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    await p.addInitScript(function (a) {
      // Init-Skripte laufen auch im Widget-iframe (gleiche Herkunft, gleicher localStorage) –
      // dort NICHT den Cache neu setzen, sonst löscht der Test selbst die Widget-Adresse.
      if (window !== window.top) return;
      try {
        if (a.token) localStorage.setItem('fi_member_token', 'test');
        localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
        localStorage.setItem('fi_flags_srv', JSON.stringify({ ern: false, social: false, demo: false, train: false, vital: false, abo: false, upfit: 'https://fit-inn-trier.upfit.io/', mlchat: a.cached }));
        ['fi_tour_v1', 'fi_welcome_seen', 'fi_tour_coach_v1', 'fi_geoci_v1'].forEach(function (k) { localStorage.setItem(k, '1'); });
      } catch (e) {}
    }, { token: o.token !== false, cached: o.cached === undefined ? null : o.cached });
    await p.goto(basis + '/mitglieder.html', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1100);
    return { c: c, p: p, fehler: fehler };
  }
  const click = (p, sel) => p.evaluate(function (s) { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  const state = (p) => p.evaluate(function () {
    const s = document.getElementById('ml-member-chatbot-widget-script'), f = document.getElementById('ml-member-chatbot-widget-iframe');
    const r = f ? f.getBoundingClientRect() : null;
    return { script: s ? s.src : null, iframe: !!f, width: f ? f.style.width : null, bottomGap: r ? Math.round(window.innerHeight - r.bottom) : null, hidden: f ? getComputedStyle(f).display === 'none' : null, clicks: window.__mlClicks || 0, panel: !!document.querySelector('.finnPanel'), on: document.body.classList.contains('mlChatOn'), hide: document.body.classList.contains('mlChatHide'), mini: (function () { const m = document.getElementById('finnMini'); return m ? m.style.display : null; })(), evil: !!window.__EVIL };
  });

  // 2a. Gast: kein Skript vor der Anmeldung
  let m = await openPage({ token: false, cached: URL_OK });
  let st = await state(m.p);
  ok('2. Ohne Anmeldung wird das Widget-Skript nicht geladen', st.script === null && !st.iframe && !st.on, JSON.stringify(st));
  await m.c.close();

  // 2b. Angemeldet, Adresse kommt vom Server (nicht im Cache): Skript wird nach app-info geladen
  m = await openPage({ cached: null });
  st = await state(m.p);
  ok('3. Nach Anmeldung: Skript mit exakt der Server-Adresse, iframe da, Blase über der Bottom-Nav', st.script === URL_OK && st.iframe && st.on && st.bottomGap >= 80 && !st.hidden && srv.widgetHits === 1, JSON.stringify(st));
  await click(m.p, '[data-act="nav"][data-arg="coach"]'); await m.p.waitForTimeout(500);
  await click(m.p, '[data-coach="hub"] [data-act="openFinn"]'); await m.p.waitForTimeout(400);
  st = await state(m.p);
  ok('3a. „Mit FINN chatten" öffnet den Magicline-Chat (Klick auf die Blase im iframe), nicht unseren Chat', st.clicks === 1 && st.width === '100%' && !st.panel, JSON.stringify(st));
  await m.p.evaluate(function () { document.getElementById('ml-member-chatbot-widget-iframe').contentDocument.querySelector('[data-role="chatbot-close-button"]').click(); }); await m.p.waitForTimeout(200);
  await click(m.p, '[data-act="finnQuick"]'); await m.p.waitForTimeout(400);
  st = await state(m.p);
  ok('3b. Schnellfrage öffnet ebenfalls das Widget; kein zweites Skript', st.clicks === 2 && !st.panel && srv.widgetHits === 1, JSON.stringify(st));
  await m.p.evaluate(function () { document.getElementById('ml-member-chatbot-widget-iframe').contentDocument.querySelector('[data-role="chatbot-close-button"]').click(); }); await m.p.waitForTimeout(200);
  // Unser Overlay (Suche) über der Blase: Blase weg, danach wieder da
  await click(m.p, '[data-act="findOpen"]'); await m.p.waitForTimeout(300);
  st = await state(m.p);
  ok('3c. Unter unserem Such-Overlay ist die Blase ausgeblendet', st.hide && st.hidden, JSON.stringify(st));
  await click(m.p, 'button[data-act="findClose"]'); await m.p.waitForTimeout(300);
  st = await state(m.p);
  ok('3d. Overlay zu -> Blase wieder sichtbar', !st.hide && !st.hidden, JSON.stringify(st));
  ok('3e. Keine Skriptfehler', m.fehler.length === 0, m.fehler.join(' | '));
  await m.c.close();

  // 2c. Manipulierter Cache mit fremder Adresse: nichts laden, FINN-Chat bleibt
  srv.mlchat = 'https://evil.example/widget.js';
  m = await openPage({ cached: 'https://evil.example/widget.js' });
  await click(m.p, '[data-act="nav"][data-arg="coach"]'); await m.p.waitForTimeout(400);
  await click(m.p, '[data-coach="hub"] [data-act="openFinn"]'); await m.p.waitForTimeout(400);
  st = await state(m.p);
  ok('4. Fremde Adresse (Cache UND Server) wird verworfen: kein Skript, FINN-Chat öffnet', st.script === null && !st.iframe && !st.evil && !(srv.evilHits > 0) && st.panel && !st.on, JSON.stringify(st));
  await m.c.close();

  // 2d. Abgeschaltet (null): FINN-Chat wie bisher
  srv.mlchat = null;
  m = await openPage({ cached: URL_OK });   // alter Cache sagt noch „an" – der Server gewinnt
  await m.p.waitForTimeout(400);
  await click(m.p, '[data-act="nav"][data-arg="coach"]'); await m.p.waitForTimeout(400);
  await click(m.p, '[data-coach="hub"] [data-act="openFinn"]'); await m.p.waitForTimeout(400);
  st = await state(m.p);
  ok('5. FEATURE_ML_CHAT=0: FINN-Chat öffnet, Widget-Klasse aus', st.panel && !st.on, JSON.stringify(st));
  await m.c.close();

  await b.close(); server.close();
  console.log(pass ? 'ML-CHAT PASS' : 'ML-CHAT FAIL');
  process.exit(pass ? 0 : 1);
})();
