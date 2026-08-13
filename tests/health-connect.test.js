'use strict';
// Health Connect (Android): Manifest, Kotlin-Berechtigungen und tatsaechliche Nutzung
// muessen deckungsgleich sein. Genau das war der Ablehnungsgrund im Play-Review -
// die App hat Rechte angefragt, die sie nie benutzt hat.
//
// Der Test liest die echten Android-Dateien und vergleicht drei Listen:
//   1. <uses-permission> im Manifest
//   2. hcPermissions in FitInnNativePlugin.kt (das, was der Dialog anfragt)
//   3. die Record-Typen, die im Code wirklich gelesen/aggregiert werden
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const AND = path.join(ROOT, 'nativeapp', 'plugins', 'fitinn-native', 'android', 'src', 'main');
const manifest = fs.readFileSync(path.join(AND, 'AndroidManifest.xml'), 'utf8');
const plugin = fs.readFileSync(path.join(AND, 'java', 'de', 'fitinn', 'nativeplugin', 'FitInnNativePlugin.kt'), 'utf8');
const rationale = fs.readFileSync(path.join(AND, 'java', 'de', 'fitinn', 'nativeplugin', 'HealthConnectRationaleActivity.kt'), 'utf8');
const member = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// Record-Klasse -> Berechtigungsname im Manifest
const PERM = {
  ExerciseSessionRecord: 'EXERCISE',
  HeartRateRecord: 'HEART_RATE',
  DistanceRecord: 'DISTANCE',
  ActiveCaloriesBurnedRecord: 'ACTIVE_CALORIES_BURNED',
  TotalCaloriesBurnedRecord: 'TOTAL_CALORIES_BURNED',
  StepsRecord: 'STEPS',
  RestingHeartRateRecord: 'RESTING_HEART_RATE',
  HeartRateVariabilityRmssdRecord: 'HEART_RATE_VARIABILITY',
  WeightRecord: 'WEIGHT',
  BodyFatRecord: 'BODY_FAT',
  Vo2MaxRecord: 'VO2_MAX',
  SleepSessionRecord: 'SLEEP',
};

// ── 1. Manifest ──
const manifestPerms = (manifest.match(/android\.permission\.health\.[A-Z_0-9]+/g) || [])
  .map(function (s) { return s.replace('android.permission.health.', ''); });
const manifestSet = manifestPerms.slice().sort();

ok('1. Manifest fragt ueberhaupt Health-Connect-Rechte an', manifestPerms.length > 0);
ok('2. KEINE Schreibrechte im Manifest', manifestPerms.filter(function (p) { return /^WRITE_/.test(p); }).length === 0,
  manifestPerms.filter(function (p) { return /^WRITE_/.test(p); }).join(','));
ok('3. Keine doppelten Eintraege', new Set(manifestPerms).size === manifestPerms.length);
// Hintergrund- und Verlaufszugriff sind eigene, streng gepruefte Anwendungsfaelle.
ok('4. Kein Hintergrundzugriff angefragt', manifestPerms.indexOf('READ_HEALTH_DATA_IN_BACKGROUND') < 0);
ok('5. Kein erweiterter Verlaufszugriff angefragt', manifestPerms.indexOf('READ_HEALTH_DATA_HISTORY') < 0);

// ── 2. Kotlin: was der Freigabedialog wirklich anfragt ──
const block = plugin.slice(plugin.indexOf('private val hcPermissions'), plugin.indexOf('fun healthAuth'));
const readPerms = (block.match(/getReadPermission\((\w+)::class\)/g) || [])
  .map(function (s) { return s.replace(/getReadPermission\((\w+)::class\)/, '$1'); });
const writePerms = (block.match(/getWritePermission\((\w+)::class\)/g) || []);

ok('6. Kotlin fragt keine Schreibrechte an', writePerms.length === 0, writePerms.join(','));
const kotlinSet = readPerms.map(function (r) { return 'READ_' + PERM[r]; }).sort();
ok('7. Kotlin und Manifest sind deckungsgleich',
  JSON.stringify(kotlinSet) === JSON.stringify(manifestSet),
  'Kotlin=' + kotlinSet.join(',') + '  Manifest=' + manifestSet.join(','));

