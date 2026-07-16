'use strict';
// Cron-/interne Endpunkte: Secret verpflichtend (fail-closed 503), NUR
// Authorization-Header (kein ?secret=), kein Vertrauen in x-vercel-cron.
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

const { requireCronAuth } = require(path.join(ROOT, 'lib/cronAuth.js'));

function res0() { return { statusCode: 0, setHeader() {}, body: null, end(s) { this.body = s; } }; }
function req0(headers, url) { return { method: 'GET', url: url || '/api/x', headers: headers || {} }; }

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1) KEIN Secret konfiguriert -> 503, niemals durchlassen (fail closed)
  delete process.env.CRON_SECRET; delete process.env.RECORD_SECRET;
  let r = res0();
  ok('1. ohne konfiguriertes Secret -> 503', requireCronAuth(req0(), r) === false && r.statusCode === 503);

  // 2) Secret gesetzt: fehlender Header -> 401
  process.env.CRON_SECRET = 's3cret';
  r = res0();
  ok('2. ohne Header -> 401', requireCronAuth(req0(), r) === false && r.statusCode === 401);

  // 3) Falsches Secret -> 401
  r = res0();
  ok('3. falsches Secret -> 401', requireCronAuth(req0({ authorization: 'Bearer falsch' }), r) === false && r.statusCode === 401);

  // 4) Query-Parameter wird NICHT akzeptiert
  r = res0();
  ok('4. ?secret= wird ignoriert -> 401', requireCronAuth(req0({}, '/api/x?secret=s3cret'), r) === false && r.statusCode === 401);

  // 5) x-vercel-cron allein reicht NICHT
  r = res0();
  ok('5. x-vercel-cron allein -> 401', requireCronAuth(req0({ 'x-vercel-cron': '1' }), r) === false && r.statusCode === 401);

  // 6) Korrekter Authorization-Header -> durch
  r = res0();
  ok('6. korrekter Bearer -> true', requireCronAuth(req0({ authorization: 'Bearer s3cret' }), r) === true);

  // 7) Alias-Envs (z. B. WINBACK_SECRET) greifen nur, wenn angegeben
  delete process.env.CRON_SECRET;
  process.env.WINBACK_SECRET = 'wb';
  r = res0();
  ok('7. Alias ohne Freigabe -> 503', requireCronAuth(req0({ authorization: 'Bearer wb' }), r) === false && r.statusCode === 503);
  r = res0();
  ok('7b. Alias mit extraEnvs -> true', requireCronAuth(req0({ authorization: 'Bearer wb' }), r, { extraEnvs: ['WINBACK_SECRET'] }) === true);
  delete process.env.WINBACK_SECRET;

  // 8) Tripwire: kein Cron-Endpoint akzeptiert mehr ?secret= / vertraut x-vercel-cron
  const files = ['api/nudge.js', 'api/plan-remind.js', 'api/social-remind.js', 'api/nutrition-impulse.js', 'api/record.js', 'api/winback-autopilot.js', 'api/seed.js', 'api/admin/off-warmup.js'];
  const offenders = files.filter((f) => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /searchParams\.get\('secret'\)|searchParams\.get\('key'\)/.test(s) || /headers\['x-vercel-cron'\]/.test(s);
  });
  ok('8. keine Query-Secrets/x-vercel-cron mehr (Verstöße: ' + (offenders.join(',') || 'keine') + ')', offenders.length === 0);

  console.log(pass ? 'CRON-AUTH PASS' : 'CRON-AUTH FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
