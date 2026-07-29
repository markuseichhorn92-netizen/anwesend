'use strict';
// Prüft die anbieterneutrale Formung anklickbarer WhatsApp-Auswahlen (Buttons/Liste)
// über lib/whatsapp.metaInteractive sowie das Einlesen angetippter Antworten
// (interactive.button_reply / list_reply bei Meta). Rein, ohne Netz/Provider-Env.
const WA = require('../lib/whatsapp');

function run() {
  let pass = true;
  const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── metaInteractive(): bis 3 Optionen -> Buttons ──
  const btn = WA.metaInteractive({ body: 'Welche Einweisung?', options: [{ id: 'opt_1', title: 'Einführungstraining' }, { id: 'opt_2', title: 'Biocircuit' }, { id: 'opt_3', title: 'Trainingsplanung' }] });
  ok('1. Buttons-Typ bei ≤3 Optionen', !!btn && btn.type === 'button', JSON.stringify(btn));
  ok('2. Body-Text gesetzt', !!btn && btn.body && btn.body.text === 'Welche Einweisung?');
  ok('3. 3 Reply-Buttons mit id + Titel', !!btn && btn.action.buttons.length === 3 && btn.action.buttons[1].reply.id === 'opt_2' && btn.action.buttons[1].reply.title === 'Biocircuit', JSON.stringify(btn && btn.action));
  // Button-Titel auf 20 Zeichen begrenzt (WhatsApp-Limit)
  ok('4. Button-Titel ≤20 Zeichen', !!btn && btn.action.buttons.every((b) => b.reply.title.length <= 20), JSON.stringify(btn && btn.action.buttons.map((b) => b.reply.title)));

  // ── metaInteractive(): >3 Optionen -> Liste ──
  const list = WA.metaInteractive({ body: 'Wähle einen Termin', options: ['Mo 10:00', 'Di 14:00', 'Mi 09:00', 'Do 18:00', 'Fr 12:00'] });
  ok('5. Listen-Typ bei >3 Optionen', !!list && list.type === 'list', JSON.stringify(list));
  ok('6. Liste hat Button-Label + 5 Zeilen', !!list && list.action.button === 'Auswählen' && list.action.sections[0].rows.length === 5);
  ok('7. Zeilen-ids stabil', !!list && list.action.sections[0].rows[0].id === 'opt_1' && list.action.sections[0].rows[4].id === 'opt_5');

  // ── Ungültige Auswahl -> null ──
  ok('8. <2 Optionen -> null', WA.metaInteractive({ body: 'x', options: ['nur eins'] }) === null);
  ok('9. leerer Body -> null', WA.metaInteractive({ body: '', options: ['a', 'b'] }) === null);

  // ── parseInbound(): angetippte Button-/Listen-Antwort wird als Text gelesen ──
  const fromButton = WA.parseInbound({ entry: [{ changes: [{ value: { messages: [{ from: '4915100', id: 'wamid.1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'opt_2', title: 'Biocircuit' } } }] } }] }] });
  ok('10. Button-Antwort -> Titel als text', fromButton.length === 1 && fromButton[0].text === 'Biocircuit', JSON.stringify(fromButton));
  const fromList = WA.parseInbound({ entry: [{ changes: [{ value: { messages: [{ from: '4915100', id: 'wamid.2', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'opt_3', title: 'Di 14:00' } } }] } }] }] });
  ok('11. Listen-Antwort -> Titel als text', fromList.length === 1 && fromList[0].text === 'Di 14:00', JSON.stringify(fromList));

  // ── parseTwilioInbound(): angetippter Quick-Reply-Button (Body / ButtonText) ──
  const twBtn = WA.parseTwilioInbound({ From: 'whatsapp:+4915100', Body: '', ButtonText: 'Biocircuit', MessageSid: 'SM1' });
  ok('12. Twilio ButtonText greift bei leerem Body', twBtn.length === 1 && twBtn[0].text === 'Biocircuit', JSON.stringify(twBtn));

  console.log(pass ? 'WA-WHATSAPP PASS' : 'WA-WHATSAPP FAIL');
  process.exit(pass ? 0 : 1);
}
run();
