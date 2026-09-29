'use strict';

/**
 * Vercel Serverless Function · /api/journeys-tick
 * -----------------------------------------------------------------------------
 * Durchlauf der FINN Journeys (lib/journeys/tick): fällige WhatsApp-Schritte
 * senden (Ruhezeiten, Kappen, Einwilligung prüft der Sender), Mitglieder mit
 * bekannter Nummer täglich neu einstufen, Check-in-Historie nachziehen,
 * Einladung dosiert verschicken.
 *
 * Fortsetzbar: `fertig:false` heißt, der nächste Aufruf macht weiter. Der
 * Workflow .github/workflows/journeys.yml ruft alle 15 Minuten, bis `fertig`.
 * Ohne JOURNEYS=1 bzw. JOURNEYS_TRACK=1 passiert nichts (fertig:true, off:true).
 *
 * Schutz wie die übrigen Cron-Endpunkte: Secret als Authorization-Header,
 * fail-closed ohne Secret. Die Antwort enthält nur Zahlen.
 */

const { requireCronAuth } = require('../lib/cronAuth');
const Journeys = require('../lib/journeys');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!requireCronAuth(req, res)) return;
  try {
    const r = await Journeys.tick({ budgetMs: 45000 });
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: !!r.ok, fertig: !!r.fertig, off: !!r.off, locked: !!r.locked, due: r.due || 0, sent: r.sent || 0, evaluated: r.evaluated || 0, ms: r.ms || 0 }));
  } catch (e) {
    console.error('[journeys-tick]', String(e && e.name));
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'tick_failed' }));
  }
};
