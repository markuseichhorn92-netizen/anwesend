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

// Themen, die ein Mensch übernehmen soll (nicht die KI). Bewusst so gefasst, dass
// reine INFO-Fragen (z. B. „Kündigungsfrist", „Kündigungsdatum") NICHT eskalieren –
// nur echte Absichten/Aktionen und klar heikle Themen.
const SENSITIVE = [
  // Vertrag beenden – das VERB „kündigen"/„kündige" (Absicht), nicht das Substantiv
  // „Kündigung(sfrist)" (Infofrage). Plus klare Beenden-Formulierungen.
  /k[uü]ndigen/i, /\bk[uü]ndige\b/i, /hiermit\s+k[uü]ndig/i,
  /widerrufen/i, /\bich\s+widerrufe\b/i,
  /vertrag\s+(beenden|aufl[oö]sen)/i, /mitgliedschaft\s+(beenden|aufl[oö]sen)/i, /austreten/i,
  // Beschwerde / rechtlich
  /beschwer/i, /unzufrieden/i, /anwalt/i, /\bklage\b/i, /verklag/i, /betrug/i, /abzock/i,
  // Geld / Abrechnung (Streitfall)
  /r[uü]ck(erstatt|zahl)/i, /geld\s*zur[uü]ck/i, /mahnung/i, /inkasso/i, /r[uü]cklastschrift/i,
  /(doppelt|zu\s*viel|falsch)\s*(abgebucht|abgezogen)/i,
  // Bankdaten ändern
  /iban/i, /bankverbindung/i, /\bsepa\b/i, /kontonummer/i,
  // Notfall
  /todesfall/i, /verstorben/i, /\bunfall/i, /notfall/i, /suizid/i, /selbstmord/i,
  // Ausdrücklicher Wunsch nach einem Menschen
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

// Diagnose-Log OHNE Personenbezug: nur Entscheidungs-Pfad + Fehlerklasse.
// KEINE Telefonnummer, KEIN Nachrichtentext, keine Prompt-/Gesundheitsinhalte.
function waLog(path, extra) { try { console.log('[wa-assist]', JSON.stringify(Object.assign({ path: path }, extra || {}))); } catch (e) {} }

// Team-sichtbare Antwort in den Vorgang schreiben UND per WhatsApp zustellen (ein Weg).
async function ownerReply(memberId, vorgangId, text, author) {
  const SR = require('./studioReply');
  try {
    const r = await SR.applyOwnerReply(memberId, vorgangId, text, { author: author || 'FINN', channel: 'whatsapp' });
    waLog('reply', { ch: (r && r.channel) || null, ok: !!(r && r.ok) });
    return r;
  } catch (e) { waLog('reply_error', { name: String(e && e.name) }); return null; }
}

// Vorgeschichte des WhatsApp-Threads als Chatverlauf (ohne die aktuelle Frage).
function buildHistory(v) {
  const msgs = (v && v.messages) || [];
  return msgs
    .filter((m) => m && (m.from === 'member' || m.from === 'team') && m.text)
    .map((m) => ({ role: m.from === 'member' ? 'user' : 'assistant', text: String(m.text) }))
    .slice(-8);
}

// Zentrale Behandlung einer eingehenden Nachricht eines BEKANNTEN Mitglieds –
// von BEIDEN WhatsApp-Webhooks (Meta + Twilio) genutzt, damit sie identisch sind.
// o: { req, memberId, msg:{from,text,id}, vorgang }
async function handleInbound(o) {
  o = o || {};
  const req = o.req, memberId = o.memberId, msg = o.msg || {}, v = o.vorgang;
  if (!v || memberId == null) return;
  const WAAuth = require('./waAuth');
  const M = require('./members');

  if (msg.id && !(await WAAuth.firstSeen(msg.id))) { waLog('dup'); return; }   // Meta/Twilio-Retry
  const phone = msg.from;

  // 1) ZUERST Identität: Nur ein verifiziertes, zur Nummer passendes Mitglied bekommt
  //    überhaupt eine KI-Auskunft. Sonst IMMER der Bestätigungs-Link (nie eine
  //    Eskalations-/Antwortmeldung vor der Verifizierung).
  const ver = await WAAuth.getVerified(phone);
  const verified = !!(ver && String(ver.memberId) === String(memberId));
  if (!verified) {
    if (ver) waLog('verify_mismatch');
    if (!(await M.rateLimit('wa-link:' + WAAuth.normPhone(phone), 3, 86400))) { waLog('link_ratelimited'); return; }
    const chal = await WAAuth.createChallenge(phone, memberId);
    const base = apiBaseFrom(req);
    if (!chal || !base) { waLog('link_blocked', { chal: !!chal, base: !!base }); return; }
    waLog(chal.reused ? 'link_reused' : 'link_sent');
    const link = base + '/wa-verify.html?token=' + encodeURIComponent(chal.token);
    await ownerReply(memberId, v.id,
      'Hi! Schön, dass du dich meldest. 😊 Damit ich dir hier sicher zu deinem Vertrag, deinen Terminen, deinem Training und deiner Ernährung antworten darf, bestätige bitte einmal kurz, dass du es wirklich bist:\n' + link + '\nDanach beantworte ich deine Fragen direkt hier – dauert nur eine Minute.',
      'System');
    return;
  }
  await WAAuth.touch(phone);

  // 2) Verifiziert: heikle/nach außen wirkende Themen an einen Menschen; sonst FINN.
  if (needsEscalation(msg.text)) {
    waLog('escalate');
    await ownerReply(memberId, v.id, 'Alles klar – da hole ich am besten einen Kollegen aus dem Team dazu. Jemand meldet sich hier bei dir. 🙌', 'System');
    return;
  }
  if (!(await M.rateLimit('wa-ai:' + memberId, 30, 3600))) {
    waLog('ai_ratelimited');
    await ownerReply(memberId, v.id, 'Ich hab gerade ganz schön viele Nachrichten von dir – magst du es in ein paar Minuten nochmal versuchen? 🙏', 'System');
    return;
  }
  // 2a) Erst eine echte App-AKTION versuchen (Essen/Wasser tracken, Tagesstand).
  //     Greift nur bei Ernährungs-Aktionen; sonst übernimmt unten der Coach.
  try {
    const WAAgent = require('./waAgent');
    const act = await WAAgent.tryAction({ req: req, memberId: memberId, question: msg.text });
    if (act && act.handled) { waLog('action'); if (act.text) await ownerReply(memberId, v.id, act.text, 'FINN'); return; }
  } catch (e) { waLog('action_error', { name: String(e && e.name) }); }

  const ans = await answer({ req: req, memberId: memberId, question: msg.text, history: buildHistory(v) });
  waLog(ans && ans.ok ? 'answered' : 'answer_failed', { err: (ans && ans.error) || null });
  if (ans && ans.ok && ans.text) await ownerReply(memberId, v.id, ans.text, 'FINN');
  else await ownerReply(memberId, v.id, 'Das kann ich dir gerade nicht sicher beantworten – ein Kollege schaut hier drauf und meldet sich. 🙌', 'System');
}

module.exports = { needsEscalation, answer, SENSITIVE, waLog, ownerReply, buildHistory, handleInbound };
