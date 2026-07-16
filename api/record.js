'use strict';

/**
 * Vercel Serverless Function · /api/record
 * ----------------------------------------
 * Liest den aktuellen Live-Wert und schreibt ihn in die Historie
 * (Wochentag/Uhrzeit-Durchschnitt). Wird vom GitHub-Actions-Cron
 * regelmäßig aufgerufen (alle 15 Minuten).
 *
 * Optionaler Schutz: ist die Env-Variable RECORD_SECRET gesetzt, muss der
 * Aufruf sie als Bearer-Token oder ?secret=... mitliefern.
 */

const { fetchUtilization } = require('../lib/utilization');
const { recordCount, hasStore } = require('../lib/store');
const { requireCronAuth } = require('../lib/cronAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (!requireCronAuth(req, res)) return;   // Secret verpflichtend, nur Authorization-Header

  if (!hasStore) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'no_store', hint: 'Upstash/KV nicht verbunden.' }));
  }

  try {
    const data = await fetchUtilization();
    const rec = await recordCount(data.count);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, recorded: rec }));
  } catch (err) {
    console.error('[record]', err.message);
    res.statusCode = err.code === 'missing_api_key' ? 500 : 502;
    return res.end(JSON.stringify({ error: err.code || 'record_failed', message: err.message }));
  }
};
