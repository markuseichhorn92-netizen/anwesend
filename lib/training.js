'use strict';

/**
 * Trainings-Bibliothek + Coach-Inhalte fürs Mitglied.
 * -------------------------------------------------------------------------
 * Kuratierte, studioweit gültige Trainingspläne für Fit-Inn Trier – auf das
 * TATSÄCHLICH vorhandene Technogym-/Studio-Inventar abgestimmt. Plus rotierende
 * Trainingstipps und Inspiration und die Speicherung des „Meinen Plans".
 *
 * WICHTIG (Studio-Vorgabe): Für Einsteiger stehen die Technogym-BIOSTRENGTH-Geräte
 * im Fokus. Meldet sich das Mitglied am Gerät an, stellt es Sitz/Hebel automatisch
 * ein und die Technogym-KI übernimmt die Progression (Gewicht/Wiederholungen).
 * Solche Pläne/Übungen sind mit aiAssist:true bzw. der Maschine markiert.
 *
 * Datenmodell:
 *   - Kuratierte Pläne + Tipps + Inspiration als Seed in DIESER Datei (keine
 *     externe Abhängigkeit, datensparsam). Struktur so, dass das Team sie später
 *     im Backend pflegen kann (train:lib:*).
 *   - Aktiver Plan eines Mitglieds:  train:active:<memberId>  STRING(JSON)
 *       { source:'library', planId, startedAt } | { source:'finn', plan:{…}, startedAt }
 *
 * Kanonische Plan-Form:
 *   { id, title, subtitle, goal, level, daysPerWeek, weeks, location, equipment:[…],
 *     emoji, accent, summary, focus:[…], aiAssist?,
 *     days:[ { name, subtitle?, exercises:[ { name, machine?, sets, reps, rest, note? } ] } ],
 *     tips:[…], source }
 */

const { redisPipeline, hasStore } = require('./store');

const AKEY = (id) => 'train:active:' + String(id);

// ── Ziele & Level (für UI-Labels + FINN-Prompt) ──
const GOALS = {
  ganzkoerper: 'Ganzkörper-Fitness',
  abnehmen: 'Abnehmen & Fettabbau',
  aufbau: 'Muskelaufbau',
  definieren: 'Definieren & straffen',
  kraft: 'Kraft & Leistung',
  beweglichkeit: 'Beweglichkeit & Rücken',
};
const LEVELS = { einsteiger: 'Einsteiger', mittel: 'Mittel', fortgeschritten: 'Fortgeschritten' };
const LOCATIONS = { studio: 'Im Studio', zuhause: 'Zuhause', beides: 'Studio oder zuhause' };

// Kurzbeschreibung des Studio-Inventars – geht in den FINN-Prompt, damit generierte
// Pläne echte Geräte von Fit-Inn Trier nutzen (Einsteiger bevorzugt Biostrength).
const STUDIO_EQUIPMENT = [
  'Fit-Inn Trier ist mit Technogym ausgestattet.',
  'BIOSTRENGTH-Geräte (für Einsteiger bevorzugen – melden das Mitglied automatisch an, stellen Sitz/Hebel ein und steuern die Progression per KI): Chest Press, Shoulder Press, Low Row, Vertical Traction, Pectoral, Reverse Fly, Arm Curl, Arm Extension, Leg Press, Leg Extension, Leg Curl, Adductor, Abductor, Lower Back, Total Abdominal.',
  'Weitere Geräte: Artis-Linie (Chest Press, Lat Machine, Leg Extension/Curl, Rotary Torso, Rear Delt Row, Multi Hip, Total Abdominal), Multipower (Smith), Kabelzüge (Cable Stations, Cable Crossover), Hip Thrust, Olympic Rack, Technogym Bench.',
  'Cardio: Laufband (Run), Bike, Recline-Bike, SkillRow, SkillMill/Climb, Vario.',
  'Freihanteln & Functional: Kurzhanteln, Langhantel, SZ-Stange, Kettlebells (Kugelhantel), Hexagon-Hanteln, Sling-Trainer, Medizinball, Bänder, Balancierpad, Schaumstoffrolle.',
].join(' ');

