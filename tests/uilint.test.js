'use strict';
// Prueft die Oberflaechen-Pruefungen selbst. Ein Linter, der nie anschlaegt, ist
// wertlos - deshalb wird hier an kleinen Beispielen belegt, dass er kaputte
// Faelle wirklich meldet und heile durchlaesst. Zusaetzlich der Live-Abgleich
// gegen die echten HTML-Dateien.
const path = require('path');
const fs = require('fs');
const UI = require('../scripts/uilint');
const ROOT = path.resolve(__dirname, '..');

function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // ── Inline-Skripte finden ──
  const doc = '<html><head><script src="/a.js"></script></head><body>'
    + '<script>var a=1;</script>\n<script>\nfunction f(){}\n</script></body></html>';
  const s = UI.inlineScripts(doc);
  ok('1. externe <script src> werden uebersprungen', s.length === 2);
  ok('2. Inhalt des ersten Blocks stimmt', s[0].code === 'var a=1;');
  ok('3. Startzeile wird mitgeliefert', s[1].line === 2, 'line=' + (s[1] && s[1].line));
  ok('4. Dokument ohne Inline-JS -> leere Liste', UI.inlineScripts('<p>nur Text</p>').length === 0);

  // ── Klickziele ──
  const heil = '<button data-act="speichern">S</button><button data-act="abbrechen">A</button>'
    + '<script>var ACT={ speichern:function(){}, abbrechen:function(){} };</script>';
  ok('5. heile Datei meldet keine toten Ziele', UI.deadActions(heil).length === 0, UI.deadActions(heil).join(','));

  const kaputt = '<button data-act="speichern">S</button><button data-act="verschwunden">X</button>'
    + '<script>var ACT={ speichern:function(){} };</script>';
  const dead = UI.deadActions(kaputt);
  ok('6. fehlender Handler wird gemeldet', dead.length === 1 && dead[0] === 'verschwunden', dead.join(','));

  // Genau die zwei Faelle, die im Debug-Pass gefunden wurden.
  const pfAtt = '<button data-act="pfAttDel">Entfernen</button><script>var ACT={ pfBack:function(){} };</script>';
  ok('7. Fall „Postfach-Anhang entfernen" wuerde auffallen', UI.deadActions(pfAtt).join(',') === 'pfAttDel');
  const tagPlan = '<button data-act="tagPlanClose">Zurueck</button><script>var ACT={ trainSeg:function(){} };</script>';
  ok('8. Fall „Plan-Picker Zurueck" wuerde auffallen', UI.deadActions(tagPlan).join(',') === 'tagPlanClose');

  // Schreibweisen des Handlers
  ok('9. Handler mit Leerzeichen erkannt', UI.deadActions('<button data-act="x"></button><script>var A={ x : function(){} };</script>').length === 0);
  ok('10. Handler in Anfuehrungszeichen erkannt', UI.deadActions('<button data-act="x"></button><script>var A={ "x":function(){} };</script>').length === 0);

  // Dynamisch gebaute Ziele duerfen NICHT gemeldet werden (statisch nicht aufloesbar).
  const dyn = '<script>var h=\'<button data-act="\'+k+\'">x</button>\';var A={};</script>';
  ok('11. dynamisch gebaute data-act bleiben aussen vor', UI.deadActions(dyn).length === 0, UI.deadActions(dyn).join(','));

  // ── Live gegen die echten Dateien ──
  for (const h of ['mitglieder.html', 'team-backend.html']) {
    const p = path.join(ROOT, h);
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, 'utf8');
    const blocks = UI.inlineScripts(html);
    ok('12. ' + h + ': Inline-JS gefunden (' + blocks.length + ' Bloecke)', blocks.length > 0);
    const d = UI.deadActions(html);
    ok('13. ' + h + ': keine toten Klickziele', d.length === 0, d.join(', '));
  }

  // Die Mitglieder-App muss eine nennenswerte Zahl Klickziele haben - faellt das auf
  // null, greift die Erkennung ins Leere und der Test wuerde sonst still gruen bleiben.
  const mit = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
  const n = UI.declaredActions(mit).size;
  ok('14. Klickziele werden ueberhaupt erkannt (' + n + ')', n > 100, 'gefunden=' + n);

  console.log(pass ? 'UILINT PASS' : 'UILINT FAIL');
  process.exit(pass ? 0 : 1);
}
run();
