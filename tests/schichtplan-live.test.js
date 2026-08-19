'use strict';
// Der Schichtplan auf echten Daten.
//
// Die uebernommenen Bildschirme rechnen in der Form des Entwurfs: Spalte 0..6
// statt Datum, Dezimalstunden statt HH:MM, zwei Bereiche statt vier Rollen.
// Der Server liefert das andere. Dazwischen steht ein Uebersetzer - und der ist
// die Stelle, an der beim Weiterbauen still etwas falsch wird: eine Schicht in
// der falschen Spalte, ein Urlaub am falschen Tag, ein Knopf, der nur so tut.
//
// Geprueft wird deshalb mit einer echten Serverantwort im Browser.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'team-backend.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── Ohne Browser pruefbar ──
// Der Umschalter selbst: ohne Serverantwort bleibt es beim Beispiel, und das
// muss dann auch dranstehen. Erfundene Namen, die wie echte aussehen, sind hier
// gefaehrlich - jemand koennte danach planen.
ok('1. Es gibt eine Weiche zwischen echt und Beispiel', /function spLive\(\)/.test(html));
ok('1b. … und einen sichtbaren Hinweis im Beispielbetrieb', /function spBeispielHTML/.test(html) && /Beispieldaten/.test(html));
// Die Entwurfsdaten duerfen nur noch ueber die Fallback-Namen erreichbar sein.
ok('2. Keine direkte Nutzung der Entwurfs-Konstanten mehr',
  !/[^_]\bSP_STAFF\[/.test(html) && !/[^_]\bSP_DAYS\[/.test(html));
ok('2b. Sie stehen aber weiter als Beispiel bereit',
  /var SP_STAFF_DEMO=/.test(html) && /var SP_DAYS_DEMO=/.test(html));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const kandidaten = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  const bin = kandidaten.filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden – die Uebersetzung (3–9) wurde NICHT geprueft.');
    console.log(pass ? 'SP-LIVE PASS (ohne Browser)' : 'SP-LIVE FAIL');
    process.exit(pass ? 0 : 1);
  }

  const MON = '2026-08-03';                       // ein Montag
  const ADD = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const WD = [['09:30', '11:30'], ['11:30', '13:00'], ['15:00', '17:30'], ['17:30', '19:30'], ['19:30', '21:30']];
  const BLOCKS = { 0: [['09:00', '12:00'], ['12:00', '15:00']], 1: WD, 2: WD, 3: WD, 4: WD, 5: WD, 6: [['13:00', '16:00'], ['16:00', '18:00']] };
  const antwort = (rolle) => ({
    ok: true, week: MON,
    me: rolle === 'admin' ? { employeeId: null, name: 'Admin', role: 'admin', initials: 'A' }
      : { employeeId: 'e1', name: 'Anna Beck', role: 'trainer', initials: 'AB' },
    canDecide: rolle === 'admin',
    days: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      date: ADD(MON, i),
      shifts: i === 0 ? [
        { id: 's1', date: ADD(MON, 0), start: '09:30', end: '11:30', role: 'flaeche', assignee: { id: 'e1', name: 'Anna Beck', initials: 'AB' }, board: false, postMode: null, applicants: [] },
        { id: 's2', date: ADD(MON, 0), start: '15:00', end: '17:30', role: 'reinigung', assignee: null, board: true, postMode: 'apply', deadline: 'heute 20:00', applicants: [{ id: 'e2', name: 'Ben Cordes', initials: 'BC' }] },
      ] : i === 2 ? [
        { id: 's3', date: ADD(MON, 2), start: '11:30', end: '13:00', role: 'theke', assignee: { id: 'e2', name: 'Ben Cordes', initials: 'BC' }, board: false, postMode: null, applicants: [] },
      ] : [],
    })),
    openCount: 1, swapBadge: 0,
    availability: [
      { employeeId: 'e1', name: 'Anna Beck', reported: true, src: 'self', blocks: { mo: [0, 1], di: [2, 3], mi: [], do: [], fr: [], sa: [0], so: [] }, soft: { di: true } },
      { employeeId: 'e2', name: 'Ben Cordes', reported: true, src: 'lead', blocks: { mi: [0, 1, 2, 3, 4] }, soft: {} },
    ],
    vacations: [
      { id: 'u1', employeeId: 'e2', name: 'Ben Cordes', from: ADD(MON, 2), to: ADD(MON, 4), days: 3, status: 'pending', kind: 'urlaub' },
      { id: 'u2', employeeId: 'e1', name: 'Anna Beck', from: ADD(MON, 30), to: ADD(MON, 34), days: 5, status: 'approved', kind: 'urlaub' },
    ],
    vacPending: 1,
    staff: [
      { id: 'e1', name: 'Anna Beck', initials: 'AB', type: 'Teilzeit', areas: ['flaeche', 'reinigung'], monthMax: 90, vacDays: 28, monthHours: 12, stored: true, active: true },
      { id: 'e2', name: 'Ben Cordes', initials: 'BC', type: 'Minijob', areas: ['theke'], monthMax: 43.5, vacDays: 24, monthHours: 1.5, stored: false, active: true },
    ],
    blocks: BLOCKS, areas: ['flaeche', 'reinigung', 'theke', 'kurs'],
  });

  const b = await chromium.launch({ executablePath: bin });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const fehler = [];
  p.on('pageerror', function (e) { fehler.push(String(e.message)); });
  await p.setContent(html, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(250);

  const anmelden = async function (rolle) {
    await p.evaluate(function (pl) {
      window.__calls = [];
      window.tapi = async function (pfad, opts) {
        window.__calls.push({ pfad: pfad, body: (opts && opts.body) || null });
        return JSON.parse(JSON.stringify(pl));
      };
      S.token = 'x'; S.screen = 'schicht'; S.booted = true; S.role = pl.me.role;
      S.spMode = 'planner'; S.spScreen = 'result';
      S.shWeek = pl.week; S.shData = JSON.parse(JSON.stringify(pl));
      S.spSA = null; S.spSoft = null; S.spToast = ''; S.spPerson = null;
      render();
    }, antwort(rolle));
    await p.waitForTimeout(250);
  };

  // ── Beispielbetrieb ──
  await p.evaluate(function () {
    S.token = 'x'; S.screen = 'schicht'; S.role = 'admin'; S.booted = true;
    S.spMode = 'planner'; S.spScreen = 'result'; S.shData = null; render();
  });
  await p.waitForTimeout(250);
  const demo = await p.evaluate(function () {
    return { live: spLive(), kw: spKW(), leute: Object.keys(spTeam()).length,
      hinweis: document.querySelector('.sp-desk').innerText.toLowerCase().indexOf('beispieldaten') >= 0 };
  });
  ok('3. Ohne Serverantwort laeuft das Beispiel', demo.live === false && demo.leute === 8, JSON.stringify(demo));
  ok('3b. … und sagt das auch', demo.hinweis === true);

  // ── Mit Serverantwort ──
  await anmelden('admin');
  const live = await p.evaluate(function () {
    return {
      live: spLive(), kw: spKW(),
      hinweisWeg: document.querySelector('.sp-desk').innerText.toLowerCase().indexOf('beispieldaten') < 0,
      tage: spDays().map(function (d) { return d[1]; }).join(','),
      leute: Object.keys(spTeam()).join(','),
      schichten: spShifts().map(function (x) { return x.day + ':' + x.id + ':' + x.area + ':' + x.a + '-' + x.b + ':' + (x.who || 'offen') + ':' + x.st; }).join(' | '),
      bloecke: spSlotsFor(0).length + '/' + spSlotsFor(5).length + '/' + spSlotsFor(6).length,
    };
  });
  ok('4. Mit Serverantwort zaehlt die echte Woche', live.live === true && live.kw === 'KW 32', JSON.stringify({ l: live.live, k: live.kw }));
  ok('4b. … und der Beispiel-Hinweis verschwindet', live.hinweisWeg === true);
  ok('4c. … die Spalten tragen die echten Daten',
    live.tage === '03.08.,04.08.,05.08.,06.08.,07.08.,08.08.,09.08.', live.tage);
  ok('4d. … und die echten Personen', live.leute === 'e1,e2', live.leute);

  // Die Uebersetzung selbst: Datum -> Spalte, HH:MM -> Dezimalstunde,
  // Rolle -> Bereich, Brett -> ausgeschrieben. Hier wird es still falsch.
  ok('5. Schichten landen in der richtigen Spalte mit den richtigen Zeiten',
    live.schichten === '0:s1:flaeche:9.5-11.5:e1:ai | 0:s2:reinigung:15-17.5:offen:posted | 2:s3:theke:11.5-13:e2:ai',
    live.schichten);
  // Die Bloecke kommen aus dem Studio-Wochenplan (Mo–Fr 5, Sa 2, So 2) - NICHT
  // aus den vier Bloecken des Entwurfs.
  ok('5b. Die Schichtbloecke kommen vom Server, nicht aus dem Entwurf',
    live.bloecke === '5/2/2', live.bloecke);

  const av = await p.evaluate(function () {
    const a = spAvail();
    return { e1: JSON.stringify(a.e1.d), e1soft: a.e1.soft.join(','), e1src: a.e1.src, e2src: a.e2.src };
  });
  // Gemeldet sind Bloecke; die Matrix zeichnet daraus ein Fenster. Mo 0+1 =
  // 9:30–13:00, Di 2+3 = 15:00–19:30, Sa 0 = 13:00–16:00.
  ok('6. Gemeldete Bloecke werden zum richtigen Fenster',
    av.e1 === '[[9.5,13],[15,19.5],null,null,null,[13,16],null]', av.e1);
  ok('6b. „nur wenn nötig" bleibt erhalten', av.e1soft === '1', av.e1soft);
  ok('6c. Die Quelle der Angabe bleibt unterscheidbar',
    av.e1src === 'self' && av.e2src === 'lead', av.e1src + '/' + av.e2src);

  const urlaub = await p.evaluate(function () {
    const d = spWeekISO();
    return { liste: spVacs().map(function (v) { return v.staffId + ':' + v.fromISO + '..' + v.toISO; }).join(' | '),
      benMi: spVacOn('e2', d[2]), benMo: spVacOn('e2', d[0]), annaMi: spVacOn('e1', d[2]) };
  });
  ok('7. Urlaub trifft die richtigen Tage',
    urlaub.benMi === true && urlaub.benMo === false && urlaub.annaMi === false, JSON.stringify(urlaub));

  // Alle Bildschirme muessen mit echten Daten stehen – auch die, in denen der
  // Entwurf feste Namen hatte.
  const kaputt = [];
  for (const sc of ['result', 'postings', 'team', 'matrix', 'year', 'settings', 'print', 'inbox', 'setup', 'person']) {
    await p.evaluate(function (s) { S.spScreen = s; if (s === 'person') S.spPerson = 'e1'; render(); }, sc);
    await p.waitForTimeout(160);
    const r = await p.evaluate(function () {
      const d = document.querySelector('.sp-desk');
      return { zeilen: d.innerText.trim().split('\n').length, breit: d.scrollWidth <= d.clientWidth };
    });
    if (r.zeilen < 8 || !r.breit) kaputt.push(sc + ':' + JSON.stringify(r));
  }
  ok('8. Alle Planer-Bildschirme stehen mit echten Daten', kaputt.length === 0, kaputt.join(' | '));

  const staffKaputt = [];
  for (const sc of ['home', 'plan', 'avail', 'open', 'absence', 'vacnew', 'notif']) {
    await p.evaluate(function (s) { S.spMode = 'staff'; S.spStaff = s; render(); }, sc);
    await p.waitForTimeout(150);
    const n = await p.evaluate(function () {
      const el = document.querySelector('.sp-phonescroll');
      return el ? el.innerText.trim().split('\n').length : 0;
    });
    // Mitteilungen sind live erst mal leer – das ist ein Zustand, kein Fehler.
    if (n < (sc === 'notif' ? 3 : 6)) staffKaputt.push(sc + ':' + n);
  }
  ok('8b. Und die Mitarbeiter-Seite ebenso', staffKaputt.length === 0, staffKaputt.join(', '));
  // Erfundene Mitteilungen waeren hier besonders schlecht: „Tauschanfrage von
  // Kathrin" liest sich wie eine echte Bitte an einen echten Menschen.
  const mitteilungen = await p.evaluate(function () {
    S.spMode = 'staff'; S.spStaff = 'notif'; render();
    return new Promise(function (r) {
      setTimeout(function () {
        const t = document.querySelector('.sp-phonescroll').innerText;
        r({ leer: /Keine Mitteilungen/.test(t), kathrin: /Kathrin/.test(t) });
      }, 200);
    });
  });
  ok('8c. Mitteilungen sind live ehrlich leer statt erfunden',
    mitteilungen.leer === true && mitteilungen.kathrin === false, JSON.stringify(mitteilungen));

  // Die Startseite gruesst mit dem echten Namen und rechnet mit echten Zahlen.
  await anmelden('trainer');
  const zuhause = await p.evaluate(function () {
    S.spMode = 'staff'; S.spStaff = 'home'; render();
    return new Promise(function (r) {
      setTimeout(function () {
        const t = document.querySelector('.sp-phonescroll').innerText;
        r({ anna: /Anna/.test(t), markus: /Markus/.test(t), std: /12/.test(t) && /90/.test(t),
          erfunden: /118/.test(t) || /Kathrin/.test(t) });
      }, 220);
    });
  });
  ok('8d. Die Mitarbeiter-Startseite gruesst die richtige Person',
    zuhause.anna === true && zuhause.markus === false, JSON.stringify(zuhause));
  ok('8e. … mit den eigenen Stunden statt denen des Entwurfs',
    zuhause.std === true && zuhause.erfunden === false, JSON.stringify(zuhause));
  await anmelden('admin');

  // Die eigene Verfuegbarkeit kommt vom Server, nicht aus dem Entwurf. Das
  // braucht eine persoenliche Anmeldung - ein Passwort-Login der Leitung hat
  // keine Mitarbeiter-Identitaet und kann fuer sich auch nichts melden.
  await anmelden('trainer');
  const sa = await p.evaluate(function () {
    S.spMode = 'staff'; S.spStaff = 'avail'; S.spSA = null; S.spSoft = null; render();
    return { sa: JSON.stringify(spSA()), soft: JSON.stringify(spSoft()) };
  });
  ok('9. Die eigene Verfuegbarkeit ist die gemeldete',
    sa.sa === '[[0,1],[2,3],[],[],[],[0],[]]' && sa.soft === '{"1":true}', JSON.stringify(sa));
  await anmelden('admin');
  const ohneId = await p.evaluate(function () {
    S.spMode = 'staff'; S.spStaff = 'avail'; S.spSA = null; S.spSoft = null; render();
    return { ich: spMe(), sa: JSON.stringify(spSA()) };
  });
  ok('9b. Ein Passwort-Login der Leitung meldet fuer niemanden',
    ohneId.ich === null && ohneId.sa === '[[],[],[],[],[],[],[]]', JSON.stringify(ohneId));

  // ── Aenderungen gehen an den Server ──
  await p.evaluate(function () { window.__calls = []; S.spMode = 'planner'; S.spScreen = 'postings'; render(); });
  await p.waitForTimeout(180);
  await p.evaluate(function () { return spAssignTo('s2', 'e1'); });
  await p.waitForTimeout(220);
  await p.evaluate(function () { return spDecideVac('u1', true); });
  await p.waitForTimeout(220);
  await p.evaluate(function () { return spPublishShift('s1', 'instant'); });
  await p.waitForTimeout(220);
  const calls = await p.evaluate(function () { return window.__calls.map(function (c) { return c.body; }).filter(Boolean); });
  const aktionen = calls.map(function (c) { return c.action; }).join(', ');
  ok('10. Jede Aenderung geht an den Server',
    aktionen === 'update, vac-decide, post', aktionen);
  // Die Woche muss mit – sonst antwortet der Server mit einer anderen.
  ok('10b. … immer mit der gewaehlten Woche',
    calls.every(function (c) { return c.week === MON; }), JSON.stringify(calls.map(function (c) { return c.week; })));
  await anmelden('trainer');
  await p.evaluate(function () {
    window.__calls = [];
    S.spMode = 'staff'; S.spStaff = 'avail'; S.spSA = [[0], [], [], [], [], [], []]; S.spSoft = { 1: true };
    return spSaveAvail();
  });
  await p.waitForTimeout(250);
  const avSet = await p.evaluate(function () {
    return (window.__calls.map(function (c) { return c.body; }).filter(Boolean)
      .filter(function (c) { return c.action === 'avail-set'; })[0]) || null;
  });
  ok('10c. Die Verfuegbarkeit geht als Bloecke je Wochentag hin',
    avSet && avSet.blocks && avSet.blocks.mo.join(',') === '0' && avSet.soft.di === true, JSON.stringify(avSet));

  // ── Was eine Angestellte NICHT angeboten bekommt ──
  await anmelden('trainer');
  await p.evaluate(function () { S.spScreen = 'postings'; render(); });
  await p.waitForTimeout(220);
  const alsTrainer = await p.evaluate(function () {
    return { post: document.querySelectorAll('[data-sppost]').length,
      postall: document.querySelectorAll('[data-sppostall]').length,
      unpost: document.querySelectorAll('[data-spunpost]').length,
      hinweis: /Leitung/.test(document.querySelector('.sp-desk').innerText) };
  });
  ok('11. Ohne Leitungsrecht wird Ausschreiben nicht angeboten',
    alsTrainer.post === 0 && alsTrainer.postall === 0 && alsTrainer.unpost === 0, JSON.stringify(alsTrainer));
  ok('11b. … und es steht dabei, warum', alsTrainer.hinweis === true);

  await p.evaluate(function () { S.spScreen = 'person'; S.spPerson = 'e2'; render(); });
  await p.waitForTimeout(220);
  const entscheiden = await p.$$eval('[data-spvacok]', function (e) { return e.length; });
  ok('11c. … und ueber Urlaub entscheidet sie auch nicht', entscheiden === 0, String(entscheiden));

  await anmelden('admin');
  await p.evaluate(function () { S.spScreen = 'person'; S.spPerson = 'e2'; render(); });
  await p.waitForTimeout(220);
  const alsChef = await p.$$eval('[data-spvacok]', function (e) { return e.length; });
  ok('11d. Die Leitung dagegen schon', alsChef === 1, String(alsChef));

  // ── Freigaben und Bewerbungen ──
  // Der gefaehrlichste Bildschirm: ein erfundener Antrag mit echt aussehendem
  // Namen und einem Knopf „Genehmigen". Wer den drueckt, glaubt entschieden zu
  // haben. Live muessen dort die WIRKLICH offenen Antraege stehen.
  await p.evaluate(function () { S.spMode = 'planner'; S.spScreen = 'inbox'; S.spInboxTab = 'urlaub'; render(); });
  await p.waitForTimeout(220);
  const freigaben = await p.evaluate(function () {
    const t = document.querySelector('.sp-desk').innerText;
    return { text: t, gudrun: /Gudrun/.test(t), ben: /Ben Cordes/.test(t),
      knoepfe: Array.from(document.querySelectorAll('[data-spact]'))
        .map(function (b) { return b.getAttribute('data-spact'); }).join(',') };
  });
  ok('13. Die Freigaben zeigen den echten offenen Antrag',
    freigaben.ben === true && freigaben.gudrun === false, JSON.stringify({ b: freigaben.ben, g: freigaben.gudrun }));
  ok('13b. … und die Knoepfe tragen dessen ID',
    /vacok:u1/.test(freigaben.knoepfe) && /vacno:u1/.test(freigaben.knoepfe), freigaben.knoepfe);
  // Die Folgenabschaetzung ist gerechnet, nicht behauptet: Ben hat in dem
  // beantragten Zeitraum genau eine Schicht (Mi).
  ok('13c. Die Folgen sind aus den Schichten gerechnet',
    /1\s*Schichten/.test(freigaben.text.replace(/\n/g, ' ')), freigaben.text.replace(/\n/g, ' ').slice(0, 300));

  // Fehlt der Knopf, haengen alle folgenden Pruefungen in der Luft – dann lieber
  // hier sauber abbrechen als mit einem Stapelabzug enden.
  if (!/vacok:u1/.test(freigaben.knoepfe)) { console.log('SP-LIVE FAIL'); await b.close(); process.exit(1); }
  await p.evaluate(function () { window.__calls = []; });
  await p.click('[data-spact="vacok:u1"]');
  await p.waitForTimeout(250);
  const entschied = await p.evaluate(function () {
    return (window.__calls.map(function (c) { return c.body; }).filter(Boolean)[0]) || null; });
  ok('13d. Genehmigen entscheidet wirklich den Antrag',
    entschied && entschied.action === 'vac-decide' && entschied.id === 'u1' && entschied.ok === true,
    JSON.stringify(entschied));

  // Bewerbungen: echte Bewerber mit gerechneten Fakten statt erfundener.
  await p.evaluate(function () { S.spScreen = 'applicants'; S.spApplFor = 's2'; render(); });
  await p.waitForTimeout(220);
  const bew = await p.evaluate(function () {
    const t = document.querySelector('.sp-desk').innerText;
    return { ben: /Ben Cordes/.test(t), gudrun: /Gudrun/.test(t),
      zusagen: Array.from(document.querySelectorAll('[data-spaccept]'))
        .map(function (b) { return b.getAttribute('data-spaccept'); }).join(',') };
  });
  ok('14. Die Bewerbungen sind die echten',
    bew.ben === true && bew.gudrun === false && bew.zusagen === 's2:e2', JSON.stringify(bew));

  if (bew.zusagen !== 's2:e2') { console.log('SP-LIVE FAIL'); await b.close(); process.exit(1); }
  await p.evaluate(function () { window.__calls = []; });
  await p.click('[data-spaccept="s2:e2"]');
  await p.waitForTimeout(250);
  const zusage = await p.evaluate(function () {
    return (window.__calls.map(function (c) { return c.body; }).filter(Boolean)[0]) || null; });
  ok('14b. Zusagen vergibt die Schicht wirklich',
    zusage && zusage.action === 'accept-applicant' && zusage.id === 's2' && zusage.employeeId === 'e2',
    JSON.stringify(zusage));

  // ── Der erste Start ──
  // Frisches Studio: Speicher da, aber nichts drin. Genau hier war der Plan
  // vorher eine Sackgasse - kein Mitarbeiter, und kein Weg, einen anzulegen.
  const leer = { ok: true, week: MON, me: { employeeId: null, name: 'Admin', role: 'admin', initials: 'A' },
    canDecide: true,
    days: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ date: ADD(MON, i), shifts: [] })),
    openCount: 0, swapBadge: 0, availability: [], vacations: [], vacPending: 0,
    staff: [], blocks: BLOCKS, areas: ['flaeche', 'reinigung', 'theke', 'kurs'] };
  await p.evaluate(function (pl) {
    window.__calls = [];
    window.tapi = async function (pfad, opts) { window.__calls.push({ body: (opts && opts.body) || null }); return JSON.parse(JSON.stringify(pl)); };
    S.token = 'x'; S.screen = 'schicht'; S.role = 'admin'; S.booted = true;
    S.spMode = 'planner'; S.spScreen = 'result'; S.spEmpForm = null;
    S.shWeek = pl.week; S.shData = JSON.parse(JSON.stringify(pl));
    render();
  }, leer);
  await p.waitForTimeout(250);
  const start = await p.evaluate(function () {
    const t = document.querySelector('.sp-desk').innerText;
    return { live: spLive(), hinweis: /Zuerst das Team anlegen/.test(t), knopf: !!document.querySelector('[data-spgoteam]') };
  });
  ok('15. Der leere Plan sagt, was zuerst zu tun ist',
    start.live === true && start.hinweis === true && start.knopf === true, JSON.stringify(start));

  await p.click('[data-spgoteam]');
  await p.waitForTimeout(220);
  const beiTeam = await p.evaluate(function () {
    return { screen: S.spScreen, sec: S.spSetSec,
      anlegen: !!document.querySelector('[data-spempnew]'),
      importieren: !!document.querySelector('[data-spempimport]') };
  });
  ok('15b. … und fuehrt dorthin, wo man es tut',
    beiTeam.screen === 'settings' && beiTeam.sec === 'team' && beiTeam.anlegen && beiTeam.importieren,
    JSON.stringify(beiTeam));

  // Anlegen von Hand: Name, Beschaeftigung, Grenzen, Bereiche.
  await p.click('[data-spempnew]');
  await p.waitForTimeout(200);
  await p.fill('#spempf_name', 'Clara Dorn');
  await p.fill('#spempf_type', 'Teilzeit');
  await p.fill('#spempf_max', '90');
  await p.fill('#spempf_vac', '28');
  await p.click('[data-spempfarea="reinigung"]');       // zweiter Bereich dazu
  await p.waitForTimeout(200);
  const nachChip = await p.evaluate(function () {
    return { name: document.querySelector('#spempf_name').value, areas: spEmpForm().areas.join(',') };
  });
  // Der Klick auf einen Chip zeichnet neu. Ginge der getippte Name dabei
  // verloren, waere das Formular unbenutzbar.
  ok('16. Ein Bereichsklick verliert die getippten Werte nicht',
    nachChip.name === 'Clara Dorn' && nachChip.areas === 'flaeche,reinigung', JSON.stringify(nachChip));

  await p.evaluate(function () { window.__calls = []; });
  await p.click('[data-spempsave]');
  await p.waitForTimeout(280);
  const gespeichert = await p.evaluate(function () {
    return (window.__calls.map(function (c) { return c.body; }).filter(Boolean)[0]) || null; });
  ok('16b. Speichern legt den Mitarbeiter wirklich an',
    gespeichert && gespeichert.action === 'staff-set' && gespeichert.name === 'Clara Dorn'
      && gespeichert.monthMax === 90 && gespeichert.vacDays === 28 && gespeichert.areas.join(',') === 'flaeche,reinigung',
    JSON.stringify(gespeichert));
  ok('16c. … und vergibt eine Kennung, wenn keine da ist',
    gespeichert && !!String(gespeichert.employeeId || '').trim(), JSON.stringify(gespeichert && gespeichert.employeeId));

  await p.evaluate(function () { window.__calls = []; });
  await p.click('[data-spempimport]');
  await p.waitForTimeout(250);
  const importiert = await p.evaluate(function () {
    return (window.__calls.map(function (c) { return c.body; }).filter(Boolean)[0]) || null; });
  ok('16d. „Aus Magicline übernehmen" ruft den Abgleich',
    importiert && importiert.action === 'staff-import', JSON.stringify(importiert));

  // Team da, Woche leer: der naechste Schritt ist der Wochenplan.
  await p.evaluate(function (pl) {
    pl.staff = [{ id: 'e1', name: 'Anna Beck', initials: 'AB', type: 'Teilzeit', areas: ['flaeche'], monthMax: 90, vacDays: 28, monthHours: 0, stored: true, active: true }];
    S.shData = JSON.parse(JSON.stringify(pl)); S.spScreen = 'result'; render();
  }, leer);
  await p.waitForTimeout(220);
  const ohneSchichten = await p.evaluate(function () {
    return { text: /keine Schichten/.test(document.querySelector('.sp-desk').innerText),
      knopf: document.querySelectorAll('[data-spreset]').length };
  });
  ok('17. Ist das Team da, fehlt nur noch der Wochenplan',
    ohneSchichten.text === true && ohneSchichten.knopf >= 1, JSON.stringify(ohneSchichten));

  await p.evaluate(function () { window.__calls = []; });
  await p.click('[data-spreset]');
  await p.waitForTimeout(250);
  const gefuellt = await p.evaluate(function () {
    return (window.__calls.map(function (c) { return c.body; }).filter(Boolean)[0]) || null; });
  // Live darf der Knopf NICHTS wegwerfen - er legt nur die fehlenden Tage an.
  ok('17b. Der Knopf legt an, statt zurueckzusetzen',
    gefuellt && gefuellt.action === 'fillTemplate', JSON.stringify(gefuellt));

  ok('12. Kein Skriptfehler auf allen Bildschirmen', fehler.length === 0, fehler.join(' | '));

  await b.close();
  console.log(pass ? 'SP-LIVE PASS' : 'SP-LIVE FAIL');
  process.exit(pass ? 0 : 1);
})();
