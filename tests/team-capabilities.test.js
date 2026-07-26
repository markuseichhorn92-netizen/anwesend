'use strict';
// Team-Berechtigungen: Rollen-Matrix (lib/capabilities.js), 403 fuer verbotene
// Zugriffe, und Abdeckungs-Tripwire (jeder Team-Endpoint traegt eine Capability).
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// teamAuth mocken: Session/Rolle steuerbar
let SESSION = null;
inject('lib/teamAuth.js', {
  requireTeam: async () => SESSION,
  roleOf: (s) => (s ? (s.role || 'admin') : null),
  isAdmin: (s) => !!s && (s.role || 'admin') === 'admin',
  bearer: () => 't',
  destroySession: async () => {},
});

const Cap = require(path.join(ROOT, 'lib/capabilities.js'));

function res0() { return { statusCode: 0, setHeader() {}, body: null, end(s) { this.body = s; } }; }

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1) Matrix: Admin darf alles, Trainer nur Tagesgeschaeft
  const admin = { role: 'admin' }, trainer = { role: 'trainer' };
  ok('1. Admin hat admin.manage', Cap.can(admin, 'admin.manage'));
  ok('1b. Trainer hat member.read', Cap.can(trainer, 'member.read'));
  ok('1c. Trainer hat training.manage', Cap.can(trainer, 'training.manage'));
  ok('1d. Trainer hat KEIN admin.manage', !Cap.can(trainer, 'admin.manage'));
  ok('1e. Alt-Session ohne role gilt als Admin (Passwort-Login)', Cap.can({}, 'admin.manage'));
  ok('1f. unbekannte Rolle hat nichts', !Cap.can({ role: 'gast' }, 'member.read'));
  ok('1g. ohne Session nichts', !Cap.can(null, 'member.read'));

  // 2) requireCapability: 401 ohne Session, 403 bei fehlender Faehigkeit
  SESSION = null;
  let r = res0();
  ok('2. ohne Session -> 401', (await Cap.requireCapability({ headers: {} }, r, 'member.read')) === null && r.statusCode === 401);
  SESSION = trainer; r = res0();
  ok('2b. Trainer + admin.manage -> 403', (await Cap.requireCapability({ headers: {} }, r, 'admin.manage')) === null && r.statusCode === 403);
  SESSION = trainer; r = res0();
  ok('2c. Trainer + training.manage -> Session', (await Cap.requireCapability({ headers: {} }, r, 'training.manage')) === trainer);

  // 3) Verbotene Zugriffe an echten Endpunkten: Trainer -> 403 (vor jeder Logik)
  const cases = [
    ['api/team/stats.js', 'Statistiken'],
    ['api/team/broadcast.js', 'Broadcast'],
    ['api/team/message.js', 'Direktnachricht'],
    ['api/team/winback.js', 'Rueckholung'],
    ['api/team/leads.js', 'Leads'],
    ['api/team/social-mod.js', 'Community-Moderation'],
    ['api/team/impersonate.js', 'Impersonation'],
    ['api/team/dues.js', 'Mahnliste'],
  ];
  SESSION = { role: 'trainer', user: 'anna' };
  for (const [rel, label] of cases) {
    const H = require(path.join(ROOT, rel));
    const rr = res0();
    const req = { method: 'POST', url: '/x', headers: {} };
    req.on = (ev, cb) => { if (ev === 'end') cb(); };
    try { await H(req, rr); } catch (e) { /* darf nicht passieren, 403 kommt vorher */ }
    ok('3. Trainer -> 403 fuer ' + label, rr.statusCode === 403);
  }

  // 4) Abdeckungs-Tripwire: JEDER Team-Endpoint (ausser Session-/Geraete-Endpunkten)
  //    referenziert die Capability-Schicht.
  //    client-error.js meldet nur, dass die eigene Oberflaeche kaputt ist: keine
  //    Mitgliedsdaten, kein Lesen, kein Schreiben ausser einer Logzeile. Ein
  //    Rechte-Gate wuerde dort ausgerechnet die Fehler verschlucken, die es zu
  //    sehen gilt; begrenzt wird stattdessen per Rate-Limit.
  const exempt = new Set(['login.js', 'logout.js', 'me.js', 'push.js', 'client-error.js']);
  const missing = fs.readdirSync(path.join(ROOT, 'api/team'))
    .filter((f) => f.endsWith('.js') && !exempt.has(f))
    .filter((f) => !fs.readFileSync(path.join(ROOT, 'api/team', f), 'utf8').includes('lib/capabilities'));
  ok('4. alle Team-Endpoints tragen eine Capability (fehlend: ' + (missing.join(',') || 'keine') + ')', missing.length === 0);

  console.log(pass ? 'TEAM-CAPABILITIES PASS' : 'TEAM-CAPABILITIES FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
