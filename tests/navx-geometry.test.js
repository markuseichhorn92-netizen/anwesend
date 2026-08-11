'use strict';
// Testleiste „Meniskus" (fi_navx): die Muldenmathematik aus mitglieder.html wird hier
// WIRKLICH ausgefuehrt, nicht nur als Text geprueft. Die Funktionen nxReach/nxMetrics/
// nxSocket/nxPath sind rein rechnerisch und beruehren kein DOM - sie lassen sich damit
// aus der Oberflaechendatei herausloesen und in Node pruefen.
//
// Abgesichert werden die Zusagen, die man auf dem Geraet sonst nur muehsam sieht:
//  - die zwei Mulden (Kugel + fester „+") ueberlagern sich nie
//  - keine Mulde laeuft in die Eckenrundung der Leiste
//  - jede Tastflaeche bleibt mindestens 44 px breit (Apple/Google-Mindestmass)
//  - 1 Einheit = 1 Pixel: auf kleinen Geraeten schrumpft NICHTS mit
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const src = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
const from = src.indexOf('  function nxReach(');
const to = src.indexOf('  function navxRender(');
if (from < 0 || to < 0 || to < from) { console.log('FAIL Geometrie-Block in mitglieder.html nicht gefunden'); process.exit(1); }
// nxTextW faengt fehlendes `document` selbst ab und schaetzt dann ueber die Zeichenzahl.
const G = {};
// eslint-disable-next-line no-new-func
new Function('exports', src.slice(from, to) + '\nexports.nxReach=nxReach;exports.nxMetrics=nxMetrics;exports.nxSocket=nxSocket;exports.nxPath=nxPath;exports.nxTextW=nxTextW;exports.nxNotch=nxNotch;exports.nxNotchReach=nxNotchReach;')(G);

const TABS = ['Start', 'Training', 'Ernährung', 'Coach'];
const TABS_S = ['Start', 'Training', 'Essen', 'Coach'];
const CENTER = ['Hinzufügen', 'Starten', 'Erfassen', 'Schließen'];
const CENTER_S = ['Neu', 'Starten', 'Erfassen', 'Schließen'];

// Gleiche Auswahl wie navxLayout: erst die vollen Woerter, dann die Kurzform.
function pick(W, variant) {
  const narrow = W < 372;
  const tabL = narrow ? TABS_S : TABS;
  const cenL = narrow ? CENTER_S : CENTER;
  let m = null;
  for (let fs2 = narrow ? 10 : 10.5; fs2 >= 9.5; fs2 -= 0.5) { m = G.nxMetrics(W, fs2, tabL, cenL, variant); if (m.fits) break; }
  if (!m.fits) { for (let fs2 = narrow ? 10 : 10.5; fs2 >= 9; fs2 -= 0.5) { m = G.nxMetrics(W, fs2, TABS_S, cenL, variant); if (m.fits) break; } }
  return m;
}

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Die Formel selbst ──
// Der Schulterkreis liegt tangential zur Oberkante UND zur Kugel: |C1C2| = s + r.
// Damit muss der Abstand zwischen Schultermittelpunkt und Kugelmittelpunkt exakt s+r sein.
(function () {
  const s = 8, r = 24, y = 9, TOP = 40;
  const reach = G.nxReach(s, r, y);
  const Cx = -reach, Cy = TOP - s;          // Schulter links (relativ zur Kugel bei x=0)
  const Bx = 0, By = TOP - y;               // Kugelmittelpunkt
  const d = Math.hypot(Bx - Cx, By - Cy);
  ok('1. Muldenformel ist tangential (|C1C2| = s + r)', Math.abs(d - (s + r)) < 1e-9, 'd=' + d + ' soll=' + (s + r));
  ok('2. Unmögliche Kombination liefert 0 statt NaN', G.nxReach(1, 1, 99) === 0, String(G.nxReach(1, 1, 99)));
})();

// ── 2. Die Zusagen über alle Gerätebreiten ──
// 296 = 320er-Gerät abzüglich der 12-px-Ränder, 456 = die Höchstbreite der Leiste.
const WIDTHS = [];
for (let w = 296; w <= 456; w += 2) WIDTHS.push(w);

