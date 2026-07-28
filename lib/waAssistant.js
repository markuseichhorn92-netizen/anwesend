'use strict';

/**
 * WhatsApp-KI-Assistent (nur für verifizierte Mitglieder).
 * -----------------------------------------------------------------------------
 * Antwortet einem verifizierten Mitglied über WhatsApp mit demselben FINN-Coach
 * wie in der App – inkl. seiner Live-, Trainings- und Ernährungsdaten. Dazu wird
 * KEINE Logik dupliziert: der Assistent legt für den internen Aufruf eine sehr
 * kurzlebige Mitglieds-Session an und ruft den bestehenden /api/member/coach-
 * Endpunkt auf (gleiche Guardrails, Datenminimierung, Prompt-Injection-Schutz).
 *
 * „Automatisch + Eskalation": heikle bzw. nach außen wirkende Themen
 * (Kündigung/Widerruf, Beschwerde, Geld/Mahnung, Bankdaten ändern, Notfälle,
 * ausdrücklicher Wunsch nach einem Menschen) werden NICHT automatisch beantwortet,
 * sondern ans Team übergeben.
 */

const M = require('./members');

// Themen, die ein Mensch übernehmen soll (nicht die KI). Bewusst konservativ.
const SENSITIVE = [
  /\bk[uü]ndig/i, /widerruf/i, /vertrag\s*(beenden|aufl[oö]sen|k[uü]ndig)/i, /austreten/i,
  /beschwer/i, /unzufrieden/i, /\b[aä]rger/i, /anwalt/i, /\bklage/i, /betrug/i, /abzock/i,
  /r[uü]ck(erstatt|zahl)/i, /erstatt/i, /geld\s*zur[uü]ck/i, /mahnung/i, /inkasso/i,
  /r[uü]cklastschrift/i, /(doppelt|zu\s*viel|falsch)\s*(abgebucht|abgezogen)/i,
  /iban/i, /bankverbindung/i, /sepa/i, /kontonummer/i,
  /todesfall/i, /verstorben/i, /\bunfall/i, /notfall/i, /suizid/i, /selbstmord/i,
  /(mitarbeiter|mensch(en)?|kollege|jemand(en)?)\s*(sprechen|reden|erreichen)/i,
  /(ruf|ruft|rufen)\s+mich\b/i, /r[uü]ckruf/i, /zur[uü]ckrufen/i, /pers[oö]nlich\s*sprechen/i,
];

function needsEscalation(text) {
  const t = String(text || '');
  if (!t) return false;
  return SENSITIVE.some((re) => re.test(t));
}

function apiBaseFrom(req) {
  const host = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
  const proto = (req && req.headers && req.headers['x-forwarded-proto']) || 'https';
  return host ? (proto + '://' + host) : '';
}

// KI-Antwort für ein verifiziertes Mitglied holen. Bounded-Timeout, damit der
// Webhook nicht hängt; bei Fehler/Timeout -> {ok:false} (Aufrufer eskaliert dann).
// o: { req, memberId, question, history:[{role,text}], timeoutMs? }
async function answer(o) {
  o = o || {};
  const base = apiBaseFrom(o.req);
  const memberId = o.memberId;
  const question = String(o.question || '').trim();
  if (!base || memberId == null || question.length < 2) return { ok: false, error: 'bad_input' };

  // Sehr kurzlebige, rein serverseitige Session – wird nie an einen Client gegeben.
  let token = null;
  try { token = await M.createSession(memberId, 120); } catch (e) { token = null; }
  if (!token) return { ok: false, error: 'no_session' };

  const ctrl = new AbortController();
  const ms = Math.max(4000, Math.min(20000, Number(o.timeoutMs) || 13000));
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, ms);
  try {
    const r = await fetch(base + '/api/member/coach', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ question: question, history: Array.isArray(o.history) ? o.history.slice(-8) : [] }),
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => '');
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    if (j && j.ok && j.answer) return { ok: true, text: String(j.answer) };
    return { ok: false, error: (j && j.error) || 'ai_failed' };
  } catch (e) {
    return { ok: false, error: 'timeout' };
  } finally {
    clearTimeout(timer);
    try { await M.destroySession(token); } catch (e) {}
  }
}

module.exports = { needsEscalation, answer, SENSITIVE };
