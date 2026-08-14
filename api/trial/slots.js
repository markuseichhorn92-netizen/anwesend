'use strict';

/**
 * GET /api/trial/slots[?days=21][&trainer=1|0]
 * Liefert die freien Probetraining-Slots (über die öffentliche Connect API).
 * trainer=1 -> mit Trainer (trainerRequired=true, weniger Slots),
 * trainer=0 -> ohne Trainer (mehr Slots). Fehlt der Parameter, gilt der
 * Standard aus lib/connect.js (mit Trainer).
 * Proxy, damit der Aufruf serverseitig läuft und einheitlich gecacht wird.
 */

const C = require('../../lib/connect');

function ymd(d) { return d.toISOString().slice(0, 10); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  let days = parseInt(u.query.days, 10);
  if (!(days >= 1 && days <= 30)) days = 21;
  // Fehlt der Parameter, gilt der Standard (mit Trainer) - frueher war das
  // hart 'ohne Trainer' und der Termin blieb ohne Ressource.
  const trainerRequired = (u.query.trainer == null || u.query.trainer === '')
    ? undefined : String(u.query.trainer) === '1';

  const now = new Date();
  const start = new Date(now.getTime());
  const end = new Date(now.getTime() + days * 86400000);

  try {
    const r = await C.getTrialSlots(ymd(start), ymd(end), trainerRequired);
    if (r.status !== 200 || !r.json) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: 'slots_unavailable' }));
    }
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      name: r.json.name || 'Probetraining',
      description: r.json.description || '',
      slots: Array.isArray(r.json.slots) ? r.json.slots : [],
    }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: 'server_error' }));
  }
};
