'use strict';
// Postfach-Anhänge (Mitglied -> Studio): nur Bilder, harte Größengrenze, Anzahl je Vorgang
// begrenzt. Der Typ wird aus dem data:-Präfix gelesen und NICHT dem Client geglaubt.
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  const kv = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') { const k = String(c[1]); return kv.has(k) ? kv.get(k) : null; }
    if (op === 'SET') { kv.set(String(c[1]), c[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(String(c[1])); return 1; }
    if (op === 'MGET') return c.slice(1).map((k) => (kv.has(String(k)) ? kv.get(String(k)) : null));
    if (op === 'KEYS') return [];
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });
  inject('lib/push.js', { sendToTeam: async () => {}, sendToMember: async () => {} });
  const Inbox = require(path.resolve(ROOT, 'lib/inbox.js'));

  const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(400);
  const v0 = await Inbox.addVorgang('m1', { type: 'frage', subject: 'App-Feedback', text: 'Hallo' });
  ok('0. Vorgang angelegt', !!(v0 && v0.id));

  // 1) Gültiges Bild wird angehängt
  let v = await Inbox.reply('m1', v0.id, 'Screenshot anbei', { name: 'shot.jpg', data: IMG });
  let last = v.messages[v.messages.length - 1];
  ok('1. Bild-Anhang gespeichert', !!last.att && last.att.kind === 'image' && last.att.mime === 'image/jpeg');
  ok('2. Nachrichtentext bleibt erhalten', last.text === 'Screenshot anbei');

  // 2) Nicht-Bilder werden verworfen (Nachricht geht trotzdem durch)
  v = await Inbox.reply('m1', v0.id, 'PDF-Versuch', { name: 'x.pdf', data: 'data:application/pdf;base64,AAAA' });
  last = v.messages[v.messages.length - 1];
  ok('3. PDF wird verworfen, Nachricht bleibt', !last.att && last.text === 'PDF-Versuch');
  v = await Inbox.reply('m1', v0.id, 'SVG-Versuch', { name: 'x.svg', data: 'data:image/svg+xml;base64,AAAA' });
  last = v.messages[v.messages.length - 1];
  ok('4. SVG (Script-Risiko) wird verworfen', !last.att);
  v = await Inbox.reply('m1', v0.id, 'Fremd-URL', { name: 'x.jpg', data: 'https://example.com/bild.jpg' });
  last = v.messages[v.messages.length - 1];
  ok('5. Externe URL wird verworfen', !last.att);
  v = await Inbox.reply('m1', v0.id, 'Falscher Typ behauptet', { name: 'x.jpg', mime: 'image/jpeg', data: 'data:text/html;base64,AAAA' });
  last = v.messages[v.messages.length - 1];
  ok('6. Behaupteter Typ zählt nicht, nur das data:-Präfix', !last.att);

  // 3) Größengrenze
  v = await Inbox.reply('m1', v0.id, 'Riesenbild', { name: 'big.jpg', data: 'data:image/png;base64,' + 'A'.repeat(800000) });
  last = v.messages[v.messages.length - 1];
  ok('7. Zu großes Bild wird verworfen', !last.att);

  // 4) Anzahl je Vorgang begrenzt (6)
  for (let i = 0; i < 8; i++) v = await Inbox.reply('m1', v0.id, 'Bild ' + i, { name: 'b.jpg', data: IMG });
  const attCount = v.messages.filter((m) => m && m.att).length;
  ok('8. Höchstens 6 Anhänge je Vorgang', attCount === 6);

  // 5) Team-Backend zeigt den Anhang, Mitglieder-App ebenfalls
  const team = fs.readFileSync(path.resolve(ROOT, 'team-backend.html'), 'utf8');
  const member = fs.readFileSync(path.resolve(ROOT, 'mitglieder.html'), 'utf8');
  ok('9. Team-Backend rendert den Anhang', /m\.att&&m\.att\.data/.test(team) && /Anhang des Mitglieds/.test(team));
  ok('10. Mitglieder-App zeigt den eigenen Anhang', /mm\.att&&mm\.att\.data/.test(member));
  ok('11. Mitglieder-App hat einen Anhang-Button', /__pfAttPick/.test(member));

  console.log(pass ? 'INBOX-ATTACHMENT PASS' : 'INBOX-ATTACHMENT FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
