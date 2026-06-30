'use strict';

/**
 * Sport-Blog für den Mitgliederbereich – kuratierte Beiträge (Training,
 * Ernährung, Motivation, Gesundheit). Aktuell statisch gepflegt; bewusst als
 * eigenes Modul, damit die Inhalte später ohne Frontend-Änderung (z. B. über das
 * Team-Backend / KV) editierbar gemacht werden können.
 *
 * Jeder Beitrag: { id, title, cat, mins, grad, tag, excerpt, body[] }
 *   grad  = CSS-Verlauf für den Karten-Header
 *   tag   = Textfarbe der Kategorie-Pille
 *   body  = Array von Absätzen (reiner Text)
 */

const POSTS = [
  {
    id: 'konstanz',
    title: '5 Tipps für mehr Konstanz im Training',
    cat: 'Motivation', mins: '3 Min',
    grad: 'linear-gradient(150deg,#F6A964,#E07C3C)', tag: '#b5631f',
    excerpt: 'Dranbleiben ist schwerer als anfangen. So machst du Training zur Gewohnheit.',
    body: [
      'Der schwierigste Teil am Training ist selten die Übung selbst – es ist das Dranbleiben. Wer ein paar einfache Prinzipien beherzigt, macht aus guten Vorsätzen eine echte Gewohnheit.',
      '1. Feste Termine: Trag dein Training wie einen wichtigen Termin in den Kalender ein. Was einen festen Platz hat, fällt seltener aus.',
      '2. Klein anfangen: Lieber 3× pro Woche 30 Minuten als einmal zwei Stunden. Konstanz schlägt Intensität – immer.',
      '3. Wunschzeit vormerken: Plane in der App deine Lieblingszeit, dann ist der Vorsatz schon halb umgesetzt.',
      '4. Trainingspartner: Zu zweit sagt man seltener ab. Wen könntest du mitnehmen?',
      '5. Fortschritt sichtbar machen: Deine Vitalpunkte und deine Wochen-Streak in der App zeigen dir schwarz auf weiß, dass sich dein Einsatz lohnt. 💪',
    ],
  },
  {
    id: 'aufwaermen',
    title: 'Richtig aufwärmen – in nur 5 Minuten',
    cat: 'Training', mins: '2 Min',
    grad: 'linear-gradient(150deg,#43BE6B,#1F9A4E)', tag: '#176b37',
    excerpt: 'Ein kurzes Warm-up beugt Verletzungen vor und macht jede Übung effektiver.',
    body: [
      'Aufwärmen wird oft übersprungen – dabei reichen schon 5 Minuten, um Verletzungen vorzubeugen und mehr aus jedem Satz herauszuholen.',
      'Starte mit 2–3 Minuten leichter Bewegung (Crosstrainer, Rudergerät oder zügiges Gehen), um den Kreislauf in Schwung zu bringen.',
      'Dann mobilisiere gezielt die Gelenke, die du gleich beanspruchst: Schulterkreisen, Hüftöffner, ein paar leichte Kniebeugen ohne Gewicht.',
      'Zum Schluss ein bis zwei „Aufwärmsätze" mit leichtem Gewicht bei deiner ersten Übung. So weiß dein Körper, was kommt – und du bist bereit für die Arbeitssätze.',
    ],
  },
  {
    id: 'eiweiss',
    title: 'Eiweiß: Wie viel brauchst du wirklich?',
    cat: 'Ernährung', mins: '4 Min',
    grad: 'linear-gradient(150deg,#4E86E8,#2C5FB8)', tag: '#2C5FB8',
    excerpt: 'Protein ist der Baustein für Muskeln. Aber mehr ist nicht automatisch besser.',
    body: [
      'Eiweiß liefert die Bausteine, aus denen dein Körper Muskeln aufbaut und repariert. Wer trainiert, hat einen leicht erhöhten Bedarf – aber „viel hilft viel" stimmt hier nicht.',
      'Als Richtwert gelten für aktive Menschen etwa 1,4 bis 1,8 Gramm Eiweiß pro Kilogramm Körpergewicht am Tag. Bei 75 kg sind das grob 105–135 g.',
      'Verteile die Menge über den Tag auf mehrere Mahlzeiten – das nutzt der Körper besser, als alles auf einmal. Gute Quellen: Quark, Eier, Hülsenfrüchte, Fisch, Geflügel, Tofu.',
      'Ein Eiweißshake ist praktisch, aber kein Muss: Mit einer ausgewogenen Ernährung erreichst du deinen Bedarf meist auch ohne Pulver.',
    ],
  },
  {
    id: 'regeneration',
    title: 'Schlaf & Regeneration: dein unterschätzter Geheimtipp',
    cat: 'Gesundheit', mins: '3 Min',
    grad: 'linear-gradient(150deg,#8E7BF0,#5B47C9)', tag: '#5B47C9',
    excerpt: 'Muskeln wachsen nicht im Training, sondern in der Erholung danach.',
    body: [
      'Viele konzentrieren sich nur auf das Training – dabei passiert der eigentliche Fortschritt in der Erholung. Im Schlaf repariert dein Körper das Gewebe und baut Muskeln auf.',
      'Sieben bis neun Stunden Schlaf sind für die meisten ideal. Schon eine Nacht zu wenig senkt Kraft, Konzentration und Motivation spürbar.',
      'Plane bewusst Ruhetage ein. Wer jeden Tag Vollgas gibt, riskiert Übertraining – Leistung und Lust sinken, statt zu steigen.',
      'Kleine Helfer für die Erholung: ausreichend trinken, eiweißreich essen und nach dem Training ein paar Minuten locker auslaufen oder dehnen.',
    ],
  },
];

function list() { return POSTS.map(function (p) { return { id: p.id, title: p.title, cat: p.cat, mins: p.mins, grad: p.grad, tag: p.tag, excerpt: p.excerpt }; }); }
function get(id) { return POSTS.find(function (p) { return p.id === String(id); }) || null; }

module.exports = { POSTS, list, get };
