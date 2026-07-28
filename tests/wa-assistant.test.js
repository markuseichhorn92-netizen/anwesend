'use strict';
// Prüft die Eskalations-Erkennung der WhatsApp-KI (lib/waAssistant.js): heikle bzw.
// nach außen wirkende Themen dürfen NICHT automatisch beantwortet, sondern müssen an
// einen Menschen übergeben werden – normale Auskunfts-/Coach-Fragen dagegen nicht.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // waAssistant lädt lib/members nur wegen createSession/destroySession – für die
  // Eskalations-Prüfung nicht nötig, daher ein schlanker Stub.
  inject('lib/members.js', { createSession: async () => 't', destroySession: async () => {} });
  const WA = require('../lib/waAssistant');

  const escalate = [
    'Ich möchte meinen Vertrag kündigen',
    'Wie kann ich widerrufen?',
    'Ich habe eine Beschwerde über das Studio',
    'Bei mir wurde doppelt abgebucht',
    'Ich will meine IBAN ändern',
    'Könnt ihr mir das Geld zurückerstatten?',
    'Ich habe eine Mahnung bekommen',
    'Kann ich bitte einen Mitarbeiter sprechen?',
    'Ruft mich bitte an',
  ];
  let missEsc = [];
  escalate.forEach((t) => { if (!WA.needsEscalation(t)) missEsc.push(t); });
  ok('1. Heikle/aktionale Themen werden eskaliert', missEsc.length === 0, missEsc.join(' | '));

  const normal = [
    'Wann ist mein nächster Termin?',
    'Wie viel Eiweiß sollte ich am Tag essen?',
    'Welchen Tarif habe ich?',
    'Wie oft war ich diesen Monat da?',
    'Gib mir bitte einen Trainingstipp für Rücken',
    'Wie sind eure Öffnungszeiten?',
  ];
  let wrongEsc = [];
  normal.forEach((t) => { if (WA.needsEscalation(t)) wrongEsc.push(t); });
  ok('2. Normale Auskunfts-/Coach-Fragen werden NICHT eskaliert', wrongEsc.length === 0, wrongEsc.join(' | '));

  ok('3. Leere Nachricht ist keine Eskalation', WA.needsEscalation('') === false);
  ok('4. answer() liefert bei fehlender Basis sauber ok:false', (await WA.answer({ memberId: '1', question: 'hallo' })).ok === false);

  console.log(pass ? 'WA-ASSISTANT PASS' : 'WA-ASSISTANT FAIL');
  process.exit(pass ? 0 : 1);
}
run();
