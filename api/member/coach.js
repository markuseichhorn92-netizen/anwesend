'use strict';

/**
 * FINN – der KI-Coach im Mitgliederbereich.   (Authorization: Bearer <token>)
 *
 *   GET                 -> { ok, message, ai }   Tagesimpuls für die Übersicht
 *   POST { question, history:[{role,text}] }
 *                       -> { ok, answer }         Chat-Antwort von FINN
 *
 * Nutzt lib/ai.js (Anthropic Claude) + die Hilfe-Artikel als Wissensbasis.
 * Ohne ANTHROPIC_API_KEY fällt der Tagesimpuls auf einen rotierenden Standardtipp
 * zurück; der Chat meldet dann ehrlich, dass FINN gerade nicht verfügbar ist.
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');
const HELP = require('../../lib/help');

const STATIC_TIPS = [
  'Trink vor dem Training ein großes Glas Wasser – das steigert deine Leistung spürbar. 💧',
  'Schon 20 Minuten zählen. Komm vorbei, dein Körper dankt es dir!',
  'Konstanz schlägt Intensität: lieber 3× kurz als 1× lang. 💪',
  'Wärm dich 5 Minuten auf – das beugt Verletzungen vor und macht jede Übung effektiver.',
  'Erholung ist Teil des Fortschritts: gönn dir guten Schlaf und genug Eiweiß.',
  'Setz dir für heute ein kleines, erreichbares Ziel – und feiere es danach. 🎯',
  'Ein fester Trainingspartner hält dich am Ball. Wen könntest du heute mitnehmen?',
];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

  // ── Tagesimpuls für die Übersicht ──
  if (req.method === 'GET') {
    let ct = null; try { ct = await M.getContract(sess.id); } catch (e) {}
    const statsLine = 'Tarif ' + ((ct && ct.rateName) || 'aktiv') + (ct && ct.active === false ? ' (ehemalig)' : ' (aktiv)');
    let goal = ''; try { goal = new URL(req.url, 'http://x').searchParams.get('goal') || ''; } catch (e) {}
    if (AI.hasAI && (await M.rateLimit('coach-tip:' + sess.id, 30, 3600))) {
      const r = await AI.coachTip(statsLine, goal);
      if (r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, message: r.answer, ai: true })); }
    }
    const idx = (new Date().getDate()) % STATIC_TIPS.length;   // tagesstabil, kein Zufall nötig
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, message: STATIC_TIPS[idx], ai: false }));
  }

  // ── Chat mit FINN ──
  if (req.method === 'POST') {
    if (!(await M.rateLimit('coach-chat:' + sess.id, 40, 3600))) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz durchatmen – das waren viele Fragen auf einmal. Versuch es gleich nochmal.' }));
    }
    const body = await M.readBody(req);
    const question = String(body.question || '').trim();
    if (question.length < 2) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty' })); }
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar. Magst du es direkt unserem Team schreiben?' })); }
    let ct = null; try { ct = await M.getContract(sess.id); } catch (e) {}
    const member = { firstName: m.firstName, lastName: m.lastName, customerNumber: m.customerNumber, rateName: ct && ct.rateName };
    const r = await AI.coachReply(member, Array.isArray(body.history) ? body.history : [], question, HELP);
    res.statusCode = 200;
    if (r.ok) return res.end(JSON.stringify({ ok: true, answer: r.answer }));
    return res.end(JSON.stringify({ ok: false, error: r.error || 'ai_failed', message: 'Da komme ich gerade nicht weiter. Magst du es unserem Team schreiben?' }));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
