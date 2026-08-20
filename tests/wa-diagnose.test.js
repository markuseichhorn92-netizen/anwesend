'use strict';
// Selbstauskunft: warum kommt kein Anmelde-Code per WhatsApp an?
//
// Der Grund stand bisher nur in den Vercel-Logs. Wer die nicht liest, sieht beim
// Mitglied nur "kein Code" und raet - das hat hier mehrere Runden gekostet.
// Diese Auskunft nennt ihn im Klartext, im Team-Backend.
//
// Zwei Zusagen muessen dabei halten:
//   - der Probe-Code ist KEIN gueltiger Anmelde-Code (sonst waere das ein
//     Generalschluessel fuer jedes Konto, dessen Nummer man kennt),
//   - und der Probeversand ist ein Leitungsakt, serverseitig gesperrt.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
};

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── Umgebung ──
let rolle = 'admin', session = { user: 'Team' };
inject('lib/teamAuth.js', {
  requireTeam: async () => session,
  roleOf: () => rolle,
});

let otpGespeichert = 0;
const limits = {};
inject('lib/members.js', {
  hasStore: true,
  readBody: async (req) => req.__body || {},
  rateLimit: async (key, max) => { limits[key] = (limits[key] || 0) + 1; return limits[key] <= max; },
  otpSave: async () => { otpGespeichert++; },
});

let waAntwort = null, waEinrichtung = null;
const gesendet = [];
inject('lib/whatsapp.js', {
  toWaNumber: (n) => String(n || '').replace(/[^\d]/g, '').replace(/^00/, '').replace(/^0/, '49'),
  loginVorlageInfo: () => waEinrichtung,
  sendLoginTemplate: async (to, code) => { gesendet.push({ to: to, code: code }); return waAntwort; },
  fehlerInfo: (r) => {
    let j = null; try { j = r && r.body ? JSON.parse(r.body) : null; } catch (e) { j = null; }
    const e = j && j.error;
    return e ? { code: e.code, text: String(e.message || '') } : { text: 'unbekannt' };
  },
});

let letzte = [];
inject('lib/loginCode.js', { letzteMessungen: async () => letzte });

const H = require(path.resolve(ROOT, 'api/team/wa-diagnose.js'));

function anfrage(method, body) {
  const req = { method: method, headers: {}, url: '/api/team/wa-diagnose', __body: body || {} };
  const res = { statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = s || ''; return this; } };
  return H(req, res).then(() => ({ status: res.statusCode, json: (function () { try { return JSON.parse(res.body); } catch (e) { return null; } })(), headers: res.headers }));
}

