'use strict';
// Beta-Freigabe der neuen Bottom-Navigation (lib/navBeta.js) + Verdrahtung.
// Standard ist AUS: ohne gesetzte Variablen darf NIEMAND die Testleiste sehen.
// Keine KI-/Netzwerkaufrufe, keine echte Umgebung - die Env wird uebergeben.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NB = require(path.join(ROOT, 'lib', 'navBeta.js'));

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

const M = { id: '12345', email: 'Markus@Example.com' };

// ── 1. Standard: aus ──
ok('1. ohne Konfiguration aus', NB.navBetaFor(M, {}) === 0, String(NB.navBetaFor(M, {})));
ok('1b. leere Werte aendern nichts', NB.navBetaFor(M, { NAV_BETA: '', NAV_BETA_IDS: '', NAV_BETA_EMAILS: '' }) === 0);
ok('1c. ohne Mitglied aus', NB.navBetaFor(null, {}) === 0);

// ── 2. Fuer alle ──
ok('2. NAV_BETA=1 -> Variante 2 (Standard)', NB.navBetaFor(M, { NAV_BETA: '1' }) === 2);
ok('2b. "all" und "true" gelten auch', NB.navBetaFor(M, { NAV_BETA: 'all' }) === 2 && NB.navBetaFor(M, { NAV_BETA: 'TRUE' }) === 2);
ok('2c. Variante waehlbar', NB.navBetaFor(M, { NAV_BETA: '1', NAV_BETA_VARIANT: '1' }) === 1);
ok('2d. unbekannte Variante -> 2', NB.navBetaFor(M, { NAV_BETA: '1', NAV_BETA_VARIANT: '9' }) === 2);
ok('2e. Variante allein schaltet NICHTS frei', NB.navBetaFor(M, { NAV_BETA_VARIANT: '2' }) === 0);

// ── 3. Allowlist nach Kunden-ID ──
ok('3. ID in der Liste', NB.navBetaFor(M, { NAV_BETA_IDS: '999,12345,777' }) === 2);
ok('3b. ID nicht in der Liste', NB.navBetaFor(M, { NAV_BETA_IDS: '999,777' }) === 0);
ok('3c. Leerzeichen in der Liste stoeren nicht', NB.navBetaFor(M, { NAV_BETA_IDS: ' 999 , 12345 ' }) === 2);
ok('3d. Zahl statt Zeichenkette als ID', NB.navBetaFor({ id: 12345 }, { NAV_BETA_IDS: '12345' }) === 2);
ok('3e. Teiltreffer zaehlt NICHT', NB.navBetaFor({ id: '123' }, { NAV_BETA_IDS: '12345' }) === 0);

// ── 4. Allowlist nach E-Mail (Gross-/Kleinschreibung egal) ──
ok('4. E-Mail in der Liste', NB.navBetaFor(M, { NAV_BETA_EMAILS: 'markus@example.com' }) === 2);
ok('4b. Gross-/Kleinschreibung egal', NB.navBetaFor(M, { NAV_BETA_EMAILS: 'MARKUS@EXAMPLE.COM' }) === 2);
ok('4c. andere E-Mail -> aus', NB.navBetaFor(M, { NAV_BETA_EMAILS: 'jemand@example.com' }) === 0);
ok('4d. Mitglied ohne E-Mail -> aus', NB.navBetaFor({ id: '1' }, { NAV_BETA_EMAILS: 'markus@example.com' }) === 0);
ok('4e. leere E-Mail matcht keinen leeren Listeneintrag', NB.navBetaFor({ id: '1', email: '' }, { NAV_BETA_EMAILS: ',,' }) === 0);

