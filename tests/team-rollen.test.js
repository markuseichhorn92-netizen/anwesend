'use strict';
// Wer darf was im Team-Bereich?
//
// Bald arbeiten Angestellte mit eigenen Konten darin. Ab dann ist jede Luecke
// zwischen „in der Oberflaeche versteckt" und „auf dem Server verboten" eine
// echte: Verstecken ist keine Sperre - die Adresse laesst sich auch direkt
// aufrufen.
//
// Dieser Test prueft deshalb BEIDE Seiten und vor allem ihre Uebereinstimmung.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

const Cap = require(path.join(ROOT, 'lib/capabilities.js'));
const TA = require(path.join(ROOT, 'lib/teamAuth.js'));
const html = fs.readFileSync(path.join(ROOT, 'team-backend.html'), 'utf8');

const admin = { user: 'Admin', role: 'admin' };
const trainer = { user: 'Anna', role: 'trainer', employeeId: 'e1' };

(function () {
  // ── 1. Die Rollen selbst ──
  ok('1. Admin darf alles', Cap.ALL_CAPS.every((c) => Cap.can(admin, c)));
  ok('2. Trainer darf das Tagesgeschaeft',
    Cap.can(trainer, 'member.read') && Cap.can(trainer, 'appointments.manage') && Cap.can(trainer, 'shifts.manage'));
  ok('3. Trainer darf KEINE Admin-Bereiche', !Cap.can(trainer, 'admin.manage'));

  // ── 2. Fail-closed ──
  // Ohne Sitzung, mit unbekannter Rolle oder mit gefaelschtem Wert: nichts.
  ok('4. Ohne Sitzung gar nichts', !Cap.can(null, 'member.read') && !Cap.can(undefined, 'member.read'));
  ok('4b. Unbekannte Rolle darf nichts', !Cap.can({ role: 'praktikant' }, 'member.read'));
  ok('4c. … auch nicht mit erfundener Rolle „superadmin"', !Cap.can({ role: 'superadmin' }, 'admin.manage'));
  ok('4d. Unbekannte Faehigkeit wird nicht gewaehrt', !Cap.can(trainer, 'gibtesnicht'));

  // Der Punkt, der beim Rollenwechsel am ehesten schiefgeht: eine Sitzung OHNE
  // Rollenfeld. Frueher wurde daraus stillschweigend ein Admin.
  ok('5. Sitzung ohne Rollenfeld ist KEIN Admin',
    TA.roleOf({ user: 'X' }) !== 'admin', String(TA.roleOf({ user: 'X' })));
  ok('5b. … sondern die kleinere Berechtigung',
    TA.roleOf({ user: 'X' }) === 'trainer', String(TA.roleOf({ user: 'X' })));
  ok('5c. … und darf damit keine Admin-Bereiche', !Cap.can({ user: 'X' }, 'admin.manage'));
  ok('5d. Ohne Sitzung gibt es gar keine Rolle', TA.roleOf(null) === null);

  // ── 3. Jeder Team-Endpunkt traegt eine Faehigkeit ──
  // Ohne das waere ein neuer Endpunkt automatisch fuer alle offen.
  const dir = path.join(ROOT, 'api/team');
  const dateien = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  // Identitaet und Geraeteanmeldung brauchen keine - sie geben nichts preis,
  // was ueber die eigene Sitzung hinausgeht.
  const ohnePruefungOk = { 'login.js': 1, 'logout.js': 1, 'me.js': 1, 'push.js': 1, 'client-error.js': 1 };
  const ungeschuetzt = dateien.filter(function (f) {
    if (ohnePruefungOk[f]) return false;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    return !/requireCap|requireCapability/.test(src);
  });
  ok('6. Jeder Team-Endpunkt prueft eine Faehigkeit',
    ungeschuetzt.length === 0, 'ohne Pruefung: ' + ungeschuetzt.join(', '));

  // Und jeder benutzt auch wirklich ein Wort aus dem Vokabular - ein Tippfehler
  // („admin.mange") wuerde sonst niemandem auffallen und alles durchlassen…
  const unbekannte = [];
  dateien.forEach(function (f) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    Array.from(src.matchAll(/requireCap(?:ability)?\([^,]+,\s*'([^']+)'/g)).forEach(function (m) {
      if (Cap.ALL_CAPS.indexOf(m[1]) < 0) unbekannte.push(f + ':' + m[1]);
    });
  });
  ok('6b. … und zwar eine, die es gibt', unbekannte.length === 0, unbekannte.join(', '));

  // ── 4. Oberflaeche und Server muessen dasselbe sagen ──
  const mAdminScreens = /ADMIN_ONLY_SCREENS=\{([^}]+)\}/.exec(html);
  ok('7. Die Oberflaeche kennt Admin-Bereiche', !!mAdminScreens);
  const adminScreens = mAdminScreens
    ? Array.from(mAdminScreens[1].matchAll(/([a-z]+)\s*:/g)).map((m) => m[1]) : [];

  // Zu jedem versteckten Bereich muss es mindestens einen Endpunkt geben, der
  // ihn serverseitig sperrt. Sonst ist das Verstecken die einzige „Sicherung".
  const screenZuDatei = {
    stats: ['stats.js'], msg: ['broadcast.js', 'message.js'], leads: ['leads.js'],
    assist: ['assistant.js'], wb: ['winback.js', 'churn.js', 'retention.js'],
    community: ['social-mod.js'], tester: ['testers.js'],
    kassenbuch: ['kassenbuch.js'], feedback: ['feedback.js'],
  };
  const nurVersteckt = [];
  adminScreens.forEach(function (sc) {
    const dateienZu = screenZuDatei[sc];
    if (!dateienZu) { nurVersteckt.push(sc + ' (keine Zuordnung im Test)'); return; }
    const gesperrt = dateienZu.some(function (f) {
      try { return /'admin\.manage'/.test(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch (e) { return false; }
    });
    if (!gesperrt) nurVersteckt.push(sc);
  });
  ok('8. Jeder versteckte Bereich ist auch serverseitig gesperrt',
    nurVersteckt.length === 0, 'nur versteckt: ' + nurVersteckt.join(', '));
  ok('8b. Es sind auch wirklich mehrere Bereiche', adminScreens.length >= 8, String(adminScreens.length));

  // ── 5. Admin-Inhalte auf gemeinsamen Bildschirmen ──
  // Die Uebersicht sieht jeder. Karten mit Finanz- oder Risikodaten duerfen dort
  // nicht auftauchen - und sollten auch nicht geladen werden, wenn sie ohnehin
  // mit 403 zurueckkommen.
  const karten = ['duesCardHTML', 'churnCardHTML'];
  karten.forEach(function (fn) {
    const start = html.indexOf('function ' + fn + '()');
    const kopf = html.slice(start, start + 220);
    ok('9. ' + fn + ' zeigt nichts ohne Admin-Rechte', /if\(!isAdmin\(\)\) return ''/.test(kopf), kopf.slice(0, 140));
  });
  const dashLade = html.slice(html.indexOf("if(k==='dash'){"), html.indexOf("if(k==='dash'){") + 240);
  ok('9b. Admin-Daten werden gar nicht erst angefordert',
    /isAdmin\(\)\)\{\s*loadChurn\(\);\s*loadDues\(\)/.test(dashLade), dashLade.slice(0, 200));

  // Impersonation ist der schwerste Eingriff - beide Seiten muessen sperren.
  ok('10. „Als Mitglied einloggen" nur fuer Admin in der Oberflaeche',
    /\(isAdmin\(\)\?'<button data-loginas/.test(html));
  ok('10b. … und auch auf dem Server',
    /'admin\.manage'/.test(fs.readFileSync(path.join(dir, 'impersonate.js'), 'utf8')));

  console.log(pass ? 'TEAM-ROLLEN PASS' : 'TEAM-ROLLEN FAIL');
  process.exit(pass ? 0 : 1);
})();
