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
 * bewusst ausgeschlossen (Kündigung nur über die Magicline-Modul-Kündigung).
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
    week: 1, title: 'Ankommen & Ziel schärfen', theme: 'Grundlagen', minutes: 10,
    teaser: 'Wie Energiebilanz wirklich funktioniert – und ein realistisches Tempo für dein Ziel.',
    pages: [
      { icon: '👋', title: 'Willkommen in deinem Coaching', paras: [
        'Schön, dass du da bist. In den nächsten Wochen bauen wir Schritt für Schritt echtes Ernährungswissen und alltagstaugliche Gewohnheiten auf – ohne Verbote, ohne Crash-Diät.',
        'Jede Woche gibt es eine Lektion wie diese, ein paar konkrete Gewohnheiten und am Ende einen kleinen Wissens-Check. Du gehst dein Tempo, dein Coach FINN begleitet dich.',
        'Diese erste Einheit legt das Fundament: wie dein Ziel wirklich funktioniert – und warum dein Stoffwechsel dabei die Hauptrolle spielt.',
      ] },
      { icon: '⚖️', title: 'Die eine Wahrheit: Energiebilanz', paras: [
        'Ob du ab-, zu- oder gleich viel wiegst, entscheidet die Energiebilanz: die Energie, die du über Essen und Trinken aufnimmst, gegen die Energie, die dein Körper verbraucht.',
        'Mehr rein als raus → du nimmst zu. Weniger rein als raus → du nimmst ab. So einfach das klingt, so oft wird es von Diät-Mythen übertönt.',
        'Wichtig: Kein Lebensmittel ist „verboten". Auch Schokolade oder Pizza haben Platz – es kommt auf die Gesamtmenge über die Woche an, nicht auf die einzelne Mahlzeit.',
      ], note: 'Merke: Es gibt keine „Dickmacher" und keine „Fatburner" – nur die Bilanz über die Zeit.' },
      { kind: 'metabolism', icon: '🧬', title: 'Dein Stoffwechsel – der Motor dahinter', paras: [
        'Die „raus"-Seite ist dein Stoffwechsel: alles, was dein Körper an Energie verbraucht. Der größte Teil ist der Grundumsatz – Energie für Herz, Atmung, Gehirn und Zellen, selbst wenn du nur auf dem Sofa liegst.',
        'Dazu kommt der Leistungsumsatz: Training, vor allem aber Alltagsbewegung (Treppen, Gehen, Zappeln). Und ein kleiner Teil geht allein für die Verdauung drauf.',
        'Dein Grundumsatz hängt von Größe, Gewicht, Alter und vor allem der Muskelmasse ab. Genau daraus berechnet die App dein Tagesziel. Wie hoch dein Stoffwechsel wirklich ist, lässt sich im Studio sogar messen.',
      ], cta: 'Stoffwechsel messen lassen' },
      { icon: '🐢', title: 'Ein realistisches Tempo', paras: [
        'Gesund und haltbar sind etwa 0,3 bis 0,7 kg pro Woche. Das klingt langsam – ist aber genau das Tempo, bei dem du Muskeln schützt und nicht in die Jojo-Falle läufst.',
        'Wer zu schnell abnimmt, verliert viel Wasser und Muskeln statt Fett. Und Muskeln sind wertvoll: Sie halten deinen Grundumsatz oben.',
        'Wir spielen hier das lange Spiel. Lieber ein halbes Kilo pro Woche, das bleibt, als zwei Kilo, die in einem Monat wieder drauf sind.',
      ] },
      { icon: '⛔', title: 'Warum Crash-Diäten scheitern', paras: [
        'Isst du sehr lange sehr wenig, fährt dein Körper den Verbrauch herunter – er spart Energie, weil er „Mangel" vermutet. Fachleute nennen das adaptive Thermogenese.',
        'Gleichzeitig steigt der Hunger. Das Ergebnis: Die Waage steht, die Laune sinkt, und irgendwann kippt die Diät. Nicht, weil du zu schwach bist – sondern weil die Strategie falsch war.',
        'Deshalb arbeiten wir mit moderaten Schritten und genug Eiweiß. So bleibt dein Stoffwechsel aktiv, statt in den Sparmodus zu schalten.',
      ] },
      { icon: '📓', title: 'Dein wichtigstes Werkzeug', paras: [
        'Protokollieren. Wer eine Woche lang ehrlich mitschreibt, sieht sofort die 2–3 Stellschrauben, die den Unterschied machen – der Schluck Saft hier, die Handvoll Nüsse da.',
        'Es geht nicht um Perfektion oder ums Zählen für die Ewigkeit, sondern darum, sichtbar zu machen, was sonst „nebenbei" passiert.',
        'Genau dafür ist dein Ernährungs-Tab da: Foto, Sprache oder schnelle Eingabe – such dir aus, was am leichtesten geht.',
      ] },
      { icon: '🚀', title: 'So startest du diese Woche', paras: [
        'Diese Woche änderst du noch nichts an deiner Ernährung. Du beobachtest nur – ehrlich und vollständig.',
        'Trag jede Mahlzeit ein, trink morgens ein Glas Wasser und schau dir einmal am Tag bewusst dein Tagesziel an. Mehr nicht.',
        'Am Ende der Woche hast du deine persönliche Landkarte – und wir wissen gemeinsam, wo wir ansetzen.',
      ] },
    ],
    quiz: [
      { q: 'Was entscheidet am Ende, ob du ab- oder zunimmst?', options: ['Die Uhrzeit deiner Mahlzeiten', 'Die Energiebilanz über die Zeit', 'Ob du abends Kohlenhydrate isst'], answer: 1, explain: 'Entscheidend ist die Bilanz aus aufgenommener und verbrauchter Energie – nicht einzelne Lebensmittel oder Uhrzeiten.' },
      { q: 'Was ist der Grundumsatz?', options: ['Die Energie beim Sport', 'Die Energie, die dein Körper in Ruhe verbraucht', 'Die Kalorien deiner größten Mahlzeit'], answer: 1, explain: 'Der Grundumsatz ist die Energie für lebenswichtige Funktionen in Ruhe – der größte Teil deines Verbrauchs.' },
      { q: 'Warum sind Crash-Diäten meist keine gute Idee?', options: ['Der Körper spart Energie und der Hunger steigt', 'Man verliert ausschließlich Fett', 'Sie kurbeln den Stoffwechsel dauerhaft an'], answer: 0, explain: 'Bei starker Restriktion fährt der Körper den Verbrauch herunter (adaptive Thermogenese) und der Hunger steigt – das Jojo ist vorprogrammiert.' },
    ],
    sources: [
      'Deutsche Gesellschaft für Ernährung (DGE): Referenzwerte für die Nährstoffzufuhr',
      'WHO – Healthy diet (Fact Sheet)',
      'Mifflin MD, St Jeor ST et al. (1990): Formel zur Grundumsatz-Schätzung (Basis der App-Berechnung)',
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
    pages: [
      { icon: '🍗', title: 'Der Sattmacher', paras: ['Eiweiß hält am längsten satt und schützt beim Abnehmen deine Muskeln. Beim Aufbau ist es der Baustoff schlechthin. Kurz: Eiweiß ist dein bester Freund.', 'Wer genug Eiweiß isst, hat weniger Heißhunger und kommt mit derselben Kalorienmenge besser durch den Tag.'] },
      { icon: '📊', title: 'Wie viel brauchst du?', paras: ['Grob 1,6–1,8 g pro kg Körpergewicht. Dein Tagesziel im Tab rechnet das schon für dich aus – dein Job ist nur, es zu treffen.', 'Verteil es über den Tag: zu jeder Hauptmahlzeit eine ordentliche Portion, statt alles abends auf einmal.'] },
      { icon: '🥚', title: 'Einfache Quellen', paras: ['Quark, Skyr, Hähnchen, Eier, Fisch, Linsen, Tofu, Magerkäse. Eine gute Faustregel: zu jeder Hauptmahlzeit eine Handfläche Eiweiß.', 'Auch pflanzlich geht viel: Hülsenfrüchte, Tofu, Sojajoghurt oder Haferflocken mit Skyr.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Eiweiß heizt den Stoffwechsel an', paras: ['Eiweiß hat einen Trick: Rund 20–30 % seiner Energie verbraucht dein Körper schon bei der Verdauung – deutlich mehr als bei Fett oder Kohlenhydraten. Diesen thermischen Effekt kannst du dir zunutze machen.', 'Noch wichtiger: Genug Eiweiß schützt beim Abnehmen deine Muskeln – und Muskeln sind der größte Hebel für einen hohen Grundumsatz.', 'Kurz: Eiweiß macht satt, erhält Muskeln und hält den Stoffwechsel oben – ein echter Dreifach-Gewinn.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum ist Eiweiß beim Abnehmen so wichtig?', options: ['Es hat keine Kalorien', 'Es macht satt und schützt die Muskeln', 'Es verbrennt Fett direkt'], answer: 1, explain: 'Eiweiß sättigt stark und schützt beim Abnehmen die Muskulatur – so bleibt der Grundumsatz hoch.' },
      { q: 'Wie viel Eiweiß ist grob sinnvoll?', options: ['0,2 g pro kg Körpergewicht', 'Etwa 1,6–1,8 g pro kg Körpergewicht', 'So viel wie möglich – je mehr desto besser'], answer: 1, explain: 'Rund 1,6–1,8 g pro kg Körpergewicht sind ein guter Richtwert – die App rechnet dein Ziel aus.' },
    ],
    sources: [
      'International Society of Sports Nutrition (ISSN): Position Stand – Protein and Exercise (Jäger et al., 2017)',
      'Deutsche Gesellschaft für Ernährung (DGE): Referenzwerte Protein',
      'Übersichtsarbeiten zum thermischen Effekt der Nahrung (TEF) von Eiweiß',
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
    pages: [
      { icon: '🤔', title: 'Hunger oder nur Appetit?', paras: ['Echter Hunger kommt langsam und lässt sich mit fast allem stillen. Appetit ist plötzlich und will etwas Bestimmtes.', 'Kurz innehalten und fragen „Habe ich wirklich Hunger?" spart oft ein paar hundert Kalorien – ganz ohne Verzicht.'] },
      { icon: '⏱️', title: 'Das Sättigungssignal', paras: ['Dein Gehirn merkt „satt" erst nach etwa 15 Minuten. Wer langsamer isst, isst automatisch weniger – ohne zu hungern.', 'Kleine Tricks: Gabel zwischendurch ablegen, gründlich kauen, das erste Glas Wasser vor dem Essen.'] },
      { icon: '📵', title: 'Nebenbei-Essen', paras: ['Vor dem Bildschirm essen wir mehr und schmecken weniger. Eine Mahlzeit am Tag ganz bewusst – das reicht als Anfang.', 'Setz dich hin, richte an, und iss ohne Handy. Du wirst überrascht sein, wie viel satter dich dieselbe Portion macht.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Deine Hunger-Hormone', paras: ['Hunger und Sättigung steuern Hormone: Ghrelin meldet „Hunger", Leptin meldet „satt". Schlafmangel und Crash-Diäten bringen diese Signale durcheinander – du hast dann mehr Hunger, obwohl du genug hättest.', 'Auch der Blutzucker spielt mit: Schnelle Zuckerspitzen (z. B. aus Süßem auf leeren Magen) fallen rasch ab und lösen neuen Heißhunger aus.', 'Bewusst und eiweißreich zu essen hält diese Signale stabil – und macht das Abnehmen leichter, statt dagegen anzukämpfen.'], cta: 'Stoffwechsel & Hormone besprechen' },
    ],
    quiz: [
      { q: 'Woran erkennst du eher echten Hunger?', options: ['Er kommt plötzlich und will etwas Bestimmtes', 'Er kommt langsam und lässt sich mit vielem stillen', 'Er tritt nur abends auf'], answer: 1, explain: 'Echter Hunger baut sich langsam auf und ist mit fast jedem Essen stillbar – Appetit ist plötzlich und spezifisch.' },
      { q: 'Warum hilft langsames Essen?', options: ['Das Sättigungssignal braucht ~15 Minuten', 'Der Stoffwechsel verdoppelt sich', 'Kalorien zählen dann nicht mehr'], answer: 0, explain: 'Das Sättigungsgefühl kommt zeitverzögert – wer langsamer isst, merkt rechtzeitig, dass er satt ist.' },
    ],
    sources: [
      'Übersichtsarbeiten zur Appetitregulation durch Leptin und Ghrelin (z. B. Klok et al., 2007)',
      'Studien zu Essgeschwindigkeit und Sättigung',
      'Deutsche Gesellschaft für Ernährung (DGE): Ernährungsverhalten',
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
    pages: [
      { icon: '⚡', title: 'Energie für dein Training', paras: ['Kohlenhydrate sind der schnellste Treibstoff. An Trainingstagen darfst du bewusst mehr davon essen – dein Körper nutzt sie direkt für Leistung und Regeneration.', 'Kohlenhydrate sind kein Feind. Sie füllen deine Muskelspeicher (Glykogen) und lassen dich im Training stärker sein.'] },
      { icon: '🌾', title: 'Qualität schlägt Verzicht', paras: ['Vollkorn, Kartoffeln, Haferflocken, Obst und Hülsenfrüchte halten länger satt als Weißmehl und Zucker. Du musst nichts streichen, nur öfter die bessere Variante wählen.', 'Ballaststoffe aus diesen Quellen füttern nebenbei deine Darmbakterien und stabilisieren den Blutzucker.'] },
      { icon: '🕒', title: 'Kluges Timing', paras: ['Rund um dein Workout sind Kohlenhydrate am sinnvollsten. An ruhigen Tagen etwas weniger – so bleibt deine Bilanz im Ziel.', 'Das passt gut zur Studio-Karte „Trainingstag = mehr Spielraum": An Tagen, an denen du trainierst, darf der Teller voller sein.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Kohlenhydrate, Schilddrüse & Anpassung', paras: ['Isst du dauerhaft sehr wenig Kohlenhydrate und sehr wenig gesamt, kann der Körper Stoffwechsel-Hormone herunterfahren – u. a. aus der Schilddrüse und das Sättigungshormon Leptin. Die Fettverbrennung wird träger.', 'Ein bewusster kohlenhydratreicher Tag (rund ums Training) kann diese Signale wieder anheben – man nennt das auch „Refeed".', 'Für die meisten gilt: Kohlenhydrate in vernünftiger Menge halten Energie, Training und Stoffwechsel oben. Extrem-Low-Carb ist selten nötig.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wann sind Kohlenhydrate besonders sinnvoll?', options: ['Nie – sie machen dick', 'Rund um dein Training', 'Nur nach 18 Uhr'], answer: 1, explain: 'Rund ums Workout nutzt dein Körper Kohlenhydrate direkt für Leistung und Regeneration.' },
      { q: 'Was kann dauerhaftes Extrem-Low-Carb bewirken?', options: ['Der Stoffwechsel kann träger werden', 'Man baut automatisch Muskeln auf', 'Der Grundumsatz steigt dauerhaft'], answer: 0, explain: 'Sehr niedrige Zufuhr über lange Zeit kann Stoffwechsel-Hormone senken – die Fettverbrennung wird träger.' },
    ],
    sources: [
      'WHO – Guideline: Sugars intake for adults and children (2015)',
      'Deutsche Gesellschaft für Ernährung (DGE): Kohlenhydrate und Ballaststoffe',
      'Literatur zu Glykogen, Trainingsleistung und metabolischer Anpassung',
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
    pages: [
      { icon: '🧠', title: 'Entscheide vorher', paras: ['Die meisten Ausrutscher passieren spontan bei Hunger. Wer vorkocht und eine Einkaufsliste hat, entscheidet einmal in Ruhe statt zehnmal unter Druck.', 'Deine Umgebung schlägt deine Willenskraft: Was griffbereit ist, wird gegessen. Mach die gute Wahl zur einfachen Wahl.'] },
      { icon: '🍲', title: 'Meal-Prep light', paras: ['Es muss nicht die ganze Woche sein. Koch einfach die doppelte Menge und friere die Hälfte ein – schon hast du ein gesundes Notfall-Essen.', 'Ein paar Basics vorbereiten (Reis, Hähnchen, Gemüse) reicht, um in 5 Minuten eine gute Mahlzeit zusammenzustellen.'] },
      { icon: '🛒', title: 'Nutze deine Werkzeuge', paras: ['Im Rezepte-Tab findest du ein Kochbuch mit fertigen Nährwerten, und FINN erstellt dir auf Wunsch einen Wochenplan samt Einkaufsliste.', 'Mit Liste einkaufen heißt: weniger Spontankäufe, weniger Zucker im Wagen, mehr Plan auf dem Teller.'] },
      { kind: 'metabolism', icon: '🧬', title: 'NEAT – dein heimlicher Kalorienfresser', paras: ['Der größte veränderbare Teil deines Verbrauchs ist oft nicht das Training, sondern die Alltagsbewegung: Gehen, Stehen, Treppen, Hausarbeit, sogar Zappeln. Fachleute nennen das NEAT.', 'NEAT kann mehrere hundert Kalorien am Tag ausmachen – und sinkt heimlich, wenn man in einer Diät müde und träge wird.', 'Bewusst mehr Alltagsbewegung (ein paar tausend Schritte extra) ist einer der stärksten und angenehmsten Hebel für deinen Stoffwechsel.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum hilft Vorkochen beim Dranbleiben?', options: ['Vorgekochtes hat weniger Kalorien', 'Du entscheidest einmal in Ruhe statt oft unter Hunger', 'Man muss dann nichts mehr protokollieren'], answer: 1, explain: 'Wer vorbereitet, trifft die gute Wahl einmal in Ruhe – statt zehnmal spontan bei Hunger.' },
      { q: 'Was ist NEAT?', options: ['Eine Diätform', 'Alltagsbewegung außerhalb von Sport', 'Ein Nahrungsergänzungsmittel'], answer: 1, explain: 'NEAT ist die Alltagsbewegung (Gehen, Stehen, Treppen) – ein großer, unterschätzter Teil deines Verbrauchs.' },
    ],
    sources: [
      'Levine JA (Mayo Clinic): Non-Exercise Activity Thermogenesis (NEAT)',
      'Forschung zu Ernährungsumgebung und Essverhalten',
      'Deutsche Gesellschaft für Ernährung (DGE): Vollwertige Ernährung im Alltag',
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
    pages: [
      { icon: '🥤', title: 'Flüssige Kalorien', paras: ['Saft, Softdrinks, Latte, Alkohol – die sättigen kaum, zählen aber voll mit. Ein Glas Saft kann so viel Zucker haben wie eine Handvoll Gummibärchen.', 'Das Tückische: Getränke lösen kaum ein Sättigungsgefühl aus. Die Kalorien kommen „on top", ohne dass du weniger isst.'] },
      { icon: '💧', title: 'Die einfachste Stellschraube', paras: ['Wasser, ungesüßter Tee, schwarzer Kaffee als Standard. Allein hier sparen viele mühelos 200–400 kcal am Tag.', 'Kleiner Bonus: Ausreichend Wasser hilft dir, Hunger und Durst besser auseinanderzuhalten.'] },
      { icon: '🍫', title: 'Bewusst snacken', paras: ['Snacks sind erlaubt – aber als Entscheidung, nicht aus Automatik. Portion auf einen Teller statt aus der Tüte, dann weißt du, was du isst.', 'Ein bewusster Genuss-Snack schlägt zehn nebenbei vernichtete Kekse, an die du dich abends gar nicht mehr erinnerst.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Alkohol bremst die Fettverbrennung', paras: ['Alkohol liefert fast so viel Energie wie Fett (7 kcal pro Gramm) – aber ohne Nährwert. Und dein Körper baut Alkohol immer zuerst ab.', 'Solange er damit beschäftigt ist, pausiert die Fettverbrennung. Genau deshalb bremsen regelmäßige „Feierabend-Bierchen" den Fortschritt oft mehr als gedacht.', 'Wasser dagegen ist neutral, und der Körper wendet sogar ein wenig Energie auf, um es auf Körpertemperatur zu bringen – ein netter, kleiner Nebeneffekt.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum sind flüssige Kalorien so tückisch?', options: ['Sie sättigen kaum, zählen aber voll mit', 'Sie haben gar keine Kalorien', 'Der Körper speichert sie nicht'], answer: 0, explain: 'Getränke lösen kaum Sättigung aus – die Kalorien kommen zusätzlich, ohne dass du weniger isst.' },
      { q: 'Was macht dein Körper, wenn du Alkohol trinkst?', options: ['Er baut ihn zuerst ab und pausiert die Fettverbrennung', 'Er verbrennt dadurch mehr Fett', 'Er ignoriert die Kalorien'], answer: 0, explain: 'Alkohol wird bevorzugt abgebaut – solange pausiert die Fettverbrennung.' },
    ],
    sources: [
      'Suter PM et al. (1992): Alkohol und Fettoxidation',
      'WHO – Alkohol und Gesundheit',
      'WHO – Guideline: Sugars intake (2015), u. a. zu zuckerhaltigen Getränken',
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
    pages: [
      { icon: '🎯', title: 'Perfektion ist der Feind', paras: ['Niemand isst perfekt. Entscheidend ist der Durchschnitt über die Woche, nicht die einzelne Mahlzeit. 80 % solide, 20 % Genuss – das hält ein Leben lang.', 'Diäten scheitern selten am Wissen, sondern am „Alles-oder-nichts"-Denken. Ein Ausrutscher ist kein Scheitern, sondern normal.'] },
      { icon: '🍰', title: 'Nach dem Ausrutscher', paras: ['Ein Stück Kuchen macht dich nicht dick, so wie ein Salat dich nicht schlank macht. Wichtig ist nur: einfach normal weiteressen.', 'Bitte NICHT „ausgleichen" durch Hungern oder extra Sport – das führt oft in einen ungesunden Kreislauf aus Verzicht und Heißhunger.'] },
      { icon: '🔁', title: 'Wieder einsteigen', paras: ['Die nächste Mahlzeit ist immer eine neue Chance. Kein Drama, kein Neustart am Montag – einfach weiter.', 'Frag dich freundlich: Was war der Auslöser? Und was ist mein nächster kleiner, normaler Schritt?'] },
      { kind: 'metabolism', icon: '🧬', title: 'Der Mythos „Hungerstoffwechsel"', paras: ['Ein einzelner Genuss-Tag ruiniert nichts – im Gegenteil, dein Stoffwechsel ist robuster, als viele denken. Ein paar hundert Kalorien mehr an einem Tag verschwinden im Wochendurchschnitt.', 'Gefährlicher ist das andere Extrem: sehr lange, sehr streng essen. DAS drosselt den Stoffwechsel (adaptive Thermogenese) und macht Heißhunger fast unvermeidlich.', 'Genussvolle, entspannte Tage sind also kein Feind deines Stoffwechsels – dauerhaftes Hungern schon.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist beim Abnehmen entscheidend?', options: ['Jede einzelne Mahlzeit muss perfekt sein', 'Der Durchschnitt über die Woche', 'Man darf nie etwas Süßes essen'], answer: 1, explain: 'Der Wochendurchschnitt zählt – 80 % solide, 20 % Genuss ist alltagstauglich und haltbar.' },
      { q: 'Was solltest du nach einem Ausrutscher tun?', options: ['Am nächsten Tag hungern zum Ausgleich', 'Einfach normal weiteressen', 'Die Diät komplett abbrechen'], answer: 1, explain: 'Kein Kompensieren durch Hungern – einfach normal weiter. Das verhindert den Verzicht-Heißhunger-Kreislauf.' },
    ],
    sources: [
      'Rosenbaum M, Leibel RL: Adaptive Thermogenese bei Gewichtsabnahme',
      'Literatur zu flexibler vs. rigider Kontrolle des Essverhaltens',
      'Deutsche Gesellschaft für Ernährung (DGE): Gewichtsmanagement',
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
    pages: [
      { icon: '🔁', title: 'Vom Vorsatz zur Routine', paras: ['Du hast 8 Wochen lang Gewohnheiten geübt. Was sich schon selbstverständlich anfühlt, darf bleiben – der Rest kommt mit der Zeit. Du brauchst keine Diät, du hast jetzt ein System.', 'Gewohnheiten schlagen Motivation. Motivation kommt und geht; eine feste Routine trägt dich auch durch stressige Wochen.'] },
      { icon: '🏅', title: 'Deine Top 3', paras: ['Welche 3 Gewohnheiten haben bei dir am meisten bewirkt? Halte sie fest – das sind deine Anker, wenn es mal stressig wird.', 'In hektischen Phasen reicht es, diese drei zu halten. Alles andere darf mal pausieren.'] },
      { icon: '🧭', title: 'Wie es weitergeht', paras: ['Setz dir ein neues, konkretes Ziel für die nächsten Wochen – im Coaching geht es mit Vertiefungen und weiteren Staffeln weiter.', 'Du bist nicht „fertig" – du bist startklar für die nächste Stufe. Bleib dran, dein Fortschritt tut es auch.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskeln – dein Stoffwechsel-Motor', paras: ['Der nachhaltigste Weg zu einem hohen Stoffwechsel: Muskeln. Jedes Kilo Muskulatur verbrennt rund um die Uhr Energie – auch im Schlaf.', 'Deshalb passen Krafttraining und Ernährung so gut zusammen: Das Training baut den Motor, die Ernährung liefert den Treibstoff und die Bausteine.', 'Wenn du genau wissen willst, wo dein Stoffwechsel steht und wie du gezielt weiterkommst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Was trägt dich langfristig am besten?', options: ['Kurzfristige Motivation', 'Feste Gewohnheiten & Routinen', 'Möglichst strenge Diäten'], answer: 1, explain: 'Motivation schwankt – feste Routinen halten dich auch in stressigen Phasen am Ball.' },
      { q: 'Warum sind Muskeln gut für den Stoffwechsel?', options: ['Sie verbrennen rund um die Uhr Energie', 'Sie machen den Grundumsatz kleiner', 'Sie speichern besonders viel Fett'], answer: 0, explain: 'Muskulatur ist stoffwechselaktiv und hebt deinen Grundumsatz – auch in Ruhe.' },
    ],
    sources: [
      'International Society of Sports Nutrition (ISSN): Position Stands zu Protein & Krafttraining',
      'WHO – Empfehlungen zu körperlicher Aktivität',
      'Forschung zu Muskelmasse und Ruheenergieumsatz',
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
// Abnehmen-Kern: Wochen 9–12 (Vertiefung zum 12-Wochen-Programm). Eigener Track;
// die übrigen Ziele nutzen bis S5 das Basis-Programm (CURRICULUM, 8 Wochen).
const ABNEHMEN_EXT = [
  {
    week: 9, title: 'Fette klug wählen', theme: 'Makros', minutes: 8,
    teaser: 'Fett ist kein Feind – die richtigen Fette in der richtigen Menge helfen dir.',
    pages: [
      { icon: '🥑', title: 'Fett ist lebenswichtig', paras: ['Fett ist essenziell: für deine Hormone, die Zellwände und die Aufnahme der Vitamine A, D, E und K. Ganz ohne Fett geht es nicht.', 'Aber Fett ist energiedicht – rund 9 kcal pro Gramm, mehr als doppelt so viel wie Eiweiß oder Kohlenhydrate. Deshalb entscheidet die Menge.'] },
      { icon: '🫒', title: 'Gute Quellen', paras: ['Setz auf Olivenöl, Rapsöl, Nüsse, Samen, Avocado und fetten Fisch. Das sind Fette, die deinem Herz und deinen Gefäßen guttun.', 'Zurückhaltender bei stark verarbeiteten Fetten (Frittiertes, viele Fertigprodukte). Du musst nichts verteufeln – nur öfter die bessere Wahl treffen.'] },
      { icon: '🐟', title: 'Omega-3 nicht vergessen', paras: ['Omega-3-Fettsäuren aus fettem Fisch (Lachs, Makrele, Hering) 1–2× pro Woche sind für viele der einfachste Gewinn. Pflanzlich liefern Lein-, Raps- und Walnussöl eine Vorstufe.', 'Sie unterstützen Herz und Gefäße und wirken entzündungshemmend – gut für deine Regeneration.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Fett, Hormone & Vitamine', paras: ['Isst du dauerhaft extrem wenig Fett, kann das den Hormonhaushalt stören – Fett ist Baustoff für viele Botenstoffe. Ein bisschen Fett hilft außerdem, die fettlöslichen Vitamine überhaupt aufzunehmen.', 'Weil Fett so energiedicht ist, machen kleine Mengen einen großen Unterschied in deiner Bilanz: Der Schuss Öl oder die Handvoll Nüsse zählt spürbar mit.', 'Kurz: Genug gute Fette – aber bewusst dosiert. Weder fürchten noch übertreiben.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum ist Fett wichtig?', options: ['Es liefert keine Kalorien', 'Es ist Baustoff für Hormone und hilft bei der Vitaminaufnahme', 'Es kann man unbegrenzt essen'], answer: 1, explain: 'Fett ist essenziell für Hormone und die Aufnahme fettlöslicher Vitamine – aber energiedicht, daher dosiert.' },
      { q: 'Woher bekommst du Omega-3 gut?', options: ['Aus Weißmehl', 'Aus fettem Fisch, Lein- und Walnussöl', 'Aus Softdrinks'], answer: 1, explain: 'Fetter Fisch 1–2×/Woche oder pflanzliche Öle (Lein, Raps, Walnuss) sind gute Omega-3-Quellen.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Fett und Fettsäuren', 'Leitlinien zu Omega-3-Fettsäuren und Herz-Kreislauf-Gesundheit'],
    exercise: 'Bau heute eine Portion gesunde Fette bewusst ein (z. B. Olivenöl, Nüsse, Avocado) und miss Öl mit dem Löffel ab, statt frei zu gießen.',
    habits: [
      { id: 'w9h1', text: 'Täglich eine Portion gesunde Fette', cat: 'fette' },
      { id: 'w9h2', text: 'Öl abmessen statt frei gießen', cat: 'achtsamkeit' },
    ],
  },
  {
    week: 10, title: 'Schlaf, Stress & Hunger', theme: 'Verhalten', minutes: 8,
    teaser: 'Dein bester Diät-Helfer kostet nichts: guter Schlaf – und weniger Dauerstress.',
    pages: [
      { icon: '😴', title: 'Schlaf ist Diät-Helfer Nr. 1', paras: ['Zu wenig Schlaf macht das Abnehmen deutlich schwerer: Du hast mehr Hunger, mehr Heißhunger auf Süßes und fühlst dich weniger satt.', 'Wer müde ist, bewegt sich außerdem weniger im Alltag – der Verbrauch sinkt heimlich. Schlaf ist kein Luxus, sondern Teil deines Plans.'] },
      { icon: '🌀', title: 'Stress & Frustessen', paras: ['Dauerstress schüttet Cortisol aus und macht Appetit auf schnelle Energie – Zucker und Fett. Aus „einem Keks" wird schnell die halbe Packung.', 'Das ist keine Willensschwäche, sondern Biologie. Der Ausweg ist nicht mehr Kontrolle, sondern weniger Stress und ein anderes Ventil.'] },
      { icon: '🛌', title: 'So schläfst du besser', paras: ['Feste Zubettgeh-Zeit, das Schlafzimmer dunkel und kühl, Bildschirm eine Stunde vorher runter. Koffein am Nachmittag meiden.', 'Für Stress: ein kurzer Spaziergang, ein paar tiefe Atemzüge oder Bewegung im Studio wirken oft besser als jedes „Zusammenreißen".'] },
      { kind: 'metabolism', icon: '🧬', title: 'Schlafmangel & deine Hormone', paras: ['Zu wenig Schlaf senkt das Sättigungshormon Leptin und erhöht das Hungerhormon Ghrelin. Ergebnis: Du isst mehr, ohne es zu merken.', 'Chronisch hohes Cortisol durch Dauerstress kann Wassereinlagerung und Heißhunger fördern – die Waage stagniert, obwohl du „alles richtig" machst.', 'Guter Schlaf und Stressabbau sind damit echte Stoffwechsel-Hebel – oft unterschätzt, aber sehr wirksam.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was bewirkt zu wenig Schlaf?', options: ['Mehr Hunger und Heißhunger', 'Weniger Appetit', 'Gar nichts'], answer: 0, explain: 'Schlafmangel verschiebt die Hungerhormone (mehr Ghrelin, weniger Leptin) – du hast mehr Hunger.' },
      { q: 'Was hilft gegen Frustessen am besten?', options: ['Mehr Selbstkontrolle erzwingen', 'Weniger Stress und ein anderes Ventil (Bewegung, Atmen)', 'Ganz auf Essen verzichten'], answer: 1, explain: 'Frustessen ist Biologie – ein Stress-Ventil wirkt besser als reine Willenskraft.' },
    ],
    sources: ['Spiegel K et al.: Schlafmangel und Appetitregulation (Leptin/Ghrelin)', 'Übersichtsarbeiten zu Stress, Cortisol und Essverhalten'],
    exercise: 'Leg heute eine feste Schlafenszeit fest und nimm dir ein Stress-Ventil vor (10 Minuten Spaziergang oder ein paar bewusste Atemzüge).',
    habits: [
      { id: 'w10h1', text: 'Feste Schlafenszeit einhalten', cat: 'schlaf' },
      { id: 'w10h2', text: 'Ein Stress-Ventil am Tag', cat: 'mindset' },
    ],
  },
  {
    week: 11, title: 'Auswärts essen & feiern', theme: 'Umsetzung', minutes: 7,
    teaser: 'Restaurant, Party, Einladung – mit ein paar Strategien bleibst du entspannt im Ziel.',
    pages: [
      { icon: '🍽️', title: 'Restaurant-Strategie', paras: ['Schau dir die Karte ruhig vorher an und entscheide in Ruhe. Eine gute Basis: eine Eiweißquelle plus Gemüse, dazu bewusst das, worauf du Lust hast.', 'Du musst nichts „richtig" oder „falsch" bestellen – du triffst nur eine bewusste statt einer automatischen Wahl.'] },
      { icon: '🎉', title: 'Feiern ohne Reue', paras: ['Geh nicht ausgehungert hin – eine eiweißreiche Kleinigkeit vorher verhindert den Heißhunger am Buffet.', 'Nimm kleinere Teller, iss langsam und trink zwischendurch Wasser. So genießt du mehr und isst trotzdem weniger.'] },
      { icon: '🍷', title: 'Alkohol clever', paras: ['Plane die Menge vorher und wechsle jedes alkoholische Getränk mit einem Glas Wasser ab. Das bremst die Kalorien und den Kater.', 'Denk an Woche 6: Alkohol pausiert die Fettverbrennung – ein bewusstes Maß hält deinen Fortschritt am Laufen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Ein Abend kippt nichts', paras: ['Dein Stoffwechsel denkt in Wochen, nicht in einzelnen Mahlzeiten. Ein üppiger Abend verschwindet im Wochendurchschnitt – vorausgesetzt, du machst danach ganz normal weiter.', 'Wichtig ist, nicht zu „kompensieren": kein Hungern am nächsten Tag, kein Straf-Sport. Das führt nur in den Verzicht-Heißhunger-Kreislauf.', 'Genuss gehört dazu. Flexibilität ist genau das, was ein Plan dauerhaft haltbar macht.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was hilft beim Feiern am meisten?', options: ['Ausgehungert hingehen', 'Nicht hungrig hingehen und Wasser einbauen', 'Am nächsten Tag hungern'], answer: 1, explain: 'Nicht hungrig hingehen + Wasser zwischendurch verhindert Heißhunger – Kompensieren durch Hungern ist kontraproduktiv.' },
      { q: 'Wie wirkt ein einzelner üppiger Abend?', options: ['Er ruiniert den ganzen Fortschritt', 'Er verschwindet im Wochendurchschnitt', 'Er verdoppelt das Gewicht'], answer: 1, explain: 'Die Bilanz über die Woche zählt – ein Abend fällt kaum ins Gewicht, wenn du normal weitermachst.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Ernährung im Alltag', 'Literatur zu flexibler Kontrolle des Essverhaltens'],
    exercise: 'Plane deine nächste Auswärts-Situation: Was bestellst/isst du als Basis, und wie baust du Wasser ein?',
    habits: [
      { id: 'w11h1', text: 'Nicht hungrig zum Essen gehen', cat: 'planung' },
      { id: 'w11h2', text: 'Beim Ausgehen Wasser einbauen', cat: 'getraenke' },
    ],
  },
  {
    week: 12, title: 'Halten statt Jojo', theme: 'Nachhaltigkeit', minutes: 9,
    teaser: 'Gewicht halten ist eine eigene Fähigkeit – so sicherst du deinen Erfolg.',
    pages: [
      { icon: '🎯', title: 'Das eigentliche Ziel: Halten', paras: ['Abnehmen kann fast jeder für ein paar Wochen. Die eigentliche Kunst ist, das Ergebnis zu halten – und genau das üben wir jetzt.', 'Halten ist keine „Diät light", sondern eine eigene Fähigkeit: locker im Rahmen bleiben, ohne ständig zu verzichten.'] },
      { icon: '📈', title: 'Kalorien langsam anheben', paras: ['Nach der Abnehmphase erhöhst du die Menge schrittweise, statt sofort „normal" weiterzuessen. Beobachte dein Gewicht über 1–2 Wochen und taste dich heran.', 'So findest du deine Erhaltungsmenge – die Kalorienzahl, bei der dein Gewicht stabil bleibt.'] },
      { icon: '🏋️', title: 'Muskeln & Bewegung sichern den Erfolg', paras: ['Krafttraining und Alltagsbewegung (NEAT) halten deinen Verbrauch oben und schützen die Muskeln, die du dir bewahrt hast.', 'Genau hier zahlt sich dein Studio aus: Training ist der beste Schutz gegen das Jojo.'] },
      { icon: '⏸️', title: 'Pausen sind erlaubt', paras: ['Geplante Erhaltungsphasen (Diätpausen) sind sinnvoll: Sie geben Kopf und Hormonen eine Erholung und machen den nächsten Schritt leichter.', 'Fortschritt ist kein Dauersprint. Phasen des Haltens gehören fest dazu.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Set-Point & der nächste Schritt', paras: ['Nach einer Abnahme ist dein Energieverbrauch oft etwas niedriger als vorher (adaptive Thermogenese). Deshalb funktioniert „einfach wieder wie früher essen" selten – langsames Anheben und Muskeln halten sind der Schlüssel.', 'Dein Körper hat keinen starren „Set-Point", aber er verteidigt sein Gewicht. Mit Wissen und Training kannst du gegensteuern.', 'Wenn du genau wissen willst, wo dein Stoffwechsel jetzt steht und wie du gezielt hältst oder weitermachst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Wie gehst du nach dem Abnehmen am besten vor?', options: ['Sofort wieder wie früher essen', 'Kalorien langsam anheben und Gewicht beobachten', 'Für immer im Defizit bleiben'], answer: 1, explain: 'Langsam die Menge erhöhen und beobachten – so findest du deine Erhaltungsmenge ohne Jojo.' },
      { q: 'Was schützt deinen Erfolg langfristig am besten?', options: ['Muskeln & Bewegung', 'Möglichst wenig essen', 'Die Waage meiden'], answer: 0, explain: 'Krafttraining und Alltagsbewegung halten Verbrauch und Muskeln oben – der beste Jojo-Schutz.' },
    ],
    sources: ['Rosenbaum M, Leibel RL: Adaptive Thermogenese und Gewichtserhalt', 'National Weight Control Registry: Merkmale erfolgreicher Gewichtserhaltung', 'Deutsche Gesellschaft für Ernährung (DGE): Gewichtsmanagement'],
    exercise: 'Leg deine grobe Erhaltungsstrategie fest: Wie hebst du die Menge an, und welche 2 Trainings-/Bewegungsgewohnheiten behältst du sicher bei?',
    habits: [
      { id: 'w12h1', text: 'Wöchentlich Gewicht checken', cat: 'tracking' },
      { id: 'w12h2', text: 'Krafttraining beibehalten', cat: 'bewegung' },
    ],
  },
];

// ── Abnehmen · Staffel 2 „Aufbaustufe" (Wochen 13–20) ────────────────────
// Fortgeschrittene Vertiefung nach dem 12-Wochen-Kern: für alle, die dranbleiben
// und tiefer verstehen wollen. Gleiche Bausteine (Seiten + Stoffwechsel-Seite +
// Quiz + Aufgabe + Gewohnheiten), season-Label „Staffel 2 · Aufbaustufe".
const ABNEHMEN_S2 = [
  {
    week: 13, title: 'Refeed & Diätpause', theme: 'Strategie', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Warum gezielt mehr essen dich weiterbringt – und wie du Pausen klug einbaust.',
    pages: [
      { icon: '🍽️', title: 'Mehr essen als Strategie', paras: ['Nach mehreren Wochen im Defizit ist gezielt mehr essen kein Rückschritt, sondern ein Werkzeug. Der Körper – und der Kopf – bekommen eine geplante Erholung.', 'Wichtig: Das ist kein „Cheat Day" aus dem Bauch heraus, sondern eine bewusste, geplante Phase auf deinem Erhaltungsniveau. Du steuerst sie, nicht der Heißhunger.'] },
      { icon: '📅', title: 'Refeed oder Diätpause?', paras: ['Ein Refeed ist 1–2 Tage auf Erhaltung, vor allem mit mehr Kohlenhydraten. Eine Diätpause ist 1–2 Wochen auf Erhaltung.', 'Beide geben deinem Stoffwechsel und deiner Psyche eine Atempause. Gerade in längeren Abnehmphasen halten geplante Pausen dich langfristig besser bei der Stange als Dauer-Defizit.'] },
      { icon: '🧭', title: 'So machst du es', paras: ['Plane die Pause bewusst: iss auf Erhaltungsniveau (nicht „alles egal"), halte dein Eiweiß hoch und nutze die extra Kohlenhydrate rund ums Training.', 'Danach steigst du ruhig wieder in dein moderates Defizit ein. Kein Ausgleichshungern, kein schlechtes Gewissen – die Pause war Teil des Plans.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Refeed & deine Hormone', paras: ['Im längeren Defizit sinkt das Sättigungshormon Leptin – Hunger steigt, der Antrieb sinkt, oft auch die unbewusste Alltagsbewegung (NEAT). Ein kohlenhydratreicher Refeed kann Leptin kurzfristig wieder anheben.', 'Das bremst nicht nur den Hunger, sondern bringt auch Energie und Alltagsbewegung zurück – beides hilft deinem Verbrauch.', 'Studien zu geplanten Diätpausen (z. B. das MATADOR-Konzept) zeigen: Wer regelmäßig pausiert, hält den Fortschritt oft besser als bei durchgehendem Defizit.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist eine Diätpause?', options: ['Ein spontaner Cheat Day', '1–2 Wochen bewusst auf Erhaltungsniveau essen', 'Komplett aufhören zu essen'], answer: 1, explain: 'Eine Diätpause ist eine geplante Phase auf Erhaltung – kontrolliert, mit hohem Eiweiß, kein „alles egal".' },
      { q: 'Warum kann ein Refeed helfen?', options: ['Er hebt Leptin kurzfristig und bringt Energie/NEAT zurück', 'Er ersetzt das Training', 'Er verbrennt Fett direkt'], answer: 0, explain: 'Der kohlenhydratreiche Refeed kann das im Defizit gesunkene Leptin anheben – Hunger runter, Alltagsbewegung rauf.' },
    ],
    sources: ['Byrne HK et al. (2018): Intermittent Energy Restriction (MATADOR-Studie)', 'Rosenbaum M, Leibel RL: Leptin und adaptive Thermogenese', 'Deutsche Gesellschaft für Ernährung (DGE): Gewichtsmanagement'],
    exercise: 'Plane deine nächste Erhaltungs-Phase: Wähle 1–2 Tage (Refeed) oder eine Woche (Pause), lege dein Erhaltungs-Ziel fest und halte das Eiweiß hoch.',
    habits: [
      { id: 'w13h1', text: 'Refeed/Pause bewusst auf Erhaltung', cat: 'planung' },
      { id: 'w13h2', text: 'Eiweißziel auch in der Pause treffen', cat: 'protein' },
    ],
  },
  {
    week: 14, title: 'Trainingstag vs. Ruhetag', theme: 'Makros', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Kalorien clever über die Woche verteilen – mehr an Trainingstagen, weniger an Ruhetagen.',
    pages: [
      { icon: '🔄', title: 'Nicht jeder Tag ist gleich', paras: ['Dein Bedarf schwankt: An Trainingstagen verbrauchst du mehr, an Ruhetagen weniger. Du darfst deine Kalorien deshalb über die Woche verteilen, statt jeden Tag gleich zu essen.', 'Das nennt man Kalorien-Zyklus: mehr an Tagen mit Leistung, etwas weniger an ruhigen Tagen. Die Wochenbilanz bleibt gleich – aber es fühlt sich besser an.'] },
      { icon: '⚡', title: 'Trainingstage: mehr Kohlenhydrate', paras: ['An Trainingstagen packst du die zusätzlichen Kalorien vor allem in Kohlenhydrate rund ums Workout. Das gibt Leistung und füllt die Muskelspeicher (Glykogen).', 'Eiweiß bleibt an allen Tagen hoch und konstant – es ist dein Muskelschutz, egal ob Ruhe- oder Trainingstag.'] },
      { icon: '🛋️', title: 'Ruhetage: etwas weniger', paras: ['An Ruhetagen brauchst du weniger schnelle Energie. Hier darfst du bei den Kohlenhydraten etwas zurückfahren, mehr Gemüse und Eiweiß auf den Teller.', 'So schaffst du an Trainingstagen Spielraum, ohne die Wochenbilanz zu sprengen – ein Plan, der sich flexibel und satt anfühlt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Glykogen & Trainingsleistung', paras: ['Kohlenhydrate landen als Glykogen in Muskeln und Leber – dein schnell verfügbarer Treibstoff. Volle Speicher heißt: mehr Kraft, bessere Sätze, bessere Regeneration.', 'Rund ums Training verwertet der Körper Kohlenhydrate besonders gut, weil die Muskeln „aufnahmebereit" sind. Genau da machen sie am meisten Sinn.', 'Wer hart trainiert und dabei klug Kohlenhydrate timt, schützt Muskeln und Leistung – der beste Weg, den Grundumsatz auch im Defizit oben zu halten.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie verteilst du Kalorien über die Woche sinnvoll?', options: ['Jeden Tag exakt gleich', 'Mehr an Trainingstagen, weniger an Ruhetagen', 'Nur am Wochenende essen'], answer: 1, explain: 'Kalorien-Zyklus: mehr Energie (v. a. Kohlenhydrate) an Trainingstagen, etwas weniger an Ruhetagen – Wochenbilanz bleibt gleich.' },
      { q: 'Was bleibt an allen Tagen konstant hoch?', options: ['Zucker', 'Eiweiß', 'Alkohol'], answer: 1, explain: 'Eiweiß ist dein Muskelschutz und bleibt an Trainings- wie Ruhetagen konstant hoch.' },
    ],
    sources: ['International Society of Sports Nutrition (ISSN): Nutrient Timing (Kerksick et al.)', 'Literatur zu Glykogen und Trainingsleistung', 'Deutsche Gesellschaft für Ernährung (DGE): Kohlenhydrate'],
    exercise: 'Schau auf deine Trainingswoche und plane: An 2 Trainingstagen etwas mehr Kohlenhydrate rund ums Workout, an einem Ruhetag etwas weniger.',
    habits: [
      { id: 'w14h1', text: 'Kohlenhydrate rund ums Training legen', cat: 'kohlenhydrate' },
      { id: 'w14h2', text: 'Eiweiß an jedem Tag konstant halten', cat: 'protein' },
    ],
  },
  {
    week: 15, title: 'Das Plateau durchbrechen', theme: 'Stoffwechsel', minutes: 9, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Warum die Waage manchmal stehen bleibt – und was wirklich hilft.',
    pages: [
      { icon: '⏸️', title: 'Wenn nichts mehr geht', paras: ['Fast jeder erreicht mal ein Plateau: Die Waage steht wochenlang, obwohl du dranbleibst. Das ist normal und kein Grund zur Panik – oft steckt kein „kaputter Stoffwechsel" dahinter.', 'Häufigster Grund: Die Portionen sind über die Zeit unbemerkt gewachsen, oder du bewegst dich weniger. Ein ehrliches Protokoll über ein paar Tage bringt Klarheit.'] },
      { icon: '📉', title: 'Der Körper passt sich an', paras: ['Wenn du leichter wirst, sinkt dein Verbrauch ganz natürlich – ein kleinerer Körper braucht weniger Energie. Das alte Defizit ist dann vielleicht gar keins mehr.', 'Dazu kommt die adaptive Thermogenese: Der Körper spart nach längerem Defizit etwas Energie. Kein Defekt, sondern Biologie – und gut steuerbar.'] },
      { icon: '🔧', title: 'Die richtigen Hebel', paras: ['Erst prüfen, dann schrauben: Protokoll ehrlich führen, Eiweiß hoch halten, Alltagsbewegung (NEAT) und Schritte erhöhen. Oft reicht das schon.', 'Wenn wirklich nötig, das Defizit leicht nachschärfen ODER eine Diätpause einlegen. Nicht radikal weniger essen – das befeuert nur die Anpassung.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Adaptive Thermogenese verstehen', paras: ['Nach längerem Defizit fährt der Körper den Verbrauch etwas stärker herunter, als der reine Gewichtsverlust erklärt – Forschende nennen das adaptive Thermogenese.', 'Sie ist begrenzt und umkehrbar: Muskeln erhalten, genug Eiweiß, Krafttraining und geplante Pausen wirken dem entgegen. Radikales Hungern verstärkt sie dagegen.', 'Wie stark dein Stoffwechsel wirklich angepasst ist, lässt sich im Studio messen – so schraubst du gezielt statt zu raten.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist der häufigste Grund für ein Plateau?', options: ['Der Stoffwechsel ist dauerhaft kaputt', 'Unbemerkt größere Portionen / weniger Bewegung + natürliche Anpassung', 'Man isst zu viel Eiweiß'], answer: 1, explain: 'Meist wachsen Portionen unbemerkt oder die Bewegung sinkt; dazu sinkt der Verbrauch mit dem Gewicht. Erst prüfen, dann anpassen.' },
      { q: 'Was hilft NICHT gegen ein Plateau?', options: ['Radikal viel weniger essen', 'NEAT/Schritte erhöhen', 'Eine geplante Diätpause'], answer: 0, explain: 'Radikales Hungern verstärkt die adaptive Anpassung. Besser: ehrlich prüfen, Bewegung hoch, ggf. leicht nachschärfen oder pausieren.' },
    ],
    sources: ['Müller MJ, Bosy-Westphal A: Adaptive Thermogenese beim Menschen', 'Rosenbaum M, Leibel RL: Energieverbrauch nach Gewichtsabnahme', 'Levine JA: Non-Exercise Activity Thermogenesis (NEAT)'],
    exercise: 'Führe 3 Tage ein besonders ehrliches Protokoll und zähle deine Schritte. Entscheide dann EINEN Hebel: mehr Bewegung, Portionen justieren oder eine Pause.',
    habits: [
      { id: 'w15h1', text: '3 Tage besonders ehrlich protokollieren', cat: 'tracking' },
      { id: 'w15h2', text: 'Täglich Schritte/NEAT erhöhen', cat: 'bewegung' },
    ],
  },
  {
    week: 16, title: 'Körperkomposition statt Waage', theme: 'Fortschritt', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Die Waage ist nur ein Teil der Wahrheit – so misst du echten Fortschritt.',
    pages: [
      { icon: '⚖️', title: 'Die Waage lügt manchmal', paras: ['Dein Gewicht schwankt täglich um 1–2 kg – durch Wasser, Salz, Kohlenhydrate, Verdauung und bei Frauen den Zyklus. Ein einzelner Wert sagt wenig.', 'Besser: immer unter gleichen Bedingungen wiegen (morgens, nüchtern) und den Wochendurchschnitt betrachten. Der Trend zählt, nicht der Tageswert.'] },
      { icon: '📏', title: 'Miss, was wirklich zählt', paras: ['Umfänge (Taille, Hüfte), Fotos im gleichen Licht und wie deine Kleidung sitzt, zeigen oft mehr als die Waage – gerade wenn du gleichzeitig Muskeln aufbaust.', 'Manchmal steht das Gewicht, während der Bauchumfang sinkt: Du wirst straffer, ohne leichter zu werden. Genau das willst du.'] },
      { icon: '🔁', title: 'Recomposition verstehen', paras: ['Fett verlieren und gleichzeitig Muskeln halten oder aufbauen – „Body Recomposition" – ist möglich, vor allem bei Einsteigern und mit Krafttraining plus genug Eiweiß.', 'Der Preis: Es geht langsamer auf der Waage. Dafür veränderst du deine Form nachhaltig. Geduld schlägt hier Tempo.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel vs. Fett – der Unterschied', paras: ['Ein Kilo Muskel und ein Kilo Fett wiegen gleich, brauchen aber unterschiedlich viel Platz: Muskel ist dichter und formt den Körper. Deshalb kann die Form besser werden, während die Zahl steht.', 'Muskulatur ist zudem stoffwechselaktiv – mehr Muskeln heben deinen Grundumsatz und machen das Halten leichter.', 'Eine echte Körperanalyse (z. B. Messung im Studio) trennt Fett von Muskel und zeigt dir, was sich unter der Oberfläche wirklich verändert.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Warum ist der Tages-Wert der Waage wenig aussagekräftig?', options: ['Waagen sind immer kaputt', 'Wasser, Salz, Verdauung & Zyklus lassen ihn täglich schwanken', 'Gewicht ändert sich nie'], answer: 1, explain: 'Tägliche Schwankungen von 1–2 kg sind normal. Aussagekräftig ist der Wochendurchschnitt und der Trend.' },
      { q: 'Was zeigt Fortschritt oft besser als die Waage?', options: ['Umfänge, Fotos und wie die Kleidung sitzt', 'Die Uhrzeit', 'Der Puls'], answer: 0, explain: 'Bei gleichzeitigem Muskelerhalt/-aufbau sagen Umfänge, Fotos und Passform mehr über deine Form aus.' },
    ],
    sources: ['Literatur zu Body Recomposition (Fettverlust bei Muskelerhalt)', 'Deutsche Gesellschaft für Ernährung (DGE): Gewichtsmanagement', 'Grundlagen der Körperzusammensetzung (Fettmasse vs. fettfreie Masse)'],
    exercise: 'Miss diese Woche Taille und Hüfte und mach ein Foto bei gleichem Licht. Notiere beides als Startpunkt für den Trend – nicht nur die Waage.',
    habits: [
      { id: 'w16h1', text: 'Wöchentlich Umfänge messen', cat: 'tracking' },
      { id: 'w16h2', text: 'Nur Wochendurchschnitt bewerten', cat: 'mindset' },
    ],
  },
  {
    week: 17, title: 'Ballaststoffe & Darmgesundheit', theme: 'Gesundheit', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Der unterschätzte Sattmacher – gut für Bauchgefühl, Blutzucker und Wohlbefinden.',
    pages: [
      { icon: '🌾', title: 'Ballaststoffe – dein Sattmacher', paras: ['Ballaststoffe aus Gemüse, Obst, Vollkorn und Hülsenfrüchten machen satt, ohne viele Kalorien zu liefern. Sie sind einer der besten Verbündeten beim Abnehmen.', 'Die meisten Menschen essen zu wenig davon. Ein guter Richtwert sind rund 30 g pro Tag – erreichbar mit ein paar bewussten Umstellungen.'] },
      { icon: '🫘', title: 'So kommst du auf deine Menge', paras: ['Vollkorn statt Weißmehl, eine Handvoll Hülsenfrüchte, Gemüse zu jeder Mahlzeit, Obst als Snack, Nüsse und Samen – so summiert sich dein Ballaststoff-Konto ganz nebenbei.', 'Steigere langsam und trink genug Wasser, sonst kann der Bauch anfangs zwicken. Dein Verdauungssystem gewöhnt sich in ein bis zwei Wochen daran.'] },
      { icon: '🩸', title: 'Ruhiger Blutzucker', paras: ['Ballaststoffe verlangsamen die Aufnahme von Zucker ins Blut. Das glättet die Blutzuckerkurve – weniger Spitzen, weniger Tiefs, weniger Heißhunger.', 'Ein Vollkornbrot hält deshalb länger satt als ein Weißmehl-Brötchen, obwohl beide ähnlich viele Kalorien haben.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Dein Mikrobiom isst mit', paras: ['In deinem Darm leben Billionen Bakterien – dein Mikrobiom. Ballaststoffe sind ihr Futter: Daraus bilden sie kurzkettige Fettsäuren, die Darm und Stoffwechsel unterstützen.', 'Ein vielfältig gefüttertes Mikrobiom wird mit besserer Verdauung, stabilerem Appetit und Wohlbefinden in Verbindung gebracht. Vielfalt auf dem Teller = Vielfalt im Darm.', 'Fermentiertes wie Joghurt, Kefir oder Sauerkraut ergänzt das Ganze. Iss bunt und pflanzenreich – dein Darm dankt es dir.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum helfen Ballaststoffe beim Abnehmen?', options: ['Sie machen satt bei wenig Kalorien und glätten den Blutzucker', 'Sie haben besonders viele Kalorien', 'Sie ersetzen Eiweiß'], answer: 0, explain: 'Ballaststoffe sättigen stark, liefern wenig Energie und bremsen die Zuckeraufnahme – weniger Heißhunger.' },
      { q: 'Was ist das Mikrobiom?', options: ['Ein Vitaminpräparat', 'Die Bakteriengemeinschaft in deinem Darm', 'Ein Trainingsgerät'], answer: 1, explain: 'Das Mikrobiom sind die Darmbakterien; Ballaststoffe sind ihr Futter und fördern ihre Vielfalt.' },
    ],
    sources: ['Reynolds A et al. (2019, The Lancet): Ballaststoffe und Gesundheit', 'Deutsche Gesellschaft für Ernährung (DGE): Ballaststoffe (~30 g/Tag)', 'Übersichtsarbeiten zu Darmmikrobiom und Ernährung'],
    exercise: 'Bau heute an jeder Mahlzeit eine Ballaststoffquelle ein (Gemüse, Vollkorn, Hülsenfrüchte) und tausche einmal Weißmehl gegen Vollkorn.',
    habits: [
      { id: 'w17h1', text: 'Ballaststoffquelle zu jeder Mahlzeit', cat: 'ballaststoffe' },
      { id: 'w17h2', text: 'Pflanzenvielfalt über die Woche', cat: 'gesundheit' },
    ],
  },
  {
    week: 18, title: 'Kalorien-Feintuning', theme: 'Präzision', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Wenn es genauer werden soll: kleine Stellschrauben mit großer Wirkung.',
    pages: [
      { icon: '🎯', title: 'Vom Schätzen zum Justieren', paras: ['Am Anfang reicht grobes Beobachten. Fortgeschritten darfst du feiner justieren – nicht aus Zwang, sondern um bewusst zu steuern, wenn ein Ziel näher rückt.', 'Feintuning heißt nicht „jede Kalorie zählen für immer". Es heißt: die 2–3 Stellschrauben kennen, die bei dir den Unterschied machen.'] },
      { icon: '🥄', title: 'Die üblichen Verdächtigen', paras: ['Öl, Nüsse, Käse, Saucen, Getränke und „ein Löffel hier und da" werden am häufigsten unterschätzt. Kurz abwiegen statt schätzen bringt oft die größte Überraschung.', 'Es reicht, ein paar energiedichte Lebensmittel genauer zu erfassen – der Rest lässt sich weiter locker handhaben.'] },
      { icon: '📐', title: 'Realistisch bleiben', paras: ['Apps und Formeln (wie in dieser App) sind Schätzungen – dein echter Verbrauch kann etwas abweichen. Beobachte 1–2 Wochen und justiere dann in kleinen Schritten.', 'Ändere immer nur eine Sache und gib ihr Zeit. Wer an fünf Schrauben gleichzeitig dreht, weiß am Ende nicht, was gewirkt hat.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Warum Rechner nur schätzen', paras: ['Formeln wie Mifflin-St-Jeor schätzen deinen Grundumsatz aus Alter, Größe, Gewicht und Geschlecht – gut als Startpunkt, aber individuell verschieden.', 'Muskelmasse, Alltagsbewegung und die adaptive Anpassung machen deinen echten Bedarf einzigartig. Deshalb ist Beobachten wertvoller als jede Formel.', 'Eine echte Stoffwechselmessung im Studio ersetzt die Schätzung durch deinen tatsächlichen Wert – die präziseste Basis fürs Feintuning.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was bedeutet sinnvolles Kalorien-Feintuning?', options: ['Für immer jede Kalorie zählen', 'Die 2–3 wichtigsten Stellschrauben kennen und in kleinen Schritten justieren', 'Gar nicht mehr essen'], answer: 1, explain: 'Feintuning heißt gezielt an wenigen Stellschrauben drehen – nicht zwanghaft alles zählen.' },
      { q: 'Welche Lebensmittel werden am häufigsten unterschätzt?', options: ['Gemüse und Wasser', 'Öl, Nüsse, Käse, Saucen und Getränke', 'Magerquark'], answer: 1, explain: 'Energiedichte Dinge wie Öl, Nüsse, Käse und flüssige Kalorien werden beim Schätzen oft deutlich unterschätzt.' },
    ],
    sources: ['Mifflin MD, St Jeor ST et al. (1990): Grundumsatz-Schätzformel', 'Hall KD: Dynamik der Energiebilanz beim Menschen', 'Deutsche Gesellschaft für Ernährung (DGE): Energiebedarf'],
    exercise: 'Wiege 3 Tage lang nur deine energiedichten Lebensmittel (Öl, Nüsse, Käse) genau ab – und justiere danach EINE Stellschraube.',
    habits: [
      { id: 'w18h1', text: 'Energiedichtes bewusst abmessen', cat: 'achtsamkeit' },
      { id: 'w18h2', text: 'Nur eine Stellschraube pro Woche ändern', cat: 'planung' },
    ],
  },
  {
    week: 19, title: 'Gewohnheiten stapeln', theme: 'Verhalten', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Aus einzelnen Vorsätzen wird ein Selbstläufer – so baust du stabile Routinen.',
    pages: [
      { icon: '🧱', title: 'Vom Vorsatz zur Routine', paras: ['Willenskraft ist eine begrenzte Ressource. Gewohnheiten laufen dagegen automatisch – sie kosten keine Kraft mehr, wenn sie erst sitzen.', 'Genau deshalb arbeiten wir im Coaching mit kleinen Gewohnheiten statt mit großen Vorsätzen. Klein, konkret, täglich – das hält.'] },
      { icon: '🔗', title: 'Habit-Stacking', paras: ['Der Trick: Hänge eine neue Gewohnheit an eine bestehende. „Nach dem Zähneputzen trinke ich ein Glas Wasser." „Nach dem Mittagessen gehe ich 5 Minuten."', 'Die alte Gewohnheit ist der Auslöser für die neue. So musst du dich nicht erinnern – die Routine erinnert dich.'] },
      { icon: '🌱', title: 'Klein anfangen, dran bleiben', paras: ['Neue Gewohnheiten brauchen im Schnitt etliche Wochen, bis sie automatisch sind – oft rund zwei Monate. Konstanz schlägt Perfektion; ein verpasster Tag ist kein Rückfall.', 'Wähle bewusst 1–2 Gewohnheiten aus, die dir am meisten bringen, und übe genau die. Der Rest kommt später.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Bewegung als Gewohnheit = Stoffwechsel-Motor', paras: ['Viele der wirksamsten Gewohnheiten bewegen deinen Stoffwechsel: Ein täglicher Spaziergang, Treppe statt Aufzug, regelmäßiges Krafttraining – alles NEAT und Muskelreiz.', 'Als Automatismus summieren sich diese kleinen Dinge zu einem spürbar höheren Verbrauch – Tag für Tag, ohne Extra-Motivation.', 'So wird aus einzelnen guten Tagen ein System, das deinen Grundumsatz dauerhaft stützt.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist Habit-Stacking?', options: ['Eine neue Gewohnheit an eine bestehende hängen', 'Alle Gewohnheiten auf einmal ändern', 'Gewohnheiten aufschreiben und vergessen'], answer: 0, explain: 'Beim Habit-Stacking wird eine bestehende Gewohnheit zum Auslöser für die neue – z. B. „nach dem Kaffee 5 Minuten gehen".' },
      { q: 'Was schlägt Perfektion beim Gewohnheitsaufbau?', options: ['Konstanz', 'Ein perfekter Start', 'Möglichst viele Gewohnheiten gleichzeitig'], answer: 0, explain: 'Konstanz über Wochen bildet die Routine – ein einzelner verpasster Tag wirft dich nicht zurück.' },
    ],
    sources: ['Lally P et al. (2010): Wie Gewohnheiten entstehen (Habit Formation)', 'Wood W, Neal DT: Psychologie der Gewohnheit', 'BJ Fogg: Tiny Habits (Verhaltensdesign)'],
    exercise: 'Wähle eine bestehende Gewohnheit und häng eine neue kleine daran (Habit-Stack). Formuliere sie als „Nach … mache ich …" und starte heute.',
    habits: [
      { id: 'w19h1', text: 'Einen Habit-Stack täglich ausführen', cat: 'mindset' },
      { id: 'w19h2', text: 'Nach einer Mahlzeit 5 Min bewegen', cat: 'bewegung' },
    ],
  },
  {
    week: 20, title: 'Von Abnehmen zu Longevity', theme: 'Nachhaltigkeit', minutes: 9, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Der nächste Level: Ernährung, die dich nicht nur schlanker, sondern lange gesund hält.',
    pages: [
      { icon: '🌍', title: 'Das größere Ziel', paras: ['Abnehmen war der Anfang. Der eigentliche Gewinn ist ein Körper, der dich lange gesund, kräftig und beweglich durchs Leben trägt.', 'Die gute Nachricht: Fast alles, was du gelernt hast – Eiweiß, Bewegung, Pflanzenvielfalt, Schlaf – zahlt genau darauf ein. Du bist schon auf dem Weg.'] },
      { icon: '🥗', title: 'Was Langlebigkeit fördert', paras: ['Studien zu langlebigen Regionen zeigen ein Muster: viel Pflanzliches, genug Eiweiß, gute Fette, wenig stark Verarbeitetes und Zucker, dazu regelmäßige Bewegung und soziale Bindung.', 'Die mediterrane Ernährung ist dafür ein gut untersuchtes Vorbild – kein starres Programm, sondern eine bunte, sättigende Art zu essen, die du dauerhaft magst.'] },
      { icon: '💪', title: 'Muskeln sind Altersvorsorge', paras: ['Ab etwa 30 verlieren wir ohne Gegenwehr langsam Muskeln. Krafttraining und genug Eiweiß halten dagegen – für Kraft, Stoffwechsel und Selbstständigkeit bis ins Alter.', 'Was du im Studio aufbaust, ist im wahrsten Sinne eine Investition in dein zukünftiges Ich.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskeln, Stoffwechsel & gesundes Altern', paras: ['Muskulatur ist mehr als Kraft: Sie ist stoffwechselaktives Gewebe, hilft beim Blutzucker, schützt vor Stürzen und hält den Grundumsatz oben – ein Schlüssel für gesundes Altern.', 'Genug Eiweiß gewinnt mit dem Alter sogar an Bedeutung, um Muskeln zu erhalten (Fachgesellschaften empfehlen älteren Menschen eher mehr als weniger).', 'Wenn du wissen willst, wo dein Stoffwechsel und deine Körperzusammensetzung heute stehen und wie du gezielt weitermachst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Was haben abnehmen und „gesund alt werden" gemeinsam?', options: ['Nichts', 'Fast dieselben Hebel: Eiweiß, Bewegung, Pflanzenvielfalt, Schlaf', 'Man muss dafür hungern'], answer: 1, explain: 'Die Gewohnheiten aus dem Coaching zahlen direkt auf Langlebigkeit ein – du bist schon auf dem Weg.' },
      { q: 'Warum sind Muskeln „Altersvorsorge"?', options: ['Sie halten Kraft, Stoffwechsel und Selbstständigkeit im Alter', 'Sie machen den Grundumsatz kleiner', 'Sie sind nur fürs Aussehen'], answer: 0, explain: 'Muskeln sind stoffwechselaktiv, schützen vor Stürzen und erhalten Kraft und Selbstständigkeit – eine Investition ins zukünftige Ich.' },
    ],
    sources: ['Bauer J et al. (PROT-AGE): Eiweißzufuhr im Alter', 'Studien zur mediterranen Ernährung und Langlebigkeit', 'WHO – Empfehlungen zu körperlicher Aktivität; Forschung zu Muskelmasse und Altern'],
    exercise: 'Formuliere dein neues Leitziel jenseits des Gewichts (z. B. „stark und beweglich bleiben") und lege 3 Gewohnheiten fest, die du dauerhaft behältst.',
    habits: [
      { id: 'w20h1', text: 'Krafttraining fest im Wochenplan', cat: 'bewegung' },
      { id: 'w20h2', text: 'Täglich pflanzlich & bunt essen', cat: 'gesundheit' },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════
//  Track „Definieren" – 12-Wochen-Kern (eigener Content).
//  Fokus: Fett verlieren UND Muskeln sichtbar machen. Moderates Defizit, VIEL
//  Eiweiß (~1,9 g/kg), Krafttraining, Körperkomposition statt Waage. Habit-IDs
//  track-eindeutig (d…). Ton „du", keine medizinischen Aussagen, keine Crashdiät.
// ═══════════════════════════════════════════════════════════════════════
const DEFINIEREN = [
  {
    week: 1, title: 'Ankommen & „definieren" schärfen', theme: 'Grundlagen', minutes: 9,
    teaser: 'Was Definition wirklich bedeutet – Fett runter, Muskeln sichtbar, in gesundem Tempo.',
    pages: [
      { icon: '👋', title: 'Willkommen zu deinem Definitions-Coaching', paras: ['Schön, dass du da bist. „Definieren" heißt: Fett verlieren und gleichzeitig deine Muskeln schützen, damit Form und Kontur sichtbar werden. Nicht einfach nur „leichter", sondern straffer und definierter.', 'Der Weg dahin ist kein Hungern, sondern ein kluges Zusammenspiel aus moderatem Defizit, viel Eiweiß und Krafttraining. Genau das bauen wir Woche für Woche auf.', 'Diese erste Einheit legt das Fundament – und zeigt dir, warum dein Stoffwechsel und deine Muskeln dabei die Hauptrolle spielen.'] },
      { icon: '🎯', title: 'Definition = Fett runter, Muskel bleibt', paras: ['Sichtbare Definition entsteht aus zwei Dingen: genug Muskelmasse UND wenig Fett darüber. Fehlt der Muskel, wirkt der Körper „schlank, aber flach"; ist zu viel Fett drüber, bleibt die Kontur verdeckt.', 'Deshalb ist dein Ziel anders als reines Abnehmen: Du willst nicht maximal viel Gewicht verlieren, sondern vor allem Fett – und den Muskel behalten oder sogar leicht aufbauen.', 'Das gelingt nur mit moderatem Tempo. Zu aggressiv, und du verlierst genau den Muskel, der dich definiert aussehen lässt.'] },
      { icon: '🐢', title: 'Das richtige Tempo', paras: ['Für Definition sind etwa 0,3–0,6 kg pro Woche ideal – langsam genug, um Muskeln zu schützen. Wer schneller abnimmt, verliert überproportional Muskelmasse.', 'Ein moderates Defizit von rund 15 % unter deinem Verbrauch reicht völlig. Die App rechnet dir das mit viel Eiweiß bereits aus.', 'Geduld ist hier kein nettes Extra, sondern die Strategie. Definition ist ein Marathon, kein Sprint.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskeln – dein Look UND dein Motor', paras: ['Muskulatur macht dich nicht nur definiert, sie ist auch stoffwechselaktiv: Jedes Kilo Muskel verbrennt rund um die Uhr Energie. Wer Muskeln hält, hält seinen Grundumsatz oben – das Defizit fällt leichter.', 'Genau deshalb ist die Kombination aus Krafttraining und viel Eiweiß der Kern der Definitionsphase: Das Training gibt den Reiz „Muskel behalten", das Eiweiß liefert den Baustoff.', 'Wie hoch dein Stoffwechsel und wie viel Muskelmasse du hast, lässt sich im Studio messen – eine ehrliche Standortbestimmung für deinen Weg.'], cta: 'Stoffwechsel messen lassen' },
      { icon: '📓', title: 'So startest du diese Woche', paras: ['Diese Woche änderst du noch wenig – du beobachtest. Trag ehrlich alles ein, was du isst, und schau besonders auf dein Eiweiß.', 'Mach außerdem ein neutrales Startfoto und miss deine Taille. Die Waage allein wird dir bei Definition nicht die ganze Wahrheit erzählen.', 'Am Ende der Woche hast du deine Landkarte – und wir wissen, wo wir ansetzen.'] },
    ],
    quiz: [
      { q: 'Was macht einen „definierten" Körper aus?', options: ['Nur möglichst wenig Gewicht', 'Genug Muskeln UND wenig Fett darüber', 'Möglichst wenig essen'], answer: 1, explain: 'Definition = sichtbare Muskeln bei niedrigem Körperfett. Beides zählt – nicht nur die Waage.' },
      { q: 'Warum ist ein moderates Tempo wichtig?', options: ['Damit du Muskeln schützt', 'Damit es länger dauert', 'Weil schnell immer besser ist'], answer: 0, explain: 'Zu schnelles Abnehmen kostet Muskeln – und genau die sorgen für Definition.' },
    ],
    sources: ['International Society of Sports Nutrition (ISSN): Position Stand – Diet & Body Composition', 'Helms ER et al.: Empfehlungen für natürliche Wettkampfvorbereitung (Review)', 'Deutsche Gesellschaft für Ernährung (DGE): Referenzwerte'],
    exercise: 'Protokolliere heute alles ehrlich, achte auf dein Eiweiß, mach ein Startfoto und miss deine Taille.',
    habits: [
      { id: 'd1h1', text: 'Jede Mahlzeit protokollieren', cat: 'tracking' },
      { id: 'd1h2', text: 'Eiweiß bewusst im Blick behalten', cat: 'protein' },
      { id: 'd1h3', text: 'Startfoto & Taille notiert', cat: 'tracking' },
    ],
  },
  {
    week: 2, title: 'Eiweiß im Mittelpunkt', theme: 'Makros', minutes: 8,
    teaser: 'In der Definition ist Eiweiß der Hauptdarsteller – so triffst du deinen erhöhten Bedarf.',
    pages: [
      { icon: '🍗', title: 'Warum du mehr brauchst', paras: ['In einem Defizit steigt dein Eiweißbedarf: Der Körper soll Muskeln halten, obwohl weniger Energie da ist. Für Definition rechnen wir daher mit rund 1,9 g pro kg Körpergewicht – mehr als beim reinen Abnehmen.', 'Eiweiß sättigt zudem am stärksten. Gerade wenn die Kalorien knapper werden, hilft dir das enorm, ohne Heißhunger durch den Tag zu kommen.'] },
      { icon: '📊', title: 'Über den Tag verteilen', paras: ['Verteil dein Eiweiß auf 3–4 Portionen. Zu jeder Hauptmahlzeit eine ordentliche Eiweißquelle – das nutzt deine Muskelbausteine besser, als alles abends auf einmal.', 'Dein Tagesziel im Tab rechnet die Menge aus. Dein Job: es zuverlässig treffen, jeden Tag.'] },
      { icon: '🥚', title: 'Die besten Quellen', paras: ['Mageres Fleisch, Fisch, Eier, Magerquark, Skyr, Hüttenkäse, Whey; pflanzlich Tofu, Tempeh, Sojaprodukte, Hülsenfrüchte. Diese Quellen liefern viel Eiweiß bei wenig Kalorien – perfekt für die Definition.', 'Eine einfache Regel: Baue jede Mahlzeit um die Eiweißquelle herum, dann kommt der Rest fast von allein.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Eiweiß, Muskelaufbau & Nachbrenn-Effekt', paras: ['Eiweiß liefert die Aminosäuren für die Muskel-Proteinsynthese – den Reparatur- und Aufbauprozess nach dem Training. Ohne genug davon kann der Muskel sich im Defizit nicht halten.', 'Zusätzlich hat Eiweiß den höchsten thermischen Effekt: 20–30 % seiner Energie verbraucht der Körper schon bei der Verdauung. Ein kleiner, aber netter Stoffwechsel-Bonus.', 'Kurz: Viel Eiweiß schützt Muskeln, macht satt und heizt die Verdauung an – der ideale Nährstoff für deine Definitionsphase.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie viel Eiweiß ist für Definition ein guter Richtwert?', options: ['Etwa 0,5 g/kg', 'Rund 1,9 g pro kg Körpergewicht', 'So wenig wie möglich'], answer: 1, explain: 'Im Defizit hält höheres Eiweiß (~1,9 g/kg) die Muskeln – die App rechnet dein Ziel aus.' },
      { q: 'Warum Eiweiß über den Tag verteilen?', options: ['Es nutzt die Muskelbausteine besser', 'Damit es abends mehr wird', 'Verteilung ist egal'], answer: 0, explain: 'Mehrere Portionen versorgen die Muskel-Proteinsynthese besser als eine große Menge auf einmal.' },
    ],
    sources: ['ISSN: Position Stand – Protein and Exercise (Jäger et al., 2017)', 'Helms ER et al.: Proteinzufuhr in der Diät (Review)', 'Übersichtsarbeiten zum thermischen Effekt von Eiweiß'],
    exercise: 'Bau heute zu jeder Hauptmahlzeit eine klare Eiweißquelle ein und prüfe am Abend, wie nah du an deinem (erhöhten) Eiweißziel bist.',
    habits: [
      { id: 'd2h1', text: 'Eiweißquelle zu jeder Hauptmahlzeit', cat: 'protein' },
      { id: 'd2h2', text: 'Erhöhtes Eiweißziel treffen', cat: 'protein' },
    ],
  },
  {
    week: 3, title: 'Moderates Defizit, Muskel schützen', theme: 'Strategie', minutes: 8,
    teaser: 'Warum „weniger ist mehr" beim Defizit gilt – und wie du nicht zu weit gehst.',
    pages: [
      { icon: '⚖️', title: 'Das richtige Maß', paras: ['Ein Defizit ist nötig, um Fett zu verlieren – aber es darf nicht zu groß sein. Rund 15 % unter deinem Verbrauch ist der süße Punkt für Definition: genug für Fortschritt, wenig genug, um Muskeln zu schützen.', 'Größere Defizite bringen schneller Gewicht runter, aber überproportional Muskel. Genau das willst du vermeiden.'] },
      { icon: '🛡️', title: 'Muskelschutz-Faktoren', paras: ['Drei Dinge schützen deinen Muskel im Defizit: genug Eiweiß, Krafttraining und ein moderates Tempo. Fehlt eines davon, leidet die Definition.', 'Deshalb ist ein „Definitions-Defizit" nie nur Kalorien sparen – es ist immer das Paket aus Essen und Training.'] },
      { icon: '🚫', title: 'Die Crash-Falle', paras: ['Sehr niedrige Kalorien fühlen sich nach „schnellem Erfolg" an, sabotieren aber dein Ziel: Muskelverlust, Kraftverlust im Training, schlechte Laune und fast garantiertes Jojo.', 'Lieber ein kleineres Defizit, das du Wochen durchhältst, als ein radikales, das nach zehn Tagen kippt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Adaptive Thermogenese & Muskel', paras: ['Bei zu großem oder zu langem Defizit fährt der Körper den Verbrauch herunter (adaptive Thermogenese) und baut eher Muskeln ab, um Energie zu sparen. Beides bremst die Definition.', 'Ein moderates Defizit mit viel Eiweiß und Krafttraining signalisiert dem Körper: „Muskeln werden gebraucht" – er greift dann eher aufs Fett zurück.', 'So arbeitest du mit deinem Stoffwechsel statt gegen ihn. Genau darum geht es in der Definitionsphase.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie groß sollte das Defizit für Definition etwa sein?', options: ['So groß wie möglich', 'Moderat, rund 15 % unter Verbrauch', 'Gar kein Defizit'], answer: 1, explain: 'Ein moderates Defizit (~15 %) schützt Muskeln und macht die Definition haltbar.' },
      { q: 'Was schützt deinen Muskel im Defizit NICHT?', options: ['Genug Eiweiß', 'Krafttraining', 'Ein radikaler Crash'], answer: 2, explain: 'Radikale Crashs kosten Muskeln. Muskelschutz = Eiweiß + Krafttraining + moderates Tempo.' },
    ],
    sources: ['Helms ER et al.: Evidence-based recommendations for natural bodybuilding contest prep', 'Rosenbaum M, Leibel RL: Adaptive Thermogenese', 'ISSN: Diet & Body Composition'],
    exercise: 'Schau dir dein Kalorienziel an und stell sicher, dass es sich moderat anfühlt (kein Hungern). Kombiniere es diese Woche fest mit deinen Trainingstagen.',
    habits: [
      { id: 'd3h1', text: 'Moderates Defizit einhalten (kein Crash)', cat: 'planung' },
      { id: 'd3h2', text: 'Krafttraining als Muskelschutz einplanen', cat: 'bewegung' },
    ],
  },
  {
    week: 4, title: 'Krafttraining trifft Ernährung', theme: 'Training', minutes: 8,
    teaser: 'Das Training gibt den Reiz, die Ernährung liefert die Bausteine – so greifen beide.',
    pages: [
      { icon: '🏋️', title: 'Der Reiz, der Muskeln hält', paras: ['Krafttraining ist im Defizit dein wichtigster Muskelschutz: Es sagt dem Körper „diese Muskeln werden gebraucht". Ohne diesen Reiz baut er sie eher ab.', 'Du musst kein Bodybuilder werden – 2–3 solide Krafteinheiten pro Woche reichen, um in der Definition den Muskel zu halten.'] },
      { icon: '🍽️', title: 'Essen rund ums Training', paras: ['Vor dem Training etwas Kohlenhydrate für Leistung, danach Eiweiß für die Regeneration – das unterstützt den Muskelerhalt. Ein exaktes „Zeitfenster" musst du nicht stressen, die Tagesmenge zählt mehr.', 'Wichtiger als Timing-Tricks: An Trainingstagen genug Eiweiß und genug Energie, um stark zu trainieren.'] },
      { icon: '📈', title: 'Kraft halten = Muskel halten', paras: ['Ein guter Indikator, ob du im Defizit deinen Muskel schützt: Bleibt deine Kraft ungefähr gleich? Dann läuft es. Bricht die Kraft stark ein, ist das Defizit oft zu aggressiv oder das Eiweiß zu niedrig.', 'Notiere dir grob deine wichtigsten Übungen. Stabile Leistung ist ein besseres Zeichen als jede Waage.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Mechanischer Reiz & Muskelerhalt', paras: ['Der Trainingsreiz (mechanische Spannung) aktiviert Signalwege, die den Muskelabbau bremsen und die Proteinsynthese anregen – selbst im Defizit. Eiweiß liefert das Material dafür.', 'Deshalb ist die Kombination so mächtig: Training + Eiweiß halten die stoffwechselaktive Muskelmasse, dein Grundumsatz bleibt oben, das Fett schmilzt gezielter.', 'Wenn du wissen willst, wie sich deine Muskelmasse über die Definitionsphase entwickelt, hilft eine Messung im Studio, den Fortschritt sichtbar zu machen.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Warum ist Krafttraining im Defizit so wichtig?', options: ['Es signalisiert „Muskeln werden gebraucht"', 'Es ersetzt das Eiweiß', 'Es macht das Defizit überflüssig'], answer: 0, explain: 'Der Trainingsreiz schützt die Muskeln im Defizit – ohne ihn baut der Körper sie eher ab.' },
      { q: 'Woran erkennst du, dass dein Muskel geschützt ist?', options: ['Deine Kraft bleibt ungefähr stabil', 'Die Waage sinkt schnell', 'Du hast ständig Hunger'], answer: 0, explain: 'Stabile Kraft ist ein gutes Zeichen für Muskelerhalt – bricht sie stark ein, ist das Defizit oft zu groß.' },
    ],
    sources: ['ISSN: Position Stand – Nutrient Timing (Kerksick et al.)', 'Literatur zu Krafttraining und Muskelerhalt im Kaloriendefizit', 'Helms ER et al.: Contest prep recommendations'],
    exercise: 'Plane 2–3 Krafteinheiten diese Woche, iss an diesen Tagen genug Eiweiß und notiere bei deinen Hauptübungen grob deine Leistung.',
    habits: [
      { id: 'd4h1', text: '2–3 Krafteinheiten diese Woche', cat: 'bewegung' },
      { id: 'd4h2', text: 'Nach dem Training Eiweiß', cat: 'protein' },
    ],
  },
  {
    week: 5, title: 'Kohlenhydrate für Leistung & Fülle', theme: 'Makros', minutes: 7,
    teaser: 'Kohlenhydrate sind in der Definition kein Feind – sie halten dich stark und die Muskeln voll.',
    pages: [
      { icon: '⚡', title: 'Treibstoff fürs Training', paras: ['Kohlenhydrate füllen deine Muskelspeicher (Glykogen) und geben dir Kraft im Training. Gerade im Defizit willst du stark bleiben, um Muskeln zu halten – dafür brauchst du Energie.', 'Deshalb streichen wir Kohlenhydrate nicht, wir timen sie klug: mehr rund ums Training, weniger an ruhigen Tagen.'] },
      { icon: '💪', title: 'Voller Muskel, bessere Optik', paras: ['Glykogen zieht Wasser in den Muskel – das lässt ihn voller und definierter wirken. Extrem-Low-Carb kann den Muskel „flach" aussehen lassen, obwohl du Fett verlierst.', 'Für Definition sind moderate Kohlenhydrate rund ums Training daher oft die bessere Wahl als sie komplett zu meiden.'] },
      { icon: '🌾', title: 'Qualität wählen', paras: ['Vollkorn, Kartoffeln, Reis, Haferflocken, Obst und Hülsenfrüchte halten länger satt und liefern Ballaststoffe. Schnellen Zucker sparst du dir eher für rund ums Training auf.', 'Du musst nichts verbieten – nur öfter die sättigende Variante wählen, dann bleibt die Bilanz im Ziel.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Glykogen, Leistung & Stoffwechsel', paras: ['Volle Glykogenspeicher bedeuten mehr Kraft und bessere Trainingsqualität – der Reiz, der deine Muskeln schützt. Dauerhaft sehr wenig Kohlenhydrate kann Leistung und Stoffwechsel-Hormone (u. a. aus der Schilddrüse) drücken.', 'Ein bewusster kohlenhydratreicherer Tag (rund ums Training) kann in einer längeren Diät helfen, Leistung und Hormone oben zu halten.', 'Für die meisten gilt: moderate Kohlenhydrate, klug getimt – das hält Training, Muskeln und Stoffwechsel in der Definition stabil.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum sind Kohlenhydrate in der Definition sinnvoll?', options: ['Sie halten dich im Training stark und den Muskel voll', 'Sie machen automatisch dick', 'Sie ersetzen Eiweiß'], answer: 0, explain: 'Kohlenhydrate füllen die Speicher, geben Trainingsleistung und lassen den Muskel voller wirken.' },
      { q: 'Wann sind Kohlenhydrate besonders sinnvoll?', options: ['Rund ums Training', 'Nur nachts', 'Nie'], answer: 0, explain: 'Rund ums Workout nutzt der Körper Kohlenhydrate direkt für Leistung und Regeneration.' },
    ],
    sources: ['ISSN: Nutrient Timing; Kohlenhydrate und Trainingsleistung', 'Literatur zu Glykogen, Muskelfülle und Low-Carb', 'Deutsche Gesellschaft für Ernährung (DGE): Kohlenhydrate'],
    exercise: 'Lege an deinen nächsten Trainingstagen die meisten Kohlenhydrate rund ums Workout und wähle einmal die sättigende Vollkorn-Variante.',
    habits: [
      { id: 'd5h1', text: 'Kohlenhydrate rund ums Training', cat: 'kohlenhydrate' },
      { id: 'd5h2', text: 'Sättigende Kohlenhydratquellen wählen', cat: 'kohlenhydrate' },
    ],
  },
  {
    week: 6, title: 'Körperkomposition statt Waage', theme: 'Fortschritt', minutes: 8,
    teaser: 'Bei Definition lügt die Waage besonders oft – so misst du echten Fortschritt.',
    pages: [
      { icon: '⚖️', title: 'Warum die Waage täuscht', paras: ['Beim Definieren kann dein Gewicht fast stehen, während du sichtbar straffer wirst – weil du Fett verlierst und Muskeln hältst oder aufbaust. Die Waage allein verrät das nicht.', 'Dazu schwankt das Gewicht täglich um 1–2 kg durch Wasser, Salz und Kohlenhydrate. Ein einzelner Wert sagt wenig; der Wochendurchschnitt zählt.'] },
      { icon: '📸', title: 'Miss die Definition', paras: ['Fotos im gleichen Licht, dein Spiegelbild, wie die Kleidung sitzt und der Taillenumfang zeigen deine Definition oft besser als jede Zahl.', 'Mach alle 2–4 Wochen ein Vergleichsfoto in gleicher Pose. Der Blick über Wochen ist ehrlicher als der tägliche.'] },
      { icon: '🔁', title: 'Recomposition ist normal', paras: ['Gerade zu Beginn und mit Krafttraining kannst du gleichzeitig Fett verlieren und etwas Muskel aufbauen – „Recomposition". Dann geht die Waage kaum runter, obwohl sich viel verändert.', 'Das ist kein Stillstand, sondern genau der Fortschritt, den du beim Definieren willst.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel vs. Fett – die Optik', paras: ['Ein Kilo Muskel braucht deutlich weniger Platz als ein Kilo Fett und formt den Körper. Deshalb kann die Optik top werden, während die Zahl auf der Waage steht.', 'Muskulatur ist außerdem stoffwechselaktiv: Mehr Muskel = höherer Grundumsatz = leichteres Fettabnehmen. Definition und Stoffwechsel arbeiten Hand in Hand.', 'Eine Körperanalyse im Studio trennt Fett und Muskel und macht sichtbar, was unter der Oberfläche wirklich passiert.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Warum kann die Waage beim Definieren stehen, obwohl du Fortschritt machst?', options: ['Du verlierst Fett und hältst/baust Muskel (Recomposition)', 'Weil du nichts tust', 'Weil Muskeln nichts wiegen'], answer: 0, explain: 'Fettverlust bei Muskelerhalt/-aufbau hält das Gewicht stabil, während die Form besser wird.' },
      { q: 'Was zeigt deine Definition am besten?', options: ['Fotos, Spiegel, Passform, Taille', 'Nur die Waage', 'Der Puls'], answer: 0, explain: 'Optik, Umfänge und Passform sagen mehr über Definition aus als die reine Zahl.' },
    ],
    sources: ['Literatur zu Body Recomposition', 'ISSN: Diet & Body Composition', 'Grundlagen der Körperzusammensetzung'],
    exercise: 'Mach ein Vergleichsfoto in gleicher Pose/gleichem Licht und miss deine Taille. Bewerte deinen Fortschritt an diesen, nicht nur an der Waage.',
    habits: [
      { id: 'd6h1', text: 'Wöchentlich Umfänge/Foto statt nur Waage', cat: 'tracking' },
      { id: 'd6h2', text: 'Nur Wochendurchschnitt bewerten', cat: 'mindset' },
    ],
  },
  {
    week: 7, title: 'Wasser, Salz & dein Tagesbild', theme: 'Verhalten', minutes: 7,
    teaser: 'Warum du an manchen Tagen „aufgeschwemmt" aussiehst – und es nichts mit Fett zu tun hat.',
    pages: [
      { icon: '💧', title: 'Wasser macht das Tagesbild', paras: ['Wie definiert du an einem Tag aussiehst, hängt stark vom Wasserhaushalt ab – nicht nur vom Fett. Ein salziges Essen, viele Kohlenhydrate oder schlechter Schlaf können dich am nächsten Morgen „voller" wirken lassen.', 'Das ist völlig normal und geht in ein paar Tagen von selbst zurück. Lass dich davon nicht verrückt machen.'] },
      { icon: '🧂', title: 'Salz clever handhaben', paras: ['Salz bindet Wasser – ein sehr salziger Tag zeigt sich oft als kurzfristige „Aufschwemmung" auf der Waage und im Spiegel. Kein Fett, nur Wasser.', 'Du musst Salz nicht meiden (dein Körper braucht es), aber wisse: Nach Pizza oder Restaurant ist die Waage am nächsten Tag kein echtes Signal.'] },
      { icon: '🚰', title: 'Genug trinken hilft', paras: ['Paradox, aber wahr: Wer genug trinkt, lagert eher weniger Wasser ein als jemand, der zu wenig trinkt. Ausreichend Wasser unterstützt außerdem Sättigung und Leistung.', 'Halte deine Trinkmenge konstant – so werden auch deine Tagesbilder vergleichbarer.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Wasser, Glykogen & die Waage', paras: ['Jedes Gramm Glykogen bindet Wasser. Isst du mehr Kohlenhydrate, speicherst du mehr Glykogen samt Wasser – die Waage steigt, obwohl kein Fett dazugekommen ist (und der Muskel sieht sogar voller aus).', 'Umgekehrt lässt ein kohlenhydratarmer Tag Wasser ab und die Zahl sinken – auch das ist kein echter Fettverlust.', 'Deshalb bewerten wir Fortschritt über Wochen und Umfänge, nicht über einzelne Tage. Der Stoffwechsel denkt langfristig, du auch.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum siehst du nach salzigem Essen „voller" aus?', options: ['Salz bindet kurzfristig Wasser', 'Du hast über Nacht Fett angesetzt', 'Deine Muskeln sind geschrumpft'], answer: 0, explain: 'Salz und Kohlenhydrate binden Wasser – das ist kein Fett und reguliert sich in ein paar Tagen.' },
      { q: 'Was ist beim täglichen Aussehen normal?', options: ['Es schwankt durch Wasser/Salz/Kohlenhydrate', 'Es ist jeden Tag exakt gleich', 'Nur Fett verändert es'], answer: 0, explain: 'Das Tagesbild schwankt v. a. durch den Wasserhaushalt – der Trend über Wochen zählt.' },
    ],
    sources: ['Literatur zu Natrium, Glykogen und Wassereinlagerung', 'Deutsche Gesellschaft für Ernährung (DGE): Wasser- und Elektrolythaushalt', 'Übersichtsarbeiten zu Körperwasser und Körperzusammensetzung'],
    exercise: 'Halte deine Trinkmenge diese Woche konstant und ignoriere bewusst die Waage am Tag nach einer salzigen/üppigen Mahlzeit.',
    habits: [
      { id: 'd7h1', text: 'Konstant genug trinken', cat: 'wasser' },
      { id: 'd7h2', text: 'Tages-Schwankungen gelassen nehmen', cat: 'mindset' },
    ],
  },
  {
    week: 8, title: 'Mahlzeiten-Rhythmus & Sättigung', theme: 'Umsetzung', minutes: 7,
    teaser: 'Wie du im Defizit satt bleibst und dein Eiweiß klug über den Tag verteilst.',
    pages: [
      { icon: '🕒', title: 'Finde deinen Rhythmus', paras: ['Ob 3 große oder 4–5 kleinere Mahlzeiten – für den Fettabbau zählt die Tagesbilanz, nicht die Anzahl. Wähle den Rhythmus, bei dem du am besten satt bleibst und dein Eiweiß triffst.', 'Viele in der Definition mögen 3–4 eiweißreiche Mahlzeiten: gute Sättigung, gute Verteilung fürs Muskelhalten.'] },
      { icon: '🥗', title: 'Volumen macht satt', paras: ['Setze auf voluminöse, kalorienarme Sattmacher: Gemüse, Salate, Suppen, mageres Eiweiß. Sie füllen den Magen bei wenig Kalorien – dein bester Trick gegen Hunger im Defizit.', 'Ein großer bunter Teller schlägt einen kleinen kalorienreichen – bei gleicher Bilanz wirst du deutlich satter.'] },
      { icon: '🍽️', title: 'Bewusst essen', paras: ['Langsamer essen, ohne Bildschirm, gründlich kauen – das Sättigungssignal braucht ~15 Minuten. So merkst du rechtzeitig, dass du genug hast.', 'Gerade wenn die Kalorien knapper sind, macht bewusstes Essen einen großen Unterschied für dein Sättigungsgefühl.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Sättigungssignale & Proteinverteilung', paras: ['Eiweiß und Ballaststoffe dämpfen Hunger-Hormone (Ghrelin) und stärken Sättigungssignale – deshalb halten eiweiß- und gemüsereiche Mahlzeiten so gut satt.', 'Eiweiß über den Tag zu verteilen versorgt außerdem die Muskel-Proteinsynthese gleichmäßiger – ein Plus fürs Muskelhalten im Defizit.', 'Kurz: Ein guter Rhythmus mit Eiweiß und Volumen arbeitet mit deinen Sättigungssignalen und schützt gleichzeitig den Muskel.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was entscheidet über den Fettabbau?', options: ['Die Anzahl der Mahlzeiten', 'Die Tagesbilanz', 'Die Uhrzeit'], answer: 1, explain: 'Die Kalorienbilanz über den Tag zählt – die Mahlzeitenanzahl ist Geschmackssache.' },
      { q: 'Was macht im Defizit besonders satt?', options: ['Voluminöse, kalorienarme Sattmacher + Eiweiß', 'Kleine kalorienreiche Snacks', 'Flüssige Kalorien'], answer: 0, explain: 'Gemüse, Salate und mageres Eiweiß füllen den Magen bei wenig Kalorien.' },
    ],
    sources: ['Übersichtsarbeiten zu Sättigung, Proteinverteilung und Energiedichte', 'ISSN: Meal Frequency', 'Deutsche Gesellschaft für Ernährung (DGE): Ernährungsverhalten'],
    exercise: 'Baue heute eine besonders voluminöse, eiweißreiche Mahlzeit (viel Gemüse + magere Eiweißquelle) und iss sie bewusst ohne Bildschirm.',
    habits: [
      { id: 'd8h1', text: 'Große Gemüse-/Volumenportion', cat: 'gemuese' },
      { id: 'd8h2', text: 'Eiweiß gleichmäßig verteilen', cat: 'protein' },
    ],
  },
  {
    week: 9, title: 'Fette für Hormone', theme: 'Makros', minutes: 7,
    teaser: 'Auch in der Definition brauchst du genug gute Fette – nur bewusst dosiert.',
    pages: [
      { icon: '🥑', title: 'Nicht zu wenig Fett', paras: ['In der Definition ist die Versuchung groß, Fett stark zu streichen, um Kalorien zu sparen. Aber Fett ist Baustoff für Hormone – zu wenig kann Hormonhaushalt und Wohlbefinden stören.', 'Ein sinnvoller Richtwert liegt bei etwa 0,8–1 g Fett pro kg Körpergewicht. Darunter dauerhaft zu gehen, lohnt sich selten.'] },
      { icon: '🫒', title: 'Gute Quellen, bewusst dosiert', paras: ['Olivenöl, Nüsse, Samen, Avocado und fetter Fisch liefern hochwertige Fette. Weil Fett energiedicht ist (9 kcal/g), machen kleine Mengen viel aus – abmessen statt frei gießen.', 'So bekommst du die gesundheitlichen Vorteile, ohne dass die Bilanz aus dem Ruder läuft.'] },
      { icon: '🐟', title: 'Omega-3 mitnehmen', paras: ['Fetter Fisch 1–2× pro Woche oder pflanzlich Lein-/Raps-/Walnussöl liefern Omega-3. Das unterstützt Herz, Gefäße und die Regeneration – gerade im Training wertvoll.', 'Ein kleiner, bewusster Fokus hier zahlt sich für Gesundheit und Erholung aus.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Fett, Hormone & Definition', paras: ['Fett ist die Grundlage vieler Hormone – auch solcher, die Muskelerhalt und Wohlbefinden beeinflussen. Ein zu radikaler Fettschnitt über lange Zeit kann sich negativ bemerkbar machen.', 'Etwas Fett hilft außerdem, die fettlöslichen Vitamine A, D, E, K aufzunehmen – wichtig, wenn die Gesamtmenge ohnehin knapper ist.', 'Genug gute Fette, bewusst dosiert, sind also kein Widerspruch zur Definition, sondern Teil einer klugen Diät.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum solltest du Fett in der Definition nicht zu stark streichen?', options: ['Fett ist Baustoff für Hormone', 'Fett hat keine Kalorien', 'Fett macht automatisch definiert'], answer: 0, explain: 'Zu wenig Fett kann den Hormonhaushalt stören – ein Mindestmaß (~0,8–1 g/kg) ist sinnvoll.' },
      { q: 'Wie dosierst du Fett clever?', options: ['Abmessen, weil es energiedicht ist', 'Frei über alles gießen', 'Komplett weglassen'], answer: 0, explain: 'Fett hat 9 kcal/g – kleine Mengen zählen viel, daher bewusst abmessen.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Fett und Fettsäuren', 'Literatur zu Fettzufuhr und Hormonen in der Diät', 'Leitlinien zu Omega-3 und Herz-Kreislauf'],
    exercise: 'Miss heute deine Fette bewusst ab (Öl, Nüsse) und baue eine Omega-3-Quelle ein – ohne die Fette komplett zu streichen.',
    habits: [
      { id: 'd9h1', text: 'Fette abmessen statt frei gießen', cat: 'fette' },
      { id: 'd9h2', text: 'Eine Omega-3-Quelle einbauen', cat: 'fette' },
    ],
  },
  {
    week: 10, title: 'Schlaf & Regeneration', theme: 'Verhalten', minutes: 7,
    teaser: 'Muskeln wachsen und bleiben in der Erholung – Schlaf ist dein unterschätzter Definitions-Helfer.',
    pages: [
      { icon: '😴', title: 'Schlaf schützt Muskeln', paras: ['Zu wenig Schlaf erschwert das Definieren gleich doppelt: mehr Hunger und Heißhunger, und schlechtere Erholung deiner Muskeln. Beides arbeitet gegen dein Ziel.', 'Guter Schlaf ist damit kein Luxus, sondern Teil deines Trainingsplans – die Erholung, in der der Muskel sich hält und aufbaut.'] },
      { icon: '🌀', title: 'Stress im Griff', paras: ['Dauerstress schüttet Cortisol aus, fördert Heißhunger auf Süßes und kann Wassereinlagerung begünstigen – die Waage steht, obwohl du alles richtig machst.', 'Ein Ventil (Spaziergang, Atmen, Training selbst) wirkt oft besser als jede zusätzliche Selbstkontrolle.'] },
      { icon: '🛌', title: 'Erholung aktiv gestalten', paras: ['Feste Schlafenszeit, dunkles kühles Zimmer, Bildschirm eine Stunde vorher runter, Koffein am Nachmittag meiden. Plane auch Ruhetage bewusst ein – Muskeln wachsen zwischen den Einheiten.', 'Wer hart trainiert und knapp isst, braucht Erholung umso mehr. Nimm sie ernst.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Hormone in der Nacht', paras: ['Schlafmangel senkt das Sättigungshormon Leptin und hebt das Hungerhormon Ghrelin – du isst mehr, ohne es zu merken. Gleichzeitig leidet die Regeneration, die deinen Muskel schützt.', 'Chronisch hohes Cortisol durch Stress kann Muskelabbau begünstigen und Wasser einlagern – doppelt ungünstig fürs Definieren.', 'Guter Schlaf und Stressabbau sind damit echte, oft unterschätzte Stoffwechsel- und Definitions-Hebel.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum ist Schlaf beim Definieren wichtig?', options: ['Weniger Hunger + bessere Muskel-Regeneration', 'Er ersetzt das Training', 'Er hat keinen Einfluss'], answer: 0, explain: 'Schlafmangel steigert Hunger und verschlechtert die Erholung – beides bremst die Definition.' },
      { q: 'Was hilft gegen Stress-Heißhunger am besten?', options: ['Ein Ventil (Bewegung, Atmen)', 'Mehr Selbstkontrolle erzwingen', 'Ganz auf Essen verzichten'], answer: 0, explain: 'Stress-Essen ist Biologie – ein Ventil wirkt besser als reine Willenskraft.' },
    ],
    sources: ['Spiegel K et al.: Schlafmangel und Appetit', 'Literatur zu Schlaf, Cortisol und Muskelregeneration', 'ISSN: Recovery'],
    exercise: 'Lege eine feste Schlafenszeit fest, plane einen echten Ruhetag ein und nimm dir ein Stress-Ventil für diese Woche vor.',
    habits: [
      { id: 'd10h1', text: 'Feste Schlafenszeit', cat: 'schlaf' },
      { id: 'd10h2', text: 'Regeneration/Ruhetag bewusst einplanen', cat: 'bewegung' },
    ],
  },
  {
    week: 11, title: 'Plateau & Feinschliff', theme: 'Stoffwechsel', minutes: 8,
    teaser: 'Wenn die Definition stockt: refeeds, Diätpausen und die richtigen Stellschrauben.',
    pages: [
      { icon: '⏸️', title: 'Plateaus gehören dazu', paras: ['In einer längeren Definitionsphase steht der Fortschritt irgendwann. Das ist normal – oft ist es kein „kaputter Stoffwechsel", sondern unbemerkt größere Portionen oder weniger Alltagsbewegung.', 'Erst ehrlich prüfen (3 Tage genaues Protokoll, Schritte), dann gezielt eine Stellschraube drehen – nicht panisch alles auf einmal.'] },
      { icon: '🍽️', title: 'Refeed & Diätpause', paras: ['Ein Refeed (1–2 Tage auf Erhaltung, mehr Kohlenhydrate) oder eine Diätpause (1–2 Wochen auf Erhaltung) geben Hormonen und Kopf eine Erholung – und bringen oft neuen Schwung.', 'Gerade beim Definieren, wo du lange im Defizit bist, sind geplante Pausen ein starkes Werkzeug gegen Plateaus.'] },
      { icon: '🔧', title: 'Die richtige Reihenfolge', paras: ['Bevor du das Defizit vergrößerst: Bewegung (NEAT, Schritte) hoch, Eiweiß hoch, Schlaf checken. Erst wenn das passt und es weiter stockt, das Defizit leicht nachschärfen.', 'Niemals radikal weniger essen – das kostet Muskeln und damit deine Definition.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Adaptive Thermogenese im Feinschliff', paras: ['Nach längerem Defizit fährt der Körper den Verbrauch etwas herunter (adaptive Thermogenese) und der Hunger steigt. Ein Refeed oder eine Pause können Sättigungssignale (Leptin) und Alltagsbewegung wieder anheben.', 'So durchbrichst du Plateaus, ohne den Muskel zu opfern. Muskelerhalt bleibt oberste Priorität – er ist dein Look und dein Motor.', 'Wie stark dein Stoffwechsel angepasst ist, lässt sich im Studio messen – dann schraubst du gezielt statt zu raten.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist der erste Schritt bei einem Plateau?', options: ['Ehrlich prüfen (Protokoll, Schritte), dann EINE Stellschraube', 'Sofort radikal weniger essen', 'Aufgeben'], answer: 0, explain: 'Erst prüfen, dann gezielt eine Sache ändern – nicht panisch alles auf einmal.' },
      { q: 'Wie hilft ein Refeed/eine Diätpause?', options: ['Hormone & NEAT wieder anheben, ohne Muskelverlust', 'Er verbrennt Fett direkt', 'Er ersetzt das Training'], answer: 0, explain: 'Geplante Pausen heben Leptin und Alltagsbewegung und schützen den Muskel – neuer Schwung ohne Crash.' },
    ],
    sources: ['Byrne HK et al. (2018): MATADOR – intermittierende Energierestriktion', 'Rosenbaum M, Leibel RL: Adaptive Thermogenese', 'Helms ER et al.: Contest prep recommendations'],
    exercise: 'Wenn es stockt: Führe 3 Tage ein genaues Protokoll, erhöhe deine Schritte – und plane bei Bedarf einen Refeed-Tag ein, statt das Defizit zu vergrößern.',
    habits: [
      { id: 'd11h1', text: 'NEAT/Schritte gezielt erhöhen', cat: 'bewegung' },
      { id: 'd11h2', text: 'Bei Plateau: Refeed statt Crash', cat: 'planung' },
    ],
  },
  {
    week: 12, title: 'Definition halten', theme: 'Nachhaltigkeit', minutes: 8,
    teaser: 'So sicherst du dein Ergebnis – und entscheidest, wie es weitergeht.',
    pages: [
      { icon: '🎯', title: 'Das Ergebnis sichern', paras: ['Definition zu erreichen ist das eine – sie zu halten das andere. Nach der Diätphase geht es nicht „zurück zu früher", sondern in einen bewussten Erhalt.', 'Du hast jetzt ein System: viel Eiweiß, Krafttraining, moderate Steuerung. Genau das trägt dich auch beim Halten.'] },
      { icon: '📈', title: 'Kalorien langsam anheben', paras: ['Erhöhe deine Kalorien nach der Diät schrittweise (Reverse-Gedanke), statt sofort viel mehr zu essen. Beobachte Gewicht und Optik 1–2 Wochen und taste dich an deine Erhaltungsmenge heran.', 'So vermeidest du, dass die mühsam erreichte Definition schnell wieder von einer Fettschicht verdeckt wird.'] },
      { icon: '🔀', title: 'Wie es weitergeht', paras: ['Du hast drei Optionen: die Definition halten, in eine leichte Aufbauphase wechseln (mehr Muskel für noch mehr Form), oder eine neue Zielsetzung angehen. Alle sind legitim.', 'Im Coaching geht es mit Vertiefungen und weiteren Staffeln weiter – du bist nicht „fertig", sondern startklar für die nächste Stufe.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel halten = Definition halten', paras: ['Deine Definition steht und fällt mit deiner Muskelmasse. Krafttraining und genug Eiweiß bleiben deshalb auch im Erhalt Pflicht – sonst verschwindet mit dem Muskel die Kontur.', 'Nach einer Diät ist der Verbrauch oft etwas niedriger (adaptive Thermogenese). Langsames Anheben und Muskelerhalt sind der Schlüssel, um das Ergebnis zu sichern.', 'Wenn du wissen willst, wo dein Stoffwechsel und deine Muskelmasse jetzt stehen und wie du gezielt weitermachst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Wie gehst du nach der Definitionsphase am besten vor?', options: ['Kalorien langsam anheben und beobachten', 'Sofort wieder essen wie früher', 'Für immer im Defizit bleiben'], answer: 0, explain: 'Langsames Anheben (Reverse-Gedanke) sichert das Ergebnis und findet deine Erhaltungsmenge.' },
      { q: 'Was hält deine Definition langfristig?', options: ['Muskel halten: Krafttraining + Eiweiß', 'Möglichst wenig essen', 'Die Waage meiden'], answer: 0, explain: 'Definition steht und fällt mit der Muskelmasse – Training und Eiweiß bleiben Pflicht.' },
    ],
    sources: ['Helms ER et al.: Recommendations for natural bodybuilding (auch Post-Diät)', 'Rosenbaum M, Leibel RL: Adaptive Thermogenese und Gewichtserhalt', 'ISSN: Diet & Body Composition'],
    exercise: 'Lege deine Strategie nach der Diät fest: Wie hebst du die Kalorien schrittweise an, und welche 2 Trainings-/Eiweiß-Gewohnheiten behältst du sicher bei?',
    habits: [
      { id: 'd12h1', text: 'Kalorien schrittweise anheben (kein Sprung)', cat: 'planung' },
      { id: 'd12h2', text: 'Krafttraining + Eiweiß beibehalten', cat: 'protein' },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════
//  Track „Aufbau" (Muskelaufbau) – 12-Wochen-Kern (eigener Content).
//  Fokus: Muskeln aufbauen mit moderatem Überschuss (Lean-Bulk), viel Eiweiß
//  (~1,8 g/kg), progressive Belastung, genug essen, Fettzuwachs minimieren.
//  Habit-IDs track-eindeutig (a…).
// ═══════════════════════════════════════════════════════════════════════
const AUFBAU = [
  {
    week: 1, title: 'Ankommen & Ziel „Aufbau" schärfen', theme: 'Grundlagen', minutes: 9,
    teaser: 'Was Muskelaufbau wirklich braucht – Überschuss, Reiz, Eiweiß und Geduld.',
    pages: [
      { icon: '👋', title: 'Willkommen zu deinem Aufbau-Coaching', paras: ['Schön, dass du da bist. Muskelaufbau ist ein Handwerk aus drei Zutaten: ein Trainingsreiz (progressive Belastung), genug Baustoff (Eiweiß) und etwas Energie-Überschuss. Dazu kommt die wichtigste: Geduld.', 'Wir bauen das Schritt für Schritt auf – ohne „dreckiges Bulken", bei dem du vor allem Fett ansetzt. Ziel ist ein sauberer, kontrollierter Aufbau.', 'Diese erste Einheit legt das Fundament und zeigt, warum dein Stoffwechsel dabei mitspielt.'] },
      { icon: '🧱', title: 'Die drei Bausteine', paras: ['1) Reiz: Krafttraining mit steigender Belastung fordert den Muskel zum Wachsen auf. 2) Baustoff: Eiweiß liefert die Aminosäuren. 3) Energie: ein moderater Kalorienüberschuss gibt dem Körper Material und Energie zum Aufbauen.', 'Fehlt einer dieser drei, stockt der Aufbau. Deshalb betrachten wir immer das ganze Paket, nicht nur „mehr essen".'] },
      { icon: '📈', title: 'Realistisches Tempo & die Waage', paras: ['Muskeln wachsen langsam: Für die meisten sind grob 0,2–0,5 kg Zunahme pro Woche sinnvoll – ein Teil davon Muskel, ein kleiner Teil Fett lässt sich kaum vermeiden.', 'Anders als beim Abnehmen SOLL die Waage hier leicht steigen. Zu schnell aber heißt vor allem Fett. Langsam und stetig gewinnt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel-Proteinsynthese – der Wachstumsmotor', paras: ['Nach dem Training steigt die Muskel-Proteinsynthese – der Prozess, in dem der Körper aus Aminosäuren neue Muskelbausteine baut. Genug Eiweiß und Energie halten diesen Prozess am Laufen.', 'Ein moderater Überschuss liefert die nötige Energie, ohne unnötig viel Fett anzusetzen. Dein Stoffwechsel bekommt „Baumaterial und Baugeld".', 'Wo du körperlich stehst – Muskelmasse, Stoffwechsel – lässt sich im Studio messen. Ein guter Startpunkt für deine Aufbaureise.'], cta: 'Stoffwechsel messen lassen' },
      { icon: '📓', title: 'So startest du diese Woche', paras: ['Beobachte diese Woche ehrlich: Wie viel isst du wirklich, und triffst du dein Eiweiß? Viele, die „nicht zunehmen", essen schlicht weniger, als sie denken.', 'Notiere außerdem deine wichtigsten Trainingsübungen mit Gewicht – das ist dein echter Fortschritts-Marker. Und mach ein Startfoto.', 'Am Ende der Woche wissen wir, wo wir ansetzen.'] },
    ],
    quiz: [
      { q: 'Welche drei Bausteine braucht Muskelaufbau?', options: ['Reiz (Training), Baustoff (Eiweiß), Energie (Überschuss)', 'Nur viel essen', 'Nur Supplemente'], answer: 0, explain: 'Training + Eiweiß + moderater Überschuss – fehlt einer, stockt der Aufbau.' },
      { q: 'Wie verhält sich die Waage beim Aufbau?', options: ['Sie soll leicht und stetig steigen', 'Sie muss sinken', 'Sie darf sich nie ändern'], answer: 0, explain: 'Ein moderater Zuwachs (~0,2–0,5 kg/Woche) ist gewollt – zu schnell bedeutet vor allem Fett.' },
    ],
    sources: ['ISSN: Position Stand – Protein and Exercise (Jäger et al., 2017)', 'Literatur zu Muskel-Proteinsynthese und Energiebilanz', 'Deutsche Gesellschaft für Ernährung (DGE): Referenzwerte'],
    exercise: 'Protokolliere ehrlich, wie viel du isst, prüfe dein Eiweiß, notiere deine Hauptübungen mit Gewicht und mach ein Startfoto.',
    habits: [
      { id: 'a1h1', text: 'Ehrlich protokollieren (isst du genug?)', cat: 'tracking' },
      { id: 'a1h2', text: 'Eiweiß im Blick behalten', cat: 'protein' },
      { id: 'a1h3', text: 'Trainingsgewichte notieren', cat: 'bewegung' },
    ],
  },
  {
    week: 2, title: 'Der moderate Überschuss', theme: 'Strategie', minutes: 8,
    teaser: 'Genug Energie zum Wachsen – aber nicht so viel, dass du unnötig Fett ansetzt.',
    pages: [
      { icon: '➕', title: 'Wie viel mehr?', paras: ['Für sauberen Aufbau reicht ein moderater Überschuss von rund 10–15 % über deinem Verbrauch. Das gibt genug Energie zum Muskelaufbau, hält den Fettzuwachs aber klein.', 'Die App rechnet dir das als Ziel aus. Dein Job: es zuverlässig treffen – auch nach oben, denn zu wenig essen bremst den Aufbau.'] },
      { icon: '🧹', title: 'Warum „Clean Bulk" schlägt „Dirty Bulk"', paras: ['„Dirty Bulk" (einfach alles reinschaufeln) bringt vor allem Fett, das du später mühsam wieder abbauen musst. Ein kontrollierter „Lean Bulk" baut Muskeln mit minimalem Fettzuwachs.', 'Der Muskel wächst nicht schneller, nur weil du 1.000 kcal drüber liegst – überschüssige Energie landet als Fett. Moderat ist effizienter.'] },
      { icon: '🍚', title: 'Qualität zählt auch im Überschuss', paras: ['Setze auf nährstoffreiche, sättigende Lebensmittel: Vollkorn, Kartoffeln, Reis, Haferflocken, Obst, Gemüse, gute Eiweißquellen. So bekommst du Energie plus Mikronährstoffe für Leistung und Regeneration.', 'Süßes und Fastfood sind nicht verboten, aber ein Überschuss aus echtem Essen tut deinem Training und deiner Gesundheit besser.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Überschuss, Aufbau & Fettzuwachs', paras: ['Ein Teil der überschüssigen Energie fließt in Muskelaufbau, ein Teil unweigerlich in Fett. Wie viel wohin geht, steuerst du über die Höhe des Überschusses und den Trainingsreiz.', 'Ein moderater Überschuss plus harter Trainingsreiz lenkt mehr Energie in den Muskel. Ein riesiger Überschuss ohne Reiz landet vor allem im Fettdepot.', 'Dein Stoffwechsel „entscheidet" also mit – und du lenkst ihn über Training und die richtige Menge. Eine Messung im Studio zeigt dir deinen Ausgangspunkt.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie groß sollte der Überschuss für sauberen Aufbau sein?', options: ['So groß wie möglich', 'Moderat, rund 10–15 % über Verbrauch', 'Gar kein Überschuss'], answer: 1, explain: 'Ein moderater Überschuss reicht zum Aufbau und hält den Fettzuwachs klein.' },
      { q: 'Warum ist „Dirty Bulk" ungünstig?', options: ['Er bringt vor allem Fett, das du später abbauen musst', 'Muskeln wachsen dadurch doppelt so schnell', 'Er spart Zeit'], answer: 0, explain: 'Überschüssige Energie über dem Bedarf landet als Fett – der Muskel wächst nicht schneller.' },
    ],
    sources: ['ISSN: Diet & Body Composition', 'Literatur zu Kalorienüberschuss und Muskel-/Fettzuwachs (z. B. Garthe et al.)', 'Deutsche Gesellschaft für Ernährung (DGE): Energiebedarf'],
    exercise: 'Stell sicher, dass du deinen (moderaten) Überschuss auch wirklich erreichst – baue bei Bedarf eine zusätzliche nährstoffreiche Mahlzeit ein.',
    habits: [
      { id: 'a2h1', text: 'Moderaten Überschuss zuverlässig treffen', cat: 'planung' },
      { id: 'a2h2', text: 'Überschuss aus echtem Essen', cat: 'kohlenhydrate' },
    ],
  },
  {
    week: 3, title: 'Eiweiß als Baustoff', theme: 'Makros', minutes: 7,
    teaser: 'Ohne genug Eiweiß kein Muskel – so deckst du deinen Baustoff-Bedarf.',
    pages: [
      { icon: '🍗', title: 'Der Baustoff schlechthin', paras: ['Muskeln bestehen aus Protein. Für den Aufbau sind rund 1,8 g Eiweiß pro kg Körpergewicht ein guter Richtwert – mehr bringt selten zusätzlichen Nutzen.', 'Ohne genug Eiweiß fehlt trotz Training und Überschuss schlicht das Material. Eiweiß ist die nicht verhandelbare Basis.'] },
      { icon: '📊', title: 'Über den Tag verteilen', paras: ['Verteil dein Eiweiß auf 3–5 Portionen à ~20–40 g. Das versorgt die Muskel-Proteinsynthese gleichmäßig – besser, als alles in einer Mahlzeit.', 'Eine Portion nach dem Training und eine vor dem Schlafen (z. B. Quark) sind sinnvolle Anker, ohne dass du es übertreiben musst.'] },
      { icon: '🥚', title: 'Gute Quellen', paras: ['Fleisch, Fisch, Eier, Milchprodukte (Quark, Skyr, Käse), Whey; pflanzlich Tofu, Tempeh, Sojaprodukte, Hülsenfrüchte, Seitan. Kombiniere pflanzliche Quellen für ein volles Aminosäureprofil.', 'Baue jede Mahlzeit um eine Eiweißquelle – so triffst du dein Ziel fast automatisch.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Eiweiß & Muskel-Proteinsynthese', paras: ['Die Aminosäure Leucin ist ein wichtiger Auslöser der Muskel-Proteinsynthese. Vollwertige Eiweißquellen liefern sie in guter Menge – ein Grund, warum Qualität und Menge des Eiweißes zählen.', 'Nach dem Training ist der Muskel besonders aufnahmebereit; eine Eiweißportion unterstützt dann die Reparatur und den Aufbau.', 'Kurz: Genug hochwertiges Eiweiß, klug verteilt, ist der Baustoff, aus dem dein Muskelwachstum entsteht.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie viel Eiweiß ist für Aufbau ein guter Richtwert?', options: ['Rund 1,8 g/kg Körpergewicht', '0,4 g/kg', 'So viel wie möglich, ohne Grenze'], answer: 0, explain: 'Etwa 1,8 g/kg deckt den Aufbau-Bedarf – deutlich mehr bringt selten Zusatznutzen.' },
      { q: 'Wie verteilst du Eiweiß am besten?', options: ['Auf 3–5 Portionen über den Tag', 'Alles in einer Mahlzeit', 'Nur morgens'], answer: 0, explain: 'Mehrere Portionen versorgen die Muskel-Proteinsynthese gleichmäßiger.' },
    ],
    sources: ['ISSN: Position Stand – Protein and Exercise (Jäger et al., 2017)', 'Morton RW et al. (2018): Meta-Analyse zu Protein und Krafttraining', 'Literatur zu Leucin und Muskel-Proteinsynthese'],
    exercise: 'Triff heute dein Eiweißziel und verteile es auf mind. 3 Portionen – eine davon nach dem Training.',
    habits: [
      { id: 'a3h1', text: 'Eiweißziel treffen (3–5 Portionen)', cat: 'protein' },
      { id: 'a3h2', text: 'Eiweiß nach dem Training', cat: 'protein' },
    ],
  },
  {
    week: 4, title: 'Kohlenhydrate: Treibstoff & Wachstum', theme: 'Makros', minutes: 7,
    teaser: 'Kohlenhydrate treiben dein Training an und schaffen ein anaboles Umfeld.',
    pages: [
      { icon: '⚡', title: 'Energie für harte Sätze', paras: ['Kohlenhydrate füllen deine Glykogenspeicher und geben dir die Energie für schwere, wachstumswirksame Sätze. Wer stark trainiert, setzt den besseren Wachstumsreiz.', 'Im Aufbau darfst du bei Kohlenhydraten großzügiger sein als beim Abnehmen – sie sind hier ein Verbündeter.'] },
      { icon: '🕒', title: 'Rund ums Training', paras: ['Lege einen guten Teil deiner Kohlenhydrate um dein Workout: vorher für Energie, nachher für die Auffüllung der Speicher und die Regeneration.', 'An trainingsfreien Tagen kannst du etwas zurückfahren – die Wochenmenge bleibt entscheidend.'] },
      { icon: '🌾', title: 'Sinnvolle Quellen', paras: ['Reis, Kartoffeln, Haferflocken, Vollkorn, Obst, Hülsenfrüchte liefern Energie plus Mikronährstoffe und Ballaststoffe. Gerade im Aufbau, wo die Mengen größer sind, hilft Qualität.', 'Schnelle Kohlenhydrate haben rund ums Training ihren Platz; im Alltag halten sättigende Quellen dich fitter.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Insulin – das anabole Signal', paras: ['Kohlenhydrate heben das Hormon Insulin. Insulin ist nicht nur ein Speicherhormon, sondern auch anti-katabol: Es hemmt den Muskelabbau und schleust Nährstoffe in die Muskelzelle.', 'Volle Glykogenspeicher lassen den Muskel zudem voller wirken und verbessern die Trainingsleistung – mehr Reiz, mehr Wachstum.', 'Deshalb sind Kohlenhydrate im Aufbau kein „notwendiges Übel", sondern Teil des anabolen Umfelds, das Muskeln wachsen lässt.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum sind Kohlenhydrate im Aufbau wertvoll?', options: ['Sie treiben das Training an und schaffen ein anaboles Umfeld', 'Sie bremsen den Muskelaufbau', 'Sie ersetzen Eiweiß'], answer: 0, explain: 'Kohlenhydrate liefern Trainingsenergie und heben Insulin (anti-katabol) – gut fürs Wachstum.' },
      { q: 'Wohin legst du viele Kohlenhydrate?', options: ['Rund ums Training', 'Nur spät nachts', 'Gar nicht essen'], answer: 0, explain: 'Rund ums Workout liefern sie Energie und füllen die Speicher für die Regeneration.' },
    ],
    sources: ['ISSN: Nutrient Timing (Kerksick et al.)', 'Literatur zu Insulin, Glykogen und Muskelaufbau', 'Deutsche Gesellschaft für Ernährung (DGE): Kohlenhydrate'],
    exercise: 'Lege an deinen nächsten Trainingstagen die meisten Kohlenhydrate um dein Workout und wähle überwiegend nährstoffreiche Quellen.',
    habits: [
      { id: 'a4h1', text: 'Kohlenhydrate rund ums Training', cat: 'kohlenhydrate' },
      { id: 'a4h2', text: 'Nährstoffreiche Kohlenhydratquellen', cat: 'kohlenhydrate' },
    ],
  },
  {
    week: 5, title: 'Progressive Belastung & Ernährung', theme: 'Training', minutes: 8,
    teaser: 'Ohne steigenden Reiz kein Wachstum – so unterstützt Ernährung dein Training.',
    pages: [
      { icon: '📶', title: 'Der wichtigste Wachstumsreiz', paras: ['Muskeln wachsen, wenn du sie über die Zeit forderst: mehr Gewicht, mehr Wiederholungen, bessere Ausführung – „progressive Belastung". Ohne diesen steigenden Reiz nützt der beste Überschuss wenig.', 'Ernährung ist der Verstärker: Sie liefert Energie und Baustoff, damit dein Körper auf den Reiz mit Wachstum antworten kann.'] },
      { icon: '📝', title: 'Fortschritt sichtbar machen', paras: ['Führe ein kurzes Trainingslog: Übung, Gewicht, Wiederholungen. Wenn diese Zahlen über Wochen steigen, baust du auf – ein ehrlicherer Marker als jedes Spiegelbild an einem einzelnen Tag.', 'Stagniert die Leistung, prüfe zuerst Ernährung (isst du genug? genug Eiweiß?), Schlaf und Programmgestaltung.'] },
      { icon: '🔗', title: 'Training & Teller greifen ineinander', paras: ['An harten Trainingstagen brauchst du Energie und Kohlenhydrate; nach dem Training Eiweiß für die Reparatur. So wird aus dem Reiz echtes Wachstum.', 'Ein starkes Training auf leerem, unterversorgtem Körper verschenkt Potenzial. Iss so, dass du deine Sätze voll ausschöpfen kannst.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Mechanische Spannung & Anpassung', paras: ['Der stärkste bekannte Wachstumsreiz ist mechanische Spannung – schweres, sauberes Training nahe der Belastungsgrenze. Der Körper passt sich an, indem er Muskelprotein aufbaut.', 'Diese Anpassung kostet Energie und Baustoff – genau das liefern Überschuss und Eiweiß. Training und Ernährung sind zwei Seiten derselben Medaille.', 'Wie effektiv dein Körper aufbaut, hängt auch von deinem Stoffwechsel ab – eine Messung im Studio kann helfen, dein Training und Essen fein abzustimmen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist der wichtigste Wachstumsreiz?', options: ['Progressive Belastung im Training', 'Nur viel essen', 'Möglichst lange Pausen'], answer: 0, explain: 'Ohne steigenden Trainingsreiz baut der Körper keinen Muskel auf – die Ernährung verstärkt ihn.' },
      { q: 'Was prüfst du zuerst, wenn die Leistung stagniert?', options: ['Ernährung (genug Energie/Eiweiß?), Schlaf, Programm', 'Sofort mehr Supplemente', 'Das Training abbrechen'], answer: 0, explain: 'Meist liegt es an zu wenig Essen/Eiweiß, Schlaf oder Programmgestaltung.' },
    ],
    sources: ['Schoenfeld BJ: Mechanismen der Muskelhypertrophie (Review)', 'ISSN: Diet & Body Composition', 'Literatur zu progressiver Belastung und Ernährung'],
    exercise: 'Führe diese Woche ein Trainingslog (Übung/Gewicht/Wiederholungen) und iss an Trainingstagen bewusst genug, um stark zu sein.',
    habits: [
      { id: 'a5h1', text: 'Trainingslog führen (Progression)', cat: 'bewegung' },
      { id: 'a5h2', text: 'Vor dem Training genug Energie', cat: 'kohlenhydrate' },
    ],
  },
  {
    week: 6, title: 'Fette & Hormone', theme: 'Makros', minutes: 7,
    teaser: 'Genug gute Fette halten deine Hormone im aufbaufreundlichen Bereich.',
    pages: [
      { icon: '🥑', title: 'Fett nicht vernachlässigen', paras: ['Auch im Aufbau brauchst du genug Fett – es ist Baustoff für Hormone (u. a. Testosteron), die den Muskelaufbau unterstützen. Ein Richtwert sind rund 0,8–1 g pro kg Körpergewicht.', 'Zu wenig Fett über lange Zeit kann den Hormonhaushalt und damit den Aufbau ausbremsen.'] },
      { icon: '🫒', title: 'Gute Quellen', paras: ['Olivenöl, Nüsse, Samen, Avocado, fetter Fisch und Eier liefern hochwertige Fette. Weil Fett energiedicht ist, helfen sie außerdem, den Überschuss zu erreichen, ohne riesige Portionen essen zu müssen.', 'Das ist im Aufbau ein Vorteil: Ein Löffel Nussmus oder eine Handvoll Nüsse bringt viele Kalorien in kleiner Menge.'] },
      { icon: '🐟', title: 'Omega-3 für Regeneration', paras: ['Fetter Fisch 1–2× pro Woche oder pflanzliche Öle (Lein, Raps, Walnuss) liefern Omega-3. Das wirkt entzündungshemmend und unterstützt die Regeneration nach hartem Training.', 'Gute Erholung heißt: häufiger und härter trainieren können – ein indirekter Aufbau-Booster.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Fett, Testosteron & Aufbau', paras: ['Cholesterin und Fettsäuren sind Ausgangsstoffe für Sexualhormone wie Testosteron, die den Muskelaufbau begünstigen. Sehr fettarme Ernährung über lange Zeit kann diese Hormone drücken.', 'Deshalb ist genug – aber nicht übermäßig – Fett Teil eines aufbaufreundlichen Hormonumfelds. Balance schlägt Extrem.', 'Wenn du deinen Stoffwechsel und deine Ausgangslage genau kennen willst, hilft eine Messung im Studio, dein Makro-Setup abzustimmen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum brauchst du im Aufbau genug Fett?', options: ['Fett ist Baustoff für aufbaufreundliche Hormone', 'Fett hat keine Kalorien', 'Fett ersetzt das Training'], answer: 0, explain: 'Zu wenig Fett kann Hormone wie Testosteron drücken – ein Mindestmaß (~0,8–1 g/kg) ist sinnvoll.' },
      { q: 'Warum sind Fette praktisch, um den Überschuss zu treffen?', options: ['Sie sind energiedicht – viel Energie in kleiner Menge', 'Sie sind kalorienfrei', 'Sie machen sofort satt für Stunden'], answer: 0, explain: 'Fett hat 9 kcal/g – Nüsse & Öle helfen, den Überschuss ohne riesige Portionen zu erreichen.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Fett und Fettsäuren', 'Literatur zu Fettzufuhr und Hormonen', 'Leitlinien zu Omega-3 und Regeneration'],
    exercise: 'Baue heute eine energiedichte gute Fettquelle ein (Nüsse, Nussmus, Öl, Avocado), um deinen Überschuss leichter zu erreichen – plus eine Omega-3-Quelle.',
    habits: [
      { id: 'a6h1', text: 'Gute Fettquelle für den Überschuss', cat: 'fette' },
      { id: 'a6h2', text: 'Omega-3 für Regeneration', cat: 'fette' },
    ],
  },
  {
    week: 7, title: 'Genug essen – die Kunst', theme: 'Umsetzung', minutes: 8,
    teaser: 'Viele „Hardgainer" essen einfach zu wenig – so schaffst du deinen Überschuss.',
    pages: [
      { icon: '🍽️', title: 'Das häufigste Problem', paras: ['„Ich esse so viel und nehme nicht zu" heißt fast immer: Es ist doch weniger, als es sich anfühlt. Große, sättigende Mahlzeiten fühlen sich üppig an, liefern aber oft weniger Energie als gedacht.', 'Die Lösung ist nicht „reinschaufeln", sondern clever mehr Energie unterzubringen.'] },
      { icon: '🥜', title: 'Energiedicht essen', paras: ['Nüsse, Nussmus, Öle, Trockenfrüchte, Vollmilch, Haferflocken, Avocado – kleine Mengen, viel Energie. Ideal, wenn große Portionen dich zu voll machen.', 'Ein Löffel Nussmus im Porridge oder eine Handvoll Nüsse als Snack bringt dich unauffällig näher an deinen Überschuss.'] },
      { icon: '🥤', title: 'Trinken als Turbo', paras: ['Wer feste Mengen kaum runterbekommt: Flüssige Kalorien sättigen weniger. Ein selbstgemachter Shake (Milch/Sojadrink, Haferflocken, Banane, Nussmus, Whey) bringt viel Energie und Eiweiß, ohne den Magen zu überlasten.', 'Auch eine zusätzliche kleine Mahlzeit oder ein Snack zwischendurch hilft, die Menge über den Tag zu verteilen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'NEAT & warum manche schwer zunehmen', paras: ['Wer schwer zunimmt, hat oft einen hohen Verbrauch durch viel unbewusste Alltagsbewegung (NEAT) – Zappeln, Gehen, Unruhe. Der Körper „verbrennt" den Überschuss teilweise über mehr Bewegung.', 'Das ist kein Defekt, sondern individuelle Regulation. Die Antwort ist ein etwas höherer, konsequent getroffener Überschuss – nicht Panik.', 'Eine Stoffwechselmessung im Studio zeigt deinen echten Bedarf – dann triffst du deinen Überschuss zielsicher statt zu raten.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist der häufigste Grund, „nicht zuzunehmen"?', options: ['Man isst weniger, als es sich anfühlt', 'Muskeln wiegen nichts', 'Der Körper speichert nie Energie'], answer: 0, explain: 'Sättigende Mahlzeiten fühlen sich üppig an, liefern aber oft weniger Energie als gedacht.' },
      { q: 'Wie bekommst du leichter mehr Energie unter?', options: ['Energiedicht essen + Shakes/flüssige Kalorien', 'Nur Salat essen', 'Mahlzeiten auslassen'], answer: 0, explain: 'Nüsse, Öle, Trockenobst und Shakes bringen viel Energie in kleiner, weniger sättigender Menge.' },
    ],
    sources: ['Levine JA: Non-Exercise Activity Thermogenesis (NEAT)', 'Literatur zu Energiedichte und Kalorienaufnahme', 'ISSN: Diet & Body Composition'],
    exercise: 'Baue heute gezielt energiedichte Kalorien ein (z. B. einen Shake oder Nussmus) und schau, ob du deinen Überschuss so leichter triffst.',
    habits: [
      { id: 'a7h1', text: 'Energiedichten Snack/Shake einbauen', cat: 'kohlenhydrate' },
      { id: 'a7h2', text: 'Eine Mahlzeit/Snack extra', cat: 'planung' },
    ],
  },
  {
    week: 8, title: 'Regeneration & Schlaf', theme: 'Verhalten', minutes: 7,
    teaser: 'Muskeln wachsen in der Erholung – Schlaf ist dein wichtigster Aufbau-Helfer.',
    pages: [
      { icon: '😴', title: 'Wachstum passiert in der Pause', paras: ['Im Training setzt du den Reiz – wachsen tut der Muskel danach, in der Erholung. Zu wenig Schlaf und Erholung bremsen den Aufbau, egal wie gut du isst und trainierst.', 'Schlaf ist damit kein „nice to have", sondern Teil deines Trainingsplans.'] },
      { icon: '🛌', title: 'Guter Schlaf, echte Ruhetage', paras: ['Ziel sind 7–9 Stunden Schlaf. Feste Zeiten, dunkles kühles Zimmer, Bildschirm vorher runter, Koffein am Nachmittag meiden. Und: Plane Ruhetage bewusst ein – der Muskel braucht sie.', 'Mehr Training ist nicht automatisch mehr Wachstum. Reiz und Erholung müssen zusammenpassen.'] },
      { icon: '🔁', title: 'Regeneration unterstützen', paras: ['Genug Eiweiß und Energie, Wasser, ein Eiweiß-Snack vor dem Schlafen (z. B. Quark) und Stressabbau helfen der Erholung. Leichte Bewegung an Ruhetagen fördert die Durchblutung.', 'Wer gut regeneriert, kann härter und häufiger trainieren – der eigentliche Aufbau-Turbo.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Schlaf, Wachstumshormon & Testosteron', paras: ['Im Tiefschlaf schüttet der Körper Wachstumshormon aus, und ausreichender Schlaf unterstützt einen gesunden Testosteronspiegel – beides begünstigt Muskelaufbau und Regeneration.', 'Chronischer Schlafmangel hebt Cortisol, was den Aufbau bremsen und den Abbau fördern kann. Schlaf ist also direkt anabol wirksam.', 'Guter Schlaf ist damit einer der stärksten, kostenlosen Aufbau-Hebel – oft unterschätzt.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wann wächst der Muskel?', options: ['In der Erholung nach dem Training', 'Nur während des Trainings', 'Nur beim Essen'], answer: 0, explain: 'Das Training setzt den Reiz – gewachsen wird in der Regeneration, deshalb ist Schlaf so wichtig.' },
      { q: 'Was passiert bei chronischem Schlafmangel?', options: ['Cortisol steigt, der Aufbau wird gebremst', 'Der Muskel wächst schneller', 'Nichts'], answer: 0, explain: 'Schlafmangel hebt Cortisol und drückt anabole Hormone – schlecht für den Aufbau.' },
    ],
    sources: ['Literatur zu Schlaf, Wachstumshormon und Testosteron', 'ISSN: Recovery', 'Übersichtsarbeiten zu Regeneration im Krafttraining'],
    exercise: 'Lege eine feste Schlafenszeit fest, plane einen echten Ruhetag ein und iss vor dem Schlafen eine Eiweißportion (z. B. Quark).',
    habits: [
      { id: 'a8h1', text: '7–9 Stunden Schlaf anpeilen', cat: 'schlaf' },
      { id: 'a8h2', text: 'Ruhetag bewusst einplanen', cat: 'bewegung' },
    ],
  },
  {
    week: 9, title: 'Fortschritt messen', theme: 'Fortschritt', minutes: 7,
    teaser: 'Baust du Muskeln – oder nur Fett? So liest du deinen Aufbau richtig.',
    pages: [
      { icon: '📈', title: 'Kraft ist dein bester Marker', paras: ['Der ehrlichste Aufbau-Marker ist deine Kraft: Steigen deine Gewichte und Wiederholungen über Wochen, baust du sehr wahrscheinlich Muskeln auf.', 'Deshalb ist das Trainingslog so wertvoll – es zeigt echten Fortschritt, den der Spiegel an einem einzelnen Tag nicht verrät.'] },
      { icon: '⚖️', title: 'Die Waage im Trend', paras: ['Ein moderater Anstieg (~0,2–0,5 kg/Woche) ist ideal. Steigt die Waage viel schneller, setzt du vor allem Fett an – dann den Überschuss etwas reduzieren.', 'Bewerte den Wochendurchschnitt, nicht den Tageswert – der schwankt durch Wasser und Kohlenhydrate.'] },
      { icon: '📏', title: 'Umfänge & Fotos', paras: ['Umfänge (Arm, Brust, Bein, Taille) und Fotos ergänzen das Bild. Wächst der Taillenumfang schneller als Arme und Beine, ist der Überschuss zu hoch.', 'So erkennst du früh, ob du zu „dirty" bulkst, und kannst gegensteuern.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel- vs. Fettzuwachs unterscheiden', paras: ['Gewichtszunahme allein sagt nicht, ob Muskel oder Fett dazukam. Kombiniert man Kraftfortschritt, Umfänge (v. a. Taille) und Fotos, lässt sich das recht gut abschätzen.', 'Steigt die Kraft und wachsen die Muskelgruppen, während die Taille stabil bleibt – ideal. Wächst vor allem die Taille, ist der Überschuss zu groß.', 'Eine Körperanalyse im Studio trennt Fett- und Muskelmasse und macht deinen Aufbau objektiv sichtbar.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Was ist der ehrlichste Aufbau-Marker?', options: ['Steigende Kraft über Wochen', 'Der Tageswert der Waage', 'Wie voll du dich fühlst'], answer: 0, explain: 'Wenn Gewichte und Wiederholungen steigen, baust du sehr wahrscheinlich Muskeln auf.' },
      { q: 'Was bedeutet ein sehr schneller Waagenanstieg?', options: ['Du setzt vor allem Fett an', 'Du baust doppelt so viel Muskel auf', 'Nichts'], answer: 0, explain: 'Zu schnelle Zunahme ist überwiegend Fett – dann den Überschuss etwas reduzieren.' },
    ],
    sources: ['Literatur zu Muskel-/Fettzuwachs bei unterschiedlichem Überschuss (Garthe et al.)', 'ISSN: Diet & Body Composition', 'Grundlagen der Körperzusammensetzung'],
    exercise: 'Vergleiche deine Trainingsgewichte mit den Vorwochen, wiege dich im Wochenschnitt und miss Arm/Bein/Taille – bewerte den Trend.',
    habits: [
      { id: 'a9h1', text: 'Kraftfortschritt im Log prüfen', cat: 'bewegung' },
      { id: 'a9h2', text: 'Waagen-Wochentrend + Umfänge', cat: 'tracking' },
    ],
  },
  {
    week: 10, title: 'Supplemente sinnvoll', theme: 'Ernährungswissen', minutes: 7,
    teaser: 'Was im Aufbau wirklich hilft – und was reines Marketing ist.',
    pages: [
      { icon: '🧾', title: 'Erst die Basics', paras: ['Kein Pulver ersetzt Training, Eiweiß, Überschuss und Schlaf. Supplemente sind das i-Tüpfelchen, nicht das Fundament. Wer die Basics nicht deckt, verschenkt Geld.', 'Die meisten „Mass Gainer" sind nur teurer Zucker – dieselbe Energie bekommst du günstiger aus echtem Essen oder einem selbstgemachten Shake.'] },
      { icon: '✅', title: 'Was belegt ist', paras: ['Kreatin (Monohydrat, ~3–5 g/Tag) ist das am besten untersuchte Supplement für Kraft und Muskelaufbau – günstig und sicher. Eiweißpulver (Whey oder pflanzlich) ist praktisch, um dein Eiweißziel zu treffen.', 'Koffein kann die Trainingsleistung kurzfristig steigern. Vitamin D (Winter) und Omega-3 je nach Versorgung – am besten an einem Bluttest orientieren.'] },
      { icon: '🛑', title: 'Spar dir den Rest', paras: ['BCAAs (wenn du genug Eiweiß isst), „Testo-Booster", exotische Pump-Mixe und die meisten Fatburner bringen für den Aufbau wenig bis nichts.', 'Investiere lieber in gutes Essen und Schlaf – das bringt mehr als jedes Wunder-Pulver.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Wie Kreatin wirkt', paras: ['Kreatin füllt die Kreatinphosphat-Speicher im Muskel – die schnelle Energiequelle für kurze, kräftige Anstrengungen. Das erlaubt oft ein, zwei Wiederholungen mehr, also mehr Trainingsreiz.', 'Es zieht außerdem etwas Wasser in die Muskelzelle (der Muskel wirkt voller) und unterstützt so ein wachstumsfreundliches Umfeld.', 'Kreatin ersetzt nichts, verstärkt aber die Basics – deshalb ist es das einzige „Muss-man-kennen"-Supplement für den Aufbau.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Welches Supplement ist für Aufbau am besten belegt?', options: ['Kreatin-Monohydrat', 'Der teuerste Testo-Booster', 'BCAAs bei ausreichend Eiweiß'], answer: 0, explain: 'Kreatin ist gut untersucht, günstig und sicher – es unterstützt Kraft und Aufbau.' },
      { q: 'Was sind die meisten „Mass Gainer"?', options: ['Vor allem teurer Zucker', 'Ein Wundermittel', 'Ersatz fürs Training'], answer: 0, explain: 'Dieselbe Energie bekommst du günstiger aus echtem Essen oder einem selbstgemachten Shake.' },
    ],
    sources: ['ISSN: Position Stand – Creatine (Kreider et al., 2017)', 'ISSN: Protein and Exercise', 'Verbraucherzentrale: Sportlernahrung und „Booster"'],
    exercise: 'Geh deine Supplemente ehrlich durch: Deckst du zuerst Training, Eiweiß, Überschuss und Schlaf? Wenn ja, ist Kreatin ein sinnvoller, günstiger Zusatz.',
    habits: [
      { id: 'a10h1', text: 'Basics vor Supplementen sichern', cat: 'planung' },
      { id: 'a10h2', text: 'Ggf. Kreatin täglich (3–5 g)', cat: 'protein' },
    ],
  },
  {
    week: 11, title: 'Wenn der Aufbau stockt', theme: 'Stoffwechsel', minutes: 8,
    teaser: 'Kein Kraft- und Gewichtszuwachs mehr? So bringst du den Aufbau wieder in Gang.',
    pages: [
      { icon: '⏸️', title: 'Plateaus gehören dazu', paras: ['Auch der Aufbau stockt mal: Kraft und Gewicht stehen. Erste Frage: Isst du wirklich im Überschuss? Wenn Kraft UND Gewicht stagnieren, ist die Energie oft zu knapp.', 'Ehrlich nachrechnen schlägt Bauchgefühl – gerade wenn NEAT und Appetit den Überschuss heimlich auffressen.'] },
      { icon: '➕', title: 'Kalorien nachjustieren', paras: ['Steht das Gewicht über 2–3 Wochen, erhöhe die Kalorien in kleinen Schritten (z. B. +150–250 kcal, vor allem Kohlenhydrate). Beobachte dann wieder Waage und Kraft.', 'Kleine Anpassungen, dann abwarten – nicht sofort 800 kcal draufpacken, das bringt nur Fett.'] },
      { icon: '🔧', title: 'Training & Erholung checken', paras: ['Steht die Kraft trotz Überschuss, liegt es oft am Training (zu wenig Progression, zu viel Volumen) oder an der Erholung (Schlaf, Stress, zu wenig Ruhetage).', 'Manchmal braucht der Körper eine leichtere Woche (Deload), um dann wieder stärker zuzulegen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Anpassung & Energieverfügbarkeit', paras: ['Wenn du zunimmst, steigt dein Verbrauch (ein größerer Körper braucht mehr Energie) – der alte Überschuss ist dann vielleicht keiner mehr. Deshalb muss man die Kalorien im Aufbau ab und zu nachziehen.', 'Gleichzeitig kann zu wenig Erholung die anabolen Signale dämpfen. Energie UND Regeneration müssen stimmen, damit der Aufbau weiterläuft.', 'Eine Stoffwechselmessung im Studio zeigt deinen aktuellen Bedarf – dann triffst du den nötigen Überschuss wieder genau.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Kraft UND Gewicht stehen – was ist die erste Frage?', options: ['Isst du wirklich im Überschuss?', 'Soll ich das Training aufgeben?', 'Brauche ich mehr Fatburner?'], answer: 0, explain: 'Stagnieren beide, ist die Energie oft zu knapp – ehrlich nachrechnen und moderat erhöhen.' },
      { q: 'Warum muss man Kalorien im Aufbau nachziehen?', options: ['Mit steigendem Gewicht steigt der Verbrauch', 'Weil Essen langweilig wird', 'Gar nicht'], answer: 0, explain: 'Ein größerer Körper verbraucht mehr – der alte Überschuss reicht irgendwann nicht mehr.' },
    ],
    sources: ['Literatur zu Energiebilanz und Gewichtszunahme', 'Schoenfeld BJ: Trainingsvariablen der Hypertrophie', 'ISSN: Diet & Body Composition'],
    exercise: 'Wenn es stockt: Rechne 3 Tage genau nach, ob du im Überschuss bist. Wenn ja und die Kraft steht, plane eine leichtere Trainingswoche (Deload).',
    habits: [
      { id: 'a11h1', text: 'Bei Stillstand Kalorien moderat +', cat: 'planung' },
      { id: 'a11h2', text: 'Erholung/Deload prüfen', cat: 'bewegung' },
    ],
  },
  {
    week: 12, title: 'Vom Aufbau zur Definition', theme: 'Nachhaltigkeit', minutes: 8,
    teaser: 'Muskeln behalten und sichtbar machen – so planst du Aufbau- und Diätphasen.',
    pages: [
      { icon: '🔁', title: 'Aufbau und Diät im Wechsel', paras: ['Muskelaufbau und Fettabbau laufen am besten in Phasen: eine Aufbauphase (Überschuss) baut Muskeln plus etwas Fett, eine anschließende Definitionsphase (moderates Defizit) macht sie sichtbar.', 'Dieses „Lean Bulk – Mini-Cut"-Prinzip ist der klassische Weg zu einem muskulösen, definierten Körper – Schritt für Schritt über Monate.'] },
      { icon: '🎯', title: 'Muskeln behalten in der Diät', paras: ['Wechselst du in eine Definitionsphase, gelten dieselben Regeln wie beim Definieren: moderates Defizit, viel Eiweiß, Krafttraining. So behältst du die aufgebauten Muskeln, während das Fett schmilzt.', 'Wichtig: Nicht zu radikal, sonst verlierst du genau die Muskeln, die du dir erarbeitet hast.'] },
      { icon: '🧭', title: 'Wie es weitergeht', paras: ['Entscheide bewusst: weiter aufbauen, in eine Definitionsphase wechseln, oder das Erreichte halten. Alle Wege sind legitim – Hauptsache, du hast einen Plan.', 'Im Coaching geht es mit Vertiefungen und weiteren Staffeln weiter – du bist nicht fertig, sondern bereit für die nächste Phase.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel als Stoffwechsel-Motor', paras: ['Jedes Kilo Muskel, das du aufbaust, hebt deinen Grundumsatz – du verbrennst rund um die Uhr mehr. Das macht spätere Definitionsphasen leichter und hilft, das Gewicht langfristig zu halten.', 'Der über Monate aufgebaute Muskel ist damit eine Investition, die sich in jeder folgenden Phase auszahlt – optisch und metabolisch.', 'Wenn du deinen Stoffwechsel und deine Körperzusammensetzung genau kennen willst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Wie werden aufgebaute Muskeln sichtbar?', options: ['In einer anschließenden Definitionsphase (moderates Defizit)', 'Durch noch mehr Überschuss', 'Durch Hungern'], answer: 0, explain: 'Aufbau bringt Muskel + etwas Fett; eine Definitionsphase macht die Muskeln sichtbar.' },
      { q: 'Warum ist aufgebauter Muskel eine gute „Investition"?', options: ['Er hebt den Grundumsatz – rund um die Uhr mehr Verbrauch', 'Er verschwindet sofort wieder', 'Er senkt den Stoffwechsel'], answer: 0, explain: 'Mehr Muskel = höherer Grundumsatz – das erleichtert Definition und Gewicht halten.' },
    ],
    sources: ['Literatur zu Bulk-/Cut-Zyklen und Körperzusammensetzung', 'Helms ER et al.: Empfehlungen für natürliche Athleten', 'Forschung zu Muskelmasse und Ruheenergieumsatz'],
    exercise: 'Plane deine nächste Phase: weiter aufbauen oder in eine Definition wechseln? Lege fest, welche 2 Gewohnheiten (Eiweiß, Krafttraining) du in jedem Fall behältst.',
    habits: [
      { id: 'a12h1', text: 'Nächste Phase bewusst planen', cat: 'planung' },
      { id: 'a12h2', text: 'Eiweiß + Krafttraining beibehalten', cat: 'protein' },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════
//  Track „Halten" (Gewicht halten) – 12-Wochen-Kern (eigener Content).
//  Fokus: Erhaltung als eigene Fähigkeit – Erhaltungsmenge finden, flexibel
//  essen, in einer Gewichts-Range bleiben, Gewohnheiten-Autopilot, Frühwarn-
//  system gegen schleichende Zunahme. Habit-IDs track-eindeutig (h…).
// ═══════════════════════════════════════════════════════════════════════
const HALTEN = [
  {
    week: 1, title: 'Ankommen & Ziel „Halten" schärfen', theme: 'Grundlagen', minutes: 8,
    teaser: 'Halten ist eine eigene Fähigkeit – locker im Rahmen bleiben, ohne Dauer-Diät.',
    pages: [
      { icon: '👋', title: 'Willkommen zu deinem Halte-Coaching', paras: ['Schön, dass du da bist. Dein Ziel ist kein Ab- oder Zunehmen, sondern das vielleicht Unterschätzteste von allen: dein Gewicht stabil halten – entspannt und dauerhaft.', 'Halten ist keine „Diät light", sondern eine eigene Fähigkeit: locker im Rahmen bleiben, genießen können und trotzdem nicht schleichend zunehmen. Genau das üben wir.', 'Diese erste Einheit legt das Fundament und zeigt, warum dein Stoffwechsel dabei ein Verbündeter ist.'] },
      { icon: '⚖️', title: 'Warum Halten unterschätzt wird', paras: ['Abnehmen kann fast jeder für ein paar Wochen. Das Ergebnis dann zu halten, schaffen viel weniger – nicht aus Faulheit, sondern weil Halten selten gezielt geübt wird.', 'Die gute Nachricht: Halten ist entspannter als jede Diät. Du hast mehr Spielraum, musst nichts streichen und arbeitest mit Gewohnheiten statt mit Verzicht.'] },
      { icon: '🎯', title: 'Dein Ziel: Stabilität mit Spielraum', paras: ['Halten heißt nicht, jeden Tag exakt gleich zu essen. Es heißt, über die Woche im Gleichgewicht zu bleiben – mal mehr, mal weniger, unterm Strich stabil.', 'Wir bauen ein System aus wenigen, verlässlichen Gewohnheiten und einem Frühwarnsystem, das kleine Abweichungen früh sichtbar macht.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Wie dein Körper das Gewicht verteidigt', paras: ['Dein Körper hat keinen starren „Set-Point", verteidigt sein Gewicht aber über Hunger und Verbrauch. Kleine Abweichungen gleicht er oft von selbst aus – ein Verbündeter beim Halten.', 'Größere Verschiebungen (dauerhaft mehr essen, weniger bewegen) kann er allerdings nicht ausgleichen. Genau da setzt dein Frühwarnsystem an.', 'Wo dein Stoffwechsel und deine Erhaltungsmenge liegen, lässt sich im Studio messen – eine gute Basis fürs stabile Halten.'], cta: 'Stoffwechsel messen lassen' },
      { icon: '📓', title: 'So startest du diese Woche', paras: ['Beobachte diese Woche einfach: Trag ehrlich ein, was du isst, und wiege dich an 2–3 Morgen unter gleichen Bedingungen. So bekommst du ein Gefühl für deinen Ist-Zustand.', 'Notiere dein aktuelles Gewicht als Ausgangspunkt und eine Wohlfühl-Range, in der du bleiben möchtest.', 'Am Ende der Woche kennst du deinen Startpunkt.'] },
    ],
    quiz: [
      { q: 'Was ist „Halten"?', options: ['Eine eigene Fähigkeit: stabil bleiben mit Spielraum', 'Eine strenge Dauer-Diät', 'Einfach nichts mehr tun'], answer: 0, explain: 'Halten heißt, über die Woche im Gleichgewicht zu bleiben – entspannt, ohne Verzicht.' },
      { q: 'Wie verteidigt dein Körper das Gewicht?', options: ['Über Hunger und Verbrauch (gleicht Kleines aus)', 'Er kann alles ausgleichen', 'Gar nicht'], answer: 0, explain: 'Kleine Abweichungen gleicht der Körper oft aus; größere, dauerhafte nicht – daher das Frühwarnsystem.' },
    ],
    sources: ['National Weight Control Registry: Merkmale erfolgreicher Gewichtserhaltung', 'Rosenbaum M, Leibel RL: Regulation des Körpergewichts', 'Deutsche Gesellschaft für Ernährung (DGE): Gewichtsmanagement'],
    exercise: 'Protokolliere ehrlich, wiege dich an 2–3 Morgen und lege dein Startgewicht plus eine Wohlfühl-Range fest.',
    habits: [
      { id: 'h1h1', text: 'Ehrlich protokollieren', cat: 'tracking' },
      { id: 'h1h2', text: 'Morgens unter gleichen Bedingungen wiegen', cat: 'tracking' },
    ],
  },
  {
    week: 2, title: 'Deine Erhaltungsmenge finden', theme: 'Strategie', minutes: 8,
    teaser: 'Die Kalorienzahl, bei der dein Gewicht stabil bleibt – so findest du sie.',
    pages: [
      { icon: '🔍', title: 'Was Erhaltung bedeutet', paras: ['Deine Erhaltungsmenge ist die Kalorienzahl, bei der dein Gewicht über Wochen stabil bleibt – nicht steigt, nicht fällt. Sie ist dein persönlicher Ankerwert.', 'Die App schätzt sie dir. Der echte Wert zeigt sich aber erst in der Praxis: über deinen Gewichtsverlauf.'] },
      { icon: '📊', title: 'So tastest du dich heran', paras: ['Iss 1–2 Wochen ungefähr auf deiner geschätzten Erhaltung und beobachte den Wochendurchschnitt deines Gewichts. Bleibt er stabil, passt es. Steigt er, etwas weniger; fällt er, etwas mehr.', 'Kleine Anpassungen (±100–200 kcal), dann wieder beobachten. So findest du deine echte Erhaltungsmenge, ohne zu raten.'] },
      { icon: '🧭', title: 'Erhaltung ist kein starrer Wert', paras: ['Deine Erhaltungsmenge schwankt mit Bewegung, Stress, Schlaf und Jahreszeit. Sieh sie als Korridor, nicht als exakte Zahl.', 'Genau deshalb arbeiten wir mit einer Gewichts-Range und beobachten den Trend – statt jeder Kalorie hinterherzujagen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'TDEE – dein Gesamtverbrauch', paras: ['Deine Erhaltungsmenge entspricht deinem Gesamtverbrauch (TDEE): Grundumsatz + Alltagsbewegung (NEAT) + Training + Verdauung. Der Grundumsatz macht den größten Teil aus.', 'Weil vor allem NEAT und Bewegung schwanken, schwankt auch dein Verbrauch von Tag zu Tag – die Erhaltung ist ein Bereich, kein Fixpunkt.', 'Deinen tatsächlichen Verbrauch kann eine Stoffwechselmessung im Studio bestimmen – die genaueste Basis, um deine Erhaltung festzulegen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist deine Erhaltungsmenge?', options: ['Kalorien, bei denen dein Gewicht stabil bleibt', 'Möglichst wenig Kalorien', 'Die Kalorien deiner größten Mahlzeit'], answer: 0, explain: 'Bei der Erhaltungsmenge bleibt dein Gewicht über Wochen konstant – dein Ankerwert.' },
      { q: 'Wie findest du sie in der Praxis?', options: ['Gewichtsverlauf beobachten und in kleinen Schritten anpassen', 'Einmal raten und nie ändern', 'Gar nicht essen'], answer: 0, explain: 'Über 1–2 Wochen den Wochenschnitt beobachten und um ±100–200 kcal justieren.' },
    ],
    sources: ['Hall KD: Dynamik der Energiebilanz', 'Mifflin MD, St Jeor ST et al. (1990): Grundumsatz-Schätzformel', 'Levine JA: NEAT'],
    exercise: 'Iss diese Woche ungefähr auf deiner geschätzten Erhaltung und beobachte deinen Gewichts-Wochenschnitt – justiere bei klarer Tendenz leicht nach.',
    habits: [
      { id: 'h2h1', text: 'Auf Erhaltungsniveau essen', cat: 'planung' },
      { id: 'h2h2', text: 'Gewichts-Wochenschnitt beobachten', cat: 'tracking' },
    ],
  },
  {
    week: 3, title: 'Flexibel essen ohne Diät', theme: 'Verhalten', minutes: 7,
    teaser: 'Die 80/20-Regel: solide Basis plus Genuss – so hält sich Gewicht von selbst.',
    pages: [
      { icon: '🎯', title: 'Flexibel statt streng', paras: ['Beim Halten brauchst du keine Verbote. Es gilt die 80/20-Regel: rund 80 % nährstoffreiche Basis, 20 % bewusster Genuss. Das hält ein Leben lang – im Gegensatz zu strengen Regeln.', 'Flexible Kontrolle (Spielraum lassen) hält Gewicht langfristig besser stabil als rigide Kontrolle (alles oder nichts).'] },
      { icon: '🍫', title: 'Genuss fest einplanen', paras: ['Was du dir bewusst gönnst, löst keinen Heißhunger aus. Plane deine Lieblingssachen ein, statt sie zu verbieten und dann „auszurutschen".', 'Ein Stück Kuchen am Nachmittag oder Pizza am Wochenende haben in einer ausgeglichenen Woche problemlos Platz.'] },
      { icon: '🥗', title: 'Die solide Basis', paras: ['Deine 80 % sind das, was dich satt und versorgt hält: Gemüse, Obst, Eiweiß, Vollkorn, gute Fette. Steht diese Basis, verzeiht der Rest viel.', 'So musst du nicht zählen – die Struktur trägt dich, auch ohne ständige Kontrolle.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Der Körper bilanziert über die Woche', paras: ['Dein Stoffwechsel denkt nicht in einzelnen Mahlzeiten, sondern über Tage und Wochen. Ein üppiger Abend verschwindet im Wochendurchschnitt, wenn du danach normal weitermachst.', 'Deshalb funktioniert flexibles Essen: Nicht der einzelne Tag zählt, sondern die Bilanz über die Woche. Das nimmt den Druck raus.', 'Ein stabiler, gut versorgter Stoffwechsel macht das Halten leichter – Genuss inklusive.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was besagt die 80/20-Regel?', options: ['~80 % solide Basis, 20 % bewusster Genuss', 'Nie etwas Süßes', '80 % Sport, 20 % Essen'], answer: 0, explain: 'Eine solide Basis plus eingeplanter Genuss hält Gewicht dauerhaft und alltagstauglich.' },
      { q: 'Was hält Gewicht langfristig besser?', options: ['Flexible Kontrolle mit Spielraum', 'Rigide Alles-oder-nichts-Regeln', 'Ständiges Verbieten'], answer: 0, explain: 'Flexible Kontrolle ist haltbarer als rigide – sie verhindert den Verzicht-Heißhunger-Kreislauf.' },
    ],
    sources: ['Literatur zu flexibler vs. rigider Kontrolle des Essverhaltens', 'Deutsche Gesellschaft für Ernährung (DGE): Ernährungsverhalten', 'National Weight Control Registry'],
    exercise: 'Plane diese Woche bewusst 1–2 Genuss-Momente fest ein und halte an den übrigen Tagen deine solide Basis.',
    habits: [
      { id: 'h3h1', text: 'Solide Basis an den meisten Tagen', cat: 'gemuese' },
      { id: 'h3h2', text: 'Genuss bewusst einplanen', cat: 'mindset' },
    ],
  },
  {
    week: 4, title: 'Eiweiß & Muskeln halten', theme: 'Makros', minutes: 7,
    teaser: 'Auch beim Halten schützt Eiweiß deine Muskeln – und macht satt.',
    pages: [
      { icon: '🍗', title: 'Warum Eiweiß wichtig bleibt', paras: ['Auch ohne Ab- oder Aufbau brauchst du genug Eiweiß: Es hält deine Muskeln, macht satt und stabilisiert so dein Gewicht. Ein Richtwert von rund 1,4–1,6 g/kg ist beim Halten sinnvoll.', 'Muskeln zu halten heißt auch, deinen Grundumsatz zu halten – das macht das Gewicht-Halten leichter.'] },
      { icon: '🏋️', title: 'Bewegung schützt mit', paras: ['Eiweiß allein hält Muskeln nur bedingt – der Reiz kommt aus Bewegung. Krafttraining oder körperliche Aktivität 2× pro Woche signalisiert dem Körper, die Muskeln zu behalten.', 'Gerade mit den Jahren ist das wichtig: Ohne Reiz baut der Körper langsam Muskeln ab, auch bei stabilem Gewicht.'] },
      { icon: '🥚', title: 'Einfach umsetzen', paras: ['Eine Handfläche Eiweiß zu jeder Hauptmahlzeit – Quark, Eier, Fisch, Fleisch, Hülsenfrüchte, Tofu. So triffst du deinen Bedarf fast automatisch, ohne zu rechnen.', 'Das Sättigungs-Plus hilft dir zusätzlich, nicht schleichend mehr zu essen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskeln = stabiler Stoffwechsel', paras: ['Muskulatur ist stoffwechselaktiv: Sie hält deinen Grundumsatz oben. Wer Muskeln verliert, senkt langsam seinen Verbrauch – und muss immer weniger essen, um das Gewicht zu halten.', 'Genug Eiweiß plus Bewegung schützt diese Muskeln und damit deinen Verbrauch. Halten wird so einfacher, nicht schwerer.', 'Wie viel Muskelmasse du hast, lässt sich im Studio messen – gerade beim langfristigen Halten eine wertvolle Info.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Warum ist Eiweiß auch beim Halten wichtig?', options: ['Es hält Muskeln, macht satt, stabilisiert das Gewicht', 'Es hat keine Kalorien', 'Es ist nur beim Abnehmen nötig'], answer: 0, explain: 'Eiweiß schützt Muskeln (= Grundumsatz) und sättigt – beides hilft beim Halten.' },
      { q: 'Was hält Muskeln zusätzlich?', options: ['Bewegung/Krafttraining als Reiz', 'Nur Eiweiß, ohne Bewegung', 'Möglichst wenig Aktivität'], answer: 0, explain: 'Ohne Reiz baut der Körper Muskeln ab – Bewegung signalisiert, sie zu behalten.' },
    ],
    sources: ['ISSN: Protein and Exercise', 'Bauer J et al. (PROT-AGE): Eiweiß und Muskelerhalt', 'Forschung zu Muskelmasse und Ruheenergieumsatz'],
    exercise: 'Bau zu jeder Hauptmahlzeit eine Eiweißquelle ein und plane 2 Bewegungs-/Krafteinheiten für diese Woche.',
    habits: [
      { id: 'h4h1', text: 'Eiweiß zu jeder Hauptmahlzeit', cat: 'protein' },
      { id: 'h4h2', text: '2× Bewegung/Kraft als Muskelreiz', cat: 'bewegung' },
    ],
  },
  {
    week: 5, title: 'Die Gewichts-Range statt fixer Zahl', theme: 'Verhalten', minutes: 7,
    teaser: 'Dein Gewicht schwankt täglich – arbeite mit einem Bereich, nicht mit einer Zahl.',
    pages: [
      { icon: '📉', title: 'Warum eine Range?', paras: ['Dein Gewicht schwankt täglich um 1–2 kg durch Wasser, Salz, Kohlenhydrate und Verdauung. Eine einzelne Zahl zum Ziel zu machen, macht nur verrückt.', 'Definiere stattdessen eine Wohlfühl-Range von etwa 2–3 kg. Solange du darin bleibst, ist alles gut.'] },
      { icon: '📅', title: 'Wochenschnitt statt Tageswert', paras: ['Wiege dich am besten mehrmals pro Woche morgens und schau auf den Wochendurchschnitt. Der Trend über Wochen ist die einzige Zahl, die wirklich zählt.', 'Ein hoher Tageswert nach salzigem Essen ist kein Grund zur Panik – meist ist es Wasser, das in ein paar Tagen wieder verschwindet.'] },
      { icon: '🚦', title: 'An den Rändern handeln', paras: ['Solange du in der Range bist: einfach weiterleben. Kratzt der Wochenschnitt über Wochen an der oberen Grenze, ziehst du sanft die Zügel an (etwas mehr Bewegung, etwas bewusster essen).', 'Dieses „Handeln an den Rändern" ist der ganze Trick des Haltens – kein Dauer-Zählen, nur gelegentliches Nachjustieren.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Wasser & warum die Waage springt', paras: ['Kohlenhydrate und Salz binden Wasser. Ein kohlenhydratreicher oder salziger Tag lässt die Waage steigen – ohne dass Fett dazukam. Am nächsten Tag ist es oft wieder weg.', 'Deshalb ist der Tageswert fast bedeutungslos und der Wochentrend aussagekräftig. Dein Stoffwechsel reguliert Wasser ständig.', 'Wer das versteht, bleibt gelassen und trifft Entscheidungen auf Basis des Trends – nicht der Tagesform.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum arbeitest du mit einer Gewichts-Range?', options: ['Weil das Gewicht täglich um 1–2 kg schwankt', 'Weil Waagen ungenau sind', 'Weil Gewicht egal ist'], answer: 0, explain: 'Tägliche Schwankungen sind normal – eine Range von 2–3 kg nimmt den Druck raus.' },
      { q: 'Wann handelst du beim Halten?', options: ['Wenn der Wochentrend an die obere Grenze kratzt', 'Bei jedem hohen Tageswert', 'Nie'], answer: 0, explain: 'An den Rändern der Range sanft nachjustieren – kein Dauer-Zählen nötig.' },
    ],
    sources: ['Literatur zu Körpergewichtsschwankungen und Wasserhaushalt', 'National Weight Control Registry: Selbst-Monitoring', 'Deutsche Gesellschaft für Ernährung (DGE): Gewichtsmanagement'],
    exercise: 'Lege deine 2–3 kg Wohlfühl-Range fest, wiege dich mehrmals und bewerte nur den Wochenschnitt.',
    habits: [
      { id: 'h5h1', text: 'In der Wohlfühl-Range bleiben', cat: 'mindset' },
      { id: 'h5h2', text: 'Nur Wochentrend bewerten', cat: 'tracking' },
    ],
  },
  {
    week: 6, title: 'Gewohnheiten als Autopilot', theme: 'Umsetzung', minutes: 7,
    teaser: 'Halten gelingt, wenn gute Entscheidungen automatisch passieren.',
    pages: [
      { icon: '🔄', title: 'Vom Nachdenken zum Automatismus', paras: ['Dauerhaft halten schaffst du nicht mit Willenskraft, sondern mit Gewohnheiten, die von selbst laufen. Was automatisch passiert, kostet keine Energie.', 'Deshalb bauen wir wenige, verlässliche Routinen, die dein Gewicht ohne ständiges Nachdenken stabil halten.'] },
      { icon: '🏅', title: 'Deine Anker-Gewohnheiten', paras: ['Überlege, welche 3–4 Gewohnheiten bei dir am meisten bewirken: z. B. Eiweiß zu jeder Mahlzeit, ein Gemüse-Anteil, wöchentliches Wiegen, tägliche Bewegung.', 'Diese Anker hältst du auch in stressigen Phasen. Alles andere darf mal pausieren – die Anker tragen dich.'] },
      { icon: '🏠', title: 'Umgebung schlägt Willenskraft', paras: ['Was griffbereit ist, wird gegessen. Mach die gute Wahl zur einfachen: gesunde Snacks sichtbar, Süßes weniger präsent, mit Einkaufsliste einkaufen.', 'So triffst du gute Entscheidungen einmal (beim Einkauf) statt zehnmal am Tag unter Druck.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Alltagsbewegung als stiller Regler', paras: ['Ein großer, oft unbewusster Teil deines Verbrauchs ist NEAT – Alltagsbewegung wie Gehen, Stehen, Treppen. Als Gewohnheit verankert, hält sie deinen Verbrauch stabil, ganz ohne Sport-Stress.', 'Wenige tausend Schritte als feste Routine gleichen viele kleine Alltags-Extras aus – ein stiller, angenehmer Regler fürs Halten.', 'So arbeitet dein Stoffwechsel im Autopilot für dich, wenn die Gewohnheiten sitzen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was trägt dich beim Halten langfristig?', options: ['Automatische Gewohnheiten', 'Dauerhafte Willenskraft', 'Strenge Verbote'], answer: 0, explain: 'Gewohnheiten laufen von selbst und kosten keine Energie – Willenskraft schwankt.' },
      { q: 'Warum ist die Umgebung so wichtig?', options: ['Was griffbereit ist, wird gegessen', 'Sie hat keinen Einfluss', 'Nur Kalorien zählen'], answer: 0, explain: 'Die gute Wahl zur einfachen machen – dann triffst du sie automatisch.' },
    ],
    sources: ['Lally P et al. (2010): Habit Formation', 'Wood W, Neal DT: Psychologie der Gewohnheit', 'Levine JA: NEAT'],
    exercise: 'Wähle deine 3–4 Anker-Gewohnheiten fürs Halten und richte deine Umgebung so ein, dass die gute Wahl die einfache ist.',
    habits: [
      { id: 'h6h1', text: 'Anker-Gewohnheiten täglich halten', cat: 'mindset' },
      { id: 'h6h2', text: 'Täglich Schritte/Alltagsbewegung', cat: 'bewegung' },
    ],
  },
  {
    week: 7, title: 'Portionen & Augenmaß', theme: 'Verhalten', minutes: 7,
    teaser: 'Ohne ewiges Wiegen im Rahmen bleiben – mit der Hand als Maß.',
    pages: [
      { icon: '✋', title: 'Die Hand als Maß', paras: ['Du musst nicht ewig Kalorien zählen. Eine einfache Faustregel: eine Handfläche Eiweiß, eine Faust Gemüse, eine hohle Hand Kohlenhydrate, ein Daumen Fett pro Mahlzeit.', 'Das passt sich automatisch an deine Größe an und liefert dir ohne Waage eine solide Portionsgröße.'] },
      { icon: '🍽️', title: 'Teller-Prinzip', paras: ['Ein einfaches Bild: die Hälfte des Tellers Gemüse/Salat, ein Viertel Eiweiß, ein Viertel Kohlenhydrate. Das hält Kalorien und Sättigung fast von allein im Gleichgewicht.', 'So brauchst du keine App im Alltag – nur beim Feinjustieren mal kurz genauer hinschauen.'] },
      { icon: '👀', title: 'Ehrlich bleiben', paras: ['Augenmaß funktioniert, solange du ehrlich bist. Die üblichen Unterschätzer bleiben Öle, Nüsse, Käse und Getränke – hier lohnt gelegentlich ein prüfender Blick.', 'Wenn die Range über Wochen wandert, kurz genauer messen, justieren, dann wieder aufs Augenmaß zurück.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Energiedichte im Blick', paras: ['Augenmaß klappt besser, wenn du die Energiedichte kennst: Gemüse, Obst und mageres Eiweiß sind kalorienarm (viel Volumen), Öle/Nüsse/Süßes energiedicht (wenig Volumen, viel Energie).', 'Wer den Teller mit sättigenden, kalorienärmeren Lebensmitteln füllt und Energiedichtes bewusst dosiert, bleibt fast automatisch im Rahmen.', 'So hältst du dein Gewicht mit Augenmaß statt Rechnerei – der Stoffwechsel dankt die Konstanz.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie schätzt du Portionen ohne Waage?', options: ['Mit der Hand als Maß (Handfläche/Faust/hohle Hand/Daumen)', 'Gar nicht möglich', 'Immer nur nach Gefühl raten'], answer: 0, explain: 'Die Hand passt sich deiner Größe an und liefert solide Portionsgrößen ohne Waage.' },
      { q: 'Welche Lebensmittel werden beim Augenmaß am ehesten unterschätzt?', options: ['Öle, Nüsse, Käse, Getränke', 'Gemüse und Wasser', 'Magerquark'], answer: 0, explain: 'Energiedichtes wird oft unterschätzt – hier lohnt gelegentlich ein prüfender Blick.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Portionsgrößen (Handmaß)', 'Literatur zu Energiedichte und Sättigung', 'Forschung zu Portionsgröße und Kalorienaufnahme'],
    exercise: 'Stelle heute deine Teller nach dem Handmaß/Teller-Prinzip zusammen und wirf einen ehrlichen Blick auf Öle und Getränke.',
    habits: [
      { id: 'h7h1', text: 'Portionen per Handmaß', cat: 'achtsamkeit' },
      { id: 'h7h2', text: 'Teller: halb Gemüse', cat: 'gemuese' },
    ],
  },
  {
    week: 8, title: 'Anlässe, Urlaub & wieder einsteigen', theme: 'Umsetzung', minutes: 7,
    teaser: 'Feiern und Urlaub gehören dazu – so bleibst du entspannt im Rahmen.',
    pages: [
      { icon: '🎉', title: 'Genießen ohne Reue', paras: ['Feiern, Restaurant, Urlaub – das gehört zum Leben und zum Halten dazu. Ein paar besondere Tage werfen dich nicht zurück, solange du danach in deine Routine zurückfindest.', 'Beim Halten hast du sogar mehr Spielraum als in einer Diät. Nutze ihn ohne schlechtes Gewissen.'] },
      { icon: '🧭', title: 'Kleine Strategien', paras: ['Nicht ausgehungert hingehen, Eiweiß und Gemüse als Basis, Wasser zwischen den Getränken, langsamer essen. Kleine Anker, die viel bewirken, ohne den Abend zu vermiesen.', 'Beim Buffet: einmal bewusst wählen statt mehrmals „nur schnell".'] },
      { icon: '🔁', title: 'Der Wiedereinstieg zählt', paras: ['Entscheidend ist nicht der Anlass, sondern was danach kommt. Die nächste Mahlzeit ist immer eine neue Chance – kein „Neustart am Montag", einfach normal weiter.', 'Kein Kompensieren durch Hungern oder Straf-Sport – das führt nur in den Verzicht-Heißhunger-Kreislauf.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Ein Wochenende kippt nichts', paras: ['Dein Stoffwechsel bilanziert über die Woche. Ein üppiges Wochenende verschwindet im Durchschnitt, wenn du danach normal weitermachst – vorausgesetzt, du kompensierst nicht mit Hungern.', 'Die Waagen-Zahl direkt nach dem Feiern ist meist Wasser (mehr Salz, mehr Kohlenhydrate), kein Fett – sie normalisiert sich in ein paar Tagen.', 'Flexibilität ist genau das, was Halten dauerhaft macht. Genuss gehört dazu.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was zählt nach einem Anlass am meisten?', options: ['Der Wiedereinstieg – einfach normal weiter', 'Ausgleichshungern am nächsten Tag', 'Ein kompletter Neustart'], answer: 0, explain: 'Kein Kompensieren – die nächste Mahlzeit ist eine neue Chance, ganz normal weiterzumachen.' },
      { q: 'Was ist die Gewichtszunahme direkt nach dem Feiern oft?', options: ['Vor allem Wasser (Salz/Kohlenhydrate)', 'Nur Fett', 'Muskeln'], answer: 0, explain: 'Meist Wasser – reguliert sich in ein paar Tagen, kein Grund zur Panik.' },
    ],
    sources: ['Literatur zu flexibler Kontrolle des Essverhaltens', 'Deutsche Gesellschaft für Ernährung (DGE): Ernährung im Alltag', 'Forschung zu Natrium, Glykogen und Wassereinlagerung'],
    exercise: 'Plane deinen nächsten Anlass: 2 einfache Strategien (z. B. „Eiweiß+Gemüse zuerst", „Wasser einbauen") und ein klarer Wiedereinstieg danach.',
    habits: [
      { id: 'h8h1', text: 'Bei Anlässen kleine Strategien nutzen', cat: 'planung' },
      { id: 'h8h2', text: 'Nach dem Anlass normal weiter', cat: 'mindset' },
    ],
  },
  {
    week: 9, title: 'Frühwarnsystem gegen Zunahme', theme: 'Strategie', minutes: 8,
    teaser: 'Schleichende Zunahme früh erkennen – bevor aus 1 kg 10 werden.',
    pages: [
      { icon: '🐌', title: 'Wie Zunahme schleicht', paras: ['Die meisten nehmen nicht auf einmal zu, sondern schleichend: ein paar hundert Kalorien mehr am Tag, über Monate. Das merkt man kaum – bis die Hose kneift.', 'Genau deshalb brauchst du ein Frühwarnsystem, das kleine Abweichungen sichtbar macht, solange sie noch klein sind.'] },
      { icon: '⚖️', title: 'Regelmäßig wiegen & messen', paras: ['Wieg dich mehrmals pro Woche und schau auf den Wochenschnitt. Kratzt er über 2–3 Wochen an der oberen Grenze deiner Range, ist das dein Signal.', 'Ergänzend: der Bund deiner Lieblingshose. Wird er enger, weißt du Bescheid – oft früher als die Waage.'] },
      { icon: '🔧', title: 'Früh und sanft gegensteuern', paras: ['Das Schöne: Bei früher Reaktion reichen kleine Korrekturen – etwas mehr Bewegung, etwas bewusster essen für 1–2 Wochen. Kein Diät-Drama nötig.', 'Wer erst bei +8 kg reagiert, braucht eine ganze Abnehmphase. Wer bei +1,5 kg reagiert, braucht nur eine ruhige Woche.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Warum kleine Überschüsse sich summieren', paras: ['Schon 100–150 kcal Überschuss am Tag machen über ein Jahr mehrere Kilo Fett aus. Der Körper gleicht kleine Mengen oft aus, aber einen dauerhaften kleinen Überschuss nicht.', 'Dein Frühwarnsystem fängt genau diese schleichenden Überschüsse ab, bevor sie sich zu viel Fett aufsummieren.', 'So bleibst du mit minimalem Aufwand stabil – der klügste Weg, langfristig zu halten.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie nehmen die meisten Menschen zu?', options: ['Schleichend über Monate (kleiner täglicher Überschuss)', 'Immer auf einmal', 'Gar nicht'], answer: 0, explain: 'Ein paar hundert Kalorien mehr am Tag summieren sich unbemerkt – daher das Frühwarnsystem.' },
      { q: 'Was ist der Vorteil von frühem Gegensteuern?', options: ['Kleine Korrekturen reichen, kein Diät-Drama', 'Es dauert länger', 'Man muss radikal hungern'], answer: 0, explain: 'Bei +1,5 kg reicht eine ruhige Woche; bei +8 kg braucht es eine ganze Abnehmphase.' },
    ],
    sources: ['National Weight Control Registry: Selbst-Monitoring als Erfolgsfaktor', 'Literatur zu schleichender Gewichtszunahme', 'Hall KD: Energiebilanz'],
    exercise: 'Richte dein Frühwarnsystem ein: Wochen-Wiegen + eine „Kontroll-Hose". Lege fest, ab wann (obere Range-Grenze) du 1–2 Wochen sanft gegensteuerst.',
    habits: [
      { id: 'h9h1', text: 'Wöchentlich wiegen (Trend)', cat: 'tracking' },
      { id: 'h9h2', text: 'An der oberen Grenze sanft gegensteuern', cat: 'planung' },
    ],
  },
  {
    week: 10, title: 'Bewegung als Anker', theme: 'Verhalten', minutes: 7,
    teaser: 'Regelmäßige Bewegung macht Halten leichter – für Verbrauch, Muskeln und Kopf.',
    pages: [
      { icon: '🚶', title: 'Alltagsbewegung zuerst', paras: ['Der größte veränderbare Teil deines Verbrauchs ist oft die Alltagsbewegung (NEAT): Gehen, Treppen, Stehen. Ein festes Schritt-Ziel hält deinen Verbrauch stabil, ohne Trainings-Stress.', 'Wer sich im Alltag mehr bewegt, hat automatisch mehr Spielraum beim Essen – ein angenehmer Puffer fürs Halten.'] },
      { icon: '🏋️', title: 'Kraft hält Muskeln', paras: ['2× pro Woche Krafttraining oder anspruchsvolle Bewegung hält deine Muskeln – und damit deinen Grundumsatz. Das ist gerade mit den Jahren der beste Schutz gegen ein langsam sinkendes „Halte-Budget".', 'Du musst nicht viel machen – Konstanz schlägt Umfang.'] },
      { icon: '🧠', title: 'Bewegung fürs Wohlbefinden', paras: ['Bewegung senkt Stress, verbessert Schlaf und Laune – und wer entspannter und ausgeschlafener ist, isst automatisch ausgeglichener. Der Effekt geht weit über verbrannte Kalorien hinaus.', 'Such dir etwas, das dir Spaß macht: Dann bleibst du dran, und genau das zählt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Bewegung, Appetit & Verbrauch', paras: ['Regelmäßige Bewegung hält nicht nur den Verbrauch oben, sie hilft dem Körper auch, Hunger und Sättigung besser zu regulieren – Appetit und Bedarf passen besser zusammen.', 'Muskeln, die durch Training erhalten bleiben, halten den Grundumsatz stabil. So bleibt dein „Halte-Budget" über die Jahre größer.', 'Bewegung ist damit einer der stärksten Anker fürs dauerhafte Halten – körperlich und mental.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist der größte veränderbare Teil deines Verbrauchs?', options: ['Alltagsbewegung (NEAT)', 'Der Grundumsatz', 'Die Verdauung'], answer: 0, explain: 'NEAT – Gehen, Stehen, Treppen – ist ein großer, gut beeinflussbarer Verbrauchsanteil.' },
      { q: 'Warum schützt Krafttraining das „Halte-Budget"?', options: ['Es hält Muskeln und damit den Grundumsatz', 'Es senkt den Verbrauch', 'Es macht nur müde'], answer: 0, explain: 'Muskelerhalt hält den Grundumsatz oben – so bleibt mehr Spielraum beim Essen.' },
    ],
    sources: ['Levine JA: NEAT', 'WHO – Empfehlungen zu körperlicher Aktivität', 'Forschung zu Bewegung und Appetitregulation'],
    exercise: 'Setz dir ein realistisches tägliches Schritt-Ziel und plane 2 Krafteinheiten – such dir eine Bewegungsform, die dir Spaß macht.',
    habits: [
      { id: 'h10h1', text: 'Tägliches Schritt-Ziel', cat: 'bewegung' },
      { id: 'h10h2', text: '2× Kraft/Woche', cat: 'bewegung' },
    ],
  },
  {
    week: 11, title: 'Schlaf, Stress & Stabilität', theme: 'Verhalten', minutes: 7,
    teaser: 'Guter Schlaf und weniger Stress halten Appetit und Gewicht stabil.',
    pages: [
      { icon: '😴', title: 'Schlaf steuert den Appetit', paras: ['Zu wenig Schlaf verschiebt deine Hungerhormone: mehr Hunger, mehr Heißhunger auf Süßes, weniger Sättigung. Über Wochen kann das dein sorgfältig gehaltenes Gewicht ins Wanken bringen.', 'Guter Schlaf ist damit kein Nebenschauplatz, sondern ein direkter Stabilitäts-Faktor.'] },
      { icon: '🌀', title: 'Stress & emotionales Essen', paras: ['Dauerstress fördert über Cortisol Appetit auf schnelle Energie und emotionales Essen. Wer viel Stress hat, isst oft mehr, ohne es zu merken.', 'Ein Ventil – Bewegung, ein Spaziergang, ein paar tiefe Atemzüge – wirkt besser als reine Selbstkontrolle.'] },
      { icon: '🛌', title: 'Kleine Routinen, große Wirkung', paras: ['Feste Schlafenszeit, Bildschirm vorher runter, dunkles kühles Zimmer, Koffein am Nachmittag meiden. Und ein bewusster Umgang mit Stress – beides stabilisiert nebenbei dein Essverhalten.', 'Halten ist oft weniger eine Frage der Ernährung als von Schlaf, Stress und Routine.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Hormone hinter der Stabilität', paras: ['Schlafmangel senkt Leptin (Sättigung) und hebt Ghrelin (Hunger); Stress hebt Cortisol, das Heißhunger und Wassereinlagerung fördert. Beides arbeitet gegen ein stabiles Gewicht.', 'Guter Schlaf und Stressabbau halten diese Hormone im Gleichgewicht – dein Appetit passt dann besser zu deinem echten Bedarf.', 'So wird Halten leichter: nicht durch mehr Kontrolle, sondern durch bessere Grundlagen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie beeinflusst Schlafmangel das Gewicht?', options: ['Mehr Hunger/Heißhunger, weniger Sättigung', 'Weniger Appetit', 'Gar nicht'], answer: 0, explain: 'Schlafmangel verschiebt die Hungerhormone – über Wochen kann das Halten stören.' },
      { q: 'Was hilft gegen Stress-Essen am besten?', options: ['Ein Ventil (Bewegung, Atmen)', 'Mehr Selbstkontrolle erzwingen', 'Gar nicht essen'], answer: 0, explain: 'Stress-Essen ist Biologie – ein Ventil wirkt besser als reine Willenskraft.' },
    ],
    sources: ['Spiegel K et al.: Schlafmangel und Appetit', 'Übersichtsarbeiten zu Stress, Cortisol und Essverhalten', 'Deutsche Gesellschaft für Ernährung (DGE): Ernährungsverhalten'],
    exercise: 'Lege eine feste Schlafenszeit fest und nimm dir ein Stress-Ventil für diese Woche vor (z. B. täglich 10 Minuten Spaziergang).',
    habits: [
      { id: 'h11h1', text: 'Feste Schlafenszeit', cat: 'schlaf' },
      { id: 'h11h2', text: 'Ein Stress-Ventil am Tag', cat: 'mindset' },
    ],
  },
  {
    week: 12, title: 'Dauerhaft halten', theme: 'Nachhaltigkeit', minutes: 8,
    teaser: 'Aus „halten" wird Normalität – dein Plan für die Zeit danach.',
    pages: [
      { icon: '🔁', title: 'Halten ist kein Projekt, sondern Normalität', paras: ['Du hast in den letzten Wochen die Fähigkeit geübt, dein Gewicht bewusst stabil zu halten. Jetzt darf das zur unauffälligen Normalität werden – ein System, kein ständiges Projekt.', 'Du brauchst keine Diät und keine Dauer-Kontrolle. Du hast Anker-Gewohnheiten und ein Frühwarnsystem – das reicht.'] },
      { icon: '🏅', title: 'Deine Top-Routinen sichern', paras: ['Halte fest, welche 3–4 Gewohnheiten bei dir am meisten bewirkt haben. Das sind deine Anker – auch in stressigen Zeiten.', 'Und dein Frühwarnsystem (Wochen-Wiegen, Kontroll-Hose) läuft im Hintergrund weiter, damit nichts schleicht.'] },
      { icon: '🧭', title: 'Neue Ziele möglich', paras: ['Halten ist ein starkes Fundament. Von hier aus kannst du jederzeit ein neues Ziel angehen – eine Definitionsphase, mehr Muskeln, oder einfach fit und stabil bleiben.', 'Im Coaching geht es mit Vertiefungen und weiteren Staffeln weiter – du bist nicht fertig, sondern souverän.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskeln & Set-Point über die Jahre', paras: ['Über die Jahre sinkt ohne Gegenwehr langsam die Muskelmasse – und damit der Verbrauch. Krafttraining und genug Eiweiß halten dein „Halte-Budget" groß, sodass Halten leicht bleibt.', 'Dein Körper verteidigt sein Gewicht, hat aber keinen starren Set-Point: Mit Wissen, Bewegung und einem Frühwarnsystem steuerst du bewusst.', 'Wenn du genau wissen willst, wo dein Stoffwechsel und deine Muskelmasse stehen und wie du gezielt hältst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Was brauchst du, um dauerhaft zu halten?', options: ['Anker-Gewohnheiten + Frühwarnsystem', 'Eine Dauer-Diät', 'Ständiges Kalorienzählen'], answer: 0, explain: 'Wenige verlässliche Routinen plus ein Frühwarnsystem reichen – kein Diät-Dauerzustand.' },
      { q: 'Warum bleibt Halten mit Krafttraining leichter?', options: ['Es hält Muskeln und damit den Verbrauch groß', 'Es senkt den Grundumsatz', 'Es ist egal'], answer: 0, explain: 'Muskelerhalt hält das „Halte-Budget" groß – so bleibt Halten über die Jahre einfach.' },
    ],
    sources: ['National Weight Control Registry: Langfristige Gewichtserhaltung', 'Bauer J et al. (PROT-AGE): Eiweiß und Muskelerhalt', 'Rosenbaum M, Leibel RL: Gewichtsregulation'],
    exercise: 'Schreib deine 3–4 wirksamsten Halte-Gewohnheiten auf, bestätige dein Frühwarnsystem und überlege, ob du als Nächstes ein neues Ziel angehen willst.',
    habits: [
      { id: 'h12h1', text: 'Top-Halte-Gewohnheiten festhalten', cat: 'mindset' },
      { id: 'h12h2', text: 'Frühwarnsystem am Laufen halten', cat: 'tracking' },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════
//  Track „Gesundheit" – 12-Wochen-Kern (eigener Content).
//  Fokus: allgemein gesünder essen (nicht gewichtszentriert) – vollwertig/bunt,
//  Ballaststoffe & Darm, Herz-Kreislauf, weniger Zucker/Verarbeitetes, Werte
//  verstehen. Bewusst vorsichtig formuliert, keine medizinischen Aussagen; der
//  Bildungs-Disclaimer weist auf ärztliche Abklärung hin. Habit-IDs (g…).
// ═══════════════════════════════════════════════════════════════════════
const GESUNDHEIT = [
  {
    week: 1, title: 'Ankommen & Ziel „Gesundheit" schärfen', theme: 'Grundlagen', minutes: 9,
    teaser: 'Gesünder essen heißt nicht Verzicht – sondern mehr von dem, was dir guttut.',
    pages: [
      { icon: '👋', title: 'Willkommen zu deinem Gesundheits-Coaching', paras: ['Schön, dass du da bist. Hier geht es nicht in erster Linie um die Waage, sondern um deine Gesundheit: mehr Energie, bessere Verdauung, ein gutes Bauchgefühl und langfristiges Wohlbefinden.', 'Gesünder essen bedeutet nicht Verzicht, sondern vor allem mehr von dem, was dir guttut – bunt, vollwertig und alltagstauglich.', 'Diese erste Einheit legt das Fundament und zeigt, warum dein Stoffwechsel ein guter Gesundheits-Anzeiger ist.'] },
      { icon: '🥗', title: 'Was „gesund essen" wirklich heißt', paras: ['Eine gesunde Ernährung ist einfacher, als Werbung glauben macht: viel Pflanzliches (Gemüse, Obst, Vollkorn, Hülsenfrüchte), gute Eiweiß- und Fettquellen, wenig stark Verarbeitetes und Zucker.', 'Es geht nicht um perfekte Regeln, sondern um ein gutes Muster über die Woche. Kein einzelnes „Superfood" macht dich gesund – das Gesamtbild zählt.'] },
      { icon: '🧭', title: 'Vom Verbot zur Ergänzung', paras: ['Statt Dinge zu verbieten, ergänzen wir Schritt für Schritt Gutes: eine Portion Gemüse mehr, ein Glas Wasser statt Limo, Vollkorn statt Weißmehl. Kleine Umstellungen, große Wirkung.', 'So baust du eine Ernährung auf, die du dauerhaft magst – ohne Diät-Frust.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Dein Stoffwechsel als Gesundheits-Barometer', paras: ['Wie dein Körper mit Energie, Blutzucker und Fetten umgeht, ist ein zentraler Teil deiner Gesundheit. Eine vollwertige Ernährung und Bewegung unterstützen einen gut funktionierenden Stoffwechsel.', 'Werte wie Blutzucker, Blutfette oder Blutdruck geben Hinweise darauf, wie es um deine Stoffwechselgesundheit steht – vieles davon lässt sich durch Ernährung und Bewegung positiv beeinflussen.', 'Eine Stoffwechselmessung im Studio kann dir eine Standortbestimmung geben – ergänzend zu ärztlichen Untersuchungen, nicht als Ersatz.'], cta: 'Stoffwechsel messen lassen' },
      { icon: '📓', title: 'So startest du diese Woche', paras: ['Beobachte diese Woche ehrlich, was du isst – besonders, wie viel Gemüse, Obst und Vollkorn dabei ist und wie viel Verarbeitetes/Süßes.', 'Kein Bewerten, nur Hinschauen. So erkennst du deine 2–3 größten Hebel für mehr Gesundheit.', 'Am Ende der Woche wissen wir, wo wir ansetzen.'] },
    ],
    quiz: [
      { q: 'Was macht eine gesunde Ernährung vor allem aus?', options: ['Das Gesamtmuster: viel Pflanzliches, wenig Verarbeitetes', 'Ein einzelnes Superfood', 'Möglichst viele Verbote'], answer: 0, explain: 'Das Gesamtbild über die Woche zählt – kein einzelnes Lebensmittel macht gesund oder ungesund.' },
      { q: 'Wie gehen wir Gesundheit an?', options: ['Gutes ergänzen statt nur verbieten', 'Alles Leckere streichen', 'Nur Kalorien zählen'], answer: 0, explain: 'Kleine Ergänzungen (mehr Gemüse, Wasser, Vollkorn) bringen mehr als Verbote.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Vollwertige Ernährung / 10 Regeln', 'WHO – Healthy diet (Fact Sheet)', 'Harvard: Healthy Eating Plate'],
    exercise: 'Protokolliere ehrlich und schau besonders auf deinen Anteil an Gemüse, Obst und Vollkorn – ohne zu bewerten.',
    habits: [
      { id: 'g1h1', text: 'Ehrlich protokollieren', cat: 'tracking' },
      { id: 'g1h2', text: 'Auf Gemüse-/Vollkornanteil achten', cat: 'gemuese' },
    ],
  },
  {
    week: 2, title: 'Bunt & vollwertig essen', theme: 'Grundlagen', minutes: 7,
    teaser: 'Je bunter dein Teller, desto breiter deine Nährstoffversorgung.',
    pages: [
      { icon: '🌈', title: 'Iss den Regenbogen', paras: ['Verschiedene Farben bei Gemüse und Obst stehen für verschiedene Vitamine, Mineralstoffe und sekundäre Pflanzenstoffe. Wer bunt isst, versorgt sich breit – fast von allein.', 'Ein guter Richtwert der DGE: „5 am Tag" – etwa 3 Portionen Gemüse und 2 Portionen Obst. Eine Portion ist ungefähr eine Handvoll.'] },
      { icon: '🍽️', title: 'Der gesunde Teller', paras: ['Ein einfaches Bild: die Hälfte des Tellers Gemüse/Salat, ein Viertel gute Kohlenhydrate (Vollkorn, Kartoffeln, Hülsenfrüchte), ein Viertel Eiweiß, dazu etwas gutes Fett.', 'Dieses Muster deckt Nährstoffe, Ballaststoffe und Sättigung ab – ohne Rechnerei.'] },
      { icon: '🌾', title: 'Vollwertig statt raffiniert', paras: ['Vollkorn statt Weißmehl, ganze Lebensmittel statt stark Verarbeitetes: Das liefert mehr Ballaststoffe, Vitamine und Mineralstoffe und hält länger satt.', 'Du musst nichts komplett streichen – nur öfter die vollwertige Variante wählen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Mikronährstoffe & Stoffwechsel', paras: ['Vitamine und Mineralstoffe sind Helfer in unzähligen Stoffwechselvorgängen – von der Energiegewinnung bis zum Immunsystem. Eine bunte, vollwertige Ernährung liefert sie in gutem Verhältnis.', 'Sekundäre Pflanzenstoffe (die Farben in Obst und Gemüse) wirken zusätzlich antioxidativ und werden mit gesundheitlichen Vorteilen in Verbindung gebracht.', 'Ein gut versorgter Körper arbeitet stoffwechselseitig runder – Vielfalt auf dem Teller ist hier die einfachste „Nahrungsergänzung".'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum bunt essen?', options: ['Verschiedene Farben = verschiedene Nährstoffe', 'Farben sind egal', 'Nur Grün zählt'], answer: 0, explain: 'Unterschiedliche Farben liefern unterschiedliche Vitamine und Pflanzenstoffe – breite Versorgung.' },
      { q: 'Wie sieht ein gesunder Teller aus?', options: ['Halb Gemüse, je ein Viertel Eiweiß und gute Kohlenhydrate', 'Nur Kohlenhydrate', 'Nur Fleisch'], answer: 0, explain: 'Dieses Teller-Prinzip deckt Nährstoffe, Ballaststoffe und Sättigung ohne Rechnerei ab.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): „5 am Tag", 10 Regeln', 'WHO – Healthy diet', 'Harvard: Healthy Eating Plate'],
    exercise: 'Bring heute mindestens 3 verschiedene Gemüse-/Obstfarben auf den Teller und stell eine Mahlzeit nach dem Teller-Prinzip zusammen.',
    habits: [
      { id: 'g2h1', text: '5 am Tag (Gemüse & Obst)', cat: 'gemuese' },
      { id: 'g2h2', text: 'Eine Vollkorn-Umstellung', cat: 'kohlenhydrate' },
    ],
  },
  {
    week: 3, title: 'Ballaststoffe & Darmgesundheit', theme: 'Gesundheit', minutes: 8,
    teaser: 'Der unterschätzte Nährstoff – gut für Darm, Sättigung und Wohlbefinden.',
    pages: [
      { icon: '🌾', title: 'Warum Ballaststoffe so wertvoll sind', paras: ['Ballaststoffe aus Gemüse, Obst, Vollkorn und Hülsenfrüchten halten satt, unterstützen eine gesunde Verdauung und werden mit vielen gesundheitlichen Vorteilen in Verbindung gebracht.', 'Die meisten Menschen essen zu wenig. Die DGE empfiehlt rund 30 g pro Tag – erreichbar mit ein paar bewussten Umstellungen.'] },
      { icon: '🫘', title: 'So kommst du auf deine Menge', paras: ['Vollkorn statt Weißmehl, eine Handvoll Hülsenfrüchte, Gemüse zu jeder Mahlzeit, Obst als Snack, Nüsse und Samen – so summiert sich dein Ballaststoff-Konto fast nebenbei.', 'Steigere langsam und trink genug Wasser, sonst kann der Bauch anfangs zwicken. In ein bis zwei Wochen gewöhnt sich die Verdauung daran.'] },
      { icon: '🩸', title: 'Ruhiger Blutzucker, längere Sättigung', paras: ['Ballaststoffe verlangsamen die Aufnahme von Zucker ins Blut – das glättet die Blutzuckerkurve, du bleibst länger satt und hast weniger Heißhunger.', 'Ein Vollkornbrot hält deshalb länger satt als ein Weißmehl-Brötchen, obwohl beide ähnlich viele Kalorien haben.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Dein Mikrobiom isst mit', paras: ['In deinem Darm leben Billionen Bakterien – dein Mikrobiom. Ballaststoffe sind ihr Futter: Daraus bilden sie kurzkettige Fettsäuren, die Darm und Stoffwechsel unterstützen.', 'Ein vielfältig gefüttertes Mikrobiom wird mit besserer Verdauung, stabilerem Appetit und Wohlbefinden in Verbindung gebracht. Vielfalt auf dem Teller = Vielfalt im Darm.', 'Fermentiertes wie Joghurt, Kefir oder Sauerkraut ergänzt das Ganze. Iss bunt und pflanzenreich – dein Darm dankt es dir.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie viel Ballaststoffe empfiehlt die DGE etwa?', options: ['Rund 30 g pro Tag', '5 g pro Tag', 'So wenig wie möglich'], answer: 0, explain: 'Etwa 30 g/Tag – die meisten Menschen liegen darunter.' },
      { q: 'Was ist das Mikrobiom?', options: ['Die Bakteriengemeinschaft in deinem Darm', 'Ein Vitaminpräparat', 'Ein Organ im Gehirn'], answer: 0, explain: 'Das Mikrobiom sind die Darmbakterien – Ballaststoffe sind ihr Futter.' },
    ],
    sources: ['Reynolds A et al. (2019, The Lancet): Ballaststoffe und Gesundheit', 'Deutsche Gesellschaft für Ernährung (DGE): Ballaststoffe (~30 g/Tag)', 'Übersichtsarbeiten zu Darmmikrobiom und Ernährung'],
    exercise: 'Bau heute an jeder Mahlzeit eine Ballaststoffquelle ein (Gemüse, Vollkorn, Hülsenfrüchte) und ergänze etwas Fermentiertes (z. B. Joghurt).',
    habits: [
      { id: 'g3h1', text: 'Ballaststoffquelle zu jeder Mahlzeit', cat: 'ballaststoffe' },
      { id: 'g3h2', text: 'Pflanzenvielfalt über die Woche', cat: 'gemuese' },
    ],
  },
  {
    week: 4, title: 'Eiweiß für Gesundheit & Muskeln', theme: 'Makros', minutes: 7,
    teaser: 'Genug Eiweiß hält Muskeln, Knochen und Immunsystem in Schuss.',
    pages: [
      { icon: '🍗', title: 'Mehr als nur Muskeln', paras: ['Eiweiß ist Baustoff für Muskeln, aber auch für Enzyme, Hormone und Teile des Immunsystems. Genug davon zu essen ist ein Grundpfeiler einer gesunden Ernährung – ein Richtwert sind rund 0,8–1,2 g/kg, aktive Menschen eher mehr.', 'Eiweiß sättigt zudem gut und hilft so, nicht ständig zu snacken.'] },
      { icon: '🌱', title: 'Gute Mischung', paras: ['Eine gesunde Wahl ist eine Mischung: mageres Fleisch und Fisch in Maßen, dazu viel Pflanzliches – Hülsenfrüchte, Tofu, Nüsse, Vollkorn – und Milchprodukte wie Quark oder Joghurt.', 'Mehr pflanzliches Eiweiß und weniger rotes/verarbeitetes Fleisch gilt als günstig für die Gesundheit.'] },
      { icon: '🦴', title: 'Muskeln & Knochen erhalten', paras: ['Mit den Jahren baut der Körper ohne Gegenwehr Muskeln und Knochendichte ab. Genug Eiweiß plus Bewegung wirkt dem entgegen – wichtig für Kraft, Stabilität und Selbstständigkeit im Alter.', 'Es ist nie zu früh (oder zu spät), hier vorzusorgen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Eiweiß, Muskeln & Stoffwechselgesundheit', paras: ['Muskulatur ist nicht nur für Kraft da: Sie nimmt Zucker aus dem Blut auf und trägt zu einem gesunden Blutzucker-Stoffwechsel bei. Mehr aktive Muskelmasse unterstützt die Insulinempfindlichkeit.', 'Genug Eiweiß hält diese Muskeln – zusammen mit Bewegung ein starker Beitrag zur Stoffwechselgesundheit.', 'Wie viel Muskelmasse du hast, lässt sich im Studio messen – eine nützliche Info für deine Gesundheitsziele.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Wofür ist Eiweiß außer für Muskeln wichtig?', options: ['Enzyme, Hormone, Immunsystem', 'Nur für die Optik', 'Für gar nichts'], answer: 0, explain: 'Eiweiß ist Baustoff für viele Körperfunktionen – ein Grundpfeiler gesunder Ernährung.' },
      { q: 'Was gilt als günstige Eiweißwahl?', options: ['Mehr Pflanzliches, weniger rotes/verarbeitetes Fleisch', 'Nur Wurst', 'Gar kein Eiweiß'], answer: 0, explain: 'Eine Mischung mit viel Pflanzlichem gilt als gesundheitlich vorteilhaft.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Protein', 'Bauer J et al. (PROT-AGE): Eiweiß und Muskelerhalt', 'WHO/Leitlinien zu rotem und verarbeitetem Fleisch'],
    exercise: 'Baue zu jeder Hauptmahlzeit eine Eiweißquelle ein und wähle heute mindestens einmal eine pflanzliche (Hülsenfrüchte, Tofu, Nüsse).',
    habits: [
      { id: 'g4h1', text: 'Eiweiß zu jeder Hauptmahlzeit', cat: 'protein' },
      { id: 'g4h2', text: 'Eine pflanzliche Eiweißquelle', cat: 'protein' },
    ],
  },
  {
    week: 5, title: 'Gute Fette & Herzgesundheit', theme: 'Makros', minutes: 8,
    teaser: 'Die richtigen Fette schützen Herz und Gefäße – auf die Qualität kommt es an.',
    pages: [
      { icon: '🫒', title: 'Fett ist nicht gleich Fett', paras: ['Bei Fett zählt die Qualität. Ungesättigte Fette aus Olivenöl, Rapsöl, Nüssen, Samen, Avocado und fettem Fisch gelten als herzfreundlich.', 'Zurückhaltender bei gesättigten Fetten (viel fettes Fleisch, Butter, Sahne) und möglichst weg von Transfetten (in manchen stark verarbeiteten und frittierten Produkten).'] },
      { icon: '🐟', title: 'Omega-3 für Herz & Gefäße', paras: ['Fetter Fisch (Lachs, Makrele, Hering) 1–2× pro Woche liefert Omega-3-Fettsäuren, die mit Herz-Kreislauf-Vorteilen in Verbindung gebracht werden. Pflanzlich liefern Lein-, Raps- und Walnussöl eine Vorstufe.', 'Ein bewusster Fokus hier ist einer der einfachsten Gewinne für die Herzgesundheit.'] },
      { icon: '⚖️', title: 'Menge im Blick', paras: ['Auch gute Fette sind energiedicht (9 kcal/g). Für die Gesundheit geht es um die Auswahl – für dein Gewicht auch um die Menge. Abmessen statt frei gießen hilft.', 'Ein Schuss Olivenöl ist top; ein halbes Fläschchen davon summiert sich schnell.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Fette & deine Blutfettwerte', paras: ['Die Art der Fette beeinflusst die Blutfettwerte. Ungesättigte Fette statt gesättigter und der Verzicht auf Transfette werden mit günstigeren Cholesterinwerten in Verbindung gebracht.', 'Zusammen mit Ballaststoffen und Bewegung ist die Fettqualität ein wichtiger Hebel für Herz-Kreislauf-Gesundheit.', 'Deine Blutfettwerte solltest du ärztlich prüfen lassen – Ernährung kann sie unterstützen, ersetzt aber keine ärztliche Kontrolle.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Welche Fette gelten als herzfreundlich?', options: ['Ungesättigte (Olivenöl, Nüsse, fetter Fisch)', 'Transfette', 'Möglichst viel gesättigtes Fett'], answer: 0, explain: 'Ungesättigte Fette statt gesättigter und Transfette gelten als günstig fürs Herz.' },
      { q: 'Woher bekommst du Omega-3 gut?', options: ['Fetter Fisch, Lein-/Raps-/Walnussöl', 'Frittiertes', 'Softdrinks'], answer: 0, explain: 'Fetter Fisch 1–2×/Woche oder pflanzliche Öle liefern Omega-3.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Fett und Fettsäuren', 'Leitlinien zu Omega-3 und Herz-Kreislauf-Gesundheit', 'WHO – Transfette'],
    exercise: 'Ersetze heute ein gesättigtes/verarbeitetes Fett durch ein gutes (z. B. Olivenöl, Nüsse) und plane eine Portion fetten Fisch für diese Woche.',
    habits: [
      { id: 'g5h1', text: 'Gute Fette bevorzugen', cat: 'fette' },
      { id: 'g5h2', text: 'Omega-3-Quelle einbauen', cat: 'fette' },
    ],
  },
  {
    week: 6, title: 'Zucker & Verarbeitetes reduzieren', theme: 'Verhalten', minutes: 7,
    teaser: 'Weniger zugesetzter Zucker und Fertigprodukte – einer der größten Gesundheitshebel.',
    pages: [
      { icon: '🍬', title: 'Zugesetzter Zucker', paras: ['Die WHO empfiehlt, den Anteil zugesetzten Zuckers deutlich zu begrenzen. Die größten Quellen sind meist Softdrinks, Süßigkeiten, gesüßte Milchprodukte und versteckter Zucker in Fertigprodukten.', 'Du musst nicht zuckerfrei leben – aber die großen Quellen zu erkennen und zu reduzieren, bringt viel für die Gesundheit.'] },
      { icon: '🥤', title: 'Getränke zuerst', paras: ['Der einfachste Schritt: gesüßte Getränke reduzieren. Ein Glas Limo oder Saft kann so viel Zucker enthalten wie eine Handvoll Süßigkeiten – ohne zu sättigen.', 'Wasser, ungesüßter Tee und Kaffee als Standard sparen mühelos viel Zucker.'] },
      { icon: '🏭', title: 'Stark Verarbeitetes erkennen', paras: ['Stark verarbeitete Produkte (viele Fertiggerichte, Snacks, Wurstwaren) enthalten oft viel Zucker, Salz, ungünstige Fette und wenig Nährstoffe. Sie werden mit gesundheitlichen Nachteilen in Verbindung gebracht.', 'Ein Blick auf die Zutatenliste hilft: kurze Listen mit erkennbaren Zutaten sind meist die bessere Wahl.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Zucker, Blutzucker & Insulin', paras: ['Viel schneller Zucker lässt den Blutzucker stark steigen und wieder fallen – das fordert die Insulin-Regulation und kann Heißhunger fördern. Dauerhaft ungünstige Muster belasten die Stoffwechselgesundheit.', 'Ballaststoffe, Eiweiß und weniger schneller Zucker halten den Blutzucker ruhiger – gut für Energie und Gesundheit.', 'Wie dein Körper mit Blutzucker umgeht, ist ärztlich messbar; Ernährung und Bewegung sind starke Stellschrauben.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wo steckt am meisten zugesetzter Zucker?', options: ['Softdrinks, Süßes, versteckt in Fertigprodukten', 'In Gemüse', 'In Wasser'], answer: 0, explain: 'Gesüßte Getränke und verarbeitete Produkte sind die größten Quellen.' },
      { q: 'Was ist der einfachste erste Schritt?', options: ['Gesüßte Getränke reduzieren', 'Nie wieder Obst essen', 'Mahlzeiten auslassen'], answer: 0, explain: 'Getränke liefern viel Zucker ohne Sättigung – hier lohnt sich das Reduzieren am meisten.' },
    ],
    sources: ['WHO – Guideline: Sugars intake for adults and children (2015)', 'Deutsche Gesellschaft für Ernährung (DGE): Zucker', 'Übersichtsarbeiten zu stark verarbeiteten Lebensmitteln'],
    exercise: 'Ersetze heute jedes gesüßte Getränk durch Wasser/Tee und wirf bei einem Fertigprodukt einen Blick auf die Zutatenliste.',
    habits: [
      { id: 'g6h1', text: 'Zuckerfreie Getränke', cat: 'getraenke' },
      { id: 'g6h2', text: 'Weniger stark Verarbeitetes', cat: 'achtsamkeit' },
    ],
  },
  {
    week: 7, title: 'Salz, Blutdruck & Herz', theme: 'Gesundheit', minutes: 7,
    teaser: 'Wie viel Salz steckt versteckt in deinem Essen – und was das mit dem Herz zu tun hat.',
    pages: [
      { icon: '🧂', title: 'Salz in Maßen', paras: ['Die WHO empfiehlt, nicht mehr als etwa 5 g Salz pro Tag zu essen. Viele liegen deutlich darüber – meist nicht durchs Nachsalzen, sondern durch verstecktes Salz in Brot, Wurst, Käse und Fertigprodukten.', 'Zu viel Salz wird mit höherem Blutdruck in Verbindung gebracht, einem wichtigen Risikofaktor fürs Herz.'] },
      { icon: '🔎', title: 'Die versteckten Quellen', paras: ['Die größten Salzquellen sind oft Brot und Backwaren, Wurst und Käse, Fertiggerichte und salzige Snacks. Weniger davon und mehr frisch Gekochtes senkt die Salzmenge fast automatisch.', 'Würze mehr mit Kräutern, Gewürzen, Zitrone und Knoblauch – das bringt Geschmack ohne viel Salz.'] },
      { icon: '❤️', title: 'Gut fürs Herz insgesamt', paras: ['Herzgesundheit ist ein Zusammenspiel: weniger Salz und Zucker, gute Fette, viele Ballaststoffe, genug Bewegung, nicht rauchen. Kein Einzelfaktor entscheidet allein.', 'Diese Ernährung wirkt nicht nur aufs Herz, sondern aufs ganze Wohlbefinden.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Blutdruck als Gesundheits-Marker', paras: ['Der Blutdruck ist ein zentraler Marker der Herz-Kreislauf-Gesundheit. Ernährung (Salz, Kalium aus Gemüse/Obst), Bewegung, Gewicht und Stress beeinflussen ihn.', 'Eine gemüsereiche, salzbewusste Ernährung mit genug Bewegung wird mit günstigeren Werten in Verbindung gebracht.', 'Deinen Blutdruck solltest du ärztlich kontrollieren lassen – Ernährung und Bewegung können ihn unterstützen, ersetzen aber keine ärztliche Behandlung.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Woher kommt das meiste Salz in der Ernährung?', options: ['Versteckt in Brot, Wurst, Käse, Fertigprodukten', 'Nur vom Nachsalzen', 'Aus Gemüse'], answer: 0, explain: 'Der größte Teil steckt versteckt in verarbeiteten Lebensmitteln – nicht im Salzstreuer.' },
      { q: 'Womit würzt du salzsparend?', options: ['Kräuter, Gewürze, Zitrone, Knoblauch', 'Noch mehr Salz', 'Zucker'], answer: 0, explain: 'Kräuter und Gewürze bringen Geschmack ohne viel Salz.' },
    ],
    sources: ['WHO – Salt reduction (≤ 5 g/Tag)', 'Deutsche Gesellschaft für Ernährung (DGE): Speisesalz', 'Leitlinien zu Blutdruck und Ernährung (z. B. DASH)'],
    exercise: 'Koch heute frisch und würze mit Kräutern/Gewürzen statt viel Salz – und schau bei einem verpackten Produkt auf den Salzgehalt.',
    habits: [
      { id: 'g7h1', text: 'Mit Kräutern statt viel Salz würzen', cat: 'achtsamkeit' },
      { id: 'g7h2', text: 'Öfter frisch kochen', cat: 'planung' },
    ],
  },
  {
    week: 8, title: 'Trinken & Alltag', theme: 'Verhalten', minutes: 6,
    teaser: 'Ausreichend trinken und Alkohol bewusst – zwei einfache Gesundheitshebel.',
    pages: [
      { icon: '💧', title: 'Genug Wasser', paras: ['Ausreichend zu trinken unterstützt Konzentration, Verdauung und Wohlbefinden. Als grober Richtwert gelten rund 1,5 Liter am Tag, mehr bei Hitze und Sport – Wasser und ungesüßter Tee sind ideal.', 'Ein guter Trick: morgens ein Glas Wasser und zu jeder Mahlzeit eins. So kommst du fast automatisch auf deine Menge.'] },
      { icon: '🍷', title: 'Alkohol bewusst', paras: ['Alkohol liefert viele Kalorien ohne Nährwert und wird ab regelmäßigem Konsum mit gesundheitlichen Risiken in Verbindung gebracht. Weniger ist gesundheitlich klar günstiger.', 'Du musst nicht abstinent leben – aber alkoholfreie Tage und bewusster Genuss statt Gewohnheit tun deiner Gesundheit gut.'] },
      { icon: '☕', title: 'Kaffee & Co. einordnen', paras: ['Kaffee in üblichen Mengen ist für die meisten unbedenklich und kann sogar Vorteile haben – problematisch wird eher, was reinkommt (viel Zucker, Sirup, Sahne).', 'Trink ihn am liebsten schwarz oder mit etwas Milch und meide die Zucker-Bomben.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Wasser, Alkohol & Stoffwechsel', paras: ['Ausreichend Wasser hält den Stoffwechsel und alle Transportprozesse am Laufen – schon leichter Flüssigkeitsmangel kann müde und unkonzentriert machen.', 'Alkohol dagegen wird vom Körper vorrangig abgebaut; solange pausieren andere Stoffwechselwege, u. a. die Fettverbrennung. Auch deshalb ist Zurückhaltung günstig.', 'Kleine Gewohnheiten beim Trinken haben über die Zeit einen großen Effekt auf Gesundheit und Wohlbefinden.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist ein guter Trink-Standard?', options: ['Wasser und ungesüßter Tee, ~1,5 L+', 'Softdrinks', 'Möglichst wenig trinken'], answer: 0, explain: 'Wasser/ungesüßter Tee, rund 1,5 L (mehr bei Sport/Hitze) unterstützt Wohlbefinden.' },
      { q: 'Wie gehst du mit Alkohol gesundheitsbewusst um?', options: ['Weniger, mit alkoholfreien Tagen', 'Täglich viel', 'Nur auf leeren Magen'], answer: 0, explain: 'Weniger Alkohol ist gesundheitlich klar günstiger – bewusster Genuss statt Gewohnheit.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Trinkmenge, Alkohol', 'WHO – Alkohol und Gesundheit', 'Übersichtsarbeiten zu Kaffee und Gesundheit'],
    exercise: 'Trink heute bewusst zu jeder Mahlzeit ein Glas Wasser und plane für diese Woche 1–2 alkoholfreie Tage.',
    habits: [
      { id: 'g8h1', text: 'Zu jeder Mahlzeit ein Glas Wasser', cat: 'wasser' },
      { id: 'g8h2', text: 'Alkoholfreie Tage einplanen', cat: 'getraenke' },
    ],
  },
  {
    week: 9, title: 'Bewegung & Stoffwechselgesundheit', theme: 'Verhalten', minutes: 7,
    teaser: 'Bewegung ist Medizin – für Blutzucker, Herz, Kopf und Stoffwechsel.',
    pages: [
      { icon: '🚶', title: 'Jede Bewegung zählt', paras: ['Regelmäßige Bewegung gehört zu den stärksten Gesundheitsfaktoren überhaupt. Die WHO empfiehlt Erwachsenen mindestens 150 Minuten moderate Aktivität pro Woche plus 2× Krafttraining.', 'Du musst kein Sportprofi sein – schon zügiges Gehen, Treppen und Alltagsbewegung wirken. Das Beste: das, was du regelmäßig machst.'] },
      { icon: '🏋️', title: 'Kraft & Ausdauer kombinieren', paras: ['Ausdauer (Gehen, Radfahren, Schwimmen) stärkt Herz und Kreislauf; Krafttraining hält Muskeln und Knochen. Die Kombination bringt den größten Gesundheitsnutzen.', '2× kurze Krafteinheiten pro Woche reichen als Basis – Konstanz schlägt Umfang.'] },
      { icon: '🧠', title: 'Auch für den Kopf', paras: ['Bewegung senkt Stress, verbessert Schlaf und Stimmung und unterstützt die geistige Gesundheit. Der Nutzen geht weit über den Körper hinaus.', 'Such dir etwas, das dir Freude macht – dann bleibst du dran, und genau das zählt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Bewegung & Insulinempfindlichkeit', paras: ['Bewegung verbessert, wie empfindlich deine Zellen auf Insulin reagieren – der Körper bekommt den Blutzucker leichter in die Zellen. Das ist ein Kernstück der Stoffwechselgesundheit.', 'Schon ein kurzer Spaziergang nach dem Essen kann die Blutzuckerreaktion abmildern. Muskelarbeit „verbraucht" Zucker direkt.', 'Regelmäßige Bewegung ist damit einer der wirksamsten Hebel für einen gesunden Stoffwechsel – kostenlos und nebenwirkungsarm.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was empfiehlt die WHO pro Woche?', options: ['≥ 150 Min moderate Aktivität + 2× Kraft', 'Gar keine Bewegung', 'Nur einmal im Monat Sport'], answer: 0, explain: 'Mindestens 150 Minuten moderate Bewegung plus 2× Krafttraining pro Woche.' },
      { q: 'Wie hilft Bewegung dem Stoffwechsel?', options: ['Sie verbessert die Insulinempfindlichkeit', 'Sie erhöht den Blutzucker dauerhaft', 'Gar nicht'], answer: 0, explain: 'Bewegung hilft, Blutzucker in die Zellen zu bringen – zentral für die Stoffwechselgesundheit.' },
    ],
    sources: ['WHO – Guidelines on physical activity (2020)', 'Literatur zu Bewegung und Insulinempfindlichkeit', 'Deutsche Gesellschaft für Ernährung/Sportmedizin'],
    exercise: 'Plane diese Woche mind. 150 Minuten Bewegung und 2 kurze Krafteinheiten – und mach nach einer Mahlzeit einen kurzen Spaziergang.',
    habits: [
      { id: 'g9h1', text: 'Täglich aktiv sein (Schritte/Sport)', cat: 'bewegung' },
      { id: 'g9h2', text: 'Spaziergang nach dem Essen', cat: 'bewegung' },
    ],
  },
  {
    week: 10, title: 'Schlaf & Erholung', theme: 'Verhalten', minutes: 6,
    teaser: 'Schlaf ist eine tragende Säule der Gesundheit – oft unterschätzt.',
    pages: [
      { icon: '😴', title: 'Schlaf als Gesundheitssäule', paras: ['Guter Schlaf ist so wichtig wie Ernährung und Bewegung. Er beeinflusst Appetit, Immunsystem, Konzentration, Stimmung und die Erholung des ganzen Körpers.', 'Für die meisten Erwachsenen sind 7–9 Stunden ein guter Bereich. Regelmäßigkeit ist dabei fast so wichtig wie die Dauer.'] },
      { icon: '🛌', title: 'Besser schlafen', paras: ['Feste Zeiten, ein dunkles kühles Schlafzimmer, Bildschirm eine Stunde vorher runter, Koffein am Nachmittag meiden, abends Alkohol reduzieren – kleine Stellschrauben mit großer Wirkung.', 'Auch Tageslicht und Bewegung am Tag verbessern den Schlaf in der Nacht.'] },
      { icon: '🌀', title: 'Stress und Erholung', paras: ['Chronischer Stress belastet die Gesundheit auf vielen Ebenen. Bewusste Erholung – Pausen, Bewegung, Zeit in der Natur, Atmen – ist kein Luxus, sondern Vorsorge.', 'Gesundheit entsteht auch in den Pausen, nicht nur beim Essen und Trainieren.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Schlaf, Hormone & Stoffwechsel', paras: ['Schlafmangel verschiebt Hunger- und Sättigungshormone und kann die Blutzuckerregulation kurzfristig verschlechtern. Guter Schlaf unterstützt dagegen einen gesunden Stoffwechsel.', 'Auch das Immunsystem und die Regeneration hängen stark am Schlaf – wer gut schläft, ist widerstandsfähiger.', 'Schlaf ist damit ein unterschätzter, kostenloser Gesundheits- und Stoffwechsel-Hebel.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie viel Schlaf ist für die meisten Erwachsenen gut?', options: ['7–9 Stunden, möglichst regelmäßig', '3–4 Stunden', 'So wenig wie möglich'], answer: 0, explain: '7–9 Stunden mit regelmäßigen Zeiten unterstützen Gesundheit und Stoffwechsel.' },
      { q: 'Was verbessert den Schlaf?', options: ['Feste Zeiten, dunkel/kühl, Bildschirm vorher runter', 'Koffein am Abend', 'Viel Alkohol'], answer: 0, explain: 'Schlafhygiene – feste Zeiten und weniger Bildschirm/Koffein/Alkohol – hilft spürbar.' },
    ],
    sources: ['Übersichtsarbeiten zu Schlaf und Gesundheit', 'Spiegel K et al.: Schlaf und Stoffwechsel', 'Empfehlungen zur Schlafhygiene'],
    exercise: 'Lege eine feste Schlafenszeit fest, reduziere abends Bildschirmzeit und plane bewusst eine echte Erholungspause am Tag ein.',
    habits: [
      { id: 'g10h1', text: 'Feste Schlafenszeit', cat: 'schlaf' },
      { id: 'g10h2', text: 'Bewusste Erholungspause', cat: 'mindset' },
    ],
  },
  {
    week: 11, title: 'Deine Werte verstehen', theme: 'Gesundheit', minutes: 8,
    teaser: 'Blutwerte, Blutdruck & Co. – was sie grob bedeuten und wann der Arzt dran ist.',
    pages: [
      { icon: '🩺', title: 'Vorsorge nutzen', paras: ['Regelmäßige ärztliche Check-ups sind ein wichtiger Teil der Gesundheit. Werte wie Blutdruck, Blutzucker (bzw. Langzeitzucker HbA1c) und Blutfette (Cholesterin) geben Hinweise auf deine Stoffwechsel- und Herzgesundheit.', 'Wichtig: Diese Werte gehören in ärztliche Hände. Wir erklären hier nur grob, was dahintersteckt – für die Einordnung und Behandlung ist deine Ärztin oder dein Arzt da.'] },
      { icon: '📊', title: 'Grob eingeordnet', paras: ['Blutdruck: dauerhaft erhöhte Werte belasten Herz und Gefäße. Blutzucker/HbA1c: geben Hinweise auf den Zuckerstoffwechsel. Blutfette: ungünstige Cholesterin-Muster gelten als Herz-Risikofaktor.', 'Vieles davon lässt sich durch Ernährung, Bewegung, Gewicht, Schlaf und Nichtrauchen positiv beeinflussen – aber immer in Absprache mit ärztlichem Rat.'] },
      { icon: '🧭', title: 'Was du selbst tun kannst', paras: ['Die gute Nachricht: Genau die Gewohnheiten aus diesem Coaching – vollwertig essen, Ballaststoffe, gute Fette, weniger Zucker/Salz, Bewegung, guter Schlaf – zahlen auf viele dieser Werte ein.', 'Du hast also mehr Einfluss, als du vielleicht denkst. Ernährung und Bewegung sind starke Werkzeuge – ergänzend zur ärztlichen Betreuung.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Was eine Stoffwechselmessung zeigt', paras: ['Eine Stoffwechselmessung im Studio kann z. B. deinen Ruhe-Energieumsatz und deine Körperzusammensetzung bestimmen – nützliche Zusatzinfos, um Ernährung und Training abzustimmen.', 'Sie ersetzt keine ärztliche Diagnostik (Blutwerte, Blutdruck), sondern ergänzt sie um die „Energie-Seite" deiner Gesundheit.', 'Zusammen mit deinen ärztlichen Werten ergibt das ein rundes Bild – und eine gute Basis für gezielte Schritte.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Wer ordnet deine Blutwerte richtig ein?', options: ['Deine Ärztin/dein Arzt', 'Das Internet allein', 'Niemand, ist egal'], answer: 0, explain: 'Werte gehören in ärztliche Hände – Ernährung/Bewegung können sie unterstützen, ersetzen aber keine ärztliche Betreuung.' },
      { q: 'Was beeinflusst viele Gesundheitswerte positiv?', options: ['Vollwertig essen, Bewegung, Schlaf, weniger Zucker/Salz', 'Nichts davon', 'Nur Medikamente'], answer: 0, explain: 'Die Gewohnheiten aus dem Coaching zahlen auf viele Werte ein – ergänzend zur ärztlichen Betreuung.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Ernährung und Prävention', 'Leitlinien zu Blutdruck, Blutfetten und Blutzucker', 'WHO – Prävention nicht übertragbarer Krankheiten'],
    exercise: 'Wenn dein letzter Check-up länger her ist: Nimm dir vor, einen Termin zu machen. Notiere, welche Coaching-Gewohnheiten deine Werte unterstützen können.',
    habits: [
      { id: 'g11h1', text: 'Ärztliche Vorsorge im Blick', cat: 'planung' },
      { id: 'g11h2', text: 'Wert-freundliche Gewohnheiten halten', cat: 'mindset' },
    ],
  },
  {
    week: 12, title: 'Gesund bleiben', theme: 'Nachhaltigkeit', minutes: 7,
    teaser: 'Aus Vorsätzen wird ein gesunder Lebensstil, der sich gut anfühlt.',
    pages: [
      { icon: '🌱', title: 'Ein Lebensstil, keine Kur', paras: ['Gesundheit ist kein 12-Wochen-Projekt, sondern ein Lebensstil aus vielen kleinen Gewohnheiten. Was sich in diesen Wochen selbstverständlich angefühlt hat, darf bleiben.', 'Du brauchst keine Perfektion – ein gutes Muster über die Woche, das du dauerhaft magst, ist das Ziel.'] },
      { icon: '🏅', title: 'Deine wirksamsten Gewohnheiten', paras: ['Welche 3–4 Umstellungen haben dir am meisten gebracht – mehr Gemüse, weniger Zucker, mehr Bewegung, besserer Schlaf? Halte sie fest, das sind deine Anker.', 'In stressigen Phasen reichen diese Anker; alles andere darf mal pausieren.'] },
      { icon: '🧭', title: 'Der Blick nach vorn', paras: ['Gesund essen und leben zahlt sich langfristig aus – für Energie heute und Lebensqualität morgen. Du hast das Rüstzeug, jetzt geht es ums Dranbleiben.', 'Im Coaching geht es mit Vertiefungen und weiteren Staffeln weiter – du bist nicht fertig, sondern auf einem guten Weg.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Gesunder Stoffwechsel über die Jahre', paras: ['Ein aktiver Stoffwechsel und erhaltene Muskelmasse sind zentrale Bausteine, um lange gesund, kräftig und beweglich zu bleiben. Ernährung und Bewegung sind deine wichtigsten Werkzeuge dafür.', 'Vieles, was du gelernt hast – bunt essen, Ballaststoffe, gute Fette, Bewegung, Schlaf – wirkt direkt auf deine Stoffwechsel- und Herzgesundheit.', 'Wenn du deinen Stoffwechsel genau kennen und gezielt unterstützen willst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt – ergänzend zur ärztlichen Vorsorge.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Was ist das Ziel beim Thema Gesundheit?', options: ['Ein dauerhafter Lebensstil aus guten Gewohnheiten', 'Eine kurze, strenge Kur', 'Perfektion an jedem Tag'], answer: 0, explain: 'Ein gutes Muster über die Woche, das du dauerhaft magst – kein 12-Wochen-Projekt.' },
      { q: 'Was hält dich langfristig gesund und leistungsfähig?', options: ['Aktiver Stoffwechsel + Muskeln + gute Ernährung/Bewegung', 'Möglichst wenig essen', 'Nur Nahrungsergänzung'], answer: 0, explain: 'Ernährung, Bewegung und erhaltene Muskelmasse sind die zentralen Bausteine.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Vollwertige Ernährung', 'WHO – Prävention und gesunde Lebensweise', 'Forschung zu Muskelmasse, Bewegung und Gesundheit'],
    exercise: 'Schreib deine 3–4 wirksamsten Gesundheits-Gewohnheiten auf und formuliere, wie du sie dauerhaft in deinen Alltag einbaust.',
    habits: [
      { id: 'g12h1', text: 'Top-Gesundheits-Gewohnheiten festhalten', cat: 'mindset' },
      { id: 'g12h2', text: 'Gutes Muster über die Woche halten', cat: 'planung' },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════
//  Track „Longevity" – 12-Wochen-Kern (eigener Content).
//  Fokus: gesundes Altern / Healthspan – lange fit, kräftig und beweglich
//  bleiben. Muster der Langlebigkeit (mediterran/Blue Zones), Eiweiß im Alter,
//  Muskeln, Entzündung runter, Knochen/Mikronährstoffe. Vorsichtig formuliert,
//  keine Heilversprechen; Bildungs-Disclaimer greift. Habit-IDs (l…).
// ═══════════════════════════════════════════════════════════════════════
const LONGEVITY = [
  {
    week: 1, title: 'Ankommen & Ziel „Longevity" schärfen', theme: 'Grundlagen', minutes: 9,
    teaser: 'Nicht nur alt werden, sondern lange fit bleiben – darum geht es hier.',
    pages: [
      { icon: '👋', title: 'Willkommen zu deinem Longevity-Coaching', paras: ['Schön, dass du da bist. Hier geht es nicht um schnelle Ergebnisse, sondern um das große Ziel: lange gesund, kräftig und beweglich zu bleiben – gute Jahre, nicht nur viele.', 'Fachleute nennen das „Healthspan" – die Zeitspanne, in der du gesund und aktiv lebst. Ernährung und Bewegung sind dafür deine stärksten Werkzeuge.', 'Diese erste Einheit legt das Fundament und zeigt, warum dein Stoffwechsel und deine Muskeln beim gesunden Altern die Hauptrolle spielen.'] },
      { icon: '🌍', title: 'Was Langlebigkeit fördert', paras: ['Studien zu besonders langlebigen Regionen und die Ernährungsforschung zeigen ein erstaunlich einfaches Muster: viel Pflanzliches, genug Eiweiß, gute Fette, wenig stark Verarbeitetes und Zucker – dazu Bewegung, Schlaf und soziale Bindung.', 'Kein einzelnes Wundermittel, sondern ein Lebensstil. Genau den bauen wir Schritt für Schritt auf.'] },
      { icon: '🧭', title: 'Der lange Blick', paras: ['Beim Thema Longevity zählt Beständigkeit über Jahre, nicht Perfektion über Wochen. Kleine, gute Gewohnheiten, die du dauerhaft magst, schlagen jede kurzfristige Kur.', 'Es ist nie zu früh und nie zu spät, damit zu beginnen – jeder gesunde Schritt zahlt sich aus.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Stoffwechsel & gesundes Altern', paras: ['Ein gut funktionierender Stoffwechsel und erhaltene Muskelmasse gehören zu den wichtigsten Faktoren, um lange leistungsfähig zu bleiben. Beide lassen sich durch Ernährung und Bewegung stark beeinflussen.', 'Mit den Jahren neigt der Körper dazu, Muskeln abzubauen und der Stoffwechsel wird träger – genau dem wirken wir hier gezielt entgegen.', 'Wo dein Stoffwechsel und deine Körperzusammensetzung heute stehen, lässt sich im Studio messen – ein guter Ausgangspunkt für deine Longevity-Reise.'], cta: 'Stoffwechsel messen lassen' },
      { icon: '📓', title: 'So startest du diese Woche', paras: ['Beobachte diese Woche ehrlich: Wie viel Pflanzliches, wie viel Eiweiß, wie viel Bewegung steckt in deinem Alltag? Und wie steht es um Schlaf und Stress?', 'Kein Bewerten, nur Hinschauen. So erkennst du deine größten Hebel für ein langes, gesundes Leben.', 'Am Ende der Woche wissen wir, wo wir ansetzen.'] },
    ],
    quiz: [
      { q: 'Was meint „Healthspan"?', options: ['Die Zeitspanne, in der du gesund und aktiv lebst', 'Nur die Lebenslänge', 'Ein Nahrungsergänzungsmittel'], answer: 0, explain: 'Es geht um gute, gesunde Jahre – nicht nur um ein langes Leben.' },
      { q: 'Was fördert Langlebigkeit laut Forschung?', options: ['Ein Lebensstil: viel Pflanzliches, Eiweiß, Bewegung, Schlaf, Bindung', 'Ein einzelnes Superfood', 'Möglichst wenig essen und viel Stress'], answer: 0, explain: 'Es ist das Gesamtmuster aus Ernährung und Lebensstil – kein Wundermittel.' },
    ],
    sources: ['Studien zu „Blue Zones" und mediterraner Ernährung', 'WHO – Healthy ageing', 'Deutsche Gesellschaft für Ernährung (DGE): Ernährung im Alter'],
    exercise: 'Protokolliere ehrlich und schau auf deinen Anteil an Pflanzlichem, Eiweiß und Bewegung – plus Schlaf und Stress. Nur beobachten.',
    habits: [
      { id: 'l1h1', text: 'Ehrlich protokollieren', cat: 'tracking' },
      { id: 'l1h2', text: 'Auf Pflanzliches & Eiweiß achten', cat: 'gemuese' },
    ],
  },
  {
    week: 2, title: 'Das Muster der Langlebigkeit', theme: 'Grundlagen', minutes: 8,
    teaser: 'Mediterran & pflanzenbetont – das am besten untersuchte Ernährungsmuster.',
    pages: [
      { icon: '🫒', title: 'Die mediterrane Ernährung', paras: ['Die mediterrane Ernährung ist eines der am besten untersuchten Muster für Herz-Kreislauf-Gesundheit und gesundes Altern: viel Gemüse, Obst, Hülsenfrüchte, Vollkorn, Nüsse und Olivenöl, dazu Fisch, wenig rotes/verarbeitetes Fleisch.', 'Sie ist kein starres Programm, sondern eine bunte, sättigende Art zu essen, die du dauerhaft genießen kannst.'] },
      { icon: '🌱', title: 'Pflanzen in den Mittelpunkt', paras: ['Ein gemeinsamer Nenner langlebiger Regionen: der Teller ist überwiegend pflanzlich. Hülsenfrüchte, Gemüse, Vollkorn und Nüsse liefern Ballaststoffe, Eiweiß und schützende Pflanzenstoffe.', 'Tierisches ist Beilage, nicht Hauptdarsteller – mit Ausnahme von Fisch, der regelmäßig auf den Tisch kommt.'] },
      { icon: '🍽️', title: 'Wie es weniger wird', paras: ['Stark Verarbeitetes, Zucker und viel rotes/verarbeitetes Fleisch treten in den Hintergrund. Nicht durch Verbote, sondern indem das Gute mehr Raum bekommt.', 'Ein einfacher Start: eine pflanzliche Hauptmahlzeit mehr pro Woche und öfter Olivenöl statt Butter.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Warum das ganze Muster wirkt', paras: ['Nicht ein einzelner Nährstoff macht den Unterschied, sondern das Zusammenspiel: Ballaststoffe, ungesättigte Fette, Pflanzenstoffe und wenig schneller Zucker wirken gemeinsam auf Blutfette, Blutzucker und Entzündung.', 'Genau dieses Zusammenspiel wird mit einem gesünderen Stoffwechsel und gesundem Altern in Verbindung gebracht.', 'Du musst nichts perfekt machen – dich dem Muster anzunähern, bringt bereits viel.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was kennzeichnet die mediterrane Ernährung?', options: ['Viel Pflanzliches, Olivenöl, Fisch; wenig rotes/verarbeitetes Fleisch', 'Viel Fastfood', 'Nur Fleisch'], answer: 0, explain: 'Ein pflanzenbetontes, gut untersuchtes Muster für Herz und gesundes Altern.' },
      { q: 'Was wirkt bei diesem Muster?', options: ['Das Zusammenspiel vieler Bausteine', 'Ein einzelner Wundernährstoff', 'Möglichst viele Verbote'], answer: 0, explain: 'Ballaststoffe, gute Fette und Pflanzenstoffe wirken gemeinsam – nicht ein einzelnes Element.' },
    ],
    sources: ['Studien zur mediterranen Ernährung (z. B. PREDIMED)', 'Blue-Zones-Forschung', 'Deutsche Gesellschaft für Ernährung (DGE): Vollwertige Ernährung'],
    exercise: 'Plane diese Woche eine zusätzliche pflanzliche Hauptmahlzeit und tausche einmal Butter gegen Olivenöl.',
    habits: [
      { id: 'l2h1', text: 'Eine pflanzliche Hauptmahlzeit mehr', cat: 'gemuese' },
      { id: 'l2h2', text: 'Olivenöl statt Butter', cat: 'fette' },
    ],
  },
  {
    week: 3, title: 'Eiweiß im Alter', theme: 'Makros', minutes: 8,
    teaser: 'Mit den Jahren wird Eiweiß wichtiger – es schützt deine Muskeln.',
    pages: [
      { icon: '🍗', title: 'Der Bedarf steigt', paras: ['Anders als man denkt, brauchen ältere Menschen tendenziell eher mehr Eiweiß, nicht weniger – Fachgesellschaften empfehlen im Alter oft rund 1,0–1,2 g/kg oder mehr, um Muskeln zu erhalten.', 'Der Grund: Der Körper baut Eiweiß mit den Jahren weniger effizient in Muskeln um. Genug davon zu essen wirkt dem entgegen.'] },
      { icon: '📊', title: 'Gut verteilen', paras: ['Verteil dein Eiweiß auf mehrere Mahlzeiten mit jeweils einer ordentlichen Portion – das nutzt die Muskel-Proteinsynthese besser, als alles auf einmal zu essen.', 'Eine einfache Regel: zu jeder Hauptmahlzeit eine Handfläche Eiweiß.'] },
      { icon: '🌱', title: 'Gute Quellen, gemischt', paras: ['Eine Mischung ist ideal: Hülsenfrüchte, Tofu, Nüsse, Vollkorn, dazu Fisch, Eier, Milchprodukte und Fleisch in Maßen. Pflanzliche und tierische Quellen ergänzen sich gut.', 'Mehr Pflanzliches und weniger rotes/verarbeitetes Fleisch passt zum Longevity-Muster.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Sarkopenie – dem Muskelabbau vorbeugen', paras: ['Ab etwa dem 30. Lebensjahr verliert der Körper ohne Gegenwehr langsam Muskeln (Sarkopenie). Das schwächt Kraft, Stoffwechsel und Selbstständigkeit im Alter.', 'Genug Eiweiß plus Krafttraining ist die stärkste bekannte Gegenmaßnahme – es hält Muskeln und damit den Grundumsatz und deine Mobilität.', 'Wie viel Muskelmasse du hast, lässt sich im Studio messen – eine besonders wertvolle Info fürs gesunde Altern.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Wie verändert sich der Eiweißbedarf im Alter?', options: ['Er steigt eher, um Muskeln zu erhalten', 'Er sinkt stark', 'Er verschwindet ganz'], answer: 0, explain: 'Im Alter empfehlen Fachgesellschaften oft mehr Eiweiß (~1,0–1,2 g/kg oder mehr).' },
      { q: 'Was ist Sarkopenie?', options: ['Der altersbedingte Muskelabbau', 'Eine Zuckerkrankheit', 'Ein Vitamin'], answer: 0, explain: 'Ab ~30 baut der Körper ohne Gegenwehr Muskeln ab – Eiweiß + Krafttraining wirken dem entgegen.' },
    ],
    sources: ['Bauer J et al. (PROT-AGE): Eiweißempfehlungen für ältere Menschen', 'Deutsche Gesellschaft für Ernährung (DGE): Protein im Alter', 'Literatur zu Sarkopenie'],
    exercise: 'Bau zu jeder Hauptmahlzeit eine ordentliche Eiweißportion ein und wähle eine gute Mischung aus pflanzlichen und tierischen Quellen.',
    habits: [
      { id: 'l3h1', text: 'Eiweiß zu jeder Hauptmahlzeit', cat: 'protein' },
      { id: 'l3h2', text: 'Eiweiß über den Tag verteilen', cat: 'protein' },
    ],
  },
  {
    week: 4, title: 'Muskeln & Krafttraining', theme: 'Training', minutes: 8,
    teaser: 'Muskeln sind dein wichtigstes „Longevity-Organ" – so hältst du sie.',
    pages: [
      { icon: '💪', title: 'Muskeln = Altersvorsorge', paras: ['Muskulatur ist weit mehr als Optik: Sie hält dich stark, beweglich und selbstständig, schützt vor Stürzen und unterstützt einen gesunden Stoffwechsel. Kaum etwas prognostiziert gesundes Altern so gut wie Kraft.', 'Was du an Muskeln aufbaust und erhältst, ist eine direkte Investition in dein zukünftiges Ich.'] },
      { icon: '🏋️', title: 'Krafttraining lohnt in jedem Alter', paras: ['Krafttraining wirkt in jedem Alter – auch mit 60, 70 oder 80 lässt sich Muskeln aufbauen. 2× pro Woche mit steigender Belastung reicht als starke Basis.', 'Ergänzt durch Balance- und Beweglichkeitsübungen schützt es zusätzlich vor Stürzen.'] },
      { icon: '🍽️', title: 'Ernährung, die Muskeln unterstützt', paras: ['Genug Eiweiß, genug Energie und eine gute Nährstoffversorgung sind der Treibstoff, damit dein Körper auf das Training mit Muskelerhalt und -aufbau reagiert.', 'Training baut den Motor, Ernährung liefert Bausteine und Energie – beide gehören zusammen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskeln, Blutzucker & Stoffwechsel', paras: ['Muskeln nehmen einen großen Teil des Blutzuckers auf und unterstützen die Insulinempfindlichkeit. Mehr aktive Muskelmasse heißt oft ein gesünderer Zuckerstoffwechsel – ein Kernstück des gesunden Alterns.', 'Zudem hält Muskulatur den Grundumsatz oben, was das Gewicht-Halten über die Jahre erleichtert.', 'Krafttraining plus Eiweiß ist damit einer der wirksamsten Longevity-Hebel überhaupt.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum sind Muskeln „Altersvorsorge"?', options: ['Kraft, Beweglichkeit, Selbstständigkeit, Sturzschutz, Stoffwechsel', 'Nur fürs Aussehen', 'Sie schaden im Alter'], answer: 0, explain: 'Muskeln halten dich stark und selbstständig und unterstützen den Stoffwechsel – zentral fürs gesunde Altern.' },
      { q: 'Ab wann lohnt Krafttraining?', options: ['In jedem Alter', 'Nur bis 30', 'Gar nicht'], answer: 0, explain: 'Muskelaufbau ist auch im hohen Alter möglich – 2×/Woche sind eine starke Basis.' },
    ],
    sources: ['WHO – Physical activity guidelines (inkl. Krafttraining)', 'Literatur zu Krafttraining im Alter und Sturzprävention', 'Forschung zu Muskelkraft und Mortalität'],
    exercise: 'Plane 2 Krafteinheiten diese Woche (auch zuhause möglich) und ergänze eine kurze Balance-Übung – dazu genug Eiweiß.',
    habits: [
      { id: 'l4h1', text: '2× Krafttraining/Woche', cat: 'bewegung' },
      { id: 'l4h2', text: 'Balance/Beweglichkeit üben', cat: 'bewegung' },
    ],
  },
  {
    week: 5, title: 'Pflanzenkraft & Ballaststoffe', theme: 'Gesundheit', minutes: 7,
    teaser: 'Je pflanzenreicher und bunter, desto besser für Darm, Zellen und lange Gesundheit.',
    pages: [
      { icon: '🌈', title: 'Bunt und pflanzenreich', paras: ['Ein pflanzenreicher, bunter Teller liefert Ballaststoffe, Vitamine, Mineralstoffe und sekundäre Pflanzenstoffe – ein Paket, das mit gesundem Altern in Verbindung gebracht wird.', 'Ziel: Vielfalt. Je unterschiedlicher deine pflanzlichen Lebensmittel über die Woche, desto breiter die Versorgung.'] },
      { icon: '🫘', title: 'Hülsenfrüchte – die Longevity-Stars', paras: ['Hülsenfrüchte (Linsen, Bohnen, Kichererbsen) sind ein gemeinsamer Nenner langlebiger Regionen: viel Eiweiß, viele Ballaststoffe, sättigend und günstig.', 'Ein paar Portionen pro Woche sind ein einfacher, wirksamer Schritt.'] },
      { icon: '🌾', title: 'Ballaststoffe im Fokus', paras: ['Rund 30 g Ballaststoffe am Tag (DGE) unterstützen Verdauung, Sättigung und werden mit vielen gesundheitlichen Vorteilen verbunden. Vollkorn, Gemüse, Obst, Hülsenfrüchte, Nüsse liefern sie.', 'Langsam steigern und genug trinken – dann gewöhnt sich der Darm gut daran.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Mikrobiom, Ballaststoffe & Entzündung', paras: ['Ballaststoffe füttern dein Darmmikrobiom, das daraus schützende kurzkettige Fettsäuren bildet. Ein vielfältiges Mikrobiom wird mit einem gesünderen Stoffwechsel und weniger chronischer Entzündung in Verbindung gebracht.', 'Chronische, niedriggradige Entzündung gilt als ein Treiber vieler Alterskrankheiten – pflanzenreiche Kost wirkt hier günstig.', 'Vielfalt auf dem Teller ist damit gelebte Vorsorge – für Darm, Zellen und langes Wohlbefinden.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum sind Hülsenfrüchte „Longevity-Stars"?', options: ['Viel Eiweiß + Ballaststoffe, sättigend, in langlebigen Regionen verbreitet', 'Sie haben keine Nährstoffe', 'Sie sind ungesund'], answer: 0, explain: 'Hülsenfrüchte sind ein gemeinsamer Nenner langlebiger Regionen – wertvoll und günstig.' },
      { q: 'Was füttern Ballaststoffe?', options: ['Dein Darmmikrobiom', 'Nur Fettzellen', 'Nichts'], answer: 0, explain: 'Das Mikrobiom bildet aus Ballaststoffen schützende kurzkettige Fettsäuren.' },
    ],
    sources: ['Reynolds A et al. (2019, The Lancet): Ballaststoffe und Gesundheit', 'Blue-Zones-Forschung (Hülsenfrüchte)', 'Deutsche Gesellschaft für Ernährung (DGE): Ballaststoffe'],
    exercise: 'Iss heute eine Portion Hülsenfrüchte und bring über den Tag mindestens 4–5 verschiedene pflanzliche Lebensmittel auf den Teller.',
    habits: [
      { id: 'l5h1', text: 'Hülsenfrüchte einplanen', cat: 'ballaststoffe' },
      { id: 'l5h2', text: 'Pflanzenvielfalt über die Woche', cat: 'gemuese' },
    ],
  },
  {
    week: 6, title: 'Gute Fette für Herz & Hirn', theme: 'Makros', minutes: 7,
    teaser: 'Die richtigen Fette unterstützen Herz, Gefäße und das alternde Gehirn.',
    pages: [
      { icon: '🐟', title: 'Omega-3 im Fokus', paras: ['Fetter Fisch 1–2× pro Woche liefert Omega-3-Fettsäuren, die mit Herz-Kreislauf-Vorteilen und einer Rolle für die Gehirngesundheit in Verbindung gebracht werden. Pflanzlich liefern Lein-, Raps- und Walnussöl eine Vorstufe.', 'Für Menschen, die keinen Fisch essen, kann Algenöl eine pflanzliche Omega-3-Quelle sein.'] },
      { icon: '🫒', title: 'Ungesättigt statt gesättigt', paras: ['Olivenöl, Nüsse, Samen und Avocado liefern herzfreundliche ungesättigte Fette – ein Kern der mediterranen Ernährung. Sie treten an die Stelle von viel gesättigtem Fett und Transfetten.', 'Nüsse sind dabei ein besonders praktischer, langlebigkeits-typischer Snack.'] },
      { icon: '🧠', title: 'Fett fürs Gehirn', paras: ['Das Gehirn besteht zu großen Teilen aus Fett. Eine gute Fettqualität – besonders Omega-3 – wird mit dem Erhalt kognitiver Funktionen im Alter in Verbindung gebracht.', 'Gute Fette sind also nicht nur Herz-, sondern auch Kopfsache.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Fette, Entzündung & Gefäße', paras: ['Die Art der Fette beeinflusst Blutfettwerte und Entzündungsprozesse. Ungesättigte Fette und Omega-3 werden mit günstigeren Werten und weniger Entzündung in Verbindung gebracht – wichtig für gesunde Gefäße über die Jahre.', 'Gesunde Gefäße versorgen Herz, Gehirn und Muskeln – die Grundlage für Leistungsfähigkeit im Alter.', 'Deine Blutfettwerte gehören in ärztliche Kontrolle; die Fettqualität in der Ernährung kann sie unterstützen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Welche Fette stehen bei Longevity im Fokus?', options: ['Ungesättigte + Omega-3 (Fisch, Nüsse, Olivenöl)', 'Transfette', 'Möglichst viel gesättigtes Fett'], answer: 0, explain: 'Ungesättigte Fette und Omega-3 werden mit Herz- und Gehirngesundheit verbunden.' },
      { q: 'Warum sind gute Fette „Kopfsache"?', options: ['Das Gehirn besteht zu großen Teilen aus Fett', 'Fett hat keine Bedeutung fürs Gehirn', 'Nur Zucker zählt fürs Gehirn'], answer: 0, explain: 'Gute Fettqualität, v. a. Omega-3, wird mit dem Erhalt kognitiver Funktionen verbunden.' },
    ],
    sources: ['Leitlinien zu Omega-3 und Herz-Kreislauf-Gesundheit', 'Studien zu mediterraner Ernährung und Kognition', 'Deutsche Gesellschaft für Ernährung (DGE): Fett und Fettsäuren'],
    exercise: 'Plane eine Portion fetten Fisch (oder eine pflanzliche Omega-3-Quelle) für diese Woche und snacke eine Handvoll Nüsse statt Süßem.',
    habits: [
      { id: 'l6h1', text: 'Omega-3-Quelle pro Woche', cat: 'fette' },
      { id: 'l6h2', text: 'Nüsse als Snack', cat: 'fette' },
    ],
  },
  {
    week: 7, title: 'Blutzucker & gesundes Altern', theme: 'Stoffwechsel', minutes: 8,
    teaser: 'Ein ruhiger Blutzucker über die Jahre ist ein Baustein für langes Wohlbefinden.',
    pages: [
      { icon: '🩸', title: 'Warum stabiler Blutzucker zählt', paras: ['Wie dein Körper mit Blutzucker umgeht, ist ein wichtiger Teil der Stoffwechselgesundheit. Dauerhaft günstige Muster werden mit gesundem Altern in Verbindung gebracht.', 'Das Ziel ist kein Verzicht auf Kohlenhydrate, sondern eine ruhige, gleichmäßige Versorgung statt ständiger großer Spitzen.'] },
      { icon: '🥗', title: 'So bleibt er ruhig', paras: ['Ballaststoffe, Eiweiß und gute Fette zu Kohlenhydraten bremsen den Zuckeranstieg. Vollkorn statt Weißmehl, Gemüse zuerst, Süßes eher rund um Bewegung – kleine Prinzipien mit großer Wirkung.', 'Ein kurzer Spaziergang nach dem Essen glättet die Blutzuckerreaktion zusätzlich.'] },
      { icon: '🚶', title: 'Bewegung als Blutzucker-Helfer', paras: ['Muskelarbeit verbraucht Zucker direkt und verbessert die Insulinempfindlichkeit. Regelmäßige Bewegung ist damit einer der stärksten, natürlichsten Blutzucker-Helfer.', 'Auch hier gilt: Beständigkeit über die Jahre zählt mehr als kurzfristige Extreme.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Insulinempfindlichkeit über die Jahre', paras: ['Mit den Jahren und mit weniger Muskelmasse kann die Insulinempfindlichkeit abnehmen – der Körper braucht mehr Insulin, um den Blutzucker zu regeln. Muskeln, Bewegung und eine ballaststoffreiche Kost wirken dem entgegen.', 'Ein gut funktionierender Zuckerstoffwechsel entlastet den Körper und wird mit gesundem Altern in Verbindung gebracht.', 'Deinen Blutzucker solltest du ärztlich prüfen lassen; Ernährung und Bewegung sind starke unterstützende Stellschrauben.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was hält den Blutzucker ruhiger?', options: ['Ballaststoffe/Eiweiß/gute Fette zu Kohlenhydraten + Bewegung', 'Nur Süßes auf leeren Magen', 'Mahlzeiten auslassen'], answer: 0, explain: 'Die richtige Kombination und Bewegung glätten die Blutzuckerkurve.' },
      { q: 'Was verbessert die Insulinempfindlichkeit?', options: ['Muskeln und regelmäßige Bewegung', 'Weniger Bewegung', 'Mehr Zucker'], answer: 0, explain: 'Muskelarbeit und erhaltene Muskelmasse unterstützen einen gesunden Zuckerstoffwechsel.' },
    ],
    sources: ['Literatur zu Insulinempfindlichkeit, Muskelmasse und Altern', 'WHO – Prävention von Typ-2-Diabetes', 'Deutsche Gesellschaft für Ernährung (DGE): Kohlenhydrate'],
    exercise: 'Kombiniere heute Kohlenhydrate bewusst mit Eiweiß/Ballaststoffen und mach nach einer Mahlzeit einen kurzen Spaziergang.',
    habits: [
      { id: 'l7h1', text: 'Kohlenhydrate klug kombinieren', cat: 'kohlenhydrate' },
      { id: 'l7h2', text: 'Spaziergang nach dem Essen', cat: 'bewegung' },
    ],
  },
  {
    week: 8, title: 'Entzündung runterfahren', theme: 'Gesundheit', minutes: 7,
    teaser: 'Chronische stille Entzündung gilt als Alterungstreiber – so isst du dagegen.',
    pages: [
      { icon: '🔥', title: 'Was „stille Entzündung" ist', paras: ['Neben akuter Entzündung (z. B. bei einer Wunde) gibt es eine chronische, niedriggradige Entzündung, die man nicht spürt. Sie wird mit vielen Alterskrankheiten in Verbindung gebracht.', 'Ernährung und Lebensstil können sie beeinflussen – im Guten wie im Schlechten.'] },
      { icon: '🥦', title: 'Entzündungsfreundlich essen', paras: ['Günstig gelten: viel Gemüse und Obst, Omega-3 (Fisch, Nüsse, Leinöl), Olivenöl, Vollkorn, Hülsenfrüchte, Kräuter und Gewürze. Also genau das mediterrane Muster.', 'Ungünstig gelten viel Zucker, stark Verarbeitetes und ein Übermaß an Alkohol.'] },
      { icon: '🌿', title: 'Kleine Extras', paras: ['Farbige Pflanzenstoffe (Beeren, grünes Blattgemüse, Kurkuma, Ingwer) werden mit antioxidativen und entzündungshemmenden Effekten in Verbindung gebracht. Als Teil einer bunten Kost sind sie ein netter Bonus.', 'Kein einzelnes „Wunder-Gewürz" ist nötig – die Vielfalt macht’s.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Entzündung, Fett & Stoffwechsel', paras: ['Überschüssiges Bauchfett und ein ungünstiger Lebensstil können stille Entzündung fördern; eine pflanzenreiche Kost und Bewegung wirken dem entgegen. Entzündung und Stoffwechselgesundheit hängen eng zusammen.', 'Wer Muskeln erhält, sich bewegt und bunt isst, schafft ein Umfeld, das Entzündung eher dämpft.', 'Das ist gelebte Vorsorge – für Gefäße, Gelenke und langes Wohlbefinden.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was gilt als entzündungsfreundlich?', options: ['Mediterranes Muster: Gemüse, Omega-3, Olivenöl, Vollkorn', 'Viel Zucker und stark Verarbeitetes', 'Viel Alkohol'], answer: 0, explain: 'Pflanzenreich, Omega-3 und wenig Verarbeitetes/Zucker wirken günstig auf stille Entzündung.' },
      { q: 'Was ist „stille Entzündung"?', options: ['Chronische, niedriggradige Entzündung ohne spürbare Symptome', 'Eine akute Wunde', 'Ein Vitaminmangel'], answer: 0, explain: 'Sie wird mit Alterskrankheiten verbunden und lässt sich über Ernährung/Lebensstil beeinflussen.' },
    ],
    sources: ['Übersichtsarbeiten zu Ernährung und chronischer Entzündung', 'Studien zur mediterranen Ernährung und Entzündungsmarkern', 'WHO – Prävention nicht übertragbarer Krankheiten'],
    exercise: 'Bau heute bewusst entzündungsfreundliche Lebensmittel ein: Beeren oder grünes Blattgemüse, eine Omega-3-Quelle und ein Gewürz wie Kurkuma/Ingwer.',
    habits: [
      { id: 'l8h1', text: 'Buntes Gemüse/Beeren einbauen', cat: 'gemuese' },
      { id: 'l8h2', text: 'Weniger Zucker/Verarbeitetes', cat: 'achtsamkeit' },
    ],
  },
  {
    week: 9, title: 'Maßvoll essen', theme: 'Strategie', minutes: 7,
    teaser: 'Nicht ständig im Überschuss leben – maßvolles Essen tut dem Körper langfristig gut.',
    pages: [
      { icon: '🍽️', title: 'Qualität und Maß', paras: ['In langlebigen Regionen fällt oft auf: Man isst gut, aber selten bis zur völligen Übersättigung. Ein maßvoller Umgang mit der Menge – nicht ständig im Überschuss – wird mit gesundem Altern in Verbindung gebracht.', 'Das heißt nicht hungern, sondern bewusst bis „angenehm satt" essen, nicht bis „pappsatt".'] },
      { icon: '🧘', title: 'Achtsam & langsam', paras: ['Langsam und ohne Ablenkung essen, auf echte Sättigung achten – das hilft, das richtige Maß fast automatisch zu treffen. Das Sättigungssignal braucht etwa 15 Minuten.', 'Eine bekannte Faustregel aus Okinawa: aufhören, wenn man zu etwa 80 % satt ist.'] },
      { icon: '⚖️', title: 'Gewicht im gesunden Bereich', paras: ['Ein Körpergewicht im gesunden Bereich über die Jahre entlastet Gelenke, Herz und Stoffwechsel. Maßvolles Essen und Bewegung halten es dort, ohne strenge Diäten.', 'Extreme sind selten nötig – Beständigkeit und Augenmaß bringen mehr.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Energiebalance über Jahrzehnte', paras: ['Dauerhaft deutlich mehr essen als verbrauchen belastet über die Jahre Stoffwechsel und Gefäße. Ein maßvoller, ausgeglichener Umgang mit Energie unterstützt die Stoffwechselgesundheit.', 'Wichtig fürs gesunde Altern ist dabei: genug Eiweiß und Bewegung, damit maßvolles Essen die Muskeln nicht kostet – Muskelerhalt bleibt Priorität.', 'Es geht nicht um Kasteiung, sondern um ein entspanntes, ausgeglichenes Maß über die Zeit.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was heißt „maßvoll essen" hier?', options: ['Bis angenehm satt, nicht bis pappsatt', 'Dauerhaft hungern', 'Immer im großen Überschuss'], answer: 0, explain: 'Bewusst bis „angenehm satt" – die Okinawa-Regel „80 % satt" ist ein gutes Bild.' },
      { q: 'Worauf muss man beim maßvollen Essen achten?', options: ['Genug Eiweiß + Bewegung, damit Muskeln bleiben', 'Muskeln sind egal', 'Möglichst wenig Eiweiß'], answer: 0, explain: 'Muskelerhalt bleibt Priorität – maßvoll essen soll nicht die Muskeln kosten.' },
    ],
    sources: ['Blue-Zones-Forschung (u. a. Okinawa, „Hara Hachi Bu")', 'Übersichtsarbeiten zu Energiebalance und Altern', 'Deutsche Gesellschaft für Ernährung (DGE): Energiebedarf'],
    exercise: 'Iss heute eine Mahlzeit bewusst langsam und ohne Bildschirm und höre auf, wenn du angenehm (nicht komplett) satt bist.',
    habits: [
      { id: 'l9h1', text: 'Bis „angenehm satt" essen', cat: 'achtsamkeit' },
      { id: 'l9h2', text: 'Langsam & ohne Bildschirm', cat: 'achtsamkeit' },
    ],
  },
  {
    week: 10, title: 'Knochen & Mikronährstoffe', theme: 'Gesundheit', minutes: 7,
    teaser: 'Kalzium, Vitamin D und B12 – im Alter besonders wichtig im Blick zu behalten.',
    pages: [
      { icon: '🦴', title: 'Starke Knochen', paras: ['Knochen bleiben durch Belastung (Bewegung, Krafttraining) und eine gute Versorgung mit Kalzium und Vitamin D stabil. Das beugt im Alter Knochenschwund (Osteoporose) und Brüchen vor.', 'Kalzium steckt in Milchprodukten, grünem Gemüse, Hülsenfrüchten und angereicherten Pflanzendrinks.'] },
      { icon: '☀️', title: 'Vitamin D nicht vergessen', paras: ['Vitamin D bildet der Körper mit Sonnenlicht – im Winter und mit dem Alter oft zu wenig. Es ist wichtig für Knochen und Muskeln. Eine Nahrungsergänzung kann sinnvoll sein, am besten nach ärztlicher Rücksprache/Bluttest.', 'Fetter Fisch und angereicherte Lebensmittel liefern zusätzlich etwas Vitamin D.'] },
      { icon: '💊', title: 'B12 & Co. im Blick', paras: ['Die Aufnahme von Vitamin B12 kann im Alter nachlassen; bei pflanzenbetonter/veganer Ernährung ist eine Ergänzung ohnehin nötig. Auch Eisen, Omega-3, Jod und Folsäure lohnen einen Blick.', 'Statt wahllos Präparate zu schlucken: gezielt schauen, was du brauchst – idealerweise über Ernährung und, wo nötig, gezielte Ergänzung nach ärztlichem Rat.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Mikronährstoffe als Stoffwechsel-Helfer', paras: ['Vitamine und Mineralstoffe sind Co-Faktoren in unzähligen Stoffwechselprozessen – von der Energiegewinnung über die Muskelfunktion bis zum Immunsystem. Ein Mangel kann sich vielfältig bemerkbar machen.', 'Eine bunte, vollwertige Ernährung deckt den Großteil; einzelne kritische Nährstoffe (v. a. Vitamin D, B12) verdienen im Alter besondere Aufmerksamkeit.', 'Deine Versorgung lässt sich ärztlich über Blutwerte prüfen – die sicherste Basis für gezielte Ergänzung.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Was hält Knochen im Alter stabil?', options: ['Belastung (Bewegung) + Kalzium + Vitamin D', 'Nur Ruhe', 'Möglichst wenig Bewegung'], answer: 0, explain: 'Krafttraining/Belastung plus gute Kalzium- und Vitamin-D-Versorgung beugt Osteoporose vor.' },
      { q: 'Welche Nährstoffe verdienen im Alter besondere Aufmerksamkeit?', options: ['Vor allem Vitamin D und B12', 'Nur Zucker', 'Gar keine'], answer: 0, explain: 'Vitamin-D-Bildung und B12-Aufnahme lassen im Alter oft nach – am besten ärztlich prüfen.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Vitamin D, B12, Kalzium', 'Leitlinien zu Osteoporose-Prävention', 'Literatur zu Mikronährstoffen im Alter'],
    exercise: 'Bau heute eine gute Kalziumquelle ein (Milchprodukt, grünes Gemüse, angereicherter Pflanzendrink) und prüfe, ob du beim Arzt mal Vitamin D/B12 checken lassen willst.',
    habits: [
      { id: 'l10h1', text: 'Kalziumquelle einbauen', cat: 'gesundheit' },
      { id: 'l10h2', text: 'Vitamin D/B12 im Blick (ärztlich)', cat: 'planung' },
    ],
  },
  {
    week: 11, title: 'Bewegung, Schlaf & Stress', theme: 'Verhalten', minutes: 7,
    teaser: 'Longevity ist mehr als Essen – Bewegung, Schlaf und Verbundenheit gehören dazu.',
    pages: [
      { icon: '🏃', title: 'Bewegung als Lebenselixier', paras: ['Regelmäßige Bewegung ist einer der stärksten Faktoren für gesundes Altern: gut für Herz, Muskeln, Knochen, Gehirn und Stimmung. Die WHO empfiehlt ≥ 150 Minuten moderate Aktivität pro Woche plus Krafttraining.', 'Alltagsbewegung zählt genauso – in langlebigen Regionen bewegen sich Menschen natürlich viel, ohne „Sport" im engen Sinn.'] },
      { icon: '😴', title: 'Schlaf als Reparaturzeit', paras: ['Im Schlaf regeneriert der Körper, verarbeitet Erlebtes und stärkt das Immunsystem. Guter, regelmäßiger Schlaf (meist 7–9 Stunden) ist eine tragende Säule des gesunden Alterns.', 'Feste Zeiten, dunkles Zimmer, weniger Bildschirm und Koffein am Abend helfen.'] },
      { icon: '🤝', title: 'Stress & Verbundenheit', paras: ['Chronischer Stress belastet die Gesundheit; soziale Bindung und ein Gefühl von Sinn gehören dagegen zu den Gemeinsamkeiten langlebiger Menschen. Der Mensch ist ein soziales Wesen – Beziehungen sind Gesundheitsvorsorge.', 'Bewusste Erholung, Zeit mit anderen und Dinge, die dir Freude machen, sind kein Luxus, sondern Teil des Plans.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Erholung, Hormone & Alterung', paras: ['Schlaf und Stressabbau halten Hormone und Stoffwechsel im Gleichgewicht; chronischer Stress und Schlafmangel dagegen fördern ungünstige Muster und stille Entzündung.', 'Bewegung wirkt zusätzlich direkt auf Stoffwechsel, Muskeln und Gehirn – ein Rundum-Schutz fürs Altern.', 'Ernährung, Bewegung, Schlaf und Verbundenheit greifen ineinander. Zusammen ergeben sie das Fundament eines langen, gesunden Lebens.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was gehört neben Ernährung zu Longevity?', options: ['Bewegung, Schlaf, Stressabbau, soziale Bindung', 'Nur Nahrungsergänzung', 'Nichts weiter'], answer: 0, explain: 'Gesundes Altern ist ein Zusammenspiel aus Ernährung und Lebensstil – inkl. Beziehungen und Sinn.' },
      { q: 'Warum ist Schlaf so wichtig fürs Altern?', options: ['Er ist Reparatur- und Regenerationszeit', 'Er ist Zeitverschwendung', 'Er schadet dem Stoffwechsel'], answer: 0, explain: 'Im Schlaf regeneriert der Körper und stärkt das Immunsystem – eine tragende Säule.' },
    ],
    sources: ['WHO – Physical activity & Healthy ageing', 'Blue-Zones-Forschung (Bewegung, Bindung, Sinn)', 'Übersichtsarbeiten zu Schlaf, Stress und Gesundheit'],
    exercise: 'Plane diese Woche 150 Minuten Bewegung, eine feste Schlafenszeit und bewusst Zeit mit Menschen, die dir guttun.',
    habits: [
      { id: 'l11h1', text: 'Täglich bewegen (Alltag + Sport)', cat: 'bewegung' },
      { id: 'l11h2', text: 'Feste Schlafenszeit', cat: 'schlaf' },
    ],
  },
  {
    week: 12, title: 'Ein Leben lang dranbleiben', theme: 'Nachhaltigkeit', minutes: 8,
    teaser: 'Longevity ist ein Lebensstil – so machst du ihn zu deiner Normalität.',
    pages: [
      { icon: '🌱', title: 'Vom Kurs zur Lebensweise', paras: ['Longevity ist kein 12-Wochen-Ziel, sondern eine Lebensweise aus vielen kleinen, guten Gewohnheiten. Was sich jetzt selbstverständlich anfühlt, darf für immer bleiben.', 'Du brauchst keine Perfektion – Beständigkeit über die Jahre ist das, was zählt.'] },
      { icon: '🏅', title: 'Deine Longevity-Anker', paras: ['Welche Gewohnheiten haben dir am meisten gebracht – Krafttraining, pflanzenreich essen, genug Eiweiß, guter Schlaf, Bewegung, Verbundenheit? Halte deine Top 3–4 fest.', 'Diese Anker tragen dich auch durch stressige Phasen. Der Rest darf mal pausieren.'] },
      { icon: '🧭', title: 'Der Blick nach vorn', paras: ['Du hast das Rüstzeug für ein langes, gesundes Leben. Jetzt geht es ums Dranbleiben – und darum, ärztliche Vorsorge als Partner zu nutzen.', 'Im Coaching geht es mit Vertiefungen und weiteren Staffeln weiter – du bist nicht fertig, sondern auf dem besten Weg.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskeln & Stoffwechsel als Longevity-Fundament', paras: ['Erhaltene Muskelmasse und ein gesunder Stoffwechsel sind zwei der wichtigsten, beeinflussbaren Faktoren für gesundes Altern. Krafttraining und genug Eiweiß bleiben deshalb lebenslang Pflicht.', 'Vieles, was du gelernt hast – pflanzenreich essen, gute Fette, Ballaststoffe, Bewegung, Schlaf – wirkt direkt auf Stoffwechsel, Gefäße und Muskeln.', 'Wenn du deinen Stoffwechsel und deine Körperzusammensetzung genau kennen und über die Jahre begleiten willst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt – ergänzend zur ärztlichen Vorsorge.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Was ist beim Thema Longevity entscheidend?', options: ['Beständigkeit über die Jahre, kein 12-Wochen-Projekt', 'Perfektion an jedem Tag', 'Eine kurze, strenge Kur'], answer: 0, explain: 'Ein dauerhafter Lebensstil aus guten Gewohnheiten – Beständigkeit schlägt Perfektion.' },
      { q: 'Was ist ein zentrales, beeinflussbares Longevity-Fundament?', options: ['Erhaltene Muskeln + gesunder Stoffwechsel', 'Möglichst wenig Bewegung', 'Nur Nahrungsergänzung'], answer: 0, explain: 'Krafttraining und genug Eiweiß bleiben lebenslang wichtig – Muskeln sind ein Longevity-Organ.' },
    ],
    sources: ['Blue-Zones-Forschung', 'WHO – Healthy ageing', 'Forschung zu Muskelmasse, Stoffwechsel und Lebensqualität'],
    exercise: 'Schreib deine 3–4 wirksamsten Longevity-Gewohnheiten auf und formuliere, wie du sie dauerhaft in dein Leben einbaust – inkl. ärztlicher Vorsorge.',
    habits: [
      { id: 'l12h1', text: 'Top-Longevity-Gewohnheiten festhalten', cat: 'mindset' },
      { id: 'l12h2', text: 'Krafttraining + pflanzenreich beibehalten', cat: 'bewegung' },
    ],
  },
];

// ── Definieren · Staffel 2 „Aufbaustufe" (Wochen 13–20) ──────────────────
const DEFINIEREN_S2 = [
  {
    week: 13, title: 'Mini-Cut vs. langsame Diät', theme: 'Strategie', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Kurz und knackig oder langsam und entspannt – welche Definitions-Strategie zu dir passt.',
    pages: [
      { icon: '⚡', title: 'Zwei Wege zum Ziel', paras: ['Es gibt nicht die eine richtige Diät-Geschwindigkeit. Ein „Mini-Cut" ist ein kurzer, etwas straffer Cut über 4–6 Wochen; die langsame Diät zieht sich mit kleinerem Defizit über viele Wochen.', 'Beide funktionieren – die Frage ist, was besser zu deinem Kopf, deinem Alltag und deinem Ausgangspunkt passt.'] },
      { icon: '🏃', title: 'Wann Mini-Cut', paras: ['Ein Mini-Cut eignet sich, wenn du nur wenig Fett verlieren willst oder eine Aufbauphase kurz „aufräumen" möchtest. Kurze, klare Phase – dann wieder auf Erhaltung.', 'Vorteil: schneller vorbei, weniger Zeit im Defizit. Nachteil: etwas straffer, verlangt mehr Disziplin am Stück.'] },
      { icon: '🐢', title: 'Wann langsam', paras: ['Hast du mehr Fett zu verlieren oder magst du es entspannt, ist die langsame Diät mit kleinem Defizit ideal: mehr essen, mehr Spielraum, bessere Trainingsleistung.', 'Vorteil: angenehm und muskelschonend. Nachteil: du brauchst Geduld über viele Wochen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Zeit im Defizit & Anpassung', paras: ['Je länger und tiefer ein Defizit, desto stärker die adaptive Thermogenese (der Körper spart Energie) und desto größer das Muskelrisiko. Kürzere Phasen mit Pausen dazwischen halten den Stoffwechsel wacher.', 'Der Mini-Cut nutzt genau das: kurze Belastung, dann Erholung. Die langsame Diät hält das Defizit klein, damit die Anpassung mild bleibt.', 'Beide Wege minimieren – richtig gemacht – den Muskelverlust. Entscheidend sind Eiweiß, Krafttraining und dass du dranbleibst.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist ein Mini-Cut?', options: ['Eine kurze, etwas straffere Diätphase (4–6 Wochen)', 'Eine Diät ohne Ende', 'Ein Trainingsplan'], answer: 0, explain: 'Ein Mini-Cut ist eine kurze, klare Defizit-Phase – danach wieder Erhaltung.' },
      { q: 'Für wen eignet sich die langsame Diät?', options: ['Wer mehr Fett verlieren will / es entspannt mag', 'Nur Profis', 'Niemand'], answer: 0, explain: 'Kleines Defizit über viele Wochen ist angenehm und muskelschonend – gut bei mehr Fett oder für den entspannten Weg.' },
    ],
    sources: ['Helms ER et al.: Empfehlungen zur Diätgestaltung', 'Byrne HK et al. (2018): MATADOR (intermittierende Restriktion)', 'Literatur zu Diätdauer und Muskelerhalt'],
    exercise: 'Entscheide bewusst deine Strategie für die nächsten Wochen: kurzer Mini-Cut oder langsame Diät – und lege Defizit-Höhe und Dauer fest.',
    habits: [
      { id: 'd13h1', text: 'Diät-Strategie bewusst wählen', cat: 'planung' },
      { id: 'd13h2', text: 'Eiweiß + Kraft als Muskelschutz', cat: 'protein' },
    ],
  },
  {
    week: 14, title: 'Wasser, Salz & „Peak-Week"-Mythen', theme: 'Verhalten', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Warum du an manchen Tagen definierter aussiehst – und was an Entwässerungs-Tricks dran ist.',
    pages: [
      { icon: '💧', title: 'Dein Tagesbild ist Wasser', paras: ['Wie definiert du aussiehst, schwankt täglich stark mit dem Wasserhaushalt. Salz, Kohlenhydrate, Schlaf, Stress und bei Frauen der Zyklus verschieben das Bild – ganz ohne Fettänderung.', 'Ein „aufgeschwemmter" Tag heißt nicht, dass du Fett angesetzt hast. Meist ist es Wasser, das in ein paar Tagen wieder weg ist.'] },
      { icon: '🚫', title: 'Der Entwässerungs-Mythos', paras: ['Man liest oft von „Peak Week"-Tricks (extrem Wasser/Salz manipulieren), um in Topform auszusehen. Für dich als normal Trainierende:r ist das unnötig und teils riskant – es verändert nur kurzfristig Wasser, kein Fett.', 'Definierter wirst du durch weniger Körperfett über Wochen, nicht durch Wasser-Spielchen an einem Tag.'] },
      { icon: '🧂', title: 'Entspannt mit Salz & Wasser', paras: ['Iss Salz in normaler Menge und trink konstant genug – paradoxerweise lagert der Körper bei zu wenig Wasser eher mehr ein. Konstanz macht dein Tagesbild vergleichbarer.', 'Nach salzigem Essen die Waage am nächsten Tag ignorieren – das ist Wasser, kein Rückschritt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Glykogen, Wasser & Fülle', paras: ['Jedes Gramm Glykogen bindet Wasser. Mehr Kohlenhydrate = vollere, definiertere Muskeln (und etwas mehr Wasser); sehr wenig Kohlenhydrate lassen den Muskel „flach" wirken.', 'Deshalb kann ein kohlenhydratreicher Tag dich sogar definierter aussehen lassen – die Muskeln sind praller gefüllt.', 'Fazit: Bewerte deine Definition über Wochen und Fotos in gleichem Zustand, nicht über das tägliche Wasserbild.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was verändert dein tägliches „Definitions-Bild" am meisten?', options: ['Der Wasserhaushalt (Salz, Kohlenhydrate, Schlaf)', 'Fettzuwachs über Nacht', 'Muskelabbau über Nacht'], answer: 0, explain: 'Das Tagesbild schwankt v. a. durch Wasser – kein echter Fett- oder Muskelwandel.' },
      { q: 'Was bringen „Peak-Week"-Entwässerungstricks für Normaltrainierende?', options: ['Wenig bis nichts (nur kurzfristig Wasser), teils riskant', 'Dauerhaft weniger Fett', 'Mehr Muskeln'], answer: 0, explain: 'Sie verändern nur kurzfristig Wasser – Definition kommt von weniger Körperfett über Wochen.' },
    ],
    sources: ['Literatur zu Natrium, Glykogen und Wassereinlagerung', 'Helms ER et al.: Kritik an aggressiven Peak-Week-Praktiken', 'Deutsche Gesellschaft für Ernährung (DGE): Wasser- und Elektrolythaushalt'],
    exercise: 'Mach ein Vergleichsfoto immer unter gleichen Bedingungen (morgens, nüchtern) und ignoriere bewusst dein Tagesbild nach salzigen Mahlzeiten.',
    habits: [
      { id: 'd14h1', text: 'Konstant genug trinken', cat: 'wasser' },
      { id: 'd14h2', text: 'Tagesbild gelassen nehmen', cat: 'mindset' },
    ],
  },
  {
    week: 15, title: 'Recomposition vertieft', theme: 'Fortschritt', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Fett verlieren und Muskeln aufbauen zugleich – wann es geht und wie du es steuerst.',
    pages: [
      { icon: '🔄', title: 'Was Recomposition kann', paras: ['„Body Recomposition" heißt: gleichzeitig Fett verlieren und Muskeln aufbauen. Die Waage steht oft still, während sich Form und Definition deutlich verbessern.', 'Das ist real – aber es geht langsamer als reines Ab- oder Aufbauen und funktioniert bei manchen besser als bei anderen.'] },
      { icon: '🎯', title: 'Wer profitiert am meisten', paras: ['Besonders gut klappt Recomposition bei Trainingseinsteiger:innen, nach längerer Pause, bei höherem Körperfett oder mit sehr sauberem Training + viel Eiweiß.', 'Fortgeschrittene mit wenig Fett bauen langsamer um – für sie sind getrennte Phasen (Cut / Aufbau) oft effizienter.'] },
      { icon: '🔧', title: 'So stellst du es ein', paras: ['Recomposition läuft meist bei ungefähr Erhaltungskalorien (leichtes Defizit an Ruhetagen, leichter Überschuss an Trainingstagen), immer mit viel Eiweiß und progressivem Krafttraining.', 'Miss den Fortschritt über Kraft, Umfänge und Fotos – nicht über die Waage, die hier bewusst kaum wandert.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Der „Nährstoff-Umschichtung" auf der Spur', paras: ['Bei Recomposition lenkt der Körper Energie und Aminosäuren gezielt in den Muskel, während er Fett als Energie nutzt – begünstigt durch den Trainingsreiz und hohes Eiweiß.', 'Volle Glykogenspeicher und guter Schlaf schaffen ein anaboles Umfeld, in dem Aufbau und Fettabbau nebeneinander laufen können.', 'Wie sich Fett- und Muskelmasse tatsächlich verändern, macht eine Körperanalyse im Studio sichtbar – gerade bei Recomposition Gold wert.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Was ist Recomposition?', options: ['Gleichzeitig Fett verlieren und Muskel aufbauen', 'Nur Fett verlieren', 'Nur Muskeln aufbauen'], answer: 0, explain: 'Beides zugleich – langsamer, aber die Form verbessert sich, während die Waage steht.' },
      { q: 'Wer profitiert am meisten von Recomposition?', options: ['Einsteiger, nach Pause, höheres Körperfett', 'Nur sehr definierte Profis', 'Niemand'], answer: 0, explain: 'Einsteiger und Menschen mit mehr Fett bauen am ehesten gleichzeitig um.' },
    ],
    sources: ['Barakat C et al.: Body Recomposition (Review)', 'ISSN: Diet & Body Composition', 'Literatur zu gleichzeitigem Fettabbau und Muskelaufbau'],
    exercise: 'Wenn du auf Recomposition setzt: Iss um deine Erhaltung herum (Trainingstag etwas mehr), halte das Eiweiß hoch und bewerte den Fortschritt an Kraft/Umfängen.',
    habits: [
      { id: 'd15h1', text: 'Kalorien um Erhaltung steuern', cat: 'planung' },
      { id: 'd15h2', text: 'Fortschritt an Kraft/Umfängen messen', cat: 'tracking' },
    ],
  },
  {
    week: 16, title: 'Trainingssteuerung im Defizit', theme: 'Training', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Wie du im Cut hart genug trainierst, um Muskeln zu halten – ohne dich zu überlasten.',
    pages: [
      { icon: '🏋️', title: 'Intensität halten, Volumen anpassen', paras: ['Der wichtigste Muskelschutz-Reiz im Defizit ist, schwer zu trainieren (Intensität halten). Beim Gesamt-Trainingsvolumen darfst du dagegen etwas zurückfahren, wenn die Erholung im Cut leidet.', 'Faustregel: Gewichte hochhalten, lieber ein, zwei Sätze weniger als die Qualität opfern.'] },
      { icon: '🔋', title: 'Mit weniger Energie umgehen', paras: ['Im Defizit ist weniger Energie da – Leistung kann leicht schwanken. Lege deine wichtigsten (schweren) Einheiten auf Tage mit mehr Kohlenhydraten und guter Erholung.', 'An müden Tagen ein etwas leichteres Training ist okay – Konstanz über Wochen schlägt das perfekte Einzeltraining.'] },
      { icon: '😌', title: 'Übertraining vermeiden', paras: ['Im Cut ist die Erholung eingeschränkt. Zu viel Volumen plus zu wenig Essen führt zu Leistungseinbruch, schlechtem Schlaf und Muskelverlust – das Gegenteil des Ziels.', 'Achte auf Erholungssignale: Kraft, Schlaf, Motivation. Bei Einbruch: Volumen runter oder eine leichtere Woche (Deload).'] },
      { kind: 'metabolism', icon: '🧬', title: 'Reiz vs. Erschöpfung', paras: ['Der Wachstums-/Erhaltungsreiz kommt vor allem aus intensiven, schweren Sätzen – nicht aus endlosem Volumen. Im Defizit, wo die Erholung knapper ist, zählt Qualität mehr als Menge.', 'Ausreichend Eiweiß und Kohlenhydrate rund ums Training halten die Leistung und schützen die Muskeln, während der Körper Fett abbaut.', 'So gibst du deinem Körper klar das Signal „Muskeln behalten" – ohne ihn zu überfordern.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was hältst du im Defizit möglichst hoch?', options: ['Die Trainingsintensität (schwere Gewichte)', 'Nur das Volumen', 'Die Kalorien'], answer: 0, explain: 'Schwer trainieren schützt die Muskeln; das Gesamtvolumen darf bei knapper Erholung etwas sinken.' },
      { q: 'Was ist ein Zeichen für zu viel im Cut?', options: ['Kraft-/Schlaf-/Motivationseinbruch', 'Stabile Leistung', 'Gute Laune'], answer: 0, explain: 'Einbruch bei Kraft, Schlaf oder Motivation zeigt: Volumen runter oder Deload.' },
    ],
    sources: ['Literatur zu Trainingsvolumen/-intensität im Defizit', 'Helms ER et al.: Training in der Diät', 'ISSN: Recovery'],
    exercise: 'Plane deine schwerste Einheit auf einen gut erholten, kohlenhydratreichen Tag und reduziere bei Müdigkeit lieber das Volumen als die Gewichte.',
    habits: [
      { id: 'd16h1', text: 'Intensität hochhalten', cat: 'bewegung' },
      { id: 'd16h2', text: 'Auf Erholungssignale achten', cat: 'mindset' },
    ],
  },
  {
    week: 17, title: 'Diätpausen bewusst nutzen', theme: 'Strategie', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Geplante Pausen auf Erhaltung machen lange Definitionsphasen leichter und muskelschonender.',
    pages: [
      { icon: '⏸️', title: 'Warum Pausen helfen', paras: ['In einer langen Definitionsphase sind geplante Pausen auf Erhaltungsniveau (1–2 Wochen) ein starkes Werkzeug: Sie geben Kopf und Hormonen eine Erholung und beugen Muskelverlust vor.', 'Kein Rückschritt – im Gegenteil: Wer pausiert, hält den Fortschritt über die Gesamtzeit oft besser.'] },
      { icon: '📅', title: 'Wann und wie', paras: ['Sinnvoll ist eine Pause z. B. alle 4–8 Wochen Defizit, oder wenn Leistung, Schlaf und Motivation nachlassen. In der Pause isst du kontrolliert auf Erhaltung – nicht „alles egal".', 'Danach steigst du ruhig wieder ins moderate Defizit ein.'] },
      { icon: '🧠', title: 'Der mentale Effekt', paras: ['Diät ist auch Kopfsache. Eine geplante Pause nimmt Druck, reduziert das Risiko für Fressattacken und macht die nächste Defizit-Phase leichter durchzuhalten.', 'Struktur statt Dauer-Verzicht – das hält dich langfristig dran.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Leptin, Hormone & Erholung', paras: ['Im längeren Defizit sinkt das Sättigungshormon Leptin, Hunger steigt, Alltagsbewegung (NEAT) sinkt oft. Eine Erhaltungsphase kann Leptin wieder anheben und diese Anpassung teils zurückdrehen.', 'Das erleichtert den weiteren Fettabbau und schützt die Muskeln – Studien zu geplanten Pausen (z. B. MATADOR) zeigen den Nutzen.', 'Pausen sind also kein „Ausbruch", sondern Teil einer klugen Strategie.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist eine Diätpause?', options: ['1–2 Wochen kontrolliert auf Erhaltung', 'Ein Cheat-Wochenende', 'Komplett aufhören zu essen'], answer: 0, explain: 'Eine geplante Phase auf Erhaltungsniveau – kontrolliert, kein „alles egal".' },
      { q: 'Was bewirkt eine Diätpause hormonell?', options: ['Leptin steigt, Anpassung wird teils zurückgedreht', 'Sie verbrennt direkt Fett', 'Nichts'], answer: 0, explain: 'Sie hebt das im Defizit gesunkene Leptin und erleichtert so den weiteren Fettabbau.' },
    ],
    sources: ['Byrne HK et al. (2018): MATADOR', 'Rosenbaum M, Leibel RL: Leptin und adaptive Thermogenese', 'Helms ER et al.: Diätpausen in der Vorbereitung'],
    exercise: 'Plane deine nächste Diätpause: Setze nach einigen Wochen Defizit 1–2 Erhaltungswochen an und halte darin Eiweiß und Training konstant.',
    habits: [
      { id: 'd17h1', text: 'Diätpause einplanen', cat: 'planung' },
      { id: 'd17h2', text: 'In der Pause Eiweiß/Kraft halten', cat: 'protein' },
    ],
  },
  {
    week: 18, title: 'Flexible Makros', theme: 'Umsetzung', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: '„If It Fits Your Macros" richtig verstanden – Flexibilität mit Struktur.',
    pages: [
      { icon: '🎛️', title: 'Was flexibles Tracken heißt', paras: ['Beim flexiblen Ansatz („IIFYM") zählen deine Tagesziele für Kalorien und Makros – vor allem Eiweiß. Innerhalb dieses Rahmens darfst du frei wählen, auch mal etwas Süßes.', 'Das nimmt Verbote raus und macht die Definition alltagstauglich – solange die Zahlen und die Basis stimmen.'] },
      { icon: '🥦', title: 'Struktur nicht vergessen', paras: ['Flexibel heißt nicht „nur Süßes, solange es passt". Für Sättigung, Nährstoffe und Leistung sollte der Großteil aus vollwertigen Lebensmitteln kommen – die 80/20-Idee gilt auch hier.', 'Eiweiß und Gemüse zuerst, dann bleibt Raum für Genuss, ohne dass Hunger oder Nährstoffe leiden.'] },
      { icon: '📊', title: 'Für wen sinnvoll', paras: ['Flexibles Tracken ist ideal für Fortgeschrittene, die genauer steuern wollen. Wer keine Lust auf Zahlen hat, kommt mit Handmaß, Eiweiß-Fokus und gutem Augenmaß ebenfalls weit.', 'Nutze das Werkzeug, das du durchhältst – Konstanz schlägt Präzision.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Warum Eiweiß der Ankerwert ist', paras: ['Im Rahmen der Makros ist Eiweiß der wichtigste Wert: Es schützt im Defizit die Muskeln und sättigt am stärksten. Kohlenhydrate und Fette darfst du je nach Vorliebe verschieben.', 'So kannst du dein Essen an dein Leben anpassen (mehr Kohlenhydrate an Trainingstagen, mehr Fett an ruhigen), ohne den Muskelschutz zu gefährden.', 'Flexibilität mit Eiweiß-Anker – das ist Definition, die man dauerhaft durchhält.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist beim flexiblen Tracken der wichtigste Wert?', options: ['Eiweiß', 'Zucker', 'Die Uhrzeit'], answer: 0, explain: 'Eiweiß schützt die Muskeln und sättigt – Kohlenhydrate/Fette darfst du nach Vorliebe verschieben.' },
      { q: 'Was heißt flexibles Tracken NICHT?', options: ['Nur Süßes essen, solange es „passt"', 'Vollwertige Basis + etwas Genuss', 'Eiweiß im Blick behalten'], answer: 0, explain: 'Der Großteil sollte vollwertig sein (80/20) – sonst leiden Sättigung, Nährstoffe und Leistung.' },
    ],
    sources: ['ISSN: Diet & Body Composition (Makronährstoffe)', 'Literatur zu flexibler vs. rigider Kontrolle', 'Helms ER et al.: Makronährstoff-Empfehlungen'],
    exercise: 'Triff heute dein Eiweißziel und gestalte Kohlenhydrate/Fette flexibel um dein Training herum – mit vollwertiger Basis und etwas eingeplantem Genuss.',
    habits: [
      { id: 'd18h1', text: 'Eiweißziel als Anker treffen', cat: 'protein' },
      { id: 'd18h2', text: 'Vollwertige Basis + geplanter Genuss', cat: 'mindset' },
    ],
  },
  {
    week: 19, title: 'Reverse Diet – sauber aussteigen', theme: 'Nachhaltigkeit', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Nach dem Cut die Kalorien schrittweise anheben – ohne die Definition sofort zu verlieren.',
    pages: [
      { icon: '📈', title: 'Nicht sofort „normal" essen', paras: ['Nach einer Definitionsphase ist die Versuchung groß, sofort wieder viel zu essen. Das legt aber schnell eine Fettschicht über die mühsam erarbeitete Definition.', 'Besser: die Kalorien schrittweise anheben („Reverse Diet") und dein Gewicht/Aussehen dabei beobachten.'] },
      { icon: '🪜', title: 'Schritt für Schritt hoch', paras: ['Erhöhe wöchentlich in kleinen Schritten (vor allem Kohlenhydrate, etwas Fett) und schau, wie dein Gewicht reagiert. Bleibt es weitgehend stabil, kannst du weiter erhöhen.', 'So findest du deine neue Erhaltungsmenge und gibst dem Körper Zeit, sich anzupassen.'] },
      { icon: '🎯', title: 'Warum das lohnt', paras: ['Mehr essen bei gehaltener Definition heißt: mehr Energie, bessere Trainingsleistung, besserer Schlaf und mehr Spielraum – und eine gute Basis für eine spätere Aufbauphase.', 'Geduld hier zahlt sich aus: Du sicherst das Ergebnis, statt es zu verspielen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Verbrauch nach der Diät', paras: ['Nach einer Diät ist der Verbrauch oft etwas niedriger als vorher (adaptive Thermogenese). Ein langsames Anheben lässt Stoffwechsel und Hormone sich erholen, statt sofort Fett einzulagern.', 'Muskeln erhalten und Krafttraining fortführen hält den Grundumsatz oben – so verträgst du mehr Kalorien bei stabiler Form.', 'Reverse Diet ist damit kein „Zauber", sondern ein bewusstes, geduldiges Wieder-Hochfahren.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist eine Reverse Diet?', options: ['Kalorien nach dem Cut schrittweise anheben', 'Sofort wieder viel essen', 'Für immer im Defizit bleiben'], answer: 0, explain: 'Langsames Anheben sichert die Definition und findet die neue Erhaltungsmenge.' },
      { q: 'Warum nicht sofort „normal" essen?', options: ['Das legt schnell Fett über die Definition', 'Es ist zu langweilig', 'Es ist egal'], answer: 0, explain: 'Ein plötzlicher Sprung führt oft zu raschem Fettzuwachs – schrittweise ist besser.' },
    ],
    sources: ['Literatur zu Post-Diät-Phasen und adaptiver Thermogenese', 'Helms ER et al.: Recovery/Reverse nach der Diät', 'Rosenbaum M, Leibel RL: Energieverbrauch nach Gewichtsabnahme'],
    exercise: 'Plane deinen Ausstieg: Hebe nach dem Cut die Kalorien wöchentlich in kleinen Schritten an und beobachte Gewicht und Aussehen.',
    habits: [
      { id: 'd19h1', text: 'Kalorien schrittweise anheben', cat: 'planung' },
      { id: 'd19h2', text: 'Gewicht/Aussehen mitbeobachten', cat: 'tracking' },
    ],
  },
  {
    week: 20, title: 'Definition langfristig halten', theme: 'Nachhaltigkeit', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Deine Form dauerhaft bewahren – und entscheiden, wie es weitergeht.',
    pages: [
      { icon: '🎯', title: 'Form wird zur Normalität', paras: ['Definition zu halten heißt, deine Gewohnheiten – viel Eiweiß, Krafttraining, bewusstes Essen – zur unauffälligen Normalität zu machen. Kein Dauer-Cut, sondern ein Lebensstil mit Spielraum.', 'Du hast das Handwerk gelernt; jetzt trägt es dich, ohne dass du ständig „auf Diät" bist.'] },
      { icon: '🔁', title: 'Bulk-Cut-Zyklen', paras: ['Wer mehr Muskeln (und damit noch mehr Form) will, wechselt in eine Aufbauphase und definiert später erneut. Dieses Wechselspiel aus Aufbau und Cut ist der klassische Weg zu einem muskulösen, definierten Körper.', 'Zwischendurch Erhaltungsphasen halten Kopf und Hormone frisch.'] },
      { icon: '🏅', title: 'Deine Anker sichern', paras: ['Halte deine 3–4 wirksamsten Gewohnheiten fest – Eiweiß, Krafttraining, dein Frühwarnsystem (Fotos/Umfänge). Diese Anker sichern deine Definition auch in stressigen Zeiten.', 'Im Coaching geht es mit Vertiefungen weiter – du bist nicht fertig, sondern souverän.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel hält Definition & Stoffwechsel', paras: ['Deine Definition steht und fällt mit deiner Muskelmasse. Krafttraining und genug Eiweiß bleiben deshalb dauerhaft Pflicht – Muskeln sind dein Look und dein Stoffwechsel-Motor.', 'Ein hoher Grundumsatz durch erhaltene Muskeln macht das Halten der Form leichter und gibt dir mehr Spielraum beim Essen.', 'Wenn du deinen Stoffwechsel und deine Körperzusammensetzung genau kennen willst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Was hält deine Definition langfristig?', options: ['Muskel halten: Krafttraining + Eiweiß, als Lebensstil', 'Dauerhaftes Hungern', 'Die Waage meiden'], answer: 0, explain: 'Definition steht und fällt mit der Muskelmasse – Training und Eiweiß bleiben dauerhaft wichtig.' },
      { q: 'Was ist der klassische Weg zu mehr Form?', options: ['Wechsel aus Aufbau- und Definitionsphasen', 'Nur Dauer-Cut', 'Gar nichts tun'], answer: 0, explain: 'Bulk-Cut-Zyklen bauen über die Zeit einen muskulösen, definierten Körper.' },
    ],
    sources: ['Helms ER et al.: Empfehlungen für natürliche Athleten (Post-Diät & Zyklen)', 'Literatur zu Bulk-/Cut-Zyklen', 'Forschung zu Muskelmasse und Ruheenergieumsatz'],
    exercise: 'Lege fest, wie es weitergeht (Definition halten oder Aufbauphase) und welche 3–4 Gewohnheiten du in jedem Fall dauerhaft behältst.',
    habits: [
      { id: 'd20h1', text: 'Nächste Phase bewusst planen', cat: 'planung' },
      { id: 'd20h2', text: 'Krafttraining + Eiweiß beibehalten', cat: 'protein' },
    ],
  },
];

// ── Aufbau · Staffel 2 „Aufbaustufe" (Wochen 13–20) ──────────────────────
const AUFBAU_S2 = [
  {
    week: 13, title: 'Volumen & Progression steuern', theme: 'Training', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Wie viel Training braucht der Muskel wirklich – und wie steigerst du klug?',
    pages: [
      { icon: '📊', title: 'Volumen ist der Treiber', paras: ['Das wöchentliche Trainingsvolumen (grob: harte Sätze pro Muskelgruppe) ist einer der stärksten Hebel fürs Muskelwachstum. Für die meisten sind etwa 10–20 harte Sätze pro Muskel und Woche ein guter Bereich.', 'Mehr ist nicht automatisch besser: Ab einem Punkt kostet zusätzliches Volumen nur Erholung, ohne mehr Wachstum.'] },
      { icon: '📈', title: 'Progressive Steigerung', paras: ['Der Muskel wächst, wenn du ihn über die Zeit forderst: mehr Gewicht, mehr Wiederholungen oder mehr Sätze. Steigere in kleinen Schritten, statt alles auf einmal.', 'Ein einfaches Modell: Halte die Übung, versuche Woche für Woche eine Wiederholung oder etwas mehr Gewicht – solange die Technik sauber bleibt.'] },
      { icon: '🎯', title: 'Qualität vor Menge', paras: ['Ein paar harte, saubere Sätze nahe der Belastungsgrenze bringen mehr als viele halbherzige. Die letzten Wiederholungen (mit 1–3 „im Tank") sind die wachstumswirksamen.', 'Wer das Volumen erhöht, sollte Erholung und Ernährung mitwachsen lassen – sonst kippt das Verhältnis.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Reiz, Erholung & Superkompensation', paras: ['Training setzt einen Reiz, der den Muskel kurzfristig ermüdet; in der Erholung baut der Körper ihn etwas stärker wieder auf – „Superkompensation". Dafür braucht er Energie, Eiweiß und Zeit.', 'Zu viel Volumen ohne genug Erholung dreht den Effekt um: Ermüdung staut sich, der Aufbau stockt. Genau deshalb sind Überschuss und Schlaf im Aufbau so wichtig.', 'Ein Stoffwechsel-Check im Studio hilft, deinen Bedarf zur aktuellen Trainingsbelastung abzustimmen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist ein guter Volumen-Bereich pro Muskel/Woche?', options: ['Etwa 10–20 harte Sätze', 'So viele wie irgend möglich', '1 Satz'], answer: 0, explain: 'Rund 10–20 harte Sätze sind für die meisten ideal – mehr kostet vor allem Erholung.' },
      { q: 'Wie steigerst du klug?', options: ['In kleinen Schritten (Gewicht/Wiederholungen), Technik sauber', 'Jede Woche das Maximum', 'Nie steigern'], answer: 0, explain: 'Progressive, kleine Steigerungen bei sauberer Technik treiben das Wachstum nachhaltig.' },
    ],
    sources: ['Schoenfeld BJ et al.: Trainingsvolumen und Hypertrophie (Meta-Analysen)', 'Literatur zu progressiver Belastung', 'ISSN: Diet & Body Composition'],
    exercise: 'Zähle diese Woche deine harten Sätze pro Muskelgruppe und plane bei einer Hauptübung eine kleine Steigerung (1 Wiederholung oder etwas Gewicht).',
    habits: [
      { id: 'a13h1', text: 'Harte Sätze pro Muskel im Blick', cat: 'bewegung' },
      { id: 'a13h2', text: 'Eine kleine Progression setzen', cat: 'bewegung' },
    ],
  },
  {
    week: 14, title: 'Lean-Bulk-Feintuning', theme: 'Strategie', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Den Überschuss so justieren, dass Muskeln wachsen und wenig Fett dazukommt.',
    pages: [
      { icon: '🎛️', title: 'Den Überschuss nachschärfen', paras: ['Der ideale Überschuss ist der kleinste, bei dem du noch stetig Kraft und Gewicht aufbaust. Zu klein: kein Fortschritt. Zu groß: unnötig Fett. Beobachte deinen Wochenschnitt und justiere.', 'Faustregel: etwa 0,2–0,4 kg Zunahme pro Woche für Fortgeschrittene, etwas mehr für Einsteiger.'] },
      { icon: '📉', title: 'Wenn zu viel Fett kommt', paras: ['Steigt die Waage deutlich schneller als geplant oder wächst vor allem die Taille, ist der Überschuss zu hoch – dann in kleinen Schritten reduzieren.', 'Kraftfortschritt ohne starken Taillenzuwachs ist das Zeichen, dass die Richtung stimmt.'] },
      { icon: '🍚', title: 'Qualität hält das Verhältnis gut', paras: ['Nährstoffreiche, sättigende Lebensmittel machen es leichter, den Überschuss kontrolliert zu treffen, statt über Süßes/Fastfood unbemerkt zu weit drüber zu landen.', 'Eiweiß hoch, gute Kohlenhydrate rund ums Training, gute Fette – so bleibt der Aufbau „lean".'] },
      { kind: 'metabolism', icon: '🧬', title: 'Wohin die Energie fließt', paras: ['Ein moderater Überschuss plus harter Trainingsreiz lenkt mehr Energie in die Muskeln; ein zu großer Überschuss landet überproportional im Fettdepot. Du steuerst die Weiche über Höhe des Überschusses und Trainingsqualität.', 'Mit steigendem Gewicht steigt auch dein Verbrauch – der Überschuss muss über die Wochen leicht nachgezogen werden, damit der Aufbau nicht stockt.', 'Eine Körperanalyse im Studio zeigt, ob dein Zuwachs eher Muskel oder Fett ist.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Was ist der ideale Überschuss?', options: ['Der kleinste, bei dem du noch stetig aufbaust', 'Der größtmögliche', 'Gar keiner'], answer: 0, explain: 'So klein wie möglich, so groß wie nötig – das hält den Fettzuwachs gering.' },
      { q: 'Woran erkennst du „zu viel Fett"?', options: ['Waage/Taille steigen deutlich schneller als geplant', 'Die Kraft steigt', 'Nichts'], answer: 0, explain: 'Schneller Waagen-/Taillenzuwachs heißt: Überschuss reduzieren.' },
    ],
    sources: ['Garthe I et al.: Gewichtszunahme-Rate und Körperzusammensetzung', 'ISSN: Diet & Body Composition', 'Literatur zu Lean-Bulk'],
    exercise: 'Prüfe deinen Gewichts-Wochenschnitt: Liegst du bei ~0,2–0,4 kg/Woche? Wenn deutlich mehr, reduziere den Überschuss leicht.',
    habits: [
      { id: 'a14h1', text: 'Zunahme-Tempo kontrollieren', cat: 'tracking' },
      { id: 'a14h2', text: 'Überschuss aus echtem Essen', cat: 'kohlenhydrate' },
    ],
  },
  {
    week: 15, title: 'Nährstoff-Timing realistisch', theme: 'Makros', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Was am Timing wirklich zählt – und was überbewerteter Mythos ist.',
    pages: [
      { icon: '⏱️', title: 'Das „anabole Fenster"', paras: ['Der Mythos vom engen „anabolen Fenster" direkt nach dem Training ist entschärft: Wichtiger als die Minute nach dem Satz ist, dass du über den Tag genug Eiweiß und Energie bekommst.', 'Eine Eiweißportion in den paar Stunden um das Training herum reicht völlig – kein Stress mit dem Shaker im Umkleideraum nötig.'] },
      { icon: '🍽️', title: 'Was sinnvoll ist', paras: ['Sinnvoll: Eiweiß gleichmäßig über 3–5 Mahlzeiten, Kohlenhydrate rund ums Training für Leistung und Auffüllung, eine Eiweißquelle vor dem Schlafen (z. B. Quark).', 'Das sind kleine Optimierungen auf einer soliden Basis – nicht der Kern des Aufbaus.'] },
      { icon: '🎯', title: 'Prioritäten richtig setzen', paras: ['Reihenfolge der Wichtigkeit: 1) Gesamtkalorien, 2) genug Eiweiß, 3) Verteilung/Timing, 4) Supplemente. Wer die ersten beiden trifft, hat fast alles.', 'Verzettel dich nicht in Timing-Details, solange die Basis nicht steht.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel-Proteinsynthese über den Tag', paras: ['Die Muskel-Proteinsynthese wird über den Tag mehrfach durch Eiweißmahlzeiten angeregt. Eine gleichmäßige Verteilung nutzt das besser als eine große Portion.', 'Volle Glykogenspeicher (durch Kohlenhydrate rund ums Training) verbessern Leistung und schaffen ein anaboles Umfeld – der eigentliche Timing-Nutzen.', 'Insgesamt zählt die Tagesbilanz weit mehr als die exakte Uhrzeit – dein Stoffwechsel arbeitet über Stunden, nicht Minuten.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie wichtig ist das enge „anabole Fenster"?', options: ['Überbewertet – die Tagesbilanz zählt mehr', 'Alles entscheidend', 'Man muss in 5 Minuten essen'], answer: 0, explain: 'Genug Eiweiß und Energie über den Tag sind wichtiger als die Minute nach dem Training.' },
      { q: 'Was hat Priorität?', options: ['Gesamtkalorien und Eiweiß', 'Nur das Timing', 'Nur Supplemente'], answer: 0, explain: 'Kalorien und Eiweiß zuerst – Timing und Supplemente sind Feinschliff.' },
    ],
    sources: ['Aragon AA, Schoenfeld BJ: Nutrient Timing revisited', 'ISSN: Position Stand – Nutrient Timing', 'Literatur zur Proteinverteilung'],
    exercise: 'Verteile heute dein Eiweiß auf mind. 3 Portionen, lege Kohlenhydrate rund ums Training – und lass den Timing-Stress los.',
    habits: [
      { id: 'a15h1', text: 'Eiweiß auf 3–5 Portionen', cat: 'protein' },
      { id: 'a15h2', text: 'Kohlenhydrate rund ums Training', cat: 'kohlenhydrate' },
    ],
  },
  {
    week: 16, title: 'Regenerations-Management', theme: 'Verhalten', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Mehr Wachstum durch bessere Erholung – Schlaf, Ruhetage und Stress im Griff.',
    pages: [
      { icon: '😴', title: 'Erholung ist Teil des Trainings', paras: ['Der Muskel wächst zwischen den Einheiten. Wer hart trainiert, aber schlecht regeneriert, verschenkt Fortschritt. Schlaf (7–9 h) ist der wichtigste, kostenlose Erholungs-Hebel.', 'Zu wenig Erholung zeigt sich als stagnierende Kraft, schlechter Schlaf, Reizbarkeit und Lustlosigkeit.'] },
      { icon: '🗓️', title: 'Ruhetage & Deloads', paras: ['Plane Ruhetage bewusst ein und alle paar Wochen eine leichtere Woche (Deload), in der du Volumen/Intensität reduzierst. Danach kommst du oft stärker zurück.', 'Mehr Training ist nicht automatisch mehr Wachstum – Reiz und Erholung müssen zusammenpassen.'] },
      { icon: '🌀', title: 'Stress zählt mit', paras: ['Alltagsstress und Trainingsstress addieren sich. In stressigen Lebensphasen ist es klüger, das Volumen etwas zu senken, als sich zu überfordern.', 'Aktive Erholung (Spaziergang, lockere Bewegung), gutes Essen und Wasser unterstützen die Regeneration.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Schlaf, Hormone & Aufbau', paras: ['Im Tiefschlaf schüttet der Körper Wachstumshormon aus; ausreichend Schlaf unterstützt einen gesunden Testosteronspiegel – beides fördert Aufbau und Regeneration.', 'Chronischer Schlafmangel und Dauerstress heben Cortisol, das den Aufbau bremst und den Abbau begünstigt. Erholung ist damit direkt anabol.', 'Wer gut regeneriert, kann härter und häufiger trainieren – der eigentliche Wachstums-Turbo.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum ist Erholung so wichtig?', options: ['Der Muskel wächst zwischen den Einheiten', 'Sie ist Zeitverschwendung', 'Nur Training zählt'], answer: 0, explain: 'Ohne genug Erholung stockt der Aufbau, egal wie hart du trainierst.' },
      { q: 'Was ist ein Deload?', options: ['Eine geplante leichtere Woche', 'Ein Maximalversuch', 'Ein Supplement'], answer: 0, explain: 'Eine leichtere Woche lässt Ermüdung abbauen – danach kommst du oft stärker zurück.' },
    ],
    sources: ['Literatur zu Schlaf, Wachstumshormon und Muskelaufbau', 'ISSN: Recovery', 'Übersichtsarbeiten zu Deload/Übertraining'],
    exercise: 'Lege eine feste Schlafenszeit fest, plane deine Ruhetage bewusst und überlege, ob eine leichtere Woche (Deload) ansteht.',
    habits: [
      { id: 'a16h1', text: '7–9 Stunden Schlaf anpeilen', cat: 'schlaf' },
      { id: 'a16h2', text: 'Ruhetage bewusst einplanen', cat: 'bewegung' },
    ],
  },
  {
    week: 17, title: 'Mini-Cut im Massephasen-Zyklus', theme: 'Strategie', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Zwischendurch etwas Fett abbauen, ohne den Aufbau-Fortschritt zu verlieren.',
    pages: [
      { icon: '✂️', title: 'Wozu ein Mini-Cut', paras: ['Nach einer längeren Aufbauphase hat sich meist etwas Fett angesammelt. Ein kurzer „Mini-Cut" (4–6 Wochen moderates Defizit) räumt das auf – und danach baust du wieder sauberer auf.', 'Vorteil: Du bleibst über die Zeit in einem angenehmen Körperfettbereich, statt immer weiter zuzunehmen.'] },
      { icon: '🛡️', title: 'Muskeln im Cut schützen', paras: ['Im Mini-Cut gelten dieselben Regeln wie beim Definieren: moderates Defizit, viel Eiweiß, Krafttraining mit gehaltener Intensität. So verlierst du Fett, nicht die aufgebauten Muskeln.', 'Kurz und knackig – lange, tiefe Defizite sind hier unnötig.'] },
      { icon: '🔁', title: 'Zurück in den Aufbau', paras: ['Nach dem Mini-Cut hebst du die Kalorien schrittweise wieder an (Reverse-Gedanke) und startest die nächste Aufbauphase mit besserer Ausgangslage.', 'Dieses Zyklische (Aufbau – Mini-Cut – Aufbau) ist ein bewährter Weg zu einem muskulösen, schlanken Körper.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Insulinempfindlichkeit & „P-Ratio"', paras: ['Bei höherem Körperfett verschiebt sich das Verhältnis, wie viel Überschuss in Muskel vs. Fett geht (grob „P-Ratio"), ungünstiger. Ein Mini-Cut verbessert die Ausgangslage – der nächste Aufbau läuft effizienter.', 'Weniger Körperfett und Training verbessern die Insulinempfindlichkeit; Nährstoffe landen eher im Muskel.', 'Eine Messung im Studio zeigt dir, wann sich ein Mini-Cut lohnt.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Was ist ein Mini-Cut?', options: ['Kurze Defizit-Phase (4–6 Wochen), um etwas Fett abzubauen', 'Ein Dauer-Defizit', 'Ein Trainingsplan'], answer: 0, explain: 'Ein kurzer Cut zwischen Aufbauphasen hält dich im angenehmen Körperfettbereich.' },
      { q: 'Wie schützt du im Mini-Cut die Muskeln?', options: ['Viel Eiweiß + Krafttraining, moderates Defizit', 'Radikal hungern', 'Kein Training'], answer: 0, explain: 'Wie beim Definieren: Eiweiß, Krafttraining, moderates Tempo schützen den Muskel.' },
    ],
    sources: ['Literatur zu Bulk-/Cut-Zyklen und Körperfett', 'Helms ER et al.: Empfehlungen für natürliche Athleten', 'Byrne HK et al. (2018): MATADOR'],
    exercise: 'Schätze deinen aktuellen Körperfett-Trend ein: Wäre ein 4–6-Wochen-Mini-Cut sinnvoll? Wenn ja, plane ihn mit Eiweiß + Krafttraining.',
    habits: [
      { id: 'a17h1', text: 'Körperfett-Trend beobachten', cat: 'tracking' },
      { id: 'a17h2', text: 'Im Cut Eiweiß + Kraft halten', cat: 'protein' },
    ],
  },
  {
    week: 18, title: 'Supplemente tiefer betrachtet', theme: 'Ernährungswissen', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Was über Kreatin und Eiweißpulver hinaus wirklich Evidenz hat.',
    pages: [
      { icon: '🧾', title: 'Die kurze Liste der Belegten', paras: ['Wirklich gut belegt sind wenige: Kreatin-Monohydrat (Kraft/Muskeln), Eiweißpulver (praktisch, um das Ziel zu treffen), Koffein (Leistung kurzfristig). Vitamin D und Omega-3 je nach Versorgung.', 'Fast alles andere ist Feinschliff oder Marketing. Die Basis (Training, Eiweiß, Überschuss, Schlaf) schlägt jedes Pulver.'] },
      { icon: '⚗️', title: 'Kreatin richtig nutzen', paras: ['Kreatin-Monohydrat, ~3–5 g täglich, dauerhaft – ein „Ladephase" ist nicht nötig. Es füllt die Kreatinspeicher, was ein, zwei Wiederholungen mehr erlaubt und den Muskel voller wirken lässt.', 'Günstig, sicher und eines der am besten untersuchten Supplemente überhaupt.'] },
      { icon: '🛑', title: 'Was du dir sparen kannst', paras: ['BCAAs (wenn du genug Eiweiß isst), „Testo-Booster", die meisten „Pump"- und „Fatburner"-Mixe bringen für den Aufbau wenig bis nichts. Bei fragwürdigen Extrakten ist Vorsicht besser.', 'Investiere das Geld lieber in gutes Essen und Schlaf.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Warum die Basics unschlagbar sind', paras: ['Kein Supplement kann fehlendes Eiweiß, zu wenig Energie oder schlechten Schlaf ausgleichen. Der Stoffwechsel baut Muskeln aus echten Bausteinen und Energie – nicht aus Kapseln.', 'Kreatin und Koffein verbessern die Trainingsleistung leicht und verstärken so den Reiz – aber nur auf einer soliden Basis.', 'Eine ehrliche Standortbestimmung im Studio zeigt, wo du wirklich ansetzen solltest.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Welche Supplemente sind für den Aufbau gut belegt?', options: ['Kreatin, Eiweißpulver, Koffein', 'Testo-Booster', 'Fatburner'], answer: 0, explain: 'Kreatin, Eiweißpulver und Koffein haben Evidenz – vieles andere ist Marketing.' },
      { q: 'Wie nimmst du Kreatin?', options: ['~3–5 g täglich dauerhaft, keine Ladephase nötig', 'Nur am Trainingstag viel', 'Gar nicht'], answer: 0, explain: '3–5 g pro Tag dauerhaft füllen die Speicher – eine Ladephase ist unnötig.' },
    ],
    sources: ['ISSN: Position Stand – Creatine (Kreider et al., 2017)', 'ISSN: Protein and Exercise', 'Verbraucherzentrale: Sportlernahrung'],
    exercise: 'Geh deine Supplemente ehrlich durch: Deckst du zuerst die Basics? Dann sind Kreatin (3–5 g/Tag) und ggf. Eiweißpulver sinnvolle Ergänzungen.',
    habits: [
      { id: 'a18h1', text: 'Basics vor Supplementen sichern', cat: 'planung' },
      { id: 'a18h2', text: 'Kreatin täglich (3–5 g)', cat: 'protein' },
    ],
  },
  {
    week: 19, title: 'Wenn der Aufbau stockt', theme: 'Stoffwechsel', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Plateau im Aufbau: die richtigen Stellschrauben statt Frust.',
    pages: [
      { icon: '⏸️', title: 'Erst die Ursache finden', paras: ['Stehen Kraft UND Gewicht, ist meist die Energie zu knapp – isst du wirklich im Überschuss? Steht die Kraft trotz Zunahme, liegt es oft am Training oder der Erholung.', 'Ehrlich nachrechnen und die Trainingsleistung prüfen schlägt jedes Bauchgefühl.'] },
      { icon: '➕', title: 'Kalorien nachziehen', paras: ['Mit steigendem Gewicht steigt der Verbrauch – der alte Überschuss reicht irgendwann nicht mehr. Erhöhe in kleinen Schritten (z. B. +150–250 kcal, v. a. Kohlenhydrate) und beobachte wieder.', 'Kleine Anpassungen, dann abwarten – nicht sofort 800 kcal draufpacken.'] },
      { icon: '🔧', title: 'Training & Erholung justieren', paras: ['Steht die Kraft trotz Überschuss: Prüfe Progression (steigerst du wirklich?), Volumen (zu viel/zu wenig?), Übungsauswahl, Schlaf und Stress. Manchmal hilft ein Deload.', 'Wechsle nicht ständig das Programm – gib jeder Anpassung ein paar Wochen Zeit.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Anpassung & Energieverfügbarkeit', paras: ['Ein größerer Körper verbraucht mehr Energie; zusätzlich kann viel unbewusste Alltagsbewegung (NEAT) den Überschuss auffressen. Beides erklärt, warum man die Kalorien im Aufbau nachziehen muss.', 'Gleichzeitig dämpft zu wenig Erholung die anabolen Signale. Energie UND Regeneration müssen stimmen, damit der Aufbau weiterläuft.', 'Eine Stoffwechselmessung zeigt deinen aktuellen Bedarf – dann triffst du den nötigen Überschuss wieder genau.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Kraft UND Gewicht stehen – wahrscheinlichste Ursache?', options: ['Zu wenig Energie (kein echter Überschuss)', 'Zu viel Schlaf', 'Zu viel Eiweiß'], answer: 0, explain: 'Stagnieren beide, ist die Energie meist zu knapp – ehrlich nachrechnen und moderat erhöhen.' },
      { q: 'Warum Kalorien im Aufbau nachziehen?', options: ['Mit dem Gewicht steigt der Verbrauch', 'Aus Langeweile', 'Gar nicht nötig'], answer: 0, explain: 'Ein größerer Körper braucht mehr – der alte Überschuss reicht irgendwann nicht mehr.' },
    ],
    sources: ['Literatur zu Energiebilanz und Gewichtszunahme', 'Levine JA: NEAT', 'Schoenfeld BJ: Trainingsvariablen der Hypertrophie'],
    exercise: 'Bei Stillstand: Rechne 3 Tage genau nach, ob du im Überschuss bist. Wenn ja und die Kraft steht, plane einen Deload oder prüfe deine Progression.',
    habits: [
      { id: 'a19h1', text: 'Bei Stillstand Kalorien moderat +', cat: 'planung' },
      { id: 'a19h2', text: 'Progression/Erholung prüfen', cat: 'bewegung' },
    ],
  },
  {
    week: 20, title: 'Bulk sauber beenden', theme: 'Nachhaltigkeit', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Die Aufbauphase gut abschließen – und entscheiden, wie es weitergeht.',
    pages: [
      { icon: '🏁', title: 'Wann beenden', paras: ['Eine Aufbauphase endet sinnvoll, wenn der Körperfettanteil in einen Bereich kommt, in dem du dich nicht mehr wohlfühlst, oder wenn du das Erreichte definieren willst. Endloses Bulken lohnt selten.', 'Ein guter Abschluss ist geplant, kein plötzlicher Stopp.'] },
      { icon: '📉', title: 'Übergang gestalten', paras: ['Willst du danach definieren, wechselst du in ein moderates Defizit (siehe Definieren-Prinzipien): viel Eiweiß, Krafttraining, moderates Tempo – so machst du die aufgebauten Muskeln sichtbar.', 'Willst du halten, findest du über ein langsames Absenken deine Erhaltungsmenge.'] },
      { icon: '🧭', title: 'Der lange Blick', paras: ['Muskelaufbau ist ein Spiel über Monate und Jahre – in Zyklen aus Aufbau, Mini-Cuts und Definitionsphasen. Jeder saubere Zyklus bringt dich weiter.', 'Im Coaching geht es mit Vertiefungen weiter – du bist nicht fertig, sondern bereit für die nächste Phase.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel als bleibende Investition', paras: ['Jedes Kilo aufgebauter Muskel hebt deinen Grundumsatz und erleichtert spätere Definitionsphasen und das Gewicht-Halten. Der über Monate gebaute Muskel zahlt sich in jeder folgenden Phase aus.', 'Auch nach einer Diät bleibt trainierter Muskel leichter erhalten (Muskelgedächtnis) – deine Arbeit ist nicht umsonst.', 'Wenn du deinen Stoffwechsel und deine Körperzusammensetzung genau kennen willst, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Wann endet eine Aufbauphase sinnvoll?', options: ['Wenn der Körperfettanteil zu hoch wird oder du definieren willst', 'Nie', 'Nach genau 4 Wochen'], answer: 0, explain: 'Endloses Bulken lohnt selten – ein geplanter Abschluss hält dich im guten Bereich.' },
      { q: 'Warum ist aufgebauter Muskel eine Investition?', options: ['Er hebt den Grundumsatz und bleibt leichter erhalten', 'Er verschwindet sofort', 'Er senkt den Stoffwechsel'], answer: 0, explain: 'Mehr Muskel = höherer Grundumsatz; trainierter Muskel kommt dank Muskelgedächtnis leichter zurück.' },
    ],
    sources: ['Literatur zu Bulk-/Cut-Zyklen', 'Forschung zu Muskelgedächtnis (myonukleäre Domäne)', 'Forschung zu Muskelmasse und Ruheenergieumsatz'],
    exercise: 'Lege fest, wie du deine Aufbauphase abschließt (Definition oder Halten) und welche 2 Gewohnheiten (Eiweiß, Krafttraining) du in jedem Fall behältst.',
    habits: [
      { id: 'a20h1', text: 'Nächste Phase bewusst planen', cat: 'planung' },
      { id: 'a20h2', text: 'Eiweiß + Krafttraining beibehalten', cat: 'protein' },
    ],
  },
];

// ── Halten · Staffel 2 „Aufbaustufe" (Wochen 13–20) ──────────────────────
const HALTEN_S2 = [
  {
    week: 13, title: 'Erhaltung durch die Jahreszeiten', theme: 'Strategie', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Warum sich dein Essverhalten mit den Jahreszeiten ändert – und wie du stabil bleibst.',
    pages: [
      { icon: '🗓️', title: 'Jede Saison hat ihre Fallen', paras: ['Im Winter locken Deftiges und weniger Bewegung, im Sommer Eis, Grillabende und Urlaub, an Feiertagen die Buffets. Dein Gewicht schwankt oft im Jahresrhythmus – das ist normal.', 'Wer die typischen Saison-Fallen kennt, kann sie einplanen, statt jedes Jahr überrascht zu werden.'] },
      { icon: '❄️', title: 'Winter & Feiertage', paras: ['Weniger Tageslicht und Bewegung senken den Verbrauch, gleichzeitig steigt der Appetit auf Deftiges. Halte hier bewusst dein Schritt-Ziel und dein Frühwarnsystem aktiv.', 'Feiertage sind Genuss-Zeiten – plane sie ein und finde danach zügig in die Routine zurück.'] },
      { icon: '☀️', title: 'Sommer & Urlaub', paras: ['Im Sommer bewegst du dich oft mehr (Baden, Radeln, draußen sein) – nutze das. Urlaub ist „Halten statt Abnehmen": ein paar Wochen stabil bleiben ist schon ein Erfolg.', 'Kleine Anker (Eiweiß zuerst, Wasser einbauen, Bewegung) tragen dich durch jede Saison.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Verbrauch schwankt übers Jahr', paras: ['Dein Energieverbrauch ist nicht konstant: Mehr Alltagsbewegung (NEAT) im Sommer, weniger im Winter, dazu saisonaler Appetit. Der Körper gleicht kleine Schwankungen aus, größere nicht.', 'Deshalb passt du dein Verhalten leicht an die Saison an – etwas mehr Bewegung im Winter, entspannter im aktiven Sommer.', 'Wo dein Stoffwechsel steht, kannst du im Studio messen lassen – hilfreich, um saisonale Muster einzuordnen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie verhält sich dein Gewicht übers Jahr?', options: ['Es schwankt oft im Jahresrhythmus – normal', 'Es ist immer exakt gleich', 'Es steigt nur'], answer: 0, explain: 'Saisonale Schwankungen sind normal; wer die Fallen kennt, plant sie ein.' },
      { q: 'Was hilft im bewegungsarmen Winter?', options: ['Schritt-Ziel + Frühwarnsystem aktiv halten', 'Gar nichts tun', 'Radikal hungern'], answer: 0, explain: 'Bewusst Bewegung und das Frühwarnsystem halten dich durch die dunkle Saison stabil.' },
    ],
    sources: ['Literatur zu saisonalen Gewichtsschwankungen', 'Levine JA: NEAT', 'National Weight Control Registry'],
    exercise: 'Überlege, welche Saison-Falle bei dir am größten ist, und lege 2 Anker fest, mit denen du sie diese Saison entschärfst.',
    habits: [
      { id: 'h13h1', text: 'Saison-Anker bewusst halten', cat: 'planung' },
      { id: 'h13h2', text: 'Schritt-Ziel auch im Winter', cat: 'bewegung' },
    ],
  },
  {
    week: 14, title: 'Reisen, Umzüge & Lebensphasen', theme: 'Umsetzung', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Wenn der Alltag sich ändert: so bleibt Erhaltung trotzdem machbar.',
    pages: [
      { icon: '🧳', title: 'Wenn die Routine wegfällt', paras: ['Reisen, ein Umzug, ein neuer Job, ein Kind – große Veränderungen werfen Routinen um. Genau dann rutscht das Gewicht am ehesten. Das ist kein Versagen, sondern eine vorhersehbare Phase.', 'Der Trick: In solchen Phasen die Ansprüche senken und nur die wichtigsten Anker halten.'] },
      { icon: '⚓', title: 'Minimal-Routine', paras: ['Definiere eine „Notfall-Routine" aus 2–3 Gewohnheiten, die auch im Chaos gehen: z. B. Eiweiß zu jeder Mahlzeit, ein Glas Wasser vor dem Essen, ein täglicher Spaziergang.', 'Diese Minimal-Routine hält dich stabil, bis wieder Ruhe einkehrt.'] },
      { icon: '🔁', title: 'Danach wieder aufbauen', paras: ['Wenn sich der neue Alltag einspielt, baust du Schritt für Schritt deine vollen Gewohnheiten wieder auf. Kein Perfektionsdruck – zurückfinden zählt mehr als durchhalten um jeden Preis.', 'Lebensphasen wechseln; deine Fähigkeit, dich anzupassen, macht Erhaltung dauerhaft.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Stress verschiebt den Appetit', paras: ['Umbruch bedeutet Stress, und Stress hebt Cortisol, das Appetit auf schnelle Energie macht. Dazu kommt oft weniger Schlaf – beides begünstigt unbewusstes Mehr-Essen.', 'Wer das weiß, nimmt Gewichtsschwankungen in solchen Phasen nicht persönlich, sondern reagiert mit Minimal-Routine und Geduld.', 'Sobald Schlaf und Alltag sich normalisieren, beruhigt sich auch der Appetit – der Stoffwechsel folgt der Routine.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was hilft in Umbruch-Phasen?', options: ['Ansprüche senken, nur die wichtigsten Anker halten', 'Alles perfekt durchziehen', 'Aufgeben'], answer: 0, explain: 'Eine Minimal-Routine aus 2–3 Gewohnheiten hält dich durch turbulente Zeiten.' },
      { q: 'Warum schwankt das Gewicht bei Stress oft?', options: ['Cortisol + wenig Schlaf fördern Mehr-Essen', 'Muskeln verschwinden', 'Zufall'], answer: 0, explain: 'Stress und Schlafmangel verschieben den Appetit – mit Geduld normalisiert es sich.' },
    ],
    sources: ['Übersichtsarbeiten zu Stress, Cortisol und Essverhalten', 'Spiegel K et al.: Schlaf und Appetit', 'Literatur zu Gewohnheitsstabilität'],
    exercise: 'Lege deine persönliche Minimal-Routine aus 2–3 Gewohnheiten fest, die auch in stressigen/reisereichen Phasen funktioniert.',
    habits: [
      { id: 'h14h1', text: 'Minimal-Routine definieren/halten', cat: 'planung' },
      { id: 'h14h2', text: 'Ein Anker auch unterwegs', cat: 'mindset' },
    ],
  },
  {
    week: 15, title: 'Das Wochenend-Muster', theme: 'Verhalten', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Unter der Woche top, am Wochenende „aus"? So bleibt die Wochenbilanz stabil.',
    pages: [
      { icon: '📅', title: 'Das häufigste Halte-Leck', paras: ['Bei vielen sabotiert das Wochenende die gute Woche: auswärts essen, Alkohol, mehr Snacks, weniger Struktur. Zwei Tage können den Schnitt der ganzen Woche kippen.', 'Das heißt nicht, das Wochenende zu streichen – nur bewusster zu gestalten.'] },
      { icon: '🍽️', title: 'Struktur ohne Verzicht', paras: ['Behalte auch am Wochenende ein paar Anker: eiweißreiches Frühstück, ein Glas Wasser vor dem Essen, Bewegung. So hast du Spielraum für Genuss, ohne komplett zu entgleisen.', 'Plane deine Highlights (das eine schöne Essen, der Drink) bewusst ein, statt alles laufen zu lassen.'] },
      { icon: '🍷', title: 'Alkohol im Blick', paras: ['Alkohol liefert viele Kalorien, senkt die Hemmschwelle beim Essen und stört den Schlaf. Ein bewusstes Maß und Wasser dazwischen halten Wochenende und Fortschritt in Balance.', 'Denk an die Wochenbilanz: Ein Abend ist okay, wenn der Rest stimmt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Die Woche als Konto', paras: ['Dein Stoffwechsel bilanziert über die Woche. Wenn du unter der Woche solide bist und am Wochenende maßvoll genießt, bleibt der Schnitt im Ziel.', 'Problematisch wird es, wenn zwei „Aus"-Tage regelmäßig einen kleinen Wochenüberschuss erzeugen – über Monate summiert sich das.', 'Ein bewusstes Wochenende hält dein Wochen-Konto ausgeglichen, ohne dir den Spaß zu nehmen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum kippt das Wochenende oft die Bilanz?', options: ['Weniger Struktur, Alkohol, mehr Snacks', 'Weil Kalorien am Wochenende doppelt zählen', 'Gar nicht'], answer: 0, explain: 'Zwei strukturarme Tage können den Wochenschnitt kippen – bewusster gestalten hilft.' },
      { q: 'Wie bleibst du am Wochenende stabil?', options: ['Ein paar Anker behalten + Highlights einplanen', 'Komplett verzichten', 'Alles laufen lassen'], answer: 0, explain: 'Struktur-Anker plus bewusst eingeplanter Genuss halten die Balance.' },
    ],
    sources: ['Racette SB et al.: Wochenend-Essverhalten und Gewicht', 'WHO – Alkohol und Gesundheit', 'Literatur zu flexibler Kontrolle'],
    exercise: 'Plane dein nächstes Wochenende: Welche 2 Anker behältst du, und welches Genuss-Highlight planst du bewusst ein?',
    habits: [
      { id: 'h15h1', text: 'Wochenend-Anker halten', cat: 'planung' },
      { id: 'h15h2', text: 'Genuss bewusst einplanen', cat: 'mindset' },
    ],
  },
  {
    week: 16, title: 'Gewohnheiten reparieren', theme: 'Verhalten', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Eine Routine ist eingeschlafen? So bringst du sie zurück – ohne Schuldgefühle.',
    pages: [
      { icon: '🔧', title: 'Gewohnheiten schlafen ein', paras: ['Jede Gewohnheit verblasst mal – nach Urlaub, Krankheit oder Stress. Das ist normal und kein Grund für Selbstvorwürfe. Wichtig ist nur, sie gezielt wieder zu aktivieren.', 'Statt „alles wieder perfekt" reicht es, eine Gewohnheit nach der anderen zurückzuholen.'] },
      { icon: '🧩', title: 'Die Ursache finden', paras: ['Frag dich freundlich: Was hat die Gewohnheit ausgebremst? Fehlender Auslöser, zu hoher Anspruch, keine Zeit? Oft lässt sich die Gewohnheit kleiner oder an einen neuen Auslöser koppeln.', 'Beispiel: Wenn das Vorkochen eingeschlafen ist, koch erstmal nur eine Portion doppelt – kleiner Wiedereinstieg.'] },
      { icon: '🔗', title: 'Neu verankern', paras: ['Häng die Gewohnheit an eine bestehende (Habit-Stack) und mach sie so klein, dass sie kaum wehtut. Kleine, sichere Wiederholungen bauen die Routine neu auf.', 'Feiere den Wiedereinstieg – nicht die verpasste Zeit.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Warum kleine Schritte wirken', paras: ['Gewohnheiten sind neuronale Bahnen, die durch Wiederholung stärker werden. Nach einer Pause sind sie noch da, nur schwächer – ein kleiner, konsequenter Wiedereinstieg reaktiviert sie schneller als ein großer Neustart.', 'Genau wie beim Muskelgedächtnis: Was einmal etabliert war, kommt leichter zurück.', 'Konstanz im Kleinen schlägt Perfektion im Großen – für Gewohnheiten wie für den Stoffwechsel.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was tust du, wenn eine Gewohnheit eingeschlafen ist?', options: ['Sie klein und gezielt wieder aktivieren', 'Sich schuldig fühlen', 'Ganz aufgeben'], answer: 0, explain: 'Eine Gewohnheit nach der anderen, klein wieder anknüpfen – ohne Selbstvorwürfe.' },
      { q: 'Wie verankerst du sie neu?', options: ['An eine bestehende Gewohnheit hängen, klein machen', 'Möglichst groß starten', 'Gar nicht'], answer: 0, explain: 'Habit-Stacking plus kleine, sichere Wiederholungen bauen die Routine neu auf.' },
    ],
    sources: ['Lally P et al. (2010): Habit Formation', 'Wood W, Neal DT: Psychologie der Gewohnheit', 'BJ Fogg: Tiny Habits'],
    exercise: 'Wähle eine eingeschlafene Gewohnheit, finde die Ursache und starte sie diese Woche in einer Mini-Version neu.',
    habits: [
      { id: 'h16h1', text: 'Eine Gewohnheit neu verankern', cat: 'mindset' },
      { id: 'h16h2', text: 'Klein wieder einsteigen', cat: 'planung' },
    ],
  },
  {
    week: 17, title: 'Erhaltungsphasen bewusst', theme: 'Strategie', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Halten ist auch eine aktive Phase – so nutzt du sie klug zwischen Zielen.',
    pages: [
      { icon: '⏸️', title: 'Halten hat einen Wert', paras: ['Erhaltung ist nicht nur „nichts tun" zwischen Diäten. Bewusste Halte-Phasen geben Körper und Kopf Erholung, festigen Gewohnheiten und beugen dem Jojo vor.', 'Wer nach dem Abnehmen bewusst hält, sichert das Ergebnis – der wichtigste und meist übersprungene Schritt.'] },
      { icon: '🔄', title: 'Zwischen Zielen', paras: ['Auch wenn du später wieder ab- oder aufbauen willst, sind Halte-Phasen sinnvoll: Sie normalisieren Hormone (z. B. Leptin nach einer Diät) und machen den nächsten Schritt leichter.', 'Ein guter Rhythmus ist oft: Ziel-Phase, dann Erhaltung, dann nächste Ziel-Phase.'] },
      { icon: '🎯', title: 'Aktiv halten', paras: ['In der Halte-Phase isst du bewusst auf Erhaltung, hältst Eiweiß und Bewegung und beobachtest dein Gewicht locker. Das ist eine Fähigkeit, die du übst – nicht bloß eine Pause.', 'So bleibt Erhaltung ein aktiver, wertvoller Teil deiner Reise.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Hormonelle Erholung', paras: ['Nach einer Diät sind Sättigungshormone (Leptin) oft gedrückt und der Verbrauch etwas gesenkt (adaptive Thermogenese). Eine bewusste Erhaltungsphase hebt das wieder an.', 'Das reduziert den Hunger, hebt die Alltagsbewegung und macht das Gewicht stabiler – die beste Vorbereitung für die nächste Phase.', 'Wie sich dein Stoffwechsel nach einer Diät erholt, lässt sich im Studio einordnen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was bringt eine bewusste Erhaltungsphase?', options: ['Erholung, gefestigte Gewohnheiten, Jojo-Schutz', 'Nichts', 'Nur Zeitverlust'], answer: 0, explain: 'Halte-Phasen sichern Ergebnisse und normalisieren Hormone – ein aktiver, wertvoller Schritt.' },
      { q: 'Wie „hältst" du aktiv?', options: ['Auf Erhaltung essen, Eiweiß/Bewegung halten, locker beobachten', 'Gar nichts tun', 'Radikal weniger essen'], answer: 0, explain: 'Aktives Halten ist eine geübte Fähigkeit, keine bloße Pause.' },
    ],
    sources: ['Rosenbaum M, Leibel RL: Leptin und adaptive Thermogenese', 'Byrne HK et al. (2018): MATADOR', 'National Weight Control Registry'],
    exercise: 'Betrachte Halten als aktive Phase: Lege fest, wie du diese Woche bewusst auf Erhaltung isst und Eiweiß + Bewegung hältst.',
    habits: [
      { id: 'h17h1', text: 'Bewusst auf Erhaltung essen', cat: 'planung' },
      { id: 'h17h2', text: 'Eiweiß + Bewegung halten', cat: 'protein' },
    ],
  },
  {
    week: 18, title: 'Identität & Selbstbild', theme: 'Mindset', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Dauerhaft halten gelingt leichter, wenn es zu dem passt, wer du sein willst.',
    pages: [
      { icon: '🪞', title: 'Von „ich muss" zu „ich bin"', paras: ['Die stärksten Gewohnheiten sind Teil deiner Identität. „Ich bin jemand, der sich bewegt und gut isst" trägt weiter als „ich muss mich zusammenreißen".', 'Kleine Handlungen formen dieses Selbstbild: Jede gute Entscheidung ist ein Beweis dafür, wer du bist.'] },
      { icon: '💬', title: 'Wie du mit dir sprichst', paras: ['Freundliche, aber klare Selbstgespräche helfen mehr als Härte. Statt „ich habe versagt" lieber „ein Ausrutscher, morgen mache ich normal weiter". Selbstmitgefühl schlägt Selbstkritik.', 'Wer sich nach einem Fehltritt runtermacht, gibt eher auf; wer nachsichtig ist, macht weiter.'] },
      { icon: '🎯', title: 'Werte statt nur Zahlen', paras: ['Halten fällt leichter, wenn es um mehr geht als eine Zahl: Energie für die Kinder, fit für den Sport, gesund alt werden. Verbinde deine Gewohnheiten mit dem, was dir wirklich wichtig ist.', 'Diese Werte tragen dich, wenn die Motivation mal schwankt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Der Kopf steuert das Verhalten', paras: ['Essverhalten ist zu großen Teilen Gewohnheit und Selbstbild, nicht reine Willenskraft. Wer sich als „gesund lebender Mensch" sieht, trifft entsprechende Entscheidungen fast automatisch.', 'Das entlastet den Alltag: Weniger innere Kämpfe, mehr stabile Routine – und damit ein stabileres Gewicht.', 'Nachhaltige Erhaltung ist am Ende genauso Kopf- wie Körpersache.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Was trägt Gewohnheiten am stärksten?', options: ['Wenn sie Teil deiner Identität sind', 'Reine Willenskraft', 'Strafen'], answer: 0, explain: '„Ich bin jemand, der…" trägt weiter als „ich muss mich zusammenreißen".' },
      { q: 'Wie gehst du mit einem Ausrutscher um?', options: ['Freundlich, morgen normal weiter', 'Sich hart bestrafen', 'Alles hinwerfen'], answer: 0, explain: 'Selbstmitgefühl hält dich am Ball – Selbstkritik führt eher zum Aufgeben.' },
    ],
    sources: ['Literatur zu Identität und Verhaltensänderung (z. B. Clear/Wood)', 'Forschung zu Selbstmitgefühl und Gesundheitsverhalten', 'Deutsche Gesellschaft für Ernährung (DGE): Essverhalten'],
    exercise: 'Formuliere einen Identitäts-Satz („Ich bin jemand, der …") und verbinde deine wichtigsten Halte-Gewohnheiten mit einem echten Wert.',
    habits: [
      { id: 'h18h1', text: 'Identitäts-Satz präsent halten', cat: 'mindset' },
      { id: 'h18h2', text: 'Freundlich mit sich sprechen', cat: 'mindset' },
    ],
  },
  {
    week: 19, title: 'Rückfall-Management', theme: 'Mindset', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Wenn das Gewicht doch mal deutlich steigt: der ruhige, klare Plan zurück.',
    pages: [
      { icon: '📈', title: 'Ein Rückfall ist kein Scheitern', paras: ['Auch nach Jahren kann das Gewicht mal deutlicher steigen – durch eine schwere Phase, Verletzung oder alte Muster. Das ist menschlich und kein Grund, alles Erreichte abzuschreiben.', 'Entscheidend ist nicht, dass es passiert, sondern wie du reagierst.'] },
      { icon: '🧭', title: 'Der Reset-Plan', paras: ['Zurück zu den Basics: Frühwarnsystem reaktivieren, deine 3–4 Anker-Gewohnheiten wieder hochfahren, und wenn nötig eine kurze, moderate Abnehmphase einlegen (kein Crash).', 'Ein klarer, ruhiger Plan schlägt Panik oder das Alles-oder-nichts-Denken.'] },
      { icon: '🤝', title: 'Hilfe holen ist Stärke', paras: ['Wenn du allein nicht zurückfindest, hol dir Unterstützung – Trainingspartner, Coaching, das Studio. Ein Blick von außen und etwas Struktur bringen dich oft schneller zurück.', 'Rückfälle gehören zu jeder langen Reise dazu. Wer wieder aufsteht, gewinnt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskelgedächtnis & Wiedereinstieg', paras: ['Die gute Nachricht: Trainierte Muskeln und etablierte Gewohnheiten kommen leichter zurück als beim ersten Mal (Muskelgedächtnis, eingespielte Routinen). Dein Wiedereinstieg ist schneller als der erste Start.', 'Auch der Stoffwechsel profitiert: Erhaltene Muskelmasse hält deinen Grundumsatz oben und erleichtert das Zurückfinden.', 'Wenn du einen strukturierten Neustart willst, ist das Studio-Coaching ein guter Partner.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Wie reagierst du auf einen Rückfall am besten?', options: ['Ruhiger Reset-Plan: Basics + Anker zurück', 'Panik / alles hinwerfen', 'Ignorieren, bis es schlimm ist'], answer: 0, explain: 'Ein klarer Plan zurück zu den Basics schlägt Alles-oder-nichts-Denken.' },
      { q: 'Warum ist der Wiedereinstieg leichter als der erste Start?', options: ['Muskelgedächtnis + eingespielte Gewohnheiten', 'Weil man aufgibt', 'Gar nicht'], answer: 0, explain: 'Trainierte Muskeln und bekannte Routinen kommen schneller zurück.' },
    ],
    sources: ['Literatur zu Gewichtserhalt und Rückfällen', 'Forschung zu Muskelgedächtnis', 'National Weight Control Registry'],
    exercise: 'Schreib dir deinen persönlichen Reset-Plan auf (Frühwarnsystem + 3–4 Anker), damit du ihn im Fall der Fälle sofort parat hast.',
    habits: [
      { id: 'h19h1', text: 'Reset-Plan griffbereit halten', cat: 'planung' },
      { id: 'h19h2', text: 'Nach Rückschlag ruhig weiter', cat: 'mindset' },
    ],
  },
  {
    week: 20, title: 'Erhaltung als Lebensstil', theme: 'Nachhaltigkeit', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Halten wird zur unauffälligen Normalität – dein Plan für die nächsten Jahre.',
    pages: [
      { icon: '🌱', title: 'Von der Übung zur Selbstverständlichkeit', paras: ['Du hast Erhaltung wochenlang bewusst geübt. Jetzt darf sie zur unauffälligen Normalität werden – ein Lebensstil, kein Projekt. Deine Anker und dein Frühwarnsystem laufen im Hintergrund.', 'Du brauchst keine Diät und keine Dauer-Kontrolle mehr, nur ein paar verlässliche Gewohnheiten.'] },
      { icon: '🏅', title: 'Deine Top-Routinen', paras: ['Halte deine 3–4 wirksamsten Gewohnheiten fest – die tragen dich auch durch stressige Zeiten. Alles andere darf mal pausieren.', 'Über die Jahre ändern sich Lebensphasen; deine Fähigkeit, dich anzupassen, hält das Gewicht stabil.'] },
      { icon: '🧭', title: 'Immer weiter möglich', paras: ['Von deiner stabilen Basis aus kannst du jederzeit ein neues Ziel angehen – definieren, aufbauen oder einfach fit bleiben. Im Coaching geht es mit Vertiefungen weiter.', 'Du bist nicht fertig, sondern souverän – Erhaltung ist eine Fähigkeit fürs Leben.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskeln halten das Budget', paras: ['Über die Jahre sinkt ohne Gegenwehr langsam die Muskelmasse und damit der Verbrauch. Krafttraining und genug Eiweiß halten dein „Halte-Budget" groß – so bleibt Erhaltung leicht.', 'Dein Körper verteidigt sein Gewicht, hat aber keinen starren Set-Point: Mit Wissen, Bewegung und Frühwarnsystem steuerst du bewusst.', 'Wenn du genau wissen willst, wo dein Stoffwechsel und deine Muskelmasse stehen, ist das persönliche Stoffwechsel-Coaching im Studio dein nächster Schritt.'], cta: 'Stoffwechsel-Coaching anfragen' },
    ],
    quiz: [
      { q: 'Was ist das Ziel bei „Erhaltung als Lebensstil"?', options: ['Unauffällige Normalität aus wenigen verlässlichen Gewohnheiten', 'Dauer-Diät', 'Ständiges Zählen'], answer: 0, explain: 'Anker-Gewohnheiten plus Frühwarnsystem – kein Projekt, sondern Alltag.' },
      { q: 'Warum bleibt Halten mit Krafttraining leicht?', options: ['Es hält Muskeln und damit den Verbrauch', 'Es senkt den Grundumsatz', 'Es ist egal'], answer: 0, explain: 'Muskelerhalt hält das „Halte-Budget" groß – Erhaltung bleibt über Jahre einfach.' },
    ],
    sources: ['National Weight Control Registry', 'Bauer J et al. (PROT-AGE): Eiweiß und Muskelerhalt', 'Rosenbaum M, Leibel RL: Gewichtsregulation'],
    exercise: 'Schreib deine 3–4 wirksamsten Halte-Gewohnheiten auf, bestätige dein Frühwarnsystem und überlege, ob als Nächstes ein neues Ziel reizt.',
    habits: [
      { id: 'h20h1', text: 'Top-Halte-Gewohnheiten festhalten', cat: 'mindset' },
      { id: 'h20h2', text: 'Krafttraining + Eiweiß beibehalten', cat: 'protein' },
    ],
  },
];

const GESUNDHEIT_S2 = [
  {
    week: 13, title: 'Herz & Kreislauf vertieft', theme: 'Gesundheit', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Wie du deinem Herz mit dem Essen etwas Gutes tust – Fette, Salz und Ballaststoffe im Blick.',
    pages: [
      { icon: '❤️', title: 'Was das Herz schützt', paras: ['Eine herzfreundliche Ernährung ist gut erforscht: viel Gemüse, Obst, Hülsenfrüchte, Vollkorn, Nüsse und Fisch, dazu gute Pflanzenöle – das Muster der mediterranen Küche. Wenig stark Verarbeitetes, wenig Zucker.', 'Es geht nicht um ein einzelnes Lebensmittel, sondern um das Gesamtmuster über Wochen und Jahre.'] },
      { icon: '🫒', title: 'Die Fett-Qualität zählt', paras: ['Wichtiger als „viel oder wenig Fett" ist die Art: ungesättigte Fette (Olivenöl, Rapsöl, Nüsse, fetter Fisch) gelten als günstig, Transfette (in stark Verarbeitetem, frittiert) als ungünstig fürs Herz.', 'Ein praktischer Schritt: öfter Olivenöl/Rapsöl statt fester Fette, ein- bis zweimal die Woche fetter Fisch (z. B. Lachs, Makrele) oder pflanzliche Omega-3-Quellen wie Leinöl und Walnüsse.'] },
      { icon: '🧂', title: 'Salz & Blutdruck', paras: ['Viele nehmen deutlich mehr Salz zu sich, als die DGE empfiehlt (max. ~6 g/Tag). Der meiste Teil steckt nicht im Salzstreuer, sondern in Brot, Wurst, Käse und Fertigprodukten.', 'Weniger stark Verarbeitetes und mehr selbst würzen mit Kräutern kann bei salzempfindlichen Menschen den Blutdruck günstig beeinflussen. Bei Bluthochdruck gehört die Behandlung aber immer in ärztliche Hand.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Blutfette & Stoffwechsel', paras: ['Deine Blutfettwerte (u. a. LDL- und HDL-Cholesterin, Triglyceride) spiegeln, wie dein Stoffwechsel mit Fetten umgeht. Ernährung, Bewegung und Gewicht beeinflussen sie – teils deutlich.', 'Ballaststoffe (Hafer, Hülsenfrüchte) und ungesättigte Fette wirken hier günstig, während viel Zucker und Transfette ungünstig wirken.', 'Eine Stoffwechselmessung im Studio ist eine Standortbestimmung – die eigentlichen Herz-Kreislauf-Werte (Blutdruck, Blutfette) gehören in die ärztliche Vorsorge.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist bei Fett fürs Herz am wichtigsten?', options: ['Die Qualität: ungesättigt statt Transfette', 'Nur die Menge, egal welches Fett', 'Fett komplett meiden'], answer: 0, explain: 'Ungesättigte Fette (Öle, Nüsse, Fisch) gelten als günstig, Transfette als ungünstig – die Art zählt mehr als die reine Menge.' },
      { q: 'Wo steckt das meiste Salz in der Ernährung?', options: ['In Brot, Wurst, Käse und Fertigprodukten', 'Nur im Salzstreuer', 'In frischem Gemüse'], answer: 0, explain: 'Der Großteil der Salzzufuhr ist „versteckt" in verarbeiteten Lebensmitteln – nicht im Nachsalzen.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Fettzufuhr, Speisesalz', 'Deutsche Herzstiftung: Herzgesunde Ernährung', 'WHO – Salz- und Fettempfehlungen'],
    exercise: 'Ersetze diese Woche zweimal ein festes/verarbeitetes Fett durch Olivenöl oder Nüsse und plane eine Fisch- oder Omega-3-Mahlzeit ein.',
    habits: [
      { id: 'g13h1', text: 'Gutes Öl statt feste Fette', cat: 'fett' },
      { id: 'g13h2', text: 'Bewusst salzarm würzen', cat: 'gesundheit' },
    ],
  },
  {
    week: 14, title: 'Darmgesundheit tiefer', theme: 'Gesundheit', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Dein Darm-Mikrobiom liebt Vielfalt – so fütterst du deine guten Bakterien.',
    pages: [
      { icon: '🦠', title: 'Das Mikrobiom kurz erklärt', paras: ['In deinem Darm leben Billionen Bakterien. Eine vielfältige, „gute" Darmflora wird mit Verdauung, Immunsystem und Wohlbefinden in Verbindung gebracht. Was du isst, formt sie mit.', 'Die Forschung ist jung und vieles noch nicht abschließend geklärt – aber ein Muster ist robust: Vielfalt und Ballaststoffe tun dem Darm gut.'] },
      { icon: '🥦', title: 'Ballaststoffe & Vielfalt füttern', paras: ['Deine Darmbakterien ernähren sich vor allem von Ballaststoffen aus Gemüse, Obst, Hülsenfrüchten und Vollkorn. Je vielfältiger die Pflanzen, desto vielfältiger die Bakterien.', 'Ein oft genannter Richtwert: über die Woche viele verschiedene pflanzliche Lebensmittel essen. Nicht jeden Tag dasselbe – Abwechslung ist hier das Ziel.'] },
      { icon: '🥛', title: 'Fermentiertes & Probiotisches', paras: ['Fermentierte Lebensmittel wie Joghurt, Kefir, Sauerkraut, Kimchi oder Miso liefern lebende Kulturen und werden mit einer gesunden Darmflora in Verbindung gebracht.', 'Sie sind ein netter Baustein, kein Wundermittel. Bei anhaltenden Darmbeschwerden gehört die Abklärung immer zum Arzt – nicht zu Selbstversuchen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Darm, Ballaststoffe & Stoffwechsel', paras: ['Wenn Darmbakterien Ballaststoffe vergären, entstehen kurzkettige Fettsäuren. Diese werden mit einer gesunden Darmschleimhaut und günstigen Stoffwechseleffekten in Verbindung gebracht.', 'Ballaststoffe verlangsamen zudem die Aufnahme von Zucker und unterstützen einen stabileren Blutzucker – ein Bindeglied zwischen Darm und Stoffwechsel.', 'Eine Standortbestimmung im Studio kann deinen Stoffwechsel einordnen; bei konkreten Darmbeschwerden ist die ärztliche Abklärung der richtige Weg.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wovon ernähren sich deine „guten" Darmbakterien vor allem?', options: ['Von Ballaststoffen aus vielfältigen Pflanzen', 'Von Zucker und Weißmehl', 'Von möglichst wenig Essen'], answer: 0, explain: 'Ballaststoffe aus Gemüse, Obst, Hülsenfrüchten und Vollkorn – und Vielfalt – füttern eine vielfältige Darmflora.' },
      { q: 'Wie gehst du mit anhaltenden Darmbeschwerden um?', options: ['Ärztlich abklären lassen', 'Einfach mehr Probiotika ausprobieren', 'Ignorieren'], answer: 0, explain: 'Fermentiertes ist ein netter Baustein, aber anhaltende Beschwerden gehören zur ärztlichen Abklärung.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Ballaststoffe', 'Übersichtsarbeiten zu Mikrobiom und Ernährung', 'Valdes AM et al.: Rolle des Darmmikrobioms für die Gesundheit'],
    exercise: 'Iss diese Woche bewusst 20+ verschiedene pflanzliche Lebensmittel und baue an einem Tag etwas Fermentiertes (z. B. Joghurt, Sauerkraut) ein.',
    habits: [
      { id: 'g14h1', text: 'Pflanzenvielfalt erhöhen', cat: 'gemuese' },
      { id: 'g14h2', text: 'Etwas Fermentiertes einbauen', cat: 'gesundheit' },
    ],
  },
  {
    week: 15, title: 'Zucker & Leber verstehen', theme: 'Gesundheit', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Warum zu viel Zucker – besonders flüssiger – auch die Leber belastet.',
    pages: [
      { icon: '🍬', title: 'Zucker ist nicht gleich Zucker', paras: ['Zucker in ganzen Lebensmitteln (Obst mit Ballaststoffen) verhält sich anders als zugesetzter oder flüssiger Zucker (Limo, Säfte, Süßes). Vor allem zugesetzter Zucker in großen Mengen ist das Thema.', 'Die WHO empfiehlt, zugesetzten Zucker auf unter 10 % der Energiezufuhr zu begrenzen – besser Richtung 5 %.'] },
      { icon: '🥤', title: 'Die Rolle flüssiger Kalorien', paras: ['Zuckergesüßte Getränke liefern viel Zucker ohne Sättigung und werden mit ungünstigen Stoffwechsel- und Lebereffekten in Verbindung gebracht. Sie sind einer der stärksten einzelnen Hebel.', 'Der einfachste Schritt bleibt: Wasser oder ungesüßten Tee zur Standardwahl machen, Süßgetränke zur bewussten Ausnahme.'] },
      { icon: '🫀', title: 'Was die Leber damit zu tun hat', paras: ['Ein Teil des Fruchtzuckers (Fruktose) aus großen Mengen zugesetztem Zucker wird in der Leber verarbeitet. Dauerhaft sehr hohe Zuckermengen plus Kalorienüberschuss werden mit einer Fettleber in Verbindung gebracht.', 'Die gute Nachricht: Eine nichtalkoholische Fettleber ist in frühen Stadien oft durch Ernährung, Bewegung und Gewichtsabnahme günstig beeinflussbar. Diagnose und Behandlung gehören aber immer zum Arzt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Zucker, Insulin & Leber', paras: ['Ständig hohe Zuckerlast fordert Insulin stark und wird langfristig mit Insulinresistenz und Fetteinlagerung in der Leber in Verbindung gebracht. Ballaststoffe, Eiweiß und Bewegung wirken dem entgegen.', 'Weniger flüssiger Zucker, mehr vollwertige Kohlenhydrate und Bewegung sind die stärksten Stellschrauben für einen entspannteren Zuckerstoffwechsel.', 'Eine Stoffwechselmessung im Studio ordnet deinen Status ein; Leberwerte und Diagnosen kommen aus der ärztlichen Vorsorge.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Welcher Zucker ist besonders im Fokus?', options: ['Zugesetzter und flüssiger Zucker (Limo, Süßes)', 'Der Zucker in ganzem Obst mit Ballaststoffen', 'Jede Art von Kohlenhydrat'], answer: 0, explain: 'Vor allem zugesetzter und flüssiger Zucker ist das Thema – Obst mit Ballaststoffen verhält sich anders.' },
      { q: 'Was ist der einfachste starke Hebel?', options: ['Süßgetränke durch Wasser/ungesüßten Tee ersetzen', 'Obst komplett streichen', 'Nur noch Light-Produkte'], answer: 0, explain: 'Flüssige Zuckerkalorien sättigen kaum – Wasser zur Standardwahl zu machen ist einer der stärksten Einzel-Hebel.' },
    ],
    sources: ['WHO – Guideline: Sugars intake (2015)', 'Deutsche Leberstiftung: Fettleber und Ernährung', 'Übersichtsarbeiten zu Fruktose, zugesetztem Zucker und Lebergesundheit'],
    exercise: 'Ersetze diese Woche konsequent zuckergesüßte Getränke durch Wasser oder ungesüßten Tee und beobachte, wie es dir damit geht.',
    habits: [
      { id: 'g15h1', text: 'Süßgetränke durch Wasser ersetzen', cat: 'zucker' },
      { id: 'g15h2', text: 'Zugesetzten Zucker reduzieren', cat: 'zucker' },
    ],
  },
  {
    week: 16, title: 'Nährstoff-Timing im Alltag', theme: 'Praxis', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Wann du was isst, ist zweitrangig – aber ein paar Alltags-Anker helfen wirklich.',
    pages: [
      { icon: '⏰', title: 'Erst das große Ganze', paras: ['Für die Gesundheit ist entscheidend, WAS und WIE VIEL du über den Tag isst – das Timing ist Feinschliff. Lass dich nicht von komplizierten Timing-Regeln verrückt machen.', 'Ein regelmäßiger Rhythmus, der zu deinem Alltag passt, ist mehr wert als eine „perfekte" Uhrzeit, die du nicht durchhältst.'] },
      { icon: '🍳', title: 'Sinnvolle Alltags-Anker', paras: ['Ein eiweiß- und ballaststoffreiches Frühstück oder eine erste Mahlzeit macht viele über den Vormittag stabiler und satter. Ein sehr spätes, schweres Essen kann dagegen den Schlaf stören.', 'Verteile Eiweiß über den Tag statt alles abends – das unterstützt Sättigung und Muskelerhalt. Das sind sanfte Anker, keine starren Gesetze.'] },
      { icon: '🚶', title: 'Bewegung rund ums Essen', paras: ['Ein kurzer Spaziergang nach dem Essen kann den Blutzuckeranstieg dämpfen und tut der Verdauung gut – ein einfacher, unterschätzter Alltags-Hebel.', 'Auch das ist kein Muss, sondern eine kleine Gewohnheit mit guter Wirkung, die sich leicht einbauen lässt.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Rhythmus & innere Uhr', paras: ['Dein Stoffwechsel folgt einem Tagesrhythmus (zirkadiane Uhr). Der Körper verarbeitet Nahrung tagsüber tendenziell etwas anders als spät in der Nacht – ein regelmäßiger Essrhythmus unterstützt diesen Takt.', 'Wichtiger als die Minute ist Konstanz: ähnliche Zeiten, ausreichend Schlaf, nicht ständig durchessen. Das hält den Rhythmus stabil.', 'Wie dein Stoffwechsel arbeitet, kann eine Standortbestimmung im Studio einordnen – als Ergänzung zu deinem Alltag, nicht als starre Vorgabe.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist für die Gesundheit wichtiger als das Timing?', options: ['Was und wie viel du über den Tag isst', 'Die exakte Uhrzeit jeder Mahlzeit', 'Möglichst spät zu essen'], answer: 0, explain: 'Qualität und Menge über den Tag zählen zuerst – das Timing ist Feinschliff.' },
      { q: 'Welcher kleine Anker hilft nach dem Essen?', options: ['Ein kurzer Spaziergang', 'Sofort hinlegen', 'Noch ein Dessert'], answer: 0, explain: 'Ein kurzer Spaziergang dämpft den Blutzuckeranstieg und unterstützt die Verdauung.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Mahlzeitenrhythmus', 'Übersichtsarbeiten zu zirkadianer Rhythmik und Ernährung', 'Literatur zu Eiweißverteilung über den Tag'],
    exercise: 'Baue diese Woche zwei Anker ein: eine eiweißreiche erste Mahlzeit und einen kurzen Spaziergang nach dem Mittag- oder Abendessen.',
    habits: [
      { id: 'g16h1', text: 'Eiweiß über den Tag verteilen', cat: 'protein' },
      { id: 'g16h2', text: 'Spaziergang nach dem Essen', cat: 'bewegung' },
    ],
  },
  {
    week: 17, title: 'Ernährung & Immunsystem', theme: 'Gesundheit', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Kein „Immun-Booster" macht dich gesund – aber eine gute Grundversorgung stärkt die Abwehr.',
    pages: [
      { icon: '🛡️', title: 'Realistisch bleiben', paras: ['Kein einzelnes Lebensmittel und kein Präparat macht dich „immun". Werbung mit „Immun-Boostern" ist meist übertrieben. Was zählt, ist eine gute Grundversorgung über die Zeit.', 'Eine ausgewogene, vielfältige Ernährung, genug Schlaf, Bewegung und wenig Stress sind die echten Stützen deiner Abwehr.'] },
      { icon: '🍊', title: 'Nährstoffe mit Immun-Bezug', paras: ['Einige Nährstoffe spielen für das Immunsystem eine Rolle, z. B. Vitamin C, Vitamin D, Zink und Eiweiß. Eine bunte, vollwertige Ernährung deckt die meisten davon gut ab.', 'Vitamin D ist ein Sonderfall: In den dunklen Monaten ist eine ausreichende Versorgung in unseren Breiten oft schwierig. Ob eine Ergänzung sinnvoll ist, klärst du am besten anhand eines ärztlich bestimmten Werts.'] },
      { icon: '💊', title: 'Nahrungsergänzung mit Augenmaß', paras: ['Für die meisten Gesunden bringt „auf Verdacht" schlucken wenig und kann in hohen Dosen sogar schaden. Sinnvoll ist Ergänzung vor allem bei nachgewiesenem Mangel oder in besonderen Lebensphasen.', 'Die Devise: erst das Essen optimieren, Präparate gezielt und idealerweise ärztlich begleitet einsetzen – nicht als Ersatz für eine gute Ernährung.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Ganzheitlich denken', paras: ['Immunsystem, Stoffwechsel, Schlaf und Stress hängen zusammen. Chronischer Stress und schlechter Schlaf schwächen die Abwehr, während Bewegung und gute Ernährung sie unterstützen.', 'Statt einzelner „Booster" lohnt der Blick auf das Gesamtbild – genau da setzt gesunde Ernährung an.', 'Eine Stoffwechselmessung im Studio ist eine Standortbestimmung fürs große Ganze; Blutwerte wie Vitamin D gehören zur ärztlichen Vorsorge.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was stärkt die Abwehr wirklich?', options: ['Gute Grundversorgung, Schlaf, Bewegung, wenig Stress', 'Ein einzelner „Immun-Booster"', 'Möglichst viele Präparate'], answer: 0, explain: 'Kein einzelnes Mittel macht immun – das Gesamtbild aus Ernährung, Schlaf und Bewegung zählt.' },
      { q: 'Wie gehst du mit Vitamin-D-Ergänzung um?', options: ['Anhand eines ärztlich bestimmten Werts entscheiden', 'Einfach hochdosiert auf Verdacht', 'Gar nicht drüber nachdenken'], answer: 0, explain: 'Vitamin D ist ein Sonderfall; ob eine Ergänzung sinnvoll ist, klärt man am besten anhand eines gemessenen Werts.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Vitamin D, Immunsystem', 'Robert Koch-Institut: Vitamin-D-Versorgung', 'Übersichtsarbeiten zu Ernährung und Immunfunktion'],
    exercise: 'Sorge diese Woche für die Basics: bunt und eiweißreich essen, ausreichend schlafen – und wenn du Vitamin D erwägst, sprich es beim nächsten Arztbesuch an.',
    habits: [
      { id: 'g17h1', text: 'Bunt & vollwertig für die Abwehr', cat: 'gemuese' },
      { id: 'g17h2', text: 'Auf ausreichend Schlaf achten', cat: 'gesundheit' },
    ],
  },
  {
    week: 18, title: 'Etiketten & Zusatzstoffe einordnen', theme: 'Alltagskompetenz', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'E-Nummern, Zusatzstoffe, Verarbeitungsgrad – so behältst du den Überblick ohne Angst.',
    pages: [
      { icon: '🏷️', title: 'Verarbeitungsgrad statt Panik', paras: ['Nützlicher als jede einzelne E-Nummer ist die Frage: Wie stark ist ein Produkt verarbeitet? Stark verarbeitete Produkte (viele Zutaten, Zucker, Salz, Fett, lange Listen) sollten die Ausnahme sein.', 'Grobe Faustregel: je kürzer und verständlicher die Zutatenliste, desto naturbelassener das Produkt. Das ist alltagstauglicher als das Auswendiglernen von Nummern.'] },
      { icon: '🔢', title: 'E-Nummern sachlich', paras: ['E-Nummern sind zugelassene Zusatzstoffe – zugelassen heißt, sie wurden auf Sicherheit geprüft. Nicht jede E-Nummer ist „schlecht"; manche sind harmlose Stoffe wie Ascorbinsäure (Vitamin C, E300).', 'Trotzdem gilt: Viele Zusatzstoffe sind oft ein Hinweis auf ein stark verarbeitetes Produkt. Nicht der einzelne Stoff ist das Problem, sondern das Gesamtprodukt.'] },
      { icon: '🍭', title: 'Süßstoffe & „ohne Zucker"', paras: ['Süßstoffe liefern Süße ohne (nennenswerte) Kalorien und gelten in den zugelassenen Mengen als sicher. Sie können beim Zuckerreduzieren helfen – ein Freifahrtschein für stark verarbeitete Produkte sind sie aber nicht.', '„Ohne Zuckerzusatz" heißt nicht „gesund": Solche Produkte können trotzdem energiedicht sein oder viel Fruchtzucker enthalten. Ein Blick auf die Nährwerte lohnt sich immer.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Warum weniger Verarbeitetes hilft', paras: ['Stark verarbeitete Lebensmittel sind oft energiedicht, salz- und zuckerreich und wenig sättigend – eine Kombination, die man mit ungünstigen Stoffwechsel- und Gewichtseffekten in Verbindung bringt.', 'Naturbelassene Lebensmittel liefern dagegen mehr Ballaststoffe, Nährstoffe und Sättigung pro Kalorie – das entlastet Bilanz und Stoffwechsel.', 'Wie dein Stoffwechsel steht, kann eine Standortbestimmung im Studio einordnen – ein guter Anlass, den Anteil naturbelassener Lebensmittel zu erhöhen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was ist nützlicher als jede einzelne E-Nummer zu kennen?', options: ['Auf den Verarbeitungsgrad achten (kurze, klare Zutatenliste)', 'Alle E-Nummern auswendig lernen', 'Nur nach dem Preis gehen'], answer: 0, explain: 'Der Verarbeitungsgrad – je kürzer und verständlicher die Zutatenliste, desto naturbelassener – ist der alltagstauglichere Kompass.' },
      { q: 'Was bedeutet „ohne Zuckerzusatz"?', options: ['Nicht automatisch „gesund" – Nährwerte trotzdem prüfen', 'Immer kalorienfrei', 'Dass es kein Fett enthält'], answer: 0, explain: 'Solche Produkte können trotzdem energiedicht sein oder viel Fruchtzucker enthalten – der Blick auf die Nährwerte bleibt wichtig.' },
    ],
    sources: ['EU-Lebensmittelinformationsverordnung (LMIV): Kennzeichnung & Zusatzstoffe', 'Verbraucherzentrale: Zusatzstoffe und E-Nummern', 'NOVA-Klassifikation: Verarbeitungsgrad von Lebensmitteln'],
    exercise: 'Nimm 3 Produkte aus deinem Vorrat und sortiere sie nach Verarbeitungsgrad (kurze vs. lange Zutatenliste) – finde eine naturbelassenere Alternative.',
    habits: [
      { id: 'g18h1', text: 'Kurze Zutatenlisten bevorzugen', cat: 'gesundheit' },
      { id: 'g18h2', text: 'Weniger stark Verarbeitetes', cat: 'gesundheit' },
    ],
  },
  {
    week: 19, title: 'Gesund kochen & Meal-Prep', theme: 'Praxis', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Wer vorkocht, isst gesünder – mit weniger Aufwand im hektischen Alltag.',
    pages: [
      { icon: '🍳', title: 'Zubereitung macht den Unterschied', paras: ['Nicht nur was du kochst, auch wie: Dünsten, Dämpfen, Kochen und schonendes Braten erhalten mehr Nährstoffe und brauchen weniger Fett als Frittieren. Viel Öl in der Pfanne summiert sich schnell.', 'Kräuter und Gewürze bringen Geschmack ohne viel Salz oder Zucker – ein einfacher Hebel für gesündere, leckere Gerichte.'] },
      { icon: '🥘', title: 'Meal-Prep als Gesundheits-Werkzeug', paras: ['Wenn Gesundes schon fertig im Kühlschrank steht, greifst du seltener zu Fertigem oder Lieferdienst. Vorkochen nimmt die Entscheidung im Hunger-Moment aus der Gleichung.', 'Ein einfacher Start: eine Basis (Vollkorn, Kartoffeln, Hülsenfrüchte), ein Eiweiß und viel Gemüse in größerer Menge kochen und variabel kombinieren.'] },
      { icon: '📦', title: 'Praktisch umsetzen', paras: ['Koch die doppelte Menge und friere Portionen ein. Schneide Gemüse für die Woche vor. Halte eine „Notfall-Mahlzeit" bereit (z. B. Tiefkühlgemüse + Hülsenfrüchte), die in 10 Minuten fertig ist.', 'Meal-Prep muss nicht die ganze Woche abdecken – schon 2–3 vorbereitete Mahlzeiten entlasten spürbar.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Selbst kochen, bessere Kontrolle', paras: ['Wer selbst kocht, bestimmt Zutaten, Fett-, Salz- und Zuckermenge selbst – und isst tendenziell weniger stark verarbeitete Lebensmittel. Das wirkt sich günstig auf Kalorienbilanz und Stoffwechsel aus.', 'Vorbereitung reduziert außerdem impulsive, energiedichte Entscheidungen im Hunger-Moment – einer der unterschätzten Hebel für stabile Gesundheit.', 'Eine Standortbestimmung im Studio zeigt dir, wo dein Stoffwechsel steht – ein schöner Anlass, die eigene Küche zur Gewohnheit zu machen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum hilft Meal-Prep der Gesundheit?', options: ['Gesundes steht bereit – weniger Griff zu Fertigem im Hunger', 'Weil vorgekochtes Essen mehr Vitamine hat als frisches', 'Weil man dann gar nicht mehr isst'], answer: 0, explain: 'Vorbereitung nimmt die Entscheidung aus dem Hunger-Moment – du greifst seltener zu Fertigem oder Lieferdienst.' },
      { q: 'Welche Zubereitung ist eher fettarm & nährstoffschonend?', options: ['Dünsten, Dämpfen, schonendes Braten', 'Frittieren in viel Öl', 'Alles lange durchkochen bis matschig'], answer: 0, explain: 'Dünsten und Dämpfen erhalten Nährstoffe und brauchen wenig Fett – Frittieren summiert schnell viele Kalorien.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Nährstoffschonende Zubereitung', 'Verbraucherzentrale: Meal-Prep und Vorratshaltung', 'Literatur zu Selbstkochen und Ernährungsqualität'],
    exercise: 'Bereite diese Woche 2–3 gesunde Mahlzeiten vor (Basis + Eiweiß + Gemüse) und lege eine 10-Minuten-Notfall-Mahlzeit für stressige Tage bereit.',
    habits: [
      { id: 'g19h1', text: 'Mahlzeiten vorbereiten (Meal-Prep)', cat: 'planung' },
      { id: 'g19h2', text: 'Nährstoffschonend zubereiten', cat: 'gesundheit' },
    ],
  },
  {
    week: 20, title: 'Werte langfristig verbessern', theme: 'Strategie', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Gesundheit ist ein Marathon – so machst du aus Wissen dauerhafte Gewohnheiten.',
    pages: [
      { icon: '📈', title: 'Kleine Schritte, große Wirkung', paras: ['Gesundheitliche Veränderungen brauchen Zeit: Blutdruck, Blutfette, Fitness und Wohlbefinden verbessern sich über Wochen und Monate, nicht über Nacht. Das ist normal – dranbleiben zahlt sich aus.', 'Nicht die perfekte Woche entscheidet, sondern das, was du über Jahre beibehältst. Gewohnheiten schlagen kurzfristige Kraftakte.'] },
      { icon: '🩺', title: 'Werte im Blick behalten', paras: ['Nutze die ärztliche Vorsorge: Lass regelmäßig die wichtigen Werte checken (Blutdruck, Blutzucker, Blutfette). So siehst du schwarz auf weiß, ob deine Umstellungen wirken – und hast einen echten Motivator.', 'Ernährung und Bewegung sind starke Hebel, ersetzen aber keine ärztliche Diagnose oder Behandlung. Beides gehört zusammen.'] },
      { icon: '🌱', title: 'Deinen Plan verstetigen', paras: ['Schau zurück auf die letzten Wochen: Welche 3–4 Gewohnheiten haben dir am meisten gebracht und passen zu deinem Leben? Genau die machst du zu deinem dauerhaften Standard.', 'Der Rest darf flexibel bleiben. Ein gesunder Lebensstil, den du magst und durchhältst, schlägt jedes perfekte Programm, das du nach vier Wochen aufgibst.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Der Stoffwechsel als Langzeit-Partner', paras: ['Viele Gesundheitswerte hängen mit deinem Stoffwechsel zusammen – und der reagiert positiv auf dauerhaft gute Ernährung, Bewegung und ein gesundes Gewicht. Kleine, stetige Veränderungen summieren sich.', 'Eine regelmäßige Standortbestimmung hilft dir, Fortschritte zu sehen und motiviert dranzubleiben – als Ergänzung zur ärztlichen Vorsorge, nicht als Ersatz.', 'Lass deinen Stoffwechsel im Studio messen und kombiniere das mit deinen ärztlichen Checks zu einem runden Langzeit-Bild.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was entscheidet über langfristige Gesundheit?', options: ['Gewohnheiten, die du über Jahre beibehältst', 'Eine einzige perfekte Woche', 'Kurzfristige Kraftakte'], answer: 0, explain: 'Nicht die perfekte Woche, sondern das dauerhaft Beibehaltene formt deine Gesundheit.' },
      { q: 'Welche Rolle spielt die ärztliche Vorsorge?', options: ['Werte regelmäßig checken – Ernährung ergänzt, ersetzt sie aber nicht', 'Sie ist überflüssig, wenn man gesund isst', 'Nur bei akuter Krankheit relevant'], answer: 0, explain: 'Regelmäßige Checks zeigen, ob deine Umstellungen wirken – Ernährung und ärztliche Betreuung gehören zusammen.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Langfristige Ernährungsumstellung', 'Gesetzliche Gesundheitsvorsorge (Check-up): Empfehlungen', 'Literatur zu Habit-Bildung und nachhaltiger Verhaltensänderung'],
    exercise: 'Wähle deine 3–4 wirkungsvollsten Gewohnheiten aus den letzten Wochen als dauerhaften Standard – und plane deinen nächsten ärztlichen Vorsorge-Check.',
    habits: [
      { id: 'g20h1', text: 'Top-Gewohnheiten verstetigen', cat: 'planung' },
      { id: 'g20h2', text: 'Vorsorge-Check einplanen', cat: 'gesundheit' },
    ],
  },
];

const LONGEVITY_S2 = [
  {
    week: 13, title: 'Eiweiß & Muskelqualität im Alter', theme: 'Longevity', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Muskeln sind deine Lebensversicherung fürs Alter – so hältst du sie stark.',
    pages: [
      { icon: '💪', title: 'Muskeln sind Zukunft', paras: ['Ab etwa dem 30. Lebensjahr baut der Körper ohne Gegenwehr langsam Muskeln ab (Sarkopenie). Das klingt harmlos, entscheidet aber im Alter über Selbstständigkeit, Kraft und Sturzsicherheit.', 'Die gute Nachricht: Dieser Abbau ist stark beeinflussbar. Eiweiß und Krafttraining sind die zwei wirksamsten Werkzeuge dagegen – in jedem Alter.'] },
        { icon: '🍳', title: 'Genug Eiweiß, gut verteilt', paras: ['Ältere Menschen brauchen tendenziell etwas mehr Eiweiß als jüngere, weil der Körper es weniger effizient in Muskeln umsetzt. Fachgesellschaften nennen für Ältere oft etwas höhere Richtwerte als die Standard-0,8 g/kg.', 'Praktisch: eine gute Eiweißquelle zu jeder Hauptmahlzeit (Eier, Quark, Fisch, Hülsenfrüchte, Fleisch), statt alles auf eine Mahlzeit zu packen. Das nutzt den Reiz über den Tag besser.'] },
      { icon: '🏋️', title: 'Der Reiz zählt', paras: ['Eiweiß allein baut keine Muskeln – es braucht den Trainingsreiz. Krafttraining (oder anspruchsvolle Belastung mit dem eigenen Körpergewicht) signalisiert dem Körper, Muskeln zu erhalten und aufzubauen.', 'Schon zwei kräftigende Einheiten pro Woche machen einen großen Unterschied. Es ist nie zu spät anzufangen – auch Hochbetagte bauen nachweislich noch Kraft auf.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel als Stoffwechsel-Organ', paras: ['Muskulatur ist stoffwechselaktiv: Sie hilft, Blutzucker aufzunehmen, stützt den Grundumsatz und wirkt wie ein Puffer in Krankheitsphasen. Mehr Muskeln bedeuten oft einen robusteren Stoffwechsel im Alter.', 'Wer Muskeln erhält, hält damit auch den Stoffwechsel und die Alltagskraft länger stabil – ein Kern-Hebel für gesundes Altern.', 'Eine Körperanalyse im Studio kann deine Muskelmasse einordnen und deine Fortschritte sichtbar machen.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Warum ist Muskelerhalt im Alter so wichtig?', options: ['Muskeln sichern Kraft, Selbstständigkeit und Sturzsicherheit', 'Muskeln sind nur für Sportler wichtig', 'Muskeln bauen sich nicht ab'], answer: 0, explain: 'Der altersbedingte Muskelabbau (Sarkopenie) entscheidet über Selbstständigkeit und Sicherheit – und ist beeinflussbar.' },
      { q: 'Wie nutzt du Eiweiß am besten?', options: ['Eine gute Quelle pro Hauptmahlzeit, über den Tag verteilt', 'Alles in einer Mahlzeit', 'Eiweiß ist im Alter unwichtig'], answer: 0, explain: 'Über den Tag verteiltes Eiweiß plus Trainingsreiz nutzt den Muskelaufbau-Reiz am besten.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Protein im Alter', 'PROT-AGE Study Group: Proteinempfehlungen für Ältere', 'Literatur zu Sarkopenie und Krafttraining'],
    exercise: 'Bring diese Woche zu jeder Hauptmahlzeit eine Eiweißquelle und plane zwei kräftigende Einheiten ein.',
    habits: [
      { id: 'l13h1', text: 'Eiweiß pro Hauptmahlzeit', cat: 'protein' },
      { id: 'l13h2', text: 'Zwei Kraft-Einheiten', cat: 'bewegung' },
    ],
  },
  {
    week: 14, title: 'Essfenster & Fasten – vorsichtig eingeordnet', theme: 'Longevity', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Was an Fasten-Konzepten dran ist – nüchtern, ohne Hype und mit klaren Grenzen.',
    pages: [
      { icon: '⏳', title: 'Erst die Einordnung', paras: ['Fasten-Konzepte (z. B. Essfenster von 8–10 Stunden) sind populär und Gegenstand aktiver Forschung. Vieles ist vielversprechend, aber noch nicht abschließend geklärt – gerade beim Menschen über lange Zeiträume.', 'Ganz wichtig: Fasten ist nicht für alle geeignet. Bei Diabetes, Untergewicht, Essstörungen, in Schwangerschaft/Stillzeit oder bei Medikamenteneinnahme gehört es unbedingt ärztlich begleitet – oder unterbleibt.'] },
      { icon: '🕗', title: 'Was oft empfohlen wird', paras: ['Eine milde, alltagstaugliche Variante ist ein moderates Essfenster: über den Tag essen, nachts eine längere Pause. Für viele bedeutet das schlicht: nach dem Abendessen nichts mehr, dafür ausgeschlafen frühstücken.', 'Ein realistischer Nutzen entsteht oft nicht durch „Magie", sondern weil ein Essfenster spätes Snacken reduziert und die Gesamtkalorien sanft begrenzt.'] },
      { icon: '⚖️', title: 'Kein Freifahrtschein', paras: ['Fasten ersetzt keine gute Ernährung. Wenn im Essfenster vor allem Verarbeitetes und Zucker landet, bringt das Zeitfenster wenig. Qualität und Eiweiß bleiben zentral – gerade im Alter für den Muskelerhalt.', 'Hör auf deinen Körper: Schwäche, Konzentrationsprobleme oder Heißhunger sind Signale, es milder anzugehen oder zu lassen.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Was im Körper diskutiert wird', paras: ['In der Forschung werden bei Ess-Pausen Prozesse wie verbesserte Insulinempfindlichkeit und Zell-Aufräumvorgänge (Autophagie) diskutiert. Vieles davon stammt aus Tier- und Kurzzeitstudien – Vorsicht bei großen Versprechen.', 'Für die meisten Gesunden ist ein moderates Essfenster ein möglicher, sanfter Baustein – kein Muss und kein Wundermittel.', 'Ob und wie ein Essfenster zu dir passt, ordnet eine Standortbestimmung im Studio mit ein – gesundheitliche Fragen dazu klärst du ärztlich.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Für wen ist Fasten NICHT ohne Weiteres geeignet?', options: ['Bei Diabetes, Untergewicht, Essstörung, Schwangerschaft, Medikamenten', 'Für alle gesunden Erwachsenen', 'Nur für Sportler'], answer: 0, explain: 'In diesen Fällen gehört Fasten ärztlich begleitet oder unterbleibt – die Sicherheit geht vor.' },
      { q: 'Woraus entsteht der Nutzen eines Essfensters oft?', options: ['Weniger spätes Snacken, sanft begrenzte Kalorien', 'Reine Magie unabhängig vom Essen', 'Man darf im Fenster alles unbegrenzt essen'], answer: 0, explain: 'Der Effekt kommt meist durch weniger Snacken und eine sanfte Kalorienbegrenzung – Qualität bleibt entscheidend.' },
    ],
    sources: ['Übersichtsarbeiten zu intermittierendem Fasten (Studienlage & Grenzen)', 'Deutsche Gesellschaft für Ernährung (DGE): Intervallfasten – Einordnung', 'Literatur zu zeitlich begrenztem Essen (time-restricted eating)'],
    exercise: 'Falls für dich geeignet: Probiere diese Woche sanft eine längere Nachtpause (nach dem Abendessen nichts mehr) und achte auf dein Wohlbefinden – bei Unsicherheit ärztlich abklären.',
    habits: [
      { id: 'l14h1', text: 'Längere Nachtpause (wenn geeignet)', cat: 'rhythmus' },
      { id: 'l14h2', text: 'Qualität im Essfenster halten', cat: 'gesundheit' },
    ],
  },
  {
    week: 15, title: 'Hormesis: Der richtige Reiz', theme: 'Longevity', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Warum moderater Stress den Körper stärkt – und wo die Grenze liegt.',
    pages: [
      { icon: '🌡️', title: 'Was Hormesis bedeutet', paras: ['Hormesis beschreibt: Ein moderater Reiz, der den Körper kurz fordert, macht ihn danach stärker. Das klassische Beispiel ist Training – die Belastung ist ein „guter Stress", auf den der Körper mit Anpassung antwortet.', 'Entscheidend ist die Dosis: zu wenig Reiz bringt nichts, zu viel überfordert. Der Nutzen liegt im mittleren Bereich mit ausreichend Erholung.'] },
      { icon: '🏃', title: 'Bewegung als stärkster Reiz', paras: ['Bewegung ist der am besten belegte „Longevity-Reiz": Ausdauer stärkt Herz und Kreislauf, Kraft erhält Muskeln und Knochen. Beides zusammen wirkt auf fast jeden Gesundheitsmarker günstig.', 'Man muss kein Leistungssportler sein – regelmäßige, moderate Bewegung plus etwas Fordern ist der Kern. Erholung gehört fest dazu.'] },
      { icon: '🥦', title: 'Pflanzenstoffe & milde Reize', paras: ['Auch manche sekundären Pflanzenstoffe (in buntem Gemüse, Kräutern, Beeren) werden mit milden hormetischen Effekten in Verbindung gebracht – ein weiterer Grund für Pflanzenvielfalt.', 'Bei anderen Reizen (Kälte, Hitze, Fasten) ist die Datenlage gemischter. Nichts davon ist Pflicht – und Extreme sind kein Longevity-Rezept, sondern ein Risiko.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Anpassung braucht Erholung', paras: ['Der Körper wird nicht während der Belastung stärker, sondern in der Erholung danach. Schlaf, Pausen und gute Ernährung sind der Teil, in dem die Anpassung tatsächlich passiert.', 'Dauerstress ohne Erholung kippt den positiven Reiz ins Gegenteil – dann überwiegt der Schaden. Balance ist beim gesunden Altern alles.', 'Wie gut dein Körper auf Reize reagiert und regeneriert, kann eine Standortbestimmung im Studio einordnen.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was meint Hormesis?', options: ['Ein moderater Reiz macht den Körper danach stärker', 'Je mehr Stress, desto besser', 'Reize schaden immer'], answer: 0, explain: 'Ein dosierter Reiz mit Erholung führt zu Anpassung und Stärke – die Dosis entscheidet.' },
      { q: 'Wann passiert die Anpassung?', options: ['In der Erholung nach der Belastung', 'Nur während der Belastung', 'Gar nicht'], answer: 0, explain: 'Der Körper wird in der Erholung stärker – Schlaf und Pausen gehören fest zum Reiz dazu.' },
    ],
    sources: ['Literatur zu Hormesis und körperlicher Aktivität', 'WHO – Bewegungsempfehlungen für Erwachsene und Ältere', 'Übersichtsarbeiten zu Training, Erholung und gesundem Altern'],
    exercise: 'Setze diese Woche einen bewussten „guten Reiz" (fordernde Bewegungseinheit) und plane bewusst die Erholung dazu (Schlaf, Pause) ein.',
    habits: [
      { id: 'l15h1', text: 'Ein fordernder Bewegungsreiz', cat: 'bewegung' },
      { id: 'l15h2', text: 'Erholung bewusst einplanen', cat: 'gesundheit' },
    ],
  },
  {
    week: 16, title: 'Ernährung fürs Gehirn', theme: 'Longevity', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Was dem Kopf langfristig guttut – und warum „gut fürs Herz" oft „gut fürs Hirn" heißt.',
    pages: [
      { icon: '🧠', title: 'Gehirn & Ernährung', paras: ['Das Gehirn ist ein sehr stoffwechselaktives Organ. Was den Gefäßen guttut, tut meist auch dem Kopf gut – Herz- und Hirngesundheit hängen eng zusammen.', 'Es gibt kein „Gedächtnis-Superfood", aber ein Ernährungsmuster, das mit besserer kognitiver Gesundheit im Alter in Verbindung gebracht wird.'] },
      { icon: '🐟', title: 'Was als günstig gilt', paras: ['Mediterran und pflanzenbetont, mit Omega-3 aus fettem Fisch (oder pflanzlich aus Leinöl, Walnüssen), viel Gemüse und Obst (besonders Beeren und grünes Blattgemüse), Vollkorn, Nüssen und Olivenöl.', 'Aus dieser Forschung entstand u. a. die „MIND"-Kost, die mediterrane und blutdruckfreundliche Prinzipien kombiniert und mit Hirngesundheit in Verbindung gebracht wird.'] },
      { icon: '🚫', title: 'Was man begrenzt', paras: ['Große Mengen an zugesetztem Zucker, stark Verarbeitetem und Alkohol gelten als eher ungünstig. Auch hier zählt das Muster über Jahre, nicht der einzelne Ausrutscher.', 'Und: Ernährung ist nur ein Baustein. Bewegung, Schlaf, soziale Kontakte und geistige Aktivität sind für den Kopf mindestens so wichtig.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Blutzucker, Gefäße & Kopf', paras: ['Ein stabiler Blutzucker und gesunde Gefäße unterstützen die Durchblutung des Gehirns. Umgekehrt werden dauerhaft hohe Zucker- und Blutdruckwerte mit schlechterer Hirngesundheit in Verbindung gebracht.', 'Deshalb wirkt vieles, was den Stoffwechsel gesund hält (Ballaststoffe, gute Fette, Bewegung), indirekt auch auf den Kopf.', 'Eine Standortbestimmung im Studio ordnet deinen Stoffwechsel ein; kognitive oder neurologische Fragen gehören in ärztliche Hand.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Was gilt fürs Gehirn als günstig?', options: ['Mediterran/pflanzenbetont mit Omega-3, Beeren, grünem Gemüse', 'Ein einzelnes Gedächtnis-Superfood', 'Viel Zucker und Alkohol'], answer: 0, explain: 'Die „MIND"-/mediterrane Kost wird mit besserer kognitiver Gesundheit in Verbindung gebracht – kein einzelnes Wundermittel.' },
      { q: 'Warum ist „gut fürs Herz" oft „gut fürs Hirn"?', options: ['Gesunde Gefäße und stabiler Blutzucker unterstützen die Hirndurchblutung', 'Herz und Hirn haben nichts miteinander zu tun', 'Nur Nahrungsergänzung hilft dem Gehirn'], answer: 0, explain: 'Herz- und Hirngesundheit hängen über Gefäße und Blutzucker eng zusammen.' },
    ],
    sources: ['Morris MC et al.: MIND-Diät und kognitive Gesundheit', 'Studien zur mediterranen Ernährung und Kognition', 'Deutsche Gesellschaft für Ernährung (DGE): Omega-3, Ernährung im Alter'],
    exercise: 'Baue diese Woche zwei „Hirn-Anker" ein: eine Omega-3-Quelle und täglich Beeren oder grünes Blattgemüse.',
    habits: [
      { id: 'l16h1', text: 'Omega-3-Quelle einplanen', cat: 'fette' },
      { id: 'l16h2', text: 'Beeren/grünes Blattgemüse', cat: 'gemuese' },
    ],
  },
  {
    week: 17, title: 'Knochen & Sturzprävention vertieft', theme: 'Longevity', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Stabil auf den Beinen bleiben – der vielleicht wichtigste Longevity-Faktor überhaupt.',
    pages: [
      { icon: '🦴', title: 'Warum Stürze so entscheidend sind', paras: ['Im höheren Alter sind Stürze und Knochenbrüche einer der größten Einschnitte für Selbstständigkeit und Lebensqualität. Vorbeugung ist deshalb ein zentrales Longevity-Thema – und beginnt früh.', 'Zwei Säulen tragen: stabile Knochen (Ernährung) und ein sicherer, kräftiger Körper mit gutem Gleichgewicht (Bewegung).'] },
      { icon: '🥛', title: 'Knochen ernähren', paras: ['Kalzium (Milchprodukte, grünes Gemüse, kalziumreiches Mineralwasser, Hülsenfrüchte), Vitamin D für die Aufnahme und genug Eiweiß bilden das Ernährungs-Fundament der Knochen.', 'Vitamin D ist besonders im Alter und in dunklen Monaten oft knapp. Ob eine Ergänzung nötig ist, wird am besten anhand eines ärztlich bestimmten Werts entschieden.'] },
      { icon: '🤸', title: 'Kraft & Gleichgewicht trainieren', paras: ['Krafttraining stärkt Muskeln und Knochen; Gleichgewichts- und Koordinationsübungen (z. B. auf einem Bein stehen, gezielte Programme) senken nachweislich das Sturzrisiko.', 'Schon einfache, regelmäßige Übungen machen einen Unterschied. Es geht nicht um Höchstleistung, sondern um Sicherheit und Stabilität im Alltag.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Muskel, Knochen & Zusammenspiel', paras: ['Muskeln und Knochen arbeiten zusammen: Belastung durch kräftige Muskeln hält Knochen stark, und starke Muskeln fangen Stolperer ab, bevor sie zum Sturz werden. Beides gemeinsam zu erhalten ist der beste Schutz.', 'Ernährung liefert die Bausteine, Bewegung den Reiz – dieselbe Kombination, die auch den Stoffwechsel jung hält.', 'Eine Körperanalyse im Studio kann deine Muskelmasse einordnen; Knochendichte und Vitamin D gehören zur ärztlichen Vorsorge.'], cta: 'Körperanalyse im Studio' },
    ],
    quiz: [
      { q: 'Welche zwei Säulen schützen vor Stürzen und Brüchen?', options: ['Knochen ernähren (Kalzium/Vitamin D/Eiweiß) + Kraft/Gleichgewicht trainieren', 'Nur Kalziumtabletten', 'Möglichst wenig bewegen'], answer: 0, explain: 'Ernährung für stabile Knochen und Training für Kraft und Gleichgewicht wirken zusammen.' },
      { q: 'Wie klärst du deinen Vitamin-D-Bedarf?', options: ['Anhand eines ärztlich bestimmten Werts', 'Hochdosiert auf Verdacht', 'Gar nicht'], answer: 0, explain: 'Vitamin D ist ein Sonderfall – die Entscheidung fällt am besten anhand eines gemessenen Werts.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Kalzium, Vitamin D, Protein', 'WHO – Sturzprävention im Alter', 'Literatur zu Kraft-/Gleichgewichtstraining und Sturzrisiko'],
    exercise: 'Baue diese Woche zweimal ein kurzes Gleichgewichts-/Krafttraining ein und sorge für kalzium- und eiweißreiche Mahlzeiten.',
    habits: [
      { id: 'l17h1', text: 'Gleichgewicht/Kraft üben', cat: 'bewegung' },
      { id: 'l17h2', text: 'Kalzium & Eiweiß im Blick', cat: 'gesundheit' },
    ],
  },
  {
    week: 18, title: 'Esskultur & soziale Bindung', theme: 'Longevity', minutes: 7, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'In langlebigen Regionen isst man selten allein – warum das Teil des Rezepts ist.',
    pages: [
      { icon: '👨‍👩‍👧', title: 'Gemeinsam essen wirkt', paras: ['In vielen langlebigen Regionen ist Essen ein soziales Ereignis: gemeinsam, in Ruhe, mit Genuss. Soziale Bindung selbst wird mit besserer Gesundheit und längerem Leben in Verbindung gebracht.', 'Es geht nicht nur um Nährstoffe, sondern um das Drumherum: Gemeinschaft, Struktur und Freude am Essen sind Teil des Longevity-Musters.'] },
      { icon: '🍽️', title: 'Langsam & achtsam', paras: ['Gemeinsame Mahlzeiten sind meist langsamer. Langsam essen gibt dem Sättigungsgefühl Zeit (es setzt mit Verzögerung ein) und macht Genuss bewusster – gut gegen Überessen.', 'Bildschirm weg, hinsetzen, schmecken: Diese einfachen Rituale verbessern Essverhalten und Wohlbefinden zugleich.'] },
      { icon: '🎉', title: 'Genuss ohne schlechtes Gewissen', paras: ['Longevity heißt nicht Verzicht bis zur Freudlosigkeit. Das gemeinsame Festessen, das Glas Wein in Gesellschaft, die Tradition – das gehört zu einem guten, langen Leben dazu.', 'Der Rahmen macht es: ein genussvolles Miteinander auf solider Alltagsbasis ist nachhaltiger als jede freudlose Diät.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Stress, Bindung & Körper', paras: ['Soziale Verbundenheit senkt Stress, und weniger chronischer Stress wirkt günstig auf Hormone, Appetit und Stoffwechsel. Der Effekt von Gemeinschaft geht also messbar unter die Haut.', 'Ein entspanntes, verbundenes Leben unterstützt gesundes Altern oft ebenso wie die Nährstoffe auf dem Teller.', 'Wie dein Stoffwechsel steht, ordnet eine Standortbestimmung im Studio ein – der soziale Rahmen ist der Teil, den du im Alltag pflegst.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Warum ist gemeinsames Essen Teil des Longevity-Musters?', options: ['Soziale Bindung wird mit besserer Gesundheit verknüpft', 'Weil man in Gesellschaft mehr Nährstoffe aufnimmt', 'Es spielt keine Rolle'], answer: 0, explain: 'Gemeinschaft, Ruhe und Genuss senken Stress und gehören in langlebigen Regionen zum Essen dazu.' },
      { q: 'Was bringt langsames Essen?', options: ['Sättigung setzt rechtzeitig ein, Genuss wird bewusster', 'Man isst automatisch mehr', 'Nichts'], answer: 0, explain: 'Das Sättigungsgefühl kommt verzögert – langsam essen beugt Überessen vor und steigert den Genuss.' },
    ],
    sources: ['Blue-Zones-Forschung: soziale Faktoren und Langlebigkeit', 'Holt-Lunstad J et al.: Soziale Bindung und Gesundheit', 'Literatur zu achtsamem Essen und Sättigung'],
    exercise: 'Plane diese Woche mindestens eine gemeinsame, bildschirmfreie Mahlzeit in Ruhe – langsam essen, genießen, ins Gespräch kommen.',
    habits: [
      { id: 'l18h1', text: 'Eine gemeinsame Mahlzeit', cat: 'verhalten' },
      { id: 'l18h2', text: 'Langsam & bildschirmfrei essen', cat: 'verhalten' },
    ],
  },
  {
    week: 19, title: 'Nahrungsergänzung im Alter – ärztlich', theme: 'Longevity', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Zwischen sinnvoll und Geldverschwendung – wie du Supplements nüchtern einordnest.',
    pages: [
      { icon: '💊', title: 'Erst das Essen', paras: ['Die Basis bleibt immer die Ernährung. Nahrungsergänzung ist Ergänzung, kein Ersatz – der Name sagt es. Für die meisten Nährstoffe ist eine vielfältige Kost der beste Weg.', 'Vorsicht bei großen Longevity-Versprechen einzelner Präparate: Vieles stammt aus Tier- oder Kurzzeitstudien, und „viel hilft viel" gilt gerade bei Supplementen oft nicht – manche schaden hochdosiert sogar.'] },
      { icon: '🎯', title: 'Wo Ergänzung sinnvoll sein kann', paras: ['Es gibt Situationen mit erhöhtem Bedarf oder häufigem Mangel, etwa Vitamin D (dunkle Monate, höheres Alter), Vitamin B12 (v. a. bei veganer Ernährung oder im Alter bei schlechterer Aufnahme) oder Omega-3, wenn kein Fisch gegessen wird.', 'Ob das auf dich zutrifft, zeigt sich am besten über ärztlich bestimmte Werte – nicht über Werbeversprechen oder Selbstdiagnose.'] },
      { icon: '⚠️', title: 'Sicher vorgehen', paras: ['Sprich Nahrungsergänzung – besonders im Alter und bei Medikamenten – mit deiner Ärztin oder deinem Arzt ab. Manche Präparate können mit Medikamenten wechselwirken oder Werte verfälschen.', 'Gut investiert ist Geld eher in gute Lebensmittel als in ein Regal voller Kapseln „auf Verdacht".'] },
      { kind: 'metabolism', icon: '🧬', title: 'Bedarf statt Gießkanne', paras: ['Ein gezielt ausgeglichener, tatsächlich bestehender Mangel kann Stoffwechsel und Gesundheit unterstützen. Wahllose Hochdosis-Ergänzung dagegen bringt selten Nutzen und birgt Risiken.', 'Der kluge Weg: Ernährung optimieren, relevante Werte ärztlich prüfen, gezielt und dosiert ergänzen, wo es nötig ist.', 'Eine Stoffwechselmessung im Studio ist eine Standortbestimmung fürs Gesamtbild; Nährstoffwerte und Ergänzungs-Entscheidungen gehören in ärztliche Hand.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Wie ist Nahrungsergänzung grundsätzlich einzuordnen?', options: ['Als Ergänzung bei nachgewiesenem Bedarf – kein Ersatz fürs Essen', 'Als Hauptquelle der Nährstoffe', 'Je mehr, desto besser'], answer: 0, explain: 'Die Ernährung bleibt die Basis; ergänzt wird gezielt bei echtem Bedarf, idealerweise ärztlich begleitet.' },
      { q: 'Wie entscheidest du über ein Supplement im Alter?', options: ['Anhand ärztlich bestimmter Werte und Absprache', 'Nach Werbeversprechen', 'Hochdosiert auf Verdacht'], answer: 0, explain: 'Gerade im Alter und bei Medikamenten gehört Ergänzung ärztlich abgeklärt – wegen Bedarf und Wechselwirkungen.' },
    ],
    sources: ['Deutsche Gesellschaft für Ernährung (DGE): Nahrungsergänzungsmittel, Vitamin D/B12 im Alter', 'Bundesinstitut für Risikobewertung (BfR): Höchstmengen für Nährstoffe', 'Verbraucherzentrale: Nahrungsergänzungsmittel kritisch betrachtet'],
    exercise: 'Mach eine ehrliche Bestandsaufnahme deiner Supplemente und notiere Fragen dazu für deinen nächsten Arzttermin – statt „auf Verdacht" weiterzunehmen.',
    habits: [
      { id: 'l19h1', text: 'Zuerst über Lebensmittel decken', cat: 'gesundheit' },
      { id: 'l19h2', text: 'Supplemente ärztlich abklären', cat: 'gesundheit' },
    ],
  },
  {
    week: 20, title: 'Dein Healthspan-Plan', theme: 'Strategie', minutes: 8, season: 'Staffel 2 · Aufbaustufe',
    teaser: 'Alles zusammengeführt: dein persönlicher Plan für viele gute, gesunde Jahre.',
    pages: [
      { icon: '🧩', title: 'Die Säulen zusammenführen', paras: ['Longevity ist kein einzelner Trick, sondern das Zusammenspiel weniger, robuster Säulen: pflanzenbetont & mediterran essen, genug Eiweiß, Muskeln durch Krafttraining erhalten, Bewegung, guter Schlaf, wenig chronischer Stress und soziale Bindung.', 'Du kennst jetzt jede Säule. Der Plan besteht darin, aus ihnen deine dauerhaften Gewohnheiten zu machen – nicht perfekt, aber beständig.'] },
      { icon: '🎯', title: 'Wenige, klare Gewohnheiten', paras: ['Wähle aus allem, was du gelernt hast, deine 4–5 wirkungsvollsten Gewohnheiten, die zu deinem Leben passen. Lieber wenige Dinge dauerhaft als viele für zwei Wochen.', 'Beispiele: „zu jeder Mahlzeit Eiweiß", „zweimal Kraft pro Woche", „täglich Gemüse-Vielfalt", „feste Schlafenszeit", „eine gemeinsame Mahlzeit".'] },
      { icon: '🩺', title: 'Mit der Vorsorge verzahnen', paras: ['Verbinde deinen Lebensstil mit der ärztlichen Vorsorge: regelmäßige Check-ups (Blutdruck, Blutzucker, Blutfette) zeigen, ob deine Gewohnheiten wirken, und fangen Probleme früh ab.', 'Lebensstil und Medizin sind ein Team – gemeinsam holen sie das Meiste an gesunden Jahren heraus.'] },
      { kind: 'metabolism', icon: '🧬', title: 'Dranbleiben lohnt sich', paras: ['Der Körper belohnt Beständigkeit: Ein erhaltener Muskelbestand, ein gesunder Stoffwechsel und stabile Werte bauen sich über Jahre auf und tragen dich weit. Es ist nie zu spät, damit zu beginnen.', 'Jeder gute Tag ist eine Einzahlung auf deine gesunden Jahre – die Summe macht den Unterschied.', 'Nutze regelmäßige Standortbestimmungen im Studio, um Fortschritte zu sehen und motiviert zu bleiben – ergänzend zur ärztlichen Vorsorge.'], cta: 'Stoffwechsel messen lassen' },
    ],
    quiz: [
      { q: 'Worin besteht ein Longevity-Plan?', options: ['Wenige robuste Gewohnheiten dauerhaft leben', 'Ein einzelner Trick oder ein Präparat', 'Zwei perfekte Wochen'], answer: 0, explain: 'Das Zusammenspiel weniger, beständiger Säulen (Ernährung, Muskeln, Bewegung, Schlaf, Bindung) macht Healthspan.' },
      { q: 'Wie verzahnst du Lebensstil und Medizin?', options: ['Regelmäßige Vorsorge-Checks + gute Gewohnheiten als Team', 'Nur Lebensstil, keine Ärzte', 'Nur Medizin, egal wie man lebt'], answer: 0, explain: 'Check-ups zeigen, ob Gewohnheiten wirken, und fangen Probleme früh ab – Lebensstil und Vorsorge ergänzen sich.' },
    ],
    sources: ['WHO – Healthy ageing: Rahmen und Empfehlungen', 'Blue-Zones- und mediterrane Ernährungsforschung', 'Literatur zu Prävention, Muskelerhalt und gesundem Altern'],
    exercise: 'Schreibe deinen persönlichen Healthspan-Plan: deine 4–5 dauerhaften Gewohnheiten und dein nächster ärztlicher Vorsorge-Termin.',
    habits: [
      { id: 'l20h1', text: 'Top-Gewohnheiten verstetigen', cat: 'planung' },
      { id: 'l20h2', text: 'Vorsorge-Check einplanen', cat: 'gesundheit' },
    ],
  },
];

const CURRICULA = {
  abnehmen: CURRICULUM.concat(ABNEHMEN_EXT, ABNEHMEN_S2),   // Kern (12 W.) + Staffel 2 (8 W.) = 20 Wochen
  definieren: DEFINIEREN.concat(DEFINIEREN_S2),             // Kern (12) + Staffel 2 (8) = 20 Wochen
  aufbau: AUFBAU.concat(AUFBAU_S2),                         // Kern (12) + Staffel 2 (8) = 20 Wochen
  halten: HALTEN.concat(HALTEN_S2),                         // Kern (12) + Staffel 2 (8) = 20 Wochen
  gesundheit: GESUNDHEIT.concat(GESUNDHEIT_S2),             // Kern (12) + Staffel 2 (8) = 20 Wochen
  longevity: LONGEVITY.concat(LONGEVITY_S2),                // Kern (12) + Staffel 2 (8) = 20 Wochen
};

// ── Vertiefung (evergreen Deep-Dives) ────────────────────────────────────
// IMMER offene Zusatz-Module – nicht zeit-gebunden, kein Wochen-Rhythmus. Damit
// wird das Coaching „nie fertig": eine wachsende Bibliothek zum Nachschlagen.
// Gleiches Format wie eine Lektion (Seiten + Stoffwechsel-Seite + Quiz + Aufgabe),
// aber mit STABILER String-ID statt „week" und ohne Gewohnheiten. Premium-Bonus.
const VERTIEFUNG = {
  abnehmen: [
    {
      id: 'abnehmen-v1', title: 'Blutzucker & Zucker verstehen', theme: 'Ernährungswissen', minutes: 8,
      teaser: 'Warum Zuckerspitzen Heißhunger machen – und wie du sie ganz einfach glättest.',
      pages: [
        { icon: '🩸', title: 'Was der Blutzucker macht', paras: ['Alle Kohlenhydrate landen als Zucker (Glukose) im Blut. Dein Körper hält den Blutzucker mit dem Hormon Insulin in einem engen Bereich – das ist ganz normal und gesund.', 'Problematisch wird es nur bei ständigen großen Spitzen: schnell hoch, schnell runter. Das Tal danach meldet sich als Heißhunger und Müdigkeit.'] },
        { icon: '🍬', title: 'Schnelle vs. langsame Kohlenhydrate', paras: ['Zucker und Weißmehl (Limo, Süßes, helles Gebäck) schießen schnell ins Blut. Vollkorn, Hülsenfrüchte, Gemüse und Obst mit Schale kommen langsam – du bleibst länger satt und stabil.', 'Es geht nicht um „verboten", sondern um die Standardwahl: öfter die langsame Variante, Süßes bewusst als Genuss.'] },
        { icon: '🥗', title: 'Der einfachste Trick', paras: ['Kombiniere Kohlenhydrate mit Eiweiß, Ballaststoffen oder etwas Fett. Das bremst den Zuckeranstieg spürbar – der Apfel mit Quark statt der Apfelsaft.', 'Auch die Reihenfolge hilft: erst Gemüse und Eiweiß, dann die Kohlenhydrate. So bleibt die Kurve flacher.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Insulin & Fettverbrennung', paras: ['Insulin ist ein Speicherhormon: Solange viel davon unterwegs ist, ist der Körper eher im „Einlagern"- als im „Verbrennen"-Modus. Ständige Zuckerspitzen halten Insulin hoch.', 'Stabiler Blutzucker durch langsame Kohlenhydrate, Eiweiß und Bewegung heißt: weniger Insulin-Spitzen, gleichmäßigere Energie, weniger Heißhunger.', 'Du musst dafür keine Kohlenhydrate streichen – klug kombinieren reicht. Wie dein Stoffwechsel individuell reagiert, kann das Studio-Coaching mit dir anschauen.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was löst nach einer Zuckerspitze oft Heißhunger aus?', options: ['Der schnelle Abfall danach (das „Tal")', 'Zu viel Eiweiß', 'Zu viel Wasser'], answer: 0, explain: 'Schnell hoch, schnell runter – das Tal nach der Spitze meldet sich als Heißhunger und Müdigkeit.' },
        { q: 'Wie glättest du den Blutzucker am einfachsten?', options: ['Kohlenhydrate mit Eiweiß/Ballaststoffen/Fett kombinieren', 'Nur noch Saft trinken', 'Mahlzeiten ganz auslassen'], answer: 0, explain: 'Eiweiß, Ballaststoffe und etwas Fett bremsen den Zuckeranstieg – die Kurve bleibt flacher.' },
      ],
      sources: ['WHO – Guideline: Sugars intake for adults and children (2015)', 'Deutsche Gesellschaft für Ernährung (DGE): Kohlenhydrate, zugesetzter Zucker', 'Literatur zu glykämischem Index und Sättigung'],
      exercise: 'Kombiniere heute bei jeder kohlenhydratreichen Mahlzeit bewusst eine Eiweiß- oder Ballaststoffquelle – und ersetze ein gesüßtes Getränk durch Wasser.',
    },
    {
      id: 'abnehmen-v2', title: 'Etiketten & Zutatenlisten lesen', theme: 'Alltagskompetenz', minutes: 7,
      teaser: 'In 20 Sekunden erkennen, was wirklich in einem Produkt steckt.',
      pages: [
        { icon: '🏷️', title: 'Die Nährwerttabelle', paras: ['Achte auf die Angabe „pro 100 g" – so kannst du Produkte fair vergleichen, egal wie groß die Packung ist. Die „pro Portion"-Spalte ist oft schöngerechnet mit Mini-Portionen.', 'Wichtig für dich: Kalorien, Eiweiß und Zucker pro 100 g. Der Rest ist Feinschliff.'] },
        { icon: '📃', title: 'Die Zutatenliste verrät alles', paras: ['Die Zutaten stehen nach Menge sortiert – was vorne steht, ist am meisten drin. Steht Zucker weit vorne, ist es ein Zuckerprodukt, egal was die Werbung sagt.', 'Zucker hat viele Namen: Glukosesirup, Dextrose, Maltodextrin, Fruktosesirup … Viele Namen = oft viel Zucker aus mehreren Quellen.'] },
        { icon: '🚩', title: 'Marketing-Fallen', paras: ['„Fettarm" heißt oft: mehr Zucker für den Geschmack. „Bio" oder „natürlich" sagt nichts über die Kalorien. „Ohne Zuckerzusatz" kann trotzdem viel Fruchtzucker enthalten.', 'Dein Blick auf die Rückseite schlägt jede Vorderseite. Zahlen lügen nicht, Slogans schon.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Energiedichte erkennen', paras: ['Ein starker Hebel ist die Energiedichte: Kalorien pro 100 g. Alles über ~250 kcal/100 g ist energiedicht (Öle, Nüsse, Süßes, Fertiges), alles darunter meist sättigend (Gemüse, Obst, mageres Eiweiß).', 'Wer viel Volumen bei wenig Kalorien isst, wird satt, ohne die Bilanz zu sprengen – der Kern eines angenehmen Defizits.', 'Die Nährwerttabelle zeigt dir die Energiedichte auf einen Blick. Ein kurzer Check im Laden spart dir später viele unnötige Kalorien.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Worauf schaust du für einen fairen Vergleich?', options: ['Auf die Angabe „pro 100 g"', 'Nur auf die Vorderseite', 'Auf die Farbe der Packung'], answer: 0, explain: '„Pro 100 g" macht Produkte vergleichbar – die „pro Portion"-Angabe ist oft mit Mini-Portionen schöngerechnet.' },
        { q: 'Was verrät die Reihenfolge der Zutatenliste?', options: ['Nichts', 'Die Mengen – vorne = am meisten drin', 'Nur den Preis'], answer: 1, explain: 'Zutaten stehen nach Menge sortiert. Steht Zucker weit vorne, ist viel drin – egal was die Vorderseite verspricht.' },
      ],
      sources: ['EU-Lebensmittelinformationsverordnung (LMIV): Nährwertkennzeichnung', 'Verbraucherzentrale: Zuckerarten und Kennzeichnung', 'Deutsche Gesellschaft für Ernährung (DGE): Lebensmittelauswahl'],
      exercise: 'Nimm 3 Produkte aus deinem Vorrat und vergleiche Kalorien, Eiweiß und Zucker pro 100 g. Finde die versteckten Zucker in der Zutatenliste.',
    },
    {
      id: 'abnehmen-v3', title: 'Heißhunger-Notfallplan', theme: 'Verhalten', minutes: 7,
      teaser: 'Dein Plan für den Moment, in dem der Heißhunger zuschlägt.',
      pages: [
        { icon: '⚡', title: 'Erst verstehen, dann handeln', paras: ['Heißhunger ist selten „echter" Hunger. Meist steckt etwas anderes dahinter: Durst, Müdigkeit, Stress, Langeweile oder ein Zucker-Tief.', 'Der erste Schritt ist eine kurze Pause: „Habe ich wirklich Hunger – oder ist das gerade etwas anderes?" Diese Sekunde entscheidet oft schon.'] },
        { icon: '🧰', title: 'Deine Sofort-Werkzeuge', paras: ['Trink ein großes Glas Wasser und warte 10 Minuten. Sehr oft ist der Drang dann weg. Ein warmer Tee oder Kaffee überbrückt ebenfalls gut.', 'Lenk dich 10 Minuten aktiv ab: kurz raus, ein paar Treppen, aufräumen, jemanden anrufen. Bewegung stoppt den Automatismus.'] },
        { icon: '🍏', title: 'Wenn du wirklich isst', paras: ['Dann bewusst und eiweißreich: Magerquark, Skyr, ein gekochtes Ei, Hüttenkäse, ein Stück Obst mit Nüssen. Das sättigt echt, statt das Tief zu verlängern.', 'Portioniere auf einen Teller, setz dich hin. „Aus der Tüte vor dem Fernseher" ist der schnellste Weg zur ganzen Packung.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Die Hormone hinter dem Heißhunger', paras: ['Schlafmangel und Dauerstress verschieben deine Hunger-Hormone: mehr Ghrelin (Hunger), weniger Leptin (Sättigung), dazu Cortisol, das Appetit auf Süßes macht. Kein Willensproblem – Biologie.', 'Deshalb wirken Schlaf, Stressabbau und regelmäßige, eiweißreiche Mahlzeiten oft besser als jede Selbstkontrolle im Akutmoment.', 'Wenn Heißhunger dich immer wieder ausbremst, lohnt der Blick aufs große Ganze – Schlaf, Stress und Stoffwechsel. Genau da setzt das Studio-Coaching an.'], cta: 'Stoffwechsel-Coaching anfragen' },
      ],
      quiz: [
        { q: 'Was ist der erste Schritt bei Heißhunger?', options: ['Sofort essen', 'Kurz innehalten: echter Hunger oder etwas anderes?', 'Den ganzen Tag hungern'], answer: 1, explain: 'Meist steckt Durst, Stress oder Müdigkeit dahinter. Die kurze Pause entscheidet oft schon.' },
        { q: 'Was hilft im Akutmoment am besten?', options: ['Ein großes Glas Wasser + 10 Min Ablenkung/Bewegung', 'Noch mehr Süßes', 'Sich schuldig fühlen'], answer: 0, explain: 'Wasser plus 10 Minuten Ablenkung/Bewegung durchbricht den Automatismus – der Drang lässt meist nach.' },
      ],
      sources: ['Übersichtsarbeiten zu Appetitregulation (Leptin, Ghrelin, Cortisol)', 'Spiegel K et al.: Schlafmangel und Appetit', 'Literatur zu emotionalem Essen und Stressbewältigung'],
      exercise: 'Leg dir jetzt deinen Notfallplan zurecht: 1 Getränk, 1 Ablenkung und 1 eiweißreicher Snack, den du griffbereit hast.',
    },
    {
      id: 'abnehmen-v4', title: 'Vegetarisch & vegan im Defizit', theme: 'Ernährungswissen', minutes: 8,
      teaser: 'Pflanzlich abnehmen – satt, eiweißreich und ausgewogen.',
      pages: [
        { icon: '🌱', title: 'Pflanzlich ist stark', paras: ['Eine pflanzenbetonte Ernährung ist ideal zum Abnehmen: viel Volumen, viele Ballaststoffe, wenig Energiedichte. Du wirst satt, ohne viele Kalorien.', 'Die zwei Punkte, auf die du achten solltest, sind Eiweiß und ein paar kritische Nährstoffe – beides gut lösbar.'] },
        { icon: '🫛', title: 'Genug Eiweiß – pflanzlich', paras: ['Gute Quellen: Hülsenfrüchte (Linsen, Kichererbsen, Bohnen), Tofu, Tempeh, Sojajoghurt, Edamame, Haferflocken, und für Vegetarier Quark, Skyr und Eier.', 'Kombiniere über den Tag verschiedene Quellen (z. B. Getreide + Hülsenfrüchte) – so bekommst du alle Bausteine. Eine eiweißreiche Basis zu jeder Mahlzeit ist der Schlüssel.'] },
        { icon: '💊', title: 'Die kritischen Nährstoffe', paras: ['Vegan solltest du Vitamin B12 supplementieren – das ist Pflicht, keine Option. Im Blick behalten: Eisen, Omega-3 (Lein-/Rapsöl, Algenöl), Kalzium, Jod, Zink und Vitamin D.', 'Das klingt nach viel, ist aber mit etwas Planung einfach. Bei Unsicherheit lohnt ein Bluttest und ärztliche Rücksprache.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Eiweißqualität & Muskeln', paras: ['Pflanzliches Eiweiß wird oft etwas schlechter verwertet als tierisches. Die Lösung ist simpel: etwas mehr davon essen und Quellen kombinieren – dann bleibt der Muskelschutz voll erhalten.', 'Gerade im Defizit ist genug Eiweiß entscheidend, um Muskeln (und damit den Grundumsatz) zu halten. Das gilt pflanzlich genauso wie omnivor.', 'Wenn du wissen willst, ob deine pflanzliche Ernährung deinen Bedarf deckt, kann eine Analyse im Studio Klarheit geben.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Welcher Nährstoff ist bei veganer Ernährung Pflicht zum Supplementieren?', options: ['Vitamin B12', 'Vitamin C', 'Ballaststoffe'], answer: 0, explain: 'Vitamin B12 muss vegan zwingend ergänzt werden – es kommt praktisch nur in tierischen Lebensmitteln vor.' },
        { q: 'Wie sicherst du pflanzlich genug Eiweiß?', options: ['Quellen kombinieren und etwas mehr essen', 'Eiweiß ganz weglassen', 'Nur Salat essen'], answer: 0, explain: 'Verschiedene Quellen kombinieren (z. B. Getreide + Hülsenfrüchte) und etwas mehr essen – so ist der Muskelschutz voll da.' },
      ],
      sources: ['Deutsche Gesellschaft für Ernährung (DGE): Vegane/vegetarische Ernährung, B12', 'Academy of Nutrition and Dietetics: Position zu pflanzlicher Ernährung', 'ISSN: Protein (auch pflanzliche Quellen)'],
      exercise: 'Plane eine pflanzliche Mahlzeit mit klarer Eiweißquelle (Hülsenfrüchte, Tofu oder Sojajoghurt) und prüfe, ob du vegan an B12 denkst.',
    },
    {
      id: 'abnehmen-v5', title: 'Supplemente – was wirkt, was nicht', theme: 'Ernährungswissen', minutes: 8,
      teaser: 'Ehrlicher Überblick: wenige Dinge helfen, das meiste ist Marketing.',
      pages: [
        { icon: '🧾', title: 'Die Wahrheit vorweg', paras: ['Kein Pulver und keine Pille nimmt dir das Abnehmen ab. Die Basis ist und bleibt: Energiebilanz, genug Eiweiß, Bewegung, Schlaf. Supplemente sind bestenfalls das i-Tüpfelchen.', '„Fatburner", Detox-Tees und Abnehm-Pillen sind fast immer rausgeworfenes Geld – manche sogar riskant. Spar dir das.'] },
        { icon: '✅', title: 'Was sinnvoll sein kann', paras: ['Eiweißpulver ist kein Wundermittel, aber praktisch, um dein Eiweißziel bequem zu treffen. Kreatin ist gut untersucht und unterstützt Kraft und Muskeln (nicht direkt Fettabbau).', 'Vitamin D im Winter, Omega-3 und – vegan – B12 können je nach Ernährung und Versorgung sinnvoll sein. Am besten an einem Bluttest orientieren.'] },
        { icon: '🛑', title: 'Vorsicht & gesunder Menschenverstand', paras: ['„Natürlich" heißt nicht „harmlos". Hochdosierte Fatburner mit viel Koffein oder unklaren Extrakten können Herz und Schlaf belasten.', 'Nahrungsergänzung ist Ergänzung – kein Ersatz für echtes Essen. Bei Erkrankungen oder Medikamenten immer ärztlich abklären.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Warum es keine Abkürzung gibt', paras: ['Der Stoffwechsel lässt sich nicht per Pille „ankurbeln". Was ihn wirklich hebt, ist Muskelmasse – und die baust du mit Training und Eiweiß, nicht mit Kapseln.', 'Koffein steigert den Verbrauch minimal und kurzfristig, aber der Effekt ist klein und nutzt sich ab. Kein Ersatz für die Basics.', 'Wenn du wissen willst, was in deinem Fall wirklich sinnvoll ist, ist eine Standortbestimmung im Studio ehrlicher als jedes Werbeversprechen.'], cta: 'Stoffwechsel-Coaching anfragen' },
      ],
      quiz: [
        { q: 'Was ist die Basis fürs Abnehmen?', options: ['Der richtige Fatburner', 'Energiebilanz, Eiweiß, Bewegung, Schlaf', 'Detox-Tee'], answer: 1, explain: 'Kein Supplement ersetzt die Basics. Fatburner und Detox sind fast immer rausgeworfenes Geld.' },
        { q: 'Wofür ist Kreatin gut belegt?', options: ['Direkter Fettabbau', 'Unterstützung von Kraft und Muskeln', 'Es macht Süßes gesund'], answer: 1, explain: 'Kreatin ist gut untersucht und unterstützt Kraft/Muskeln – nicht direkt den Fettabbau.' },
      ],
      sources: ['International Society of Sports Nutrition (ISSN): Position Stands (Kreatin, Protein, Koffein)', 'Deutsche Gesellschaft für Ernährung (DGE): Nahrungsergänzungsmittel', 'Verbraucherzentrale: „Schlankmacher" und Fatburner'],
      exercise: 'Geh deine Supplemente (falls vorhanden) einmal ehrlich durch: Was hat Evidenz (Eiweiß, Kreatin, ggf. D/Omega-3/B12) – und was kannst du streichen?',
    },
    {
      id: 'abnehmen-v6', title: 'Reisen, Urlaub & Restaurant', theme: 'Umsetzung', minutes: 8,
      teaser: 'Unterwegs im Ziel bleiben – ohne dir den Urlaub zu vermiesen.',
      pages: [
        { icon: '✈️', title: 'Der richtige Anspruch', paras: ['Unterwegs ist „halten statt abnehmen" ein starkes Ziel. Wer im Urlaub das Gewicht hält, hat schon gewonnen – Abnehmen kann danach weitergehen.', 'Entspann dich: Ein paar besondere Tage werfen dich nicht zurück. Entscheidend ist, dass du danach in deine Routine zurückfindest.'] },
        { icon: '🍳', title: 'Frühstück & Buffet', paras: ['Am Buffet gilt: erst schauen, dann wählen. Starte mit Eiweiß (Eier, Quark, Joghurt) und Obst/Gemüse – das sättigt und bremst den Griff zu allem anderen.', 'Nimm einen kleineren Teller und geh einmal bewusst, statt zehnmal „nur schnell". So genießt du mehr und isst automatisch weniger.'] },
        { icon: '🚶', title: 'Bewegung als Anker', paras: ['Reisen bedeutet oft mehr Bewegung: Gehen, Sightseeing, Schwimmen. Nutze das bewusst – ein paar tausend Schritte extra gleichen einiges aus.', 'Ein kurzer Spaziergang nach dem Essen tut Verdauung und Blutzucker gut – und gehört in vielen Urlaubsländern ohnehin zum guten Ton.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Warum der Körper in Wochen denkt', paras: ['Dein Stoffwechsel bilanziert über Tage und Wochen, nicht über einzelne Mahlzeiten. Ein üppiger Urlaubstag verschwindet im Durchschnitt, wenn du danach normal weitermachst.', 'Was du nach dem Urlaub oft auf der Waage siehst, ist außerdem viel Wasser (mehr Salz, mehr Kohlenhydrate) – kein echtes Fett. Das reguliert sich in wenigen Tagen von selbst.', 'Flexibilität ist genau das, was einen Plan langfristig haltbar macht. Genuss gehört dazu – ohne schlechtes Gewissen.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was ist im Urlaub ein starkes, realistisches Ziel?', options: ['Weiter streng abnehmen', 'Das Gewicht halten', 'Gar nichts essen'], answer: 1, explain: 'Halten statt Abnehmen ist unterwegs ein Gewinn – nach dem Urlaub geht es normal weiter.' },
        { q: 'Was ist die Gewichtszunahme direkt nach dem Urlaub oft?', options: ['Nur Fett', 'Vor allem Wasser (Salz/Kohlenhydrate)', 'Muskeln'], answer: 1, explain: 'Meist ist es Wasser durch mehr Salz und Kohlenhydrate – das reguliert sich in wenigen Tagen von selbst.' },
      ],
      sources: ['Deutsche Gesellschaft für Ernährung (DGE): Ernährung im Alltag', 'Literatur zu Wassereinlagerung durch Natrium und Kohlenhydrate', 'Levine JA: NEAT / Alltagsbewegung'],
      exercise: 'Plane für deine nächste Reise 2 einfache Regeln (z. B. „Eiweiß zuerst am Buffet" + „täglich 8.000 Schritte") und einen entspannten Genuss-Moment.',
    },
  ],
  definieren: [
    {
      id: 'definieren-v1', title: 'Makros genau tracken', theme: 'Ernährungswissen', minutes: 8,
      teaser: 'Für Fortgeschrittene: wie du Kalorien und Makros präzise steuerst – ohne Zwang.',
      pages: [
        { icon: '🎯', title: 'Warum genauer tracken', paras: ['Je definierter du wirst, desto kleiner die Fehlerspanne. Wer die letzten Prozente Körperfett will, profitiert davon, Kalorien und vor allem Eiweiß genauer zu erfassen.', 'Tracken ist ein Werkzeug auf Zeit, kein Lebensstil für immer – es schärft dein Gefühl für Mengen.'] },
        { icon: '⚖️', title: 'Sauber wiegen & erfassen', paras: ['Wiege energiedichte Dinge (Öl, Nüsse, Käse) im rohen Zustand ab und nutze verlässliche Nährwertangaben. Getränke und „ein Löffel hier und da" nicht vergessen – sie summieren sich.', 'Ein paar genaue Tage zeigen dir oft mehr als Wochen des Schätzens.'] },
        { icon: '🎛️', title: 'Prioritäten setzen', paras: ['Reihenfolge der Wichtigkeit: 1) Kalorien, 2) Eiweiß, 3) Fett/Kohlenhydrate-Verteilung, 4) Timing, 5) alles andere. Wer die ersten zwei trifft, hat 90 % geschafft.', 'Verzettel dich nicht in Details, solange die Basis nicht sitzt.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Warum Rechner nur schätzen', paras: ['Formeln (Mifflin-St-Jeor & Co.) schätzen deinen Verbrauch – dein echter Bedarf hängt von Muskelmasse, NEAT und Anpassung ab und kann abweichen.', 'Deshalb ist Beobachten über 1–2 Wochen wertvoller als jede Formel: Du justierst anhand deiner realen Reaktion.', 'Eine Stoffwechselmessung im Studio ersetzt die Schätzung durch deinen tatsächlichen Wert – die präziseste Basis fürs Feintuning.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was ist beim Tracken am wichtigsten?', options: ['Kalorien und Eiweiß', 'Nur das Timing', 'Die Uhrzeit'], answer: 0, explain: 'Kalorien und Eiweiß zuerst – wer die trifft, hat den Großteil geschafft.' },
        { q: 'Wie erfasst du energiedichte Lebensmittel am besten?', options: ['Genau abwiegen', 'Nur schätzen', 'Ignorieren'], answer: 0, explain: 'Öl, Nüsse, Käse werden am häufigsten unterschätzt – abwiegen bringt Klarheit.' },
      ],
      sources: ['ISSN: Diet & Body Composition', 'Mifflin MD, St Jeor ST et al. (1990)', 'Literatur zu Tracking-Genauigkeit'],
      exercise: 'Wiege 3 Tage lang deine energiedichten Lebensmittel genau ab und prüfe, ob du dein Kalorien- und Eiweißziel wirklich triffst.',
    },
    {
      id: 'definieren-v2', title: 'Satt bleiben im Cut', theme: 'Verhalten', minutes: 7,
      teaser: 'Weniger Kalorien, trotzdem satt – die besten Strategien gegen Hunger.',
      pages: [
        { icon: '🥗', title: 'Volumen essen', paras: ['Der stärkste Sattmacher-Trick im Defizit: viel Volumen bei wenig Kalorien. Gemüse, Salate, Suppen, Beeren und mageres Eiweiß füllen den Magen, ohne die Bilanz zu sprengen.', 'Ein großer bunter Teller schlägt einen kleinen kalorienreichen – bei gleicher Energie wirst du deutlich satter.'] },
        { icon: '🍗', title: 'Eiweiß & Ballaststoffe', paras: ['Eiweiß und Ballaststoffe sind die sättigendsten Bausteine. Baue beide in jede Mahlzeit ein – das dämpft Hunger-Hormone und hält den Blutzucker ruhig.', 'Magerquark, Skyr, Hülsenfrüchte, Vollkorn und Gemüse sind deine Verbündeten.'] },
        { icon: '☕', title: 'Kleine Helfer', paras: ['Wasser, ungesüßter Tee, Kaffee und ausreichend Schlaf dämpfen Appetit zusätzlich. Flüssige Kalorien (Säfte, Latte) dagegen sättigen kaum – lieber sparen.', 'Bewusst und langsam essen lässt das Sättigungssignal rechtzeitig ankommen.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Hunger-Hormone im Defizit', paras: ['Im Defizit steigt Ghrelin (Hunger) und sinkt Leptin (Sättigung) – der Körper will die Energielücke schließen. Eiweiß, Ballaststoffe und Volumen wirken diesem Signal entgegen.', 'Schlafmangel verstärkt den Hunger zusätzlich; guter Schlaf ist also auch ein Sattmacher.', 'So arbeitest du mit deiner Biologie statt gegen sie – Definition ohne Dauerhunger.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was macht im Defizit am meisten satt?', options: ['Volumen + Eiweiß + Ballaststoffe', 'Flüssige Kalorien', 'Kleine kalorienreiche Snacks'], answer: 0, explain: 'Voluminöse, eiweiß- und ballaststoffreiche Mahlzeiten füllen den Magen bei wenig Kalorien.' },
        { q: 'Was passiert im Defizit mit den Hunger-Hormonen?', options: ['Mehr Ghrelin, weniger Leptin', 'Weniger Hunger', 'Nichts'], answer: 0, explain: 'Der Körper meldet mehr Hunger – Eiweiß, Ballaststoffe, Volumen und Schlaf wirken dem entgegen.' },
      ],
      sources: ['Übersichtsarbeiten zu Sättigung und Energiedichte', 'Literatur zu Protein/Ballaststoffen und Appetit', 'Spiegel K et al.: Schlaf und Appetit'],
      exercise: 'Bau bei jeder Mahlzeit heute bewusst Volumen (viel Gemüse) plus Eiweiß ein und ersetze eine flüssige Kalorienquelle durch Wasser/Tee.',
    },
    {
      id: 'definieren-v3', title: 'Auswärts essen im Defizit', theme: 'Umsetzung', minutes: 7,
      teaser: 'Restaurant, Kantine, Einladung – definiert bleiben, ohne Spielverderber zu sein.',
      pages: [
        { icon: '🍽️', title: 'Die Basis-Wahl', paras: ['Eine sichere Restaurant-Basis: eine magere Eiweißquelle (Fisch, Geflügel, Tofu) plus Gemüse/Salat, Beilagen bewusst dosiert. Damit triffst du fast überall eine gute Wahl.', 'Schau die Karte ruhig vorher an und entscheide in Ruhe, statt spontan bei Hunger.'] },
        { icon: '🧠', title: 'Kleine Stellschrauben', paras: ['Nicht ausgehungert hingehen, Wasser vorweg und zwischendurch, Saucen/Dressings separat, langsam essen. Das senkt die Kalorien spürbar, ohne zu verzichten.', 'Frittiertes und cremige Saucen sind die üblichen versteckten Kalorienquellen.'] },
        { icon: '🎉', title: 'Genuss einplanen', paras: ['Ein besonderes Essen darf sein – plane es bewusst in deine Woche ein und mach danach normal weiter. Ein Abend kippt deine Definition nicht.', 'Kein Kompensieren durch Hungern am nächsten Tag – das führt nur in den Verzicht-Heißhunger-Kreislauf.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Ein Essen im Wochenkontext', paras: ['Dein Stoffwechsel bilanziert über die Woche. Ein üppiges Auswärts-Essen verschwindet im Durchschnitt, wenn die restlichen Tage im Ziel liegen.', 'Die Waage am nächsten Tag ist meist Wasser (mehr Salz/Kohlenhydrate), kein Fett – in ein paar Tagen wieder weg.', 'Flexibilität ist genau das, was eine Diät sozial verträglich und dauerhaft haltbar macht.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was ist eine sichere Restaurant-Basis?', options: ['Mageres Eiweiß + Gemüse, Beilagen dosiert', 'Nur Frittiertes', 'Gar nichts essen'], answer: 0, explain: 'Eiweiß plus Gemüse ist fast überall eine gute, sättigende Wahl.' },
        { q: 'Wie wirkt ein einzelnes üppiges Essen auf deine Definition?', options: ['Kaum – die Wochenbilanz zählt', 'Es ruiniert alles', 'Es verdoppelt das Körperfett'], answer: 0, explain: 'Ein Essen fällt im Wochendurchschnitt kaum ins Gewicht, wenn du normal weitermachst.' },
      ],
      sources: ['Literatur zu flexibler Kontrolle', 'Deutsche Gesellschaft für Ernährung (DGE): Ernährung im Alltag', 'Forschung zu Natrium/Wasser'],
      exercise: 'Plane dein nächstes Auswärts-Essen: Basis (Eiweiß+Gemüse), 2 Stellschrauben (Wasser, Saucen separat) und ein klarer, entspannter Wiedereinstieg danach.',
    },
    {
      id: 'definieren-v4', title: 'Cardio sinnvoll einsetzen', theme: 'Training', minutes: 7,
      teaser: 'Wie viel Cardio brauchst du zum Definieren – und wann es zu viel wird.',
      pages: [
        { icon: '🏃', title: 'Cardio ist ein Werkzeug', paras: ['Cardio hilft, ein Defizit zu schaffen und die Herz-Kreislauf-Fitness zu verbessern – aber es ist nur ein Werkzeug, nicht die Hauptzutat. Die Ernährung schafft das Defizit, Krafttraining schützt die Muskeln.', 'Du musst dich nicht „auspowern", um Fett zu verlieren. Ein moderates Maß reicht.'] },
        { icon: '🚶', title: 'NEAT zuerst', paras: ['Bevor du stundenlang joggst: Alltagsbewegung (Schritte, NEAT) ist der angenehmste und nachhaltigste Cardio-Hebel. Ein paar tausend Schritte extra am Tag summieren sich stark.', 'Gezieltes Cardio ergänzt das, wenn du zusätzlich Kalorien verbrauchen oder deine Ausdauer verbessern willst.'] },
        { icon: '⚠️', title: 'Wann es zu viel wird', paras: ['Sehr viel Cardio plus knappe Kalorien belastet die Erholung und kann Muskeln kosten. Wenn Kraft, Schlaf oder Motivation einbrechen, ist es zu viel – dann reduzieren.', 'Priorität bleibt: genug Essen für starkes Krafttraining, Cardio als Ergänzung.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Cardio, Muskeln & Verbrauch', paras: ['Moderates Cardio verbessert die Insulinempfindlichkeit und die Fettverbrennung, ohne die Muskeln stark zu belasten. Exzessives Ausdauertraining im Defizit kann dagegen den Muskelabbau fördern.', 'Krafttraining bleibt der Muskelschützer; Cardio unterstützt Herz und Kalorienbilanz. Die Mischung macht’s.', 'Wie viel Verbrauch du hast und wie viel Cardio sinnvoll ist, kann eine Standortbestimmung im Studio klären.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was schafft das Defizit zum Definieren primär?', options: ['Die Ernährung (Cardio ergänzt)', 'Nur Cardio', 'Nur Supplemente'], answer: 0, explain: 'Die Ernährung schafft das Defizit, Krafttraining schützt Muskeln, Cardio ist Ergänzung.' },
        { q: 'Was ist der angenehmste Cardio-Hebel?', options: ['Alltagsbewegung/NEAT (Schritte)', 'Stundenlanges Joggen', 'Gar keine Bewegung'], answer: 0, explain: 'Mehr Alltagsbewegung ist nachhaltig und muskelschonend – gezieltes Cardio ergänzt.' },
      ],
      sources: ['Literatur zu Cardio, NEAT und Fettabbau', 'Levine JA: NEAT', 'Helms ER et al.: Trainingsempfehlungen in der Diät'],
      exercise: 'Setz dir ein tägliches Schritt-Ziel als Basis und ergänze – falls nötig – 1–2 moderate Cardio-Einheiten, ohne das Krafttraining zu verdrängen.',
    },
    {
      id: 'definieren-v5', title: 'Problemzonen & Spot-Reduction', theme: 'Ernährungswissen', minutes: 7,
      teaser: 'Kann man gezielt am Bauch abnehmen? Was Wissenschaft dazu wirklich sagt.',
      pages: [
        { icon: '🎯', title: 'Der Spot-Reduction-Mythos', paras: ['Die Idee, mit Bauchübungen gezielt Bauchfett zu verlieren, ist ein hartnäckiger Mythos. Der Körper baut Fett nach eigenem Muster ab – nicht dort, wo du die Muskeln trainierst.', 'Bauchtraining stärkt die Bauchmuskeln, „verbrennt" aber nicht selektiv das Fett darüber.'] },
        { icon: '🧬', title: 'Wo Fett zuerst geht', paras: ['Wo dein Körper Fett zuerst oder zuletzt abbaut, ist stark genetisch und hormonell bestimmt. Oft sind Bauch (bei Männern) oder Hüften/Oberschenkel (bei Frauen) die „letzten Bastionen".', 'Das ist normal und kein Zeichen, dass du etwas falsch machst – Geduld ist hier die Antwort.'] },
        { icon: '📉', title: 'Was wirklich hilft', paras: ['Der einzige Weg zu weniger Fett an den Problemzonen ist, den Gesamtkörperfettanteil zu senken – über ein moderates Defizit, viel Eiweiß und Krafttraining. Die Problemzonen folgen mit der Zeit.', 'Konstanz über Wochen schlägt jeden „Bauch-weg"-Trick.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Hartnäckiges Fett verstehen', paras: ['Manche Fettdepots haben mehr „hartnäckige" Rezeptoren, die den Abbau bremsen – das erklärt, warum bestimmte Zonen zuletzt verschwinden. Es ist Biologie, nicht mangelnde Disziplin.', 'Mit sinkendem Gesamtfett und erhaltener Muskulatur werden auch diese Zonen definierter – es dauert nur länger.', 'Eine Körperanalyse im Studio zeigt deinen echten Fortschritt, auch wenn eine Zone gefühlt „stur" bleibt.'], cta: 'Körperanalyse im Studio' },
      ],
      quiz: [
        { q: 'Kann man mit Bauchübungen gezielt Bauchfett verlieren?', options: ['Nein – Spot-Reduction ist ein Mythos', 'Ja, sofort', 'Nur mit Geräten'], answer: 0, explain: 'Der Körper baut Fett nach eigenem Muster ab – Bauchtraining stärkt nur die Muskeln.' },
        { q: 'Was senkt das Fett an Problemzonen?', options: ['Gesamtkörperfett senken (Defizit, Eiweiß, Kraft)', 'Nur eine Zone trainieren', 'Spezielle Cremes'], answer: 0, explain: 'Nur ein niedrigerer Gesamtfettanteil bringt die Problemzonen mit der Zeit zum Schmelzen.' },
      ],
      sources: ['Literatur zur Widerlegung von Spot-Reduction', 'Übersichtsarbeiten zu regionaler Fettverteilung', 'ISSN: Diet & Body Composition'],
      exercise: 'Verabschiede dich von „Bauch-weg"-Tricks: Fokussiere diese Woche auf Gesamtdefizit, Eiweiß und Krafttraining – und übe dich in Geduld mit deiner Problemzone.',
    },
    {
      id: 'definieren-v6', title: 'Dranbleiben & Motivation', theme: 'Mindset', minutes: 7,
      teaser: 'Eine Diät ist auch Kopfsache – so hältst du durch, ohne dich zu quälen.',
      pages: [
        { icon: '🧭', title: 'Warum vor Wie', paras: ['Diäten scheitern selten am Wissen, sondern am Dranbleiben. Ein klares „Warum" (dein echtes Motiv) trägt dich durch die zähen Wochen besser als jede Regel.', 'Schreib dir auf, warum dir Definition wichtig ist – und erinnere dich daran, wenn die Motivation schwankt.'] },
        { icon: '📊', title: 'Prozess statt nur Ergebnis', paras: ['Feier den Prozess: getroffene Eiweißziele, absolvierte Trainings, gehaltene Gewohnheiten. Diese hast du in der Hand – die Waage nicht immer.', 'Kleine, sichtbare Erfolge halten die Motivation, auch wenn sich äußerlich gerade wenig tut.'] },
        { icon: '🤝', title: 'Struktur & Unterstützung', paras: ['Feste Routinen, ein realistischer Plan und Menschen, die dich unterstützen (Trainingspartner, Coach, Studio) machen das Durchhalten leichter. Willenskraft allein ist unzuverlässig.', 'Und: Diätpausen sind kein Scheitern, sondern Teil der Strategie – sie halten den Kopf frisch.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Der Kopf und die Hormone', paras: ['Langes Defizit senkt nicht nur Leptin, sondern kann auch Stimmung und Antrieb dämpfen – das ist normal und biologisch. Geplante Pausen, guter Schlaf und Erfolge helfen dagegen.', 'Wer das versteht, nimmt Motivationstiefs nicht persönlich, sondern reagiert mit Struktur statt Selbstvorwürfen.', 'Ein realistischer Plan mit Pausen schlägt jeden kurzfristigen Motivations-Kick – und schont Kopf und Stoffwechsel.'], cta: 'Stoffwechsel-Coaching anfragen' },
      ],
      quiz: [
        { q: 'Woran scheitern Diäten meist?', options: ['Am Dranbleiben, nicht am Wissen', 'An zu viel Eiweiß', 'An zu viel Gemüse'], answer: 0, explain: 'Ein klares „Warum", Prozess-Fokus und Struktur helfen mehr als noch eine Regel.' },
        { q: 'Was solltest du feiern, wenn die Waage stockt?', options: ['Den Prozess (Eiweiß, Training, Gewohnheiten)', 'Nichts', 'Nur die Waage'], answer: 0, explain: 'Prozess-Erfolge hast du in der Hand und halten die Motivation.' },
      ],
      sources: ['Literatur zu Motivation und Verhaltensänderung', 'Rosenbaum M, Leibel RL: Diät und Antrieb', 'Helms ER et al.: psychologische Aspekte der Diät'],
      exercise: 'Schreib dein echtes „Warum" auf und definiere 2–3 Prozess-Ziele (z. B. Eiweiß treffen, 3× trainieren), die du diese Woche feiern kannst.',
    },
  ],
  aufbau: [
    {
      id: 'aufbau-v1', title: 'Genug essen als „Hardgainer"', theme: 'Umsetzung', minutes: 8,
      teaser: 'Wenn Zunehmen schwerfällt: so bekommst du die Kalorien wirklich unter.',
      pages: [
        { icon: '🍽️', title: 'Das eigentliche Problem', paras: ['„Ich esse so viel und nehme trotzdem nicht zu" heißt fast immer: Es ist doch weniger, als es sich anfühlt. Große, sättigende Mahlzeiten wirken üppig, liefern aber oft weniger Energie als gedacht.', 'Die Lösung ist nicht „reinschaufeln", sondern clever mehr Energie unterzubringen.'] },
        { icon: '🥜', title: 'Energiedicht essen', paras: ['Nüsse, Nussmus, Öle, Trockenfrüchte, Vollmilch, Haferflocken, Avocado – kleine Mengen, viel Energie. Ideal, wenn große Portionen dich zu voll machen.', 'Ein Löffel Nussmus im Porridge oder eine Handvoll Nüsse als Snack bringt dich unauffällig näher an deinen Überschuss.'] },
        { icon: '🥤', title: 'Kalorien trinken', paras: ['Flüssige Kalorien sättigen weniger. Ein selbstgemachter Shake (Milch/Sojadrink, Haferflocken, Banane, Nussmus, Whey) bringt viel Energie und Eiweiß, ohne den Magen zu überlasten.', 'Auch eine zusätzliche kleine Mahlzeit oder ein Snack zwischendurch hilft, die Menge über den Tag zu verteilen.'] },
        { kind: 'metabolism', icon: '🧬', title: 'NEAT & hoher Verbrauch', paras: ['Wer schwer zunimmt, hat oft einen hohen Verbrauch durch viel unbewusste Alltagsbewegung (NEAT) – Zappeln, Gehen, Unruhe. Der Körper „verbrennt" den Überschuss teilweise über mehr Bewegung.', 'Das ist keine Störung, sondern individuelle Regulation. Die Antwort ist ein etwas höherer, konsequent getroffener Überschuss.', 'Eine Stoffwechselmessung zeigt deinen echten Bedarf – dann triffst du den Überschuss zielsicher.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Häufigster Grund für „nehme nicht zu"?', options: ['Man isst weniger, als es sich anfühlt', 'Muskeln wiegen nichts', 'Der Körper speichert nie Energie'], answer: 0, explain: 'Sättigende Mahlzeiten wirken üppig, liefern aber oft weniger Energie als gedacht.' },
        { q: 'Wie bekommst du leichter mehr Energie unter?', options: ['Energiedicht essen + Shakes', 'Nur Salat', 'Mahlzeiten auslassen'], answer: 0, explain: 'Nüsse, Öle, Trockenobst und Shakes bringen viel Energie in kleiner, weniger sättigender Menge.' },
      ],
      sources: ['Levine JA: NEAT', 'Literatur zu Energiedichte', 'ISSN: Diet & Body Composition'],
      exercise: 'Baue heute gezielt energiedichte Kalorien ein (Shake oder Nussmus) und schau, ob du deinen Überschuss so leichter triffst.',
    },
    {
      id: 'aufbau-v2', title: 'Der Muskelaufbau-Shake', theme: 'Ernährungswissen', minutes: 6,
      teaser: 'Ein guter Shake selbst gemacht – günstig, sättigend und voller Bausteine.',
      pages: [
        { icon: '🥛', title: 'Wozu ein Shake', paras: ['Ein Shake ist kein Muss, aber praktisch: Er bringt Eiweiß und Energie schnell und flüssig, ideal wenn feste Mahlzeiten schwerfallen oder rund ums Training.', 'Selbstgemacht ist er günstiger und besser als die meisten „Mass Gainer" aus dem Handel (oft nur teurer Zucker).'] },
        { icon: '🧾', title: 'Ein einfaches Rezept', paras: ['Basis: 300–400 ml Milch oder Sojadrink, 50–80 g Haferflocken, 1 Banane, 1 EL Nussmus, optional 30 g Whey oder Sojaprotein. Ergibt grob 500–700 kcal mit viel Eiweiß.', 'Variiere mit Beeren, Kakao, Zimt oder Magerquark – je nach Geschmack und Kalorienziel.'] },
        { icon: '🎯', title: 'Klug einsetzen', paras: ['Nutze den Shake als Ergänzung, nicht als Ersatz für echtes Essen. Ein Shake zu viel und die festen Mahlzeiten leiden – dann fehlt Vielfalt und Sättigung.', 'Gut als Snack zwischendurch oder rund ums Training.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Flüssig = weniger Sättigung', paras: ['Flüssige Kalorien sättigen schwächer als feste – für Hardgainer ein Vorteil, weil man so leichter in den Überschuss kommt. Für alle, die aufpassen müssen, eher eine Falle.', 'Eiweiß im Shake (Whey/Soja/Quark) liefert schnell Aminosäuren für die Muskel-Proteinsynthese – praktisch rund ums Training.', 'Als Teil einer soliden Basis ist der Shake ein nützliches Werkzeug – kein Wundermittel.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was ist an den meisten „Mass Gainern" das Problem?', options: ['Oft nur teurer Zucker', 'Zu viel Eiweiß', 'Sie sind zu günstig'], answer: 0, explain: 'Dieselbe Energie bekommst du günstiger aus einem selbstgemachten Shake.' },
        { q: 'Wie nutzt du den Shake richtig?', options: ['Als Ergänzung, nicht als Ersatz für echtes Essen', 'Statt aller Mahlzeiten', 'Nie'], answer: 0, explain: 'Der Shake ergänzt – zu viele Shakes lassen feste Mahlzeiten und Vielfalt leiden.' },
      ],
      sources: ['ISSN: Protein and Exercise', 'Literatur zu flüssigen vs. festen Kalorien', 'Verbraucherzentrale: Weight Gainer'],
      exercise: 'Mix dir heute einen Aufbau-Shake nach dem Rezept (oder deiner Variante) und trink ihn als Snack oder rund ums Training.',
    },
    {
      id: 'aufbau-v3', title: 'Pflanzlich Muskeln aufbauen', theme: 'Ernährungswissen', minutes: 8,
      teaser: 'Vegetarisch oder vegan aufbauen – geht sehr gut, mit ein paar Kniffen.',
      pages: [
        { icon: '🌱', title: 'Ja, es funktioniert', paras: ['Muskelaufbau ist auch rein pflanzlich gut möglich. Wichtig sind genug Kalorien, genug Eiweiß und eine kluge Auswahl der Quellen.', 'Die zwei Punkte, auf die du achtest: Eiweißmenge/-qualität und ein paar kritische Nährstoffe.'] },
        { icon: '🫘', title: 'Genug (gutes) Eiweiß', paras: ['Setze auf Hülsenfrüchte, Tofu, Tempeh, Sojaprodukte, Seitan, Haferflocken, Nüsse; für Vegetarier Quark, Skyr, Eier. Kombiniere Quellen (z. B. Getreide + Hülsenfrüchte) für ein volles Aminosäureprofil.', 'Weil pflanzliches Eiweiß etwas schlechter verwertet wird, plane eher am oberen Ende (~1,8–2,0 g/kg) und verteile es gut.'] },
        { icon: '💊', title: 'Kritische Nährstoffe', paras: ['Vegan Vitamin B12 supplementieren (Pflicht). Im Blick behalten: Eisen, Omega-3 (Algenöl), Kalzium, Jod, Zink, Vitamin D. Kreatin ist bei Pflanzenkost besonders sinnvoll, da es in Fleisch vorkommt.', 'Mit etwas Planung ist das alles gut abgedeckt.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Leucin & Verwertung', paras: ['Die Aminosäure Leucin löst die Muskel-Proteinsynthese aus; manche pflanzlichen Quellen haben etwas weniger davon. Die Lösung: etwas mehr essen und Quellen kombinieren – dann ist der Aufbau voll erhalten.', 'Sojaprotein schneidet unter den pflanzlichen Quellen besonders gut ab und ist eine praktische Ergänzung.', 'Eine Analyse im Studio kann zeigen, ob deine pflanzliche Ernährung deinen Bedarf deckt.'], cta: 'Körperanalyse im Studio' },
      ],
      quiz: [
        { q: 'Was ist beim pflanzlichen Aufbau wichtig?', options: ['Genug Eiweiß, Quellen kombinieren, etwas mehr davon', 'Eiweiß weglassen', 'Nur Salat'], answer: 0, explain: 'Etwas mehr Eiweiß und kombinierte Quellen sichern den Muskelaufbau vollständig.' },
        { q: 'Welches Supplement ist bei Pflanzenkost besonders sinnvoll?', options: ['Kreatin (und vegan B12)', 'Fatburner', 'BCAAs'], answer: 0, explain: 'Kreatin kommt v. a. in Fleisch vor – pflanzlich lohnt sich die Ergänzung; B12 ist vegan Pflicht.' },
      ],
      sources: ['ISSN: Protein (auch pflanzlich)', 'Academy of Nutrition and Dietetics: pflanzliche Ernährung', 'Literatur zu Sojaprotein und Aufbau'],
      exercise: 'Plane eine pflanzliche, eiweißreiche Mahlzeit (z. B. Tofu + Hülsenfrüchte + Getreide) und prüfe, ob du an B12/Kreatin denkst.',
    },
    {
      id: 'aufbau-v4', title: 'Schlaf & Muskelwachstum', theme: 'Verhalten', minutes: 6,
      teaser: 'Der unterschätzte Wachstums-Booster, der nichts kostet.',
      pages: [
        { icon: '😴', title: 'Schlaf ist anabol', paras: ['Im Schlaf – besonders im Tiefschlaf – regeneriert der Muskel und der Körper schüttet Wachstumshormon aus. Zu wenig Schlaf bremst den Aufbau spürbar, egal wie gut Training und Ernährung sind.', 'Ziel sind 7–9 Stunden, möglichst regelmäßig.'] },
        { icon: '📉', title: 'Was Schlafmangel anrichtet', paras: ['Chronischer Schlafmangel senkt die Erholung, drückt anabole Hormone, hebt Cortisol und erhöht den Appetit auf schnelle Energie. Kraft und Motivation leiden.', 'Studien zeigen: Bei zu wenig Schlaf geht in der Diät mehr Muskel und weniger Fett verloren – Schlaf schützt also auch die Muskeln.'] },
        { icon: '🛌', title: 'Besser schlafen', paras: ['Feste Zeiten, dunkles kühles Zimmer, Bildschirm eine Stunde vorher runter, Koffein am Nachmittag meiden, abends weniger Alkohol. Tageslicht und Bewegung am Tag verbessern den Schlaf in der Nacht.', 'Ein Eiweiß-Snack vor dem Schlafen (z. B. Quark) versorgt die Regeneration über Nacht.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Hormone in der Nacht', paras: ['Wachstumshormon-Ausschüttung im Tiefschlaf und ein gesunder Testosteronspiegel (durch ausreichenden Schlaf) begünstigen Aufbau und Regeneration.', 'Guter Schlaf verbessert außerdem die Insulinempfindlichkeit – Nährstoffe landen eher im Muskel.', 'Schlaf ist damit einer der stärksten, kostenlosen Aufbau-Hebel überhaupt.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Warum ist Schlaf „anabol"?', options: ['Regeneration + Wachstumshormon im Tiefschlaf', 'Er ist Zeitverschwendung', 'Er baut Muskeln ab'], answer: 0, explain: 'Im Schlaf regeneriert der Muskel und Wachstumshormon wird ausgeschüttet.' },
        { q: 'Was passiert bei Schlafmangel in der Diät?', options: ['Mehr Muskel- und weniger Fettverlust', 'Nur Fettverlust', 'Nichts'], answer: 0, explain: 'Zu wenig Schlaf kostet in der Diät mehr Muskel – Schlaf schützt die Muskulatur.' },
      ],
      sources: ['Literatur zu Schlaf und Wachstumshormon/Testosteron', 'Nedeltcheva AV et al.: Schlaf und Körperkomposition in der Diät', 'ISSN: Recovery'],
      exercise: 'Lege eine feste Schlafenszeit fest, reduziere abends Bildschirm/Koffein und iss vor dem Schlafen eine Eiweißportion.',
    },
    {
      id: 'aufbau-v5', title: 'Supplemente-Deep-Dive', theme: 'Ernährungswissen', minutes: 8,
      teaser: 'Kreatin, Koffein, Beta-Alanin & Co. – was wirkt, was nicht, was wie einnehmen.',
      pages: [
        { icon: '⚗️', title: 'Kreatin – der Klassiker', paras: ['Kreatin-Monohydrat ist das am besten untersuchte Supplement für Kraft und Muskeln. ~3–5 g täglich, dauerhaft, keine Ladephase nötig. Günstig und sicher.', 'Es füllt die schnellen Energiespeicher im Muskel – ein, zwei Wiederholungen mehr und ein vollerer Muskel.'] },
        { icon: '☕', title: 'Koffein & Pre-Workout', paras: ['Koffein (ca. 3 mg/kg vor dem Training) steigert Leistung und Fokus kurzfristig – nützlich vor schweren Einheiten. Der Effekt nutzt sich bei Dauerkonsum ab; Pausen helfen.', 'Fertige „Pre-Workouts" sind oft Koffein plus wenig belegte Extras – ein schwarzer Kaffee tut es meist auch.'] },
        { icon: '❓', title: 'Der Rest – nüchtern betrachtet', paras: ['Beta-Alanin kann bei bestimmten Ausdauer-/Wiederholungsbereichen leicht helfen (harmloses Kribbeln). Eiweißpulver ist praktisch. BCAAs, „Testo-Booster" und exotische Extrakte bringen bei guter Ernährung wenig.', 'Faustregel: Wenige belegte Mittel gezielt, den Rest sparen.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Wie Kreatin & Koffein wirken', paras: ['Kreatin liefert Phosphat für die schnelle ATP-Regeneration bei kurzen, kräftigen Anstrengungen – mehr Reiz pro Satz. Koffein wirkt aufs Nervensystem und die wahrgenommene Anstrengung.', 'Beide verbessern die Trainingsqualität leicht und verstärken so den Wachstumsreiz – aber nur auf einer soliden Basis aus Training, Eiweiß, Überschuss und Schlaf.', 'Kein Supplement ersetzt die Basics – der Stoffwechsel baut Muskeln aus echten Bausteinen.'], cta: 'Stoffwechsel-Coaching anfragen' },
      ],
      quiz: [
        { q: 'Wie nimmst du Kreatin?', options: ['~3–5 g täglich dauerhaft', 'Nur vor dem Wettkampf', 'Gar nicht'], answer: 0, explain: '3–5 g pro Tag dauerhaft füllen die Speicher – keine Ladephase nötig.' },
        { q: 'Was gilt für die meisten „Pre-Workouts"?', options: ['Oft Koffein + wenig belegte Extras', 'Wundermittel', 'Ersatz fürs Training'], answer: 0, explain: 'Der Hauptwirkstoff ist meist Koffein – ein Kaffee tut es oft auch.' },
      ],
      sources: ['ISSN Position Stands: Creatine, Caffeine, Beta-Alanine', 'Verbraucherzentrale: Sportlernahrung', 'Literatur zu Pre-Workout-Supplementen'],
      exercise: 'Sortiere deine Supplemente: Behalte, was Evidenz hat (Kreatin, ggf. Koffein/Eiweißpulver), und streiche den Rest.',
    },
    {
      id: 'aufbau-v6', title: 'Trainingsplan-Grundlagen', theme: 'Training', minutes: 8,
      teaser: 'Wie ein guter Hypertrophie-Plan aufgebaut ist – die wichtigsten Prinzipien.',
      pages: [
        { icon: '🏗️', title: 'Die Bausteine', paras: ['Ein guter Muskelaufbau-Plan deckt alle großen Muskelgruppen ab, nutzt vor allem Grundübungen (Kniebeuge, Kreuzheben, Drücken, Rudern, Klimmzüge) plus gezielte Isolation, und steigert die Belastung über die Zeit.', 'Häufigkeit: jede Muskelgruppe idealerweise 2× pro Woche trainieren.'] },
        { icon: '🔁', title: 'Wiederholungen & Intensität', paras: ['Muskelwachstum funktioniert über einen breiten Wiederholungsbereich (ca. 5–30), solange die Sätze nah an die Belastungsgrenze gehen (1–3 Wiederholungen „im Tank").', 'Für die meisten sind 6–15 Wiederholungen ein praktischer, gelenkschonender Bereich.'] },
        { icon: '📈', title: 'Progression einbauen', paras: ['Der Plan muss Steigerung ermöglichen: mehr Gewicht, mehr Wiederholungen oder mehr Sätze über die Wochen. Notiere deine Leistung, damit du siehst, ob es vorangeht.', 'Wechsle nicht ständig alles – gib einem Plan 6–12 Wochen, bevor du größer umbaust.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Reiz trifft Ernährung', paras: ['Der Trainingsreiz (mechanische Spannung) aktiviert die Signalwege für Muskelaufbau; Eiweiß und Energie liefern das Material. Beides zusammen ergibt Wachstum – eins ohne das andere verpufft.', 'Ein durchdachter Plan sorgt für regelmäßige, steigende Reize; die Ernährung sorgt dafür, dass der Körper darauf mit Aufbau antworten kann.', 'Wie gut dein Körper darauf reagiert, kann eine Standortbestimmung im Studio einordnen.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Wie oft solltest du eine Muskelgruppe trainieren?', options: ['Idealerweise 2× pro Woche', 'Einmal im Monat', 'Jeden Tag maximal'], answer: 0, explain: '2× pro Woche pro Muskelgruppe ist für die meisten ein guter Aufbau-Reiz.' },
        { q: 'Was ist der Schlüssel im Plan?', options: ['Progression (Steigerung über die Zeit)', 'Ständig alles wechseln', 'Möglichst leicht trainieren'], answer: 0, explain: 'Ohne progressive Steigerung kein Wachstum – gib einem Plan Zeit.' },
      ],
      sources: ['Schoenfeld BJ: Mechanismen der Hypertrophie & Trainingsvariablen', 'ISSN: Diet & Body Composition', 'Literatur zu Wiederholungsbereichen und Hypertrophie'],
      exercise: 'Prüfe deinen Plan: Deckt er alle großen Muskelgruppen 2×/Woche ab, mit Grundübungen und einer Möglichkeit zur Progression?',
    },
  ],
  halten: [
    {
      id: 'halten-v1', title: 'Wochenend-Kalorien im Griff', theme: 'Alltagskompetenz', minutes: 8,
      teaser: 'Warum das Wochenende oft die ganze Woche kippt – und wie du es entspannt in Balance hältst.',
      pages: [
        { icon: '📅', title: 'Das Wochenend-Rechenspiel', paras: ['Fünf Tage sauber, zwei Tage „egal" – und die Waage bewegt sich trotzdem nach oben. Der Grund ist simple Mathematik: An Samstag und Sonntag kommen schnell 1.000–1.500 kcal extra pro Tag zusammen (Restaurant, Snacks, Alkohol). Das kann das kleine Defizit der Woche komplett auffressen.', 'Erhalten heißt nicht, das Wochenende zu streichen. Es heißt, die Ausschläge kleiner zu machen, sodass die Wochenbilanz stimmt.'] },
        { icon: '🍷', title: 'Die üblichen Verdächtigen', paras: ['Alkohol ist der stille Kalorienlieferant: Ein Bier oder Glas Wein hat 150–200 kcal, und Alkohol bremst zusätzlich die Fettverbrennung, während er da ist. Dazu kommt oft der Heißhunger danach.', 'Restaurant-Portionen sind meist 1,5–2× größer als zu Hause, und flüssige Kalorien (Softdrinks, Cocktails, Latte) zählen mit, machen aber kaum satt.'] },
        { icon: '⚖️', title: 'Deine Wochenend-Strategie', paras: ['Plane den Genuss statt ihn zu verbieten: Wähle bewusst ein oder zwei Highlights (das gute Essen, das Glas Wein) und lass den Rest normal laufen. „Alles oder nichts" ist der Weg zur Völlerei.', 'Praktische Anker: eiweißreich frühstücken, vor dem Restaurant kein Snack-Hunger, Wasser zwischen alkoholischen Getränken, und am Sonntag zurück zur normalen Routine – nicht „jetzt ist eh egal".'] },
        { kind: 'metabolism', icon: '🧬', title: 'Warum die Woche als Ganzes zählt', paras: ['Dein Körper rechnet nicht in Kalendertagen. Für Gewichtserhaltung zählt die Energiebilanz über die Woche und den Monat – ein Tag mit Überschuss ist völlig unkritisch, wenn die Tage drumherum stimmen.', 'Das nimmt den Druck: Du musst nicht jeden Tag „perfekt" sein. Ein bewusstes Wochenende plus fünf ruhige Tage ergibt eine stabile Bilanz – genau das ist nachhaltiges Halten.', 'Wo dein persönlicher Erhaltungsbedarf liegt und wie viel Spielraum du am Wochenende wirklich hast, kann eine Standortbestimmung im Studio einordnen.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Warum kann ein „lockeres" Wochenende das Wochendefizit auffressen?', options: ['Weil an 2 Tagen schnell 2.000–3.000 kcal extra zusammenkommen', 'Weil man am Wochenende weniger schläft', 'Weil der Körper am Wochenende langsamer verbrennt'], answer: 0, explain: 'Zwei Tage mit je 1.000–1.500 kcal extra können das kleine Defizit von fünf Tagen komplett ausgleichen – reine Mathematik.' },
        { q: 'Was ist die klügste Wochenend-Strategie beim Halten?', options: ['Genuss bewusst planen statt „alles oder nichts"', 'Freitag bis Sonntag komplett fasten', 'Am Wochenende gar nicht auf die Waage schauen und einfach loslassen'], answer: 0, explain: 'Ein bis zwei geplante Highlights plus normale Routine drumherum halten die Ausschläge klein – ganz ohne Verzicht auf das Schöne.' },
      ],
      sources: ['Racette SB et al.: Wochenend-Muster bei Gewichtsveränderung', 'Deutsche Gesellschaft für Ernährung (DGE): Alkohol und Energiezufuhr', 'Literatur zu Energiebilanz über Wochenzeiträume'],
      exercise: 'Plane dein nächstes Wochenende: Lege ein oder zwei bewusste Genuss-Highlights fest und entscheide vorher, wo du entspannt bei der Routine bleibst.',
    },
    {
      id: 'halten-v2', title: 'Gewicht halten auf Reisen', theme: 'Alltagskompetenz', minutes: 7,
      teaser: 'Urlaub, Dienstreise, Hotel – so kommst du ohne Gewichts-Überraschung zurück.',
      pages: [
        { icon: '✈️', title: 'Reisen ist eine Ausnahmesituation', paras: ['Auf Reisen fällt fast jede Routine weg: kein eigener Kühlschrank, andere Portionen, Buffet, mehr Sitzen (oder mehr Laufen), oft Alkohol. Kein Wunder, dass sich das Gewicht bewegt.', 'Das Ziel im Urlaub ist selten Abnehmen – realistisch ist „das Gewicht ungefähr halten" und danach nahtlos in die Routine zurückzufinden.'] },
        { icon: '🍽️', title: 'Das Buffet clever nutzen', paras: ['Am Buffet gilt: erst einmal schauen, dann wählen. Nimm dir zuerst Eiweiß (Eier, Fisch, Joghurt, mageres Fleisch) und Gemüse/Obst – das macht satt und dämpft den Griff zu allem anderen.', 'Ein Teller, hinsetzen, essen, kurz warten. Der Nachschlag-Automatismus ist die eigentliche Kalorienfalle, nicht das erste Mal Auffüllen.'] },
        { icon: '🚶', title: 'Bewegung passiert nebenbei', paras: ['Reisen bietet oft mehr Alltagsbewegung als der Büroalltag: Städte zu Fuß erkunden, Treppen, Schwimmen, Wandern. Diese „NEAT"-Bewegung verbrennt über den Tag erstaunlich viel, ganz ohne Fitnessstudio.', 'Ein einfaches Ziel: jeden Reisetag ein bisschen bewegen – ein Spaziergang nach dem Essen zählt schon und hilft auch der Verdauung.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Wasser, Salz und die Reise-Waage', paras: ['Nach einer Reise zeigt die Waage oft 1–2 kg mehr – meist ist das kein Fett. Salzige Restaurant-Kost, Alkohol, langes Sitzen im Flieger und veränderte Verdauung binden Wasser. Das reguliert sich nach ein paar normalen Tagen von selbst.', 'Echtes Fett aufzubauen bräuchte einen deutlichen, längeren Kalorienüberschuss – ein einwöchiger Urlaub reicht dafür fast nie so stark, wie die Waage kurz suggeriert.', 'Wie schnell dein Körper nach einer Ausnahme zurück in die Balance findet, hängt an deinem Stoffwechsel – eine Messung im Studio ordnet das für dich ein.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was ist ein realistisches Ziel für das Gewicht im Urlaub?', options: ['Ungefähr halten und danach zur Routine zurück', 'Im Urlaub 3 kg abnehmen', 'Komplett aufhören zu essen'], answer: 0, explain: 'Urlaub ist eine Ausnahmesituation – „ungefähr halten" und ein sauberer Wiedereinstieg sind das vernünftige Ziel.' },
        { q: 'Warum zeigt die Waage direkt nach einer Reise oft mehr an?', options: ['Meist Wasser durch Salz, Alkohol und Sitzen – kein Fett', 'Weil man im Urlaub Muskeln aufbaut', 'Weil die Hotelwaage immer falsch ist'], answer: 0, explain: 'Salzige Kost, Alkohol und langes Sitzen binden Wasser. Nach ein paar normalen Tagen reguliert sich das von selbst.' },
      ],
      sources: ['Literatur zu NEAT (Alltagsbewegung) und Energieverbrauch', 'Deutsche Gesellschaft für Ernährung (DGE): Ernährung unterwegs', 'Übersichtsarbeiten zu Wasserhaushalt und Natriumzufuhr'],
      exercise: 'Nimm dir für deine nächste Reise zwei einfache Regeln vor: am Buffet mit Eiweiß + Gemüse starten und jeden Tag mindestens einen Spaziergang einbauen.',
    },
    {
      id: 'halten-v3', title: 'Snack-Strategien fürs Halten', theme: 'Verhalten', minutes: 7,
      teaser: 'Snacks sind nicht das Problem – planlose Snacks sind es. So machst du sie zu deinem Werkzeug.',
      pages: [
        { icon: '🥨', title: 'Der stille Kalorien-Kanal', paras: ['Snacks werden selten bewusst gegessen: die Kekse im Büro, die Handvoll Nüsse nebenbei, die Kinder-Reste. Genau weil sie „nicht zählen", zählen sie am Ende doppelt – sie tauchen in keiner Mahlzeit-Planung auf.', 'Beim Halten geht es nicht darum, Snacks zu verbieten, sondern sie sichtbar zu machen und gezielt einzusetzen.'] },
        { icon: '💪', title: 'Der sättigende Snack', paras: ['Ein guter Snack liefert Eiweiß und/oder Ballaststoffe: Skyr, Magerquark, Hüttenkäse, ein gekochtes Ei, Gemüsesticks mit Hummus, ein Stück Obst mit ein paar Nüssen. Das hält bis zur nächsten Mahlzeit.', 'Der schlechte Snack ist rein energiedicht und schnell weg: Chips, Kekse, Schokoriegel. Sie liefern viele Kalorien, aber kaum Sättigung – kurz danach hast du wieder Appetit.'] },
        { icon: '🍽️', title: 'Umgebung schlägt Willenskraft', paras: ['Was in Sichtweite und griffbereit ist, wird gegessen. Stell die Obstschale nach vorne, pack Süßes weg (oder kauf es gar nicht erst), portioniere Nüsse in kleine Dosen statt aus der großen Tüte.', '„Aus den Augen, aus dem Mund": Die meiste Snack-Kontrolle passiert beim Einkauf und beim Einräumen, nicht im Moment des Verlangens.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Snacks und deine Sättigung', paras: ['Eiweiß und Ballaststoffe lösen stärkere Sättigungssignale aus (u. a. über Darmhormone wie GLP-1 und PYY) als Zucker und Fett allein. Ein eiweißreicher Snack dämpft den Hunger bis zur nächsten Mahlzeit spürbar.', 'Zuckrige Snacks dagegen geben einen kurzen Blutzucker-Peak und ein Tief danach – der Hunger kommt oft schneller zurück als vorher.', 'Wie oft und was du zwischendurch wirklich brauchst, hängt von deinem Verbrauch und Stoffwechsel ab. Eine Standortbestimmung im Studio hilft dir, das für dich einzuordnen.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was macht einen Snack „gut" fürs Gewicht-Halten?', options: ['Er liefert Eiweiß und/oder Ballaststoffe und sättigt', 'Er ist möglichst süß', 'Er ist flüssig und schnell getrunken'], answer: 0, explain: 'Eiweiß und Ballaststoffe halten bis zur nächsten Mahlzeit – energiedichte Snacks liefern viele Kalorien, aber kaum Sättigung.' },
        { q: 'Wo findet die meiste Snack-Kontrolle statt?', options: ['Beim Einkauf und Einräumen (Umgebung gestalten)', 'Nur durch eiserne Willenskraft im Moment', 'Beim Kalorienzählen nach dem Essen'], answer: 0, explain: 'Was griffbereit ist, wird gegessen. Die Umgebung zu gestalten schlägt Willenskraft im Verlangens-Moment.' },
      ],
      sources: ['Literatur zu Sättigungshormonen (GLP-1, PYY) und Makronährstoffen', 'Wansink B: Umgebung und Essverhalten', 'Deutsche Gesellschaft für Ernährung (DGE): Zwischenmahlzeiten'],
      exercise: 'Richte dir eine „Snack-Zone" ein: zwei sättigende Snacks griffbereit (z. B. Skyr, Obst) und lege Energiedichtes bewusst außer Sichtweite.',
    },
    {
      id: 'halten-v4', title: 'Emotionales Essen verstehen', theme: 'Verhalten', minutes: 8,
      teaser: 'Wenn nicht der Bauch isst, sondern der Kopf – erkennen, verstehen, sanft umlenken.',
      pages: [
        { icon: '🧠', title: 'Hunger ist nicht gleich Hunger', paras: ['Körperlicher Hunger kommt langsam, ist im Bauch spürbar und mit vielem stillbar. Emotionaler Hunger kommt plötzlich, verlangt etwas Bestimmtes (meist Süßes oder Fettiges) und ist nach dem Essen oft von Reue begleitet.', 'Emotionales Essen ist völlig normal und menschlich. Es wird nur dann zum Thema fürs Gewicht, wenn es der Haupt-Weg wird, mit Gefühlen umzugehen.'] },
        { icon: '🔁', title: 'Der Auslöser-Kreislauf', paras: ['Meist läuft ein Muster ab: Auslöser (Stress, Langeweile, Frust, Einsamkeit) → Griff zum Essen → kurze Erleichterung → danach schlechtes Gewissen → mehr Stress. Der Kreis schließt sich.', 'Der Hebel liegt nicht im Verbot, sondern in der Lücke zwischen Auslöser und Handlung. Diese Lücke lässt sich trainieren.'] },
        { icon: '⏸️', title: 'Die Pause einbauen', paras: ['Bevor du zum Essen greifst, frag dich kurz: „Habe ich körperlich Hunger – oder fühle ich gerade etwas?" Schon diese Sekunde durchbricht den Automatismus.', 'Leg dir Alternativen zurecht, die das Gefühl bedienen statt den Magen: kurz rausgehen, jemanden anrufen, Musik, eine Dusche, aufschreiben, was gerade los ist. Wenn du dann noch isst, dann bewusst und ohne Schuld.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Stress, Cortisol und der Süß-Hunger', paras: ['Unter Dauerstress schüttet der Körper mehr Cortisol aus. Das steigert den Appetit – besonders auf zucker- und fettreiche Nahrung, weil der Körper schnell verfügbare Energie „will". Das ist Biologie, kein Charakterfehler.', 'Schlaf, Bewegung und Entspannung senken den Stresspegel und damit oft auch den emotionalen Essdruck – manchmal wirksamer als jede Diät-Regel.', 'Wenn Stress und Essverhalten eng verknüpft sind, lohnt der Blick aufs Ganze. Das Studio-Coaching schaut Schlaf, Stress und Stoffwechsel gemeinsam mit dir an.'], cta: 'Stoffwechsel-Coaching anfragen' },
      ],
      quiz: [
        { q: 'Wie unterscheidet sich emotionaler von körperlichem Hunger meistens?', options: ['Er kommt plötzlich, will etwas Bestimmtes und lässt oft Reue zurück', 'Er kommt langsam und ist mit allem stillbar', 'Er tritt nur morgens auf'], answer: 0, explain: 'Emotionaler Hunger ist plötzlich, spezifisch (oft Süßes/Fettiges) und von schlechtem Gewissen begleitet – körperlicher kommt langsam und ist unspezifisch stillbar.' },
        { q: 'Wo liegt der wichtigste Hebel beim emotionalen Essen?', options: ['In der Pause zwischen Auslöser und Handlung', 'Im kompletten Verbot von Süßem', 'Im Auslassen von Mahlzeiten'], answer: 0, explain: 'Die kurze Pause – „echter Hunger oder ein Gefühl?" – durchbricht den Automatismus und öffnet Raum für eine andere Reaktion.' },
      ],
      sources: ['Übersichtsarbeiten zu emotionalem Essen und Stressbewältigung', 'Adam TC, Epel ES: Stress, Cortisol und Essverhalten', 'Literatur zu achtsamem Essen (Mindful Eating)'],
      exercise: 'Beobachte heute einen Ess-Impuls, der nicht aus dem Bauch kommt: Benenne das Gefühl dahinter und probiere eine nicht-essbare Reaktion aus.',
    },
    {
      id: 'halten-v5', title: 'Die Waage richtig lesen', theme: 'Ernährungswissen', minutes: 7,
      teaser: 'Warum tägliche Schwankungen nichts bedeuten – und wie du den echten Trend siehst.',
      pages: [
        { icon: '📉', title: 'Gewicht schwankt – jeden Tag', paras: ['Dein Körpergewicht kann von einem Tag auf den anderen um 1–2 kg schwanken, ohne dass sich am Fett irgendetwas geändert hat. Wasser, Darminhalt, Salz, Kohlenhydrate und Hormone bewegen die Zahl ständig.', 'Wer die Tageszahl ernst nimmt, fährt Achterbahn: gestern super, heute frustriert – obwohl sich real nichts geändert hat.'] },
        { icon: '💧', title: 'Was die Zahl bewegt', paras: ['Viel Salz oder Kohlenhydrate am Vortag binden Wasser (jedes Gramm gespeicherte Kohlenhydrate bindet ~3 g Wasser). Auch ein intensives Training, wenig Schlaf oder der weibliche Zyklus verschieben die Zahl deutlich.', 'All das ist Wasser, nicht Fett. Es kommt und geht – der Fettbestand ändert sich viel langsamer und gleichmäßiger.'] },
        { icon: '📊', title: 'Den Trend sehen, nicht den Punkt', paras: ['Wieg dich am besten immer gleich: morgens, nüchtern, nach dem Toilettengang. Und dann schau auf den Wochendurchschnitt, nicht auf den einzelnen Tag.', 'Beim Halten ist ein stabiler Korridor das Ziel – z. B. „mein Gewicht pendelt in einer 2-kg-Spanne". Erst wenn sich der Durchschnitt über 2–3 Wochen klar verschiebt, ist es ein echter Trend, auf den du reagierst.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Gewicht ist mehr als Fett', paras: ['Die Waage zeigt dein Gesamtgewicht – Muskeln, Wasser, Knochen, Organe, Darminhalt und Fett zusammen. Sie kann nicht unterscheiden, was sich geändert hat. Deshalb ist sie ein grobes Werkzeug, kein Präzisionsinstrument.', 'Gerade beim Halten sagen Umfang (Bauch, Taille), wie die Kleidung sitzt und die Körperzusammensetzung oft mehr aus als das reine Gewicht. Muskeln aufbauen und gleichzeitig Fett verlieren kann die Waage sogar gleich lassen.', 'Eine Körperanalyse im Studio trennt Muskel, Wasser und Fett – so siehst du, was sich wirklich verändert, statt nur die Gesamtzahl zu raten.'], cta: 'Körperanalyse im Studio' },
      ],
      quiz: [
        { q: 'Was bedeutet ein plötzliches Plus von 1,5 kg über Nacht meistens?', options: ['Wasser (Salz, Kohlenhydrate, Hormone) – kein Fett', '1,5 kg neues Fett', 'Dass die Diät gescheitert ist'], answer: 0, explain: 'So schnell lässt sich kein Fett auf- oder abbauen. Tagesschwankungen sind fast immer Wasser und Darminhalt.' },
        { q: 'Worauf solltest du beim Halten schauen?', options: ['Den Wochendurchschnitt / Trend statt der Tageszahl', 'Nur den niedrigsten Wert der Woche', 'Jede einzelne Messung ernst nehmen'], answer: 0, explain: 'Der gleitende Durchschnitt über Tage und Wochen zeigt den echten Trend – der einzelne Tag ist Rauschen.' },
      ],
      sources: ['Literatur zu täglichen Gewichtsschwankungen und Wasserhaushalt', 'Deutsche Gesellschaft für Ernährung (DGE): Körpergewicht und -zusammensetzung', 'Übersichtsarbeiten zu Selbst-Monitoring des Gewichts'],
      exercise: 'Wieg dich 7 Tage in Folge morgens unter gleichen Bedingungen und bilde den Durchschnitt – vergleiche ihn mit deinem Gefühl von einzelnen Tagen.',
    },
    {
      id: 'halten-v6', title: 'Motivation ohne Ziel-Druck', theme: 'Verhalten', minutes: 7,
      teaser: 'Wenn das Ziel erreicht ist, fällt der Antrieb weg. So bleibst du dran, wenn es „nur" ums Halten geht.',
      pages: [
        { icon: '🎯', title: 'Die Motivations-Lücke nach dem Ziel', paras: ['Beim Abnehmen gibt es ein klares Ziel, sichtbare Fortschritte und viel Lob. Beim Halten passiert – im besten Fall – nichts. Genau das macht es psychologisch schwer: Es gibt keinen Countdown mehr, keinen wöchentlichen Erfolg auf der Waage.', 'Halten ist kein Projekt mit Enddatum, sondern ein Zustand. Deshalb braucht es andere Motivations-Anker als eine Diät.'] },
        { icon: '🌱', title: 'Von Zielen zu Gewohnheiten', paras: ['Ziele haben ein Ende, Gewohnheiten laufen weiter. Wer sein Gewicht dauerhaft hält, tut das nicht durch ständige Willenskraft, sondern weil gute Routinen automatisch geworden sind: der übliche Einkauf, die übliche Bewegung, das übliche Frühstück.', 'Frag dich nicht „Wie erreiche ich mein Ziel?", sondern „Welche Person will ich sein?". Identität („Ich bin jemand, der sich bewegt und gut isst") trägt länger als jedes Zahlenziel.'] },
        { icon: '🧭', title: 'Neue Anker setzen', paras: ['Such dir Ziele jenseits der Waage: eine Kraftleistung steigern, einen Lauf schaffen, mehr Energie im Alltag, besser schlafen, dich in deiner Haut wohlfühlen. Das gibt Richtung, auch ohne abzunehmen.', 'Feier das Halten aktiv: Ein stabiles Gewicht über Monate ist ein echter Erfolg – die meisten nehmen nach einer Diät wieder zu. Dass du hältst, ist die eigentliche Meisterleistung.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Warum Halten die schwerere Kunst ist', paras: ['Nach einer Gewichtsabnahme sinkt der Kalorienverbrauch etwas ab, und der Körper reguliert die Hunger-Hormone eine Weile Richtung „mehr essen". Das macht Zunehmen biologisch leichter als Halten – wer hält, arbeitet also gegen einen realen Sog an.', 'Genau deshalb ist Halten kein Selbstläufer und kein „Nichtstun", sondern eine aktive Leistung, die Anerkennung verdient. Gewohnheiten nehmen dir dabei die tägliche Willenskraft ab.', 'Wie sich dein Verbrauch nach einer Abnahme entwickelt hat, kann eine Stoffwechselmessung im Studio zeigen – so weißt du, mit welchem Bedarf du realistisch planst.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Warum ist Motivation beim Halten oft schwieriger als beim Abnehmen?', options: ['Es gibt kein sichtbares Ziel und keine wöchentlichen Erfolge mehr', 'Weil Halten mehr Sport erfordert', 'Weil man beim Halten hungern muss'], answer: 0, explain: 'Halten ist ein Zustand ohne Countdown und ohne stetige Fortschritts-Belohnung – deshalb braucht es andere Anker als eine Diät.' },
        { q: 'Was trägt beim dauerhaften Halten am längsten?', options: ['Gewohnheiten und Identität statt einmaliger Ziele', 'Eine strengere Diät als vorher', 'Sich täglich unter Druck setzen'], answer: 0, explain: 'Automatisierte Routinen und ein Selbstbild („Ich bin jemand, der …") tragen länger als jedes Zahlenziel oder reine Willenskraft.' },
      ],
      sources: ['Clear J: Gewohnheiten und Identität (verhaltenswissenschaftliche Grundlagen)', 'Literatur zu adaptiver Thermogenese nach Gewichtsabnahme', 'National Weight Control Registry: Merkmale erfolgreicher Gewichtserhaltung'],
      exercise: 'Definiere ein Ziel jenseits der Waage für die nächsten 4 Wochen (z. B. eine Bewegung, ein Kraftwert, ein Schlaf-Fenster) und mach es zu deinem neuen Anker.',
    },
  ], gesundheit: [
    {
      id: 'gesundheit-v1', title: 'Blutdruck natürlich unterstützen', theme: 'Gesundheit', minutes: 8,
      teaser: 'Wie Ernährung und Lebensstil den Blutdruck begleiten – ergänzend zur ärztlichen Behandlung.',
      pages: [
        { icon: '🩺', title: 'Warum Blutdruck wichtig ist', paras: ['Der Blutdruck ist ein zentraler Gesundheitswert. Dauerhaft zu hohe Werte belasten Herz und Gefäße, oft ohne dass man es spürt – deshalb heißt Bluthochdruck auch „der stille Risikofaktor".', 'Wichtig vorweg: Blutdruck gehört gemessen und, wenn nötig, ärztlich behandelt. Ernährung und Lebensstil sind starke Begleiter, aber kein Ersatz für die ärztliche Betreuung.'] },
        { icon: '🥗', title: 'Das DASH-Prinzip', paras: ['Die gut untersuchte DASH-Ernährung setzt auf viel Gemüse, Obst, Vollkorn, Hülsenfrüchte, Nüsse und fettarme Milchprodukte, dazu wenig Salz, Zucker und rotes/verarbeitetes Fleisch.', 'Dieses Muster wird mit günstigeren Blutdruckwerten in Verbindung gebracht – ein alltagstauglicher, genussvoller Ansatz statt strenger Verbote.'] },
        { icon: '🧂', title: 'Salz, Kalium & Gewicht', paras: ['Weniger Salz (viel steckt versteckt in Brot, Wurst, Fertigem) kann bei salzempfindlichen Menschen den Blutdruck senken. Kaliumreiche Lebensmittel (Gemüse, Obst, Hülsenfrüchte) wirken oft günstig gegen.', 'Auch ein gesundes Gewicht, Bewegung, wenig Alkohol und Stressabbau zählen zu den wirksamsten nicht-medikamentösen Hebeln.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Gefäße & Stoffwechsel', paras: ['Blutdruck, Blutzucker, Blutfette und Gewicht hängen stoffwechselseitig zusammen – man fasst sie oft als „metabolisches" Gesamtbild zusammen. Verbesserst du einen Bereich, profitieren oft auch die anderen.', 'Eine vollwertige Ernährung mit viel Gemüse und Bewegung unterstützt gesunde Gefäße und einen entspannteren Stoffwechsel.', 'Eine Stoffwechselmessung im Studio ist eine Standortbestimmung fürs Gesamtbild – die Blutdruck-Kontrolle und Behandlung selbst gehört in ärztliche Hände.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was beschreibt das DASH-Prinzip?', options: ['Viel Gemüse/Obst/Vollkorn, wenig Salz und Verarbeitetes', 'Möglichst wenig essen', 'Nur Eiweiß, keine Kohlenhydrate'], answer: 0, explain: 'DASH setzt auf ein pflanzenbetontes, salzarmes Muster – mit günstigen Effekten auf den Blutdruck.' },
        { q: 'Welche Rolle hat die ärztliche Betreuung bei Bluthochdruck?', options: ['Zentral – Ernährung begleitet, ersetzt sie aber nicht', 'Überflüssig bei guter Ernährung', 'Nur bei akuten Beschwerden'], answer: 0, explain: 'Blutdruck gehört gemessen und ggf. behandelt; Ernährung und Lebensstil sind starke Begleiter, kein Ersatz.' },
      ],
      sources: ['Deutsche Hochdruckliga: Ernährung und Lebensstil bei Bluthochdruck', 'DASH-Diät: Studienlage (NIH/NHLBI)', 'WHO – Salzreduktion und Blutdruck'],
      exercise: 'Baue diese Woche das DASH-Muster ein: mehr Gemüse/Obst und Hülsenfrüchte, weniger Salz und Verarbeitetes – und lass bei Gelegenheit deinen Blutdruck messen.',
    },
    {
      id: 'gesundheit-v2', title: 'Entzündungsarm essen', theme: 'Ernährungswissen', minutes: 8,
      teaser: 'Was hinter „entzündungsarmer Ernährung" steckt – nüchtern und alltagstauglich erklärt.',
      pages: [
        { icon: '🔥', title: 'Stille Entzündungen kurz erklärt', paras: ['Neben akuten Entzündungen (Wunde, Infekt) gibt es „stille", niedriggradige Entzündungsprozesse. Sie werden mit ungünstigem Lebensstil und diversen Zivilisationskrankheiten in Verbindung gebracht.', 'Die Forschung ist im Fluss und vieles nicht abschließend geklärt – aber das grundlegende Ernährungsmuster überschneidet sich mit dem, was ohnehin als gesund gilt.'] },
        { icon: '🐟', title: 'Was als günstig gilt', paras: ['Als eher entzündungsarm gelten: viel Gemüse und Obst (Farbvielfalt, sekundäre Pflanzenstoffe), Omega-3-Quellen (fetter Fisch, Leinöl, Walnüsse), Olivenöl, Vollkorn und Hülsenfrüchte – das mediterrane Muster.', 'Kurz: bunt, pflanzenbetont, gute Fette. Nichts Exotisches, sondern solide Alltagskost.'] },
        { icon: '🍩', title: 'Was man eher begrenzt', paras: ['Als eher ungünstig gelten große Mengen an zugesetztem Zucker, stark Verarbeitetem, Transfetten und viel rotem/verarbeitetem Fleisch. Es geht um die Menge und Häufigkeit, nicht um striktes Verbot.', 'Wieder gilt das Gesamtbild: kein einzelnes „Anti-Entzündungs-Superfood", sondern das Muster über Wochen macht den Unterschied.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Entzündung & Stoffwechsel', paras: ['Übergewicht (besonders viel Bauchfett), Bewegungsmangel und einseitige Ernährung werden mit erhöhten Entzündungsmarkern in Verbindung gebracht. Gewichtsreduktion und Bewegung können sie oft senken.', 'Ballaststoffe, Omega-3 und Pflanzenstoffe unterstützen ein günstigeres Gesamtmilieu – ein Bindeglied zwischen Ernährung, Entzündung und Stoffwechsel.', 'Eine Standortbestimmung im Studio kann deinen Stoffwechsel einordnen; konkrete Entzündungswerte gehören in die ärztliche Diagnostik.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Welches Muster gilt als eher entzündungsarm?', options: ['Bunt, pflanzenbetont, gute Fette (mediterran)', 'Viel Zucker und Verarbeitetes', 'Möglichst einseitig essen'], answer: 0, explain: 'Das mediterrane Muster mit viel Gemüse, Omega-3 und Olivenöl gilt als günstig – solide Alltagskost.' },
        { q: 'Wie ist „entzündungsarm essen" einzuordnen?', options: ['Als Gesamtmuster über Wochen, kein einzelnes Superfood', 'Ein einzelnes Wunder-Lebensmittel reicht', 'Es ist reine Erfindung'], answer: 0, explain: 'Es geht um das Muster über Zeit – kein einzelnes Lebensmittel macht den Unterschied.' },
      ],
      sources: ['Übersichtsarbeiten zu Ernährung und niedriggradiger Entzündung', 'Deutsche Gesellschaft für Ernährung (DGE): Omega-3-Fettsäuren', 'Literatur zur mediterranen Ernährung'],
      exercise: 'Setze diese Woche zwei entzündungsarme Anker: eine Omega-3-Quelle (Fisch, Leinöl, Walnüsse) und täglich bunte pflanzliche Vielfalt.',
    },
    {
      id: 'gesundheit-v3', title: 'Knochen & Muskeln erhalten', theme: 'Gesundheit', minutes: 8,
      teaser: 'Kalzium, Vitamin D, Eiweiß und Bewegung – das Fundament für einen starken Körper.',
      pages: [
        { icon: '🦴', title: 'Warum Knochen Pflege brauchen', paras: ['Knochen sind lebendes Gewebe, das ständig auf- und abgebaut wird. Eine gute Versorgung und Bewegung helfen, die Knochendichte zu erhalten – wichtig, um im Alter stabil und beweglich zu bleiben.', 'Vorbeugen lohnt sich früh: Was du über die Jahre aufbaust und erhältst, zahlt sich später aus.'] },
        { icon: '🥛', title: 'Kalzium & Vitamin D', paras: ['Kalzium (Milchprodukte, grünes Gemüse wie Brokkoli und Grünkohl, kalziumreiches Mineralwasser, Hülsenfrüchte) ist der Baustein der Knochen. Vitamin D hilft, es aufzunehmen.', 'Vitamin D ist in dunklen Monaten oft knapp. Ob eine Ergänzung sinnvoll ist, klärst du am besten anhand eines ärztlich bestimmten Werts – nicht auf Verdacht.'] },
        { icon: '💪', title: 'Eiweiß & Belastung', paras: ['Ausreichend Eiweiß versorgt Muskeln und Knochen. Und: Belastung baut auf. Kraft- und stützende Bewegung geben Knochen und Muskeln den Reiz, stark zu bleiben.', 'Gerade mit zunehmendem Alter ist der Erhalt von Muskelmasse entscheidend – für Stoffwechsel, Kraft und Sturzprävention.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Muskeln als Stoffwechsel-Organ', paras: ['Muskulatur ist mehr als Kraft: Sie ist stoffwechselaktiv, hilft beim Blutzuckermanagement und stützt den Grundumsatz. Muskelerhalt ist damit ein Gesundheits- und Stoffwechsel-Thema zugleich.', 'Eiweiß plus Krafttraining ist die stärkste Kombination, um Muskeln (und indirekt Knochen) über die Jahre zu erhalten.', 'Eine Körperanalyse im Studio kann deine Muskelmasse einordnen; Knochendichte und Vitamin-D-Status gehören zur ärztlichen Vorsorge.'], cta: 'Körperanalyse im Studio' },
      ],
      quiz: [
        { q: 'Welche Kombination erhält Knochen und Muskeln?', options: ['Kalzium/Vitamin D, Eiweiß und Belastung/Bewegung', 'Nur Milch trinken', 'Möglichst wenig bewegen, um zu schonen'], answer: 0, explain: 'Nährstoffe plus Belastung: Kalzium und Vitamin D, genug Eiweiß und Kraft-/Bewegungsreize halten beides stark.' },
        { q: 'Wie klärst du deinen Vitamin-D-Status?', options: ['Anhand eines ärztlich bestimmten Werts', 'Einfach hochdosiert auf Verdacht ergänzen', 'Gar nicht'], answer: 0, explain: 'Vitamin D ist ein Sonderfall – ob und wie viel ergänzt werden sollte, entscheidet man am besten anhand eines gemessenen Werts.' },
      ],
      sources: ['Deutsche Gesellschaft für Ernährung (DGE): Kalzium, Vitamin D, Protein', 'Robert Koch-Institut: Vitamin-D-Versorgung', 'Literatur zu Krafttraining, Muskel- und Knochenerhalt'],
      exercise: 'Sorge diese Woche für Knochen-Basics: kalziumreiche Lebensmittel, genug Eiweiß und mindestens zwei stützende/kräftigende Bewegungseinheiten.',
    },
    {
      id: 'gesundheit-v4', title: 'Gesund essen mit kleinem Budget', theme: 'Alltagskompetenz', minutes: 7,
      teaser: 'Gesunde Ernährung muss nicht teuer sein – mit ein paar Strategien geht viel.',
      pages: [
        { icon: '💶', title: 'Der Mythos „gesund = teuer"', paras: ['Viele der gesündesten Lebensmittel sind günstig: Haferflocken, Hülsenfrüchte (getrocknet oder Dose), Eier, Tiefkühlgemüse, Kartoffeln, saisonales Gemüse, Kohl, Karotten. Teuer wird es vor allem durch Fertiges und Superfood-Marketing.', 'Mit etwas Planung isst man gesund oft günstiger als mit Fertigprodukten und Lieferdiensten.'] },
        { icon: '🫘', title: 'Günstige Nährstoff-Champions', paras: ['Hülsenfrüchte liefern viel Eiweiß und Ballaststoffe für wenig Geld. Tiefkühlgemüse ist genauso nährstoffreich wie frisches, oft günstiger und länger haltbar. Haferflocken sind ein sättigendes Vollkorn-Frühstück für Cent-Beträge.', 'Eier, Magerquark, Naturjoghurt und Vollkornnudeln/-reis runden eine preiswerte, nährstoffreiche Basis ab.'] },
        { icon: '📝', title: 'Clever einkaufen', paras: ['Saisonal und regional kaufen (billiger und frischer), auf Angebote achten, größere Mengen kochen und einfrieren, nicht hungrig einkaufen und mit Liste gegen Impulskäufe. Wasser statt teurer Getränke spart zusätzlich.', 'Vorkochen (Meal-Prep) senkt die Kosten weiter, weil weniger weggeworfen und seltener spontan teuer gegessen wird.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Nährstoffdichte pro Euro', paras: ['Statt „Kalorien pro Euro" lohnt der Blick auf Nährstoffe pro Euro: Hülsenfrüchte, Eier, Haferflocken und Gemüse liefern viel Sättigung, Eiweiß und Mikronährstoffe fürs Geld – gut für Gesundheit und Bilanz.', 'Stark Verarbeitetes liefert oft viele Kalorien, aber wenig Nährstoffe pro Euro – teuer für den Körper, auch wenn es billig wirkt.', 'Eine Standortbestimmung im Studio ordnet deinen Stoffwechsel ein – ein guter Anlass, die günstige, nährstoffreiche Küche zur Gewohnheit zu machen.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Welche Lebensmittel sind günstig UND nährstoffreich?', options: ['Hülsenfrüchte, Haferflocken, Eier, Tiefkühlgemüse', 'Nur teure Superfoods', 'Fertiggerichte und Lieferdienst'], answer: 0, explain: 'Diese Basics liefern viel Eiweiß, Ballaststoffe und Nährstoffe für wenig Geld – gesund geht auch preiswert.' },
        { q: 'Wie ist Tiefkühlgemüse einzuordnen?', options: ['Genauso nährstoffreich wie frisches, oft günstiger', 'Immer schlechter als frisches', 'Nährstofffrei'], answer: 0, explain: 'TK-Gemüse wird erntefrisch eingefroren und ist nährstoffreich, günstig und lange haltbar.' },
      ],
      sources: ['Verbraucherzentrale: Preiswert und gesund einkaufen', 'Deutsche Gesellschaft für Ernährung (DGE): Hülsenfrüchte, Tiefkühlgemüse', 'Literatur zu Nährstoffdichte und Lebensmittelkosten'],
      exercise: 'Plane diese Woche zwei günstige, nährstoffreiche Gerichte auf Basis von Hülsenfrüchten, Haferflocken oder TK-Gemüse – mit Einkaufsliste.',
    },
    {
      id: 'gesundheit-v5', title: 'Wechseljahre & Ernährung', theme: 'Lebensphasen', minutes: 8,
      teaser: 'Wie sich der Körper in dieser Phase verändert – und wie Ernährung sanft unterstützt.',
      pages: [
        { icon: '🔄', title: 'Was sich verändert', paras: ['In den Wechseljahren verschiebt sich der Hormonhaushalt. Das kann Gewicht, Fettverteilung (mehr am Bauch), Knochendichte und Wohlbefinden beeinflussen. Das ist ein natürlicher Übergang, keine Krankheit.', 'Jeder Mensch erlebt diese Phase anders. Bei starken Beschwerden ist die ärztliche/gynäkologische Begleitung der richtige Weg – Ernährung ist eine unterstützende Ergänzung.'] },
        { icon: '💪', title: 'Eiweiß & Muskeln in den Fokus', paras: ['Mit den hormonellen Veränderungen (und mit dem Alter generell) wird der Erhalt von Muskelmasse wichtiger. Ausreichend Eiweiß und Krafttraining wirken dem altersbedingten Muskelabbau entgegen.', 'Mehr Muskeln stützen Stoffwechsel, Kraft und Knochen – ein zentraler Hebel in dieser Lebensphase.'] },
        { icon: '🦴', title: 'Knochen besonders schützen', paras: ['Die Knochendichte kann in dieser Phase stärker abnehmen. Deshalb rücken Kalzium, Vitamin D, Eiweiß und belastende Bewegung noch mehr in den Fokus (siehe auch das Knochen-Modul).', 'Wenig Alkohol, nicht rauchen und ein aktiver Alltag unterstützen die Knochengesundheit zusätzlich.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Stoffwechsel im Übergang', paras: ['Der Energiebedarf kann leicht sinken und sich die Fettverteilung ändern – das erklärt, warum viele in dieser Phase leichter zunehmen. Es ist keine „Schuld", sondern Biologie, auf die man reagieren kann.', 'Etwas mehr Eiweiß, Krafttraining und Aufmerksamkeit für die Portionsgrößen helfen, das Gewicht stabil zu halten, ohne zu hungern.', 'Eine Stoffwechselmessung im Studio kann deinen aktuellen Bedarf einordnen; hormonelle Fragen und Beschwerden gehören in die ärztliche Hand.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was rückt in den Wechseljahren besonders in den Fokus?', options: ['Eiweiß, Krafttraining und Knochenschutz', 'Möglichst wenig essen', 'Nur noch Kohlenhydrate'], answer: 0, explain: 'Muskel- und Knochenerhalt (Eiweiß, Kraft, Kalzium/Vitamin D) sind in dieser Phase besonders wichtig.' },
        { q: 'Wie ordnet man Ernährung bei starken Beschwerden ein?', options: ['Als Ergänzung – ärztliche/gynäkologische Begleitung ist der richtige Weg', 'Als vollständigen Ersatz für Ärzte', 'Als irrelevant'], answer: 0, explain: 'Bei starken Beschwerden ist die ärztliche Begleitung zentral; Ernährung unterstützt ergänzend.' },
      ],
      sources: ['Deutsche Gesellschaft für Ernährung (DGE): Ernährung in verschiedenen Lebensphasen', 'Berufsverband der Frauenärzte: Wechseljahre und Lebensstil', 'Literatur zu Muskel-/Knochenerhalt und Proteinbedarf im Alter'],
      exercise: 'Setze diese Woche zwei Schwerpunkte: mehr Eiweiß über den Tag und zwei kräftigende Einheiten – bei Beschwerden sprich sie beim nächsten Arzttermin an.',
    },
    {
      id: 'gesundheit-v6', title: 'Schlaf, Stress & Ernährung', theme: 'Ganzheitlich', minutes: 8,
      teaser: 'Warum guter Schlaf und weniger Stress zu den stärksten Gesundheits-Hebeln gehören.',
      pages: [
        { icon: '😴', title: 'Schlaf ist Gesundheits-Basis', paras: ['Schlaf ist keine „verlorene Zeit", sondern aktive Regeneration. Zu wenig oder schlechter Schlaf wird mit mehr Appetit (besonders auf Süßes), ungünstigem Stoffwechsel und schlechterer Regeneration in Verbindung gebracht.', 'Ausreichender, regelmäßiger Schlaf ist damit einer der stärksten – und am meisten unterschätzten – Hebel für Gesundheit und Gewicht.'] },
        { icon: '🍵', title: 'Ernährung fürs Ein- und Durchschlafen', paras: ['Späte, sehr schwere Mahlzeiten, viel Koffein am Nachmittag/Abend und Alkohol können den Schlaf stören. Alkohol hilft vielleicht beim Einschlafen, verschlechtert aber die Schlafqualität.', 'Hilfreich sind ein einigermaßen regelmäßiger Essrhythmus, Koffein-Stopp am Nachmittag und ein nicht zu spätes, nicht zu schweres Abendessen.'] },
        { icon: '🧘', title: 'Stress & Essverhalten', paras: ['Chronischer Stress steigert über Cortisol den Appetit – oft auf Süßes und Fettiges – und begünstigt emotionales Essen. Stressabbau wirkt daher indirekt auch auf die Ernährung.', 'Kleine Werkzeuge: Bewegung, kurze Pausen, Atemübungen, soziale Kontakte, feste Offline-Zeiten. Nicht perfekt, aber regelmäßig – das zählt.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Die Achse Schlaf–Stress–Stoffwechsel', paras: ['Schlaf, Stress, Hunger-Hormone und Stoffwechsel sind eng verzahnt: Schlafmangel und Dauerstress verschieben Ghrelin, Leptin und Cortisol Richtung „mehr Appetit" – ein biologischer Effekt, kein Willensmangel.', 'Wer Schlaf und Stress verbessert, erleichtert sich damit oft auch die Ernährung – manchmal wirksamer als jede zusätzliche Diät-Regel.', 'Wenn Schlaf, Stress und Essverhalten zusammenspielen, lohnt der ganzheitliche Blick – genau da setzt das Studio-Coaching an, ergänzend zur ärztlichen Betreuung.'], cta: 'Stoffwechsel-Coaching anfragen' },
      ],
      quiz: [
        { q: 'Warum ist Schlaf ein starker Gesundheits-Hebel?', options: ['Schlafmangel steigert Appetit und wirkt ungünstig auf den Stoffwechsel', 'Schlaf ist verlorene Zeit', 'Schlaf hat mit Ernährung nichts zu tun'], answer: 0, explain: 'Zu wenig Schlaf verschiebt die Hunger-Hormone Richtung mehr Appetit und wirkt ungünstig auf den Stoffwechsel.' },
        { q: 'Wie wirkt chronischer Stress aufs Essverhalten?', options: ['Er steigert über Cortisol oft den Appetit auf Süßes/Fettiges', 'Er macht immer satt', 'Er hat keinen Einfluss'], answer: 0, explain: 'Dauerstress erhöht via Cortisol den Appetit und begünstigt emotionales Essen – Stressabbau wirkt indirekt auf die Ernährung.' },
      ],
      sources: ['Übersichtsarbeiten zu Schlaf, Appetitregulation und Stoffwechsel', 'Spiegel K et al.: Schlafmangel und Hunger-Hormone', 'Deutsche Gesellschaft für Schlafforschung: Schlafhygiene'],
      exercise: 'Wähle diese Woche einen Schlaf-Hebel (fester Zeitpunkt, Koffein-Stopp am Nachmittag oder leichteres Abendessen) und einen Stress-Hebel und setze beide bewusst um.',
    },
  ], longevity: [
    {
      id: 'longevity-v1', title: 'Antioxidantien & freie Radikale', theme: 'Ernährungswissen', minutes: 8,
      teaser: 'Was hinter „Antioxidantien" steckt – nüchtern erklärt, ohne Wunderversprechen.',
      pages: [
        { icon: '⚗️', title: 'Freie Radikale kurz erklärt', paras: ['Beim normalen Stoffwechsel entstehen reaktive Moleküle, die „freien Radikale". In Maßen sind sie normal und sogar nützlich (z. B. für das Immunsystem); ein dauerhaftes Übermaß („oxidativer Stress") wird mit Zellalterung in Verbindung gebracht.', 'Antioxidantien sind Stoffe, die diese Moleküle abfangen können. Der Körper hat eigene Systeme dafür, und die Nahrung liefert zusätzliche.'] },
        { icon: '🫐', title: 'Aus dem Essen, nicht aus der Dose', paras: ['Buntes Gemüse, Obst (besonders Beeren), Kräuter, Nüsse, Hülsenfrüchte, dazu Kaffee und Tee liefern ein breites Spektrum an Antioxidantien und Pflanzenstoffen – im natürlichen Verbund.', 'Genau dieser Verbund scheint zu wirken. Hochdosierte Antioxidantien-Präparate haben in Studien dagegen oft keinen Nutzen gezeigt – und in einzelnen Fällen sogar geschadet.'] },
        { icon: '🌈', title: 'Vielfalt schlägt Einzelstoff', paras: ['Statt einem „Super-Antioxidans" nachzujagen, ist Farbvielfalt der beste Weg: verschiedene Farben stehen für verschiedene Pflanzenstoffe. Wer bunt isst, deckt breit ab.', 'Das ist die gute Nachricht: Du brauchst keine teuren Pillen, sondern einen bunten Teller – lecker und wirksam zugleich.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Balance statt Krieg gegen Radikale', paras: ['Der Körper braucht ein Gleichgewicht: nicht null freie Radikale, sondern eine gesunde Balance zwischen ihnen und den Schutzsystemen. Genau deshalb ist „mehr Antioxidantien um jeden Preis" kein sinnvolles Ziel.', 'Ein aktiver Lebensstil und eine pflanzenreiche Ernährung unterstützen diese Balance auf natürliche Weise.', 'Wie dein Stoffwechsel arbeitet, kann eine Standortbestimmung im Studio einordnen – der bunte Teller ist der Teil, den du im Alltag lebst.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Woher solltest du Antioxidantien am besten beziehen?', options: ['Aus buntem Gemüse, Obst, Kräutern – dem natürlichen Verbund', 'Aus hochdosierten Präparaten', 'Aus einem einzelnen Superfood'], answer: 0, explain: 'Der natürliche Verbund aus Lebensmitteln wirkt; hochdosierte Präparate zeigten oft keinen Nutzen oder Schaden.' },
        { q: 'Warum ist „möglichst viele Antioxidantien" kein gutes Ziel?', options: ['Der Körper braucht eine Balance, nicht null freie Radikale', 'Weil Antioxidantien immer schaden', 'Weil Gemüse keine enthält'], answer: 0, explain: 'Freie Radikale haben auch Funktionen – es geht um Balance, nicht um maximale Ausschaltung.' },
      ],
      sources: ['Übersichtsarbeiten zu oxidativem Stress und Antioxidantien', 'Studien zu Antioxidantien-Supplementen (u. a. fehlender/negativer Nutzen)', 'Deutsche Gesellschaft für Ernährung (DGE): Sekundäre Pflanzenstoffe'],
      exercise: 'Bring diese Woche jeden Tag mindestens vier verschiedene Farben an Gemüse/Obst auf den Teller – Vielfalt statt Pillen.',
    },
    {
      id: 'longevity-v2', title: 'Was wir von den Blue Zones lernen', theme: 'Longevity', minutes: 8,
      teaser: 'Regionen mit besonders vielen gesunden Hochbetagten – und ihre gemeinsamen Muster.',
      pages: [
        { icon: '🗺️', title: 'Was Blue Zones sind', paras: ['Als „Blue Zones" werden Regionen bezeichnet, in denen auffällig viele Menschen sehr alt und dabei gesund werden (z. B. Sardinien, Okinawa, Ikaria). Forschende haben nach Gemeinsamkeiten gesucht.', 'Wichtig zur Einordnung: Das sind Beobachtungen, keine strengen Experimente. Genetik, Umwelt und Kultur spielen mit. Trotzdem sind die wiederkehrenden Muster lehrreich.'] },
        { icon: '🌱', title: 'Die Ernährungs-Muster', paras: ['Überwiegend pflanzlich: viel Gemüse, Hülsenfrüchte (ein echter roter Faden), Vollkorn und Nüsse. Fleisch eher selten und in kleinen Mengen, Fisch je nach Region. Wenig stark Verarbeitetes und Zucker.', 'Gegessen wird oft bis „angenehm satt", nicht bis übervoll – in Okinawa als „Hara hachi bu" (iss, bis du zu 80 % satt bist) bekannt.'] },
        { icon: '🤝', title: 'Mehr als Essen', paras: ['Auffällig ist: Es ist nie nur die Ernährung. Viel natürliche Alltagsbewegung, enge soziale Bindungen, ein Sinn im Leben und geringer chronischer Stress ziehen sich durch alle Regionen.', 'Für dich heißt das: Longevity ist ein Lebensstil-Paket. Der Teller ist ein wichtiger Teil, aber Bewegung, Menschen und Sinn gehören dazu.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Warum das Paket wirkt', paras: ['Pflanzenbetont essen, sich viel bewegen und wenig chronischen Stress haben – diese Kombination wirkt günstig auf Blutzucker, Blutfette, Blutdruck und Entzündung, also auf zentrale Stoffwechsel-Größen.', 'Kein einzelnes Element erklärt die Langlebigkeit; es ist das Zusammenspiel über ein ganzes Leben.', 'Eine Standortbestimmung im Studio ordnet deinen Stoffwechsel ein – die Blue-Zone-Prinzipien sind der Alltagsrahmen, den du selbst gestaltest.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was ist ein roter Faden der Blue-Zone-Ernährung?', options: ['Überwiegend pflanzlich, viele Hülsenfrüchte, wenig Verarbeitetes', 'Viel Fleisch und Fastfood', 'Strenge Kalorienzählung'], answer: 0, explain: 'Pflanzenbetont mit Hülsenfrüchten als gemeinsamer Nenner – plus „bis angenehm satt" essen.' },
        { q: 'Warum ist Longevity mehr als Ernährung?', options: ['Bewegung, soziale Bindung und Sinn gehören zum Paket', 'Weil Ernährung egal ist', 'Weil nur Gene zählen'], answer: 0, explain: 'In allen Regionen wirken Ernährung, Alltagsbewegung, Gemeinschaft und Sinn zusammen.' },
      ],
      sources: ['Buettner D: Blue-Zones-Forschung', 'Studien zu Ernährungsmustern langlebiger Regionen', 'WHO – Healthy ageing'],
      exercise: 'Übernimm diese Woche zwei Blue-Zone-Prinzipien: mehr Hülsenfrüchte auf den Teller und bewusst „bis angenehm satt" statt übervoll essen.',
    },
    {
      id: 'longevity-v3', title: 'Trinken & Nieren im Alter', theme: 'Gesundheit', minutes: 7,
      teaser: 'Ausreichend trinken wird mit den Jahren wichtiger – und oft vergessen.',
      pages: [
        { icon: '💧', title: 'Das Durstgefühl lässt nach', paras: ['Mit dem Alter nimmt das Durstempfinden oft ab – man merkt zu wenig, dass man trinken sollte. Gleichzeitig können Hitze, Medikamente oder Krankheit den Flüssigkeitsbedarf erhöhen.', 'Deshalb ist bewusstes Trinken im Alter wichtiger als in jungen Jahren. Ausreichend Flüssigkeit unterstützt Kreislauf, Konzentration und Verdauung.'] },
        { icon: '🚰', title: 'Wie viel und was', paras: ['Als grober Richtwert gelten für gesunde Erwachsene rund 1,5 Liter aus Getränken pro Tag, mehr bei Hitze oder Bewegung. Wasser und ungesüßte Getränke (Tee) sind die beste Wahl.', 'Wichtig: Bei bestimmten Erkrankungen (z. B. Herz oder Nieren) kann die empfohlene Trinkmenge abweichen – dann gilt immer die ärztliche Vorgabe, nicht die Faustregel.'] },
        { icon: '⏰', title: 'Trinken in den Alltag bauen', paras: ['Feste Anker helfen: ein Glas zu jeder Mahlzeit, eine Flasche in Sichtweite, morgens direkt ein Glas Wasser. Sichtbarkeit schlägt Erinnerung.', 'Ein einfacher Selbstcheck ist die Urinfarbe: hell heißt meist gut versorgt, dunkel ein Zeichen, mehr zu trinken (sofern keine ärztliche Einschränkung besteht).'] },
        { kind: 'metabolism', icon: '🧬', title: 'Wasser & Körperfunktionen', paras: ['Wasser ist an fast allen Stoffwechselvorgängen beteiligt – vom Nährstofftransport bis zur Temperaturregulation. Schon leichter Flüssigkeitsmangel kann Konzentration und Wohlbefinden mindern.', 'Ausreichend zu trinken ist damit ein einfacher, oft unterschätzter Baustein für Vitalität im Alter.', 'Eine Standortbestimmung im Studio ordnet deinen Stoffwechsel ein; bei Nieren- oder Herzfragen ist die ärztliche Vorgabe maßgeblich.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Warum ist Trinken im Alter besonders wichtig?', options: ['Das Durstgefühl lässt nach – man trinkt leicht zu wenig', 'Ältere brauchen kein Wasser', 'Durst wird im Alter stärker'], answer: 0, explain: 'Das nachlassende Durstempfinden macht bewusstes Trinken im Alter wichtiger.' },
        { q: 'Was gilt bei Herz- oder Nierenerkrankungen?', options: ['Die ärztliche Trinkmengen-Vorgabe, nicht die Faustregel', 'Immer möglichst viel trinken', 'Die Faustregel gilt für alle gleich'], answer: 0, explain: 'Bei bestimmten Erkrankungen kann die empfohlene Menge abweichen – die ärztliche Vorgabe hat Vorrang.' },
      ],
      sources: ['Deutsche Gesellschaft für Ernährung (DGE): Wasser/Flüssigkeitszufuhr', 'Literatur zu Durstempfinden und Hydration im Alter', 'Empfehlungen zur Flüssigkeitszufuhr bei Erkrankungen (ärztlich)'],
      exercise: 'Setze diese Woche zwei Trink-Anker (Glas zu jeder Mahlzeit, Flasche in Sichtweite) – sofern ärztlich keine Einschränkung besteht.',
    },
    {
      id: 'longevity-v4', title: 'Sarkopenie verstehen & vorbeugen', theme: 'Longevity', minutes: 8,
      teaser: 'Der schleichende Muskelabbau – warum er zählt und wie du ihn ausbremst.',
      pages: [
        { icon: '📉', title: 'Was Sarkopenie ist', paras: ['Sarkopenie ist der altersbedingte Verlust von Muskelmasse und -kraft. Er verläuft schleichend und wird lange nicht bemerkt – bis Alltagsdinge (Treppen, Einkäufe tragen, Aufstehen) schwerer fallen.', 'Er ist einer der wichtigsten Faktoren dafür, ob man im Alter selbstständig und sicher bleibt. Und: Er ist kein unabwendbares Schicksal.'] },
        { icon: '🍗', title: 'Eiweiß als Baustein', paras: ['Muskeln brauchen Baumaterial. Im Alter ist der Eiweißbedarf pro Kilogramm eher höher, weil der Körper Protein weniger effizient nutzt. Fachgesellschaften empfehlen Älteren daher oft mehr als die Standard-0,8 g/kg.', 'Praktisch: gute Eiweißquellen über den Tag verteilen (Eier, Quark, Fisch, Hülsenfrüchte, Fleisch), statt alles abends – das nutzt den Aufbaureiz besser.'] },
        { icon: '🏋️', title: 'Krafttraining ist das A und O', paras: ['Ohne Reiz kein Muskel: Krafttraining (auch mit dem eigenen Körpergewicht oder Bändern) ist der wirksamste Hebel gegen Sarkopenie. Selbst im hohen Alter reagieren Muskeln nachweislich noch auf Training.', 'Schon zwei Einheiten pro Woche, die die Muskeln fordern, machen einen großen Unterschied für Kraft und Selbstständigkeit.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Muskel schützt den ganzen Körper', paras: ['Muskulatur ist nicht nur Kraft, sondern ein stoffwechselaktives Organ: Sie hilft beim Blutzuckermanagement und dient als Eiweiß-Reserve in Krankheitsphasen. Muskelerhalt schützt damit weit über die Bewegung hinaus.', 'Eiweiß plus Krafttraining ist die stärkste Kombination gegen den altersbedingten Abbau – ein Kern-Baustein für gesundes Altern.', 'Eine Körperanalyse im Studio kann deine Muskelmasse einordnen und Fortschritte über die Zeit sichtbar machen.'], cta: 'Körperanalyse im Studio' },
      ],
      quiz: [
        { q: 'Was ist der wirksamste Hebel gegen Sarkopenie?', options: ['Krafttraining plus ausreichend Eiweiß', 'Schonung und wenig Bewegung', 'Nur Ausdauersport'], answer: 0, explain: 'Der Trainingsreiz plus Baumaterial (Eiweiß) hält Muskeln stark – selbst im hohen Alter.' },
        { q: 'Wie ist der Eiweißbedarf im Alter?', options: ['Pro Kilogramm eher höher als bei Jüngeren', 'Deutlich niedriger', 'Spielt keine Rolle'], answer: 0, explain: 'Weil der Körper Protein weniger effizient nutzt, empfehlen Fachgesellschaften Älteren oft mehr Eiweiß.' },
      ],
      sources: ['PROT-AGE Study Group: Proteinempfehlungen für Ältere', 'Literatur zu Sarkopenie, Krafttraining und Muskelerhalt', 'Deutsche Gesellschaft für Ernährung (DGE): Protein im Alter'],
      exercise: 'Plane diese Woche zwei kräftigende Einheiten und bring zu jeder Hauptmahlzeit eine Eiweißquelle unter.',
    },
    {
      id: 'longevity-v5', title: 'Zucker, AGEs & Zellalterung', theme: 'Ernährungswissen', minutes: 8,
      teaser: 'Wie viel Zucker mit Alterungsprozessen zu tun hat – sachlich eingeordnet.',
      pages: [
        { icon: '🍬', title: 'Zucker über das Nötige hinaus', paras: ['Zucker ist nicht per se „Gift" – aber dauerhaft sehr viel zugesetzter und flüssiger Zucker wird mit ungünstigen Stoffwechselprozessen und beschleunigter Zellalterung in Verbindung gebracht.', 'Es geht wie immer um Menge und Muster: Obst mit Ballaststoffen ist kein Problem, die tägliche Limo-und-Süßes-Routine dagegen ein relevanter Hebel.'] },
        { icon: '🔗', title: 'Was AGEs sind', paras: ['AGEs (advanced glycation end-products) entstehen, wenn Zucker sich an Eiweiße oder Fette anlagert – im Körper (begünstigt durch hohen Blutzucker) und beim starken Erhitzen von Lebensmitteln (Frittieren, Grillen bei hoher Hitze).', 'Ein Übermaß an AGEs wird mit Alterungs- und Entzündungsprozessen in Verbindung gebracht. Die Forschung ist noch nicht abschließend, aber die Richtung ist konsistent mit „weniger Zucker, schonender garen".'] },
        { icon: '🍳', title: 'Praktische Hebel', paras: ['Weniger zugesetzten und flüssigen Zucker, stabiler Blutzucker durch Ballaststoffe und Eiweiß, und öfter schonende Garmethoden (dünsten, dämpfen, kochen) statt scharf Frittiertes.', 'Nichts davon muss dogmatisch sein. Es sind sanfte Verschiebungen im Alltag, die sich über Jahre summieren.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Blutzucker ruhig halten', paras: ['Ein gleichmäßiger Blutzucker (durch weniger schnellen Zucker, mehr Ballaststoffe und Bewegung) reduziert die Bildung von AGEs im Körper und entlastet den Stoffwechsel. Das ist derselbe Hebel, der auch beim Abnehmen und der Herzgesundheit hilft.', 'Ein ruhiger Zuckerstoffwechsel gehört damit zu den robustesten Longevity-Bausteinen.', 'Wie dein Zuckerstoffwechsel arbeitet, kann eine Standortbestimmung im Studio einordnen – ergänzend zu ärztlichen Blutwerten.'], cta: 'Stoffwechsel messen lassen' },
      ],
      quiz: [
        { q: 'Was begünstigt die Bildung von AGEs?', options: ['Hoher Blutzucker und starkes Erhitzen (Frittieren) von Speisen', 'Dünsten und Dämpfen', 'Ballaststoffe'], answer: 0, explain: 'AGEs entstehen bei hohem Blutzucker und bei stark erhitzten Speisen – schonendes Garen und ruhiger Blutzucker helfen.' },
        { q: 'Welcher Hebel wirkt gegen zuckerbedingte Alterungsprozesse?', options: ['Weniger schneller Zucker, mehr Ballaststoffe, Bewegung', 'Mehr Limo', 'Zucker ist völlig egal'], answer: 0, explain: 'Ein ruhiger Blutzucker durch Ballaststoffe, weniger schnellen Zucker und Bewegung entlastet den Stoffwechsel.' },
      ],
      sources: ['Übersichtsarbeiten zu AGEs, Glykierung und Alterung', 'WHO – Guideline: Sugars intake (2015)', 'Literatur zu Blutzucker, Ballaststoffen und Stoffwechselgesundheit'],
      exercise: 'Reduziere diese Woche eine feste Zuckerquelle (z. B. Süßgetränk) und ersetze einmal Frittiertes durch Gedünstetes oder Gekochtes.',
    },
    {
      id: 'longevity-v6', title: 'Genuss, Rhythmus & mentale Gesundheit', theme: 'Ganzheitlich', minutes: 7,
      teaser: 'Lange gut leben heißt auch: entspannt, verbunden und mit Freude essen.',
      pages: [
        { icon: '😌', title: 'Longevity ist kein Verzichtsprojekt', paras: ['Ein langes, gesundes Leben entsteht nicht aus Angst und Verboten, sondern aus einem stabilen, freudvollen Lebensstil. Chronischer Stress und ständiger Diät-Druck können selbst zum Gesundheitsrisiko werden.', 'Genuss, Gelassenheit und ein guter Rhythmus sind keine Gegenspieler der Gesundheit – sie sind Teil davon.'] },
        { icon: '🧘', title: 'Mentale Gesundheit zählt mit', paras: ['Psychisches Wohlbefinden, Sinn und soziale Verbundenheit werden mit besserer Gesundheit und Langlebigkeit in Verbindung gebracht. Der Kopf isst und altert mit.', 'Kleine Anker: Dankbarkeit, Bewegung an der frischen Luft, Zeit mit Menschen, Dinge, die dir Sinn geben. Bei anhaltender Belastung ist es ein Zeichen von Stärke, sich Unterstützung zu holen.'] },
        { icon: '🔁', title: 'Rhythmus trägt', paras: ['Ein einigermaßen regelmäßiger Tag – Essenszeiten, Bewegung, Schlaf – gibt dem Körper Halt. Nicht als starres Korsett, sondern als verlässlicher Rahmen, in dem gute Gewohnheiten fast von allein laufen.', 'Beständigkeit statt Perfektion: Das ist der rote Faden dieses ganzen Programms.'] },
        { kind: 'metabolism', icon: '🧬', title: 'Der Mensch als Ganzes', paras: ['Ernährung, Bewegung, Schlaf, Stress und soziale Bindung wirken zusammen auf Hormone, Stoffwechsel und Wohlbefinden. Longevity ist die Summe – kein Einzelfaktor.', 'Wer sich um das Ganze kümmert und dabei die Freude nicht verliert, hat die besten Chancen auf viele gute Jahre.', 'Ein ganzheitlicher Blick auf Schlaf, Stress und Stoffwechsel ist der Kern des Studio-Coachings – ergänzend zur ärztlichen Betreuung.'], cta: 'Stoffwechsel-Coaching anfragen' },
      ],
      quiz: [
        { q: 'Wie passt Genuss zu Longevity?', options: ['Er gehört dazu – ständiger Diät-Druck kann selbst schaden', 'Genuss ist verboten', 'Nur Verzicht zählt'], answer: 0, explain: 'Ein freudvoller, entspannter Lebensstil ist Teil der Gesundheit; Dauerstress und Verbotsdruck wirken gegenteilig.' },
        { q: 'Was trägt langfristig am meisten?', options: ['Beständigkeit und ein guter Rhythmus statt Perfektion', 'Kurzfristige perfekte Phasen', 'Möglichst viele Regeln'], answer: 0, explain: 'Ein verlässlicher Rhythmus, in dem gute Gewohnheiten von allein laufen, trägt über Jahre – der rote Faden des Programms.' },
      ],
      sources: ['Holt-Lunstad J et al.: Soziale Bindung und Langlebigkeit', 'WHO – Mentale Gesundheit und Wohlbefinden', 'Literatur zu Stress, Rhythmus und gesundem Altern'],
      exercise: 'Wähle diese Woche einen Genuss- und einen Rhythmus-Anker (z. B. eine bewusste Genussmahlzeit und feste Schlafenszeiten) und lebe beide ohne schlechtes Gewissen.',
    },
  ],
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
// Lektionsinhalt normalisieren (defensiv, obwohl eigener Content): Seiten + Quiz.
function normPages(pages) {
  return (Array.isArray(pages) ? pages : []).map(function (p) {
    p = p || {};
    return {
      kind: p.kind === 'metabolism' ? 'metabolism' : 'content',
      icon: String(p.icon || '').slice(0, 8),
      title: String(p.title || '').slice(0, 120),
      paras: (Array.isArray(p.paras) ? p.paras : []).map(function (x) { return String(x == null ? '' : x).slice(0, 900); }).filter(Boolean).slice(0, 12),
      note: p.note ? String(p.note).slice(0, 300) : '',
      cta: p.cta ? String(p.cta).slice(0, 60) : '',
    };
  }).filter(function (p) { return p.title || p.paras.length; }).slice(0, 20);
}
function normQuiz(quiz) {
  return (Array.isArray(quiz) ? quiz : []).map(function (q) {
    q = q || {};
    const opts = (Array.isArray(q.options) ? q.options : []).map(function (o) { return String(o == null ? '' : o).slice(0, 160); }).filter(Boolean).slice(0, 5);
    return { q: String(q.q || '').slice(0, 300), options: opts, answer: clampInt(q.answer, 0, Math.max(0, opts.length - 1), 0), explain: String(q.explain || '').slice(0, 400) };
  }).filter(function (q) { return q.q && q.options.length >= 2; }).slice(0, 5);
}
function normSources(sources) {
  return (Array.isArray(sources) ? sources : []).map(function (s) { return String(s == null ? '' : s).slice(0, 200); }).filter(Boolean).slice(0, 6);
}
// Bildungs-Disclaimer (unter jeder Lektion): keine medizinische/individuelle Beratung.
const LESSON_DISCLAIMER = 'Diese Inhalte dienen der Ernährungsbildung nach anerkannten Empfehlungen und ersetzen keine medizinische oder individuelle Beratung. Bei Erkrankungen, Schwangerschaft oder Beschwerden bitte ärztlich abklären.';
function fullLesson(track, week) {
  const arr = lessonsFor(track);
  const l = arr[clampInt(week, 1, arr.length, 1) - 1];
  return { week: l.week, title: l.title, theme: l.theme, teaser: l.teaser, minutes: l.minutes, season: l.season || 'Kern', pages: normPages(l.pages), quiz: normQuiz(l.quiz), exercise: l.exercise, habits: l.habits, sources: normSources(l.sources), disclaimer: LESSON_DISCLAIMER };
}
function habitsForWeek(track, week) {
  const arr = lessonsFor(track);
  const l = arr[clampInt(week, 1, arr.length, 1) - 1];
  return l.habits.map(function (h) { return { id: h.id, text: h.text, cat: h.cat, week: l.week, source: 'curriculum' }; });
}

// ── Vertiefung (evergreen, immer offen) ──
function vertiefungFor(track) { return (track && VERTIEFUNG[track]) ? VERTIEFUNG[track] : []; }
function findVert(track, id) { const arr = vertiefungFor(track); id = String(id == null ? '' : id); for (let i = 0; i < arr.length; i++) { if (arr[i].id === id) return arr[i]; } return null; }
// Kurz-Liste fürs Frontend (ohne Inhalt) – Reihenfolge wie definiert.
function vertiefungList(track) { return vertiefungFor(track).map(function (m) { return { id: m.id, title: m.title, teaser: m.teaser, minutes: m.minutes, theme: m.theme }; }); }
// Voller Modul-Inhalt (defensiv normalisiert, gleiche Bausteine wie fullLesson).
function fullVertiefung(track, id) {
  const m = findVert(track, id);
  if (!m) return null;
  return { id: m.id, title: m.title, theme: m.theme, teaser: m.teaser, minutes: m.minutes, vert: true, pages: normPages(m.pages), quiz: normQuiz(m.quiz), exercise: m.exercise, habits: [], sources: normSources(m.sources), disclaimer: LESSON_DISCLAIMER };
}
// Vertiefungs-Modul abschließen (getrennt von den Wochen-Lektionen im State).
async function completeVertiefung(id, vid) {
  const st = await getState(id);
  if (!st || !st.enrolled) return { ok: false, error: 'not_enrolled' };
  const m = findVert(trackOf(st), vid);
  if (!m) return { ok: false, error: 'not_found' };
  st.vertiefung = st.vertiefung || {};
  st.vertiefung[m.id] = st.vertiefung[m.id] || { completedAt: null };
  if (!st.vertiefung[m.id].completedAt) st.vertiefung[m.id].completedAt = Date.now();
  await saveState(id, st);
  return { ok: true, state: st };
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
    return { enrolled: false, track: null, totalWeeks: weeksFor('abnehmen'), week: 0, unlockedWeek: 0, startDate: null, prefs: null, currentLesson: null, lessons: [], vertiefung: [] };
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
  // Vertiefung: immer offen (Premium-Bonus), Abschluss aus dem State.
  const vdone = st.vertiefung || {};
  const vertiefung = vertiefungFor(track).map(function (m) { const v = vdone[m.id]; return { id: m.id, title: m.title, teaser: m.teaser, minutes: m.minutes, completed: !!(v && v.completedAt) }; });
  return {
    enrolled: true, track: track, totalWeeks: total, week: timeWeek(st, today), unlockedWeek: uw,
    startDate: st.startDate, prefs: st.prefs || null,
    currentLesson: cur ? { week: cur.week, title: cur.title, teaser: cur.teaser, minutes: cur.minutes, season: cur.season, completed: cur.completed } : null,
    lessons: lessons,
    vertiefung: vertiefung,
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
  VERTIEFUNG, vertiefungFor, vertiefungList, fullVertiefung, completeVertiefung,
  berlinToday, daysBetween, addDays, isYMD, clampInt,
  timeWeek, highestCompleted, unlockedWeek, isWeekUnlocked, sanitizePrefs,
  getState, saveState, enroll, completeLesson, publicSnapshot,
  isKnownHabit, activeWeek, getHabitRec, saveHabitRec, todayHabitList, toggleHabit, habitStreak, habitPoints, POINTS_PER_HABIT,
  staticImpulse, getImpulse, saveImpulse, ensureImpulse, ackImpulse, markImpulsePushed,
  getCheckins, saveCheckins, buildCheckinEntry, appendCheckin, checkinHistory, nextCheckinInfo, shouldLoopTeam, CHECKIN_INTERVAL_DAYS,
  exportState, deleteKeys,
  kvGetJson, kvSetJson,
};
