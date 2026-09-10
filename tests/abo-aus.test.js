'use strict';
// Abo-Modell aus, Coach fuer alle - und der Coach auf die drei Zwecke der App
// umgebaut: Mitgliedschaft, Termine, Coaching.
//
// Was hier auf dem Spiel steht: Ein uebersehener Premium-Rest ist kein
// Schoenheitsfehler, sondern eine Sperre fuer ein Mitglied, das dafuer nichts
// mehr zahlen kann. Und ein FINN, der weiter vom Ernaehrungstagebuch oder vom
// Trainingsplan in der App spricht, schickt Menschen in Bereiche, die es nicht
// mehr gibt. Beides prueft dieser Test - serverseitig am Hebel, im Prompt am
// Wortlaut, in der Oberflaeche am Ergebnis.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const frisch = (rel) => { delete require.cache[path.resolve(ROOT, rel)]; delete require.cache[path.resolve(ROOT, 'lib/features.js')]; return require(path.resolve(ROOT, rel)); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Der Hebel: Entitlements ohne Abo-Modell ──
delete process.env.FEATURE_ABO; delete process.env.FEATURE_ERN; delete process.env.FEATURE_TRAINING;
let Ent = frisch('lib/entitlements.js');
ok('1. Ohne Abo-Modell ist jedes Mitglied premium - auch ohne Datensatz', Ent.isPremium(null) === true && Ent.isPremium({ tier: 'free' }) === true);
const t = Ent.publicTier(null);
ok('1b. … der Status heisst „inklusive", ohne Testphase, ohne Kuendigen-UI',
  t.premium === true && t.status === 'inklusive' && t.trialEligible === false && t.viaModule === false && t.comp === true, JSON.stringify(t));
ok('1c. Ein abgelaufener Alt-Datensatz sperrt niemanden mehr', Ent.isPremium({ tier: 'premium', status: 'canceled', until: Date.now() - 864e5 }) === true);

process.env.FEATURE_ABO = '1';
Ent = frisch('lib/entitlements.js');
ok('2. Mit FEATURE_ABO=1 gilt das alte Modell wieder', Ent.isPremium(null) === false && Ent.publicTier(null).trialEligible === true);
delete process.env.FEATURE_ABO;

// Das Kontingent ist ohne Abo bedeutungslos: publicQuota meldet fuer premium „unbegrenzt".
const Quota = frisch('lib/nutriquota.js');
ok('3. Ohne Abo gibt es kein Kontingent (unbegrenzt)', Quota.publicQuota(99, Ent.isPremium(null), '2026-09').unlimited === true);

// ── 2. Der Server sagt es dem Client ──
function appInfo() {
  const H = frisch('api/app-info.js');
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; return this; } };
  H({ method: 'GET', headers: {}, url: '/api/app-info' }, res);
  return JSON.parse(res.body);
}
ok('4. /api/app-info meldet abo:false', appInfo().features.abo === false);

// ── 3. FINN weiss, was die App ist - und was nicht ──
process.env.ANTHROPIC_API_KEY = 'test-key';
const AI = frisch('lib/ai.js');
const sys = AI.coachSystem({ firstName: 'Max' }, []);
ok('5. FINN kennt seine drei Aufgaben', /MITGLIEDSCHAFT/.test(sys) && /TERMINE/.test(sys) && /COACHING/.test(sys));
ok('5b. … verweist Ernaehrung an Upfit statt ans eigene Tagebuch', /Upfit/.test(sys) && /kein Ernährungstagebuch/.test(sys));
ok('5c. … verweist Training an die Technogym-App', /Technogym-App/.test(sys) && /keine Trainingspläne in dieser App/.test(sys));
ok('5d. … und sagt: kein Abo, kein Premium', /kein Abo, kein Premium/.test(sys));
ok('5e. … kann auf Upfit, InBody und Figur-Check verlinken', /ern=Ernährung \(Partner Upfit\)/.test(sys) && /inbody=/.test(sys) && /figur=/.test(sys));
ok('5f. … und nicht mehr als „Ernährungsberater" auf das eigene Modul', !/UND Ernährungsberater/.test(sys));

// Schaltet jemand die Module zurueck, redet FINN wieder darueber - die Saetze
// haengen an denselben Schaltern wie die App.
process.env.FEATURE_ERN = '1'; process.env.FEATURE_TRAINING = '1'; process.env.FEATURE_ABO = '1';
const sysAlt = frisch('lib/ai.js').coachSystem({ firstName: 'Max' }, []);
ok('6. Mit den Modulen redet FINN wieder ueber das eigene Tagebuch und den Bereich Training',
  /Bereich „Ernährung“ dieser App/.test(sysAlt) && /Bereich „Training“ dieser App/.test(sysAlt) && !/kein Abo, kein Premium/.test(sysAlt));
