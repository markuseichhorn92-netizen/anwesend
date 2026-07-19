'use strict';
// Browser-/API-Haertung: vercel.json setzt die Sicherheits-Header korrekt,
// private API-Antworten sind nicht cachebar, Zahlungsdateien blieben unberuehrt.
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const headerFor = (srcIncludes, key) => {
    for (const h of v.headers || []) {
      if (h.source.includes(srcIncludes)) {
        const e = (h.headers || []).find((x) => x.key === key);
        if (e) return e.value;
      }
    }
    return null;
  };

  // 1) Globale Header
  ok('1. nosniff global', headerFor('/(.*)', 'X-Content-Type-Options') === 'nosniff');
  ok('1b. Referrer-Policy global', /strict-origin/.test(headerFor('/(.*)', 'Referrer-Policy') || ''));

  // 2) API: privat + no-store
  ok('2. /api/* Cache-Control private,no-store', /private/.test(headerFor('/api/', 'Cache-Control') || '') && /no-store/.test(headerFor('/api/', 'Cache-Control') || ''));

  // 3) App-Seiten: frame-ancestors + Permissions-Policy + CSP-Report-Only
  ok('3. frame-ancestors self auf App-Seiten', /frame-ancestors 'self'/.test(headerFor('widget', 'Content-Security-Policy') || ''));
  const pp = headerFor('widget', 'Permissions-Policy') || '';
  ok('3b. Permissions-Policy gesetzt (Kamera/Mikro/Geo self)', /camera=\(self\)/.test(pp) && /geolocation=\(self\)/.test(pp));
  ok('3c. Permissions-Policy sperrt die Payment-API NICHT', !/payment/.test(pp));
  const cspro = headerFor('widget', 'Content-Security-Policy-Report-Only') || '';
  ok('3d. CSP-Report-Only vorhanden (Weg zur strikten CSP)', /default-src 'self'/.test(cspro) && /recaptcha|google\.com/.test(cspro));

  // 4) Einbettbare Seiten (Widget/Auslastung) sind vom frame-ancestors ausgenommen
  const appSrc = (v.headers || []).find((h) => h.source.includes('widget'));
  ok('4. widget/auslastung ausgenommen', !!appSrc && appSrc.source.includes('?!') && appSrc.source.includes('auslastung'));

  // 5) Handler-Sweep: alle Member-/Team-Endpoints setzen Cache-Control (Tripwire)
  const missing = [];
  ['api/member', 'api/team'].forEach((dir) => {
    fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).forEach((f) => {
      const s = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      if (!s.includes('Cache-Control')) missing.push(dir + '/' + f);
    });
  });
  // Zahlungsdateien wurden bewusst nicht angefasst -> vom Tripwire ausgenommen.
  const payment = new Set(['api/member/payment-instrument.js', 'api/member/payment-session.js']);
  const realMissing = missing.filter((f) => !payment.has(f));
  ok('5. alle Nicht-Zahlungs-Handler mit Cache-Control (fehlend: ' + (realMissing.join(',') || 'keine') + ')', realMissing.length === 0);

  console.log(pass ? 'HEADERS PASS' : 'HEADERS FAIL');
  process.exit(pass ? 0 : 1);
}
run();
