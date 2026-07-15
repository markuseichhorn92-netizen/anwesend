'use strict';

/**
 * Ernährungs-Coaching – Programm-Logik (Single Source of Truth).
 * -------------------------------------------------------------------------
 * Baut auf dem Ernährungsmodul auf: aus dem reinen Tracker wird eine geführte,
 * mehrwöchige Coaching-Reise (Vorbild: HappyFigur/figurscout-Kurs) – fester
 * Wochen-Rahmen (kuratierte Lektionen) + adaptive tägliche Begleitung durch FINN.
 *
 * Diese Datei hält NUR Zustand & reine Logik (kuratiertes CURRICULUM, Wochen-/
 * Unlock-Mathe, State laden/speichern, DSGVO-Export/-Löschung). KI, Auth, HTTP
 * liegen im Endpunkt (api/member/nutrition-coach.js). Keine npm-Abhängigkeit,
 * alles über redisPipeline (Upstash). Keys: nutri:coach|habits|impulse|checkins|chat:<id>.
 *
 * WICHTIG: Alle diese Keys sind Mitglieds-Ernährungsdaten -> in export UND
 * delete-all (nutrition.js) enthalten. Der Abrechnungs-Key nutri:prem bleibt
 * bewusst ausgeschlossen (Kündigung nur über Stripe-Portal).
 */

const { redisPipeline, hasStore } = require('./store');

const TOTAL_WEEKS = 8;
const COACH_TTL = 400 * 86400; // ~13 Monate, wird bei jeder Änderung verlängert

const COACHKEY = (id) => 'nutri:coach:' + String(id);
const HABITKEY = (id) => 'nutri:habits:' + String(id);
const IMPULSEKEY = (id) => 'nutri:impulse:' + String(id);
const CHECKINKEY = (id) => 'nutri:checkins:' + String(id);
const CHATKEY = (id) => 'nutri:chat:' + String(id);

// ── KV-Helfer (robust: redisPipeline wirft ohne Store -> abfangen) ──
async function kvGetJson(key) {
  if (!hasStore) return null;
  try { const [r] = await redisPipeline([['GET', key]]); return r ? JSON.parse(r) : null; } catch (e) { return null; }
}
async function kvSetJson(key, val, ttl) {
  if (!hasStore) return false;
  try { await redisPipeline([['SET', key, JSON.stringify(val), 'EX', String(ttl || COACH_TTL)]]); return true; } catch (e) { return false; }
}

// ── Datum/Zeit in Studio-Zone (Europe/Berlin), DST-sicher (wie nutrition.berlinNow) ──
function berlinToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
// Ganze Tage zwischen zwei YYYY-MM-DD (b - a); Mittags-UTC-Anker vermeidet DST-Kanten.
function daysBetween(aYMD, bYMD) {
  const a = new Date(String(aYMD) + 'T12:00:00Z').getTime();
  const b = new Date(String(bYMD) + 'T12:00:00Z').getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}
