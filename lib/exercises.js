'use strict';

/**
 * Übungsdatenbank – kuratiert aus dem echten Geräte-/Übungsbestand von Fit-Inn Trier
 * (Technogym Biostrength & Artis, Multipower, Kabelzüge, Freihanteln, Functional,
 * Cardio, Mobility). Bewusst eine übersichtliche, entdupelte Auswahl der wichtigsten
 * Übungen – nicht der komplette Roh-Export (viele Duplikate/Sport-Aktivitäten/Tests).
 *
 * Für Einsteiger sind die BIOSTRENGTH-Geräte markiert (bio:true): am Gerät anmelden,
 * es stellt sich automatisch ein und die Technogym-KI übernimmt die Progression.
 *
 * Struktur je Übung:
 *   { id, name, machine, group, equip, bio, cue }
 *     group: brust|ruecken|schulter|arme|beine|po|bauch|ganzkoerper|cardio|mobility
 *     equip: kurzer Anzeige-Text der Geräteklasse
 *     cue:   1 Satz Kurzanleitung
 */

const GROUPS = [
  ['brust', 'Brust'], ['ruecken', 'Rücken'], ['schulter', 'Schulter'], ['arme', 'Arme'],
  ['beine', 'Beine'], ['po', 'Gesäß'], ['bauch', 'Bauch & Core'],
  ['ganzkoerper', 'Ganzkörper'], ['cardio', 'Cardio'], ['mobility', 'Beweglichkeit'],
];
const GROUP_LABEL = GROUPS.reduce((m, g) => { m[g[0]] = g[1]; return m; }, {});

const BIO = 'Am Gerät anmelden – Sitz & Gewicht stellen sich automatisch ein, die Technogym-KI steigert dich.';

