'use strict';
// Widerruf/Kündigung (api/member/cancel.js): Erfolg nur bei echtem ok, kein _debug
// in Produktivantworten, Doppel-Submit-Schutz. Läuft ohne Netz (Deps gemockt).
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ── In-Memory-Redis für lib/store ──
const kv = new Map();
async function redisPipeline(cmds) {
  return cmds.map((c) => {
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') return kv.has(c[1]) ? kv.get(c[1]) : null;
    if (op === 'SET') { kv.set(c[1], String(c[2])); return 'OK'; }
    if (op === 'DEL') { kv.delete(c[1]); return 1; }
    if (op === 'INCR') { const n = (parseInt(kv.get(c[1]), 10) || 0) + 1; kv.set(c[1], String(n)); return n; }
    if (op === 'EXPIRE') return 1;
    return null;
  });
}
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
inject('lib/store.js', { hasStore: true, redisPipeline, TZ: 'Europe/Berlin' });

// ── Steuerbare Mocks ──
let OPEN_OK = true;      // Magicline Open-API-Widerruf
let MAIL_OK = true;      // Studio-Mail
let SESSION = { id: 'M1' };
let BODY = {};

inject('lib/mlCancel.js', {
  cancelReasons: async () => ({ ok: true, reasons: [] }),
  ordinaryCancel: async () => ({ ok: OPEN_OK, status: OPEN_OK ? 200 : 500 }),
  contractWithdrawal: async () => ({ ok: OPEN_OK, status: OPEN_OK ? 200 : 500, forbidden: false, error: OPEN_OK ? '' : 'ml_down' }),
});
inject('lib/connect.js', { submitCancellation: async () => ({ ok: false, status: 0 }), submitWithdrawal: async () => ({ ok: false, status: 0 }) });
inject('lib/inbox.js', { addVorgang: async () => ({ id: 'v1' }) });
inject('lib/mail.js', { hasMail: true, sendMail: async () => ({ ok: MAIL_OK }), sendMailRaw: async () => ({ ok: true }) });
inject('lib/emailTemplate.js', { renderEmail: () => ({ text: '', html: '' }), BASE: 'https://x' });
inject('lib/magic.js', { memberLink: async () => 'https://x/portal' });
inject('lib/studioReply.js', { notifyStudio: async () => ({ ok: MAIL_OK }) });
inject('lib/handled.js', { record: () => {} });

// lib/members echt laden geht nicht (fetch/Env) -> minimal mocken.
inject('lib/members.js', {
  hasStore: true,
  getSession: async () => SESSION,
  bearer: () => 't',
  readBody: async () => BODY,
  getMember: async () => ({ id: 'M1', firstName: 'Max', lastName: 'Muster', email: 'max@example.org', customerNumber: 'M-1' }),
  getContract: async () => ({ contractId: 77, rateName: 'Flex', contractOrigin: 'WEBSITE', withdrawalEligible: true, nextCancellationDateISO: '2027-01-31', nextCancellationDate: '31.01.2027' }),
  rateLimit: async (key, max) => {
    const n = (parseInt(kv.get('rl:' + key), 10) || 0) + 1; kv.set('rl:' + key, String(n));
    return n <= max;
  },
});

const H = require(path.join(ROOT, 'api/member/cancel.js'));
function res0() { return { statusCode: 0, setHeader() {}, body: null, end(s) { this.body = s; } }; }
async function POST(b) { BODY = b; const r = res0(); await H({ method: 'POST', url: '/api/member/cancel', headers: {} }, r); return { code: r.statusCode, j: JSON.parse(r.body) }; }

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1) Widerruf erfolgreich (Open API) -> ok:true, KEIN _debug
  let r = await POST({ action: 'revoke' });
  ok('1. Widerruf ok:true bei Server-Erfolg', r.j.ok === true);
  ok('1b. keine _debug-Daten in der Antwort', !('_debug' in r.j));

  // 2) Doppel-Submit: 3 erlaubt, der 4. wird abgewiesen (429)
  await POST({ action: 'revoke' }); await POST({ action: 'revoke' });
  r = await POST({ action: 'revoke' });
  ok('2. 4. Versuch in 5 Min -> 429 + ok:false', r.code === 429 && r.j.ok === false);

  // 3) Anderes Mitglied ist nicht betroffen (Limit pro Mitglied)
  SESSION = { id: 'M2' };
  r = await POST({ action: 'revoke' });
  ok('3. anderes Mitglied nicht geblockt', r.j.ok === true);

  // 4) Open API scheitert + Studio-Mail scheitert -> ok:false (KEIN falscher Erfolg)
  SESSION = { id: 'M3' }; OPEN_OK = false; MAIL_OK = false;
  r = await POST({ action: 'revoke' });
  ok('4. alles fehlgeschlagen -> ok:false', r.j.ok === false);
  ok('4b. auch hier kein _debug', !('_debug' in r.j));

  // 5) Open API scheitert, Studio-Mail geht durch -> ok:true (Erklärung zugegangen)
  SESSION = { id: 'M4' }; MAIL_OK = true;
  r = await POST({ action: 'revoke' });
  ok('5. Mail-Fallback -> ok:true', r.j.ok === true && r.j.direct === false);

  // 6) Kündigung (cancel): Antwort ebenfalls ohne _debug
  SESSION = { id: 'M5' }; OPEN_OK = true;
  r = await POST({ action: 'cancel', date: '2027-01-31', cancelationReasonId: 3 });
  ok('6. Kündigung ok + ohne _debug', r.j.ok === true && !('_debug' in r.j));

  console.log(pass ? 'REVOKE PASS' : 'REVOKE FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