// ── 3. Jede angefragte Berechtigung wird auch wirklich benutzt ──
// Gelesen wird ueber readRecords(ReadRecordsRequest(X::class …)), latestRecord<X>(…)
// oder aggregate() mit einer Kennzahl der Klasse (X.IRGENDWAS).
const body = plugin.slice(plugin.indexOf('fun healthAuth'));
const usedBy = (rec) => {
  if (new RegExp('ReadRecordsRequest\\(\\s*' + rec + '::class').test(body)) return 'readRecords';
  if (new RegExp('latestRecord<' + rec + '>').test(body)) return 'latestRecord';
  if (new RegExp(rec + '\\.[A-Z_]{3,}').test(body)) return 'aggregate';
  return null;
};
const unused = readPerms.filter(function (r) { return !usedBy(r); });
ok('8. Jede angefragte Leseberechtigung wird im Code benutzt', unused.length === 0,
  'ohne Nutzung: ' + unused.join(','));

// Gegenprobe: die vier im Review beanstandeten Rechte sind wirklich weg.
['WRITE_EXERCISE', 'WRITE_DISTANCE', 'WRITE_ACTIVE_CALORIES_BURNED', 'READ_TOTAL_CALORIES_BURNED'].forEach(function (p, i) {
  ok('9' + '.abcd'[i] + ' ' + p + ' entfernt', manifestPerms.indexOf(p) < 0 && block.indexOf(PERM[p] || '###') < 0);
});
ok('10. TotalCaloriesBurnedRecord auch nicht mehr importiert', plugin.indexOf('TotalCaloriesBurnedRecord') < 0);

// ── 4. Ehrliche Rueckmeldung an die Oberflaeche ──
// Ohne Schreibrechte darf authFrom niemals write:true melden, sonst bietet die App
// ein Zurueckschreiben an, das gar nicht geht.
ok('11. authFrom meldet write immer false', /authResult\(read, read, false\)/.test(plugin));
ok('12. saveHealthWorkout meldet ehrlich "not_supported"', /put\("error", "not_supported"\)/.test(plugin));

// ── 5. Datenschutzerklaerung im Freigabeschirm ──
const url = (rationale.match(/PRIVACY_URL\s*=\s*"([^"]+)"/) || [])[1] || '';
ok('13. Datenschutz-Adresse gesetzt', /^https:\/\//.test(url), url);
ok('14. NICHT die 404-Adresse der Website', url.indexOf('www.fit-inn-trier.de/datenschutz') < 0, url);
ok('15. Zeigt auf die App-Erklaerung', url === 'https://mitglieder.fit-inn-trier.de/datenschutz', url);

// Die App-Erklaerung muss Health Connect samt Zweck benennen.
ok('16. App-Datenschutz benennt Health Connect', /Health Connect \(Android\)/.test(member));
ok('17. … und schliesst Werbung/Verkauf aus', /nicht zu Werbezwecken<\/b> genutzt oder verkauft/.test(member));

// … und ohne Login erreichbar sein - ein Pruefer hat kein Mitgliedskonto.
ok('18. Rechtsseiten sind ohne Login erreichbar', /PUBLIC_LEGAL\s*=\s*\{[^}]*datenschutz/.test(member));
ok('19. Der Einstieg setzt den Screen auch ohne Token', /screen: TOKEN\?'home':\(LEGAL_ENTRY\|\|'login'\)/.test(member));

// ── 6. Die Erklaerung fuer die Play Console liegt versioniert im Repo ──
const doc = fs.readFileSync(path.join(ROOT, 'docs', 'PLAY-HEALTH-CONNECT.md'), 'utf8');
ok('20. docs/PLAY-HEALTH-CONNECT.md nennt den Anwendungsfall', /Fitness und Wellness/.test(doc));
ok('21. … und listet jede angefragte Berechtigung auf',
  readPerms.every(function (r) { return doc.indexOf('READ_' + PERM[r]) >= 0; }),
  readPerms.filter(function (r) { return doc.indexOf('READ_' + PERM[r]) < 0; }).join(','));
// Die Tabelle im Dokument ist die Fassung, die in die Play Console wandert. Sie muss
// dem Manifest in BEIDE Richtungen entsprechen - eine dort aufgefuehrte, aber nicht
// mehr angefragte Berechtigung waere genauso falsch wie eine fehlende. (Namen im
// Fliesstext, etwa die Sperrliste, sind davon bewusst nicht betroffen.)
const docTable = (doc.match(/^\| `(READ|WRITE)_[A-Z_0-9]+`/gm) || [])
  .map(function (s) { return s.replace(/^\| `|`$/g, ''); }).sort();
ok('22. Die Tabelle im Dokument entspricht genau dem Manifest',
  JSON.stringify(docTable) === JSON.stringify(manifestSet),
  'Dokument=' + docTable.join(',') + '  Manifest=' + manifestSet.join(','));

console.log(pass ? 'HEALTH-CONNECT PASS' : 'HEALTH-CONNECT FAIL');
process.exit(pass ? 0 : 1);
