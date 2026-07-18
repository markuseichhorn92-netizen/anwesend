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
  { name: 'Brustdrücken', machine: 'Chest Press Artis', group: 'brust', equip: 'Gerät (Artis)', cue: 'Schulterblätter zurück, gleichmäßig nach vorn drücken, nicht ganz durchstrecken.', pattern: 'press-fwd', steps: ['Rücken und Kopf ans Polster, Füße fest auf dem Boden.', 'Griffe auf Brusthöhe fassen, Schulterblätter zusammen und nach unten.', 'Gleichmäßig nach vorn drücken, ohne die Ellenbogen ganz durchzustrecken.', 'Langsam zurückführen, bis du eine leichte Dehnung in der Brust spürst.'] },
  { name: 'Butterfly / Armadduktion', machine: 'Pectoral Biostrength', group: 'brust', equip: 'Biostrength', bio: true, cue: BIO + ' Arme im leichten Bogen vor der Brust zusammenführen.' },
  { name: 'Schräg-Brustdrücken', machine: 'Chest Incline', group: 'brust', equip: 'Gerät', cue: 'Obere Brust – Rücken anlehnen, sauber nach oben-vorn drücken.', pattern: 'press-fwd', steps: ['Rücken an die schräge Lehne, Griffe knapp unter Schulterhöhe.', 'Schulterblätter fixieren, Brust raus.', 'Nach oben-vorn drücken, kurz vor dem Durchstrecken stoppen.', 'Kontrolliert absenken – die obere Brust arbeiten lassen.'] },
  { name: 'Bankdrücken', machine: 'Olympic Rack Pure', group: 'brust', equip: 'Langhantel', cue: 'Stange zur Brust senken, Ellenbogen ~45°, explosiv hochdrücken.', pattern: 'press-fwd', steps: ['Flach auf die Bank, Augen unter der Stange, Füße fest am Boden.', 'Schulterblätter zusammenziehen, leichtes Hohlkreuz, Stange etwas weiter als schulterbreit greifen.', 'Stange kontrolliert zur unteren Brust senken, Ellenbogen ca. 45°.', 'Explosiv nach oben drücken, ohne die Ellenbogen zu überstrecken.', 'Immer mit Partner oder Sicherheitsablagen arbeiten.'] },
  { name: 'Schrägbankdrücken', machine: 'Kurzhanteln', group: 'brust', equip: 'Kurzhanteln', cue: 'Auf der Schrägbank Hanteln über der oberen Brust zusammenführen.', pattern: 'press-fwd', steps: ['Auf die Schrägbank legen, Hanteln auf Höhe der oberen Brust.', 'Handflächen nach vorn, Schulterblätter zusammen.', 'Hanteln nach oben zusammenführen, nicht aneinanderschlagen.', 'Langsam absenken, bis die Ellenbogen etwa auf Brusthöhe sind.'] },
  { name: 'Fliegende auf Flachbank', machine: 'Kurzhanteln', group: 'brust', equip: 'Kurzhanteln', cue: 'Leicht gebeugte Arme im Bogen öffnen und schließen – Dehnung spüren.', pattern: 'press-fwd', steps: ['Flach auf die Bank, Hanteln gestreckt über der Brust, Handflächen zueinander.', 'Arme leicht gebeugt lassen – diesen Winkel fixieren.', 'Im weiten Bogen zur Seite öffnen, bis du die Brust dehnst.', 'Über dieselbe Bahn zusammenführen – die Brust arbeitet, nicht die Arme.'] },
  { name: 'Fliegende am Kabel', machine: 'Cable Crossover', group: 'brust', equip: 'Kabelzug', cue: 'Züge von oben oder unten vor der Brust zusammenführen.', pattern: 'press-fwd', steps: ['Züge auf gewünschte Höhe stellen, mittig stehen, ein Fuß leicht vor.', 'Arme leicht gebeugt weit öffnen, Brust raus.', 'Die Griffe vor dem Körper zusammenführen und kurz halten.', 'Langsam zurück in die Dehnung.'] },

  // ── Rücken ──
  { name: 'Latzug zur Brust', machine: 'Lat Machine Artis', group: 'ruecken', equip: 'Gerät (Artis)', cue: 'Stange zur oberen Brust ziehen, Schulterblätter zuerst nach unten.', pattern: 'pull-down', steps: ['Oberschenkel unter die Polster, Stange etwas weiter als schulterbreit greifen.', 'Brust raus, leicht zurücklehnen.', 'Zuerst die Schulterblätter nach unten ziehen, dann die Stange zur oberen Brust.', 'Kontrolliert nach oben zurückführen, ohne die Schultern hochzuziehen.'] },
  { name: 'Vertikaler Zug', machine: 'Vertical Traction Biostrength', group: 'ruecken', equip: 'Biostrength', bio: true, cue: BIO + ' Von oben zur Brust ziehen, Brust raus.' },
  { name: 'Rudern tief', machine: 'Low Row Biostrength', group: 'ruecken', equip: 'Biostrength', bio: true, cue: BIO + ' Griffe zum Bauch ziehen, Rücken gerade.' },
  { name: 'Rudern am Kabel', machine: 'Cable Stations 4', group: 'ruecken', equip: 'Kabelzug', cue: 'Ellenbogen eng am Körper nach hinten ziehen, Brust raus.', pattern: 'pull-row', steps: ['Aufrecht sitzen, Füße gestemmt, leichte Beugung in den Knien.', 'Griff fassen, Brust raus, Rücken gerade.', 'Ellenbogen eng am Körper nach hinten ziehen, Schulterblätter zusammen.', 'Langsam zurück, ohne den Rücken rund werden zu lassen.'] },
  { name: 'Rudern vorgebeugt', machine: 'Langhantel', group: 'ruecken', equip: 'Langhantel', cue: 'Oberkörper vorgebeugt, Stange zum Bauchnabel ziehen.', pattern: 'pull-row', steps: ['Hüftbreiter Stand, Stange schulterbreit greifen.', 'Hüfte nach hinten, Oberkörper ~45° vorgebeugt, Rücken gerade.', 'Stange zum unteren Bauch ziehen, Ellenbogen nah am Körper.', 'Kontrolliert absenken – Spannung im oberen Rücken halten.'] },
  { name: 'Rudern einarmig', machine: 'Kurzhanteln', group: 'ruecken', equip: 'Kurzhanteln', cue: 'Ein Knie auf der Bank, Hantel eng am Körper hochziehen.', pattern: 'pull-row', steps: ['Ein Knie und eine Hand auf der Bank, Rücken waagerecht und gerade.', 'Hantel hängen lassen, Schulter nicht nach vorn fallen lassen.', 'Hantel eng am Körper nach oben ziehen, Ellenbogen nach hinten.', 'Langsam absenken, dann die Seite wechseln.'] },
  { name: 'Fliegende rückwärts (Rear Delt)', machine: 'Rear Delt Row Artis', group: 'ruecken', equip: 'Gerät (Artis)', cue: 'Für hinteren Schulter/oberen Rücken – Arme kontrolliert öffnen.', pattern: 'raise', steps: ['Brust ans Polster, Griffe auf Schulterhöhe fassen.', 'Arme fast gestreckt, leichte Beugung fixieren.', 'Arme im Bogen nach hinten öffnen, Schulterblätter zusammen.', 'Langsam zurückführen – die hintere Schulter spüren.'] },
  { name: 'Reverse Fly', machine: 'Reverse Fly Biostrength', group: 'ruecken', equip: 'Biostrength', bio: true, cue: BIO + ' Arme gegen den Widerstand nach hinten öffnen.' },
  { name: 'Rückenstreckung', machine: 'Lower Back Biostrength', group: 'ruecken', equip: 'Biostrength', bio: true, cue: BIO + ' Oberkörper langsam aufrichten, nicht überstrecken.' },
  { name: 'Klimmzüge', machine: 'Olympic Rack Pure', group: 'ruecken', equip: 'Körpergewicht', cue: 'Aus dem vollen Hang bis Kinn über die Stange – ggf. mit Unterstützung.', pattern: 'pull-down', steps: ['Stange etwas weiter als schulterbreit greifen, aus dem Hang starten.', 'Schulterblätter nach unten ziehen, Brust leicht raus.', 'Hochziehen, bis das Kinn über die Stange kommt.', 'Kontrolliert ganz nach unten absenken.', 'Zu schwer? Miniband oder Unterstützungsgerät nutzen.'] },

  // ── Schulter ──
  { name: 'Schulterdrücken', machine: 'Shoulder Press Biostrength', group: 'schulter', equip: 'Biostrength', bio: true, cue: BIO + ' Griffe über Kopf drücken, nicht komplett durchstrecken.' },
  { name: 'Überkopfdrücken', machine: 'Kurzhanteln', group: 'schulter', equip: 'Kurzhanteln', cue: 'Aus Schulterhöhe kontrolliert nach oben drücken, Rumpf fest.', pattern: 'press-up', steps: ['Aufrecht sitzen oder stehen, Rumpf fest, Hanteln auf Schulterhöhe.', 'Handflächen nach vorn, Ellenbogen unter den Handgelenken.', 'Gerade nach oben drücken, ohne die Ellenbogen zu überstrecken.', 'Langsam auf Schulterhöhe zurückführen.'] },
  { name: 'Seitheben', machine: 'Kurzhanteln', group: 'schulter', equip: 'Kurzhanteln', cue: 'Leicht gebeugte Arme bis Schulterhöhe seitlich anheben.', pattern: 'raise', steps: ['Aufrecht stehen, Hanteln neben dem Körper, Ellenbogen leicht gebeugt.', 'Arme seitlich bis auf Schulterhöhe anheben, die Ellenbogen führen.', 'Kurz halten, nicht mit Schwung arbeiten.', 'Langsam absenken.'] },
  { name: 'Frontheben', machine: 'Kurzhanteln', group: 'schulter', equip: 'Kurzhanteln', cue: 'Arme abwechselnd nach vorn bis Schulterhöhe heben.', pattern: 'raise', steps: ['Aufrecht stehen, Hanteln vor den Oberschenkeln.', 'Einen Arm (leichte Beugung) nach vorn bis Schulterhöhe heben.', 'Kurz halten, kontrolliert absenken.', 'Im Wechsel, ohne Schwung aus dem Rücken.'] },
  { name: 'Face Pulls', machine: 'Cable Stations 4', group: 'schulter', equip: 'Kabelzug', cue: 'Seil zum Gesicht ziehen, Ellenbogen hoch – gut für gesunde Schultern.', pattern: 'pull-row', steps: ['Seil auf Kopfhöhe einstellen, mit beiden Händen fassen.', 'Einen Schritt zurücktreten, Arme gestreckt, Brust raus.', 'Seil zum Gesicht ziehen, Ellenbogen hoch und weit auseinander.', 'Langsam zurück – hintere Schulter und oberer Rücken arbeiten.'] },
  { name: 'Schulterheben (Nacken)', machine: 'Kurzhanteln', group: 'schulter', equip: 'Kurzhanteln', cue: 'Schultern gerade nach oben ziehen, kurz halten, senken.', pattern: 'raise', steps: ['Aufrecht stehen, Hanteln neben dem Körper, Arme gestreckt.', 'Schultern gerade nach oben Richtung Ohren ziehen.', 'Oben kurz halten, nicht kreisen.', 'Langsam absenken.'] },

  // ── Arme ──
  { name: 'Bizeps: Armbeugung', machine: 'Arm Curl Biostrength', group: 'arme', equip: 'Biostrength', bio: true, cue: BIO + ' Nur die Unterarme bewegen, Oberarme ruhig.' },
  { name: 'Bizepscurl', machine: 'Kurzhanteln', group: 'arme', equip: 'Kurzhanteln', cue: 'Ellenbogen fixiert, Hanteln kontrolliert beugen und senken.', pattern: 'curl', steps: ['Aufrecht stehen, Hanteln neben dem Körper, Handflächen nach vorn.', 'Ellenbogen fest am Körper fixieren.', 'Hanteln nach oben beugen, nur die Unterarme bewegen.', 'Langsam absenken, ohne Schwung.'] },
  { name: 'Bizepscurl (SZ-Stange)', machine: 'SZ-Langhantel', group: 'arme', equip: 'SZ-Stange', cue: 'Schulterbreit greifen, ohne Schwung beugen.', pattern: 'curl', steps: ['Aufrecht stehen, SZ-Stange schulterbreit an den Kröpfungen greifen.', 'Ellenbogen am Körper fixieren, Oberarme ruhig.', 'Stange nach oben beugen.', 'Kontrolliert absenken, ohne Schwung aus dem Rücken.'] },
  { name: 'Hammercurl', machine: 'Kurzhanteln', group: 'arme', equip: 'Kurzhanteln', cue: 'Neutraler Griff (Daumen oben), beugen – trainiert auch den Unterarm.', pattern: 'curl', steps: ['Aufrecht stehen, neutraler Griff (Daumen oben).', 'Ellenbogen am Körper, Handgelenke gerade.', 'Hanteln nach oben beugen, Griff bleibt neutral.', 'Langsam absenken – trainiert auch den Unterarm.'] },
  { name: 'Trizeps: Armstreckung', machine: 'Arm Extension Biostrength', group: 'arme', equip: 'Biostrength', bio: true, cue: BIO + ' Kontrolliert strecken, Ellenbogen stabil.' },
  { name: 'Trizepsdrücken am Kabel', machine: 'Cable Stations 4', group: 'arme', equip: 'Kabelzug', cue: 'Ellenbogen am Körper, Seil/Stange nach unten strecken.', pattern: 'extend', steps: ['Seil/Stange am oberen Zug fassen, aufrecht stehen.', 'Ellenbogen eng am Körper fixieren.', 'Nach unten strecken, bis die Arme fast gerade sind.', 'Langsam zurück, die Ellenbogen bleiben am Körper.'] },
  { name: 'Stirndrücken', machine: 'Kurzhanteln', group: 'arme', equip: 'Kurzhanteln', cue: 'Auf der Bank, Hanteln zur Stirn senken und strecken.', pattern: 'extend', steps: ['Flach auf die Bank, Hanteln über der Stirn, Handflächen zueinander.', 'Oberarme senkrecht halten, nur im Ellenbogen bewegen.', 'Hanteln langsam zur Stirn senken.', 'Nach oben strecken, ohne die Oberarme zu bewegen.'] },
  { name: 'Trizeps-Dips', machine: 'Technogym Bench', group: 'arme', equip: 'Bank', cue: 'Hände auf der Bank, Körper senken und über die Trizeps hochdrücken.', pattern: 'extend', steps: ['Hände schulterbreit auf die Bankkante, Finger nach vorn.', 'Gesäß von der Bank lösen, Beine nach vorn.', 'Körper senken, bis die Ellenbogen ~90° gebeugt sind.', 'Über die Trizeps nach oben drücken.'] },

  // ── Beine ──
  { name: 'Beinpresse', machine: 'Leg Press Biostrength', group: 'beine', equip: 'Biostrength', bio: true, cue: BIO + ' Füße hüftbreit, nicht ganz durchstrecken.' },
  { name: 'Beinstrecker (Kniestreckung)', machine: 'Leg Extension Biostrength', group: 'beine', equip: 'Biostrength', bio: true, cue: BIO + ' Knie kontrolliert strecken, oben kurz halten.' },
  { name: 'Beinbeuger (Kniebeugung)', machine: 'Leg Curl Biostrength', group: 'beine', equip: 'Biostrength', bio: true, cue: BIO + ' Fersen zum Gesäß ziehen, langsam zurück.' },
  { name: 'Kniebeuge', machine: 'Multipower', group: 'beine', equip: 'Multipower', cue: 'Geführt in der Multipresse – so tief, wie der Rücken gerade bleibt.', pattern: 'squat', steps: ['Stange auf dem oberen Rücken, hüftbreiter Stand, Zehen leicht nach außen.', 'Rumpf fest, Sicherung der Multipresse einstellen.', 'Hüfte nach hinten und unten, so tief wie der Rücken gerade bleibt.', 'Kraftvoll nach oben drücken, Knie in Richtung der Zehen.'] },
  { name: 'Kniebeuge', machine: 'Olympic Rack Pure', group: 'beine', equip: 'Langhantel', cue: 'Stange auf dem oberen Rücken, Hüfte nach hinten, Brust hoch.', pattern: 'squat', steps: ['Stange auf dem Trapez ablegen, aus dem Rack heben, zwei Schritte zurück.', 'Hüftbreiter Stand, Brust hoch, Rumpf fest.', 'Hüfte nach hinten, in die Hocke, bis mind. die Oberschenkel parallel sind.', 'Über die Fersen nach oben drücken.', 'Immer mit Sicherheitsablagen arbeiten.'] },
  { name: 'Ausfallschritte', machine: 'Kurzhanteln', group: 'beine', equip: 'Kurzhanteln', cue: 'Großer Schritt nach vorn, hinteres Knie Richtung Boden.', pattern: 'squat', steps: ['Aufrecht stehen, Hanteln neben dem Körper.', 'Großer Schritt nach vorn, Oberkörper aufrecht.', 'Hinteres Knie Richtung Boden senken, vorderes Knie über dem Fuß.', 'Über die vordere Ferse zurück in den Stand, Seite wechseln.'] },
  { name: 'Bulgarische Kniebeuge', machine: 'Kurzhanteln', group: 'beine', equip: 'Kurzhanteln', cue: 'Hinterer Fuß erhöht, vorderes Bein tief beugen.', pattern: 'squat', steps: ['Hinteren Fuß auf eine Bank legen, aufrecht stehen.', 'Hanteln neben dem Körper, Rumpf fest.', 'Vorderes Bein tief beugen, Knie über dem Fuß.', 'Über die vordere Ferse hochdrücken, Seite wechseln.'] },
  { name: 'Rumänisches Kreuzheben', machine: 'Kurzhanteln', group: 'beine', equip: 'Kurzhanteln', cue: 'Beine fast gestreckt, Hüfte nach hinten, Rückseite spüren.', pattern: 'hinge', steps: ['Hüftbreiter Stand, Hanteln vor den Oberschenkeln, Beine fast gestreckt.', 'Rücken gerade, Brust raus.', 'Hüfte weit nach hinten schieben, Hanteln nah am Bein herabführen.', 'Dehnung in der Beinrückseite spüren, dann über die Hüfte aufrichten.'] },
  { name: 'Kreuzheben', machine: 'Langhantel', group: 'beine', equip: 'Langhantel', cue: 'Rücken gerade, aus den Beinen heben – Technik vor Gewicht.', pattern: 'hinge', steps: ['Stange über der Mitte des Fußes, hüftbreiter Stand.', 'Hüfte beugen, Stange schulterbreit greifen, Rücken gerade, Brust raus.', 'Über Beine und Hüfte aufrichten, Stange nah am Körper führen.', 'Oben Gesäß anspannen, kontrolliert absetzen.', 'Technik vor Gewicht – Rücken nie rund werden lassen.'] },
  { name: 'Wadenheben (sitzend)', machine: 'Calf Machine Sitting', group: 'beine', equip: 'Gerät', cue: 'Fersen langsam heben und senken, volle Bewegung.', pattern: 'raise', steps: ['Fußballen auf die Trittfläche, Polster auf die Oberschenkel.', 'Fersen langsam so weit wie möglich absenken.', 'Über die Fußballen hoch drücken, oben kurz halten.', 'Volle Bewegung, langsam und ohne Wippen.'] },

  // ── Gesäß ──
  { name: 'Hip Thrust', machine: 'Hip Thrust Pure', group: 'po', equip: 'Gerät', cue: 'Schulterblätter auf der Bank, Becken nach oben, Gesäß fest anspannen.', pattern: 'hinge', steps: ['Schulterblätter auf der Bank, Polster/Stange über der Hüfte.', 'Füße hüftbreit, Schienbeine senkrecht.', 'Über die Fersen die Hüfte nach oben drücken, bis der Körper eine Linie bildet.', 'Oben Gesäß fest anspannen, langsam absenken.'] },
  { name: 'Beckenheben (Glute Bridge)', machine: 'Freie Übung', group: 'po', equip: 'Körpergewicht', cue: 'Rückenlage, Becken hoch drücken, oben kurz halten.', pattern: 'hinge', steps: ['Rückenlage, Knie gebeugt, Füße hüftbreit nah am Gesäß.', 'Arme neben dem Körper, Bauch leicht anspannen.', 'Becken nach oben drücken, bis Oberschenkel und Rumpf eine Linie bilden.', 'Oben Gesäß anspannen, kontrolliert absenken.'] },
  { name: 'Hüftstreckung', machine: 'Multi Hip Artis', group: 'po', equip: 'Gerät (Artis)', cue: 'Bein gegen das Polster nach hinten strecken, Gesäß anspannen.', pattern: 'hinge', steps: ['Am Gerät einstellen, Polster an der Rückseite des Oberschenkels.', 'Aufrecht halten, festhalten.', 'Bein gegen den Widerstand nach hinten strecken, Gesäß anspannen.', 'Langsam zurückführen, Seite wechseln.'] },
  { name: 'Kickbacks am Kabel', machine: 'Cable Stations 4', group: 'po', equip: 'Kabelzug', cue: 'Fußmanschette, Bein kontrolliert nach hinten strecken.', pattern: 'hinge', steps: ['Fußmanschette am unteren Zug befestigen, leicht vorbeugen, festhalten.', 'Standbein leicht gebeugt, Rumpf fest.', 'Arbeitsbein kontrolliert nach hinten strecken, Gesäß anspannen.', 'Langsam zurück, ohne Schwung, Seite wechseln.'] },
  { name: 'Beinabduktion', machine: 'Abductor Biostrength', group: 'po', equip: 'Biostrength', bio: true, cue: BIO + ' Beine gegen den Widerstand nach außen öffnen.' },
  { name: 'Beinadduktion', machine: 'Adductor Biostrength', group: 'po', equip: 'Biostrength', bio: true, cue: BIO + ' Beine gegen den Widerstand schließen.' },

  // ── Bauch & Core ──
  { name: 'Crunch', machine: 'Total Abdominal Biostrength', group: 'bauch', equip: 'Biostrength', bio: true, cue: BIO + ' Oberkörper einrollen, Bauch anspannen.' },
  { name: 'Crunch', machine: 'Total Abd. Artis', group: 'bauch', equip: 'Gerät (Artis)', cue: 'Kontrolliert einrollen, nicht am Nacken ziehen.', pattern: 'core', steps: ['Am Gerät einstellen, Griffe/Polster fassen.', 'Bauch anspannen, den Oberkörper einrollen (nicht am Nacken ziehen).', 'Kurz halten, wenn der Bauch maximal angespannt ist.', 'Langsam zurückführen, die Spannung halten.'] },
  { name: 'Rumpfrotation', machine: 'Rotary Torso Artis', group: 'bauch', equip: 'Gerät (Artis)', cue: 'Oberkörper gegen den Widerstand rotieren, Becken stabil.', pattern: 'rotate', steps: ['Aufrecht sitzen, Beine fixieren, Polster am Oberkörper.', 'Becken stabil, Bauch anspannen.', 'Oberkörper gegen den Widerstand zur Seite rotieren.', 'Langsam zurück, Seite wechseln – nicht mit Schwung.'] },
  { name: 'Beinheben', machine: 'Freie Übung', group: 'bauch', equip: 'Körpergewicht', cue: 'Gestreckte oder gebeugte Beine anheben, unteren Rücken flach lassen.', pattern: 'core', steps: ['Rückenlage, Hände neben oder unter dem Gesäß.', 'Den unteren Rücken flach auf den Boden drücken.', 'Gestreckte oder leicht gebeugte Beine anheben.', 'Langsam absenken, ohne den Rücken abheben zu lassen.'] },
  { name: 'Plank (Unterarmstütz)', machine: 'Freie Übung', group: 'bauch', equip: 'Körpergewicht', cue: 'Körper in einer Linie halten, Bauch und Gesäß fest.', pattern: 'core', steps: ['Unterarme und Zehen aufstellen, Ellenbogen unter den Schultern.', 'Körper in einer geraden Linie – Kopf, Rücken, Beine.', 'Bauch und Gesäß fest anspannen, gleichmäßig atmen.', 'Position halten, ohne ins Hohlkreuz zu fallen.'] },
  { name: 'Russian Twist', machine: 'Kurzhanteln', group: 'bauch', equip: 'Kurzhanteln', cue: 'Sitzend, Oberkörper leicht zurück, Gewicht seitlich tippen.', pattern: 'rotate', steps: ['Sitzen, Knie gebeugt, Oberkörper leicht zurücklehnen.', 'Eine Hantel mit beiden Händen vor dem Bauch halten.', 'Rumpf anspannen, das Gewicht seitlich neben die Hüfte tippen.', 'Kontrolliert zur anderen Seite – aus dem Rumpf, nicht den Armen.'] },

  // ── Ganzkörper / Functional ──
  { name: 'Kettlebell Swing', machine: 'Kugelhantel', group: 'ganzkoerper', equip: 'Kettlebell', cue: 'Kraft aus der Hüfte, Kettlebell bis Schulterhöhe schwingen.', pattern: 'hinge', steps: ['Hüftbreiter Stand, Kettlebell eine Fußlänge vor dir.', 'Hüfte nach hinten, Rücken gerade, Kettlebell zwischen die Beine schwingen.', 'Explosiv die Hüfte strecken – der Schwung hebt die Kettlebell bis Schulterhöhe.', 'Die Kraft kommt aus der Hüfte, nicht aus den Armen.'] },
  { name: 'Goblet-Kniebeuge', machine: 'Kugelhantel', group: 'ganzkoerper', equip: 'Kettlebell', cue: 'Kettlebell vor der Brust, tief in die Hocke.', pattern: 'squat', steps: ['Kettlebell mit beiden Händen vor der Brust halten.', 'Hüftbreiter Stand, Ellenbogen zeigen nach unten.', 'Tief in die Hocke, Rücken gerade, Brust hoch.', 'Über die Fersen nach oben drücken.'] },
  { name: 'Türkisches Aufstehen', machine: 'Kugelhantel', group: 'ganzkoerper', equip: 'Kettlebell', cue: 'Langsam vom Liegen zum Stand, Gewicht immer über dem Kopf.', pattern: 'carry', steps: ['Rückenlage, Kettlebell mit gestrecktem Arm nach oben, Blick zum Gewicht.', 'Schrittweise über Ellenbogen und Hand zum Sitz aufrichten.', 'In den Ausfallschritt und langsam zum Stand kommen – Gewicht immer oben.', 'Denselben Weg kontrolliert zurück. Erst ohne Gewicht üben.'] },
  { name: 'Rudern im Sling-Trainer', machine: 'Sling trainer', group: 'ganzkoerper', equip: 'Sling-Trainer', cue: 'Körper gerade, sich am Griff hochziehen.', pattern: 'pull-row', steps: ['Griffe fassen, Körper schräg nach hinten lehnen, Fersen fest.', 'Körper von Kopf bis Fuß gerade, Rumpf fest.', 'Sich an den Griffen zum Gerät hochziehen, Schulterblätter zusammen.', 'Langsam zurück in die gestreckte Position. Schwerer: Füße weiter vor.'] },
  { name: 'Liegestütz im Sling-Trainer', machine: 'Sling trainer', group: 'ganzkoerper', equip: 'Sling-Trainer', cue: 'Griffe schulterbreit, Körper gerade absenken und drücken.', pattern: 'press-fwd', steps: ['Griffe schulterbreit, Körper gerade nach vorn gelehnt.', 'Rumpf und Gesäß fest, Blick nach unten.', 'Körper zwischen die Griffe absenken, Ellenbogen ~45°.', 'Kraftvoll zurückdrücken, ohne ins Hohlkreuz zu fallen.'] },
  { name: 'Burpees', machine: 'Freie Übung', group: 'ganzkoerper', equip: 'Körpergewicht', cue: 'Kniebeuge → Liegestütz → Strecksprung, flüssig.', pattern: 'squat', steps: ['Aus dem Stand in die Hocke, Hände auf den Boden.', 'Füße nach hinten in die Liegestützposition springen.', 'Optional ein Liegestütz, dann die Füße zurück zur Hocke.', 'Explosiv nach oben strecken/springen. Tempo an dein Level anpassen.'] },
  { name: 'Farmers Carry', machine: 'Hexagon dumbbells', group: 'ganzkoerper', equip: 'Kurzhanteln', cue: 'Schwere Hanteln aufrecht tragen, Schultern zurück.', pattern: 'carry', steps: ['Zwei schwere Hanteln neben den Füßen, aus den Beinen aufnehmen.', 'Aufrecht stehen, Schultern zurück, Rumpf fest.', 'Kontrolliert geradeaus gehen, ruhige Schritte.', 'Nicht ins Hohlkreuz fallen, gleichmäßig atmen.'] },

  // ── Cardio ──
  { name: 'Laufband', machine: 'Run', group: 'cardio', equip: 'Cardio', cue: 'Gehen oder Laufen; für Intervalle Tempo/Steigung wechseln.', pattern: 'cardio', steps: ['Sicherheits-Clip anlegen, langsam starten.', 'Aufrecht gehen/laufen, locker aus der Hüfte.', 'Für Intervalle Tempo oder Steigung wechseln.', 'Zum Ende das Tempo langsam herausnehmen.'] },
  { name: 'Bike', machine: 'Bike', group: 'cardio', equip: 'Cardio', cue: 'Gleichmäßig treten; Programm „Abnehmen" steuert die Intensität automatisch.', pattern: 'cardio', steps: ['Sattelhöhe so einstellen, dass das Knie unten fast gestreckt ist.', 'Gleichmäßig treten, Oberkörper locker.', 'Widerstand/Programm nach Ziel wählen (Abnehmen steuert automatisch).', 'Trittfrequenz ruhig und konstant halten.'] },
  { name: 'Recline-Bike (Liegerad)', machine: 'Recline', group: 'cardio', equip: 'Cardio', cue: 'Rückenschonend im Sitzen – ideal für den Einstieg.', pattern: 'cardio', steps: ['Rückenlehne und Sitzabstand einstellen, bequem anlehnen.', 'Gleichmäßig treten, rückenschonend im Sitzen.', 'Widerstand moderat wählen – ideal für den Einstieg.', 'Ein konstantes Tempo halten.'] },
  { name: 'SkillRow (Rudern)', machine: 'Skillrow', group: 'cardio', equip: 'Cardio', cue: 'Ganzkörper-Cardio: Beine drücken, dann ziehen.', pattern: 'cardio', steps: ['Füße fixieren, Griff fassen, aufrecht sitzen.', 'Zuerst mit den Beinen abdrücken.', 'Dann Oberkörper leicht zurück und mit den Armen zum Bauch ziehen.', 'In umgekehrter Reihenfolge zurück – Arme, Oberkörper, Beine.'] },
  { name: 'SkillMill / Climb', machine: 'Climb', group: 'cardio', equip: 'Cardio', cue: 'Intensives Ausdauer-/Intervalltraining ohne Motor.', pattern: 'cardio', steps: ['Am Griff festhalten, langsam anlaufen.', 'Aufrechte Haltung, Tempo selbst über die eigene Kraft steuern.', 'Für Intervalle das Tempo bewusst wechseln.', 'Ohne Motor – die Intensität kommt von dir.'] },
  { name: 'Vario (Crosstrainer)', machine: 'Vario', group: 'cardio', equip: 'Cardio', cue: 'Gelenkschonend, gleichmäßiger Bewegungsfluss.', pattern: 'cardio', steps: ['Auf die Pedale steigen, Griffe fassen.', 'Gleichmäßiger, runder Bewegungsfluss – gelenkschonend.', 'Widerstand nach Ziel wählen.', 'Oberkörper aufrecht, ruhig atmen.'] },

  // ── Beweglichkeit ──
  { name: 'Faszienrolle unterer Rücken', machine: 'Schaumstoffrolle', group: 'mobility', equip: 'Faszienrolle', cue: 'Langsam hin und her rollen, verspannte Stellen halten.', pattern: 'stretch', steps: ['Rolle unter den unteren Rücken/das Gesäß legen, aufstützen.', 'Langsam über die verspannten Stellen hin und her rollen.', 'Auf einem Druckpunkt kurz verweilen und ausatmen.', 'Nicht direkt auf der Wirbelsäule rollen.'] },
  { name: 'Katze-Kuh', machine: 'Freie Übung', group: 'mobility', equip: 'Körpergewicht', cue: 'Im Vierfüßlerstand Rücken abwechselnd runden und strecken.', pattern: 'stretch', steps: ['Vierfüßlerstand, Hände unter den Schultern, Knie unter der Hüfte.', 'Einatmen: Rücken sanft ins Hohlkreuz, Blick leicht nach oben.', 'Ausatmen: Rücken runden, Kinn zur Brust.', 'Langsam im Atemrhythmus wechseln.'] },
  { name: 'Hüftbeuger-Dehnung', machine: 'Stretching', group: 'mobility', equip: 'Dehnung', cue: 'Ausfallschritt, hinterer Hüftbeuger dehnt – ruhig atmen.', pattern: 'stretch', steps: ['In den Ausfallschritt gehen, hinteres Knie ablegen.', 'Becken leicht nach vorn schieben, Oberkörper aufrecht.', 'Dehnung im vorderen Bereich der hinteren Hüfte spüren.', 'Ruhig atmen, Position halten, Seite wechseln.'] },
  { name: 'Vierfüßler diagonal (Bird Dog)', machine: 'Freie Übung', group: 'mobility', equip: 'Körpergewicht', cue: 'Gegenüberliegenden Arm und Bein strecken, Rumpf stabil.', pattern: 'core', steps: ['Vierfüßlerstand, Rumpf fest, Rücken gerade.', 'Gegenüberliegenden Arm und Bein gleichzeitig strecken.', 'Kurz halten, das Becken bleibt stabil (nicht kippen).', 'Kontrolliert zurück, Seite wechseln.'] },
  { name: 'Mobility Ball Schulter', machine: 'Mobility ball', group: 'mobility', equip: 'Mobility Ball', cue: 'Verspannte Schulter-/Brustmuskeln sanft ausrollen.', pattern: 'stretch', steps: ['Ball zwischen Schulter/Brust und Wand oder Boden platzieren.', 'Sanft Druck aufbauen, verspannte Stellen suchen.', 'Kleine Bewegungen, auf Druckpunkten kurz verweilen.', 'Ruhig atmen, nicht in den Schmerz drücken.'] },
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
  // Schritt-für-Schritt-Anleitung + Bewegungsmuster (nur Nicht-KI-Übungen; KI-Geräte führen selbst).
  steps: Array.isArray(e.steps) ? e.steps : [], pattern: e.pattern || '',
}));