const BIO_NOTE = 'Am Gerät anmelden – Sitz & Gewicht stellen sich automatisch ein, die Technogym-KI steigert dich Schritt für Schritt.';

function str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 200); }
function clampN(v, lo, hi, def) { const n = Math.round(Number(v)); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); }

// ─────────────────────────────────────────────────────────────────────────
// Kuratierte Trainingsplan-Bibliothek (echtes Fit-Inn-Inventar)
// ─────────────────────────────────────────────────────────────────────────
const PLANS = [
  {
    id: 'biostrength-einsteiger',
    title: 'Biostrength Ganzkörper',
    subtitle: 'Der perfekte Start – die Geräte stellen sich für dich ein',
    goal: 'ganzkoerper', level: 'einsteiger', daysPerWeek: 3, weeks: 8, location: 'studio',
    equipment: ['Biostrength'], emoji: '🤖', accent: '#12a06a', aiAssist: true,
    summary: 'Der ideale Einstieg an unseren Technogym-Biostrength-Geräten: Du meldest dich am Gerät an, Sitz und Gewicht stellen sich automatisch ein und die Technogym-KI steigert dich Woche für Woche. Zwei- bis dreimal pro Woche der ganze Körper.',
    focus: ['Ganzkörper', 'Geführt & sicher', 'KI-Progression'],
    days: [
      { name: 'Ganzkörper (Biostrength)', subtitle: 'An jedem Gerät anmelden – der Rest passt sich automatisch an', exercises: [
        { name: 'Beinpresse', machine: 'Leg Press Biostrength', sets: 3, reps: '12–15', rest: '75 s', note: BIO_NOTE },
        { name: 'Brustdrücken', machine: 'Chest Press Biostrength', sets: 3, reps: '12–15', rest: '75 s' },
        { name: 'Rudern / Zug', machine: 'Low Row Biostrength', sets: 3, reps: '12–15', rest: '75 s' },
        { name: 'Schulterdrücken', machine: 'Shoulder Press Biostrength', sets: 2, reps: '12–15', rest: '60 s' },
        { name: 'Beinbeuger', machine: 'Leg Curl Biostrength', sets: 3, reps: '12–15', rest: '60 s' },
        { name: 'Beinstrecker', machine: 'Leg Extension Biostrength', sets: 3, reps: '12–15', rest: '60 s' },
        { name: 'Rückenstreckung', machine: 'Lower Back Biostrength', sets: 2, reps: '12–15', rest: '60 s' },
        { name: 'Bauch / Crunch', machine: 'Total Abdominal Biostrength', sets: 3, reps: '15', rest: '45 s' },
      ] },
    ],
    tips: ['Melde dich an JEDEM Biostrength-Gerät mit deinem Profil an – nur dann steuert die KI deine Progression.', 'Beweg dich langsam und kontrolliert; die Geräte führen die Bewegung sauber – so lernst du die richtige Technik.'],
  },
  {
    id: 'geraete-ganzkoerper',
    title: 'Ganzkörper an den Geräten',
    subtitle: 'Biostrength & Artis kombiniert',
    goal: 'ganzkoerper', level: 'mittel', daysPerWeek: 3, weeks: 10, location: 'studio',
    equipment: ['Biostrength', 'Artis', 'Kabelzug'], emoji: '🏋️', accent: '#0f7a4a',
    summary: 'Dreimal pro Woche der komplette Körper an unseren geführten Geräten – ein Mix aus Biostrength und der Artis-Linie. Sicher, effektiv und schnell gelernt.',
    focus: ['Ganzkörper', 'Geräte', 'Kraftaufbau'],
    days: [
      { name: 'Ganzkörper A', exercises: [
        { name: 'Beinpresse', machine: 'Leg Press Biostrength', sets: 3, reps: '10–12', rest: '90 s' },
        { name: 'Brustdrücken', machine: 'Chest Press Artis', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Latzug zur Brust', machine: 'Lat Machine Artis', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Schulterdrücken', machine: 'Shoulder Press Biostrength', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Beinstrecker', machine: 'Leg Extension Artis', sets: 3, reps: '12', rest: '60 s' },
        { name: 'Rumpfrotation', machine: 'Rotary Torso Artis', sets: 3, reps: '15 je Seite', rest: '45 s' },
      ] },
      { name: 'Ganzkörper B', exercises: [
        { name: 'Rudern tief', machine: 'Low Row Biostrength', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Beinbeuger', machine: 'Leg Curl Artis', sets: 3, reps: '12', rest: '60 s' },
        { name: 'Butterfly / Armadduktion', machine: 'Pectoral Artis', sets: 3, reps: '12', rest: '60 s' },
        { name: 'Rear Delt / Fliegende rückwärts', machine: 'Rear Delt Row Artis', sets: 3, reps: '12–15', rest: '60 s' },
        { name: 'Rückenstreckung', machine: 'Lower Back Biostrength', sets: 3, reps: '12–15', rest: '60 s' },
        { name: 'Bauch / Crunch', machine: 'Total Abd. Artis', sets: 3, reps: '15', rest: '45 s' },
      ] },
    ],
    tips: ['An den Biostrength-Geräten übernimmt die KI die Steigerung – an den Artis-Geräten steigerst du selbst alle 1–2 Wochen leicht.'],
  },
  {
    id: 'ober-unterkoerper',
    title: 'Oberkörper / Unterkörper',
    subtitle: '4× pro Woche – oben/unten getrennt',
    goal: 'aufbau', level: 'mittel', daysPerWeek: 4, weeks: 10, location: 'studio',
    equipment: ['Langhantel', 'Kurzhanteln', 'Kabelzug', 'Geräte'], emoji: '💪', accent: '#0a5a37',
    summary: 'Vier Einheiten pro Woche, aufgeteilt in zwei Oberkörper- und zwei Unterkörper-Tage. Mehr Volumen pro Muskelgruppe für sichtbaren Aufbau.',
    focus: ['Muskelaufbau', 'Mehr Volumen', 'Struktur'],
    days: [
      { name: 'Oberkörper 1', exercises: [
        { name: 'Bankdrücken', machine: 'Multipower', sets: 4, reps: '8–10', rest: '120 s' },
        { name: 'Latzug zur Brust', machine: 'Lat Machine Artis', sets: 4, reps: '8–10', rest: '90 s' },
        { name: 'Schrägbankdrücken', machine: 'Kurzhanteln', sets: 3, reps: '10–12', rest: '90 s' },
        { name: 'Rudern am Kabel', machine: 'Cable Stations 4', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Seitheben', machine: 'Kurzhanteln', sets: 3, reps: '12–15', rest: '60 s' },
      ] },
      { name: 'Unterkörper 1', exercises: [
        { name: 'Kniebeuge', machine: 'Multipower', sets: 4, reps: '8–10', rest: '150 s', note: 'Nur so tief, wie du den Rücken gerade hältst.' },
        { name: 'Beinpresse', machine: 'Leg Press Biostrength', sets: 3, reps: '10–12', rest: '120 s' },
        { name: 'Beinbeuger', machine: 'Leg Curl Artis', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Hip Thrust', machine: 'Hip Thrust Pure', sets: 3, reps: '10–12', rest: '90 s' },
        { name: 'Wadenheben', machine: 'Multipower', sets: 4, reps: '15', rest: '45 s' },
      ] },
      { name: 'Oberkörper 2', exercises: [
        { name: 'Schulterdrücken', machine: 'Kurzhanteln', sets: 4, reps: '8–10', rest: '120 s' },
        { name: 'Rudern eng am Kabel', machine: 'Cable Stations 4', sets: 4, reps: '10–12', rest: '90 s' },
        { name: 'Bizeps-Curl', machine: 'Arm Curl Biostrength', sets: 3, reps: '10–12', rest: '60 s' },
        { name: 'Trizeps-Strecken', machine: 'Arm Extension Biostrength', sets: 3, reps: '10–12', rest: '60 s' },
        { name: 'Face Pulls', machine: 'Cable Stations 4', sets: 3, reps: '15', rest: '45 s' },
      ] },
      { name: 'Unterkörper 2', exercises: [
        { name: 'Kreuzheben rumänisch', machine: 'Langhantel', sets: 4, reps: '8–10', rest: '120 s' },
        { name: 'Beinstrecker', machine: 'Leg Extension Artis', sets: 4, reps: '10–12', rest: '60 s' },
        { name: 'Ausfallschritte', machine: 'Kurzhanteln', sets: 3, reps: '10 je Seite', rest: '75 s' },
        { name: 'Bauch: Beinheben', machine: 'Freie Übung', sets: 3, reps: '12', rest: '45 s' },
      ] },
    ],
    tips: ['Steigere alle 1–2 Wochen leicht Gewicht oder eine Wiederholung (progressive Überlastung).'],
  },
  {
    id: 'push-pull-legs',
    title: 'Push / Pull / Legs',
    subtitle: 'Der Klassiker – 3 bis 6× pro Woche',
    goal: 'aufbau', level: 'fortgeschritten', daysPerWeek: 6, weeks: 12, location: 'studio',
    equipment: ['Langhantel', 'Kurzhanteln', 'Olympic Rack', 'Kabelzug'], emoji: '🔥', accent: '#063540',
    summary: 'Drücken, Ziehen, Beine – der bewährte Split für Fortgeschrittene. Als 3er-Woche (je 1×) oder 6er-Woche (je 2×) fahrbar.',
    focus: ['Muskelaufbau', 'Hohes Volumen', 'Split'],
    days: [
      { name: 'Push (Brust/Schulter/Trizeps)', exercises: [
        { name: 'Bankdrücken', machine: 'Olympic Rack Pure', sets: 4, reps: '6–8', rest: '150 s' },
        { name: 'Schrägbankdrücken', machine: 'Kurzhanteln', sets: 3, reps: '8–10', rest: '90 s' },
        { name: 'Schulterdrücken', machine: 'Kurzhanteln', sets: 3, reps: '8–10', rest: '90 s' },
        { name: 'Seitheben', machine: 'Kurzhanteln', sets: 4, reps: '12–15', rest: '45 s' },
        { name: 'Trizeps am Kabel', machine: 'Cable Crossover', sets: 3, reps: '10–12', rest: '60 s' },
      ] },
      { name: 'Pull (Rücken/Bizeps)', exercises: [
        { name: 'Kreuzheben', machine: 'Langhantel', sets: 3, reps: '5', rest: '180 s', note: 'Technik geht vor Gewicht.' },
        { name: 'Latzug / Klimmzug', machine: 'Lat Machine Artis', sets: 4, reps: '8–10', rest: '90 s' },
        { name: 'Rudern vorgebeugt', machine: 'Langhantel', sets: 3, reps: '8–10', rest: '90 s' },
        { name: 'Rear Delt Row', machine: 'Rear Delt Row Artis', sets: 3, reps: '12', rest: '60 s' },
        { name: 'Bizeps-Curl', machine: 'SZ-Langhantel', sets: 3, reps: '10–12', rest: '60 s' },
      ] },
      { name: 'Legs (Beine/Bauch)', exercises: [
        { name: 'Kniebeuge', machine: 'Olympic Rack Pure', sets: 4, reps: '6–8', rest: '180 s' },
        { name: 'Beinpresse', machine: 'Leg Press Biostrength', sets: 3, reps: '10–12', rest: '90 s' },
        { name: 'Beinbeuger', machine: 'Leg Curl Artis', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Wadenheben', machine: 'Multipower', sets: 4, reps: '12–15', rest: '45 s' },
        { name: 'Plank', machine: 'Freie Übung', sets: 3, reps: '45 s', rest: '45 s' },
      ] },
    ],
    tips: ['Als 6er-Split brauchst du gute Regeneration – schlaf genug und iss ausreichend Eiweiß.'],
  },
  {
    id: 'kurzhantel-ganzkoerper',
    title: 'Kurzhantel Ganzkörper',
    subtitle: 'Frei trainieren – Studio oder zuhause',
    goal: 'ganzkoerper', level: 'mittel', daysPerWeek: 3, weeks: 8, location: 'beides',
    equipment: ['Kurzhanteln'], emoji: '🏋️‍♀️', accent: '#7a5326',
    summary: 'Ein kompletter Ganzkörperplan nur mit Kurzhanteln – funktioniert im Studio genauso wie zuhause. Fördert nebenbei Koordination und Rumpfstabilität.',
    focus: ['Ganzkörper', 'Freihantel', 'Flexibel'],
    days: [
      { name: 'Ganzkörper (Kurzhantel)', exercises: [
        { name: 'Goblet-Kniebeuge', machine: 'Kurzhanteln', sets: 3, reps: '12', rest: '75 s' },
        { name: 'Brustdrücken auf Flachbank', machine: 'Kurzhanteln', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Rudern einarmig', machine: 'Kurzhanteln', sets: 3, reps: '10–12 je Seite', rest: '60 s' },
        { name: 'Überkopfdrücken', machine: 'Kurzhanteln', sets: 3, reps: '10–12', rest: '60 s' },
        { name: 'Rumänisches Kreuzheben', machine: 'Kurzhanteln', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Ausfallschritte gehend', machine: 'Kurzhanteln', sets: 3, reps: '10 je Seite', rest: '60 s' },
        { name: 'Russian Twist', machine: 'Kurzhanteln', sets: 3, reps: '20', rest: '45 s' },
      ] },
    ],
    tips: ['Mach die Bewegungen langsam – 2 Sekunden runter, 1 Sekunde hoch – das erhöht den Reiz.'],
  },
  {
    id: 'functional-kettlebell',
    title: 'Functional & Kettlebell',
    subtitle: 'Dynamisch, kräftigend, athletisch',
    goal: 'definieren', level: 'mittel', daysPerWeek: 3, weeks: 8, location: 'studio',
    equipment: ['Kugelhantel', 'Sling-Trainer', 'Körpergewicht'], emoji: '⚡', accent: '#e0662f',
    summary: 'Ein funktionelles Ganzkörper-Workout mit Kettlebell und Sling-Trainer. Bringt den Puls hoch, kräftigt den ganzen Körper und formt einen athletischen Look.',
    focus: ['Functional', 'Kondition', 'Ganzkörper'],
    days: [
      { name: 'Functional-Zirkel', subtitle: '2–3 Runden, 60 s Pause zwischen den Runden', exercises: [
        { name: 'Kettlebell Swing', machine: 'Kugelhantel', sets: 3, reps: '15', rest: '45 s' },
        { name: 'Goblet-Kniebeuge', machine: 'Kugelhantel', sets: 3, reps: '12', rest: '45 s' },
        { name: 'Rudern im Sling-Trainer', machine: 'Sling trainer', sets: 3, reps: '12', rest: '45 s' },
        { name: 'Liegestütz im Sling-Trainer', machine: 'Sling trainer', sets: 3, reps: '10–12', rest: '45 s' },
        { name: 'Türkisches Aufstehen', machine: 'Kugelhantel', sets: 2, reps: '4 je Seite', rest: '60 s', note: 'Langsam und kontrolliert – Technik vor Tempo.' },
        { name: 'Plank', machine: 'Körpergewicht', sets: 3, reps: '40 s', rest: '45 s' },
      ] },
    ],
    tips: ['Beim Kettlebell Swing kommt die Kraft aus der Hüfte, nicht aus den Armen.'],
  },
  {
    id: 'cardio-abnehmen',
    title: 'Cardio & Fettabbau',
    subtitle: 'Ausdauer und Kalorienverbrauch',
    goal: 'abnehmen', level: 'einsteiger', daysPerWeek: 4, weeks: 8, location: 'studio',
    equipment: ['Cardio', 'SkillRow', 'Climb'], emoji: '🏃', accent: '#2C5FB8',
    summary: 'Ein abwechslungsreiches Cardio-Programm an unseren Technogym-Geräten – kurbelt den Kalorienverbrauch an und stärkt Herz und Kreislauf. Kombiniere es mit einem leichten Kaloriendefizit.',
    focus: ['Fettabbau', 'Ausdauer', 'Kreislauf'],
    days: [
      { name: 'Cardio-Mix', subtitle: 'Locker starten, in der Mitte fordern, ausrollen', exercises: [
        { name: 'Aufwärmen locker', machine: 'Bike', sets: 1, reps: '5 Min', rest: '—' },
        { name: 'Intervalle (1 Min zügig / 2 Min locker)', machine: 'Run', sets: 1, reps: '20 Min', rest: '—' },
        { name: 'Ganzkörper-Zug-Intervalle', machine: 'SkillRow', sets: 1, reps: '10 Min', rest: '—' },
        { name: 'Ausrollen & Puls senken', machine: 'Recline', sets: 1, reps: '5 Min', rest: '—' },
      ] },
    ],
    tips: ['Das „Abnehmen"-Profil an Bike und Laufband steuert die Intensität automatisch – ideal zum Einstieg.', 'Fettabbau entsteht aus Bewegung + Ernährung: Cardio plus ein kleines Kaloriendefizit wirken zusammen.'],
  },
  {
    id: 'ruecken-mobility',
    title: 'Rücken & Beweglichkeit',
    subtitle: 'Sanft für einen starken, gesunden Rücken',
    goal: 'beweglichkeit', level: 'einsteiger', daysPerWeek: 3, weeks: 6, location: 'studio',
    equipment: ['Biostrength', 'Schaumstoffrolle', 'Körpergewicht'], emoji: '🧘', accent: '#0e6072',
    summary: 'Kräftigung der Rücken- und Rumpfmuskulatur plus Mobility. Ideal als Ausgleich zum Bürojob oder als Ergänzung zum Krafttraining.',
    focus: ['Rücken', 'Mobility', 'Haltung'],
    days: [
      { name: 'Rücken & Core', exercises: [
        { name: 'Rückenstreckung', machine: 'Lower Back Biostrength', sets: 3, reps: '12–15', rest: '60 s' },
        { name: 'Rudern / Zug', machine: 'Low Row Biostrength', sets: 3, reps: '12–15', rest: '60 s' },
        { name: 'Katze-Kuh (Mobilisation)', machine: 'Freie Übung', sets: 2, reps: '10', rest: '30 s' },
        { name: 'Vierfüßler diagonal (Bird Dog)', machine: 'Freie Übung', sets: 3, reps: '10 je Seite', rest: '45 s' },
        { name: 'Beckenheben / Glute Bridge', machine: 'Freie Übung', sets: 3, reps: '15', rest: '45 s' },
        { name: 'Faszienrolle unterer Rücken', machine: 'Schaumstoffrolle', sets: 2, reps: '45 s', rest: '—' },
        { name: 'Hüftbeuger-Dehnung', machine: 'Stretching', sets: 2, reps: '30 s je Seite', rest: '—' },
      ] },
    ],
    tips: ['Atme bei den Dehnungen ruhig weiter und geh nie in den Schmerz – nur bis zum leichten Ziehen.'],
  },
];

// ── Trainingstipps (rotierender „Tipp des Tages") ──
const TIPS = [
  'An den Biostrength-Geräten musst du nichts einstellen: anmelden, lostrainieren – die Technogym-KI steuert dein Gewicht und deine Progression.',
  'Progressive Überlastung ist der Schlüssel: Wird eine Übung leicht, steigere Gewicht oder Wiederholungen minimal.',
  'Wärme dich 5–10 Minuten locker auf (z. B. Bike oder Laufband) – das schützt vor Verletzungen und du bringst mehr Leistung.',
  'Technik vor Gewicht: Eine saubere Ausführung bringt mehr Muskelreiz als schweres Wackeln. Die geführten Geräte helfen dir dabei.',
  'Nach dem Training sind 20–30 g Eiweiß ideal für die Regeneration – z. B. Magerquark oder ein Shake.',
  'Pausen zählen: Bei Kraft 2–3 Min., bei Muskelaufbau 60–90 s, bei Kondition 20–40 s.',
  'Regeneration ist Teil des Trainings – jede Muskelgruppe braucht rund 48 Stunden Erholung.',
  'Schlaf ist dein bester Booster: 7–9 Stunden helfen dem Muskel mehr als jedes Supplement.',
  'Trink genug: Schon 2 % Flüssigkeitsverlust kosten spürbar Kraft und Kondition.',
  'Zwei Wochen kein Fortschritt? Wechsle Übungen, Wiederholungen oder gönn dir eine leichtere Woche (Deload).',
];

// ── Inspiration-Kacheln ──
const INSPIRATION = [
  { emoji: '🤖', tag: 'Für Einsteiger', title: 'Biostrength macht’s einfach', text: 'Am Gerät anmelden – Sitz und Gewicht stellen sich automatisch ein, die Technogym-KI übernimmt die Steigerung. Du musst dich nur bewegen.' },
  { emoji: '📈', tag: 'Prinzip', title: 'Progressive Überlastung', text: 'Der Muskel wächst nur, wenn du ihn regelmäßig etwas mehr forderst – kleine Steigerungen schlagen große Sprünge.' },
  { emoji: '🔥', tag: 'Fettabbau', title: 'Kraft + Kaloriendefizit', text: 'Krafttraining hält die Muskeln, das Defizit bringt das Fett weg. Beides zusammen formt den Körper.' },
  { emoji: '🍗', tag: 'Ernährung', title: 'Eiweiß über den Tag verteilen', text: 'Rund 1,6–2 g Eiweiß je kg Körpergewicht, verteilt auf 3–4 Mahlzeiten, unterstützt den Muskelerhalt.' },
  { emoji: '😴', tag: 'Regeneration', title: 'Erholung macht stark', text: 'Im Schlaf und an Pausentagen passt sich dein Körper an. Ohne Erholung kein Fortschritt.' },
  { emoji: '🎯', tag: 'Motivation', title: 'Setz dir ein Wochenziel', text: 'Zwei bis drei feste Trainingstage pro Woche im Kalender – so wird Training zur Gewohnheit statt zur Frage.' },
];

// ─────────────────────────────────────────────────────────────────────────
// Zugriffshelfer
// ─────────────────────────────────────────────────────────────────────────
function getLibrary(opts) {
  opts = opts || {};
  let list = PLANS.slice();
  if (opts.goal && GOALS[opts.goal]) list = list.filter((p) => p.goal === opts.goal);
  if (opts.level && LEVELS[opts.level]) list = list.filter((p) => p.level === opts.level);
  return list;
}
function getById(id) { return PLANS.find((p) => p.id === String(id)) || null; }
function searchLibrary(q) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return PLANS.slice();
  return PLANS.filter((p) => (p.title + ' ' + p.subtitle + ' ' + (p.focus || []).join(' ') + ' ' + (p.equipment || []).join(' ') + ' ' + (GOALS[p.goal] || '')).toLowerCase().includes(s));
}
// Deterministischer Tipp des Tages (stabil je Kalendertag, ohne Zufall).
function tipOfDay(ymd) {
  const s = String(ymd || '');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TIPS[h % TIPS.length];
}

// ── Plan normalisieren (für FINN-generierte / gespeicherte Pläne) ──
function normExercise(x) {
  x = x || {};
  const name = str(x.name || x.uebung || x.exercise, 90);
  if (!name) return null;
  const e = {
    name: name,
    sets: clampN(x.sets, 1, 12, 3),
    reps: str(x.reps || x.wiederholungen || x.reps_text, 30) || '10–12',
    rest: str(x.rest || x.pause, 20) || '60 s',
  };
  const machine = str(x.machine || x.geraet || x.equipment, 60); if (machine) e.machine = machine;
  const note = str(x.note || x.hinweis, 140); if (note) e.note = note;
  return e;
}
function normDay(d) {
  d = d || {};
  const exercises = (Array.isArray(d.exercises) ? d.exercises : []).map(normExercise).filter(Boolean).slice(0, 12);
  if (!exercises.length) return null;
  return { name: str(d.name || d.title, 60) || 'Training', subtitle: str(d.subtitle, 90) || undefined, exercises: exercises };
}
function normalizePlan(raw, source) {
  raw = raw || {};
  const days = (Array.isArray(raw.days) ? raw.days : []).map(normDay).filter(Boolean).slice(0, 7);
  if (!days.length) return null;
  const goal = GOALS[raw.goal] ? raw.goal : 'ganzkoerper';
  const level = LEVELS[raw.level] ? raw.level : 'mittel';
  const location = LOCATIONS[raw.location] ? raw.location : 'studio';
  return {
    id: str(raw.id, 60) || ('finn-' + Date.now().toString(36)),
    title: str(raw.title, 70) || 'Dein Trainingsplan',
    subtitle: str(raw.subtitle, 90) || '',
    goal: goal, level: level,
    daysPerWeek: clampN(raw.daysPerWeek || days.length, 1, 7, days.length),
    weeks: clampN(raw.weeks, 1, 24, 8),
    location: location,
    equipment: (Array.isArray(raw.equipment) ? raw.equipment : []).map((e) => str(e, 30)).filter(Boolean).slice(0, 8),
    emoji: str(raw.emoji, 4) || '💪', accent: '#0f7a4a',
    aiAssist: !!raw.aiAssist,
    summary: str(raw.summary, 300) || '',
    focus: (Array.isArray(raw.focus) ? raw.focus : []).map((f) => str(f, 30)).filter(Boolean).slice(0, 4),
    days: days,
    tips: (Array.isArray(raw.tips) ? raw.tips : []).map((t) => str(t, 200)).filter(Boolean).slice(0, 4),
    source: source || 'finn',
  };
}
// Für Listen-/Übersichtsdarstellung genügt eine schlanke Form.
function trimPlan(p) {
  if (!p) return null;
  return { id: p.id, title: p.title, subtitle: p.subtitle, goal: p.goal, level: p.level, daysPerWeek: p.daysPerWeek, weeks: p.weeks, location: p.location, equipment: p.equipment, emoji: p.emoji, accent: p.accent, aiAssist: !!p.aiAssist, summary: p.summary, focus: p.focus, source: p.source || 'library' };
}

// ─────────────────────────────────────────────────────────────────────────
// „Mein Plan" – aktiver Plan eines Mitglieds
// ─────────────────────────────────────────────────────────────────────────
async function loadActive(id) {
  if (!hasStore || !id) return null;
  try {
    const [r] = await redisPipeline([['GET', AKEY(id)]]);
    if (!r) return null;
    const o = JSON.parse(r);
    if (!o || !o.source) return null;
    return o;
  } catch (e) { return null; }
}
async function saveActive(id, obj) {
  if (!hasStore || !id) return false;
  try { await redisPipeline([['SET', AKEY(id), JSON.stringify(obj)]]); return true; } catch (e) { return false; }
}
async function clearActive(id) {
  if (!hasStore || !id) return false;
  try { await redisPipeline([['DEL', AKEY(id)]]); return true; } catch (e) { return false; }
}
// Aktiven Plan zu einem vollständigen Plan-Objekt auflösen (Bibliothek nachladen).
async function resolveActive(id) {
  const a = await loadActive(id);
  if (!a) return null;
  if (a.source === 'library') {
    const p = getById(a.planId);
    if (!p) return null;
    return { plan: Object.assign({}, p, { source: 'library' }), startedAt: a.startedAt || null };
  }
  if (a.source === 'finn' && a.plan) {
    return { plan: Object.assign({}, a.plan, { source: 'finn' }), startedAt: a.startedAt || null };
  }
  return null;
}

module.exports = {
  GOALS, LEVELS, LOCATIONS, PLANS, TIPS, INSPIRATION, STUDIO_EQUIPMENT,
  getLibrary, getById, searchLibrary, tipOfDay,
  normalizePlan, trimPlan,
  loadActive, saveActive, clearActive, resolveActive,
  AKEY,
};
