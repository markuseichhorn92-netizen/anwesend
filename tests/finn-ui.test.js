'use strict';
// FINN in der Oberfläche: Bestätigungskarte im Mitglieder-Chat (Vorschlag -> Bestätigen/Abbrechen,
// nichts passiert ohne Klick, Zustand überlebt ein Neuladen) und die Team-Seite „FINN & Magicline"
// (nur Admin, Scope-Ampel, Reiter). Fake-Server, kein Netz.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
const team = fs.readFileSync(path.join(ROOT, 'team-backend.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Quelltext ──
ok('1. Chat kennt Bestätigen/Abbrechen als Handler', /finnConfirm:function/.test(html) && /finnDecline:function/.test(html) && /data-act="finnConfirm"/.test(html));
ok('1a. Team-Seite ist Admin-only und verdrahtet (Slug, Nav, Dispatch, Lader)', /finn:1/.test(team.slice(team.indexOf('var ADMIN_ONLY_SCREENS'), team.indexOf('var ADMIN_ONLY_SCREENS') + 200)) && /finn:'finn'/.test(team) && /content=finnNode\(\)/.test(team) && /if\(k==='finn'\)\{ loadFinn\(\); return; \}/.test(team) && /navItem\('finn'/.test(team));
ok('1b. FINN-Verlauf im Profil (Reiter Nachrichten & Vorgänge)', /finnVerlaufCard\(p\)/.test(team) && /loadMemberFinn\(id\)/.test(team));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.');
    console.log(pass ? 'FINN-UI PASS (ohne Browser)' : 'FINN-UI FAIL');
    process.exit(pass ? 0 : 1);
  }
  const srv = { posts: [], confirmed: 0, declined: 0 };
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    const J = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const readBody = (cb) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { let j = {}; try { j = JSON.parse(b || '{}'); } catch (e) {} cb(j); }); };
    if (u === '/api/member/me') return J({ ok: true, profile: { firstName: 'Mara', lastName: 'M' }, contract: { rateName: 'Flex 12', active: true } });
    if (u === '/api/member/coach' && req.method === 'POST') {
      return readBody((b) => {
        srv.posts.push(b);
        if (b.action === 'confirm') { srv.confirmed++; return J({ ok: true, answer: 'Erledigt ✓ Termin stornieren: Einführungstraining\nIch habe es gerade noch einmal in Magicline nachgesehen – passt.', done: true }); }
        if (b.action === 'decline') { srv.declined++; return J({ ok: true, answer: 'Okay, ich habe nichts geändert.', declined: true }); }
        if (/kündig/i.test(b.question || '')) return J({ ok: true, answer: 'Bitte bestätige ausdrücklich:\n→ Mitgliedschaft ordentlich kündigen zum 31.01.2027.', confirm: { id: 'cf_high_0001', preview: 'Mitgliedschaft ordentlich kündigen zum 31.01.2027.', risk: 'HIGH' }, agent: 'contract' });
        return J({ ok: true, answer: 'Soll ich das so machen?\n→ Termin stornieren: Einführungstraining', confirm: { id: 'cf_med_00001', preview: 'Termin stornieren: Einführungstraining', risk: 'MEDIUM' }, agent: 'appointment' });
      });
    }
    if (u === '/api/member/coach') return J({ ok: true, message: 'Tipp', ai: false });
    if (u === '/api/team/me') return J({ ok: true, role: srv.role || 'admin', name: 'Chef' });
    if (u === '/api/team/finn' && req.method === 'POST') return readBody((b) => { srv.probes = (srv.probes || 0) + 1; srv.lastProbe = b; return J({ ok: true, customerScoped: !!b.customerId, checks: [{ scope: 'STUDIO_READ', fn: 'studio.hours', state: 'ok', status: 200 }, { scope: 'MEMBERSHIP_SELF_SERVICE_READ', fn: 'contract.cancelReasons', state: 'forbidden', status: 403 }] }); });
    if (u === '/api/team/finn') {
      const q = new URL(req.url, 'http://x').searchParams;
      if (q.get('view') === 'events') return J({ ok: true, items: [{ type: 'CUSTOMER_CHECKIN', action: 'checkin', klass: 'handled', at: Date.now(), dedup: 'id' }, { type: 'CUSTOMER_CHECKIN', action: 'duplicate', klass: 'duplicate', at: Date.now(), dedup: 'id' }] });
      if (q.get('view') === 'agents') return J({ ok: true, agents: [{ key: 'contract', name: 'Vertrag', purpose: 'Vertrag', actors: ['member'], tools: ['get_contract', 'cancel_contract'] }], tools: [{ name: 'cancel_contract', risk: 'HIGH', scopes: ['MEMBERSHIP_SELF_SERVICE_WRITE'], actors: ['member'], description: 'Kündigen' }] });
      return J({ ok: true, mode: { agents: true, magicline: 'live', ai: true, kv: 'kv', automations: 'timeline,retention', publicChat: false, emailDraft: false }, capabilities: [{ scope: 'CUSTOMER_READ', purpose: 'Kunde', state: 'ok', light: 'green', declared: true, at: Date.now() }, { scope: 'APPOINTMENTS_WRITE', purpose: 'Termine', state: 'forbidden', light: 'red', declared: false, at: Date.now() }, { scope: 'MEMBER_LIST_READ', purpose: 'Liste', state: 'unknown', light: 'yellow', declared: false, neverAssume: true }], webhook: { types: [{ type: 'CUSTOMER_CHECKIN', count: 12 }], lastType: 'CUSTOMER_CHECKIN', lastAt: Date.now() }, events: { handled: 12, duplicate: 1, unknown: 0, error: 0, automation_error: 0, last: [{ type: 'CUSTOMER_CHECKIN', action: 'checkin', klass: 'handled', at: Date.now() }] }, audit: { proposed: 3, confirmed: 2, declined: 1, handoff: 1, forbidden: 0 }, metrics: { 'finn.turn': 9, 'finn.blocked': 1 } });
    }
    if (u.indexOf('/api/team/') === 0) return J({ ok: true, items: [], conversations: [], members: [], todos: [], leads: [], offers: [], joins: [], employees: [] });
    if (u.indexOf('/api/') === 0) return J({ ok: true });
    let f = path.join(ROOT, u === '/' ? '/mitglieder.html' : (u.indexOf('/team') === 0 ? '/team-backend.html' : u));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : (u.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8') });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;
  const b = await chromium.launch({ executablePath: bin });

  // ── 2. Mitglieder-Chat: Bestätigungskarte ──
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
  await click('[data-act="openFinn"]'); await p.waitForTimeout(400);
  await p.evaluate(function () { const t = document.getElementById('finn_q'); t.value = 'Storniere mein Einführungstraining'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('#finn_send'); await p.waitForTimeout(700);
  let card = await p.evaluate(function () { const c = document.querySelector('.fcMsg.fcCf'); if (!c) return null; const y = c.querySelector('[data-act="finnConfirm"]'), n = c.querySelector('[data-act="finnDecline"]'); return { high: c.classList.contains('high'), yes: y ? y.textContent : null, no: n ? n.textContent : null, yH: y ? y.getBoundingClientRect().height : 0, text: c.innerText }; });
  ok('2. MEDIUM-Vorschlag als Karte mit „Ja, so machen"/„Abbrechen", Knöpfe ≥ 38 px', !!card && !card.high && /Ja, so machen/.test(card.yes) && /Abbrechen/.test(card.no) && card.yH >= 38 && /Einführungstraining/.test(card.text), JSON.stringify(card));
  ok('2a. Ohne Klick wurde nichts bestätigt', srv.confirmed === 0 && srv.declined === 0);
  // Neuladen: Karte bleibt (sessionStorage), noch offen
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900);
  await click('[data-act="openFinn"]'); await p.waitForTimeout(400);
  card = await p.evaluate(function () { const c = document.querySelector('.fcMsg.fcCf'); return c ? { yes: !!c.querySelector('[data-act="finnConfirm"]') } : null; });
  ok('2b. Nach Neuladen: Vorschlag noch da und offen', !!card && card.yes, JSON.stringify(card));
  await click('[data-act="finnConfirm"]'); await p.waitForTimeout(700);
  const after = await p.evaluate(function () { const c = document.querySelector('.fcMsg.fcCf'); const st = c && c.querySelector('.fcCfState'); const last = document.querySelectorAll('#finn_scroll .fcMsg'); return { state: st ? st.textContent : null, btn: !!(c && c.querySelector('[data-act="finnConfirm"]')), last: last[last.length - 1].innerText }; });
  ok('2c. Bestätigt: genau ein Server-Aufruf, Karte zeigt „Bestätigt", Ergebnisblase folgt', srv.confirmed === 1 && after.state === 'Bestätigt' && !after.btn && /Erledigt/.test(after.last), JSON.stringify(after));
  ok('2d. Bestätigung schickt nur action+id (keine Frage, kein Verlauf)', srv.posts.some((x) => x.action === 'confirm' && x.id === 'cf_med_00001' && !x.question && !x.history));
  // HIGH: rote Karte, verbindlicher Knopf, Abbrechen
  await p.evaluate(function () { const t = document.getElementById('finn_q'); t.value = 'Ich möchte kündigen'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('#finn_send'); await p.waitForTimeout(700);
  const high = await p.evaluate(function () { const cs = document.querySelectorAll('.fcMsg.fcCf'); const c = cs[cs.length - 1]; const y = c.querySelector('[data-act="finnConfirm"]'); return { high: c.classList.contains('high'), lbl: (c.querySelector('.fcCfLbl') || {}).textContent, yes: y ? y.textContent : '', border: getComputedStyle(c.querySelector('.fcB')).borderColor }; });
  ok('2e. HIGH-Vorschlag: Warnlabel, „verbindlich bestätigen", roter Rahmen', high.high && /Wichtige Änderung/.test(high.lbl) && /verbindlich/.test(high.yes), JSON.stringify(high));
  await p.evaluate(function () { const cs = document.querySelectorAll('[data-act="finnDecline"]'); cs[cs.length - 1].click(); }); await p.waitForTimeout(600);
  const dec = await p.evaluate(function () { const cs = document.querySelectorAll('.fcMsg.fcCf'); const c = cs[cs.length - 1]; const st = c.querySelector('.fcCfState'); return st ? st.textContent : null; });
  ok('2f. Abbrechen: Karte zeigt „Abgebrochen", Server hat decline bekommen', dec === 'Abgebrochen' && srv.declined === 1 && srv.confirmed === 1);
  ok('2g. Keine Skriptfehler', fehler.length === 0, fehler.join(' | '));
  await c.close();

  // ── 3. Team-Backend: Seite „FINN & Magicline" ──
  async function teamPage(role) {
    srv.role = role;
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', function (e) { errs.push(String(e.message)); });
    await pg.addInitScript(function (r) { try { localStorage.setItem('fi_team_token', 'tok'); localStorage.setItem('fi_team_role', r); localStorage.setItem('fi_team_name', 'Chef'); } catch (e) {} }, role);
    await pg.goto(basis + '/team/finn', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(1200);
    return { ctx: ctx, pg: pg, errs: errs };
  }
  let t = await teamPage('admin');
  const st = await t.pg.evaluate(function () { const txt = document.body.innerText; const lights = document.querySelectorAll('[data-light="green"]').length + document.querySelectorAll('[data-light="red"]').length + document.querySelectorAll('[data-light="yellow"]').length; return { title: /FINN & Magicline/.test(txt), scopes: /CUSTOMER_READ/.test(txt) && /APPOINTMENTS_WRITE/.test(txt) && /403 gemerkt/.test(txt) && /wird nie angenommen/.test(txt), mode: /MOCK|live/.test(txt), tabs: document.querySelectorAll('[data-finnview]').length, lights: lights, nav: !!document.querySelector('[data-nav="finn"]') }; });
  ok('3. Admin sieht Status: Titel, Scope-Ampel mit 403-Hinweis, vier Reiter, Nav-Eintrag', st.title && st.scopes && st.mode && st.tabs === 4 && st.lights >= 3 && st.nav, JSON.stringify(st));
  // Scope-Probe: Kunden-Id eintippen, prüfen, Ergebniszeile erscheint, Status wird neu geladen
  await t.pg.evaluate(function () { const i = document.querySelector('[data-finnprobe-cid]'); i.value = '12x34'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-finnprobe]').click(); }); await t.pg.waitForTimeout(900);
  const pr = await t.pg.evaluate(function () { return { msg: document.body.innerText.match(/\d+ von \d+ Prüfungen[^\n]*/) ? RegExp.lastMatch : null }; });
  ok('3p. Scope-Probe: nur Ziffern als Kunden-Id, Ergebniszeile mit „kein Recht"', srv.probes === 1 && srv.lastProbe && srv.lastProbe.action === 'probe' && srv.lastProbe.customerId === '1234' && pr.msg && /1 von 2/.test(pr.msg) && /kein Recht: MEMBERSHIP_SELF_SERVICE_READ/.test(pr.msg), JSON.stringify({ probes: srv.probes, last: srv.lastProbe, msg: pr.msg }));
  // Reiterleiste scrollt waagerecht (kein abgeschnittener Reiter auf dem Handy)
  const tb = await t.pg.evaluate(function () { const bar = document.querySelector('[data-finnview]').parentElement; return getComputedStyle(bar).overflowX; });
  ok('3q. Reiterleiste ist waagerecht scrollbar', tb === 'auto', tb);
  await t.pg.evaluate(function () { document.querySelector('[data-finnview="events"]').click(); }); await t.pg.waitForTimeout(700);
  const ev = await t.pg.evaluate(function () { const txt = document.body.innerText; return /duplicate/.test(txt) && /CUSTOMER_CHECKIN/.test(txt); });
  ok('3a. Reiter Webhook-Events lädt und zeigt Duplikate', ev);
  ok('3b. Keine Skriptfehler (Admin)', t.errs.length === 0, t.errs.join(' | '));
  await t.ctx.close();
  t = await teamPage('trainer');
  const tr = await t.pg.evaluate(function () { return { nav: !!document.querySelector('[data-nav="finn"]'), title: /FINN & Magicline/.test(document.body.innerText) }; });
  ok('3c. Angestellte: kein Nav-Eintrag, Seite nicht erreichbar (Umleitung)', !tr.nav && !tr.title, JSON.stringify(tr));
  await t.ctx.close();

  await b.close(); server.close();
  console.log(pass ? 'FINN-UI PASS' : 'FINN-UI FAIL');
  process.exit(pass ? 0 : 1);
})();
