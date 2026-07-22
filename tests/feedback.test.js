'use strict';
// App-Feedback (lib/feedback.js): Anonymisierung (keine PII in der Meta),
// Kategorie-/Text-Säuberung und der Speicher-Roundtrip (submit -> list -> status -> delete)
// mit In-Memory-KV-Mock. Kein Netzwerk.

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));

const KV = new Map();
const SETS = new Map();
function fakePipeline(cmds) {
  return Promise.resolve((cmds || []).map((c) => {
    const op = String(c[0]).toUpperCase(), key = c[1];
    if (op === 'GET') return KV.has(key) ? KV.get(key) : null;
    if (op === 'SET') { KV.set(key, c[2]); return 'OK'; }
    if (op === 'DEL') { const had = KV.delete(key) || SETS.delete(key); return had ? 1 : 0; }
    if (op === 'SREM') { const s = SETS.get(key); if (s) s.delete(c[2]); return 1; }
    if (op === 'SADD') { const s = SETS.get(key) || new Set(); const b = s.size; s.add(c[2]); SETS.set(key, s); return s.size - b; }
    if (op === 'SMEMBERS') { return Array.from(SETS.get(key) || []); }
    return null;
  }));
}
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { hasStore: true, redisPipeline: fakePipeline } };

const FB = require(path.join(ROOT, 'lib/feedback.js'));

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 0. Verdrahtung (Endpunkte + UI) vorhanden – schützt vor versehentlichem Entfernen.
  const fs = require('fs');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok('0. Member-Endpoint da', fs.existsSync(path.join(ROOT, 'api/member/feedback.js')));
  ok('0b. Team-Endpoint da', fs.existsSync(path.join(ROOT, 'api/team/feedback.js')));
  const mem = read('mitglieder.html');
  ok('0c. Startseiten-Banner', mem.includes('function feedbackBanner()') && mem.includes("data-act=\"fbOpen\""));
  ok('0d. Banner eingehängt', mem.includes("sec('App verbessern', feedbackBanner())"));
  ok('0e. Sendet an /api/member/feedback', mem.includes("api('/api/member/feedback'"));
  ok('0f. Endpoint anonymisiert (keine memberId gespeichert)', !read('api/member/feedback.js').match(/submit\([^)]*id\s*:/));
  const team = read('team-backend.html');
  ok('0g. Team-Screen', team.includes('function feedbackNode()') && team.includes("navItem('feedback'"));
  ok('0h. „Für Claude kopieren"', team.includes('data-fbcopy') && team.includes('fbReport'));
  ok('0i. Team ruft /api/team/feedback', team.includes("tapi('/api/team/feedback'"));


  // 1. Anonymisierung: PII fliegt NIE in der gespeicherten Meta.
  const rec = FB.buildRecord({
    category: 'BUG', text: 'oben klebt der Kopf',
    meta: { platform: 'android', device: 'SM-S911B', os: 'Android 14', screen: 'home', ua: 'x'.repeat(400),
      memberId: 'M-123', email: 'a@b.de', name: 'Melanie', evil: 'drop', online: true, dpr: '2' },
  });
  ok('1. Kategorie normalisiert (BUG->bug)', rec.category === 'bug');
  ok('1b. keine memberId/email/name/evil in Meta', !('memberId' in rec.meta) && !('email' in rec.meta) && !('name' in rec.meta) && !('evil' in rec.meta));
  ok('1c. erlaubte Meta übernommen', rec.meta.platform === 'android' && rec.meta.device === 'SM-S911B' && rec.meta.screen === 'home');
  ok('1d. UA gekappt (<=300)', rec.meta.ua.length === 300);
  ok('1e. dpr numerisch, online bool', rec.meta.dpr === 2 && rec.meta.online === true);
  ok('1f. Datensatz ohne Personenbezug', !('memberId' in rec) && !('email' in rec) && !('name' in rec) && rec.status === 'new');

  // 2. Text: leer bleibt leer, unbekannte Kategorie -> sonstiges.
  ok('2. leerer Text -> leer', FB.buildRecord({ text: '   ' }).text === '');
  ok('2b. unbekannte Kategorie -> sonstiges', FB.buildRecord({ text: 'x', category: 'quatsch' }).category === 'sonstiges');

  // 3. Speicher-Roundtrip: zwei Feedbacks -> Liste (neueste zuerst) + open-Zähler.
  const a = await FB.submit({ text: 'erstes', category: 'idee', meta: { platform: 'ios' } });
  await new Promise((r) => setTimeout(r, 3)); // sichere zeitliche Reihenfolge (ID-Präfix = ms)
  const b = await FB.submit({ text: 'zweites', category: 'bug', meta: { platform: 'android' } });
  ok('3. beide gespeichert', a.ok && b.ok && a.id && b.id && a.id !== b.id);
  const l1 = await FB.list({ limit: 50 });
  ok('3b. Liste enthält beide', l1.total === 2 && l1.items.length === 2);
  ok('3c. neueste zuerst', l1.items[0].text === 'zweites' && l1.items[1].text === 'erstes');
  ok('3d. open-Zähler = 2', l1.open === 2);

  // 4. leerer Text wird gar nicht gespeichert.
  const emptyRes = await FB.submit({ text: '  ' });
  ok('4. leeres Feedback abgelehnt', emptyRes.ok === false && emptyRes.error === 'empty');
  ok('4b. Liste unverändert', (await FB.list()).total === 2);

  // 5. Status auf done -> open sinkt.
  const st = await FB.setStatus(b.id, 'done');
  ok('5. status done gesetzt', st.ok && st.item.status === 'done' && st.item.doneAt);
  const l2 = await FB.list();
  ok('5b. open jetzt 1', l2.open === 1);
  ok('5c. unbekannte id -> not_found', (await FB.setStatus('gibtsnicht', 'done')).error === 'not_found');

  // 6. löschen -> aus Liste raus.
  const del = await FB.remove(a.id);
  ok('6. gelöscht', del.ok === true);
  const l3 = await FB.list();
  ok('6b. nur noch 1 gesamt', l3.total === 1 && l3.items.length === 1 && l3.items[0].id === b.id);

  console.log(pass ? 'FEEDBACK PASS' : 'FEEDBACK FAIL');
  process.exit(pass ? 0 : 1);
}
run();
