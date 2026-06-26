'use strict';

/**
 * Vercel Serverless Function · /api/seed
 * --------------------------------------
 * Trägt einmalig die historische Basis (data/baseline.json, aus dem
 * Check-in-Export berechnet) in den Speicher ein — als Startpunkt, den die
 * Live-Daten danach weiter anreichern/überschreiben.
 *
 * Es werden NUR anonyme Aggregate geschrieben (Ø Anwesende je Wochentag+Slot).
 *
 * Aufruf:  /api/seed?confirm=1            (einmalig)
 *          /api/seed?confirm=1&force=1    (vorhandene Basis überschreiben)
 *
 * Schutz: ist SEED_SECRET oder RECORD_SECRET gesetzt, muss es als
 * Bearer-Token oder ?secret=... passen. Idempotent: ein zweiter Aufruf ohne
 * force=1 tut nichts (schützt bereits gesammelte Live-Daten).
 */

const { redisPipeline, hasStore, SLOTS_PER_DAY } = require('../lib/store');
const baseline = require('../data/baseline.json');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const secret = process.env.SEED_SECRET || process.env.RECORD_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const u = new URL(req.url, 'http://localhost');
    const provided = auth.replace(/^Bearer\s+/i, '') || u.searchParams.get('secret') || '';
    if (provided !== secret) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
  }

  if (!hasStore) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'no_store' }));
  }

  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('confirm') !== '1') {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'confirm_required', hint: 'Mit ?confirm=1 aufrufen.' }));
  }
  const force = url.searchParams.get('force') === '1';

  try {
    const [seeded] = await redisPipeline([['GET', 'meta:seeded']]);
    if (seeded && !force) {
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true, already_seeded: true, seeded_at: seeded,
        hint: 'Bereits geseedet. Mit &force=1 überschreiben.',
      }));
    }

    const W = Math.max(1, Math.round(baseline.weight || 3));
    const cmds = [];
    let nonZero = 0;
    for (let wd = 0; wd < 7; wd++) {
      const arr = baseline.typical[String(wd)] || [];
      const sumArgs = ['HSET', `typical:sum:${wd}`];
      const cntArgs = ['HSET', `typical:cnt:${wd}`];
      for (let s = 0; s < SLOTS_PER_DAY; s++) {
        const avg = Number(arr[s]) || 0;
        const sum = Math.round(avg * W);
        if (sum > 0) nonZero++;
        sumArgs.push(String(s), String(sum));
        cntArgs.push(String(s), String(W));
      }
      cmds.push(sumArgs, cntArgs);
    }
    cmds.push(['SET', 'meta:seeded', new Date().toISOString()]);
    cmds.push(['SET', 'meta:seed_source', JSON.stringify(baseline.meta || {})]);

    await redisPipeline(cmds);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true, seeded: true, forced: force, weight: W,
      nonZeroSlots: nonZero, source: baseline.meta || null,
    }));
  } catch (err) {
    console.error('[seed]', err.message);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'seed_failed', message: err.message }));
  }
};
