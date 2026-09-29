'use strict';
// FINN Journeys – Echtbetrieb-Schalter tolerant lesen, unbekannten Wert melden;
// Durchlauf aus App-Verkehr: nur mit Vercels waitUntil, höchstens alle 14 min
// (KV „SET NX"), je Instanz höchstens eine Nachfrage pro Minute, wartet nicht auf
// den Durchlauf; letzter Durchlauf wird vermerkt und im Team-Backend gezeigt.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
delete process.env.JOURNEYS; delete process.env.JOURNEYS_TRACK; delete process.env.JOURNEYS_MODE; delete process.env.JOURNEYS_TEST_NUMBERS;

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
inject('lib/teamAuth.js', { requireTeam: async () => ({ role: 'admin', name: 'Anna' }), roleOf: () => 'admin', isAdmin: () => true, bearer: () => 't', destroySession: async () => {} });
const runs = [];
let release = null;
inject('lib/journeys/tick.js', Object.assign({}, require(path.join(ROOT, 'lib/journeys/tick.js')), {
  run: async (o) => { runs.push(o); await new Promise((r) => { release = r; }); return { ok: true, fertig: true }; },
}));

const Config = require(path.join(ROOT, 'lib/journeys/config.js'));
const Auto = require(path.join(ROOT, 'lib/journeys/autotick.js'));
const KV = require(path.join(ROOT, 'lib/finn/kv.js'));

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // 1. Echtbetrieb-Schalter
  const cases = [['auto', 'auto', 'auto'], [' Auto ', 'auto', 'auto'], ['"auto"', 'auto', 'auto'], ['JOURNEYS_MODE=auto', 'auto', 'auto'], ['AUTO\n', 'auto', 'auto'],
    ['', 'dry', 'unset'], ['dry', 'dry', 'dry'], ['Probelauf', 'dry', 'dry'], ['echt', 'dry', 'unknown'], ['1', 'dry', 'unknown'], ['automatisch', 'dry', 'unknown']];
  const bad = cases.filter(([v, m, st]) => { process.env.JOURNEYS_MODE = v; return Config.mode() !== m || Config.modeState() !== st; });
  ok('1. JOURNEYS_MODE: Schreibweisen von „auto" werden erkannt, alles andere bleibt Probelauf', !bad.length, JSON.stringify(bad));
  delete process.env.JOURNEYS_MODE;

  // 2. Ohne Journeys oder ohne waitUntil: nichts
  ok('2. ohne JOURNEYS/JOURNEYS_TRACK: kein Anstoß', Auto.maybe('x') === false && runs.length === 0);
  process.env.JOURNEYS = '1';
  Auto._reset();
  ok('2a. ohne Vercel-Kontext (kein waitUntil): kein Anstoß', Auto.maybe('x') === false && runs.length === 0);

  // 3. Mit waitUntil: einmal, wartet nicht
  const pending = [];
  globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: (p) => { pending.push(p); } }) };
  Auto._reset();
  const t0 = Date.now();
  const r1 = Auto.maybe('checkins');
  ok('3. mit waitUntil: sofort zurück, Durchlauf im Hintergrund eingeplant', r1 === true && Date.now() - t0 < 50 && pending.length === 1);
  await new Promise((r) => setTimeout(r, 20));
  ok('3a. Durchlauf gestartet mit kleinem Budget und Quelle', runs.length === 1 && runs[0].budgetMs === 20000 && runs[0].src === 'app:checkins', JSON.stringify(runs));
  ok('3b. gleiche Instanz innerhalb einer Minute: keine neue Nachfrage', Auto.maybe('account') === false && pending.length === 1);
  Auto._reset();
  ok('3c. andere Instanz innerhalb von 14 min: KV-Sperre verhindert zweiten Lauf', Auto.maybe('account') === true);
  await new Promise((r) => setTimeout(r, 20));
  ok('3d. … es läuft trotzdem nur einer', runs.length === 1);
  release(); await Promise.all(pending);

  // 4. Sperre abgelaufen → nächster Lauf
  await KV.del(Auto.KEY); Auto._reset();
  Auto.maybe('magicline'); await new Promise((r) => setTimeout(r, 20));
  ok('4. nach Ablauf der Sperre: nächster Durchlauf', runs.length === 2 && runs[1].src === 'app:magicline');
  release(); await Promise.all(pending);

  // 4b. Cron läuft (letzter Durchlauf < 10 min) → kein Anstoß aus dem App-Verkehr
  await KV.del(Auto.KEY); Auto._reset();
  await KV.set('jr:lasttick', { at: Date.now() - 3 * 60000, src: 'cron' }, 3600);
  const n4 = runs.length;
  Auto.maybe('checkins'); await new Promise((r) => setTimeout(r, 20));
  ok('4b. frischer Cron-Durchlauf: App stößt nichts an', runs.length === n4);
  await KV.del('jr:lasttick');

  // 5. Fehler im Durchlauf bleiben im Hintergrund
  delete require.cache[path.resolve(ROOT, 'lib/journeys/tick.js')];
  inject('lib/journeys/tick.js', { run: async () => { throw new Error('boom'); }, lastRun: async () => null });
  await KV.del(Auto.KEY); Auto._reset();
  let threw = false; try { Auto.maybe('x'); await Promise.all(pending); } catch (e) { threw = true; }
  ok('5. Fehler im Durchlauf werfen nicht in die Anfrage', !threw);
  delete globalThis[Symbol.for('@vercel/request-context')];

  // 6. Letzter Durchlauf wird vermerkt (echter tick.run) und im Team-Backend gezeigt
  delete require.cache[path.resolve(ROOT, 'lib/journeys/tick.js')];
  delete require.cache[path.resolve(ROOT, 'api/team/journeys.js')];
  const Tick = require(path.join(ROOT, 'lib/journeys/tick.js'));
  process.env.JOURNEYS_MODE = 'Auto ';
  const out = await Tick.run({ budgetMs: 5000, src: 'workflow' });
  const last = await Tick.lastRun();
  ok('6. tick.run vermerkt Zeit und Quelle', out.ok && last && last.src === 'workflow' && Date.now() - last.at < 60000, JSON.stringify(last));
  const H = require(path.join(ROOT, 'api/team/journeys.js'));
  const res = { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } };
  await H({ method: 'GET', url: '/api/team/journeys', headers: {}, on() { return this; } }, res);
  const j = JSON.parse(res.body || '{}');
  ok('6a. Übersicht: Echtbetrieb erkannt, letzter Durchlauf sichtbar', j.mode && j.mode.mode === 'auto' && j.mode.modeState === 'auto' && j.mode.lastTick && j.mode.lastTick.src === 'workflow', JSON.stringify(j.mode));
  process.env.JOURNEYS_MODE = 'echt';
  const res2 = { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } };
  await H({ method: 'GET', url: '/api/team/journeys', headers: {}, on() { return this; } }, res2);
  const j2 = JSON.parse(res2.body || '{}');
  ok('6b. unbekannter Wert: Probelauf + Hinweis-Zustand', j2.mode.mode === 'dry' && j2.mode.modeState === 'unknown');

  console.log(pass ? 'JOURNEYS AUTOTICK PASS' : 'JOURNEYS AUTOTICK FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
