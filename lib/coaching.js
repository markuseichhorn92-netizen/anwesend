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

function lessonMeta(week) {
  const l = CURRICULUM[clampInt(week, 1, TOTAL_WEEKS, 1) - 1];
  return { week: l.week, title: l.title, theme: l.theme, teaser: l.teaser, minutes: l.minutes };
}
function fullLesson(week) {
  const w = clampInt(week, 1, TOTAL_WEEKS, 1);
  const l = CURRICULUM[w - 1];
  return { week: l.week, title: l.title, theme: l.theme, teaser: l.teaser, minutes: l.minutes, body: l.body, exercise: l.exercise, habits: l.habits };
}
function habitsForWeek(week) {
  const l = CURRICULUM[clampInt(week, 1, TOTAL_WEEKS, 1) - 1];
  return l.habits.map(function (h) { return { id: h.id, text: h.text, cat: h.cat, week: l.week, source: 'curriculum' }; });
}

// ── Wochen-/Unlock-Mathe ──
// Zeit-Woche: 1 Woche je 7 Tage seit Start, 1..8.
function timeWeek(st, today) {
  if (!st || !st.startDate) return 1;
  return clampInt(Math.floor(daysBetween(st.startDate, today) / 7) + 1, 1, TOTAL_WEEKS, 1);
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
  return clampInt(Math.max(timeWeek(st, today), highestCompleted(st) + 1), 1, TOTAL_WEEKS, 1);
}
function isWeekUnlocked(st, week, today) {
  const w = clampInt(week, 1, TOTAL_WEEKS, 0);
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
    startDate: today,                 // bewusst „heute": Client kann den Start nicht rückdatieren
    tz: 'Europe/Berlin',
    prefs: sanitizePrefs(opts.prefs),
    lessons: { '1': { unlockedAt: now, completedAt: null, personalized: null } },
    createdAt: now, updatedAt: now,
  };
  await saveState(id, st);
  return st;
}

// Lektion abschließen; schaltet die Folgewoche früh frei (Early-Unlock).
async function completeLesson(id, week) {
  const st = await getState(id);
  if (!st || !st.enrolled) return { ok: false, error: 'not_enrolled' };
  const today = berlinToday();
  const w = clampInt(week, 1, TOTAL_WEEKS, 0);
  if (!w || !isWeekUnlocked(st, w, today)) return { ok: false, error: 'locked' };
  st.lessons = st.lessons || {};
  st.lessons[String(w)] = st.lessons[String(w)] || { unlockedAt: Date.now(), completedAt: null, personalized: null };
  if (!st.lessons[String(w)].completedAt) st.lessons[String(w)].completedAt = Date.now();
  // Folgewoche vormerken (freigeschaltet wird real über unlockedWeek()).
  if (w < TOTAL_WEEKS) {
    const nx = String(w + 1);
    st.lessons[nx] = st.lessons[nx] || { unlockedAt: Date.now(), completedAt: null, personalized: null };
  }
  await saveState(id, st);
  return { ok: true, state: st, assignHabits: habitsForWeek(w) };
}

// Öffentlicher Snapshot fürs Frontend (ohne interne Zeitstempel-Details).
function publicSnapshot(st, today) {
  today = today || berlinToday();
  if (!st || !st.enrolled) {
    return { enrolled: false, totalWeeks: TOTAL_WEEKS, week: 0, unlockedWeek: 0, startDate: null, prefs: null, currentLesson: null, lessons: [] };
  }
  const uw = unlockedWeek(st, today);
  const lessons = CURRICULUM.map(function (l) {
    const s = st.lessons && st.lessons[String(l.week)];
    return { week: l.week, title: l.title, theme: l.theme, teaser: l.teaser, minutes: l.minutes, unlocked: l.week <= uw, completed: !!(s && s.completedAt) };
  });
  // „Aktuelle" Lektion = niedrigste freigeschaltete, noch nicht abgeschlossene (sonst die höchste freie).
  let cur = lessons.filter(function (l) { return l.unlocked && !l.completed; })[0] || lessons.filter(function (l) { return l.unlocked; }).slice(-1)[0] || lessons[0];
  return {
    enrolled: true, totalWeeks: TOTAL_WEEKS, week: timeWeek(st, today), unlockedWeek: uw,
    startDate: st.startDate, prefs: st.prefs || null,
    currentLesson: cur ? { week: cur.week, title: cur.title, teaser: cur.teaser, minutes: cur.minutes, completed: cur.completed } : null,
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
const HABIT_BY_ID = {};
CURRICULUM.forEach(function (l) { l.habits.forEach(function (h) { HABIT_BY_ID[h.id] = { id: h.id, text: h.text, cat: h.cat, week: l.week }; }); });
function isKnownHabit(hid) { return Object.prototype.hasOwnProperty.call(HABIT_BY_ID, String(hid)); }

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
  return habitsForWeek(wk).map(function (h) { return { id: h.id, text: h.text, cat: h.cat, week: h.week, done: doneToday.indexOf(h.id) >= 0 }; });
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
  CURRICULUM, lessonMeta, fullLesson, habitsForWeek,
  berlinToday, daysBetween, addDays, isYMD, clampInt,
  timeWeek, highestCompleted, unlockedWeek, isWeekUnlocked, sanitizePrefs,
  getState, saveState, enroll, completeLesson, publicSnapshot,
  isKnownHabit, activeWeek, getHabitRec, saveHabitRec, todayHabitList, toggleHabit, habitStreak, habitPoints, POINTS_PER_HABIT,
  exportState, deleteKeys,
  kvGetJson, kvSetJson,
};