function addDays(ymd, n) {
  const d = new Date(String(ymd) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function clampInt(v, lo, hi, def) { const n = Math.round(Number(v)); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); }

// ═══════════════════════════════════════════════════════════════════════
//  Kuratiertes 8-Wochen-Kurrikulum (Content wie ERN_COOKBOOK – kein KI-Text).
//  FINN personalisiert später nur die Intro (Premium); der Kurstext ist fix.
//  Ton: „du", grün, motivierend, KEINE medizinischen Aussagen / keine Crashdiät.
// ═══════════════════════════════════════════════════════════════════════
const CURRICULUM = [
  {
    week: 1, title: 'Ankommen & Ziel schärfen', theme: 'Grundlagen', minutes: 6,
    teaser: 'Wie Energiebilanz wirklich funktioniert – und ein realistisches Tempo für dein Ziel.',
    body: [
      { h: 'Worum es diese Woche geht', p: 'Abnehmen, halten oder aufbauen – alles entscheidet sich über die Energiebilanz: Was du isst gegen das, was du verbrauchst. Kein Lebensmittel ist „verboten", es kommt auf die Menge über die Woche an.' },
      { h: 'Ein realistisches Tempo', p: 'Gesund sind ca. 0,3–0,7 kg pro Woche. Schneller heißt fast immer Muskelverlust und Jojo. Wir gehen es ruhig an – dafür bleibt es.' },
      { h: 'Dein wichtigstes Werkzeug', p: 'Protokollieren. Wer eine Woche lang ehrlich mitschreibt, sieht sofort die 2–3 Stellschrauben, die den Unterschied machen. Genau dafür ist dein Ernährungs-Tab da.' },
    ],
    exercise: 'Trag heute jede Mahlzeit ein – auch den Kaffee mit Milch und den Snack zwischendurch. Nur beobachten, nichts ändern.',
    habits: [
      { id: 'w1h1', text: 'Jede Mahlzeit protokollieren', cat: 'tracking' },
      { id: 'w1h2', text: 'Morgens 1 Glas Wasser trinken', cat: 'wasser' },
      { id: 'w1h3', text: 'Tagesziel bewusst ansehen', cat: 'achtsamkeit' },
    ],
  },
  {
    week: 2, title: 'Eiweiß zuerst', theme: 'Makros', minutes: 6,
    teaser: 'Warum Eiweiß satt macht, den Muskel schützt – und wie du dein Ziel locker triffst.',
    body: [
      { h: 'Der Sattmacher', p: 'Eiweiß hält am längsten satt und schützt beim Abnehmen deine Muskeln. Beim Aufbau ist es der Baustoff schlechthin. Kurz: Eiweiß ist dein bester Freund.' },
      { h: 'Wie viel?', p: 'Grob 1,6–1,8 g pro kg Körpergewicht. Dein Tagesziel im Tab rechnet das schon für dich aus – dein Job ist nur, es zu treffen.' },
      { h: 'Einfache Quellen', p: 'Quark, Skyr, Hähnchen, Eier, Fisch, Linsen, Tofu, Magerkäse. Eine gute Faustregel: zu jeder Hauptmahlzeit eine Handfläche Eiweiß.' },
    ],
    exercise: 'Bau bei jeder Hauptmahlzeit heute bewusst eine Eiweißquelle ein und schau am Abend, wie nah du an deinem Eiweißziel bist.',
    habits: [
      { id: 'w2h1', text: 'Eiweißquelle zu jeder Hauptmahlzeit', cat: 'protein' },
      { id: 'w2h2', text: 'Eiweißziel zu 90 % treffen', cat: 'protein' },
    ],
  },
  {
    week: 3, title: 'Bewusst statt nebenbei', theme: 'Verhalten', minutes: 5,
    teaser: 'Hunger oder nur Appetit? Langsamer essen, Portionen fühlen – ohne Verzicht.',
    body: [
      { h: 'Hunger vs. Appetit', p: 'Echter Hunger kommt langsam und lässt sich mit fast allem stillen. Appetit ist plötzlich und will etwas Bestimmtes. Kurz innehalten und fragen „Habe ich wirklich Hunger?" spart oft ein paar hundert Kalorien.' },
      { h: 'Das Sättigungssignal', p: 'Dein Gehirn merkt „satt" erst nach ~15 Minuten. Wer langsamer isst, isst automatisch weniger – ohne zu hungern.' },
      { h: 'Nebenbei-Essen', p: 'Vor dem Bildschirm essen wir mehr und schmecken weniger. Eine Mahlzeit am Tag ganz bewusst – das reicht als Anfang.' },
    ],
    exercise: 'Iss heute eine Mahlzeit komplett ohne Bildschirm und leg zwischendurch einmal die Gabel ab.',
    habits: [
      { id: 'w3h1', text: '1× am Tag ohne Bildschirm essen', cat: 'achtsamkeit' },
      { id: 'w3h2', text: 'Vor dem Nachschlag 5 Min warten', cat: 'achtsamkeit' },
    ],
  },
  {
    week: 4, title: 'Kohlenhydrate klug timen', theme: 'Makros', minutes: 6,
    teaser: 'Kohlenhydrate sind kein Feind – rund ums Training bringen sie dich weiter.',
    body: [
      { h: 'Energie für dein Training', p: 'Kohlenhydrate sind der schnellste Treibstoff. An Trainingstagen darfst du bewusst mehr davon essen – dein Körper nutzt sie direkt für Leistung und Regeneration.' },
      { h: 'Qualität schlägt Verzicht', p: 'Vollkorn, Kartoffeln, Haferflocken, Obst, Hülsenfrüchte halten länger satt als Weißmehl und Zucker. Du musst nichts streichen, nur öfter die bessere Variante wählen.' },
      { h: 'Timing', p: 'Rund um dein Workout sind Kohlenhydrate am sinnvollsten. An ruhigen Tagen etwas weniger – so bleibt deine Bilanz im Ziel.' },
    ],
    exercise: 'Plane an deinem nächsten Trainingstag eine kohlenhydratreiche Mahlzeit und tausche einmal Weißmehl gegen die Vollkorn-Variante.',
    habits: [
      { id: 'w4h1', text: 'An Trainingstagen bewusst mehr essen', cat: 'kohlenhydrate' },
      { id: 'w4h2', text: 'Eine Vollkorn-Umstellung', cat: 'kohlenhydrate' },
    ],
  },
  {
    week: 5, title: 'Der Alltag gewinnt', theme: 'Umsetzung', minutes: 6,
    teaser: 'Meal-Prep, Kochbuch & Einkaufsliste – gute Entscheidungen im Voraus treffen.',
    body: [
      { h: 'Entscheide vorher', p: 'Die meisten Ausrutscher passieren spontan bei Hunger. Wer vorkocht und eine Einkaufsliste hat, entscheidet einmal in Ruhe statt zehnmal unter Druck.' },
      { h: 'Meal-Prep light', p: 'Es muss nicht die ganze Woche sein. Koch einfach die doppelte Menge und friere die Hälfte ein – schon hast du ein gesundes Notfall-Essen.' },
      { h: 'Nutze deine Werkzeuge', p: 'Im Rezepte-Tab findest du ein Kochbuch mit fertigen Nährwerten, und FINN erstellt dir auf Wunsch einen Wochenplan samt Einkaufsliste.' },
    ],
    exercise: 'Koch diese Woche einmal die doppelte Portion und schreib vor dem nächsten Einkauf eine Liste.',
    habits: [
      { id: 'w5h1', text: '1× pro Woche vorkochen', cat: 'planung' },
      { id: 'w5h2', text: 'Mit Einkaufsliste einkaufen', cat: 'planung' },
    ],
  },
  {
    week: 6, title: 'Getränke & versteckte Kalorien', theme: 'Verhalten', minutes: 5,
    teaser: 'Was du trinkst und nebenbei snackst, entscheidet oft mehr als die Hauptmahlzeit.',
    body: [
      { h: 'Flüssige Kalorien', p: 'Saft, Softdrinks, Latte, Alkohol – die sättigen kaum, zählen aber voll mit. Ein Glas Saft kann so viel Zucker haben wie eine Handvoll Gummibärchen.' },
      { h: 'Die einfachste Stellschraube', p: 'Wasser, ungesüßter Tee, schwarzer Kaffee als Standard. Allein hier sparen viele mühelos 200–400 kcal am Tag.' },
      { h: 'Bewusst snacken', p: 'Snacks sind erlaubt – aber als Entscheidung, nicht aus Automatik. Portion auf einen Teller statt aus der Tüte, dann weißt du, was du isst.' },
    ],
    exercise: 'Ersetze heute jedes gesüßte Getränk durch Wasser oder Tee und portioniere deinen Snack auf einen Teller.',
    habits: [
      { id: 'w6h1', text: 'Zuckerfreie Getränke', cat: 'getraenke' },
      { id: 'w6h2', text: 'Snack bewusst portionieren', cat: 'achtsamkeit' },
    ],
  },
  {
    week: 7, title: 'Rückschläge einplanen', theme: 'Mindset', minutes: 5,
    teaser: 'Die 80/20-Regel: Ein „schlechter" Tag wirft dich nicht zurück – Aufgeben schon.',
    body: [
      { h: 'Perfektion ist der Feind', p: 'Niemand isst perfekt. Entscheidend ist der Durchschnitt über die Woche, nicht die einzelne Mahlzeit. 80 % solide, 20 % Genuss – das hält ein Leben lang.' },
      { h: 'Nach dem Ausrutscher', p: 'Ein Stück Kuchen macht dich nicht dick, so wie ein Salat dich nicht schlank macht. Wichtig ist nur: einfach normal weiteressen, nicht „ausgleichen" durch Hungern oder extra Sport.' },
      { h: 'Wieder einsteigen', p: 'Die nächste Mahlzeit ist immer eine neue Chance. Kein Drama, kein Neustart am Montag – einfach weiter.' },
    ],
    exercise: 'Denk an einen typischen „Ausrutscher" und plan konkret, wie du danach ganz normal weitermachst – ohne Kompensation.',
    habits: [
      { id: 'w7h1', text: 'Nach einem Ausrutscher normal weiter', cat: 'mindset' },
      { id: 'w7h2', text: 'Kurze Wochen-Reflexion', cat: 'mindset' },
    ],
  },
  {
    week: 8, title: 'Dranbleiben', theme: 'Nachhaltigkeit', minutes: 6,
    teaser: 'Aus Vorsätzen werden Gewohnheiten. Dein Plan für die Zeit nach dem Kurs.',
    body: [
      { h: 'Vom Vorsatz zur Routine', p: 'Du hast 8 Wochen lang Gewohnheiten geübt. Was sich schon selbstverständlich anfühlt, darf bleiben – der Rest kommt mit der Zeit. Du brauchst keine Diät, du hast jetzt ein System.' },
      { h: 'Deine Top 3', p: 'Welche 3 Gewohnheiten haben bei dir am meisten bewirkt? Halte sie fest – das sind deine Anker, wenn es mal stressig wird.' },
      { h: 'Wie es weitergeht', p: 'Setz dir ein neues, konkretes Ziel für die nächsten 8 Wochen. Und wenn du persönliche Begleitung möchtest: Das Stoffwechsel-Coaching im Studio geht mit dir den nächsten Schritt.' },
    ],
    exercise: 'Schreib deine 3 wirksamsten Gewohnheiten auf und formuliere ein konkretes Ziel für die nächsten 8 Wochen.',
    habits: [
      { id: 'w8h1', text: 'Deine 3 wirksamsten Gewohnheiten festhalten', cat: 'mindset' },
      { id: 'w8h2', text: 'Nächstes 8-Wochen-Ziel setzen', cat: 'planung' },
    ],
  },
];

// ── Ziel-spezifische Programme (Tracks) ──────────────────────────────────
// Jedes Ziel hat sein eigenes Lektions-Programm. Bis eigener Content vorliegt
// (S4/S5) teilen sich die Tracks das Basis-Programm; die Länge darf je Track
// variieren. „season" (Staffel) ist ein Anzeige-Label pro Lektion (Default „Kern").
const TRACKS = ['abnehmen', 'definieren', 'halten', 'aufbau', 'gesundheit', 'longevity'];
const CURRICULA = {
  abnehmen: CURRICULUM, definieren: CURRICULUM, halten: CURRICULUM,
  aufbau: CURRICULUM, gesundheit: CURRICULUM, longevity: CURRICULUM,
};
function lessonsFor(track) { return (track && CURRICULA[track]) ? CURRICULA[track] : CURRICULUM; }
function weeksFor(track) { return lessonsFor(track).length; }
// Gültiger Track eines States (Default „abnehmen"; robust bei Altdaten ohne track).
function trackOf(st) { return (st && st.track && CURRICULA[st.track]) ? st.track : 'abnehmen'; }
function validTrack(goal) { return (goal && CURRICULA[goal]) ? goal : 'abnehmen'; }

function lessonMeta(track, week) {
  const arr = lessonsFor(track);
  const l = arr[clampInt(week, 1, arr.length, 1) - 1];
  return { week: l.week, title: l.title, theme: l.theme, teaser: l.teaser, minutes: l.minutes, season: l.season || 'Kern' };
}
function fullLesson(track, week) {
  const arr = lessonsFor(track);
  const l = arr[clampInt(week, 1, arr.length, 1) - 1];
  return { week: l.week, title: l.title, theme: l.theme, teaser: l.teaser, minutes: l.minutes, season: l.season || 'Kern', body: l.body, exercise: l.exercise, habits: l.habits };
}
function habitsForWeek(track, week) {
  const arr = lessonsFor(track);
  const l = arr[clampInt(week, 1, arr.length, 1) - 1];
  return l.habits.map(function (h) { return { id: h.id, text: h.text, cat: h.cat, week: l.week, source: 'curriculum' }; });
}

// ── Wochen-/Unlock-Mathe (track-abhängige Länge) ──
// Zeit-Woche: 1 Woche je 7 Tage seit Start, 1..N (N = Länge des Tracks).
function timeWeek(st, today) {
  if (!st || !st.startDate) return 1;
  return clampInt(Math.floor(daysBetween(st.startDate, today) / 7) + 1, 1, weeksFor(trackOf(st)), 1);
}
function highestCompleted(st) {
  if (!st || !st.lessons) return 0;
  let hi = 0;
  Object.keys(st.lessons).forEach(function (k) { if (st.lessons[k] && st.lessons[k].completedAt) { const n = parseInt(k, 10); if (n > hi) hi = n; } });
  return hi;
}
// Frei ist alles bis zur Zeit-Woche ODER bis „letzte abgeschlossene + 1" (Early-Unlock).
function unlockedWeek(st, today) {
  if (!st || !st.enrolled) return 0;
  return clampInt(Math.max(timeWeek(st, today), highestCompleted(st) + 1), 1, weeksFor(trackOf(st)), 1);
}
function isWeekUnlocked(st, week, today) {
  const w = clampInt(week, 1, weeksFor(trackOf(st)), 0);
  return !!(st && st.enrolled) && w >= 1 && w <= unlockedWeek(st, today);
}

// ── Präferenzen säubern ──
function sanitizePrefs(raw) {
  raw = raw || {};
  const SCHEDULES = ['3-meals', '2-meals', 'shift'];
  const arr = function (a) {
    if (!Array.isArray(a)) return [];
    return a.map(function (x) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, 30); }).filter(Boolean).slice(0, 10);
  };
  return {
    cookMinutes: clampInt(raw.cookMinutes, 5, 120, 20),
    schedule: SCHEDULES.indexOf(String(raw.schedule)) >= 0 ? String(raw.schedule) : '3-meals',
    allergies: arr(raw.allergies),
    dislikes: arr(raw.dislikes),
  };
}