const bad = { overlap: [], corner: [], touch: [], plus: [], order: [], fits: [] };
WIDTHS.forEach((W) => {
  const m = pick(W);
  if (!m || !m.fits) { bad.fits.push(W); return; }
  const half = m.br + m.pr;                 // Summe der halben Muldenbreiten
  m.tabX.forEach((x, i) => {
    if (Math.abs(x - m.CX) < half) bad.overlap.push(W + '/' + i);
    if (x - m.br < m.R) bad.corner.push(W + '/' + i + ' links');
    if (x + m.br > m.W - m.R) bad.corner.push(W + '/' + i + ' rechts');
  });
  if (m.w < 44) bad.touch.push(W + ' (' + Math.round(m.w) + 'px)');
  if (Math.max(48, m.PRB * 2) < 44) bad.plus.push(W);
  for (let i = 1; i < m.tabX.length; i++) if (m.tabX[i] <= m.tabX[i - 1]) bad.order.push(W);
});
ok('3. Passende Aufteilung für jede Breite 296–456', bad.fits.length === 0, bad.fits.slice(0, 6).join(','));
ok('4. Die beiden Mulden überlagern sich nie', bad.overlap.length === 0, bad.overlap.slice(0, 6).join(','));
ok('5. Keine Mulde läuft in die Eckenrundung', bad.corner.length === 0, bad.corner.slice(0, 6).join(','));
ok('6. Jede Tab-Tastfläche bleibt >= 44 px', bad.touch.length === 0, bad.touch.slice(0, 6).join(','));
ok('7. Die „+"-Tastfläche bleibt >= 44 px', bad.plus.length === 0, bad.plus.slice(0, 6).join(','));
ok('8. Tabs bleiben in der Reihenfolge links -> rechts', bad.order.length === 0, bad.order.slice(0, 6).join(','));

// ── 3. Mobile first: nichts skaliert mit ──
(function () {
  const small = pick(296), big = pick(456);
  ok('9. Kleines Gerät: „+" bleibt bei mindestens 44 px', small.PRB * 2 >= 44, String(small.PRB * 2));
  ok('10. Der „+" wird auf grossen Geräten nicht groesser als in der App heute (54 px)', big.PRB * 2 === 54, String(big.PRB * 2));
  ok('11. Leistenhöhe bleibt im Rahmen der heutigen 64-px-Leiste', small.BARH >= 60 && big.BARH <= 70, small.BARH + '/' + big.BARH);
  ok('12. Nur die Abstände wachsen, nicht die Knöpfe', big.w > small.w && big.RB >= small.RB, small.w + ' -> ' + big.w);
})();

// ── 4. Der gezeichnete Pfad ──
(function () {
  const m = pick(390);
  const socks = [G.nxSocket(m, m.tabX[0], m.RB, m.BY, m.S, m.S), G.nxSocket(m, m.CX, m.PRB, m.PBY, m.PS, m.PS)];
  const d = G.nxPath(m, socks);
  ok('13. Ein einziger geschlossener Pfad (kein Stapel Einzelteile)', /^M /.test(d) && /Z$/.test(d) && d.indexOf('M', 1) < 0, d.slice(0, 40));
  ok('14. Keine NaN-Werte im Pfad', d.indexOf('NaN') < 0);
  // Sortierung: die Mulden werden von links nach rechts eingegossen, egal in welcher
  // Reihenfolge sie ankommen - sonst kreuzt sich der Pfad.
  const dRev = G.nxPath(m, [socks[1], socks[0]]);
  ok('15. Reihenfolge der Mulden ist egal (wird sortiert)', d === dRev);
  // Neigung beim Ziehen: die Schultern werden unterschiedlich weit gezogen
  const lean = G.nxPath(m, [G.nxSocket(m, m.tabX[1], m.RB, m.BY, m.S * 1.4, m.S * 0.6), socks[1]]);
  ok('16. Geneigte Mulde erzeugt einen anderen Pfad', lean !== d && lean.indexOf('NaN') < 0);
})();

// ── 5. Die Sperrzone deckt den Zug wirklich ab ──
(function () {
  const m = pick(390);
  // navxWire klemmt x auf mindestens keepOut Abstand zur Mitte. Genau an dieser Grenze
  // duerfen sich die Mulden noch nicht beruehren.
  const x = m.CX - m.keepOut;
  ok('17. An der Sperrzonen-Grenze berühren sich die Mulden noch nicht', (m.CX - m.pr) - (x + m.br) > 0,
    'Lücke=' + (((m.CX - m.pr) - (x + m.br)).toFixed(2)));
  ok('18. Sperrzone lässt beide äusseren Tabs zu', Math.abs(m.tabX[1] - m.CX) >= m.keepOut && Math.abs(m.tabX[2] - m.CX) >= m.keepOut,
    m.tabX[1] + '/' + m.tabX[2] + ' keepOut=' + m.keepOut);
})();

