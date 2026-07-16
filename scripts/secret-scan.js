'use strict';
// Secret-Scan: sucht in allen versionierten Textdateien nach typischen
// Geheimnis-Mustern (Live-API-Keys, private Schluessel, Connection-Strings
// mit Zugangsdaten). Bewusst konservativ, damit CI nicht auf Beispiel-Werte
// anschlaegt: .env.example-Platzhalter und Doku-Beispiele nutzen <...>-Syntax.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PATTERNS = [
  [/sk_live_[0-9a-zA-Z]{20,}/, 'Stripe Live Secret Key'],
  [/rk_live_[0-9a-zA-Z]{20,}/, 'Stripe Restricted Live Key'],
  [/whsec_[0-9a-zA-Z]{20,}/, 'Stripe Webhook Secret'],
  [/AKIA[0-9A-Z]{16}/, 'AWS Access Key'],
  [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, 'Private Key Block'],
  [/AIza[0-9A-Za-z\-_]{35}/, 'Google API Key'],
  [/xox[baprs]-[0-9a-zA-Z-]{10,}/, 'Slack Token'],
  [/https:\/\/[^\s"']*:[^\s"'@]{8,}@[a-z0-9.-]*upstash\.io/, 'Upstash URL mit Credentials'],
  [/re_[0-9a-zA-Z]{20,}/, 'Resend API Key'],
];

const files = execSync('git ls-files', { cwd: ROOT }).toString().split('\n').filter(Boolean)
  .filter((f) => !/\.(png|jpg|jpeg|webp|gif|ico|pdf|woff2?|ttf|zip)$/i.test(f))
  .filter((f) => !f.startsWith('node_modules/') && f !== 'package-lock.json' && !f.startsWith('data/'));

let hits = 0;
for (const f of files) {
  let s = '';
  try { s = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
  for (const [re, label] of PATTERNS) {
    const m = s.match(re);
    if (m) { hits++; console.error('MOEGLICHES SECRET (' + label + ') in ' + f); }
  }
}
console.log('secret-scan: ' + files.length + ' Dateien geprueft, ' + hits + ' Treffer');
process.exit(hits ? 1 : 0);