// ── Muskel-Info je Gruppe (für die Übungs-Detailansicht: „welche Muskeln + Beschreibung") ──
// regions = Schlüssel, die das Front-/Back-Körperdiagramm im Client einfärbt.
const MUSCLES = {
  brust: { primary: 'Brustmuskulatur, vordere Schulter, Trizeps', regions: ['chest', 'delts', 'triceps'], desc: 'Trainiert die Brust als großen „Druck-Muskel“ – wichtig für Kraft beim Drücken, eine aufrechte Haltung und einen definierten Oberkörper.' },
  ruecken: { primary: 'Latissimus, oberer & unterer Rücken, hintere Schulter', regions: ['lats', 'traps', 'lowerback'], desc: 'Kräftigt den gesamten Rücken – die Basis für eine gesunde, aufrechte Haltung und ein Gegengewicht zum vielen Sitzen.' },
  schulter: { primary: 'Schultern (Deltamuskel), Nacken', regions: ['delts', 'traps'], desc: 'Formt runde, stabile Schultern und stärkt sie für alle Über-Kopf-Bewegungen im Alltag und Sport.' },
  arme: { primary: 'Bizeps, Trizeps, Unterarme', regions: ['biceps', 'triceps', 'forearms'], desc: 'Kräftigt Ober- und Unterarme – für mehr Zug- und Druckkraft und einen definierten Arm.' },
  beine: { primary: 'Oberschenkel (vorne & hinten), Waden', regions: ['quads', 'hams', 'calves'], desc: 'Trainiert die größten Muskeln des Körpers – das verbrennt viele Kalorien und macht dich im Alltag belastbar.' },
  po: { primary: 'Gesäßmuskulatur, hintere Oberschenkel', regions: ['glutes', 'hams'], desc: 'Stärkt Gesäß und Beinrückseite – gut für Kraft aus der Hüfte, einen geformten Po und einen gesunden unteren Rücken.' },
  bauch: { primary: 'Gerade & seitliche Bauchmuskeln, Core', regions: ['abs', 'obliques'], desc: 'Kräftigt die Körpermitte – deine Stabilität für jede Übung und ein Schutz für den unteren Rücken.' },
  ganzkoerper: { primary: 'Ganzkörper – mehrere große Muskelgruppen', regions: ['fullbody'], desc: 'Fordert mehrere Muskelgruppen gleichzeitig – effizient für Kraft, Koordination und Kalorienverbrauch.' },
  cardio: { primary: 'Herz-Kreislauf-System, Beine', regions: ['heart', 'quads', 'calves'], desc: 'Trainiert Herz und Kreislauf – verbessert Ausdauer, Regeneration und unterstützt den Fettstoffwechsel.' },
  mobility: { primary: 'Beweglichkeit, Faszien, Gelenke', regions: ['fullbody'], desc: 'Hält Muskeln und Gelenke geschmeidig – beugt Verspannungen vor und verbessert deine Bewegungsqualität.' },
};
function muscleInfo(group) { return MUSCLES[group] || MUSCLES.ganzkoerper; }

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

