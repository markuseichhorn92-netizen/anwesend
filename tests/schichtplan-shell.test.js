'use strict';
// Schichtplan-Huelle aus dem Claude-Design-Entwurf.
// Geprueft wird, was beim Weiterbauen leicht kaputtgeht.
const fs=require('fs'), path=require('path');
const ROOT='/home/user/anwesend';
const html=fs.readFileSync(path.join(ROOT,'team-backend.html'),'utf8');
let pass=true;
const ok=(l,c,e)=>{ if(!c) pass=false; console.log((c?'OK  ':'FAIL')+' '+l+(c?'':' -- '+(e||''))); };

// Die Tokens duerfen NICHT an :root haengen - sonst faerbte der Umschalter das
// ganze Backend um.
ok('1. Tokens haengen am Schichtplan, nicht an :root',
  /\.sp\[data-sptheme="dark"\]/.test(html) && /\.sp\[data-sptheme="light"\]/.test(html));
ok('1b. … und nicht global', !/:root\[data-sptheme/.test(html));
// Der Akzent des Entwurfs, nicht der des Hauses.
ok('2. Mint-Akzent aus dem Entwurf', /--ac:#2FD4B6/.test(html));
ok('2b. Heller Gegenpart', /--ac:#0C8E79/.test(html));

// Gesperrter Speicher darf die Seite nicht toeten.
const g=html.slice(html.indexOf('function spThemeGespeichert'), html.indexOf('var SPI='));
ok('3. Der Themenspeicher ist gekapselt', /try\{/.test(g) && /catch/.test(g), g.slice(0,160));
ok('3b. … und wird beim Aufbau des Zustands benutzt', /spTheme:spThemeGespeichert\(\)/.test(html));
ok('3c. Kein ungeschuetzter Lesezugriff im Zustand', !/spTheme:\(localStorage/.test(html));

// Kopfzeilen-Marke: an genau einer Stelle, sonst bleibt sie haengen.
ok('4. Die Kopfzeilen-Marke wird umgeschaltet, nicht nur gesetzt',
  /classList\.toggle\('sp-on', S\.screen==='schicht'\)/.test(html));
ok('4b. … und es gibt keinen zweiten Setzer',
  (html.match(/classList\.(add|remove)\('sp-on'/g)||[]).length===0);

// Jeder Navigationseintrag braucht einen Bildschirmnamen und eine Bereit-Angabe.
const nav=html.slice(html.indexOf('var SP_PLAN='), html.indexOf('function spNavBtn'));
const eintraege=(nav.match(/\{k:'/g)||[]).length;
ok('5. Alle Navigationsziele des Entwurfs sind angelegt', eintraege===8, String(eintraege));
ok('5b. Jeder traegt, ob er schon gebaut ist',
  (nav.match(/bereit:/g)||[]).length===eintraege, String((nav.match(/bereit:/g)||[]).length));

// ── Die uebernommene Ergebnisansicht ──
// Der Entwurf ist die Wahrheit: Masse, Farben und Beschriftungen stammen von
// dort. Diese Pruefungen halten fest, was beim Weiterbauen leicht verrutscht.
const r=html.slice(html.indexOf('function spResultHTML'), html.indexOf('// ── Ziehen'));
ok('6. Die Ergebnisansicht ist uebernommen', r.length>2000, String(r.length));
ok('6b. … mit den vier Kennzahlen des Entwurfs',
  /Abdeckung/.test(r) && /Personalkosten Q4/.test(r) && /Wünsche erfüllt/.test(r) && /Offene Konflikte/.test(r));
ok('6c. … und den vier Zoomstufen', /'woche'.*'tag'.*'monat'.*'quartal'/s.test(r));

// Rastermasse aus dem Entwurf: 9 bis 22 Uhr, 42 Pixel je Stunde. Verrutscht das,
// stimmen alle Balkenpositionen nicht mehr.
ok('7. Rastermasse wie im Entwurf',
  /SP_GRID_TOP=9, SP_GRID_BOT=22, SP_PX=42/.test(html));
// Die festen Schichtbloecke sind Studio-Realitaet, keine Design-Zierde.
ok('7b. Die Schichtbloecke stimmen',
  /wd:\[\[9\.5,11\.5\],\[11\.5,13\],\[15,17\.5\],\[17\.5,21\.5\]\]/.test(html));
ok('7c. Sa und So haben eigene Bloecke',
  /sa:\[\[13,16\],\[16,18\]\], so:\[\[9,12\],\[12,15\]\]/.test(html));
ok('7d. Oeffnungszeiten je Wochentag', /day===5\?\[13,18\]:day===6\?\[9,15\]:\[9\.5,21\.5\]/.test(html));

// Ziehen: verschieben, beide Kanten, Personal einplanen.
ok('8. Balken lassen sich verschieben und an den Kanten fassen',
  /data-spmove/.test(html) && /data-sptop/.test(html) && /data-spbot/.test(html));
ok('8b. Personal laesst sich in eine Schicht ziehen', /function spStartStaffDrag/.test(html));
ok('8c. … und wird dabei auf Eignung geprueft', /function spFitCheck/.test(html));
// Ohne Rasterung landen Schichten auf krummen Zeiten wie 10:17.
// Alle drei Zieh-Arten rasten: verschieben, obere Kante, untere Kante. Nur zu
// pruefen, ob die Rasterung irgendwo vorkommt, wuerde den Wegfall einer
// einzelnen nicht bemerken - dann landeten Schichten auf 10:17.
const drag=html.slice(html.indexOf('function spStartDrag'), html.indexOf('function spFitCheck'));
ok('8d. Alle drei Zieh-Arten rasten auf die Schichtgrenzen ein',
  (drag.match(/spSnapEdge\(day,/g)||[]).length===3,
  String((drag.match(/spSnapEdge\(day,/g)||[]).length)+' von 3');
// Ueberlappende Schichten muessen nebeneinander liegen, nicht uebereinander.
ok('8e. Ueberlappungen werden nebeneinander gelegt', /function spPackLanes/.test(html));

// Die App-Kopfzeile traegt ihren display-Wert inline - eine Klassenregel ohne
// !important verliert dagegen und die Kopfzeile stuende doppelt.
ok('9. Die doppelte Kopfzeile wird wirklich unterdrueckt',
  /body\.sp-on \.hdr-mobile\{display:none!important\}/.test(html));

// ── Setup und Generierung ──
const setup=html.slice(html.indexOf('function spSetupHTML'), html.indexOf('// ── Schichtplan · Generierung'));
ok('10. Der Setup-Bildschirm ist uebernommen', setup.length>2000, String(setup.length));
ok('10b. … mit den vier Zeitraeumen', /'woche','Woche'.*'halb','6 Monate'/s.test(setup));
ok('10c. … der Besetzungsbedarf-Matrix', /data-spneed/.test(setup));
const goalsBlock=(html.match(/var SP_GOALS=\[[\s\S]*?\n\];/)||[''])[0];
const rulesBlock=(html.match(/var SP_RULES=\[[\s\S]*?\n\];/)||[''])[0];
ok('10d. … den vier Optimierungszielen',
  (goalsBlock.match(/^\s*\['/gm)||[]).length===4, String((goalsBlock.match(/^\s*\['/gm)||[]).length));
ok('10e. … und den sechs Regeln',
  (rulesBlock.match(/^\s*\['/gm)||[]).length===6, String((rulesBlock.match(/^\s*\['/gm)||[]).length));

// Die Bedarfszahlen sind begrenzt: unter 0 waere unsinnig, ueber 5 unrealistisch.
const bump=html.slice(html.indexOf("data-spneed]').forEach"), html.indexOf("var rm=node.querySelector('[data-spremind]')"));
ok('11. Der Bedarf laesst sich nicht ins Unsinnige drehen',
  /Math\.max\(0,Math\.min\(5,/.test(bump), bump.slice(0,200));

// Der Zaehler laeuft zeitgesteuert. Bricht man ab, darf er NICHT weiterlaufen
// und am Ende doch auf das Ergebnis springen.
const gen=html.slice(html.indexOf('function spStartGen'), html.indexOf('function spGenHTML'));
ok('12. Die Generierung bricht wirklich ab',
  /if\(S\.spScreen!=='gen'\) return;/.test(gen), gen.slice(0,300));
ok('12b. … und der Abbruch stoppt auch den Zeitgeber', /clearTimeout\(window\.__spGenT\)/.test(html));
const genBlock=(html.match(/var SP_GEN_LABELS=\[[^\]]*\];/)||[''])[0];
ok('12c. Fuenf Schritte wie im Entwurf',
  genBlock.split("','").length===5, String(genBlock.split("','").length));

// ── Freigaben, Bewerbungen, Verfuegbarkeitsmatrix ──
ok('13. Freigaben sind uebernommen', /function spInboxHTML/.test(html));
ok('13b. … mit den vier Reitern des Entwurfs',
  /'urlaub','Urlaub'.*'stempel','Stempelzeiten'/s.test(html));
// Die Folgenabschaetzung ist der Kern des Bildschirms: Sie zeigt VOR der
// Entscheidung, was eine Genehmigung anrichtet.
ok('13c. … und der Folgenabschaetzung vor der Entscheidung',
  /Folgen der Genehmigung/.test(html) && /Resturlaub danach/.test(html));
ok('13d. Nach der Entscheidung andere Handlungen',
  /entschieden\s*\?/.test(html) && /vacreplan/.test(html));

ok('14. Bewerbungen sind uebernommen', /function spApplicantsHTML/.test(html));
ok('14b. … drei Bewerbungen mit Fakten',
  (html.match(/var SP_APPS=\[[\s\S]*?\n\];/)||[''])[0].split("\n  ['").length===4);
// Der Hinweis, dass die anderen automatisch eine Absage bekommen, gehoert dazu -
// sonst tippt jemand drei Absagen von Hand.
ok('14c. … und dem Hinweis auf die automatische Absage',
  /andere.*automatisch eine.*Absage/s.test(html));

ok('15. Die Verfuegbarkeitsmatrix ist uebernommen', /function spMatrixHTML/.test(html));
// Echte Von-Bis-Fenster statt Ja/Nein - das ist der Unterschied zu einer
// Kaestchenliste und der Grund, warum die Balken im Tagesrahmen liegen.
const mx=html.slice(html.indexOf('function spMatrixHTML'), html.indexOf('function spPresets'));
ok('15b. … als Balken im Tagesrahmen, nicht als Kaestchen',
  /\(v\[0\]-lo\)\/\(hi-lo\)\*100/.test(mx), mx.slice(0,200));
// Sehr kurze Fenster muessen sichtbar bleiben.
ok('15c. … mit Mindestbreite fuer kurze Fenster', /Math\.max\(9,/.test(mx));
// Die Quelle der Angabe ist im Entwurf farblich getrennt.
ok('15d. … und getrennter Quelle selbst/Leitung',
  /src==='self'\?'var\(--ac\)':'var\(--vi\)'/.test(mx));
// Traegt die Leitung ein, muss die Quelle umspringen - sonst behauptet die
// Anzeige weiter, die Person haette es selbst gemeldet.
const cyc=html.slice(html.indexOf('function spCycleCell'), html.indexOf('function spWireInbox'));
ok('15e. Eintragen durch die Leitung aendert die Quelle', /row\.src='lead'/.test(cyc), cyc.slice(-200));
ok('15f. … und schaltet durch fuenf Zustaende',
  /\(at\+1\)%opts\.length/.test(cyc));

console.log(pass?'SP-SHELL PASS':'SP-SHELL FAIL');
process.exit(pass?0:1);
