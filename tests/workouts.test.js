'use strict';
// Trainings-Aufzeichnung (lib/workouts): reine Auswertung – Zonen-Einordnung, Aggregation
// (Ø/Max, Zeit je Zone, kcal, TRIMP), Säuberung eingehender Einheiten, 7-Tage-Last.
const WO = require('../lib/workouts');
const MO = require('../lib/morning');

function run() {
  let pass = true;
  const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  const age = 40;
  const zones = MO.trainingZones(age);          // {hrMax, table:[Z1..Z5]}
  ok('0. trainingZones liefert 5 Zonen', zones && zones.table && zones.table.length === 5);
  const hrMax = zones.hrMax;

  // 1. Zonen-Index: unter Z1 -> -1, in Z1 -> 0, sehr hoch -> 4
  ok('1. zoneIndex unter Z1 = -1', WO.zoneIndex(zones.table[0].bpmLo - 5, zones.table) === -1);
  ok('1b. zoneIndex an Z1-Grenze = 0', WO.zoneIndex(zones.table[0].bpmLo, zones.table) === 0);
  ok('1c. zoneIndex sehr hoch = 4', WO.zoneIndex(hrMax + 10, zones.table) === 4);

  // 2. Aggregation: 20 Min konstant in Zone 3 (Mitte)
  const z3 = Math.round((zones.table[2].bpmLo + zones.table[2].bpmHi) / 2);
  const samples = [];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i <= 1200; i++) samples.push({ t: t0 + i * 1000, bpm: z3 });   // 1200 s @1Hz
  const a = WO.aggregate(samples, { age, weightKg: 80, sex: 'm', hrRest: 55 });
  ok('2. Dauer ~1200 s', a && Math.abs(a.durationSec - 1200) <= 2);
  ok('3. Ø-Puls = Zone-3-Mitte', a && a.avgHr === z3);
  ok('4. Max-Puls = Zone-3-Mitte', a && a.maxHr === z3);
  ok('5. Zeit fast komplett in Zone 3', a && a.zoneSecs[2] >= 1150 && a.zoneSecs[0] === 0 && a.zoneSecs[4] === 0);
  ok('6. kcal > 0 und plausibel', a && a.kcal > 100 && a.kcal < 800);
  ok('7. TRIMP > 0', a && a.trimp > 0);

  // 3. Aussetzer werden gedeckelt (Lücke von 5 Min zählt max 30 s)
  const gap = [{ t: t0, bpm: z3 }, { t: t0 + 1000, bpm: z3 }, { t: t0 + 301000, bpm: z3 }, { t: t0 + 302000, bpm: z3 }];
  const ag = WO.aggregate(gap, { age });
  ok('8. Lücke gedeckelt: Zonenzeit < Rohdauer', ag && ag.zoneSecs[2] <= 62);

  // 4. Zu wenige Messwerte -> null
  ok('9. <3 Messwerte -> null', WO.aggregate([{ t: t0, bpm: 120 }], { age }) === null);

  // 5. sanitizeSession: klammert + Outdoor-Felder + Route-Kappung
  const s = WO.sanitizeSession({ kind: 'outdoor', activity: 'laufen', durationSec: 1800, avgHr: 150, maxHr: 175, zoneSecs: [10, 20, 30, 40, 50], kcal: 400, trimp: 90, distanceM: 5000, paceSec: 360, elevM: 40, route: new Array(999).fill([50.1, 6.7]) }, 1700000000000);
  ok('10. Outdoor säubern: Distanz/Pace erhalten', s.kind === 'outdoor' && s.distanceM === 5000 && s.paceSec === 360);
  ok('11. Route auf 600 Punkte gekappt', s.route.length === 600 && s.route[0][0] === 50.1);
  ok('12. Unbekannte Aktivität -> Fallback', WO.sanitizeSession({ kind: 'indoor', activity: 'bloedsinn', durationSec: 100, avgHr: 120 }).activity === 'studio');
  ok('13. Werte außerhalb Bereich -> geklammert (avgHr 999 -> null)', WO.sanitizeSession({ durationSec: 100, avgHr: 999 }).avgHr === null);

  // 6. validSession
  ok('14. valid: kurz/ohne Puls ungültig', !WO.validSession({ durationSec: 3, avgHr: 0 }) && WO.validSession({ durationSec: 30, avgHr: 120 }));
  ok('14b. valid: Outdoor ohne Puls, aber mit Strecke gültig', WO.validSession({ kind: 'outdoor', durationSec: 600, avgHr: 0, distanceM: 4000 }) && !WO.validSession({ kind: 'indoor', durationSec: 600, avgHr: 0, distanceM: 4000 }));

  // 6b. Health/Fit-Import: fromExternal + importMerge (Dedup per extId)
  const ext1 = { extId: 'HK-1', start: t0, end: t0 + 1800 * 1000, activity: 'laufen', kcal: 320, avgHr: 148, maxHr: 170, distanceM: 5200 };
  const fe = WO.fromExternal(ext1);
  ok('17. fromExternal: Dauer aus start/end, source=health, outdoor', fe.durationSec === 1800 && fe.source === 'health' && fe.kind === 'outdoor' && fe.extId === 'HK-1');
  const feSan = WO.sanitizeSession(fe, fe.ts);
  ok('17b. sanitize erhält source/extId/Distanz', feSan.source === 'health' && feSan.extId === 'HK-1' && feSan.distanceM === 5200 && WO.validSession(feSan));
  // Studio-Import ohne Puls, aber mit kcal -> gültig (Zusammenfassung reicht bei Import)
  const ext2 = { extId: 'HK-2', start: t0 + 999, end: t0 + 999 + 2700 * 1000, activity: 'studio', kind: 'indoor', kcal: 260, avgHr: 0 };
  ok('18. Import Studio ohne Puls, mit kcal -> gültig', WO.validSession(WO.sanitizeSession(WO.fromExternal(ext2), t0 + 999)));
  // Merge dedupliziert: HK-1 bereits vorhanden -> nur HK-2 neu
  const merged = WO.importMerge([feSan], [ext1, ext2], t0);
  ok('19. importMerge: nur neue (dedup per extId)', merged.added === 1 && merged.list.length === 2 && merged.list.some((s) => s.extId === 'HK-2'));
  // Erneuter Merge mit denselben -> nichts neu
  const merged2 = WO.importMerge(merged.list, [ext1, ext2], t0);
  ok('19b. importMerge idempotent', merged2.added === 0 && merged2.list.length === 2);
  // App-Session ohne extId bleibt (source app implizit)
  ok('20. sanitize Default-Source app', WO.sanitizeSession({ durationSec: 100, avgHr: 120 }).source === 'app');

  // 7. weeklyLoad: nur letzte 7 Tage
  const now = Date.now();
  const wl = WO.weeklyLoad([
    { ts: now - 1 * 864e5, durationSec: 1800, trimp: 80, avgHr: 150 },
    { ts: now - 3 * 864e5, durationSec: 2400, trimp: 100, avgHr: 145 },
    { ts: now - 20 * 864e5, durationSec: 3600, trimp: 200, avgHr: 150 },  // zu alt
  ]);
  ok('15. weeklyLoad: 2 Sessions, TRIMP 180, ~70 min', wl.sessions === 2 && wl.trimp === 180 && wl.minutes === 70);
  ok('16. weeklyLoad: letzte Einheit = jüngste', wl.lastLoad === 80);

  console.log(pass ? 'WORKOUTS PASS' : 'WORKOUTS FAIL');
  process.exit(pass ? 0 : 1);
}
run();