delete process.env.FEATURE_ERN; delete process.env.FEATURE_TRAINING; delete process.env.FEATURE_ABO;

// ── 4. Die Analyse ist frei und nimmt nur, was sie braucht ──
const CI = frisch('api/member/coach-insights.js');
const c = CI.cleanCtx({ goal: 'abnehmen <script>', freq: '9', figur: { date: '2026-09-01T10:00', weight: '82.4', waist: 'x' }, inbody: { weight: 999, muscle: 33.2, fat: 21.5 }, plan: { title: 'darf nicht durch' }, nutrition: { kcal: 1 } });
ok('7. Der Kontext wird gesaeubert: Ziel ohne Sonderzeichen, Wunschtage nur 1-7', c.goal === 'abnehmen script' && c.freq === null, JSON.stringify(c));
ok('7b. … Koerperwerte nur im plausiblen Bereich', c.figur.weight === 82.4 && c.figur.waist === null && c.figur.date === '2026-09-01' && c.inbody.weight === null && c.inbody.muscle === 33.2, JSON.stringify(c));
ok('7c. … und nichts vom alten Trainings-/Ernaehrungskontext', !('plan' in c) && !('nutrition' in c));
const quelle = fs.readFileSync(path.join(ROOT, 'api/member/coach-insights.js'), 'utf8');
ok('7d. Kein Kontingent, kein Premium mehr in der Analyse', !/premium_required|nutriquota|entitlements/.test(quelle));

// ── 5. WhatsApp: keine Werkzeuge fuer Bereiche, die es nicht gibt ──
const WA = frisch('lib/waAgent.js');
const sysWa = (function () { try { return WA.__buildSysForTest ? WA.__buildSysForTest() : null; } catch (e) { return null; } })();
ok('8. Der WhatsApp-Agent kennt log_workout und log_weight_checkin weiterhin (fuer die Schalter)',
  WA.ACTION_TOOLS.some((x) => x.name === 'log_workout') && WA.ACTION_TOOLS.some((x) => x.name === 'log_weight_checkin'));
