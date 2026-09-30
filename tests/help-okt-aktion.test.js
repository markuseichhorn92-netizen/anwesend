'use strict';
// Hilfe-Artikel „Oktober-Aktion 2026": einmalige Migration legt ihn im Team-Backend an (genau
// einmal, nicht wieder nach Löschen/Entwurf), FINNs Wissenssuche findet ihn für die typischen
// Fragen ganz oben, die Sommer-Aktion (bis 31.08.2026) ist aus FINNs Wissen und der App-Hilfe
// verschwunden, der reguläre Preisartikel „Tarife & Preise" bleibt.
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const Articles = require(path.join(ROOT, 'lib/articles.js'));
const Mig = require(path.join(ROOT, 'lib/articleMigrations.js'));
const TITLE = 'Oktober-Aktion 2026: 12 Wochen für je 5 €';

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // 1. Vor der Erstbefüllung: nichts anlegen (sonst übersprünge seedDefaults die Standard-Artikel)
  let all = await Articles.list();
  ok('1. ohne Erstbefüllung keine Migration', all.length === 0);
  const seed = await Articles.seedDefaults();
  ok('1a. Standard-Artikel werden danach angelegt', seed.seeded >= 20, JSON.stringify(seed));
  Mig._reset();

  // 2. Migration legt den Artikel genau einmal an
  all = await Articles.list();
  const okt = all.filter((a) => a.title === TITLE);
  ok('2. Oktober-Artikel angelegt, veröffentlicht, Kategorie Mitgliedschaft', okt.length === 1 && okt[0].status === 'veröffentlicht' && okt[0].cat === 'mitglied');
  const body = okt[0].body;
  ok('2a. Inhalt: genau die vorgegebenen Fakten', /ersten 12 Wochen je 5 € pro Woche/.test(body) && /Basic 12 € pro Woche bei 52 Wochen/.test(body) && /Premium 9 € pro Woche bei 104 Wochen/.test(body)
    && /540 € über 52 Wochen bzw\. 888 € über 104 Wochen, zzgl\. einmalig 39 € Aufnahmegebühr/.test(body) && /bis 31\.10\.2026, nur für Neumitglieder, ab 18 Jahren/.test(body)
    && /nicht auf bestehende Verträge übertragbar/.test(body) && /Flex-Tarif \(4 Wochen, 15 € pro Woche\) ist nicht Teil der Aktion/.test(body)
    && /fit-inn-trier\.de\/agbs-fit-inn-trier/.test(body) && body.split('\n\n').length === 11);
  Mig._reset(); await Articles.list();
  ok('2b. kein zweites Mal', (await Articles.list()).filter((a) => a.title === TITLE).length === 1);

  // 3. Team setzt ihn auf Entwurf bzw. löscht ihn → taucht nicht wieder auf
  await Articles.remove(okt[0].id); Mig._reset();
  ok('3. nach Löschen durch das Team nicht wieder angelegt', !(await Articles.list()).some((a) => a.title === TITLE));
  await R.store.redisPipeline([['DEL', 'art:mig:okt26']]); Mig._reset(); await Articles.list();   // zurück für die Suche

  // 4. Sommer-Aktion weg, regulärer Preisartikel bleibt
  const help = require(path.join(ROOT, 'lib/help.js'));
  const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
  ok('4. Sommer-Aktion nicht mehr in FINNs Wissen (lib/help.js)', !help.some((a) => /5-Euro-Aktion|31\.08\.2026/.test(a.t + a.body)));
  ok('4a. … und nicht mehr in der App-Hilfe', !/5-Euro-Aktion|gültig bis 31\.08\.2026/.test(html));
  ok('4b. „Tarife & Preise" bleibt', help.some((a) => a.t === 'Tarife & Preise') && (await Articles.list()).some((a) => a.title === 'Tarife & Preise'));

  // 5. FINNs Wissenssuche: für alle vier Fragen steht der Oktober-Artikel oben, nie die Sommer-Aktion
  const K = require(path.join(ROOT, 'lib/finn/knowledge.js'));
  const qs = ['Was kostet es nach den 12 Wochen?', 'Bis wann gilt die 5-€-Aktion?', 'Gibt es eine Aufnahmegebühr?', 'Kann ich die Aktion auch als bestehendes Mitglied nutzen?'];
  for (let i = 0; i < qs.length; i++) {
    const hits = await K.search(qs[i], 4);
    ok('5.' + (i + 1) + ' „' + qs[i] + '" → Oktober-Artikel ganz oben', hits[0] && hits[0].title === TITLE && !hits.some((h) => /5-Euro-Aktion|31\.08\.2026/.test(h.title + h.snippet)), JSON.stringify(hits.map((h) => h.title + ' ' + h.score)));
  }
  const dup = (await K.search('Mitgliedschaft pausieren', 4)).map((h) => h.title);
  ok('5.5 kein Artikel doppelt (Backend-Fassung ersetzt die eingebaute)', dup.length === new Set(dup).size, JSON.stringify(dup));

  // 6. Der Prompt-Kontext enthält den Aktionsartikel vollständig (bei 500 Zeichen fehlten
  //    „nur für Neumitglieder", die Leistungen und der Flex-Ausschluss – FINN riet dann)
  for (let i = 0; i < qs.length; i++) {
    const c = await K.contextFor(qs[i], 3);
    ok('6.' + (i + 1) + ' Kontext zu „' + qs[i] + '" vollständig', /nur für Neumitglieder/.test(c) && /In jeder Mitgliedschaft enthalten/.test(c) && /Flex-Tarif \(4 Wochen, 15 € pro Woche\) ist nicht Teil der Aktion/.test(c) && /agbs-fit-inn-trier/.test(c), c.slice(0, 300));
  }
  const tool = await K.search('Gibt es eine Aufnahmegebühr?', 4);
  ok('6.5 Werkzeug search_knowledge bleibt bei 900 Zeichen je Treffer', tool.every((h) => h.snippet.length <= 900));

  console.log(pass ? 'HELP OKT-AKTION PASS' : 'HELP OKT-AKTION FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
