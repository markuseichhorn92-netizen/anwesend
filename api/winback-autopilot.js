'use strict';

/**
 * Rückhol-Auto-Pilot (VORBEREITET, standardmäßig sicher).   Cron/Job-Endpoint.
 * --------------------------------------------------------------------------
 * Findet Mitglieder, die auf ein laufendes Rückhol-Angebot GEANTWORTET haben,
 * und kümmert sich – im Rahmen – um die nächste Runde.
 *
 * Sicherheits-Stufen (bewusst konservativ):
 *   1. Zugang nur mit Secret (WINBACK_SECRET oder RECORD_SECRET) bzw. Vercel-Cron.
 *   2. Läuft nur, wenn der Rahmen AKTIV und Auto-Pilot AN ist (lib/retention).
 *   3. STANDARD = sicherer Modus: die KI antwortet NICHT selbst, sondern legt
 *      dem Team eine Aufgabe „Rückhol-Antwort fällig" an (nichts geht ungeprüft
 *      an Kunden). Erst wenn WINBACK_AUTOPILOT_LIVE=1 gesetzt ist, antwortet die
 *      KI eigenständig im Rahmen (und eskaliert bei Deal/Überschreitung ans Team).
 *
 * So kann man den Auto-Piloten erst „trocken" beobachten und dann scharf schalten.
 *
 * Einplanen (z. B. GitHub Action alle 30 Min):
 *   GET /api/winback-autopilot?secret=<WINBACK_SECRET>
 */

const R = require('../lib/retention');
const Inbox = require('../lib/inbox');
const Todos = require('../lib/todos');
const AI = require('../lib/ai');

const MAX_PER_RUN = 8;
const REPLY_WINDOW_MS = 21 * 86400000;   // nur Angebote der letzten ~3 Wochen

function authorized(req) {
  const secret = process.env.WINBACK_SECRET || process.env.RECORD_SECRET;
  if (req.headers['x-vercel-cron']) return true;            // von Vercel-Cron ausgelöst
  if (!secret) return false;                                 // ohne Secret bewusst gesperrt
  let provided = '';
  try {
    const url = new URL(req.url, 'http://x');
    provided = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('secret') || '';
  } catch (e) {}
  return provided === secret;
}

// Letzte Mitglieds-Nachricht in irgendeinem Vorgang, neuer als seit.
async function memberRepliedSince(memberId, since) {
  let list = [];
  try { list = await Inbox.list(memberId); } catch (e) { return null; }
  let best = null;
  (list || []).forEach((v) => {
    const msgs = (v && v.messages) || [];
    const last = msgs[msgs.length - 1];
    if (last && last.from === 'member' && (last.at || v.updatedAt || 0) > since) {
      if (!best || (last.at || 0) > (best.at || 0)) best = { vorgangId: v.id, text: String(last.text || ''), at: last.at || v.updatedAt || 0, subject: v.subject || '' };
    }
  });
  return best;
}

// KI-Antwort im Rahmen entwerfen (nur im Live-Modus genutzt). Bewusst reiner
// Gesprächstext – ein formelles neues Angebot macht weiterhin der Mensch.
async function draftReply(frame, offer, reply) {
  const bounds = [];
  if (frame.maxDiscountPct) bounds.push('Rabatt bis ' + frame.maxDiscountPct + '%');
  if (frame.maxFreeWeeks) bounds.push('bis ' + frame.maxFreeWeeks + ' Wochen gratis');
  if (frame.waiveActivation) bounds.push('Aktivierungsgebühr kann entfallen');
  if (frame.maxPauseWeeks) bounds.push('Pause bis ' + frame.maxPauseWeeks + ' Wochen');
  const system = [
    'Du bist der Rückhol-Assistent von Fit-Inn Trier und antwortest einem Mitglied im laufenden Rückhol-Gespräch. Freundlich, wertschätzend, per "du", kurz (max ~60 Wörter).',
    'Das bereits gemachte Angebot lautet: ' + (offer.summary || '—') + '.',
    'HARTE Grenze (nie überschreiten, nichts Höheres zusagen): ' + (bounds.join('; ') || 'keine weiteren Zugeständnisse') + '.' + (frame.notes ? ' Leitplanken: ' + frame.notes : ''),
    'Wenn der Kunde im Rahmen zufrieden ist, bestätige herzlich und verweise auf den bereits verschickten Annahme-Link. Verlangt er MEHR als die Grenze, sag freundlich, dass du das nicht allein entscheiden kannst und ein Kollege sich meldet – sage nichts Höheres zu.',
    'Antworte nur mit dem Nachrichtentext, ohne Anrede-Floskeln wie "Hallo".',
  ].join('\n');
  const r = await AI.complete(system, [{ role: 'user', content: 'Nachricht des Mitglieds: ' + String(reply.text || '').slice(0, 800) }], { maxTokens: 300, temperature: 0.5 });
  return (r && r.ok && r.answer) ? r.answer : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req)) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  const frame = await R.getFrame();
  if (!frame.active || !frame.autopilot) {
    return res.end(JSON.stringify({ ok: true, skipped: 'autopilot_off', active: frame.active, autopilot: frame.autopilot }));
  }
  const live = process.env.WINBACK_AUTOPILOT_LIVE === '1';

  const offers = await R.listOffers(120);
  const pending = offers.filter((o) => o.status === 'sent' && !R.isExpired(o) && (Date.now() - (o.createdAt || 0)) < REPLY_WINDOW_MS);

  const handled = [];
  for (const o of pending) {
    if (handled.length >= MAX_PER_RUN) break;
    const reply = await memberRepliedSince(o.memberId, o.createdAt || 0);
    if (!reply) continue;

    if (!live) {
      // Sicherer Standard: Team-Aufgabe statt Kunden-Nachricht.
      try { await Todos.addTodo({ text: 'Rückhol-Antwort fällig: ' + (o.memberName || ('Mitglied ' + o.memberId)) + ' hat auf das Angebot (' + o.summary + ') geantwortet – bitte im Posteingang antworten.' }); } catch (e) {}
      handled.push({ member: o.memberName || o.memberId, mode: 'todo', reply: reply.text.slice(0, 120) });
      continue;
    }
    // Live: KI antwortet im Rahmen.
    const text = await draftReply(frame, o, reply);
    if (!text) { handled.push({ member: o.memberName || o.memberId, mode: 'skip_no_ai' }); continue; }
    try { await Inbox.teamReply(o.memberId, reply.vorgangId, text, { author: 'Auto-Pilot' }); handled.push({ member: o.memberName || o.memberId, mode: 'replied' }); }
    catch (e) { handled.push({ member: o.memberName || o.memberId, mode: 'reply_failed' }); }
  }

  return res.end(JSON.stringify({ ok: true, mode: live ? 'live' : 'safe(todo)', pending: pending.length, handled: handled.length, details: handled }));
};