// ── State laden/speichern ──
async function getState(id) { return kvGetJson(COACHKEY(id)); }
async function saveState(id, st) { st.updatedAt = Date.now(); return kvSetJson(COACHKEY(id), st); }

// Einschreiben (idempotent: bestehendes Programm nicht zurücksetzen).
async function enroll(id, opts) {
  opts = opts || {};
  const today = berlinToday();
  let st = await getState(id);
  if (st && st.enrolled) {
    // Nur Präferenzen aktualisieren, Startdatum/Fortschritt bleiben.
    if (opts.prefs) { st.prefs = sanitizePrefs(opts.prefs); await saveState(id, st); }
    return st;
  }
  const now = Date.now();
  st = {
    enrolled: true,
    track: validTrack(opts.goal),     // Ziel-Programm beim Start fixiert
    startDate: today,                 // bewusst „heute": Client kann den Start nicht rückdatieren
    tz: 'Europe/Berlin',
    prefs: sanitizePrefs(opts.prefs),
    lessons: { '1': { unlockedAt: now, completedAt: null, personalized: null } },
    createdAt: now, updatedAt: now,
  };
  await saveState(id, st);
  return st;
}

// Track bei Altdaten (vor S2) nachtragen: aus dem Profil-Ziel ableiten, sonst abnehmen.
async function ensureTrack(id, st, goal) {
  if (!st || !st.enrolled) return st;
  if (st.track && CURRICULA[st.track]) return st;
  st.track = validTrack(goal);
  await saveState(id, st);
  return st;
}

