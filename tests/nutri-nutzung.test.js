'use strict';
// Wie viele Menschen protokollieren ihr Essen?
//
// Die Zahl wird nicht mitgezählt, sondern aus dem Bestand abgeleitet. Das ist
// robuster (ein vergessener Zählpunkt kann nicht driften), verschiebt die
// Sorgfalt aber ins Ableiten. Genau da prueft dieser Test:
//
//   - „nutzt es" heisst mind. ein LEBENSMITTEL-Eintrag. Ein angetipptes
//     Wasserglas ist kein Protokoll - sonst schoent sich die Zahl selbst.
//   - Der Durchlauf ueber den Schluesselraum muss FORTSETZBAR sein, sonst gibt
//     es bei vielen Schluesseln nie ein Ergebnis.
//   - Und das Wichtigste: im Ergebnis darf keine einzige Kennung stehen.
//     Ernaehrung ist ein Gesundheitsdatum (Art. 9 DSGVO); eine Auswertung, aus
//     der sich „diese Person protokolliert" ablesen laesst, waere schlimmer als
//     gar keine.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
};
const frisch = (rel) => { delete require.cache[path.resolve(ROOT, rel)]; return require(path.resolve(ROOT, rel)); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── Speicher nachbauen: SCAN (mit Cursor + MATCH), MGET, GET, SET, DEL ──
const daten = new Map();
let scanBatch = 3;        // absichtlich winzig: erzwingt mehrere Runden
let scanRunden = 0;
function musterZuRegex(m) {
  return new RegExp('^' + String(m).replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : '\\' + c)) + '$');
}
const redisPipeline = async (cmds) => cmds.map((c) => {
  const op = String(c[0]).toUpperCase();
  if (op === 'SCAN') {
    scanRunden++;
    const von = parseInt(c[1], 10) || 0;
    const alle = Array.from(daten.keys());
    const teil = alle.slice(von, von + scanBatch);
    const weiter = (von + scanBatch >= alle.length) ? 0 : (von + scanBatch);
    const mi = c.indexOf('MATCH');
    const rx = musterZuRegex(mi >= 0 ? c[mi + 1] : '*');
    return [String(weiter), teil.filter((k) => rx.test(k))];
  }
  if (op === 'MGET') return c.slice(1).map((k) => (daten.has(String(k)) ? daten.get(String(k)) : null));
  if (op === 'GET') return daten.has(String(c[1])) ? daten.get(String(c[1])) : null;
  if (op === 'SET') { daten.set(String(c[1]), String(c[2])); return 'OK'; }
  if (op === 'DEL') { daten.delete(String(c[1])); return 1; }
  if (op === 'EXPIRE') return 1;
  return 0;
});
inject('lib/store.js', { hasStore: true, redisPipeline: redisPipeline });