// ── 5. Verdrahtung ──
const me = fs.readFileSync(path.join(ROOT, 'api', 'member', 'me.js'), 'utf8');
ok('5. /api/member/me liefert navBeta mit', /navBeta: navBeta/.test(me) && /navBetaFor\(/.test(me));
ok('5b. nutzt das bereits geladene Mitglied (keine Extra-Abfrage)', /navBetaFor\(\{ id: sess\.id, email: m && m\.email \}/.test(me));
ok('5c. Fehler beim Ermitteln sperrt das Mitglied nicht aus', /let navBeta = 0;[\s\S]{0,160}catch \(e\) \{\}/.test(me));

const mem = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
ok('6. Client übernimmt navBeta aus /api/member/me', /DATA\.navBeta=\(d&&\(d\.navBeta===1\|\|d\.navBeta===2\)\)\?d\.navBeta:0/.test(mem));
ok('6b. Geräteeinstellung schlägt die Beta-Freigabe', /if\(v==='0'\) return 0;/.test(mem));
ok('6c. ?navx=auto folgt wieder der Beta-Freigabe', /navx=\(auto\|\[012\]\)/.test(mem) && /'auto'\) localStorage\.removeItem\('fi_navx'\)/.test(mem));
ok('6d. Beta wirkt nur auf Mobil', /navxV && window\.innerWidth<1000/.test(mem));

// ── 6b. Die Rangfolge wird WIRKLICH ausgefuehrt, nicht nur als Text geprueft.
// navxOn() beruehrt nur localStorage und DATA - beides laesst sich hier stellen.
(function () {
  const a = mem.indexOf('  function navxOn(){');
  const b = mem.indexOf('\n  }', a);
  if (a < 0 || b < 0) { ok('8. navxOn aus mitglieder.html herausloesbar', false, 'Block nicht gefunden'); return; }
  const body = mem.slice(a, b + 4);
  const run = (stored, beta) => {
    const ls = { getItem: function (k) { return (k === 'fi_navx' && stored !== undefined) ? stored : null; } };
    const F = {};
    // eslint-disable-next-line no-new-func
    new Function('localStorage', 'DATA', 'exports', body + '\nexports.navxOn=navxOn;')(ls, { navBeta: beta }, F);
    return F.navxOn();
  };
  ok('8. nichts gesetzt -> aus', run(undefined, 0) === 0, String(run(undefined, 0)));
  ok('8b. Beta 2, Gerät neutral -> 2', run(undefined, 2) === 2, String(run(undefined, 2)));
  ok('8c. Beta 1, Gerät neutral -> 1', run(undefined, 1) === 1);
  ok('8d. Gerät AUS schlägt Beta', run('0', 2) === 0, String(run('0', 2)));
  ok('8e. Gerät 1 schlägt Beta 2', run('1', 2) === 1, String(run('1', 2)));
  ok('8f. Gerät 2 ohne Beta', run('2', 0) === 2);
  ok('8g. Unsinn im Speicher -> Beta gilt', run('ja', 2) === 2, String(run('ja', 2)));
  ok('8h. kaputter Beta-Wert -> aus', run(undefined, 7) === 0 && run(undefined, null) === 0);
  // Kein Zugriff auf localStorage moeglich (Privatmodus): darf nicht werfen.
  const boom = { getItem: function () { throw new Error('blocked'); } };
  const H = {};
  // eslint-disable-next-line no-new-func
  new Function('localStorage', 'DATA', 'exports', body + '\nexports.navxOn=navxOn;')(boom, { navBeta: 2 }, H);
  ok('8i. gesperrter Speicher wirft nicht, Beta gilt weiter', H.navxOn() === 2, String(H.navxOn()));
})();

// ── 7. Dokumentiert ──
const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
ok('7. .env.example beschreibt NAV_BETA', /NAV_BETA=/.test(env) && /NAV_BETA_IDS/.test(env) && /NAV_BETA_VARIANT/.test(env));
ok('7b. Hinweis, dass es KEINE Berechtigungsgrenze ist', /KEINE Berechtigungsgrenze/.test(env));

console.log(pass ? 'NAV-BETA PASS' : 'NAV-BETA FAIL');
process.exit(pass ? 0 : 1);
