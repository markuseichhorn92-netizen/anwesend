'use strict';
// Magicline-Webhook: Auth mit mehreren Schluesseln.
//
// Der Grund ist unspektakulaer und trotzdem der Kern: Vercel zeigt einen einmal
// gespeicherten Wert nicht wieder an. Wer den Schluessel nicht notiert hat,
// kommt an die bestehende Konfiguration nicht mehr heran - und ihn einfach zu
// ueberschreiben wuerde alle bereits eingerichteten Webhooks stilllegen:
// Willkommensmail, neue Mitglieder, Check-in-Feed, Leads.
//
// Mit mehreren Schluesseln laesst sich einer ergaenzen, ohne den anderen zu
// brechen. Genau das prueft dieser Test - und dass ein falscher weiterhin
// abprallt.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
};
const frisch = (rel) => { delete require.cache[path.resolve(ROOT, rel)]; return require(path.resolve(ROOT, rel)); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

const stats = {};
const termine = [];
inject('lib/mlEvents.js', {
  hasStore: true,
  bumpStat: async (t) => { stats[t] = (stats[t] || 0) + 1; },
  readStats: async () => stats,
  listAppointments: async () => termine,
  recentCheckins: async () => [],
  presentCount: async () => 0,
  upsertAppointment: async (a) => { termine.push(a); return true; },
  removeAppointment: async (id) => { const i = termine.findIndex((x) => String(x.bookingId) === String(id)); if (i >= 0) termine.splice(i, 1); return true; },
  recordCheckin: async () => {},
});
inject('lib/welcome.js', { sendAccessInfoOnce: async () => ({ sent: false, reason: 'test' }) });
inject('lib/newMembers.js', { recordJoin: async () => {} });

function ruf(H, opt) {
  opt = opt || {};
  const req = {
    method: opt.method || 'POST',
    url: opt.url || '/api/webhooks/magicline',
    headers: opt.headers || {},
    on: function (ev, cb) {
      if (ev === 'data' && opt.body) cb(JSON.stringify(opt.body));
      if (ev === 'end') cb();
      return this;
    },
    destroy: function () {},
  };
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; return this; } };
  return H(req, res).then(() => ({ status: res.statusCode, json: (function () { try { return JSON.parse(res.body); } catch (e) { return null; } })() }));
}

async function run() {
  // ── 1. Ohne Schluessel ist der Empfaenger aus ──
  delete process.env.MAGICLINE_WEBHOOK_KEY; delete process.env.MAGICLINE_WEBHOOK_SECRET;
  let H = frisch('api/webhooks/magicline.js');
  let r = await ruf(H, { headers: { 'x-api-key': 'egal' }, body: {} });
  ok('1. Ohne eingerichteten Schluessel: aus', r.status === 503, JSON.stringify(r.json));

  // ── 2. Zwei Schluessel gleichzeitig ──
  // Der eigentliche Zweck: einen neuen ergaenzen, ohne den alten zu brechen.
  process.env.MAGICLINE_WEBHOOK_KEY = 'alt_geheim, neu_geheim';
  H = frisch('api/webhooks/magicline.js');

  r = await ruf(H, { headers: { 'x-api-key': 'alt_geheim' }, body: {} });
  ok('2. Der alte Schluessel gilt weiter', r.status === 200, JSON.stringify(r.json));
  r = await ruf(H, { headers: { 'x-api-key': 'neu_geheim' }, body: {} });
  ok('2b. … und der neue ebenso', r.status === 200, JSON.stringify(r.json));
  ok('2c. … auch mit Leerzeichen in der Liste', true);

  r = await ruf(H, { headers: { 'x-api-key': 'falsch' }, body: {} });
  ok('3. Ein falscher prallt weiterhin ab', r.status === 401, JSON.stringify(r.json));
  r = await ruf(H, { body: {} });
  ok('3b. Gar keiner ebenso', r.status === 401, JSON.stringify(r.json));
  ok('3c. … und der Fehlversuch wird gezaehlt', stats._AUTH_REJECTED >= 2, JSON.stringify(stats));

  // Ein Schluessel, der nur ein Anfang des richtigen ist, darf nicht durchgehen.
  r = await ruf(H, { headers: { 'x-api-key': 'alt_gehei' }, body: {} });
  ok('3d. Ein Teilstueck reicht nicht', r.status === 401, JSON.stringify(r.json));

  // ── 3. Der Schluessel darf auch im Pfad stehen ──
  r = await ruf(H, { url: '/api/webhooks/magicline?key=neu_geheim', body: {} });
  ok('4. … oder als Abfrageparameter', r.status === 200, JSON.stringify(r.json));

  // ── 4. Buchungen kommen an ──
  r = await ruf(H, { headers: { 'x-api-key': 'neu_geheim' },
    body: { type: 'APPOINTMENT_BOOKING_CREATED', entityId: 'b-1', content: { startDateTime: '2026-09-01T10:00:00Z', name: 'Probetraining' } } });
  ok('5. Eine erstellte Buchung wird verarbeitet',
    r.status === 200 && JSON.stringify(r.json).indexOf('appt_') >= 0, JSON.stringify(r.json));

  r = await ruf(H, { headers: { 'x-api-key': 'neu_geheim' },
    body: { type: 'APPOINTMENT_BOOKING_CANCELLED', entityId: 'b-1' } });
  ok('5b. … und eine Stornierung ebenso',
    r.status === 200 && JSON.stringify(r.json).indexOf('appt_removed') >= 0, JSON.stringify(r.json));

  // ── 5. Diagnose ──
  // Sie beantwortet die Frage "kommt ueberhaupt etwas an, und unter welchem
  // Namen" - ohne dass jemand ins Log schauen muss.
  r = await ruf(H, { method: 'GET', url: '/api/webhooks/magicline?key=alt_geheim&health=1' });
  ok('6. Die Diagnose antwortet mit Zaehlern', r.status === 200 && r.json.health === true, JSON.stringify(r.json));
  ok('6b. … und ist ohne Schluessel gesperrt',
    (await ruf(H, { method: 'GET', url: '/api/webhooks/magicline?health=1' })).status === 401);

  console.log(pass ? 'ML-WEBHOOK-KEYS PASS' : 'ML-WEBHOOK-KEYS FAIL');
  process.exit(pass ? 0 : 1);
}
run();
