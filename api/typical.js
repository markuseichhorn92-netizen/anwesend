'use strict';

/**
 * Vercel Serverless Function · GET /api/typical
 * ---------------------------------------------
 * Liefert die typische Auslastung ("normal um diese Zeit") für den aktuellen
 * (oder per ?weekday= & ?slot= angefragten) Zeitpunkt plus optional die
 * komplette Tageskurve (?day=1, Standard) für das Diagramm im Widget.
 *
 * Antwort:
 *   { available, weekday, slot, max, typicalCount, typicalPercent,
 *     samples, day:[48], totalSamples }
 *
 * Ist kein Speicher verbunden, kommt { available:false } zurück — das Widget
 * blendet die "normal"-Anzeige dann einfach aus.
 */

const { getTypicalSlot, getTypicalDay, getTypicalWeek, localParts, hasStore } = require('../lib/store');
const { scaleVal } = require('../lib/utilization');

const MAX_CAPACITY = parseInt(process.env.MAX_CAPACITY || '40', 10);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (!hasStore) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false }));
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const now = localParts();
    const weekday = url.searchParams.has('weekday')
      ? parseInt(url.searchParams.get('weekday'), 10)
      : now.weekday;
    const slot = url.searchParams.has('slot')
      ? parseInt(url.searchParams.get('slot'), 10)
      : now.slot;
    const withDay = url.searchParams.get('day') !== '0';

    const cur = await getTypicalSlot(weekday, slot);
    // Gleiche Hochrechnung wie beim Live-Wert, damit Verlauf & "~X Personen" zur
    // angezeigten Live-Zahl passen (Rohwerte in der Historie bleiben unverändert).
    const typicalCount = scaleVal(cur.typicalCount, MAX_CAPACITY);
    const payload = {
      available: true,
      weekday,
      slot,
      max: MAX_CAPACITY,
      typicalCount,
      typicalPercent:
        typicalCount == null
          ? null
          : Math.min(100, Math.round((typicalCount / MAX_CAPACITY) * 100)),
      samples: cur.samples,
    };

    if (withDay) {
      const d = await getTypicalDay(weekday);
      payload.day = Array.isArray(d.day) ? d.day.map(function (v) { return scaleVal(v, MAX_CAPACITY); }) : d.day;
      payload.totalSamples = d.totalSamples;
    }

    if (url.searchParams.get('week') === '1') {
      const wk = await getTypicalWeek();        // 7 Tageskurven für die Empfehlung
      payload.week = Array.isArray(wk)
        ? wk.map(function (day) { return Array.isArray(day) ? day.map(function (v) { return scaleVal(v, MAX_CAPACITY); }) : day; })
        : wk;
    }

    // CDN-cachebar: entlastet den Speicher massiv (viele Viewer -> 1 Abruf/5 min)
    res.setHeader('Cache-Control', 'public, s-maxage=300, max-age=60, stale-while-revalidate=600');
    res.statusCode = 200;
    return res.end(JSON.stringify(payload));
  } catch (err) {
    console.error('[typical]', err.message);
    res.statusCode = 200; // sanft scheitern, Widget zeigt dann nur den Live-Wert
    return res.end(JSON.stringify({ available: false, error: err.message }));
  }
};
