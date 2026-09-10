'use strict';

/**
 * POST /api/member/coach-insights   (Mitglied-Session erforderlich)
 * ----------------------------------------------------------------
 * FINNs Erkenntnis für den Coach-Tab: EINE zusammenhängende Aussage plus ein
 * nächster Schritt. Seit September 2026 aus dem, was die App noch ist –
 * Mitgliedschaft, Termine, Coaching: Besuche, anstehende Termine, Ziel,
 * Körperwerte (InBody / Figur-Check). Kein Trainingsplan, kein Tagebuch.
 *
 * Für alle inklusive: kein Kontingent, kein Premium. Der Coach ist frei.
 *
 * Datenfluss: Der Live-Block (Vertrag, Termine, Besuche) wird SERVERSEITIG
 * gebaut – derselbe wie im FINN-Chat. Vom Client kommen nur Ziel, Wunsch-
 * Trainingstage und die zuletzt gemessenen Körperwerte, jeweils auf das
 * Nötige beschnitten. Nichts davon wird gespeichert.
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');
const Coach = require('./coach');

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

// Nur die erwarteten Felder übernehmen – kein Durchreichen beliebiger Daten.
function cleanCtx(raw) {
  raw = raw || {};
  const num = (v, max) => { const n = Math.round(Number(v) * 10) / 10; return (isNaN(n) || n <= 0 || n > max) ? null : n; };
  const datum = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);
  const out = {
    goal: String(raw.goal || '').replace(/[^\wäöüÄÖÜß\- ]/g, '').slice(0, 40),
    freq: (function () { const n = parseInt(raw.freq, 10); return (n >= 1 && n <= 7) ? n : null; })(),
  };
  if (raw.figur && typeof raw.figur === 'object') {
    const f = { date: datum(raw.figur.date), weight: num(raw.figur.weight, 400), waist: num(raw.figur.waist, 250) };
    if (f.weight || f.waist) out.figur = f;
  }
  if (raw.inbody && typeof raw.inbody === 'object') {
    const b = { date: datum(raw.inbody.date), weight: num(raw.inbody.weight, 400), muscle: num(raw.inbody.muscle, 150), fat: num(raw.inbody.fat, 80) };
    if (b.weight || b.muscle || b.fat) out.inbody = b;
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' });
  if (!(await M.rateLimit('coach-insight:' + sess.id, 20, 3600))) {
    return j(res, 200, { ok: false, error: 'rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' });
  }

  try {
    const body = await M.readBody(req);
    const ctx = cleanCtx(body && body.ctx);
    let det = { text: '' };
    try { det = await Coach.memberDetails(sess.id); } catch (e) {}
    ctx.details = det.text || '';
    const r = await AI.coachInsight(ctx);
    if (!r || !r.ok || !r.text) {
      return j(res, 200, { ok: false, error: 'gen_failed', message: 'FINN konnte gerade keine Analyse erstellen – bitte gleich noch einmal.' });
    }
    return j(res, 200, { ok: true, text: r.text });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed', message: 'FINN ist gerade nicht erreichbar.' });
  }
};
module.exports.cleanCtx = cleanCtx;
