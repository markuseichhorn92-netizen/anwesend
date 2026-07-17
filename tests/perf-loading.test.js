'use strict';
// Ladezeit-Pass: jsPDF nur bei Bedarf, Fonts nicht render-blockierend,
// Boot-Splash/Ladeanimation statisch in der Seite (sichtbar vor dem ersten render()).
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
  const member = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
  const team = fs.readFileSync(path.join(ROOT, 'team-backend.html'), 'utf8');

  for (const [name, html] of [['mitglieder', member], ['team-backend', team]]) {
    ok(name + ': jsPDF nicht mehr im <head> (kein Start-Download)', !/<script[^>]+src="[^"]*jspdf/.test(html));
    ok(name + ': loadPdfLib-Lazy-Loader vorhanden', html.indexOf('function loadPdfLib(') >= 0 && html.indexOf('jspdf.umd.min.js') >= 0);
    ok(name + ': Font-CSS nicht render-blockierend (media=print + onload + noscript)',
      /fonts\.googleapis[^>]+media="print" onload=/.test(html) && /<noscript><link[^>]*fonts\.googleapis/.test(html));
    ok(name + ': Boot-Splash mit Ladeanimation statisch im App-Container',
      html.indexOf('class="bootsplash"') >= 0 && html.indexOf('wird geladen') >= 0);
  }
  ok('mitglieder: Skeleton-Karten im Splash', /bootsplash[^<]*"[^>]*>[\s\S]{0,200}skcard/.test(member) && member.indexOf('@keyframes skShimmer') >= 0);
  ok('team-backend: native.js lädt mit defer (nicht render-blockierend)', /<script src="\/assets\/native\.js" defer><\/script>/.test(team));
  ok('mitglieder: PDF-Aktionen laden die Bibliothek erst beim Klick',
    /function emailPdf\(\)\{[\s\S]{0,220}loadPdfLib\(\)/.test(member) && /function downloadMembershipPdf\(\)\{[\s\S]{0,120}loadPdfLib\(\)/.test(member));
  ok('team-backend: Check-in-PDF lädt die Bibliothek erst beim Klick',
    /function downloadCheckinPdf\(p\)\{[\s\S]{0,160}loadPdfLib\(\)/.test(team) && /function emailCheckinPdf\(p\)\{[\s\S]{0,220}loadPdfLib\(\)/.test(team));

  console.log(pass ? 'PERF-LOADING PASS' : 'PERF-LOADING FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