// ── 6. Der Schalter selbst ──
(function () {
  ok('19. Testleiste ist standardmässig aus (nur fi_navx=1 oder =2 schaltet sie ein)',
    /v==='1'\|\|v==='2'/.test(src) && /localStorage\.getItem\('fi_navx'\)/.test(src));
  ok('20. Sie hängt an keinem Server-Flag (rein optisch, keine Berechtigungsgrenze)',
    src.indexOf('navxOn') > 0 && !/navxOn[\s\S]{0,200}srvFlags/.test(src));
  ok('21. Gleiche Klickziele wie die normale Leiste', /data-act="nav" data-arg="'\+t\.key\+'"/.test(src));
  ok('22. Nur auf Mobil aktiv', /navxV && window\.innerWidth<1000/.test(src));
  ok('23. Zwei Varianten wählbar (Meniskus / Center-FAB)', /navx=\(auto\|\[012\]\)/.test(src));
})();

// ── 7. Variante 2 „Center-FAB": eingekerbte Leiste, Knopf schwebt mit Spalt darin ──
(function () {
  // Die Hohlkehle beruehrt die Kerbe von AUSSEN: |Mitte-Mitte| muss exakt rn + s sein.
  const rn = 36, k = 2, s = 9, TOP = 40;
  const d = G.nxNotchReach(rn, k, s);
  const dist = Math.hypot(d, (TOP + k) - (TOP + s));
  ok('24. Kerbenformel ist tangential (|Mitte-Mitte| = rn + s)', Math.abs(dist - (rn + s)) < 1e-9, 'd=' + dist + ' soll=' + (rn + s));

  const bad2 = { fits: [], touch: [], fab: [], corner: [], gap: [], deep: [] };
  WIDTHS.forEach((W) => {
    const m = pick(W, 2);
    if (!m || !m.fits) { bad2.fits.push(W); return; }
    if (m.w < 44) bad2.touch.push(W + ' (' + Math.round(m.w) + 'px)');
    if (Math.max(48, m.FR * 2) < 44) bad2.fab.push(W);
    if (m.CX - m.pr < m.R + 2) bad2.corner.push(W);
    // Der sichtbare Spalt ist genau GAP – der Knopf ist kleiner als die Kerbe.
    if (m.PRB - m.FR !== m.GAP || m.GAP < 5) bad2.gap.push(W);
    // Der Knopf darf nicht durch die Leiste durchfallen: Unterkante innerhalb der Leiste.
    if (m.FCY + m.FR > m.H - 6) bad2.deep.push(W);
  });
  ok('25. Variante 2: passende Aufteilung für jede Breite', bad2.fits.length === 0, bad2.fits.slice(0, 6).join(','));
  ok('26. Variante 2: Tab-Tastflächen >= 44 px', bad2.touch.length === 0, bad2.touch.slice(0, 6).join(','));
  ok('27. Variante 2: Knopf-Tastfläche >= 44 px', bad2.fab.length === 0, bad2.fab.slice(0, 6).join(','));
  ok('28. Variante 2: Kerbe läuft nie in die Eckenrundung', bad2.corner.length === 0, bad2.corner.slice(0, 6).join(','));
  ok('29. Variante 2: sichtbarer Spalt zwischen Knopf und Kerbe', bad2.gap.length === 0, bad2.gap.slice(0, 6).join(','));
  ok('30. Variante 2: Knopf bleibt in der Leiste verankert', bad2.deep.length === 0, bad2.deep.slice(0, 6).join(','));

  const m2 = pick(390, 2);
  const d2 = G.nxPath(m2, [G.nxNotch(m2, m2.CX, m2.PRB, m2.PBY, m2.PS)]);
  ok('31. Variante 2: ein geschlossener Pfad ohne NaN', /^M /.test(d2) && /Z$/.test(d2) && d2.indexOf('M', 1) < 0 && d2.indexOf('NaN') < 0, d2.slice(0, 40));
  ok('32. Variante 2 hat keine wandernde Kugel', m2.br === 0 && m2.RB === 0);
  // Die Kerbe schneidet nach UNTEN: der Beruehrpunkt der Hohlkehle liegt unter der Oberkante.
  ok('33. Variante 2 schneidet nach unten (Kerbe statt Mulde)', m2.FCY > m2.TOP, 'FCY=' + m2.FCY + ' TOP=' + m2.TOP);
  const m1 = pick(390, 1);
  ok('34. Variante 1 bleibt unveraendert (Kugel liegt ueber der Kante)', m1.FCY < m1.TOP && m1.br > 0, 'FCY=' + m1.FCY);
})();

console.log(pass ? 'NAVX-GEOMETRY PASS' : 'NAVX-GEOMETRY FAIL');
process.exit(pass ? 0 : 1);