const waQuelle = fs.readFileSync(path.join(ROOT, 'lib/waAgent.js'), 'utf8');
ok('8b. … bietet sie dem Modell ohne Module aber nicht an', /TRAIN_TOOLS = \['log_workout'\]/.test(waQuelle) && /'log_weight_checkin'\]/.test(waQuelle) && /F\.trainOn\(\) && TRAIN_TOOLS/.test(waQuelle));
void sysWa;

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const bin = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden - die Oberflaeche wurde NICHT geprueft.');
    console.log(pass ? 'ABO-AUS PASS (ohne Browser)' : 'ABO-AUS FAIL');
    process.exit(pass ? 0 : 1);
  }

  const heute = new Date(); const in3 = new Date(Date.now() + 3 * 864e5);
  const server = http.createServer(function (req, res) {
    const u = String(req.url || '').split('?')[0];
    if (u === '/api/member/appointments') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, appointments: [{ id: 'a1', title: 'Stoffwechselanalyse', startDateTime: in3.toISOString() }] })); }
    if (u === '/api/member/checkins') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, checkins: [{ in: new Date(Date.now() - 864e5).toISOString() }] })); }
    if (u.indexOf('/api/') === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    const f = path.join(ROOT, u === '/' ? '/mitglieder.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const basis = 'http://127.0.0.1:' + server.address().port;
  void heute;

  const b = await chromium.launch({ executablePath: bin });
  const oeffne = async function (flags, pfad) {
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await c.newPage();
    const fehler = [];
    p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    await p.addInitScript(function (fl) {
      try {
        localStorage.setItem('fi_member_token', 'test');
        localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'abnehmen', freq: 3, age: 34, exp: 'fortgeschritten' }));
        localStorage.setItem('fi_flags_srv', JSON.stringify(Object.assign({ ern: false, social: false, demo: false, train: false, vital: false, abo: false, upfit: 'https://fit-inn-trier.upfit.io/' }, fl)));
        localStorage.setItem('fi_tour_v1', '1'); localStorage.setItem('fi_welcome_seen', '1');
      } catch (e) {}
    }, flags || {});
    await p.goto(basis + (pfad || '/mitglieder.html'), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    return { p: p, c: c, fehler: fehler };
  };
  const klick = async function (p, sel, ms) { await p.evaluate(function (s) { const el = document.querySelector(s); if (el) el.click(); }, sel); await p.waitForTimeout(ms || 500); };
  const text = (p) => p.evaluate(function () { return document.body.innerText; });

  // ── 6. Der Coach-Tab: eine Seite fuer die drei Zwecke ──
  let r = await oeffne({});
  await klick(r.p, '.btmnav [data-act="nav"][data-arg="coach"]', 900);
  let t = await text(r.p);
  const coach = await r.p.evaluate(function () {
    return {
      reiter: document.querySelectorAll('[data-act="coachTab"]').length,
      woche: !!document.querySelector('[data-coach="woche"]'),
      schritte: !!document.querySelector('[data-coach="schritte"]'),
      partner: !!document.querySelector('[data-coach="partner"]'),
      technogym: !!document.querySelector('[data-partner="technogym"]'),
      upfit: !!document.querySelector('[data-upfit="coach"]'),
      chat: !!document.querySelector('[data-act="openFinn"]'),
      analyse: !!document.querySelector('[data-act="coachFinn"]'),
    };
  });
  ok('9. Keine Themen-Reiter mehr, dafuer Woche, Schritte und Partner',
    coach.reiter === 0 && coach.woche && coach.schritte && coach.partner, JSON.stringify(coach));
  ok('9b. FINN-Chat und Analyse sind da - fuer alle', coach.chat && coach.analyse, JSON.stringify(coach));
  ok('9c. Die Partner-Karte zeigt Technogym und Upfit', coach.technogym && coach.upfit, JSON.stringify(coach));
  ok('9d. Der Untertitel nennt die drei Zwecke', /Mitgliedschaft, Termine & Ziele/.test(t));
  ok('9e. „Deine Woche" kennt den naechsten Termin und den Besuch', /Nächster Termin: Stoffwechselanalyse/.test(t) && /Letzter Besuch/.test(t) && /gestern/.test(t), t.slice(0, 300));
  ok('9f. Der Blick fuer heute spricht vom Termin', /Dein nächster Termin steht: Stoffwechselanalyse/.test(t));
  // Der Kern: nichts vom alten Modell scheint durch.
  ok('10. Kein Premium, kein Upgrade, kein Tagebuch, kein Trainingsplan-Versprechen auf dem Coach-Tab',
    !/Premium|Upgrade|Essen-Tagebuch|Zum Trainingsplan|Wochen-Lern|Lernen/.test(t), t.slice(0, 400));
  ok('10b. … ohne Skriptfehler', r.fehler.length === 0, r.fehler.join(' | '));

  // Suche: „Mein Abo" gibt es nicht mehr.
  await klick(r.p, '[data-act="findOpen"]', 400);
  await r.p.evaluate(function () { const i = document.querySelector('input'); if (i) { i.value = 'abo'; i.dispatchEvent(new Event('input', { bubbles: true })); } });
  await r.p.waitForTimeout(300);
  t = await text(r.p);
  ok('11. Die Suche kennt „Mein Abo" nicht mehr', !/Mein Abo|Premium-Status/.test(t));
  await klick(r.p, '[data-act="findClose"]', 300);
  await r.c.close();

  // Deep-Links auf die Abo-Screens landen auf der Startseite.
  r = await oeffne({}, '/mitglieder.html?go=abo');
  t = await text(r.p);
  ok('12. ?go=abo fuehrt nicht mehr auf den Abo-Screen', !/Premium-Status|Coach Premium/.test(t) && !/Mein Abo/.test(t));
  await r.c.close();

  // Datenschutzerklaerung: keine Premium-Karte, kein Widerruf-Link im Footer.
  r = await oeffne({}, '/mitglieder.html?go=datenschutz');
  t = await text(r.p);
  ok('13. Die Datenschutzerklaerung nennt kein „Coach Premium & Zahlung" mehr', !/Coach Premium & Zahlung/.test(t));
  const footer = await r.p.evaluate(function () { return Array.prototype.some.call(document.querySelectorAll('[data-act="nav"][data-arg="recht"]'), function () { return true; }); });
  ok('13b. … und es gibt keinen „Widerruf"-Link mehr', footer === false);
  await r.c.close();

  // Rueckweg: mit abo:true ist alles wieder da (das alte Modell bleibt schaltbar).
  r = await oeffne({ abo: true }, '/mitglieder.html?go=datenschutz');
  t = await text(r.p);
  const footerAlt = await r.p.evaluate(function () { return !!document.querySelector('[data-act="nav"][data-arg="recht"]'); });
  ok('14. Mit Schalter erscheinen Rechtstext und Widerruf wieder', /Coach Premium & Zahlung/.test(t) && footerAlt === true);
  await r.c.close();

  await b.close();
  server.close();
  console.log(pass ? 'ABO-AUS PASS' : 'ABO-AUS FAIL');
  process.exit(pass ? 0 : 1);
})();
