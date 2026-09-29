'use strict';

/**
 * Auth für Cron-/interne Endpunkte – fail-closed.
 * ------------------------------------------------
 * Regeln:
 *  - Ein Secret ist VERPFLICHTEND. Ist keins konfiguriert, antwortet der
 *    Endpunkt 503 und tut nichts („fail closed" statt „fail open").
 *  - Das Secret wird AUSSCHLIESSLICH als `Authorization: Bearer <secret>`
 *    akzeptiert – nie als Query-Parameter (Query-Strings landen in Logs,
 *    Browser-Historie und Proxies).
 *  - Der Header `x-vercel-cron` wird NICHT als Nachweis gewertet (von außen
 *    frei setzbar). Vercel Cron sendet bei gesetzter Env `CRON_SECRET`
 *    automatisch `Authorization: Bearer $CRON_SECRET` – genau das prüfen wir.
 *  - Vergleich timing-sicher.
 *
 * Env-Variablen: CRON_SECRET und RECORD_SECRET (beide gültig, wenn gesetzt);
 * einzelne Endpunkte können zusätzliche Alias-Namen mitgeben (z. B. SEED_SECRET).
 */

const crypto = require('node:crypto');

function safeEqual(a, b) {
  try {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch (e) { return false; }
}

// Alle gesetzten Secrets aus CRON_SECRET, RECORD_SECRET und extraEnvs.
// Zur Laufzeit gelesen (testbar, und Vercel-Env-Änderungen greifen sofort).
// Mehrere zugleich gültig: Vercel-Cron sendet CRON_SECRET, die GitHub-Workflows
// RECORD_SECRET – ein neu gesetztes CRON_SECRET darf die Workflows nicht aussperren.
function secretsOf(extraEnvs) {
  const names = ['CRON_SECRET', 'RECORD_SECRET'].concat(extraEnvs || []);
  const out = [];
  for (const n of names) { const v = process.env[n]; if (v && out.indexOf(v) < 0) out.push(v); }
  return out;
}
// Erstes gesetztes Secret (für Aufrufer, die selbst eines senden, z. B. interne Anstöße).
function resolveSecret(extraEnvs) { return secretsOf(extraEnvs)[0] || ''; }

/**
 * Guard: beantwortet 503 (kein Secret konfiguriert) bzw. 401 (falsch/fehlend)
 * selbst und liefert false; bei gültigem Header true.
 *   if (!requireCronAuth(req, res)) return;
 */
function requireCronAuth(req, res, opts) {
  const secrets = secretsOf(opts && opts.extraEnvs);
  if (!secrets.length) {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: 'cron_secret_missing' }));
    return false;
  }
  const provided = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  // Jeden Kandidaten vergleichen (kein Abbruch beim ersten Treffer → gleiche Laufzeit).
  let match = false;
  for (const sec of secrets) { if (safeEqual(provided, sec)) match = true; }
  if (!provided || !match) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return false;
  }
  return true;
}

module.exports = { requireCronAuth, resolveSecret, secretsOf, safeEqual };