const CATALOG = [
  // ── Brust ──
  { name: 'Brustdrücken', machine: 'Chest Press Biostrength', group: 'brust', equip: 'Biostrength', bio: true, cue: BIO + ' Griffe auf Brusthöhe, kontrolliert nach vorn drücken.' },
  { name: 'Brustdrücken', machine: 'Chest Press Artis', group: 'brust', equip: 'Gerät (Artis)', cue: 'Schulterblätter zurück, gleichmäßig nach vorn drücken, nicht ganz durchstrecken.' },
  { name: 'Butterfly / Armadduktion', machine: 'Pectoral Biostrength', group: 'brust', equip: 'Biostrength', bio: true, cue: BIO + ' Arme im leichten Bogen vor der Brust zusammenführen.' },
  { name: 'Schräg-Brustdrücken', machine: 'Chest Incline', group: 'brust', equip: 'Gerät', cue: 'Obere Brust – Rücken anlehnen, sauber nach oben-vorn drücken.' },
  { name: 'Bankdrücken', machine: 'Olympic Rack Pure', group: 'brust', equip: 'Langhantel', cue: 'Stange zur Brust senken, Ellenbogen ~45°, explosiv hochdrücken.' },
  { name: 'Schrägbankdrücken', machine: 'Kurzhanteln', group: 'brust', equip: 'Kurzhanteln', cue: 'Auf der Schrägbank Hanteln über der oberen Brust zusammenführen.' },
  { name: 'Fliegende auf Flachbank', machine: 'Kurzhanteln', group: 'brust', equip: 'Kurzhanteln', cue: 'Leicht gebeugte Arme im Bogen öffnen und schließen – Dehnung spüren.' },
  { name: 'Fliegende am Kabel', machine: 'Cable Crossover', group: 'brust', equip: 'Kabelzug', cue: 'Züge von oben oder unten vor der Brust zusammenführen.' },

  // ── Rücken ──
  { name: 'Latzug zur Brust', machine: 'Lat Machine Artis', group: 'ruecken', equip: 'Gerät (Artis)', cue: 'Stange zur oberen Brust ziehen, Schulterblätter zuerst nach unten.' },
  { name: 'Vertikaler Zug', machine: 'Vertical Traction Biostrength', group: 'ruecken', equip: 'Biostrength', bio: true, cue: BIO + ' Von oben zur Brust ziehen, Brust raus.' },
  { name: 'Rudern tief', machine: 'Low Row Biostrength', group: 'ruecken', equip: 'Biostrength', bio: true, cue: BIO + ' Griffe zum Bauch ziehen, Rücken gerade.' },
  { name: 'Rudern am Kabel', machine: 'Cable Stations 4', group: 'ruecken', equip: 'Kabelzug', cue: 'Ellenbogen eng am Körper nach hinten ziehen, Brust raus.' },
  { name: 'Rudern vorgebeugt', machine: 'Langhantel', group: 'ruecken', equip: 'Langhantel', cue: 'Oberkörper vorgebeugt, Stange zum Bauchnabel ziehen.' },
  { name: 'Rudern einarmig', machine: 'Kurzhanteln', group: 'ruecken', equip: 'Kurzhanteln', cue: 'Ein Knie auf der Bank, Hantel eng am Körper hochziehen.' },
  { name: 'Fliegende rückwärts (Rear Delt)', machine: 'Rear Delt Row Artis', group: 'ruecken', equip: 'Gerät (Artis)', cue: 'Für hinteren Schulter/oberen Rücken – Arme kontrolliert öffnen.' },
  { name: 'Reverse Fly', machine: 'Reverse Fly Biostrength', group: 'ruecken', equip: 'Biostrength', bio: true, cue: BIO + ' Arme gegen den Widerstand nach hinten öffnen.' },
  { name: 'Rückenstreckung', machine: 'Lower Back Biostrength', group: 'ruecken', equip: 'Biostrength', bio: true, cue: BIO + ' Oberkörper langsam aufrichten, nicht überstrecken.' },
  { name: 'Klimmzüge', machine: 'Olympic Rack Pure', group: 'ruecken', equip: 'Körpergewicht', cue: 'Aus dem vollen Hang bis Kinn über die Stange – ggf. mit Unterstützung.' },

  // ── Schulter ──
  { name: 'Schulterdrücken', machine: 'Shoulder Press Biostrength', group: 'schulter', equip: 'Biostrength', bio: true, cue: BIO + ' Griffe über Kopf drücken, nicht komplett durchstrecken.' },
  { name: 'Überkopfdrücken', machine: 'Kurzhanteln', group: 'schulter', equip: 'Kurzhanteln', cue: 'Aus Schulterhöhe kontrolliert nach oben drücken, Rumpf fest.' },
  { name: 'Seitheben', machine: 'Kurzhanteln', group: 'schulter', equip: 'Kurzhanteln', cue: 'Leicht gebeugte Arme bis Schulterhöhe seitlich anheben.' },
  { name: 'Frontheben', machine: 'Kurzhanteln', group: 'schulter', equip: 'Kurzhanteln', cue: 'Arme abwechselnd nach vorn bis Schulterhöhe heben.' },
  { name: 'Face Pulls', machine: 'Cable Stations 4', group: 'schulter', equip: 'Kabelzug', cue: 'Seil zum Gesicht ziehen, Ellenbogen hoch – gut für gesunde Schultern.' },
  { name: 'Schulterheben (Nacken)', machine: 'Kurzhanteln', group: 'schulter', equip: 'Kurzhanteln', cue: 'Schultern gerade nach oben ziehen, kurz halten, senken.' },

  // ── Arme ──
  { name: 'Bizeps: Armbeugung', machine: 'Arm Curl Biostrength', group: 'arme', equip: 'Biostrength', bio: true, cue: BIO + ' Nur die Unterarme bewegen, Oberarme ruhig.' },
  { name: 'Bizepscurl', machine: 'Kurzhanteln', group: 'arme', equip: 'Kurzhanteln', cue: 'Ellenbogen fixiert, Hanteln kontrolliert beugen und senken.' },
  { name: 'Bizepscurl (SZ-Stange)', machine: 'SZ-Langhantel', group: 'arme', equip: 'SZ-Stange', cue: 'Schulterbreit greifen, ohne Schwung beugen.' },
  { name: 'Hammercurl', machine: 'Kurzhanteln', group: 'arme', equip: 'Kurzhanteln', cue: 'Neutraler Griff (Daumen oben), beugen – trainiert auch den Unterarm.' },
  { name: 'Trizeps: Armstreckung', machine: 'Arm Extension Biostrength', group: 'arme', equip: 'Biostrength', bio: true, cue: BIO + ' Kontrolliert strecken, Ellenbogen stabil.' },
  { name: 'Trizepsdrücken am Kabel', machine: 'Cable Stations 4', group: 'arme', equip: 'Kabelzug', cue: 'Ellenbogen am Körper, Seil/Stange nach unten strecken.' },
  { name: 'Stirndrücken', machine: 'Kurzhanteln', group: 'arme', equip: 'Kurzhanteln', cue: 'Auf der Bank, Hanteln zur Stirn senken und strecken.' },
  { name: 'Trizeps-Dips', machine: 'Technogym Bench', group: 'arme', equip: 'Bank', cue: 'Hände auf der Bank, Körper senken und über die Trizeps hochdrücken.' },

  // ── Beine ──
  { name: 'Beinpresse', machine: 'Leg Press Biostrength', group: 'beine', equip: 'Biostrength', bio: true, cue: BIO + ' Füße hüftbreit, nicht ganz durchstrecken.' },
  { name: 'Beinstrecker (Kniestreckung)', machine: 'Leg Extension Biostrength', group: 'beine', equip: 'Biostrength', bio: true, cue: BIO + ' Knie kontrolliert strecken, oben kurz halten.' },
  { name: 'Beinbeuger (Kniebeugung)', machine: 'Leg Curl Biostrength', group: 'beine', equip: 'Biostrength', bio: true, cue: BIO + ' Fersen zum Gesäß ziehen, langsam zurück.' },
  { name: 'Kniebeuge', machine: 'Multipower', group: 'beine', equip: 'Multipower', cue: 'Geführt in der Multipresse – so tief, wie der Rücken gerade bleibt.' },
  { name: 'Kniebeuge', machine: 'Olympic Rack Pure', group: 'beine', equip: 'Langhantel', cue: 'Stange auf dem oberen Rücken, Hüfte nach hinten, Brust hoch.' },
  { name: 'Ausfallschritte', machine: 'Kurzhanteln', group: 'beine', equip: 'Kurzhanteln', cue: 'Großer Schritt nach vorn, hinteres Knie Richtung Boden.' },
  { name: 'Bulgarische Kniebeuge', machine: 'Kurzhanteln', group: 'beine', equip: 'Kurzhanteln', cue: 'Hinterer Fuß erhöht, vorderes Bein tief beugen.' },
  { name: 'Rumänisches Kreuzheben', machine: 'Kurzhanteln', group: 'beine', equip: 'Kurzhanteln', cue: 'Beine fast gestreckt, Hüfte nach hinten, Rückseite spüren.' },
  { name: 'Kreuzheben', machine: 'Langhantel', group: 'beine', equip: 'Langhantel', cue: 'Rücken gerade, aus den Beinen heben – Technik vor Gewicht.' },
  { name: 'Wadenheben (sitzend)', machine: 'Calf Machine Sitting', group: 'beine', equip: 'Gerät', cue: 'Fersen langsam heben und senken, volle Bewegung.' },

  // ── Gesäß ──
  { name: 'Hip Thrust', machine: 'Hip Thrust Pure', group: 'po', equip: 'Gerät', cue: 'Schulterblätter auf der Bank, Becken nach oben, Gesäß fest anspannen.' },
  { name: 'Beckenheben (Glute Bridge)', machine: 'Freie Übung', group: 'po', equip: 'Körpergewicht', cue: 'Rückenlage, Becken hoch drücken, oben kurz halten.' },
  { name: 'Hüftstreckung', machine: 'Multi Hip Artis', group: 'po', equip: 'Gerät (Artis)', cue: 'Bein gegen das Polster nach hinten strecken, Gesäß anspannen.' },
  { name: 'Kickbacks am Kabel', machine: 'Cable Stations 4', group: 'po', equip: 'Kabelzug', cue: 'Fußmanschette, Bein kontrolliert nach hinten strecken.' },
  { name: 'Beinabduktion', machine: 'Abductor Biostrength', group: 'po', equip: 'Biostrength', bio: true, cue: BIO + ' Beine gegen den Widerstand nach außen öffnen.' },
  { name: 'Beinadduktion', machine: 'Adductor Biostrength', group: 'po', equip: 'Biostrength', bio: true, cue: BIO + ' Beine gegen den Widerstand schließen.' },

  // ── Bauch & Core ──
  { name: 'Crunch', machine: 'Total Abdominal Biostrength', group: 'bauch', equip: 'Biostrength', bio: true, cue: BIO + ' Oberkörper einrollen, Bauch anspannen.' },
  { name: 'Crunch', machine: 'Total Abd. Artis', group: 'bauch', equip: 'Gerät (Artis)', cue: 'Kontrolliert einrollen, nicht am Nacken ziehen.' },
  { name: 'Rumpfrotation', machine: 'Rotary Torso Artis', group: 'bauch', equip: 'Gerät (Artis)', cue: 'Oberkörper gegen den Widerstand rotieren, Becken stabil.' },
  { name: 'Beinheben', machine: 'Freie Übung', group: 'bauch', equip: 'Körpergewicht', cue: 'Gestreckte oder gebeugte Beine anheben, unteren Rücken flach lassen.' },
  { name: 'Plank (Unterarmstütz)', machine: 'Freie Übung', group: 'bauch', equip: 'Körpergewicht', cue: 'Körper in einer Linie halten, Bauch und Gesäß fest.' },
  { name: 'Russian Twist', machine: 'Kurzhanteln', group: 'bauch', equip: 'Kurzhanteln', cue: 'Sitzend, Oberkörper leicht zurück, Gewicht seitlich tippen.' },

  // ── Ganzkörper / Functional ──
  { name: 'Kettlebell Swing', machine: 'Kugelhantel', group: 'ganzkoerper', equip: 'Kettlebell', cue: 'Kraft aus der Hüfte, Kettlebell bis Schulterhöhe schwingen.' },
  { name: 'Goblet-Kniebeuge', machine: 'Kugelhantel', group: 'ganzkoerper', equip: 'Kettlebell', cue: 'Kettlebell vor der Brust, tief in die Hocke.' },
  { name: 'Türkisches Aufstehen', machine: 'Kugelhantel', group: 'ganzkoerper', equip: 'Kettlebell', cue: 'Langsam vom Liegen zum Stand, Gewicht immer über dem Kopf.' },
  { name: 'Rudern im Sling-Trainer', machine: 'Sling trainer', group: 'ganzkoerper', equip: 'Sling-Trainer', cue: 'Körper gerade, sich am Griff hochziehen.' },
  { name: 'Liegestütz im Sling-Trainer', machine: 'Sling trainer', group: 'ganzkoerper', equip: 'Sling-Trainer', cue: 'Griffe schulterbreit, Körper gerade absenken und drücken.' },
  { name: 'Burpees', machine: 'Freie Übung', group: 'ganzkoerper', equip: 'Körpergewicht', cue: 'Kniebeuge → Liegestütz → Strecksprung, flüssig.' },
  { name: 'Farmers Carry', machine: 'Hexagon dumbbells', group: 'ganzkoerper', equip: 'Kurzhanteln', cue: 'Schwere Hanteln aufrecht tragen, Schultern zurück.' },

  // ── Cardio ──
  { name: 'Laufband', machine: 'Run', group: 'cardio', equip: 'Cardio', cue: 'Gehen oder Laufen; für Intervalle Tempo/Steigung wechseln.' },
  { name: 'Bike', machine: 'Bike', group: 'cardio', equip: 'Cardio', cue: 'Gleichmäßig treten; Programm „Abnehmen" steuert die Intensität automatisch.' },
  { name: 'Recline-Bike (Liegerad)', machine: 'Recline', group: 'cardio', equip: 'Cardio', cue: 'Rückenschonend im Sitzen – ideal für den Einstieg.' },
  { name: 'SkillRow (Rudern)', machine: 'Skillrow', group: 'cardio', equip: 'Cardio', cue: 'Ganzkörper-Cardio: Beine drücken, dann ziehen.' },
  { name: 'SkillMill / Climb', machine: 'Climb', group: 'cardio', equip: 'Cardio', cue: 'Intensives Ausdauer-/Intervalltraining ohne Motor.' },
  { name: 'Vario (Crosstrainer)', machine: 'Vario', group: 'cardio', equip: 'Cardio', cue: 'Gelenkschonend, gleichmäßiger Bewegungsfluss.' },

  // ── Beweglichkeit ──
  { name: 'Faszienrolle unterer Rücken', machine: 'Schaumstoffrolle', group: 'mobility', equip: 'Faszienrolle', cue: 'Langsam hin und her rollen, verspannte Stellen halten.' },
  { name: 'Katze-Kuh', machine: 'Freie Übung', group: 'mobility', equip: 'Körpergewicht', cue: 'Im Vierfüßlerstand Rücken abwechselnd runden und strecken.' },
  { name: 'Hüftbeuger-Dehnung', machine: 'Stretching', group: 'mobility', equip: 'Dehnung', cue: 'Ausfallschritt, hinterer Hüftbeuger dehnt – ruhig atmen.' },
  { name: 'Vierfüßler diagonal (Bird Dog)', machine: 'Freie Übung', group: 'mobility', equip: 'Körpergewicht', cue: 'Gegenüberliegenden Arm und Bein strecken, Rumpf stabil.' },
  { name: 'Mobility Ball Schulter', machine: 'Mobility ball', group: 'mobility', equip: 'Mobility Ball', cue: 'Verspannte Schulter-/Brustmuskeln sanft ausrollen.' },
];

