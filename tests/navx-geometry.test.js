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
new Function('exports', src.slice(from, to) + '\nexports.nxReach=nxReach;exports.nxMetrics=nxMetrics;exports.nxSocket=nxSocket;exports.nxPath=nxPath;exports.nxTextW=nxTextW;')(G);

const TABS = ['Start', 'Training', 'Ernährung', 'Coach'];
const TABS_S = ['Start', 'Training', 'Essen', 'Coach'];
const CENTER = ['Hinzufügen', 'Starten', 'Erfassen', 'Schließen'];
const CENTER_S = ['Neu', 'Starten', 'Erfassen', 'Schließen'];

// Gleiche Auswahl wie navxLayout: erst die vollen Woerter, dann die Kurzform.
function pick(W) {
  const narrow = W < 372;
  const tabL = narrow ? TABS_S : TABS;
  const cenL = narrow ? CENTER_S : CENTER;
  let m = null;
  for (let fs2 = narrow ? 10 : 10.5; fs2 >= 9.5; fs2 -= 0.5) { m = G.nxMetrics(W, fs2, tabL, cenL); if (m.fits) break; }
  if (!m.fits) { for (let fs2 = narrow ? 10 : 10.5; fs2 >= 9; fs2 -= 0.5) { m = G.nxMetrics(W, fs2, TABS_S, cenL); if (m.fits) break; } }
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
  ok('19. Testleiste ist standardmässig aus (nur fi_navx=1 schaltet sie ein)',
    /localStorage\.getItem\('fi_navx'\)==='1'/.test(src));
  ok('20. Sie hängt an keinem Server-Flag (rein optisch, keine Berechtigungsgrenze)',
    src.indexOf('navxOn') > 0 && !/navxOn[\s\S]{0,200}srvFlags/.test(src));
  ok('21. Gleiche Klickziele wie die normale Leiste', /data-act="nav" data-arg="'\+t\.key\+'"/.test(src));
  ok('22. Nur auf Mobil aktiv', /navxOn\(\) && window\.innerWidth<1000/.test(src));
})();

console.log(pass ? 'NAVX-GEOMETRY PASS' : 'NAVX-GEOMETRY FAIL');
process.exit(pass ? 0 : 1);
