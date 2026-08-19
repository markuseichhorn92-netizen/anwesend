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

// ── Ausschreibungen, Mitarbeiter, Person ──
ok('16. Ausschreibungen sind uebernommen', /function spPostingsHTML/.test(html));
ok('16b. Die Mitarbeiterliste ebenso', /function spTeamHTML/.test(html));
ok('16c. … und die Personenansicht', /function spPersonHTML/.test(html));
// Erreichbar muessen sie auch sein - eine Funktion, die niemand aufruft, ist
// gebaut und trotzdem nicht da.
const dispatch=html.slice(html.indexOf('function schichtNode'), html.indexOf('function spTitel'));
['spPostingsHTML','spTeamHTML','spPersonHTML'].forEach(function(fn){
  ok('16d. '+fn+' haengt am Bildschirmwechsel', dispatch.indexOf(fn+'()')>=0, dispatch.slice(0,400));
});
// Und die Navigation darf sie nicht weiter als „in Arbeit" fuehren.
const nav2=html.slice(html.indexOf('var SP_PLAN='), html.indexOf('function spNavBtn'));
ok('16e. Ausschreibungen und Personen sind nicht mehr „in Arbeit"',
  /\{k:'postings',l:'Ausschreibungen', ic:'bell',  bereit:true\}/.test(nav2) &&
  /\{k:'team',   l:'Personen',        ic:'users', bereit:true\}/.test(nav2), nav2);

// Die Mitarbeiter-Seite ist der Entwurf als Telefon. Bliebe hier der Platzhalter
// stehen, waere die Halfte der Anwendung unsichtbar.
ok('16f. Die Mitarbeiter-Seite haengt am Rollenumschalter',
  dispatch.indexOf('spPhoneHTML()')>=0 && dispatch.indexOf("spTodoHTML('Mitarbeiter-Ansicht')")<0, dispatch.slice(-500));

// Die Rueckmeldung stand frueher NUR im Plan. Damit blieben Zusagen, Freigaben
// und Ausschreibungen anderswo stumm: klicken, nichts sehen.
ok('17. Die Rueckmeldung haengt an der Huelle', /function spToastHTML/.test(html));
const res=html.slice(html.indexOf('function spResultHTML'), html.indexOf('// Die Rueckmeldung gehoert'));
ok('17b. … und nicht mehr nur im Plan', res.indexOf('S.spToast')<0, res.slice(-260));
ok('17c. … sie wird in der Huelle gezeichnet', /\+spToastHTML\(\)\+/.test(dispatch), dispatch.slice(-300));

// Die Eignungspruefung kennt drei Ausgaenge, nicht zwei. Faellt „mit Abstrich"
// weg, verschwindet der halbe Nutzen: knappe Faelle waeren entweder verboten
// oder unsichtbar durchgewunken.
const fit=html.slice(html.indexOf('function spFitCheck'), html.indexOf('function spStartStaffDrag'));
ok('18. Die Eignungspruefung kennt „geht, aber mit Abstrich"',
  (fit.match(/soft:true/g)||[]).length===2, String((fit.match(/soft:true/g)||[]).length)+' von 2');
ok('18b. … prueft die gemeldete Verfuegbarkeit', /spAvail\(\)\[staffId\]/.test(fit), fit.slice(0,200));
ok('18c. … und Doppelbelegung am selben Tag', /x\.a<sh\.b && x\.b>sh\.a/.test(fit), fit.slice(0,200));
// Wer „nur mit Abstrich" passt, wird als Konflikt eingeplant - sonst sieht die
// Leitung spaeter nicht mehr, dass da etwas klemmt.
const sdrag=html.slice(html.indexOf('function spStartStaffDrag'), html.indexOf('function spWireResult'));
ok('18d. Abstriche landen sichtbar als Konflikt im Plan',
  /st=chk\.soft\?'conflict':'ai'/.test(sdrag), sdrag.slice(-400));

