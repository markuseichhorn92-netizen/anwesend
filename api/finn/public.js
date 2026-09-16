'use strict';

/**
 * POST /api/finn/public   – Website-Chat für Interessenten (nicht angemeldet).
 * -----------------------------------------------------------------------------
 * Nur aktiv mit FINN_PUBLIC=1 (sonst 404). Der Besucher hat KEINEN Zugriff auf
 * Mitgliedsdaten: Aktor-Art `lead`, nur Studio-/Lead-Agenten, nur lesende Werkzeuge
 * plus „Interessent anlegen" (mit Bestätigung). Rate-Limit je Besucher UND je IP.
 *   { message, history?, visitorId? | action:'confirm'|'decline', id, visitorId }
 * CORS nur für ALLOWED_ORIGIN (kommagetrennt), sonst same-origin.
 */

const M = require('../../lib/members');
const Channels = require('../../lib/finn/channels');
const KV = require('../../lib/finn/kv');
const U = require('../../lib/finn/util');

function ipOf(req) { return String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket && req.socket.remoteAddress || '').trim(); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const origins = String(process.env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = String(req.headers.origin || '');
  if (origin && origins.indexOf(origin) >= 0) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); }
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (!Channels.publicOn()) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const ipHash = U.sha1('finnpub:' + ipOf(req)).slice(0, 16);
  const n = await KV.incr('finnrl:pubip:' + ipHash, 3600);
  if (n != null && n > 40) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', answer: U.safeMessage('rate_limited') })); }
  const body = await M.readBody(req);
  const vid = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.visitorId || '')) ? String(body.visitorId) : ipHash;
  let r;
  try { r = await Channels.publicTurn(vid, body); } catch (e) { r = { ok: false, error: 'failed', answer: U.safeMessage('failed') }; }
  r.visitorId = vid;
  res.statusCode = 200; return res.end(JSON.stringify(r));
};