// Lektion abschließen; schaltet die Folgewoche früh frei (Early-Unlock).
async function completeLesson(id, week) {
  const st = await getState(id);
  if (!st || !st.enrolled) return { ok: false, error: 'not_enrolled' };
  const track = trackOf(st);
  const today = berlinToday();
  const w = clampInt(week, 1, weeksFor(track), 0);
  if (!w || !isWeekUnlocked(st, w, today)) return { ok: false, error: 'locked' };
  st.lessons = st.lessons || {};
  st.lessons[String(w)] = st.lessons[String(w)] || { unlockedAt: Date.now(), completedAt: null, personalized: null };
  if (!st.lessons[String(w)].completedAt) st.lessons[String(w)].completedAt = Date.now();
  // Folgewoche vormerken (freigeschaltet wird real über unlockedWeek()).
  if (w < weeksFor(track)) {
    const nx = String(w + 1);
    st.lessons[nx] = st.lessons[nx] || { unlockedAt: Date.now(), completedAt: null, personalized: null };
  }
  await saveState(id, st);
  return { ok: true, state: st, assignHabits: habitsForWeek(track, w) };
}

// Öffentlicher Snapshot fürs Frontend (ohne interne Zeitstempel-Details).
function publicSnapshot(st, today) {
  today = today || berlinToday();
  if (!st || !st.enrolled) {
    return { enrolled: false, track: null, totalWeeks: weeksFor('abnehmen'), week: 0, unlockedWeek: 0, startDate: null, prefs: null, currentLesson: null, lessons: [] };
  }
  const track = trackOf(st);
  const total = weeksFor(track);
  const uw = unlockedWeek(st, today);
  const lessons = lessonsFor(track).map(function (l) {
    const s = st.lessons && st.lessons[String(l.week)];
    return { week: l.week, title: l.title, theme: l.theme, teaser: l.teaser, minutes: l.minutes, season: l.season || 'Kern', unlocked: l.week <= uw, completed: !!(s && s.completedAt) };
  });
  // „Aktuelle" Lektion = niedrigste freigeschaltete, noch nicht abgeschlossene (sonst die höchste freie).
  let cur = lessons.filter(function (l) { return l.unlocked && !l.completed; })[0] || lessons.filter(function (l) { return l.unlocked; }).slice(-1)[0] || lessons[0];
  return {
    enrolled: true, track: track, totalWeeks: total, week: timeWeek(st, today), unlockedWeek: uw,
    startDate: st.startDate, prefs: st.prefs || null,
    currentLesson: cur ? { week: cur.week, title: cur.title, teaser: cur.teaser, minutes: cur.minutes, season: cur.season, completed: cur.completed } : null,
    lessons: lessons,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Gewohnheiten (Etappe 2): tägliche Checkliste + abgeleitete Streak/Punkte.
//  Quelle der WELCHE-Gewohnheiten = Kurrikulum der aktiven Woche (self-healing);
//  gespeichert wird NUR der Erledigungs-Log (nutri:habits). Streak/Punkte werden
//  daraus abgeleitet (wie computeStreak/pointsToday in nutrition.js).
// ═══════════════════════════════════════════════════════════════════════
const POINTS_PER_HABIT = 10;
// Gültige Habit-IDs über ALLE Tracks (ein Mitglied hat nur einen Track; der Text
// kommt track-abhängig aus habitsForWeek, die Menge dient nur der Validierung).
const HABIT_ID_SET = {};
TRACKS.forEach(function (tr) { lessonsFor(tr).forEach(function (l) { (l.habits || []).forEach(function (h) { HABIT_ID_SET[h.id] = true; }); }); });
function isKnownHabit(hid) { return Object.prototype.hasOwnProperty.call(HABIT_ID_SET, String(hid)); }

// Aktive Woche = die „aktuelle" Lektion (erste freie, unerledigte, sonst höchste freie).
function activeWeek(st, today) {
  const snap = publicSnapshot(st, today || berlinToday());
  return (snap.currentLesson && snap.currentLesson.week) || Math.max(1, snap.unlockedWeek || 1);
}

async function getHabitRec(id) { return kvGetJson(HABITKEY(id)); }
async function saveHabitRec(id, rec) { rec.updatedAt = Date.now(); return kvSetJson(HABITKEY(id), rec); }

// Log auf die letzten ~60 Tage begrenzen (Wachstum deckeln).
function pruneLog(rec, today) {
  const min = addDays(today, -60);
  if (rec && rec.log) Object.keys(rec.log).forEach(function (k) { if (k < min) delete rec.log[k]; });
}

// Heutige Checkliste: Kurrikulums-Gewohnheiten der aktiven Woche + done-Flag.
function todayHabitList(st, rec, today) {
  today = today || berlinToday();
  const wk = activeWeek(st, today);
  const doneToday = (rec && rec.log && rec.log[today]) || [];
  return habitsForWeek(trackOf(st), wk).map(function (h) { return { id: h.id, text: h.text, cat: h.cat, week: h.week, done: doneToday.indexOf(h.id) >= 0 }; });
}

// Eine Gewohnheit für einen Tag an-/abhaken (idempotent pro (Tag,Gewohnheit)).
async function toggleHabit(id, habitId, date) {
  const hid = String(habitId || '');
  if (!isKnownHabit(hid)) return { ok: false, error: 'bad_habit' };
  const st = await getState(id);
  if (!st || !st.enrolled) return { ok: false, error: 'not_enrolled' };
  const today = berlinToday();
  const d = (isYMD(date) && String(date) <= today) ? String(date) : today;   // nie in der Zukunft
  const rec = (await getHabitRec(id)) || { log: {}, updatedAt: 0 };
  rec.log = rec.log || {};
  const arr = rec.log[d] || [];
  const i = arr.indexOf(hid);
  if (i >= 0) arr.splice(i, 1); else arr.push(hid);
  if (arr.length) rec.log[d] = arr; else delete rec.log[d];
  pruneLog(rec, today);
  await saveHabitRec(id, rec);
  return { ok: true, rec: rec };
}

// Streak: aufeinanderfolgende Tage mit ≥1 erledigten Gewohnheit (heute noch offen
// bricht nicht sofort ab -> ab gestern zählen).
function habitStreak(rec, today) {
  today = today || berlinToday();
  const log = (rec && rec.log) || {};
  let cursor = today;
  if (!(log[today] && log[today].length)) cursor = addDays(today, -1);
  let streak = 0;
  while (log[cursor] && log[cursor].length) { streak++; cursor = addDays(cursor, -1); }
  return streak;
}
function habitPoints(rec, today) {
  today = today || berlinToday();
  const arr = (rec && rec.log && rec.log[today]) || [];
  return arr.length * POINTS_PER_HABIT;
}

// ═══════════════════════════════════════════════════════════════════════
//  Tagesimpuls (Etappe 4): EIN kurzer Motivations-/Fokus-Text pro Tag.
//  Lazy erzeugt (beim GET) und pro Berlin-Datum gecacht -> max. 1 KI-Call/Tag.
//  KI nur für Premium; sonst statische Rotation. Der Cron pusht den gecachten Text.
// ═══════════════════════════════════════════════════════════════════════
const STATIC_IMPULSES = [
  'Kleiner Schritt heute: bleib bei deinen Gewohnheiten dran – Konstanz schlägt Perfektion.',
  'Denk an dein Warum. Eine gute Entscheidung nach der anderen bringt dich ans Ziel.',
  'Trink früh dein erstes Glas Wasser und starte bewusst in den Tag.',
  'Protokollier heute ehrlich – du kannst nur steuern, was du siehst.',
  'Plane deine nächste Mahlzeit, bevor der Hunger für dich entscheidet.',
  'Eiweiß zuerst: Das hält satt und macht den Tag leichter.',
  'Ein guter Tag muss nicht perfekt sein. Bleib einfach dran.',
];
function dayHash(ymd) { const s = String(ymd || ''); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function staticImpulse(st, today) {
  const wk = activeWeek(st, today);
  const idx = (dayHash(today) + wk) % STATIC_IMPULSES.length;
  return { text: STATIC_IMPULSES[idx], focusHabitId: null, source: 'static' };
}
async function getImpulse(id) { return kvGetJson(IMPULSEKEY(id)); }
async function saveImpulse(id, rec) { return kvSetJson(IMPULSEKEY(id), rec, 3 * 86400); }

// Heutigen Impuls sicherstellen (gecacht pro Tag). aiGen (optional) liefert
// {text,focusHabitId,source:'ai'} oder null -> dann statische Rotation.
async function ensureImpulse(id, st, today, aiGen) {
  today = today || berlinToday();
  let rec = await getImpulse(id);
  if (rec && rec.date === today) return rec;
  let built = null;
  if (typeof aiGen === 'function') { try { built = await aiGen(); } catch (e) { built = null; } }
  if (!built || !built.text) built = staticImpulse(st, today);
  rec = { date: today, text: String(built.text).slice(0, 400), focusHabitId: built.focusHabitId || null, source: built.source || 'static', pushedAt: null, ackedAt: null };
  await saveImpulse(id, rec);
  return rec;
}
async function ackImpulse(id, today) {
  today = today || berlinToday();
  const rec = await getImpulse(id);
  if (rec && rec.date === today && !rec.ackedAt) { rec.ackedAt = Date.now(); await saveImpulse(id, rec); }
  return rec;
}
async function markImpulsePushed(id, today) {
  today = today || berlinToday();
  const rec = await getImpulse(id);
  if (rec && rec.date === today) { rec.pushedAt = Date.now(); await saveImpulse(id, rec); }
  return rec;
}

// ═══════════════════════════════════════════════════════════════════════
//  Erfolgskontrolle (Etappe 5): geführter Check-in alle ~14 Tage.
//  Zahlen (Gewicht/Taille/Stimmung/Umsetzung) + optionale KI-Auswertung (Premium)
//  + Team-Einschleifung bei Auffälligkeiten. Alles serverseitig validiert/geklemmt.
// ═══════════════════════════════════════════════════════════════════════
const CHECKIN_MAX = 30;            // ~1 Jahr bei 14-Tage-Takt
const CHECKIN_INTERVAL_DAYS = 14;
function clampNum(v, lo, hi) { const n = Number(v); return isNaN(n) ? null : Math.max(lo, Math.min(hi, n)); }

async function getCheckins(id) { return kvGetJson(CHECKINKEY(id)); }
async function saveCheckins(id, rec) { rec.updatedAt = Date.now(); return kvSetJson(CHECKINKEY(id), rec); }

// Validierter, geklemmter Check-in-Eintrag (Gewicht ist Pflicht). -> Entry | null.
function buildCheckinEntry(data, today) {
  data = data || {};
  const weight = clampNum(data.weight, 35, 250);
  if (weight == null) return null;
  const waist = (data.waist === '' || data.waist == null) ? null : clampNum(data.waist, 40, 200);
  return {
    at: Date.now(), date: today,
    weight: Math.round(weight * 10) / 10,
    waist: waist != null ? Math.round(waist * 10) / 10 : null,
    mood: clampInt(data.mood, 1, 5, 3),
    adherence: clampInt(data.adherence, 0, 100, 50),
    note: String(data.note == null ? '' : data.note).replace(/\s+/g, ' ').trim().slice(0, 300),
    help: !!data.help,
    review: null, teamVorgangId: null,
  };
}

// Eintrag ablegen (max. 1/Tag: gleicher Tag ersetzt), nextDue = +14 Tage. -> { rec, entry }.
function appendCheckin(rec, entry, today) {
  rec = rec || { list: [], nextDue: null, updatedAt: 0 };
  rec.list = Array.isArray(rec.list) ? rec.list : [];
  const iToday = rec.list.map(function (e) { return e.date; }).indexOf(today);
  if (iToday >= 0) rec.list[iToday] = entry; else rec.list.push(entry);
  if (rec.list.length > CHECKIN_MAX) rec.list = rec.list.slice(-CHECKIN_MAX);
  rec.nextDue = addDays(today, CHECKIN_INTERVAL_DAYS);
  return { rec: rec, entry: entry };
}

function checkinHistory(rec) {
  const list = (rec && Array.isArray(rec.list)) ? rec.list : [];
  return list.map(function (e) { return { date: e.date, weight: e.weight, waist: e.waist, mood: e.mood, adherence: e.adherence }; });
}

function nextCheckinInfo(rec, today) {
  today = today || berlinToday();
  const list = (rec && Array.isArray(rec.list)) ? rec.list : [];
  if (!list.length) return { dueDate: today, overdue: true, first: true, count: 0, lastWeight: null };
  const due = (rec && rec.nextDue) || today;
  const last = list[list.length - 1];
  return { dueDate: due, overdue: String(due) <= today, first: false, count: list.length, lastDate: last.date, lastWeight: last.weight };
}

// Team einschleifen? Bei Hilfe-Wunsch, schwacher Umsetzung, gedrückter Stimmung
// oder Gewichtstrend gegen das Ziel über zwei Check-ins. -> { loop, reason }.
function shouldLoopTeam(rec, goal) {
  const list = (rec && Array.isArray(rec.list)) ? rec.list : [];
  const last = list[list.length - 1];
  if (!last) return { loop: false };
  if (last.help) return { loop: true, reason: 'Mitglied bittet um Unterstützung' };
  if (Number(last.adherence) < 50) return { loop: true, reason: 'Umsetzung unter 50 %' };
  if (Number(last.mood) <= 2) return { loop: true, reason: 'gedrückte Stimmung' };
  if (list.length >= 2) {
    const prev = list[list.length - 2];
    const dw = Number(last.weight) - Number(prev.weight);
    if ((goal === 'abnehmen' || goal === 'definieren') && dw > 0.5) return { loop: true, reason: 'Gewicht steigt trotz Abnehm-/Definier-Ziel' };
    if (goal === 'aufbau' && dw < -0.5) return { loop: true, reason: 'Gewicht sinkt trotz Aufbau-Ziel' };
  }
  return { loop: false };
}

// ── DSGVO: Export & vollständige Löschung (von nutrition.js aufgerufen) ──
async function exportState(id) {
  const [coach, habits, checkins, impulse, chat] = await Promise.all([
    kvGetJson(COACHKEY(id)), kvGetJson(HABITKEY(id)), kvGetJson(CHECKINKEY(id)), kvGetJson(IMPULSEKEY(id)), kvGetJson(CHATKEY(id)),
  ]);
  const out = {};
  if (coach) out.program = coach;
  if (habits) out.habits = habits;
  if (checkins) out.checkins = checkins;
  if (impulse) out.impulse = impulse;
  if (chat) out.chat = chat;
  return Object.keys(out).length ? out : null;
}
function deleteKeys(id) {
  return [COACHKEY(id), HABITKEY(id), IMPULSEKEY(id), CHECKINKEY(id), CHATKEY(id)];
}

module.exports = {
  TOTAL_WEEKS, COACH_TTL,
  COACHKEY, HABITKEY, IMPULSEKEY, CHECKINKEY, CHATKEY,
  CURRICULUM, CURRICULA, TRACKS, lessonsFor, weeksFor, trackOf, validTrack, ensureTrack,
  lessonMeta, fullLesson, habitsForWeek,
  berlinToday, daysBetween, addDays, isYMD, clampInt,
  timeWeek, highestCompleted, unlockedWeek, isWeekUnlocked, sanitizePrefs,
  getState, saveState, enroll, completeLesson, publicSnapshot,
  isKnownHabit, activeWeek, getHabitRec, saveHabitRec, todayHabitList, toggleHabit, habitStreak, habitPoints, POINTS_PER_HABIT,
  staticImpulse, getImpulse, saveImpulse, ensureImpulse, ackImpulse, markImpulsePushed,
  getCheckins, saveCheckins, buildCheckinEntry, appendCheckin, checkinHistory, nextCheckinInfo, shouldLoopTeam, CHECKIN_INTERVAL_DAYS,
  exportState, deleteKeys,
  kvGetJson, kvSetJson,
};
