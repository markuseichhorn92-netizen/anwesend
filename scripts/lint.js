'use strict';
// Syntax-Lint: prueft jede JS-Datei (api/, lib/, scripts/, tests/, server.js) mit
// `node --check`, dazu das Inline-JS der Oberflaechen-Dateien (mitglieder.html,
// team-backend.html) und die data-act-Klickziele. Validiert ausserdem vercel.json
// + package.json als JSON. Kein externes Tooling noetig - laeuft ueberall mit Node.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const UI = require('./uilint');

const ROOT = path.resolve(__dirname, '..');
const HTML = ['mitglieder.html', 'team-backend.html'];
const DIRS = ['api', 'lib', 'scripts', 'tests'];
const files = ['server.js'];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(path.relative(ROOT, p));
  }
}
DIRS.forEach((d) => { const p = path.join(ROOT, d); if (fs.existsSync(p)) walk(p); });

let fail = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { fail++; console.error('SYNTAXFEHLER ' + f + '\n' + String(e.stderr || e.message)); }
}
for (const j of ['vercel.json', 'package.json']) {
  try { JSON.parse(fs.readFileSync(path.join(ROOT, j), 'utf8')); }
  catch (e) { fail++; console.error('UNGUELTIGES JSON ' + j + ': ' + e.message); }
}

// Inline-JS der Oberflaechen: hier liegt die gesamte App. Zum Pruefen in eine
// temporaere Datei schreiben, damit `node --check` echte Zeilennummern meldet.
let scripts = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uilint-'));
for (const h of HTML) {
  const p = path.join(ROOT, h);
  if (!fs.existsSync(p)) continue;
  const html = fs.readFileSync(p, 'utf8');
  UI.inlineScripts(html).forEach((s, i) => {
    scripts++;
    // Leerzeilen bis zur Startzeile vorschalten -> gemeldete Zeile passt zur HTML-Datei.
    const f = path.join(tmp, h.replace(/\W/g, '_') + '_' + i + '.js');
    fs.writeFileSync(f, '\n'.repeat(Math.max(0, s.line - 1)) + s.code);
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) {
      fail++;
      console.error('SYNTAXFEHLER im Inline-JS von ' + h + ' (Block ' + (i + 1) + ', ab Zeile ' + s.line + ')\n'
        + String(e.stderr || e.message).replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), h));
    }
  });
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

// Tote Klickziele: data-act ohne passenden Handler = Button, der nichts tut.
let acts = 0;
for (const h of HTML) {
  const p = path.join(ROOT, h);
  if (!fs.existsSync(p)) continue;
  const html = fs.readFileSync(p, 'utf8');
  acts += UI.declaredActions(html).size;
  const dead = UI.deadActions(html);
  if (dead.length) {
    fail++;
    console.error('TOTE KLICKZIELE in ' + h + ' (data-act ohne Handler): ' + dead.join(', '));
  }
}

console.log('lint: ' + files.length + ' JS-Dateien + ' + scripts + ' Inline-Skripte + '
  + acts + ' Klickziele geprueft, ' + fail + ' Fehler');
process.exit(fail ? 1 : 0);
