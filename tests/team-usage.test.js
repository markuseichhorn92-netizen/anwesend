'use strict';
// Team-Backend „Zuletzt benutzt" (lib/teamUsage) und Altdaten entfernter Funktionen:
// Zeitstempel aus vorhandenen Daten, Bots zählen nicht als Team; Altdaten zählen/löschen
// nur die festen Präfixe (todo:, shf:, nutri:usage:) – nichts anderes; nur Admin.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';

const R = require('./_memredis').create();
inject('lib/store.js', Object.assign({}, R.store, { getTypicalWeek: async () => null }));
let SESSION = { role: 'admin', user: 'Anna' };
inject('lib/teamAuth.js', { requireTeam: async () => SESSION, roleOf: (s) => (s ? s.role : null), isAdmin: (s) => !!s && s.role === 'admin', bearer: () => 't', destroySession: async () => {} });
inject('lib/inbox.js', { listAll: async () => CASES });
inject('lib/articles.js', { seedDefaults: async () => {}, list: async () => ARTS });
inject('lib/handled.js', { totals: async () => ({ ai: 0, system: 0, team: 0, quote: 0 }) });
inject('lib/leadflow.js', { listLeads: async () => [{ updatedAt: Date.now() - 2 * 86400000 }] });
inject('lib/members.js', { readBody: async (req) => req.__body || {} });

const NOW = Date.now(), DAY = 86400000;
const CASES = [
  { type: 'whatsapp', teamStatus: 'neu', messages: [{ from: 'member', at: NOW - 3 * DAY }, { from: 'team', author: 'FINN', at: NOW - 3 * DAY + 1000 }, { from: 'team', author: 'Kathrin', at: NOW - 2 * DAY }], notes: [{ author: 'System', at: NOW - DAY }] },
  { type: 'allgemein', teamStatus: 'abgeschlossen', messages: [{ from: 'team', author: 'FINN · Journey', at: NOW - 1000 }], notes: [{ author: 'Tom', at: NOW - 40 * DAY }] },
];
const ARTS = [{ title: 'A', updatedAt: new Date(NOW - 5 * DAY).toISOString() }];
const H = require(path.join(ROOT, 'api/team/stats.js'));
const Usage = require(path.join(ROOT, 'lib/teamUsage.js'));

async function call(method, body) {
  const res = { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } };
  await H({ method: method, url: '/api/team/stats', headers: {}, __body: body }, res);
  return { status: res.statusCode, json: JSON.parse(res.body || '{}') };
}

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };
  const P = R.store.redisPipeline;
  const ym = new Date(NOW).toISOString().slice(0, 7);
  await P([
    ['SET', 'kb:m:' + ym, JSON.stringify({ updatedAt: new Date(NOW - 3 * DAY).toISOString(), closedAt: null })],
    ['ZADD', 'wb:offer:idx', String(NOW - 10 * DAY), 'o1'], ['ZADD', 'wb:offer:idx', String(NOW - 70 * DAY), 'o2'],
    ['SET', 'jr:cfg', JSON.stringify({ updatedAt: NOW - DAY, updatedBy: 'Anna' })],
    ['SADD', 'push:team:tokens', 'tk1'], ['SET', 'push:team:meta:tk1', JSON.stringify({ who: 'Kathrin', at: NOW - 4 * DAY })],
    // Altdaten + etwas, das NICHT gelöscht werden darf
    ['SET', 'todo:1', '{}'], ['SET', 'todo:idx', 'x'], ['SET', 'shf:v:1', '{}'], ['SET', 'shf:emp:2', '{}'], ['SET', 'nutri:usage:snap', '{}'],
    ['SET', 'nutri:p:4711', '{"bleibt":1}'], ['SET', 'pf:v:1:1', '{}'],
  ]);

  // 1. Übersicht
  const r = await call('GET');
  const rows = (r.json.lastUsed && r.json.lastUsed.rows) || [];
  const by = (k) => rows.find((x) => x.key === k) || {};
  ok('1. Statistiken liefern „Zuletzt benutzt"', r.status === 200 && rows.length >= 8, JSON.stringify(r.json).slice(0, 200));
  ok('1a. Posteingang: letzte echte Team-Antwort (Bots/System zählen nicht)', by('inbox').who === 'Kathrin' && Math.abs(by('inbox').at - (NOW - 2 * DAY)) < 1000 && by('inbox').n30 === 1, JSON.stringify(by('inbox')));
  ok('1b. Rückholung: letztes Angebot, 30 Tage = 1', Math.abs(by('wb').at - (NOW - 10 * DAY)) < 1000 && by('wb').n30 === 1, JSON.stringify(by('wb')));
  ok('1c. Kassenbuch, Journeys, Team-App, Artikel, Leads', by('kassenbuch').at && by('journeys').who === 'Anna' && by('teamapp').who === 'Kathrin' && by('help').at && by('leads').note, JSON.stringify(rows.map((x) => x.key + ':' + !!x.at)));
  ok('1d. Nicht messbare Bereiche werden genannt', (r.json.lastUsed.ohne || []).indexOf('Termine') >= 0);
  ok('1e. keine Ernährungs-Auswertung mehr', !('nutrition' in r.json));

  // 2. Altdaten
  let a = await call('POST', { action: 'altdaten', step: 'count' });
  const g = {}; (a.json.gruppen || []).forEach((x) => { g[x.key] = x.anzahl; });
  ok('2. zählen: Aufgaben 2, Schichtplan 2, Auswertung 1', a.json.ok && a.json.fertig && g.todo === 2 && g.shf === 2 && g.nutri_usage === 1, JSON.stringify(a.json));
  a = await call('POST', { action: 'altdaten', step: 'delete' });
  const left = await P([['GET', 'todo:1'], ['GET', 'shf:v:1'], ['GET', 'nutri:usage:snap'], ['GET', 'nutri:p:4711'], ['GET', 'pf:v:1:1']]);
  ok('2a. löschen: nur die festen Präfixe', a.json.ok && a.json.geloescht === 5 && left[0] == null && left[1] == null && left[2] == null && left[3] != null && left[4] != null, JSON.stringify({ a: a.json, left: left }));
  a = await call('POST', { action: 'irgendwas' });
  ok('2b. unbekannte Aktion → 400', a.status === 400);

  // 3. Nur Admin
  SESSION = { role: 'trainer', user: 'Tina' };
  a = await call('POST', { action: 'altdaten', step: 'delete' });
  ok('3. Trainer: 403', a.status === 403);

  console.log(pass ? 'TEAM USAGE PASS' : 'TEAM USAGE FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