const NU = frisch('lib/nutriUsage.js');
const HEUTE = NU.berlinHeute();
const tagVor = (n) => new Date(Date.parse(HEUTE + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const essen = (n) => JSON.stringify({ entries: Array.from({ length: n }, (_, i) => ({ id: 'e' + i, kcal: 100 })), water: 2 });

// ── Der Bestand, aus dem die Zahl entstehen muss ──
// mAnna protokolliert regelmaessig, mBen einmal heute, mCarla hat nur Wasser
// angetippt, mDirk hat vor Monaten aufgehoert.
[0, 1, 2, 3, 4, 5].forEach((o) => daten.set('nutri:d:mAnna:' + tagVor(o), essen(2)));
daten.set('nutri:d:mBen:' + tagVor(0), essen(1));
daten.set('nutri:d:mCarla:' + tagVor(2), JSON.stringify({ entries: [], water: 6 }));
daten.set('nutri:d:mDirk:' + tagVor(40), essen(3));
['mAnna', 'mBen', 'mCarla'].forEach((id) => daten.set('nutri:p:' + id, JSON.stringify({ onboarded: true, goal: 'halten' })));
daten.set('nutri:p:mDirk', JSON.stringify({ onboarded: false }));
// Nachbarschluessel mit aehnlichem Praefix – sie duerfen nicht mitgezaehlt werden.
daten.set('nutri:prem:mAnna', '{"premium":true}');
daten.set('nutri:q:mAnna:2026-09', '3');
daten.set('nutri:fav:mAnna', '[]');
daten.set('nutri:phidx', 'mAnna');
daten.set('inbox:mAnna', '[]');

async function run() {
  // ── 1. Vor dem ersten Durchlauf gibt es bewusst nichts ──
  ok('1. Ohne Durchlauf kein Ergebnis', (await NU.lesen()) === null);

  // ── 2. Der Durchlauf ist fortsetzbar ──
  // Ohne das gaebe es bei einem grossen Schluesselraum nie eine Zahl: die
  // Funktion waere vorher abgelaufen.
  let schritte = 0, r = null;
  do { r = await NU.weiter({ runden: 1 }); schritte++; } while (!r.fertig && schritte < 50);
  ok('2. Der Durchlauf wird ueber mehrere Aufrufe fertig', r.fertig === true && schritte > 1, 'Schritte: ' + schritte);
  ok('2b. … und hat dabei wirklich mehrfach gescannt', scanRunden >= schritte, String(scanRunden));
  ok('2c. … und raeumt seinen Zwischenstand weg', !daten.has(NU.RUN));

  const e = r.ergebnis;
  ok('3. Am Ende steht ein Ergebnis', !!e && e.vollstaendig === true, JSON.stringify(e));
  ok('3b. … und es ist auch gespeichert', JSON.stringify(await NU.lesen()) === JSON.stringify(e));

  // ── 3. Die eigentliche Frage ──
  ok('4. Zwei Personen haben in 30 Tagen protokolliert', e.aktiv.d30 === 2, JSON.stringify(e.aktiv));
  ok('4b. … beide auch heute', e.aktiv.d1 === 2 && e.aktiv.d7 === 2, JSON.stringify(e.aktiv));
  ok('4c. … eine davon regelmaessig (5+ Tage)', e.regelmaessig === 1, String(e.regelmaessig));
  ok('4d. Protokollierte Tage und Eintraege stimmen',
    e.protokolltage30 === 7 && e.eintraege30 === 13, JSON.stringify([e.protokolltage30, e.eintraege30]));
  ok('4e. … und der Schnitt je Person', e.tageProPerson30 === 3.5, String(e.tageProPerson30));

  // Der Kern der Definition: Wasser allein ist kein Ernaehrungsprotokoll.
  ok('5. Wer nur Wasser angetippt hat, zaehlt nicht als Nutzer',
    e.aktiv.d30 === 2 && e.jemals === 4, JSON.stringify({ aktiv: e.aktiv.d30, jemals: e.jemals }));
  // „Aufgehoert" ist nicht dasselbe wie „nutzt es" – sonst waere die Zahl geschoent.
  ok('5b. Wer vor Monaten aufgehoert hat, faellt aus der aktuellen Zahl',
    e.aktiv.d30 === 2 && e.jemals === 4, JSON.stringify(e));

  // „Profil angelegt" ist nicht „eingerichtet" – die Unterscheidung zeigt, wie
  // viele im Onboarding haengengeblieben sind.
  ok('6. Profile und abgeschlossenes Onboarding werden getrennt',
    e.profile === 4 && e.eingerichtet === 3, JSON.stringify([e.profile, e.eingerichtet]));
  // Nachbarschluessel (nutri:prem:, nutri:q:, nutri:fav:) duerfen nicht durchrutschen.
  ok('6b. Aehnliche Schluessel werden nicht mitgezaehlt', e.profile === 4, String(e.profile));

  // ── 4. Datenschutz: die Zusage, die diese Auswertung ueberhaupt tragbar macht ──
  const alsText = JSON.stringify(e);
  ok('7. Im Ergebnis steht keine einzige Kennung',
    ['mAnna', 'mBen', 'mCarla', 'mDirk'].every((id) => alsText.indexOf(id) < 0), alsText);
  ok('7b. … und auch kein Datum eines einzelnen Protokolltags',
    alsText.indexOf(tagVor(2)) < 0 && alsText.indexOf(tagVor(40)) < 0, alsText);
  ok('7c. … der gespeicherte Stand ebenso wenig',
    String(daten.get(NU.SNAP) || '').indexOf('mAnna') < 0, String(daten.get(NU.SNAP)));

  // ── 5. Der Endpunkt: fail-closed wie die uebrigen Cron-Laeufe ──
  const ruf = (H, token) => {
    const req = { method: 'GET', url: '/api/nutri-usage-tick', headers: token ? { authorization: 'Bearer ' + token } : {} };
    const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; return this; } };
    return Promise.resolve(H(req, res)).then(() => ({ status: res.statusCode, json: (function () { try { return JSON.parse(res.body); } catch (x) { return null; } })() }));
  };
  delete process.env.CRON_SECRET; delete process.env.RECORD_SECRET;
  let H = frisch('api/nutri-usage-tick.js');
  ok('8. Ohne konfiguriertes Secret: aus', (await ruf(H, 'egal')).status === 503);
  process.env.CRON_SECRET = 'geheim';
  ok('8b. Falsches Secret: abgewiesen', (await ruf(H, 'falsch')).status === 401);
  ok('8c. Gar keins ebenso', (await ruf(H, null)).status === 401);
  const gut = await ruf(H, 'geheim');
  ok('9. Mit Secret laeuft die Auswertung durch',
    gut.status === 200 && gut.json.fertig === true && gut.json.ergebnis.aktiv.d30 === 2, JSON.stringify(gut.json));
  ok('9b. … und auch die Antwort nennt niemanden',
    JSON.stringify(gut.json).indexOf('mAnna') < 0, JSON.stringify(gut.json));

  // ── 6. Notbremse: lieber eine ehrliche Untergrenze als ein endloser Lauf ──
  // Wenn der Scan vorzeitig stoppt, MUSS das am Ergebnis sichtbar sein - sonst
  // haelt jemand eine halbe Zahl fuer die ganze und wundert sich ueber den
  // Rueckgang. Die Oberflaeche schreibt daraus „Untergrenze".
  daten.delete(NU.SNAP); daten.delete(NU.RUN);
  const halb = await NU.weiter({ runden: 50, maxSchluessel: 4 });
  ok('10. Ein abgebrochener Lauf liefert trotzdem ein Ergebnis', halb.fertig === true && !!halb.ergebnis, JSON.stringify(halb));
  ok('10b. … das sich ehrlich als unvollstaendig ausweist',
    halb.ergebnis.vollstaendig === false, JSON.stringify(halb.ergebnis));
  ok('10c. … und zaehlt nur, was es gesehen hat',
    halb.ergebnis.aktiv.d30 <= e.aktiv.d30, JSON.stringify(halb.ergebnis.aktiv));

  console.log(pass ? 'NUTRI-NUTZUNG PASS' : 'NUTRI-NUTZUNG FAIL');
  process.exit(pass ? 0 : 1);
}
run();
