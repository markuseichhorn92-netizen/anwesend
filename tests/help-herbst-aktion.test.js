'use strict';
// Hilfe-Artikel Aktion „5 € pro Woche bis Silvester" (Herbst 2026): die einmalige Migration
// ersetzt den Oktober-Artikel an Ort und Stelle (gleiche Id) bzw. legt die Aktion an, tauscht die
// alte Telefonnummer in allen Backend-Artikeln aus und läuft nach Löschen nicht erneut. FINNs
// Wissenssuche findet die Aktion für die typischen Fragen oben und bekommt sie vollständig; FINN,
// Hilfetexte und App nennen nur noch die neue Nummer (die WhatsApp-Nummer bleibt).
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const Articles = require(path.join(ROOT, 'lib/articles.js'));
const Mig = require(path.join(ROOT, 'lib/articleMigrations.js'));
const TITLE = Mig.HERBST_TITLE;
const OKT = 'Oktober-Aktion 2026: 12 Wochen für je 5 €';
const NEW = '0651 493 688 19';
const OLD = /0651 308524/;

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };
  const P = R.store.redisPipeline;

  // 1. Vor der Erstbefüllung: nichts anlegen (sonst übersprünge seedDefaults die Standard-Artikel)
  ok('1. ohne Erstbefüllung keine Migration', (await Articles.list()).length === 0);
  const seed = await Articles.seedDefaults();
  ok('1a. Standard-Artikel werden danach angelegt', seed.seeded >= 20, JSON.stringify(seed));
  Mig._reset();

  // 2. Frischer Speicher: Aktion wird angelegt – veröffentlicht, Mitgliedschaft, mit allen Fakten
  let all = await Articles.list();
  let akt = all.filter((a) => a.title === TITLE);
  ok('2. Aktion angelegt, veröffentlicht, Kategorie Mitgliedschaft', akt.length === 1 && akt[0].status === 'veröffentlicht' && akt[0].cat === 'mitglied');
  const body = akt[0].body;
  ok('2a. Inhalt: Angebot, Preise ab Januar, Ersparnis, Konditionen, Kontakt',
    /bis einschließlich 31\.12\.2026 nur 5 € pro Woche – in beiden Tarifen/.test(body)
    && /Basic 12 € pro Woche bei 52 Wochen Laufzeit, Premium 9 € pro Woche bei 104 Wochen Laufzeit/.test(body)
    && /Nur die ersten 25 Neuanmeldungen/.test(body) && /Frühester Start ist der 01\.10\.2026/.test(body)
    && /Start 1\. Oktober: Basic 92 € gespart, Premium 53 €/.test(body) && /Start 1\. November: Basic 61 €, Premium 35 €/.test(body) && /Start 1\. Dezember: Basic 31 €, Premium 18 €/.test(body)
    && /Einmalige Aufnahmegebühr 39 €/.test(body) && /Nur für Neumitglieder, ab 18 Jahren/.test(body) && /nicht auf bestehende Verträge übertragbar/.test(body)
    && /Flex-Tarif \(4 Wochen, 15 € pro Woche\) ist nicht Teil der Aktion/.test(body) && /über 100 Geräte auf zwei Etagen/.test(body)
    && /Telefon: 0651 493 688 19/.test(body) && /fit-inn-trier-dark-landing\.onepage\.me\/5-euro-woche/.test(body) && /agbs-fit-inn-trier/.test(body));
  ok('2b. keine alten Angaben', !OLD.test(body) && !/angebot\.fit-inn-trier/.test(body));

  // 3. Produktion: Oktober-Artikel vorhanden → gleiche Id, neuer Titel/Text; alte Nummer und alte
  //    Angebotsseite in Team-Artikeln ersetzt; nichts anderes angefasst
  await Articles.remove(akt[0].id);
  const okt = await Articles.save({ title: OKT, cat: 'mitglied', status: 'veröffentlicht', body: 'Als Neumitglied zahlst du in den ersten 12 Wochen je 5 € pro Woche.' });
  const team = await Articles.save({ title: 'Geschenkgutscheine', cat: 'mitglied', status: 'veröffentlicht', body: 'Ruf an unter 0651 308524 oder +49 651 308524. Infos: https://angebot.fit-inn-trier.de/herbst' });
  const draft = await Articles.save({ title: 'Entwurf ohne Nummer', cat: 'studio', status: 'entwurf', body: 'Nichts zu ändern.' });
  await P([['DEL', 'art:mig:herbst26']]); Mig._reset();
  all = await Articles.list();
  const moved = all.find((a) => a.id === okt.id);
  ok('3. Oktober-Artikel an Ort und Stelle ersetzt (gleiche Id)', moved && moved.title === TITLE && moved.body === Mig.HERBST_BODY && moved.status === 'veröffentlicht', JSON.stringify(moved && moved.title));
  ok('3a. kein zweiter Aktionsartikel, kein Oktober-Artikel mehr', all.filter((a) => a.title === TITLE).length === 1 && !all.some((a) => a.title === OKT));
  const t2 = all.find((a) => a.id === team.id);
  ok('3b. Team-Artikel: beide Schreibweisen der alten Nummer ersetzt', t2.body.split(NEW).length === 3 && !/308\s?524/.test(t2.body), t2.body);
  ok('3c. Team-Artikel: alte Angebotsseite → Aktionsseite', /Infos: fit-inn-trier-dark-landing\.onepage\.me\/5-euro-woche$/.test(t2.body), t2.body);
  ok('3d. Titel, Status, Kategorie bleiben', t2.title === 'Geschenkgutscheine' && t2.status === 'veröffentlicht' && t2.cat === 'mitglied');
  const d2 = all.find((a) => a.id === draft.id);
  ok('3e. Artikel ohne alte Angaben unverändert', d2.body === 'Nichts zu ändern.' && d2.updatedAt === draft.updatedAt);
  ok('3f. keine alte Nummer mehr in irgendeinem Backend-Artikel', !all.some((a) => /308\s?524/.test(a.body)));

  // 4. Team löscht bzw. setzt auf Entwurf → taucht nicht wieder auf
  await Articles.setStatus(okt.id, 'entwurf'); Mig._reset();
  ok('4. Entwurf bleibt Entwurf', (await Articles.list()).find((a) => a.id === okt.id).status === 'entwurf');
  await Articles.remove(okt.id); Mig._reset();
  ok('4a. nach Löschen nicht wieder angelegt', !(await Articles.list()).some((a) => a.title === TITLE));
  await Articles.save({ title: TITLE, cat: 'mitglied', status: 'veröffentlicht', body: Mig.HERBST_BODY });   // zurück für die Suche

  // 5. Hilfetexte, FINN und App nennen nur die neue Nummer; WhatsApp-Link bleibt
  const help = require(path.join(ROOT, 'lib/help.js'));
  const seedArts = require(path.join(ROOT, 'lib/helpSeed.js'));
  const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
  ok('5. eingebaute Artikel und Erstbefüllung ohne alte Nummer', !help.some((a) => OLD.test(a.body)) && !seedArts.some((a) => OLD.test(a.body)) && help.some((a) => a.body.indexOf(NEW) >= 0));
  ok('5a. Mitglieder-App ohne alte Nummer, Impressum mit neuer, WhatsApp-Link bleibt', !OLD.test(html) && /tel:'0651 493 688 19'/.test(html) && /wa\.me\/49651308524/.test(html));
  const Rt = require(path.join(ROOT, 'lib/finn/runtime.js'));
  ok('5b. FINN (BRAND) nennt die neue Nummer', Rt.BRAND.indexOf('Tel. ' + NEW) >= 0 && !OLD.test(Rt.BRAND));
  const ai = fs.readFileSync(path.join(ROOT, 'lib/ai.js'), 'utf8');
  ok('5c. Coach- und WhatsApp-Persona mit neuer Nummer', !OLD.test(ai) && ai.split('Tel. ' + NEW).length === 3);
  ['probetraining.html', 'probetraining-info.html', 'einladung.html', 'api/offer.js', 'api/wa-verify.js', 'api/member/contact.js'].forEach((f) => {
    ok('5d. ' + f + ' mit neuer Nummer', fs.readFileSync(path.join(ROOT, f), 'utf8').indexOf(NEW) >= 0 && !OLD.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  });

  // 6. FINNs Wissenssuche: Aktion ganz oben und vollständig im Kontext
  const K = require(path.join(ROOT, 'lib/finn/knowledge.js'));
  K._reset();
  const qs = ['Was kostet es ab Januar?', 'Wie viel spare ich, wenn ich heute starte?', 'Gibt es eine Aufnahmegebühr?', 'Kann ich das als bestehendes Mitglied nutzen?'];
  for (let i = 0; i < qs.length; i++) {
    // Die ersten drei eindeutig, die vierte („das") ist ohne Verlauf mehrdeutig → unter den drei Treffern im Kontext.
    const hits = await K.search(qs[i], 3);
    const rank = hits.findIndex((h) => h.title === TITLE);
    ok('6.' + (i + 1) + ' „' + qs[i] + '" → Aktion ' + (i < 3 ? 'ganz oben' : 'unter den Treffern'), i < 3 ? rank === 0 : rank >= 0, JSON.stringify(hits.map((h) => h.title + ' ' + h.score)));
    const c = await K.contextFor(qs[i], 3);
    ok('6.' + (i + 1) + 'a … vollständig im Kontext', c.indexOf(Mig.HERBST_BODY) >= 0);
  }
  const tel = await K.contextFor('Wie ist eure Telefonnummer?', 3);
  ok('6.5 Telefon-Frage: Kontext ohne alte Nummer', !OLD.test(tel) && tel.indexOf(NEW) >= 0, tel.slice(0, 300));
  const tool = await K.search('Gibt es eine Aufnahmegebühr?', 4);
  ok('6.6 Werkzeug search_knowledge bleibt bei 900 Zeichen je Treffer', tool.every((h) => h.snippet.length <= 900));
  const big = await K.contextFor('Kann ich das als bestehendes Mitglied nutzen?', 3);
  ok('6.6a Kontext bleibt begrenzt (Budget)', big.length < 6500 + 600, String(big.length));
  const dup = (await K.search('Mitgliedschaft pausieren', 4)).map((h) => h.title);
  ok('6.7 kein Artikel doppelt (Backend-Fassung ersetzt die eingebaute)', dup.length === new Set(dup).size, JSON.stringify(dup));

  // 7. Interessenten: die aktuelle Aktion steht immer im Prompt (Live-Probe: „Kann ich das als
  //    bestehendes Mitglied nutzen?" wurde sonst als Login-Frage verstanden) – Mitglieder nicht
  const Agents = require(path.join(ROOT, 'lib/finn/agents.js'));
  const pr = await K.promos();
  ok('7. promos(): veröffentlichter Artikel mit „Aktion" im Titel', pr.length === 1 && pr[0].title === TITLE && pr[0].body === Mig.HERBST_BODY, JSON.stringify(pr.map((p) => p.title)));
  const lead = await Rt.buildSystem({ actor: { kind: 'lead', id: 'v1' }, channel: 'public' }, Agents.get('lead'), 'Kann ich das als bestehendes Mitglied nutzen?');
  ok('7a. Website-Besucher: AKTUELLE AKTION mit vollem Text im Prompt', /AKTUELLE AKTION/.test(lead) && lead.indexOf(Mig.HERBST_BODY) >= 0 && /„Heute" ist immer das Datum oben/.test(lead));
  ok('7b. … und nicht noch einmal in der Wissensbasis', lead.split(Mig.HERBST_BODY.slice(0, 80)).length === 2);
  const mem = await Rt.buildSystem({ actor: { kind: 'member', id: '1' }, channel: 'web', live: 'Vertrag: aktiv' }, Agents.get('concierge'), 'Wann habt ihr offen?');
  ok('7c. Mitglied: keine angeheftete Aktion', !/AKTUELLE AKTION/.test(mem));
  const akt2 = (await Articles.list()).find((a) => a.title === TITLE);
  await Articles.setStatus(akt2.id, 'entwurf'); K._reset();
  ok('7d. Aktion auf Entwurf → nicht mehr angeheftet', (await K.promos()).length === 0 && !/AKTUELLE AKTION/.test(await Rt.buildSystem({ actor: { kind: 'lead', id: 'v1' }, channel: 'public' }, Agents.get('lead'), 'Hallo')));
  await Articles.save({ title: 'Transaktionen und Aktionen im Überblick', cat: 'studio', status: 'veröffentlicht', body: 'x' }); K._reset();
  ok('7e. „Aktionen"/„Transaktion" im Titel zählt nicht als Aktion', (await K.promos()).length === 0);

  console.log(pass ? 'HELP HERBST-AKTION PASS' : 'HELP HERBST-AKTION FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
