'use strict';

/**
 * TEMPORÄRER Diagnose-Endpunkt – prüft nur, ob die Anthropic-Anbindung in der
 * Produktion funktioniert (KI-Antwort fürs Kontaktformular). Tokengeschützt,
 * feste Frage (kein offener KI-Proxy). Wird nach dem Test wieder entfernt.
 */

const AI = require('../lib/ai');
const HELP = require('../lib/help');

const TOKEN = 'f52dcf64b69db7c6f5f45a5fc453be9cc66b';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('t') !== TOKEN) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }

  const question = 'Wie kann ich meine Mitgliedschaft pausieren?';
  const r = await AI.askHelp(question, HELP);
  res.statusCode = 200;
  return res.end(JSON.stringify({
    hasKey: AI.hasAI,
    model: AI.MODEL,
    ok: !!r.ok,
    status: r.status || null,
    error: r.error || null,
    answerPreview: r.ok ? String(r.answer).slice(0, 220) : null,
  }));
};