async function run() {
  waEinrichtung = { meta: true, twilio: false, bereit: true, anbieter: 'meta', name: 'anmelde_code', sprache: 'de', form: null, festgenagelt: null };

  // ── 1. Ohne Anmeldung gibt es gar nichts ──
  session = null;
  let r = await anfrage('GET');
  ok('1. Ohne Team-Sitzung: abgewiesen', r.status === 401, JSON.stringify(r.json));

  // ── 2. Eine Angestellte darf keinen Probeversand ausloesen ──
  session = { user: 'Kathrin' }; rolle = 'trainer';
  r = await anfrage('POST', { phone: '0151 12345678' });
  ok('2. Ohne Leitungsrolle: gesperrt – und zwar hier, nicht in der Oberflaeche',
    r.status === 403 && gesendet.length === 0, JSON.stringify(r.json));

  // ── 3. Die Leitung sieht, wie der Versand eingerichtet ist ──
  rolle = 'admin';
  letzte = [
    { t: Date.now(), via: 'whatsapp', ms: 380, ok: false, code: 132000, grund: 'Number of parameters does not match' },
    { t: Date.now() - 60000, via: 'email', ms: 210, ok: true },
  ];
  r = await anfrage('GET');
  ok('3. Die Einrichtung steht da', r.status === 200 && r.json.ok === true && r.json.einrichtung.anbieter === 'meta', JSON.stringify(r.json));
  ok('3b. … und die letzten Versuche mit Grund', (r.json.letzte || []).length === 2 && r.json.letzte[0].code === 132000, JSON.stringify(r.json.letzte));
  ok('3c. … und nichts davon wird zwischengespeichert',
    /no-store/.test(String(r.headers['Cache-Control'] || '')), String(r.headers['Cache-Control']));

  // ── 4. Ohne Nummer wird nichts verschickt ──
  gesendet.length = 0;
  r = await anfrage('POST', { phone: '' });
  ok('4. Ohne Nummer passiert nichts', r.json.ok === false && gesendet.length === 0, JSON.stringify(r.json));

  // ── 5. Der Fehler des Anbieters kommt im Klartext zurueck ──
  // Das ist der eigentliche Zweck: nicht "hat nicht geklappt", sondern warum.
  waAntwort = { ok: false, status: 400, body: JSON.stringify({ error: { message: '(#132000) Number of parameters does not match', code: 132000 } }) };
  r = await anfrage('POST', { phone: '0151 12345678' });
  ok('5. Ein abgelehnter Versand nennt den Fehlercode',
    r.json.ok === true && r.json.zugestellt === false && r.json.fehler && r.json.fehler.code === 132000, JSON.stringify(r.json));
  ok('5b. … und den Klartext dazu', /parameters/.test(String(r.json.fehler.text || '')), JSON.stringify(r.json.fehler));

  // ── 6. Der Probe-Code ist KEIN gueltiger Anmelde-Code ──
  // Sonst koennte die Leitung sich mit jeder bekannten Nummer irgendwo anmelden.
  ok('6. Der Probe-Code wird nirgends als Anmeldung hinterlegt', otpGespeichert === 0, String(otpGespeichert));
  // Die Nummer geht so weiter, wie sie eingetippt wurde – in E.164 bringt sie
  // derselbe Weg wie beim echten Login (toWaNumber im Versand), nicht dieser hier.
  ok('6b. … er ist sechsstellig und geht an die genannte Nummer',
    gesendet.length === 1 && /^\d{6}$/.test(gesendet[0].code) && gesendet[0].to === '0151 12345678',
    JSON.stringify(gesendet[0] && { to: gesendet[0].to, len: String(gesendet[0].code).length }));

  // ── 7. Gelingt der Versand, wird das nicht als Zustellung ausgegeben ──
  waAntwort = { ok: true, status: 200, body: '{"messages":[{"id":"wamid.X"}]}', id: 'wamid.X' };
  r = await anfrage('POST', { phone: '0151 12345678' });
  ok('7. Angenommen heisst angenommen, nicht angekommen',
    r.json.zugestellt === true && /Zustellung/.test(String(r.json.message || '')), JSON.stringify(r.json.message));

  // ── 8. Nicht als Nachrichten-Schleuder missbrauchbar ──
  let letzterStatus = null;
  for (let i = 0; i < 6; i++) letzterStatus = (await anfrage('POST', { phone: '0151 12345678' })).json;
  ok('8. Nach fuenf Proben je Nummer ist Schluss',
    letzterStatus && letzterStatus.ok === false && /spaeter|später/i.test(String(letzterStatus.message || '')), JSON.stringify(letzterStatus));

  // ── 9. Ist gar nichts eingerichtet, wird das gesagt statt gesendet ──
  waEinrichtung = { meta: false, twilio: false, bereit: false, anbieter: null, name: null, sprache: 'de', form: null, festgenagelt: null };
  gesendet.length = 0;
  r = await anfrage('POST', { phone: '0160 99999999' });
  ok('9. Ohne eingerichtete Vorlage: klare Ansage, kein Versuch',
    r.json.zugestellt === false && gesendet.length === 0 && /Vorlage/.test(String(r.json.message || '')), JSON.stringify(r.json.message));

  console.log(pass ? 'WA-DIAGNOSE PASS' : 'WA-DIAGNOSE FAIL');
  process.exit(pass ? 0 : 1);
}
run();
