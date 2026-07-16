'use strict';
// Check-in (api/member/checkin.js): Sitzung + aktiver Vertrag serverseitig
// verpflichtend, Wiederholungs-/Missbrauchsschutz, kein Check-in bei
// nicht ladbarem Vertrag. Zusätzlich: kein ?nfc-Auto-Check-in im Client.
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let SESSION = { id: 'M1' };
let CONTRACT = { active: true };
let ML_OK = true;
let checkinCalls = 0;
const rl = new Map();

inject('lib/members.js', {
  getSession: async () => SESSION,
  bearer: () => 't',
  rateLimit: async (key, max) => { const n = (rl.get(key) || 0) + 1; rl.set(key, n); return n <= max; },
  getContract: async () => { if (CONTRACT === 'throw') throw new Error('ml down'); return CONTRACT; },
  checkinCustomer: async () => { checkinCalls++; return { status: ML_OK ? 204 : 500 }; },
});

const H = require(path.join(ROOT, 'api/member/checkin.js'));
function res0() { return { statusCode: 0, setHeader() {}, body: null, end(s) { this.body = s; } }; }
async function POST() { const r = res0(); await H({ method: 'POST', headers: {} }, r); return { code: r.statusCode, j: JSON.parse(r.body) }; }

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1) Ohne Sitzung -> 401, kein Magicline-Aufruf
  SESSION = null;
  let r = await POST();
  ok('1. ohne Sitzung -> 401', r.code === 401 && checkinCalls === 0);

  // 2) Aktiver Vertrag -> Check-in geht durch
  SESSION = { id: 'M1' }; CONTRACT = { active: true };
  r = await POST();
  ok('2. aktiver Vertrag -> ok:true', r.j.ok === true && checkinCalls === 1);

  // 3) Inaktiver Vertrag -> abgelehnt, kein Magicline-Check-in
  SESSION = { id: 'M2' }; CONTRACT = { active: false };
  r = await POST();
  ok('3. inaktiver Vertrag -> abgelehnt', r.j.ok === false && checkinCalls === 1);

  // 4) Vertrag nicht ladbar (Magicline down) -> KEIN Check-in (fail-closed)
  SESSION = { id: 'M3' }; CONTRACT = null;
  r = await POST();
  ok('4. Vertrag nicht ladbar -> abgelehnt', r.j.ok === false && checkinCalls === 1);
  SESSION = { id: 'M4' }; CONTRACT = 'throw';
  r = await POST();
  ok('4b. getContract wirft -> abgelehnt', r.j.ok === false && checkinCalls === 1);

  // 5) Wiederholungsschutz: 3 je 30 Min, der 4. wird geblockt
  SESSION = { id: 'M5' }; CONTRACT = { active: true };
  await POST(); await POST(); await POST();
  r = await POST();
  ok('5. 4. Versuch in 30 Min geblockt', r.j.ok === false && /eingecheckt/i.test(r.j.message));

  // 6) Kein Check-in-Bypass über URL-Parameter im Client:
  //    ?nfc=1 darf doCheckin NICHT mehr automatisch ausloesen.
  const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
  const nfcBlock = html.slice(html.indexOf('function nfcArrive'), html.indexOf('function nfcArrive') + 900);
  ok('6. nfcArrive() ruft doCheckin nicht mehr auf', nfcBlock.length > 100 && !/doCheckin/.test(nfcBlock));

  console.log(pass ? 'CHECKIN PASS' : 'CHECKIN FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
