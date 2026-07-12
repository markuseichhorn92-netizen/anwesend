'use strict';

/**
 * POST /api/member/pause-attest   (Authorization: Bearer <token>)
 *   { photo: dataURI|base64 }
 *   -> { ok, found, untilDate, startDate, kind, confidence, note }
 *
 * Scannt ein hochgeladenes ärztliches Attest / eine Bescheinigung per KI und
 * liest das End-Datum aus, bis zu dem keine sportliche Betätigung möglich ist
 * (Krankheit) bzw. bis zu dem die Bescheinigung gilt (Schwangerschaft). Damit
 * begrenzt der Kundenbereich die Beitragspause automatisch auf dieses Datum.
 * Ohne KI-Key oder bei unlesbarem Dokument: { ok:true, found:false }.
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');

function isoToday() { return new Date().toISOString().slice(0, 10); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  // Anti-Abuse: begrenzte KI-Scans pro Mitglied.
  if (!(await M.rateLimit('attest:' + sess.id, 20, 3600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
  }

  const body = await M.readBody(req);
  const raw = String(body.photo || body.document || '');
  if (!raw) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_photo' })); }

  // dataURI -> mediaType + reines base64
  let mediaType = 'image/jpeg';
  const mm = raw.match(/^data:([^;]+);base64,/);
  if (mm) mediaType = mm[1];
  const bi = raw.indexOf('base64,');
  const b64 = (bi >= 0 ? raw.slice(bi + 7) : raw).replace(/\s+/g, '');
  if (b64.length < 100 || b64.length > 8000000) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'bad_photo' })); }

  if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, found: false, error: 'no_ai' })); }

  let r;
  try { r = await AI.scanAttest(b64, mediaType, { today: isoToday() }); } catch (e) { r = { ok: false }; }
  if (!r || !r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, found: false })); }

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true, found: !!r.found, untilDate: r.untilDate || null, startDate: r.startDate || null,
    kind: r.kind || 'sonstiges', confidence: r.confidence || 'low',
    checks: r.checks || null, missing: r.missing || [], complete: r.complete !== false,
    note: r.note || '',
  }));
};