// ── Mit Browser: das Verhalten selbst ──
(async function(){
  let chromium=null;
  try{ chromium=require('playwright-core').chromium; }catch(e){ chromium=null; }
  const kandidaten=['/opt/pw-browsers/chromium-1194/chrome-linux/chrome','/opt/pw-browsers/chromium/chrome-linux/chrome'];
  const bin=kandidaten.filter(function(p){ try{ return fs.existsSync(p); }catch(e){ return false; } })[0];
  if(!chromium||!bin){
    console.log('HINWEIS Kein Browser vorhanden – die Verhaltenspruefungen (19–22) liefen NICHT.');
    console.log(pass?'SP-SHELL PASS (ohne Browser)':'SP-SHELL FAIL');
    process.exit(pass?0:1);
  }

  const b=await chromium.launch({executablePath:bin});
  const p=await b.newPage({viewport:{width:1440,height:1000}});
  const fehler=[];
  p.on('pageerror',function(e){ fehler.push(String(e.message)); });
  await p.setContent(html,{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(250);
  const zeige=async function(sc){
    await p.evaluate(function(s){
      window.S.token='x'; window.S.screen='schicht'; window.S.role='admin'; window.S.booted=true;
      window.S.spMode='planner'; window.S.spScreen=s;
      window.S.spShifts=null; window.S.spVac=null; window.S.spAvail=null; window.S.spToast='';
      window.render();
    }, sc);
    await p.waitForTimeout(220);
  };
  const toastText=function(){ return p.evaluate(function(){
    const d=Array.from(document.querySelectorAll('.sp-desk > div'))
      .filter(function(x){ return /bottom:26px/.test(x.getAttribute('style')||''); })[0];
    return d?(d.innerText+'|'+Math.round(d.getBoundingClientRect().width)):'';
  }); };

  await zeige('postings');

  // Die Karten muessen genau den Schichten entsprechen, die Besetzung brauchen.
  // Zaehlt die Ansicht anders als die Daten, sieht die Leitung Luecken nicht.
  const soll=await p.evaluate(function(){
    return spShifts().filter(function(x){
      return x.st!=='posted' && (!x.who||x.st==='blocked'||(x.who&&spVacOn(x.who,spDomOf(x.day)))||x.st==='conflict');
    }).length;
  });
  const ist=await p.$$eval('[data-sppost]',function(e){ return e.length; });
  ok('19. Jede Schicht, die Besetzung braucht, hat eine Karte', soll===ist && soll>0, ist+' von '+soll);

  // Urlaub muss der genannte Grund sein, auch wenn zusaetzlich ein Konflikt
  // haengt - sonst sucht jemand nach einem Regelfehler, der keiner ist.
  const gruende=await p.evaluate(function(){
    return Array.from(document.querySelectorAll('.sp-desk [style*="border-left:3px"]')).map(function(c){
      return c.innerText.replace(/\n/g,' ');
    });
  });
  ok('19b. Urlaub wird als Grund genannt', gruende.some(function(t){ return /URLAUB/i.test(t) && /im Urlaub/.test(t); }),
    gruende.join(' // ').slice(0,300));

  // Der erste Vorschlag muss der beste sein. Waere die Liste unsortiert, waere
  // der schnelle Klick der schlechteste Griff.
  const erste=await p.evaluate(function(){
    const karte=document.querySelector('.sp-desk [data-sppost]').closest('[style*="border-left:3px"]');
    const id=karte.querySelector('[data-sppost]').getAttribute('data-sppost');
    const sh=spShifts().filter(function(x){ return x.id===id; })[0];
    const c=spCandidatesFor(sh);
    const chip=karte.querySelector('[data-spassign]');
    return { chipWer:chip?chip.getAttribute('data-spassign').split(':')[1]:null,
      besterWer:c[0]?c[0].id:null, bestOk:c[0]?!!c[0].ok:false,
      sortiert:c.every(function(x,i){ return i===0||c[i-1].score>=x.score; }) };
  });
  ok('19c. Der erste Vorschlag ist der bestbewertete',
    erste.chipWer===erste.besterWer && erste.sortiert, JSON.stringify(erste));

  // „Alle offenen" darf NUR wirklich offene Schichten ausschreiben. Wer im
  // Urlaub eingeplant ist, gehoert einzeln entschieden, nicht per Sammelklick.
  const vorher=await p.evaluate(function(){
    return { offen:spShifts().filter(function(x){ return (!x.who||x.st==='blocked')&&x.st!=='posted'; }).length,
      karten:document.querySelectorAll('[data-sppost]').length }; });
  await p.click('[data-sppostall]'); await p.waitForTimeout(260);
  const nachher=await p.$$eval('[data-spunpost]',function(e){ return e.length; });
  ok('20. Sammelausschreibung nimmt nur die wirklich offenen',
    nachher===vorher.offen && vorher.offen<vorher.karten, JSON.stringify({nachher:nachher, vorher:vorher}));
  const t1=await toastText();
  ok('20b. … und sagt sichtbar Bescheid', /Schichten ausgeschrieben/.test(t1) && parseInt(t1.split('|')[1],10)>0, t1);

  await p.click('[data-spunpost]'); await p.waitForTimeout(260);
  ok('20c. Zurueckziehen wirkt', (await p.$$eval('[data-spunpost]',function(e){ return e.length; }))===nachher-1);

  // Ein Klick auf einen Vorschlag besetzt die Schicht wirklich.
  await zeige('postings');
  const wen=await p.$eval('[data-spassign]',function(e){ return e.getAttribute('data-spassign'); });
  await p.click('[data-spassign]'); await p.waitForTimeout(260);
  const besetzt=await p.evaluate(function(id){
    const t=id.split(':'); const sh=spShifts().filter(function(x){ return x.id===t[0]; })[0];
    return { who:sh.who, st:sh.st, conflict:sh.conflict }; }, wen);
  ok('20d. Ein Vorschlag besetzt die Schicht',
    besetzt.who===wen.split(':')[1] && besetzt.st==='ai' && !besetzt.conflict, JSON.stringify(besetzt));

  // ── Mitarbeiterliste und Person ──
  await zeige('team');
  const zeilen=await p.$$eval('[data-spperson]',function(e){ return e.length; });
  ok('21. Jede Person steht in der Liste',
    zeilen===(await p.evaluate(function(){ return Object.keys(SP_STAFF).length; })), String(zeilen));
  // Knappe Stundenkonten muessen sich abheben, sonst faellt es niemandem auf.
  const knapp=await p.evaluate(function(){
    const z=Array.from(document.querySelectorAll('[data-spperson]'))
      .filter(function(d){ return d.getAttribute('data-spperson')==='ka'; })[0];
    return /var\(--wn\)/.test(z.innerHTML); });
  ok('21b. Ein fast volles Stundenkonto ist gewarnt gefaerbt', knapp===true);

  await p.click('[data-spperson="gu"]'); await p.waitForTimeout(260);
  ok('21c. Der Klick fuehrt zur Person', (await p.evaluate(function(){ return S.spScreen+':'+S.spPerson; }))==='person:gu');

  // Urlaub genehmigen: Zustand UND Oberflaeche muessen mitgehen.
  const vorStatus=await p.evaluate(function(){ return S.spVac.filter(function(v){ return v.staffId==='gu'; })[0].status; });
  await p.click('[data-spvacok]'); await p.waitForTimeout(260);
  const nachStatus=await p.evaluate(function(){
    return { st:S.spVac.filter(function(v){ return v.staffId==='gu'; })[0].status,
      knoepfe:document.querySelectorAll('[data-spvacok]').length }; });
  ok('22. Genehmigen aendert den Antrag',
    vorStatus==='pending' && nachStatus.st==='approved' && nachStatus.knoepfe===0, JSON.stringify(nachStatus));
  ok('22b. … und meldet es sichtbar', /Genehmigt/.test(await toastText()));

  // Der letzte Bereich darf nicht entzogen werden - sonst haette jemand einen
  // Dienstplan-Eintrag ohne jede Qualifikation.
  await p.click('[data-sparea="gu:flaeche"]'); await p.waitForTimeout(260);
  const bereiche=await p.evaluate(function(){ return SP_STAFF.gu.areas.join(','); });
  ok('22c. Der letzte Bereich laesst sich nicht entziehen',
    bereiche==='flaeche' && /mindestens einen Bereich/.test(await toastText()), bereiche);

  ok('22d. Kein Skriptfehler in allen drei Bildschirmen', fehler.length===0, fehler.join(' | '));

  // ── Jahreskalender ──
  await zeige('year');
  const jahr=await p.evaluate(function(){
    const d=document.querySelector('.sp-desk');
    const balken=Array.from(d.querySelectorAll('[style*="top:3px;height:18px"]'));
    const soll=Object.keys(spYearDefs()).reduce(function(n,k){ return n+spYearDefs()[k].length; },0);
    const raus=balken.filter(function(x){
      const l=parseFloat(x.style.left), w=parseFloat(x.style.width);
      return !(l>=0 && l<100 && w>0); });
    // Gudruns Urlaub laeuft ueber Neujahr hinaus. Er darf ueberstehen - aber der
    // Rahmen muss ihn abschneiden, sonst ragt er in die Nachbarspalte.
    const clip=balken.every(function(x){ return getComputedStyle(x.parentNode).overflow==='hidden'; });
    return { balken:balken.length, soll:soll, raus:raus.length, clip:clip,
      monate:d.innerText.indexOf('Kollision')>=0 };
  });
  ok('23. Jede Abwesenheit hat einen Balken', jahr.balken===jahr.soll && jahr.soll>0, JSON.stringify(jahr));
  // Ein Balken, der ausserhalb des Jahres beginnt, sitzt im falschen Monat.
  ok('23b. Jeder Balken beginnt im Jahr', jahr.raus===0, String(jahr.raus));
  ok('23c. … und der Rahmen schneidet Ueberstehendes ab', jahr.clip===true);
  ok('23d. Die Urlaubskollision wird benannt', jahr.monate===true);

  // ── Einstellungen ──
  await zeige('settings');
  const abschnitte=await p.$$eval('[data-spsetsec]',function(e){ return e.map(function(x){ return x.getAttribute('data-spsetsec'); }); });
  ok('24. Alle zehn Abschnitte sind da', abschnitte.length===10, abschnitte.join(','));
  // Ein Abschnitt, der leer bleibt, sieht aus wie ein Fehler - und ist einer.
  const leer=[];
  for(const s of abschnitte){
    await p.click('[data-spsetsec="'+s+'"]'); await p.waitForTimeout(140);
    const zeilenZahl=await p.evaluate(function(){
      const k=document.querySelector('.sp-desk [style*="min-width:320px"]');
      return k?k.innerText.trim().split('\n').length:0; });
    if(zeilenZahl<6) leer.push(s+':'+zeilenZahl);
  }
  ok('24b. Kein Abschnitt bleibt leer', leer.length===0, leer.join(', '));

  await p.click('[data-spsetsec="freigaben"]'); await p.waitForTimeout(160);
  const vorCfg=await p.evaluate(function(){ return spCfg().autoSwap; });
  await p.click('[data-spcfg="autoSwap"]'); await p.waitForTimeout(200);
  const nachCfg=await p.evaluate(function(){
    return { wert:spCfg().autoSwap,
      zeile:document.querySelector('.sp-desk').innerText.split('\n')
        .filter(function(l){ return /Automatiken aktiv/.test(l); })[0]||'' }; });
  ok('25. Ein Schalter aendert die Einstellung wirklich', nachCfg.wert===!vorCfg, JSON.stringify(nachCfg));
  // Die Zahl oben zaehlt genau die vier Automatiken - nicht die Wachpunkte.
  ok('25b. … und der Zaehler oben geht mit',
    nachCfg.zeile.indexOf('3 Automatiken')===0, nachCfg.zeile);

  // ── Export und Druck ──
  await zeige('result');
  await p.click('[data-spexport]'); await p.waitForTimeout(200);
  ok('26. Das Export-Menue bietet vier Druckarten',
    (await p.$$eval('[data-spprint]',function(e){ return e.length; }))===4);
  ok('26b. … dazu CSV und Link', !!(await p.$('[data-spcsv]')) && !!(await p.$('[data-spcopylink]')));
  await p.click('[data-spexpclose]'); await p.waitForTimeout(180);
  ok('26c. … und es schliesst sich beim Klick daneben',
    (await p.evaluate(function(){ return !!S.spExportOpen; }))===false);

  const druck={};
  for(const m of ['aushang','entwurf','stunden','person']){
    await p.evaluate(function(mm){ S.spScreen='print'; S.spPrintMode=mm; render(); }, m);
    await p.waitForTimeout(200);
    druck[m]=await p.evaluate(function(){
      const s=document.querySelector('.sp-desk .psheet');
      return { da:!!s, weiss:s?getComputedStyle(s).backgroundColor:'',
        wasser:/ENTWURF/.test(s?s.innerText:''),
        zeilen:s?s.innerText.trim().split('\n').length:0 }; });
  }
  ok('27. Alle vier Druckarten liefern ein Blatt',
    Object.keys(druck).every(function(k){ return druck[k].da && druck[k].zeilen>12; }), JSON.stringify(druck));
  // Weisses Papier unabhaengig vom Farbschema - sonst druckt jemand dunkelgrau.
  ok('27b. Das Blatt ist immer weiss',
    Object.keys(druck).every(function(k){ return druck[k].weiss==='rgb(255, 255, 255)'; }));
  // Das Wasserzeichen gehoert NUR auf den Entwurf. Faellt es weg, haengt ein
  // unfertiger Plan im Studio; steht es ueberall, glaubt niemand mehr daran.
  ok('27c. Das Wasserzeichen steht nur auf dem Entwurf',
    druck.entwurf.wasser===true && !druck.aushang.wasser && !druck.stunden.wasser && !druck.person.wasser,
    JSON.stringify({e:druck.entwurf.wasser, a:druck.aushang.wasser}));

  // Der Aushang haengt oeffentlich. „Namen zeigen: aus" muss deshalb wirklich
  // die Namen ersetzen, nicht nur eine Vorschau umschalten.
  const namen=await (async function(){
    await p.evaluate(function(){ S.spPrintMode='aushang'; spCfg().exportNames=false; render(); });
    await p.waitForTimeout(200);
    const aus=await p.evaluate(function(){ const t=document.querySelector('.psheet').innerText;
      return { voll:/Harald/.test(t), ini:/\bHA\b/.test(t) }; });
    await p.evaluate(function(){ spCfg().exportNames=true; render(); });
    await p.waitForTimeout(200);
    const an=await p.evaluate(function(){ return /Harald/.test(document.querySelector('.psheet').innerText); });
    return { aus:aus, an:an };
  })();
  ok('28. „Namen zeigen: aus" nimmt die Namen wirklich aus dem Aushang',
    namen.aus.voll===false && namen.aus.ini===true && namen.an===true, JSON.stringify(namen));

  // Gedruckt wird das Blatt, nicht die Bedienung.
  await p.emulateMedia({ media:'print' });
  await p.waitForTimeout(200);
  const gedruckt=await p.evaluate(function(){
    const sicht=function(el){ return !!el && getComputedStyle(el).display!=='none'; };
    return { kopf:sicht(document.querySelector('.sp-desk [data-noprint]')),
      blatt:sicht(document.querySelector('.psheet')),
      hand:sicht(document.querySelector('.sp-hand')) }; });
  await p.emulateMedia({ media:'screen' });
  ok('28b. Im Druck bleibt nur das Blatt',
    gedruckt.blatt===true && gedruckt.kopf===false && gedruckt.hand===false, JSON.stringify(gedruckt));

  // Jetzt ist jeder Navigationspunkt gebaut - kein „in Arbeit" mehr.
  ok('29. Kein Planer-Bildschirm ist mehr „in Arbeit"',
    (await p.evaluate(function(){
      return SP_PLAN.concat(SP_TEAM).concat(SP_SYS).filter(function(n){ return !n.bereit; })
        .map(function(n){ return n.k; }).join(','); }))==='');

  // ── Mitarbeiter-Seite ──
  const staffGo=async function(sc){
    await p.evaluate(function(s){
      S.token='x'; S.screen='schicht'; S.role='admin'; S.booted=true;
      S.spMode='staff'; S.spStaff=s;
      S.spShifts=null; S.spVac=null; S.spSA=null; S.spSoft=null; S.spApplied=null;
      S.spSwapAsked=null; S.spSwapOpen=false; S.spVacFrom=null; S.spVacTo=null;
      S.spPunched=false; S.spToast='';
      render();
    }, sc);
    await p.waitForTimeout(240);
  };
  const phoneText=function(){ return p.evaluate(function(){
    const el=document.querySelector('.sp-phonescroll'); return el?el.innerText.toLowerCase():''; }); };

  // Jeder der acht Bildschirme muss im Rahmen erscheinen - und der Rahmen die
  // Masse des Entwurfs behalten, sonst ist es keine Telefonvorschau mehr.
  const schirme=['home','plan','detail','avail','open','notif','vacnew','absence'];
  const kaputt=[];
  for(const sc of schirme){
    await staffGo(sc);
    const r=await p.evaluate(function(){
      const f=document.querySelector('.sp-desk .sp-phonescroll');
      if(!f) return null;
      const box=f.closest('[style*="height:812px"]');
      return { h:Math.round(box.getBoundingClientRect().height),
        zeilen:f.innerText.trim().split('\n').length,
        nav:!!box.querySelector('[data-spstaff="home"]'),
        quer:f.scrollWidth<=f.clientWidth+1 };
    });
    if(!r||r.h!==812||r.zeilen<6||!r.nav||!r.quer) kaputt.push(sc+':'+JSON.stringify(r));
  }
  ok('30. Alle acht Mitarbeiter-Bildschirme stehen im Telefonrahmen', kaputt.length===0, kaputt.join(' | '));

  // Die Stechuhr laeuft im Sekundentakt und zeichnet dabei die ganze Seite neu.
  // Laeuft sie weiter, nachdem man den Bereich verlassen hat, rechnet der Browser
  // dauerhaft im Leerlauf - genau das darf nicht passieren.
  await staffGo('home');
  await p.click('[data-sppunch]'); await p.waitForTimeout(1300);
  const uhr=await p.evaluate(function(){ return { an:!!S.spPunched, sek:S.spPunchSek }; });
  ok('31. Die Stechuhr laeuft', uhr.an===true && uhr.sek>=1, JSON.stringify(uhr));
  const gestoppt=await p.evaluate(function(){
    S.spMode='planner'; S.spScreen='result'; render();
    const vor=S.spPunchSek;
    return new Promise(function(r){ setTimeout(function(){ r({vor:vor, nach:S.spPunchSek}); },1600); });
  });
  ok('31b. … und steht still, sobald man den Bereich verlaesst',
    gestoppt.vor===gestoppt.nach, JSON.stringify(gestoppt));

  // Verfuegbarkeit: die Bloecke sind der Kern des Bildschirms.
  await staffGo('avail');
  const vorMo=await p.evaluate(function(){ return spSA()[0].join(','); });
  await p.click('[data-spblock="0:2"]'); await p.waitForTimeout(200);
  const nachMo=await p.evaluate(function(){ return spSA()[0].join(','); });
  ok('32. Ein Block laesst sich zuschalten', vorMo==='0,1' && nachMo==='0,1,2', vorMo+' -> '+nachMo);
  await p.click('[data-spallday="0"]'); await p.waitForTimeout(200);
  const alle=await p.evaluate(function(){ return spSA()[0].join(','); });
  await p.click('[data-spallday="0"]'); await p.waitForTimeout(200);
  const keiner=await p.evaluate(function(){ return spSA()[0].join(','); });
  ok('32b. „Alle" und „Keiner" schalten den ganzen Tag', alle==='0,1,2,3' && keiner==='', alle+' / '+keiner);
  await p.click('[data-spsoft="1"]'); await p.waitForTimeout(200);
  ok('32c. „nur wenn nötig" wird gemerkt', (await p.evaluate(function(){ return !!spSoft()[1]; }))===true);

  // Bewerben und zuruecknehmen.
  await staffGo('open');
  const wieViele=await p.$$eval('[data-spapply]',function(e){ return e.length; });
  const shiftId=await p.$eval('[data-spapply]',function(e){ return e.getAttribute('data-spapply'); });
  await p.click('[data-spapply]'); await p.waitForTimeout(220);
  const beworben=await p.evaluate(function(){ return (S.spApplied||[]).join(','); });
  const knopf=await p.$eval('[data-spapply="'+shiftId+'"]',function(e){ return e.innerText; });
  await p.click('[data-spapply="'+shiftId+'"]'); await p.waitForTimeout(220);
  const zurueckgezogen=await p.evaluate(function(){ return (S.spApplied||[]).length; });
  ok('33. Bewerben und zuruecknehmen wirken beide',
    wieViele>0 && beworben===shiftId && /zurückziehen/i.test(knopf) && zurueckgezogen===0,
    JSON.stringify({wieViele:wieViele, beworben:beworben, knopf:knopf, zurueckgezogen:zurueckgezogen}));

  // Urlaubskalender: rueckwaerts gewaehlt muss der Zeitraum sich drehen, sonst
  // stuende „vom 20. bis zum 18." im Antrag.
  await staffGo('vacnew');
  await p.click('[data-spvacday="20"]'); await p.waitForTimeout(160);
  await p.click('[data-spvacday="18"]'); await p.waitForTimeout(160);
  const rueck=await p.evaluate(function(){ return { von:S.spVacFrom, bis:S.spVacTo, n:spVacCount() }; });
  ok('34. Rueckwaerts gewaehlter Zeitraum dreht sich um',
    rueck.von===18 && rueck.bis===20 && rueck.n===3, JSON.stringify(rueck));

  // Die Warnung wird aus den Daten gerechnet. Ein fester Text waere schlimmer als
  // keiner: die Person plant danach ihren Urlaub.
  const warnFuer=async function(a,bb){
    await p.evaluate(function(x){ S.spVacFrom=x[0]; S.spVacTo=x[1]; render(); }, [a,bb]);
    await p.waitForTimeout(200);
    return await phoneText();
  };
  const wKeine=await warnFuer(1,3);        // niemand sonst weg
  const wEine=await warnFuer(5,9);         // Peter im Urlaub
  const wZwei=await warnFuer(22,23);       // Harald + Gudrun
  ok('34b. Ohne Ueberschneidung meldet sie gute Chancen',
    wKeine.indexOf('keine überschneidung')>=0, wKeine.slice(0,120));
  ok('34c. Bei einer Kollegin sagt sie „sollte machbar"',
    wEine.indexOf('sollte machbar')>=0, wEine.slice(0,120));
  ok('34d. Bei zweien warnt sie mit Zahl',
    wZwei.indexOf('schon 2 kolleg')>=0, wZwei.slice(0,160));

  await p.evaluate(function(){ S.spVacFrom=12; S.spVacTo=16; render(); }); await p.waitForTimeout(200);
  const beschriftung=await p.$eval('[data-spvacsend]',function(e){ return e.innerText; });
  await p.click('[data-spvacsend]'); await p.waitForTimeout(280);
  const gesendet=await p.evaluate(function(){
    return { screen:S.spStaff, meine:S.spVac.filter(function(v){ return v.staffId==='ma'; }).length,
      offen:S.spVac.filter(function(v){ return v.staffId==='ma'&&v.status==='pending'; }).length }; });
  ok('35. Ein Antrag landet in der Liste und fuehrt dorthin',
    /5 Tage/.test(beschriftung) && gesendet.screen==='absence' && gesendet.meine===2 && gesendet.offen===1,
    JSON.stringify({knopf:beschriftung, gesendet:gesendet}));

  // Tausch: anfragen zeigt die Kette, zuruecknehmen raeumt sie weg.
  await staffGo('plan');
  await p.click('[data-spdet]'); await p.waitForTimeout(240);
  await p.click('[data-spswapopen]'); await p.waitForTimeout(240);
  const auswaehlbar=await p.$$eval('[data-spswapask]',function(e){ return e.length; });
  await p.click('[data-spswapask]'); await p.waitForTimeout(240);
  const nachTausch=await p.evaluate(function(){
    return { wer:S.spSwapAsked, offen:!!S.spSwapOpen,
      kette:/Wartet auf Freigabe/.test(document.querySelector('.sp-phonescroll').innerText) }; });
  ok('36. Eine Tauschanfrage zeigt den Stand der Kette',
    auswaehlbar>0 && !!nachTausch.wer && nachTausch.offen===false && nachTausch.kette===true,
    JSON.stringify({auswaehlbar:auswaehlbar, nachTausch:nachTausch}));
  // Nur regelkonforme Personen duerfen angefragt werden - der Rest steht mit
  // Schloss da. Waeren alle anfragbar, waere die Pruefung nur Optik.
  ok('36b. Nicht jede Person ist anfragbar', auswaehlbar<4, String(auswaehlbar)+' von 4');

  ok('37. Kein Skriptfehler auf allen Bildschirmen', fehler.length===0, fehler.join(' | '));

  await b.close();
  console.log(pass?'SP-SHELL PASS':'SP-SHELL FAIL');
  process.exit(pass?0:1);
})();
