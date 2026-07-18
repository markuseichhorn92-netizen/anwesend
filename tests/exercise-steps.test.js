'use strict';
// Schritt-für-Schritt-Anleitung + Bewegungsmuster (lib/exercises): Nicht-KI-Übungen (bio=false)
// bekommen nummerierte Schritte + ein gültiges Bewegungsmuster; KI-Geräte (bio=true) NICHT.
// Beides fließt über publicList() an den Client (Übungs-Detail, moveAnimSvg).
const EX = require('../lib/exercises');

// Muster, die der Client (moveAnimSvg) kennt.
const VALID_PATTERNS = ['press-fwd', 'press-up', 'pull-down', 'pull-row', 'hinge', 'squat', 'curl', 'extend', 'raise', 'rotate', 'core', 'carry', 'cardio', 'stretch'];
// Kraft-/Bewegungsgruppen, für die eine Anleitung Pflicht ist (Cardio = Geräte-Hinweise, aber ebenfalls mit steps).
const NEEDS_STEPS = ['brust', 'ruecken', 'schulter', 'arme', 'beine', 'po', 'bauch', 'ganzkoerper', 'cardio', 'mobility'];

function run() {
  let pass = true;
  const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
  const L = EX.publicList();
  const nonbio = L.filter((e) => !e.bio);
  const bio = L.filter((e) => e.bio);

  ok('1. publicList liefert Übungen', L.length >= 60);

  // 2. Jede Nicht-KI-Übung hat >=3 Schritte
  const missing = nonbio.filter((e) => NEEDS_STEPS.includes(e.group) && (!Array.isArray(e.steps) || e.steps.length < 3));
  ok('2. Alle Nicht-KI-Übungen haben >=3 Schritte', missing.length === 0);
  if (missing.length) console.log('     fehlt bei: ' + missing.map((e) => e.name + ' / ' + e.machine).join('; '));

  // 3. Jede Nicht-KI-Übung hat ein gültiges Bewegungsmuster
  const badPat = nonbio.filter((e) => !VALID_PATTERNS.includes(e.pattern));
  ok('3. Alle Nicht-KI-Übungen haben ein gültiges pattern', badPat.length === 0);
  if (badPat.length) console.log('     ungültig: ' + badPat.map((e) => e.name + ' -> "' + e.pattern + '"').join('; '));

  // 4. KI-Geräte (bio) tragen KEINE Schritte (Gerät führt selbst)
  const bioWithSteps = bio.filter((e) => Array.isArray(e.steps) && e.steps.length);
  ok('4. KI-Geräte (bio) haben keine steps', bioWithSteps.length === 0);

  // 5. Schritte sind nicht-leere Strings, jeder Schritt kurz genug
  const badStep = nonbio.find((e) => (e.steps || []).some((s) => typeof s !== 'string' || !s.trim() || s.length > 200));
  ok('5. Schritte sind saubere, kurze Strings', !badStep);

  // 6. Beispiel: Bankdrücken (Nicht-KI) hat steps + press-fwd; Chest Press Biostrength (KI) nicht
  const bank = L.find((e) => e.name === 'Bankdrücken' && e.machine === 'Olympic Rack Pure');
  ok('6. Bankdrücken: steps + pattern press-fwd', bank && bank.steps.length >= 3 && bank.pattern === 'press-fwd');
  const chestKi = L.find((e) => /Chest Press Biostrength/.test(e.machine));
  ok('6b. Chest Press Biostrength (KI): keine steps, kein pattern', chestKi && chestKi.bio && chestKi.steps.length === 0 && !chestKi.pattern);

  // 7. Alle real verwendeten Muster stehen in der Client-Whitelist
  const usedPatterns = Array.from(new Set(nonbio.map((e) => e.pattern)));
  ok('7. Alle verwendeten Muster sind dem Client bekannt', usedPatterns.every((p) => VALID_PATTERNS.includes(p)));

  console.log(pass ? 'EXERCISE-STEPS PASS' : 'EXERCISE-STEPS FAIL');
  process.exit(pass ? 0 : 1);
}
run();
