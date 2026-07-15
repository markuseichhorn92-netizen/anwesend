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

const CURRICULA = {
  abnehmen: CURRICULUM.concat(ABNEHMEN_EXT, ABNEHMEN_S2),   // Kern (12 W.) + Staffel 2 (8 W.) = 20 Wochen
  definieren: DEFINIEREN,                                   // eigener 12-Wochen-Kern
  halten: CURRICULUM,
  aufbau: CURRICULUM, gesundheit: CURRICULUM, longevity: CURRICULUM,
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
  definieren: [], halten: [], aufbau: [], gesundheit: [], longevity: [],
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
