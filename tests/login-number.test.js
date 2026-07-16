'use strict';
// Login per Mitgliedsnummer (api/member/login-number.js): Rate-Limits (IP + Nummer)
// greifen wirklich, strikte Validierung, generische Fehler, Sitzungs-TTL gedeckelt.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const rl = new Map();         // Rate-Limit-Zähler
let FOUND = null;             // findByNumberDob-Ergebnis
let LAST_TTL = null;          // an createSession übergebene TTL
let CODE_SENT = 0;

inject('lib/members.js', {
  hasStore: true,
  isoDate: (s) => { s = String(s || '').trim(); const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m ? (m[3] + '-' + m[2] + '-' + m[1]) : s.slice(0, 10); },
  rateLimit: async (key, max) => { const n = (rl.get(key) || 0) + 1; rl.set(key, n); return n <= max; },
  readBody: async () => BODY,
  findByNumberDob: async () => FOUND,
  createSession: async (id, ttl) => { LAST_TTL = ttl; return 'tok-' + id; },
});
inject('lib/loginCode.js', { sendLoginCode: async () => { CODE_SENT++; return { challenge: 'ch1' }; } });

let BODY = {};
const H = require(path.join(ROOT, 'api/member/login-number.js'));
function res0() { return { statusCode: 0, setHeader() {}, body: null, end(s) { this.body = s; } }; }
async function POST(b, ip) {
  BODY = b; const r = res0();
  await H({ method: 'POST', headers: { 'x-forwarded-for': ip || '1.2.3.4' } }, r);
  return { code: r.statusCode, j: JSON.parse(r.body) };
}

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1) Validierung: Müll wird abgewiesen, bevor irgendwas passiert
  let r = await POST({ customerNumber: 'DROP TABLE', dob: '01.01.1990' });
  ok('1. ungültige Nummer -> 400', r.code === 400);
  r = await POST({ customerNumber: 'M-123', dob: '31.02.1990' });
  ok('1b. unmögliches Datum -> 400', r.code === 400);
  r = await POST({ customerNumber: 'M-123', dob: '01.01.2024' });
  ok('1c. unplausibles Alter -> 400', r.code === 400);

  // 2) Unbekannte Kombination -> generische 401 (keine Konto-Enumeration)
  FOUND = null;
  r = await POST({ customerNumber: 'M-123', dob: '01.01.1990' });
  ok('2. unbekannt -> 401 generisch', r.code === 401 && !/existiert|gefunden/i.test(r.j.message));

  // 3) Rate-Limit pro Nummer greift WIRKLICH (6 Versuche, dann 429) – IPs wechseln
  rl.clear();
  let blocked = null;
  for (let i = 0; i < 7; i++) blocked = await POST({ customerNumber: 'M-777', dob: '01.01.1990' }, '9.9.9.' + i);
  ok('3. 7. Versuch je Nummer -> 429', blocked.code === 429);

  // 4) Rate-Limit pro IP greift (8 Versuche, dann 429) – Nummern wechseln
  rl.clear();
  for (let i = 0; i < 8; i++) await POST({ customerNumber: 'M-10' + i, dob: '01.01.1990' }, '8.8.8.8');
  r = await POST({ customerNumber: 'M-999', dob: '01.01.1990' }, '8.8.8.8');
  ok('4. 9. Versuch je IP -> 429', r.code === 429);

  // 5) Konto MIT E-Mail -> Code-Pflicht statt Direkt-Login
  rl.clear(); FOUND = { id: 'M9', email: 'a@b.c' };
  r = await POST({ customerNumber: 'M-9', dob: '01.01.1990' });
  ok('5. E-Mail-Konto -> needsCode', r.j.ok === true && r.j.needsCode === true && !r.j.token && CODE_SENT === 1);

  // 6) Sitzungsdauer gedeckelt: remember erzeugt max. 24 h, nie 30 Tage
  rl.clear(); FOUND = { id: 'M9' };
  r = await POST({ customerNumber: 'M-9', dob: '01.01.1990' });
  ok('6. Standard-TTL 30 min', LAST_TTL === 1800 && r.j.token);
  rl.clear();
  r = await POST({ customerNumber: 'M-9', dob: '01.01.1990', remember: true });
  ok('6b. remember-TTL = 24 h (nicht 30 Tage)', LAST_TTL === 86400);

  console.log(pass ? 'LOGIN-NUMBER PASS' : 'LOGIN-NUMBER FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
