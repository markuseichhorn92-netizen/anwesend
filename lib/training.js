'use strict';

/**
 * Trainings-Bibliothek + Coach-Inhalte fürs Mitglied.
 * -------------------------------------------------------------------------
 * Kuratierte, studioweit gültige Trainingspläne (Fit-Inn Trier) plus rotierende
 * Trainingstipps und Inspiration. Dazu die Speicherung des „Meinen Plans" eines
 * Mitglieds (kuratiert ODER von FINN generiert).
 *
 * Datenmodell:
 *   - Kuratierte Pläne + Tipps + Inspiration leben als Seed in DIESER Datei
 *     (keine externe Abhängigkeit, datensparsam, sofort verfügbar). Struktur ist
 *     so gehalten, dass das Team sie später im Backend pflegen kann (train:lib:*).
 *   - Aktiver Plan eines Mitglieds:  train:active:<memberId>  STRING(JSON)
 *       { source:'library', planId, startedAt }
 *       { source:'finn',    plan:{…},   startedAt }
 *
 * Kanonische Plan-Form:
 *   { id, title, subtitle, goal, level, daysPerWeek, weeks, location,
 *     equipment:[…], emoji, accent, summary, focus:[…],
 *     days:[ { name, subtitle?, exercises:[ { name, sets, reps, rest, note? } ] } ],
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

function str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 200); }
function clampN(v, lo, hi, def) { const n = Math.round(Number(v)); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); }

// ─────────────────────────────────────────────────────────────────────────
// Kuratierte Trainingsplan-Bibliothek
// ─────────────────────────────────────────────────────────────────────────
const PLANS = [
  {
    id: 'ganzkoerper-einsteiger',
    title: 'Ganzkörper für Einsteiger',
    subtitle: 'Der perfekte Start – 3 Übungen pro Muskelgruppe',
    goal: 'ganzkoerper', level: 'einsteiger', daysPerWeek: 3, weeks: 8, location: 'studio',
    equipment: ['Geräte', 'Kurzhanteln'], emoji: '🌱', accent: '#12a06a',
    summary: 'Zweimal bis dreimal pro Woche der komplette Körper an den Geräten. Sichere Technik, moderate Gewichte – ideal für die ersten 8 Wochen.',
    focus: ['Ganzkörper', 'Technik lernen', 'Grundlagen'],
    days: [
      { name: 'Ganzkörper A', exercises: [
        { name: 'Beinpresse', sets: 3, reps: '12–15', rest: '90 s', note: 'Rücken flach anlehnen, nicht ganz durchstrecken.' },
        { name: 'Brustpresse (Gerät)', sets: 3, reps: '12–15', rest: '75 s' },
        { name: 'Latzug zur Brust', sets: 3, reps: '12–15', rest: '75 s', note: 'Schulterblätter zuerst nach unten ziehen.' },
        { name: 'Schulterdrücken (Gerät)', sets: 2, reps: '12–15', rest: '60 s' },
        { name: 'Bauch: Crunch-Maschine', sets: 3, reps: '15', rest: '45 s' },
      ] },
      { name: 'Ganzkörper B', exercises: [
        { name: 'Beinbeuger (liegend)', sets: 3, reps: '12–15', rest: '75 s' },
        { name: 'Rudern am Kabel', sets: 3, reps: '12–15', rest: '75 s' },
        { name: 'Beinstrecker', sets: 3, reps: '12–15', rest: '60 s' },
        { name: 'Bizeps-Curl (Kurzhantel)', sets: 2, reps: '12', rest: '60 s' },
        { name: 'Trizeps-Drücken am Kabel', sets: 2, reps: '12', rest: '60 s' },
      ] },
    ],
    tips: ['Starte 5–10 Min. locker auf dem Crosstrainer zum Aufwärmen.', 'Lieber sauber und langsam als schwer und ruckartig.'],
  },
  {
    id: 'oberkoerper-unterkoerper',
    title: 'Oberkörper / Unterkörper Split',
    subtitle: '4× pro Woche – oben/unten getrennt',
    goal: 'aufbau', level: 'mittel', daysPerWeek: 4, weeks: 10, location: 'studio',
    equipment: ['Langhantel', 'Kurzhanteln', 'Geräte'], emoji: '🏋️', accent: '#0f7a4a',
    summary: 'Vier Einheiten pro Woche, aufgeteilt in zwei Oberkörper- und zwei Unterkörper-Tage. Mehr Volumen pro Muskelgruppe für sichtbaren Aufbau.',
    focus: ['Muskelaufbau', 'Mehr Volumen', 'Struktur'],
    days: [
      { name: 'Oberkörper 1', exercises: [
        { name: 'Bankdrücken (Langhantel)', sets: 4, reps: '8–10', rest: '120 s' },
        { name: 'Klimmzug / Latzug', sets: 4, reps: '8–10', rest: '90 s' },
        { name: 'Schrägbankdrücken (Kurzhantel)', sets: 3, reps: '10–12', rest: '90 s' },
        { name: 'Rudern vorgebeugt', sets: 3, reps: '10–12', rest: '90 s' },
        { name: 'Seitheben', sets: 3, reps: '12–15', rest: '60 s' },
      ] },
      { name: 'Unterkörper 1', exercises: [
        { name: 'Kniebeuge', sets: 4, reps: '8–10', rest: '150 s', note: 'Tief nur so weit, wie du den Rücken gerade hältst.' },
        { name: 'Rumänisches Kreuzheben', sets: 3, reps: '10', rest: '120 s' },
        { name: 'Ausfallschritte (Kurzhantel)', sets: 3, reps: '10 je Seite', rest: '90 s' },
        { name: 'Wadenheben', sets: 4, reps: '15', rest: '45 s' },
      ] },
      { name: 'Oberkörper 2', exercises: [
        { name: 'Schulterdrücken (Kurzhantel)', sets: 4, reps: '8–10', rest: '120 s' },
        { name: 'Rudern am Kabel eng', sets: 4, reps: '10–12', rest: '90 s' },
        { name: 'Dips / Trizeps-Drücken', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Bizeps-Curl (SZ-Stange)', sets: 3, reps: '10–12', rest: '75 s' },
        { name: 'Face Pulls', sets: 3, reps: '15', rest: '45 s' },
      ] },
      { name: 'Unterkörper 2', exercises: [
        { name: 'Beinpresse', sets: 4, reps: '10–12', rest: '120 s' },
        { name: 'Beinbeuger', sets: 4, reps: '10–12', rest: '75 s' },
        { name: 'Hip Thrust', sets: 3, reps: '10–12', rest: '90 s' },
        { name: 'Bauch: Beinheben', sets: 3, reps: '12', rest: '45 s' },
      ] },
    ],
    tips: ['Steigere alle 1–2 Wochen leicht das Gewicht oder eine Wiederholung (progressive Überlastung).'],
  },
  {
    id: 'push-pull-legs',
    title: 'Push / Pull / Legs',
    subtitle: 'Der Klassiker – 3 bis 6× pro Woche',
    goal: 'aufbau', level: 'fortgeschritten', daysPerWeek: 6, weeks: 12, location: 'studio',
    equipment: ['Langhantel', 'Kurzhanteln', 'Geräte'], emoji: '💪', accent: '#0a5a37',
    summary: 'Drücken, Ziehen, Beine – der bewährte Split für Fortgeschrittene. Als 3er-Woche (je 1×) oder 6er-Woche (je 2×) fahrbar.',
    focus: ['Muskelaufbau', 'Hohes Volumen', 'Split'],
    days: [
      { name: 'Push (Brust/Schulter/Trizeps)', exercises: [
        { name: 'Bankdrücken', sets: 4, reps: '6–8', rest: '150 s' },
        { name: 'Schrägbankdrücken (Kurzhantel)', sets: 3, reps: '8–10', rest: '90 s' },
        { name: 'Schulterdrücken', sets: 3, reps: '8–10', rest: '90 s' },
        { name: 'Seitheben', sets: 4, reps: '12–15', rest: '45 s' },
        { name: 'Trizeps am Kabel', sets: 3, reps: '10–12', rest: '60 s' },
      ] },
      { name: 'Pull (Rücken/Bizeps)', exercises: [
        { name: 'Kreuzheben', sets: 3, reps: '5', rest: '180 s', note: 'Technik geht vor Gewicht.' },
        { name: 'Klimmzüge', sets: 4, reps: '6–10', rest: '120 s' },
        { name: 'Rudern vorgebeugt', sets: 3, reps: '8–10', rest: '90 s' },
        { name: 'Latzug eng', sets: 3, reps: '10–12', rest: '60 s' },
        { name: 'Bizeps-Curl', sets: 3, reps: '10–12', rest: '60 s' },
      ] },
      { name: 'Legs (Beine/Bauch)', exercises: [
        { name: 'Kniebeuge', sets: 4, reps: '6–8', rest: '180 s' },
        { name: 'Rumänisches Kreuzheben', sets: 3, reps: '8–10', rest: '120 s' },
        { name: 'Beinpresse', sets: 3, reps: '10–12', rest: '90 s' },
        { name: 'Wadenheben', sets: 4, reps: '12–15', rest: '45 s' },
        { name: 'Plank', sets: 3, reps: '45 s', rest: '45 s' },
      ] },
    ],
    tips: ['Als 6er-Split brauchst du gute Regeneration – schlafe genug und iss ausreichend Eiweiß.'],
  },
  {
    id: 'abnehmen-zirkel',
    title: 'Abnehmen-Zirkel',
    subtitle: 'Kraft + Kreislauf in einem – schnell & effektiv',
    goal: 'abnehmen', level: 'einsteiger', daysPerWeek: 3, weeks: 8, location: 'beides',
    equipment: ['Kurzhanteln', 'Körpergewicht'], emoji: '🔥', accent: '#e0662f',
    summary: 'Ein Zirkel aus 6 Übungen, 2–3 Runden mit wenig Pause. Verbrennt viele Kalorien und hält den Puls oben – auch zuhause machbar.',
    focus: ['Fettabbau', 'Kondition', 'Ganzkörper'],
    days: [
      { name: 'Zirkel (2–3 Runden)', subtitle: '40 s Übung / 20 s Pause, 90 s zwischen den Runden', exercises: [
        { name: 'Kniebeugen (Körpergewicht)', sets: 1, reps: '40 s', rest: '20 s' },
        { name: 'Liegestütze (ggf. auf Knien)', sets: 1, reps: '40 s', rest: '20 s' },
        { name: 'Ausfallschritte im Wechsel', sets: 1, reps: '40 s', rest: '20 s' },
        { name: 'Schulterdrücken (Kurzhantel)', sets: 1, reps: '40 s', rest: '20 s' },
        { name: 'Mountain Climbers', sets: 1, reps: '40 s', rest: '20 s' },
        { name: 'Plank halten', sets: 1, reps: '40 s', rest: '90 s' },
      ] },
    ],
    tips: ['Kombiniere den Zirkel mit einem leichten Kaloriendefizit – Training + Ernährung wirken zusammen.', 'Zu anstrengend? Lass eine Runde weg. Zu leicht? Nimm eine 4. Runde dazu.'],
  },
  {
    id: 'kraft-5x5',
    title: 'Kraft 5×5',
    subtitle: 'Stark werden mit den großen Grundübungen',
    goal: 'kraft', level: 'mittel', daysPerWeek: 3, weeks: 12, location: 'studio',
    equipment: ['Langhantel', 'Power-Rack'], emoji: '🏋️‍♂️', accent: '#063540',
    summary: 'Zwei abwechselnde Ganzkörper-Einheiten mit 5 Sätzen à 5 Wiederholungen auf den Grundübungen. Fokus auf reine Kraft.',
    focus: ['Maximalkraft', 'Grundübungen', 'Progression'],
    days: [
      { name: 'Kraft A', exercises: [
        { name: 'Kniebeuge', sets: 5, reps: '5', rest: '180 s' },
        { name: 'Bankdrücken', sets: 5, reps: '5', rest: '180 s' },
        { name: 'Rudern (Langhantel)', sets: 5, reps: '5', rest: '150 s' },
      ] },
      { name: 'Kraft B', exercises: [
        { name: 'Kniebeuge', sets: 5, reps: '5', rest: '180 s' },
        { name: 'Schulterdrücken (stehend)', sets: 5, reps: '5', rest: '180 s' },
        { name: 'Kreuzheben', sets: 1, reps: '5', rest: '—', note: 'Nur 1 schwerer Satz nach gutem Aufwärmen.' },
      ] },
    ],
    tips: ['Erhöhe das Gewicht erst, wenn alle 5×5 sauber sitzen – meist +2,5 kg pro Einheit.', 'Wärme dich mit leichteren Sätzen an die Arbeitslast heran.'],
  },
  {
    id: 'zuhause-ohne-geraete',
    title: 'Zuhause ohne Geräte',
    subtitle: 'Nur Körpergewicht – überall trainierbar',
    goal: 'ganzkoerper', level: 'einsteiger', daysPerWeek: 3, weeks: 6, location: 'zuhause',
    equipment: ['Körpergewicht'], emoji: '🏠', accent: '#2C5FB8',
    summary: 'Ein kompletter Ganzkörperplan ganz ohne Ausrüstung. Perfekt für Reisetage oder wenn es mal nicht ins Studio geht.',
    focus: ['Ganzkörper', 'Ohne Geräte', 'Flexibel'],
    days: [
      { name: 'Ganzkörper (Körpergewicht)', exercises: [
        { name: 'Kniebeugen', sets: 3, reps: '15–20', rest: '60 s' },
        { name: 'Liegestütze', sets: 3, reps: 'so viele wie möglich', rest: '60 s', note: 'Auf Knien, wenn nötig.' },
        { name: 'Ausfallschritte', sets: 3, reps: '12 je Seite', rest: '60 s' },
        { name: 'Superman (Rücken)', sets: 3, reps: '15', rest: '45 s' },
        { name: 'Plank', sets: 3, reps: '30–45 s', rest: '45 s' },
        { name: 'Glute Bridge', sets: 3, reps: '15–20', rest: '45 s' },
      ] },
    ],
    tips: ['Mach die Bewegungen langsam – 3 Sekunden runter, 1 Sekunde hoch – das erhöht den Reiz.'],
  },
  {
    id: 'definieren-oberkoerper',
    title: 'Definieren & Straffen',
    subtitle: 'Mehr Wiederholungen, kurze Pausen',
    goal: 'definieren', level: 'mittel', daysPerWeek: 4, weeks: 10, location: 'studio',
    equipment: ['Kurzhanteln', 'Kabel', 'Geräte'], emoji: '✨', accent: '#7a5326',
    summary: 'Höhere Wiederholungszahlen und kurze Pausen für einen straffen, definierten Look – kombiniert mit etwas mehr Bewegung im Alltag.',
    focus: ['Definition', 'Muskelausdauer', 'Straffung'],
    days: [
      { name: 'Oberkörper', exercises: [
        { name: 'Brustpresse', sets: 3, reps: '15', rest: '45 s' },
        { name: 'Latzug', sets: 3, reps: '15', rest: '45 s' },
        { name: 'Seitheben', sets: 3, reps: '15–20', rest: '30 s' },
        { name: 'Bizeps/Trizeps im Supersatz', sets: 3, reps: '15', rest: '45 s' },
      ] },
      { name: 'Unterkörper & Core', exercises: [
        { name: 'Beinpresse', sets: 3, reps: '15–20', rest: '45 s' },
        { name: 'Ausfallschritte gehend', sets: 3, reps: '20 Schritte', rest: '45 s' },
        { name: 'Hip Thrust', sets: 3, reps: '15', rest: '45 s' },
        { name: 'Bauch-Zirkel (Crunch/Plank/Beinheben)', sets: 3, reps: 'je 30 s', rest: '30 s' },
      ] },
    ],
    tips: ['Definition entsteht in der Küche: ohne leichtes Kaloriendefizit werden die Muskeln nicht sichtbar.'],
  },
  {
    id: 'ruecken-mobility',
    title: 'Rücken & Beweglichkeit',
    subtitle: 'Sanft für einen starken, gesunden Rücken',
    goal: 'beweglichkeit', level: 'einsteiger', daysPerWeek: 3, weeks: 6, location: 'beides',
    equipment: ['Matte', 'Körpergewicht'], emoji: '🧘', accent: '#0e6072',
    summary: 'Kräftigung der Rumpf- und Rückenmuskulatur plus Mobility. Ideal als Ausgleich zum Bürojob oder als Ergänzung zum Krafttraining.',
    focus: ['Rücken', 'Mobility', 'Haltung'],
    days: [
      { name: 'Rücken & Core', exercises: [
        { name: 'Katze-Kuh (Mobilisation)', sets: 2, reps: '10', rest: '30 s' },
        { name: 'Vierfüßler diagonal (Bird Dog)', sets: 3, reps: '10 je Seite', rest: '45 s' },
        { name: 'Superman', sets: 3, reps: '12', rest: '45 s' },
        { name: 'Seitstütz', sets: 3, reps: '20–30 s je Seite', rest: '45 s' },
        { name: 'Glute Bridge', sets: 3, reps: '15', rest: '45 s' },
        { name: 'Hüftbeuger-Dehnung', sets: 2, reps: '30 s je Seite', rest: '—' },
      ] },
    ],
    tips: ['Atme bei den Dehnungen ruhig weiter und geh nie in den Schmerz – nur bis zum leichten Ziehen.'],
  },
];

// ── Trainingstipps (rotierender „Tipp des Tages") ──
const TIPS = [
  'Progressive Überlastung ist der Schlüssel: Wird eine Übung leicht, steigere Gewicht oder Wiederholungen minimal.',
  'Wärme dich 5–10 Minuten locker auf – das schützt vor Verletzungen und du bringst mehr Leistung.',
  'Technik vor Gewicht: Eine saubere Ausführung bringt mehr Muskelreiz als schweres Wackeln.',
  'Nach dem Training sind 20–30 g Eiweiß ideal für die Regeneration – z. B. Magerquark oder ein Shake.',
  'Pausen zählen: Bei Kraft 2–3 Min., bei Muskelaufbau 60–90 s, bei Kondition 20–40 s.',
  'Regeneration ist Teil des Trainings – jede Muskelgruppe braucht 48 Stunden Erholung.',
  'Schlaf ist dein bester Booster: 7–9 Stunden helfen dem Muskel mehr als jedes Supplement.',
  'Trink genug: Schon 2 % Flüssigkeitsverlust kosten spürbar Kraft und Kondition.',
  'Führe ein kurzes Trainingslogbuch – wer seine Gewichte notiert, steigert sich verlässlicher.',
  'Zwei Wochen kein Fortschritt? Wechsle Übungen, Wiederholungen oder gönn dir eine leichtere Woche (Deload).',
];

// ── Inspiration-Kacheln ──
const INSPIRATION = [
  { emoji: '📈', tag: 'Prinzip', title: 'Progressive Überlastung', text: 'Der Muskel wächst nur, wenn du ihn regelmäßig etwas mehr forderst – kleine Steigerungen schlagen große Sprünge.' },
  { emoji: '🔥', tag: 'Fettabbau', title: 'Kraft + Kaloriendefizit', text: 'Krafttraining hält die Muskeln, das Defizit bringt das Fett weg. Beides zusammen formt den Körper.' },
  { emoji: '🍗', tag: 'Ernährung', title: 'Eiweiß über den Tag verteilen', text: 'Rund 1,6–2 g Eiweiß je kg Körpergewicht, verteilt auf 3–4 Mahlzeiten, unterstützt den Muskelerhalt.' },
  { emoji: '😴', tag: 'Regeneration', title: 'Erholung macht stark', text: 'Im Schlaf und an Pausentagen passt sich dein Körper an. Ohne Erholung kein Fortschritt.' },
  { emoji: '⏱️', tag: 'Alltag', title: '20 Minuten reichen oft', text: 'Ein kurzer, fokussierter Zirkel ist besser als der Plan, den du nie machst. Dranbleiben schlägt Perfektion.' },
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
  return PLANS.filter((p) => (p.title + ' ' + p.subtitle + ' ' + (p.focus || []).join(' ') + ' ' + (GOALS[p.goal] || '')).toLowerCase().includes(s));
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
  return {
    name: name,
    sets: clampN(x.sets, 1, 12, 3),
    reps: str(x.reps || x.wiederholungen || x.reps_text, 30) || '10–12',
    rest: str(x.rest || x.pause, 20) || '60 s',
    note: str(x.note || x.hinweis, 140) || undefined,
  };
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
  return { id: p.id, title: p.title, subtitle: p.subtitle, goal: p.goal, level: p.level, daysPerWeek: p.daysPerWeek, weeks: p.weeks, location: p.location, equipment: p.equipment, emoji: p.emoji, accent: p.accent, summary: p.summary, focus: p.focus, source: p.source || 'library' };
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
  GOALS, LEVELS, LOCATIONS, PLANS, TIPS, INSPIRATION,
  getLibrary, getById, searchLibrary, tipOfDay,
  normalizePlan, trimPlan,
  loadActive, saveActive, clearActive, resolveActive,
  AKEY,
};
