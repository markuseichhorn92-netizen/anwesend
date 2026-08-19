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

console.log(pass?'SP-SHELL PASS':'SP-SHELL FAIL');
process.exit(pass?0:1);
