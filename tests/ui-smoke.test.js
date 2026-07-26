'use strict';
/**
 * Browser-Smoke der Mitglieder-App: jeder Screen muss rendern, ohne JS-Fehler und
 * ohne leer zu bleiben - mit Daten, im Fehlerfall und in beiden Farbschemata.
 *
 * Warum: alle uebrigen Tests laufen serverseitig. Die Client-Logik (468 Klickziele,
 * 29 Screens) war im Repo ungetestet; Fehler dort fielen erst Mitgliedern auf.
 *
 * Der Test ueberspringt sich selbst, wenn playwright-core oder ein Chromium fehlen -
 * die CI installiert keine Entwicklungsabhaengigkeiten. Lokal laeuft er mit:
 *   npm i --no-save playwright-core   (Browser via PW_CHROMIUM oder /opt/pw-browsers)
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const url = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TODAY = new Date().toISOString().slice(0, 10);

function skip(grund) {
  console.log('UI-SMOKE UEBERSPRUNGEN: ' + grund);
  process.exit(0);
}

let chromium;
try { chromium = require('playwright-core').chromium; }
catch (e) { skip('playwright-core nicht installiert (npm i --no-save playwright-core)'); }

// Chromium finden: explizite Angabe, sonst die ueblichen Ablagen.
function findChromium() {
  if (process.env.PW_CHROMIUM && fs.existsSync(process.env.PW_CHROMIUM)) return process.env.PW_CHROMIUM;
  const bases = ['/opt/pw-browsers', path.join(process.env.HOME || '/root', '.cache/ms-playwright')];
  for (const b of bases) {
    if (!fs.existsSync(b)) continue;
    for (const d of fs.readdirSync(b)) {
      if (!/^chromium-/.test(d)) continue;
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(b, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
    const flat = path.join(b, 'chromium');
    if (fs.existsSync(flat) && fs.statSync(flat).isFile()) return flat;
  }
  return null;
}
const EXE = findChromium();
if (!EXE) skip('kein Chromium gefunden (PW_CHROMIUM setzen oder /opt/pw-browsers befuellen)');

// ── Antwortdaten fuer die gestubbten Endpunkte ──
const PLAN = { id: 'p1', title: 'Ganzkoerper', level: 'mittel', daysPerWeek: 3, location: 'studio', emoji: '💪', source: 'library', days: [{ name: 'Tag A', exercises: [{ name: 'Beinpresse', machine: 'Leg Press', bio: true }, { name: 'Bankdruecken', machine: 'Multipower', sets: 3, reps: '8', rest: '90 s' }] }] };
const TRAIN = { ok: true, available: true, tip: 'Progressive Ueberlastung.', inspiration: [{ title: 'Schlaf', text: 'Erholung zaehlt.', tag: 'Wissen', emoji: '😴' }], plans: [{ id: 'p1', title: 'Ganzkoerper', subtitle: 'Der Start', level: 'mittel', daysPerWeek: 3, location: 'studio', emoji: '💪', summary: 'Ganzer Koerper.', aiAssist: true }], goals: { aufbau: 'Muskelaufbau' }, levels: { mittel: 'Mittel' }, locations: { studio: 'Studio' }, exercises: [{ id: 'e1', name: 'Beinpresse', machine: 'Leg Press', bio: true, cue: 'Anmelden.', group: 'beine', groupLabel: 'Beine', equip: 'Maschine' }], exerciseGroups: [['beine', 'Beine']], myPlan: { source: 'library', startedAt: 1, plan: PLAN }, premium: false, aiAvailable: true, quota: { used: 0, remaining: 5, limit: 5 } };
const NUT = { ok: true, available: true, onboarded: true, premium: false, quota: { used: 2, limit: 5, month: TODAY.slice(0, 7) }, profile: { goal: 'aufbau' }, targets: { kcal: 2100, protein: 130, carbs: 230, fat: 70, water: 2.8 }, today: { date: TODAY, isToday: true, totals: { kcal: 900, p: 60, c: 90, f: 30 }, water: 2, waterGoal: 8, entries: [{ id: 'e1', name: 'Haferflocken', meal: 'fruehstueck', kcal: 350, p: 12, c: 55, f: 7, grade: 'A' }] }, streak: 4, pointsToday: 20, fasting: { plan: '16:8', start: null, active: false } };
const COACH = { ok: true, available: true, enrolled: true, week: 2, totalWeeks: 20, premium: false, streak: 3, startDate: TODAY, lessons: [{ week: 1, title: 'Ankommen', teaser: 'x', minutes: 8, completed: true, unlocked: true }], currentLesson: { week: 2, title: 'Kalorien', teaser: 'y', minutes: 10, completed: false }, todayHabits: [{ id: 'h1', text: 'Eiweiss', done: false }] };
const VORGANG = { id: 'v1', ref: 'FI-1', subject: 'Frage', status: 'offen', unread: false, createdAt: Date.now() - 8e5, messages: [{ from: 'team', text: 'Hallo!', at: Date.now() - 7e5 }] };
const ME = { ok: true, profile: { firstName: 'Max', lastName: 'Muster' }, contract: { rateName: 'Premium', active: true }, membershipActive: true };

const SCREENS = ['home', 'tag', 'ern', 'coach', 'profil', 'data', 'contract', 'account', 'appt', 'checkin', 'referral', 'checkins', 'postfach', 'help', 'settings', 'card', 'fort', 'figur', 'inbody', 'morning', 'abo', 'recht', 'impressum', 'datenschutz', 'agb', 'blog', 'insta', 'social', 'finnusage'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' };

// Eigener Server statt page.route: Request-Interception schaltet in Chromium den
// HTTP-Cache ab und faerbt Messungen ein. Ausserdem bleibt der Test so hermetisch.
function startServer(mode) {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(url.parse(req.url).pathname);
    if (p.indexOf('/api/') === 0) {
      const j = (o, code) => { res.statusCode = code || 200; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'private, no-store'); res.end(JSON.stringify(o)); };
      if (/\/api\/member\/me$/.test(p)) return j(ME);                 // sonst landet die App im Login
      if (mode === 'fehler') return j({ ok: false, error: 'server' }, 500);
      if (p.indexOf('nutrition-coach') >= 0) return j(COACH);
      if (p.indexOf('nutrition') >= 0) return j(NUT);
      if (p.indexOf('training') >= 0) return j(TRAIN);
      if (p.indexOf('inbox') >= 0) return j(req.url.indexOf('id=') > 0 ? { ok: true, vorgang: VORGANG } : { ok: true, vorgaenge: [VORGANG], unread: 0 });
      if (p.indexOf('checkins') >= 0) return j({ ok: true, checkins: [{ in: new Date(Date.now() - 864e5).toISOString() }] });
      return j({ ok: true });
    }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('nope'); }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

(async () => {
  let pass = true;
  const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

  async function durchlauf(mode, theme, screens) {
    const { srv, port } = await startServer(mode);
    const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, colorScheme: theme });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.addInitScript((th) => {
      localStorage.setItem('fi_member_token', 't');
      localStorage.setItem('fi_flags_srv', '{"ern":true,"social":true,"demo":true}');
      localStorage.setItem('fi_ern_test', '1'); localStorage.setItem('fi_theme', th);
      ['fi_tour_v1', 'fi_tour_tag_v1', 'fi_tour_ern_v1', 'fi_tour_coach_v1'].forEach((k) => localStorage.setItem(k, '1'));
      localStorage.setItem('fi_ob_v2', JSON.stringify({ goal: 'aufbau', freq: 3, age: 30, exp: 'mittel' }));
    }, theme);
    // Fremdhosts (Fonts, reCAPTCHA) blocken - ohne Netz im CI wuerden sie nur bremsen.
    await page.route(/googleapis|gstatic|google\.com|recaptcha|cdnjs|cloudflare/, (r) => r.abort().catch(() => {}));

    const kaputt = [];
    for (const s of screens) {
      errs.length = 0;
      await page.goto('http://127.0.0.1:' + port + '/mitglieder.html?go=' + s, { waitUntil: 'commit' });
      let leer = false;
      try {
        // Auf echten Inhalt warten statt fester Pause: schnell und trotzdem verlaesslich.
        await page.waitForFunction(() => { const a = document.getElementById('app'); return a && (a.innerText || '').trim().length > 60; }, null, { timeout: 12000 });
      } catch (e) { leer = true; }
      const probleme = [];
      if (errs.length) probleme.push('JS: ' + errs[0].split('\n')[0]);
      if (leer) probleme.push('kein Inhalt binnen 12 s');
      if (probleme.length) kaputt.push(s + ' -> ' + probleme.join(' | '));
    }
    await ctx.close();
    await new Promise((r) => srv.close(r));
    return kaputt;
  }

  // 1) Alle Screens mit Daten, hell
  let k = await durchlauf('daten', 'light', SCREENS);
  ok('1. ' + SCREENS.length + ' Screens mit Daten (hell)', k.length === 0, k.join(' ; '));

  // 2) Kernscreens dunkel - faengt Dark-Mode-Regressionen
  const KERN = ['home', 'tag', 'ern', 'coach', 'profil', 'postfach', 'fort', 'morning'];
  k = await durchlauf('daten', 'dark', KERN);
  ok('2. ' + KERN.length + ' Kernscreens dunkel', k.length === 0, k.join(' ; '));

  // 3) Fehlerfall: keine API antwortet ausser /me. Nichts darf abstuerzen oder leer bleiben.
  k = await durchlauf('fehler', 'light', KERN);
  ok('3. ' + KERN.length + ' Kernscreens bei API-Fehler 500', k.length === 0, k.join(' ; '));

  await browser.close();
  console.log(pass ? 'UI-SMOKE PASS' : 'UI-SMOKE FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('UI-SMOKE HARNESS-FEHLER', e); process.exit(1); });
