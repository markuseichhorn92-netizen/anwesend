'use strict';
// Ops-Überblick: anonyme Tageszähler (lib/opsStat) + Aggregator-Endpunkt (api/ops.js).
// Nur Zahlen/Aggregate, keine Freitexte/IDs. In-Memory-KV (Strings/Sets).
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

process.env.OPS_KEY = 'opssecret';

const KV = new Map(), SETS = new Map();
inject('lib/store.js', {
  hasStore: true,
  getTypicalWeek: async () => [[0, 3, 6], [0, 0, 0]],
  redisPipeline: async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1]);
    if (op === 'GET') return KV.has(k) ? KV.get(k) : null;
    if (op === 'SET') { KV.set(k, String(c[2])); return 'OK'; }
    if (op === 'INCRBY') { const n = (parseInt(KV.get(k), 10) || 0) + (parseInt(c[2], 10) || 0); KV.set(k, String(n)); return n; }
    if (op === 'SADD') { if (!SETS.has(k)) SETS.set(k, new Set()); SETS.get(k).add(String(c[2])); return 1; }
    if (op === 'SMEMBERS') return SETS.has(k) ? Array.from(SETS.get(k)) : [];
    if (op === 'EXPIRE') return 1;
    return null;
  }),
});

// Aggregator-Abhängigkeiten mocken (deterministisch, ohne echte Stores).
const fbId = String(Date.now()).padStart(14, '0') + '-aa';
inject('lib/feedback.js', { list: async () => ({ items: [{ id: fbId, category: 'bug', status: 'new', meta: { platform: 'ios' } }], total: 1, open: 1 }) });
inject('lib/newMembers.js', { listJoins: async () => [{ id: '1', joinedAt: new Date().toISOString() }] });
inject('lib/leadflow.js', { listLeads: async () => [{ source: 'whatsapp', status: 'neu', createdAt: Date.now() }] });
inject('lib/mlEvents.js', { hasStore: true, readStats: async () => ({ total: 0, types: {} }), recentCheckins: async () => [], presentCount: async () => 0 });

const Ops = require(path.join(ROOT, 'lib/opsStat.js'));
const H = require(path.join(ROOT, 'api/ops.js'));

function res0() { return { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } }; }
async function get(key) {
  const res = res0();
  const req = { method: 'GET', url: '/api/ops' + (key ? ('?key=' + key) : ''), headers: {} };
  await H(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body || '{}') };
}

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── opsStat: Zähler erhöhen + lesen ──
  await Ops.bump('wa_inbound');
  await Ops.bump('wa_inbound');
  await Ops.bump('wa_escalate');
  const stats = await Ops.read();
  ok('1. Zähler summiert (wa_inbound d7=2)', stats.wa_inbound && stats.wa_inbound.d7 === 2 && stats.wa_inbound.d30 === 2, JSON.stringify(stats));
  ok('2. Zweiter Zähler getrennt (wa_escalate=1)', stats.wa_escalate && stats.wa_escalate.d1 === 1, JSON.stringify(stats));

  // ── Endpunkt-Auth ──
  ok('3. ohne Key -> 401', (await get('')).status === 401);
  ok('4. falscher Key -> 401', (await get('falsch')).status === 401);

  // ── Endpunkt liefert Aggregate ──
  const r = await get('opssecret');
  ok('5. korrekter Key -> 200', r.status === 200 && r.json.ok === true);
  ok('6. Feedback-Aggregat (Kategorie bug, Plattform ios)', r.json.feedback && r.json.feedback.byCategory.bug === 1 && r.json.feedback.byPlatform.ios === 1, JSON.stringify(r.json.feedback));
  ok('7. Zähler im Endpunkt (wa_inbound d7=2)', r.json.counters && r.json.counters.wa_inbound && r.json.counters.wa_inbound.d7 === 2, JSON.stringify(r.json.counters));
  ok('8. neue Mitglieder gezählt', r.json.newMembers && r.json.newMembers.last7 === 1, JSON.stringify(r.json.newMembers));
  ok('9. Leads nach Quelle', r.json.leads && r.json.leads.bySource.whatsapp === 1, JSON.stringify(r.json.leads));
  ok('10. Auslastung: Slots mit Daten', r.json.attendance && r.json.attendance.slotsWithData === 2, JSON.stringify(r.json.attendance));

  console.log(pass ? 'OPS PASS' : 'OPS FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
