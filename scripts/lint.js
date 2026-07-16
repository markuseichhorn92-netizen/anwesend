'use strict';
// Syntax-Lint: prueft jede JS-Datei (api/, lib/, scripts/, tests/, server.js)
// mit `node --check` und validiert vercel.json + package.json als JSON.
// Kein externes Tooling noetig - laeuft ueberall, wo Node laeuft.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
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
console.log('lint: ' + files.length + ' JS-Dateien geprueft, ' + fail + ' Fehler');
process.exit(fail ? 1 : 0);