// Stabile ID aus Name + Maschine (ohne Zufall/Date).
function idFor(name, machine) {
  const s = (name + ' ' + machine).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return s.replace(/\s+/g, '-').slice(0, 40) + '-' + h.toString(36);
}
const LIST = CATALOG.map((e) => ({
  id: idFor(e.name, e.machine),
  name: e.name, machine: e.machine, group: e.group, groupLabel: GROUP_LABEL[e.group] || '',
  equip: e.equip, bio: !!e.bio, cue: e.cue,
}));

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
// Öffentliche Liste (komplett – klein genug für den GET-Payload).
function publicList() { return LIST; }
function getById(id) { return LIST.find((e) => e.id === String(id)) || null; }
// Server-Suche (falls gewünscht) – filtert nach Freitext, Gruppe, Gerät.
function search(q, opts) {
  opts = opts || {};
  const s = norm(q).trim();
  let list = LIST.slice();
  if (opts.group && GROUP_LABEL[opts.group]) list = list.filter((e) => e.group === opts.group);
  if (opts.bio) list = list.filter((e) => e.bio);
  if (s) list = list.filter((e) => norm(e.name + ' ' + e.machine + ' ' + e.equip + ' ' + e.groupLabel).indexOf(s) >= 0);
  return list.slice(0, 60);
}

module.exports = { GROUPS, GROUP_LABEL, publicList, getById, search };
