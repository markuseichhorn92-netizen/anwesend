'use strict';
// Muskelgruppen-Auflösung (lib/exercises.groupOf): exakter DB-Treffer -> Name-Treffer -> Heuristik -> ''.
// Diese Auflösung liefert die Muskelgruppe für Plan-Übungen, damit im Client die RICHTIGEN
// Muskeln im Körperdiagramm hervorgehoben werden (statt „ganzkörper" = alles).
const EX = require('../lib/exercises');

function run() {
  let pass = true;
  const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1. Exakter Treffer Name + Gerät
  ok('1. Beinpresse @ Leg Press Biostrength -> beine', EX.groupOf('Beinpresse', 'Leg Press Biostrength') === 'beine');
  ok('1b. Chest Press Biostrength -> brust', EX.groupOf('Brustdrücken', 'Chest Press Biostrength') === 'brust');

  // 2. Name-Treffer, obwohl Gerät nicht exakt in der DB steht (KI erfindet Gerätenamen)
  ok('2. Bankdrücken @ Multipower (DB-Gerät ist Olympic Rack) -> brust', EX.groupOf('Bankdrücken', 'Multipower') === 'brust');
  ok('2b. Klimmzüge ohne Gerät -> ruecken', EX.groupOf('Klimmzüge', '') === 'ruecken');

  // 3. Heuristik greift, wenn der Name gar nicht in der DB steht
  ok('3. „Wadenheben stehend" -> beine (calf/wade)', EX.groupOf('Wadenheben stehend', 'Freihantel') === 'beine');
  ok('3b. „Face Pull am Seil" -> schulter', EX.groupOf('Face Pull am Seil', 'Kabelzug') === 'schulter');
  ok('3c. „Bizeps Curl mit Kurzhantel" -> arme', EX.groupOf('Bizeps Curl mit Kurzhantel', 'Kurzhantel') === 'arme');
  ok('3d. „Laufband-Intervall" -> cardio', EX.groupOf('Laufband-Intervall', 'Run') === 'cardio');
  ok('3e. „Kettlebell Swing" -> ganzkoerper', EX.groupOf('Kettlebell Swing', 'Kugelhantel') === 'ganzkoerper');
  ok('3f. „Plank" -> bauch', EX.groupOf('Plank halten', 'Matte') === 'bauch');

  // 4. Reihenfolge: cardio vor allem, damit „Bike" nicht als beine (bike enthält kein bein) landet
  ok('4. „Bike-Ausfahrt" -> cardio (nicht beine)', EX.groupOf('Bike-Ausfahrt', 'Bike') === 'cardio');

  // 5. Wirklich Unbekanntes -> '' (Client fällt dann auf ganzkoerper zurück, ohne falsche Muskeln)
  ok('5. Fantasie-Übung ohne Anker -> ""', EX.groupOf('Voellig Erfundene Uebung', 'Fantasiegeraet') === '');
  ok('5b. Leerer Name -> ""', EX.groupOf('', 'Chest Press') === '');

  // 6. isGroup prüft die gültigen Gruppen-Keys
  ok('6. isGroup(brust)=true, isGroup(xxx)=false', EX.isGroup('brust') === true && EX.isGroup('xxx') === false);
  ok('6b. alle aufgelösten Gruppen sind gültige Keys', ['brust', 'ruecken', 'schulter', 'arme', 'beine', 'po', 'bauch', 'ganzkoerper', 'cardio', 'mobility'].every((g) => EX.isGroup(g)));

  // 7. Jede aufgelöste Gruppe hat einen Muskel-Eintrag mit regions (Diagramm-Schlüssel)
  ok('7. MUSCLES deckt alle Gruppen ab (regions vorhanden)', ['brust', 'ruecken', 'schulter', 'arme', 'beine', 'po', 'bauch', 'ganzkoerper', 'cardio', 'mobility'].every((g) => EX.MUSCLES[g] && Array.isArray(EX.MUSCLES[g].regions) && EX.MUSCLES[g].regions.length));

  console.log(pass ? 'EXERCISE-GROUP PASS' : 'EXERCISE-GROUP FAIL');
  process.exit(pass ? 0 : 1);
}
run();
