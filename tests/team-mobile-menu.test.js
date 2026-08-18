'use strict';
// „Mehr" im Team-Backend auf dem Telefon.
//
// Vorher schob sich hier die Desktop-Seitenleiste von links ins Bild: 268 Pixel,
// dunkel, achtzehn Eintraege untereinander - und die obersten drei standen schon
// in der Leiste darunter. Jetzt ein Blatt von unten mit Kacheln.
//
// Geprueft wird das, was beim naechsten Umbau leicht kaputtgeht:
//  - dass nicht wieder BEIDE Menues gleichzeitig auftauchen,
//  - dass keine Ziel-Doppelung zwischen Leiste und Blatt entsteht,
//  - dass jede Kachel auf einen Bildschirm zeigt, den es wirklich gibt.
//
// Der erste Punkt braucht einen echten Browser (es haengt an Medienabfragen).
// Ist keiner da, wird das ehrlich gemeldet statt still uebersprungen.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'team-backend.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── Teil 1: Ohne Browser pruefbar ──
const sheetSrc = html.slice(html.indexOf('function moreSheet('), html.indexOf('function navItem('));
ok('1. Das Blatt existiert', sheetSrc.length > 400, String(sheetSrc.length));

// Ziele im Blatt.
const imBlatt = Array.from(sheetSrc.matchAll(/\{k:'([a-z]+)'/g)).map((m) => m[1]);
ok('1b. Es traegt mehrere Ziele', imBlatt.length >= 10, imBlatt.join(','));

// Ziele in der unteren Leiste.
const bnSrc = html.slice(html.indexOf('var bnDefs=['), html.indexOf('var bnav=el('));
const inLeiste = Array.from(bnSrc.matchAll(/\{k:'([a-z_]+)'/g)).map((m) => m[1]).filter((k) => k !== '__more');
ok('2. Die Leiste hat ihre eigenen Ziele', inLeiste.length === 3, inLeiste.join(','));

// Der eigentliche Punkt: keine Doppelung. Vorher standen Uebersicht, Posteingang
// und Mitglieder BEIDES - unten in der Leiste und oben in der Schublade.
const doppelt = imBlatt.filter((k) => inLeiste.indexOf(k) >= 0);
ok('3. Kein Ziel steht in Leiste UND Blatt', doppelt.length === 0, 'doppelt: ' + doppelt.join(','));

// Jede Kachel muss auf einen Bildschirm zeigen, den es gibt. Die Seitenleiste ist
// dafuer die Wahrheit - sie listet alle echten Ziele.
const seiteSrc = html.slice(html.indexOf("var side=el('<aside"), html.indexOf('main.appendChild(bnav)'));
const echte = Array.from(seiteSrc.matchAll(/navItem\('([a-z]+)'/g)).map((m) => m[1]);
const erfunden = imBlatt.filter((k) => echte.indexOf(k) < 0);
ok('4. Jede Kachel zeigt auf einen echten Bildschirm', erfunden.length === 0, 'erfunden: ' + erfunden.join(','));

// Umgekehrt: nichts darf verloren gehen. Was in der Seitenleiste steht, muss auf
// dem Telefon irgendwo erreichbar sein - in der Leiste oder im Blatt.
const verloren = echte.filter((k) => imBlatt.indexOf(k) < 0 && inLeiste.indexOf(k) < 0);
ok('5. Kein Bildschirm ist auf dem Telefon unerreichbar', verloren.length === 0, 'fehlt: ' + verloren.join(','));

// Rechteabhaengige Ziele muessen auch im Blatt gefiltert werden, sonst sieht eine
// Angestellte Kacheln, die ins Leere fuehren.
ok('6. Das Blatt beachtet die Rechte', /canSee\(it\.k\)/.test(sheetSrc), sheetSrc.slice(0, 200));

// Abmelden und „Zur Mitglieder-App" gehoerten zur Seitenleiste - sie duerfen auf
// dem Telefon nicht verschwinden.
ok('7. Abmelden ist im Blatt erreichbar', /__logout/.test(sheetSrc));
ok('7b. Der Weg in die Mitglieder-App ebenso', /__toapp/.test(sheetSrc));
ok('7c. … und es laesst sich schliessen', /__close/.test(sheetSrc));

// Der Schleier der alten Schublade ist weg - sonst dunkelt es doppelt ab.
ok('8. Kein zweiter Schleier mehr', (html.match(/mb-overlay/g) || []).length === 1,
  String((html.match(/mb-overlay/g) || []).length));

// ── Teil 2: Mit Browser ──
(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const kandidaten = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  const bin = kandidaten.filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];

  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden – die Breiten-Pruefung (9/10) lief NICHT.');
    console.log(pass ? 'TEAM-MOBILE-MENU PASS (ohne Browser)' : 'TEAM-MOBILE-MENU FAIL');
    process.exit(pass ? 0 : 1);
  }

  const b = await chromium.launch({ executablePath: bin });
  async function sichtbar(w, h) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.setContent(html, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(250);
    await p.evaluate(() => {
      window.S.token = 'x'; window.S.screen = 'dash'; window.S.meName = 'Test Person';
      window.S.role = 'admin'; window.S.booted = true; window.S.navOpen = true;
      if (window.render) window.render();
    }).catch(function () {});
    await p.waitForTimeout(300);
    const r = await p.evaluate((hoehe) => {
      const sicht = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
      const sheet = document.querySelector('.mb-more-sheet');
      const grid = document.querySelector('.mb-more-grid');
      return {
        seite: sicht(document.querySelector('.mb-sidebar')),
        blatt: sicht(sheet),
        leiste: sicht(document.querySelector('.bottomnav')),
        spalten: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
        kleinsteKachel: grid ? Math.min.apply(null, Array.from(grid.children).map((c) => Math.round(c.getBoundingClientRect().height))) : 0,
        passtInsBild: sheet ? sheet.getBoundingClientRect().height <= hoehe : true,
      };
    }, h);
    await p.close();
    return r;
  }

  const handy = await sichtbar(375, 667);
  const klein = await sichtbar(320, 568);
  const desktop = await sichtbar(1280, 900);

  // Genau EIN Menue je Breite. Beides gleichzeitig war der alte Zustand.
  ok('9. Auf dem Telefon nur das Blatt, keine Seitenleiste',
    handy.blatt === true && handy.seite === false, JSON.stringify(handy));
  ok('9b. Auf dem Desktop nur die Seitenleiste, kein Blatt',
    desktop.seite === true && desktop.blatt === false, JSON.stringify(desktop));
  ok('9c. Die untere Leiste bleibt auf dem Telefon, verschwindet am Desktop',
    handy.leiste === true && desktop.leiste === false, JSON.stringify({ h: handy.leiste, d: desktop.leiste }));

  // Trefferflaechen und Umbruch.
  ok('10. Kacheln sind gross genug zum Tippen',
    handy.kleinsteKachel >= 44, String(handy.kleinsteKachel) + 'px');
  ok('10b. Drei Spalten auf dem Telefon', handy.spalten === 3, String(handy.spalten));
  ok('10c. Zwei Spalten auf sehr schmalen Geraeten', klein.spalten === 2, String(klein.spalten));
  ok('10d. … und dort immer noch tippbar', klein.kleinsteKachel >= 44, String(klein.kleinsteKachel) + 'px');
  // Das Blatt darf das Bild nie ueberragen - sonst ist der Fuss unerreichbar.
  ok('11. Das Blatt bleibt im Bild', handy.passtInsBild && klein.passtInsBild,
    JSON.stringify({ h: handy.passtInsBild, k: klein.passtInsBild }));

  await b.close();
  console.log(pass ? 'TEAM-MOBILE-MENU PASS' : 'TEAM-MOBILE-MENU FAIL');
  process.exit(pass ? 0 : 1);
})();