// Heuristik-Regeln (Reihenfolge zählt) – IDENTISCH zur Client-Heuristik in mitglieder.html,
// damit Server (Plan-Generierung) und Client dieselbe Muskelgruppe herleiten.
const GROUP_RULES = [
  ['cardio', /lauf|treadmill|bike|rad |skill|climb|vario|crosstrainer|cardio|recline|ellip/],
  ['brust', /brust|chest|bankdr|butterfly|pectoral|fliegende/],
  ['ruecken', /rucken|lat |latzug|rudern|\brow\b|klimmz|reverse fly|rear delt|zug/],
  ['schulter', /schulter|shoulder|seitheben|frontheben|face pull|nacken|delt|uberkopf/],
  ['arme', /bizeps|trizeps|curl|arm ext|arm curl|hammer|stirndr|dips/],
  ['po', /hip thrust|glute|gesass|abduzt|adduzt|abductor|adductor|kickback|beckenheb|huftstreck/],
  ['beine', /bein|leg|knieb|squat|ausfall|kreuzheb|wade|calf|lunge/],
  ['bauch', /bauch|crunch|core|plank|beinheb|russian|rumpf|abdominal|torso/],
  ['mobility', /faszien|dehn|katze|mobility|stretch|bird dog|vierfussl/],
  ['ganzkoerper', /kettlebell|swing|goblet|burpee|farmer|sling|turkisch/],
];
function isGroup(g) { return !!GROUP_LABEL[g]; }
// Muskelgruppe zu Name/Gerät auflösen: exakter DB-Treffer (Name+Gerät) → Name-Treffer → Heuristik → '' (unbekannt).
function groupOf(name, machine) {
  const nn = norm(name); if (!nn) return '';
  const mm = norm(machine || '');
  let hit = LIST.find((e) => norm(e.name) === nn && (!mm || norm(e.machine) === mm));
  if (hit) return hit.group;
  hit = LIST.find((e) => norm(e.name) === nn);
  if (hit) return hit.group;
  // Heuristik: erst nur am Namen (stärkstes Signal), dann Name+Gerät. Generische Gerätenamen
  // (z. B. „Kabelzug", „Multipower") sollen die Gruppe NICHT dominieren.
  for (let i = 0; i < GROUP_RULES.length; i++) { if (GROUP_RULES[i][1].test(nn)) return GROUP_RULES[i][0]; }
  const s = nn + ' ' + mm;
  for (let i = 0; i < GROUP_RULES.length; i++) { if (GROUP_RULES[i][1].test(s)) return GROUP_RULES[i][0]; }
  return '';
}
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

module.exports = { GROUPS, GROUP_LABEL, MUSCLES, muscleInfo, groupOf, isGroup, publicList, getById, search };
