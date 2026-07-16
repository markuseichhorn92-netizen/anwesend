'use strict';
// Serverseitiger Logout (Member + Team): Sitzung wird in Redis widerrufen,
// Aufruf ist idempotent, optionales Push-Token wird abgemeldet, Tokens landen
// in keiner Log-Ausgabe.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const kv = new Map();
async function redisPipeline(cmds) {
  return cmds.map((c) => {
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') return kv.has(c[1]) ? kv.get(c[1]) : null;
    if (op === 'SET') { kv.set(c[1], String(c[2])); return 'OK'; }
    if (op === 'DEL') { const had = kv.delete(c[1]); return had ? 1 : 0; }
    if (op === 'SREM' || op === 'SADD' || op === 'EXPIRE') return 1;
    if (op === 'SMEMBERS') return [];
    return null;
  });
}
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
inject('lib/store.js', { hasStore: true, redisPipeline, TZ: 'Europe/Berlin' });

const unregistered = [];      // [memberId, token]
const teamUnregistered = [];
inject('lib/push.js', {
  hasPush: true,
  unregisterToken: async (id, tok) => { unregistered.push([String(id), String(tok)]); },
  unregisterTeamToken: async (tok) => { teamUnregistered.push(String(tok)); },
});

// Logs abfangen: Sitzungstokens dürfen NIRGENDS geloggt werden.
const logged = [];
['log', 'error', 'warn'].forEach((k) => { const orig = console[k]; console[k] = (...a) => { logged.push(a.map(String).join(' ')); }; });

const M = require(path.join(ROOT, 'lib/members.js'));
const TA = require(path.join(ROOT, 'lib/teamAuth.js'));
const H = require(path.join(ROOT, 'api/member/logout.js'));
const HT = require(path.join(ROOT, 'api/team/logout.js'));

function res0() { return { statusCode: 0, setHeader() {}, body: null, end(s) { this.body = s; } }; }
async function call(handler, token, body) {
  const r = res0();
  const req = { method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {} };
  req.on = (ev, cb) => { if (ev === 'data' && body) cb(JSON.stringify(body)); if (ev === 'end') cb(); };
  await handler(req, r);
  return { code: r.statusCode, j: JSON.parse(r.body) };
}

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.info((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1) Member: Sitzung anlegen -> Logout -> Sitzung ist WIRKLICH weg
  const tok = await M.createSession('M1', 3600);
  ok('1. Sitzung existiert vor Logout', !!(await M.getSession(tok)));
  let r = await call(H, tok, { pushToken: 'dev-abc' });
  ok('1b. Logout ok:true', r.code === 200 && r.j.ok === true);
  ok('1c. Sitzung serverseitig widerrufen', (await M.getSession(tok)) === null);
  ok('1d. Push-Token dieses Geräts abgemeldet', unregistered.length === 1 && unregistered[0][0] === 'M1' && unregistered[0][1] === 'dev-abc');

  // 2) Idempotent: gleicher Logout nochmal + mit Fantasie-Token -> weiterhin ok
  r = await call(H, tok, {});
  ok('2. wiederholter Logout ok', r.code === 200 && r.j.ok === true);
  r = await call(H, 'gibtsnicht', {});
  ok('2b. unbekannter Token ok (idempotent)', r.code === 200 && r.j.ok === true);
  r = await call(H, null, {});
  ok('2c. ganz ohne Token ok', r.code === 200 && r.j.ok === true);

  // 3) Andere Sitzung desselben Mitglieds bleibt gültig (nur DIESE Sitzung endet)
  const t1 = await M.createSession('M2', 3600); const t2 = await M.createSession('M2', 3600);
  await call(H, t1, {});
  ok('3. zweite Sitzung überlebt', (await M.getSession(t2)) !== null && (await M.getSession(t1)) === null);

  // 4) Team-Logout widerruft Team-Sitzung + meldet Team-Push-Token ab
  const tt = await TA.createSession({ user: 'anna', role: 'trainer' }, 3600);
  ok('4. Team-Sitzung existiert', !!(await TA.getSession(tt)));
  r = await call(HT, tt, { pushToken: 'team-dev-1' });
  ok('4b. Team-Logout ok + Sitzung weg', r.j.ok === true && (await TA.getSession(tt)) === null);
  ok('4c. Team-Push-Token abgemeldet', teamUnregistered.length === 1 && teamUnregistered[0] === 'team-dev-1');

  // 5) Kein Sitzungstoken in irgendeiner Log-Ausgabe
  const leak = logged.some((l) => l.includes(tok) || l.includes(t1) || l.includes(t2) || l.includes(tt));
  ok('5. keine Tokens in Logs', !leak);

  console.info(pass ? 'LOGOUT PASS' : 'LOGOUT FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.info('FAIL ' + (e && e.stack || e)); process.exit(1); });
