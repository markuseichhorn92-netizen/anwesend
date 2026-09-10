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

// Wie ownerReply, aber mit anklickbaren WhatsApp-Buttons (Quick-Reply). `numberedText`
// (Frage + nummerierte Optionen) wird ins Postfach geschrieben UND dient als Fallback,
// wenn der Anbieter keine Buttons kann (Twilio ohne Vorlage) – dann kann das Mitglied
// die Nummer tippen, was dank Verlaufs-Kontext genauso weiterläuft.
async function ownerChoice(memberId, vorgangId, body, options, numberedText, author) {
  const SR = require('./studioReply');
  try {
    const r = await SR.applyOwnerReply(memberId, vorgangId, numberedText || body, { author: author || 'FINN', channel: 'whatsapp', buttons: { body: body, options: options } });
    waLog('choice', { ch: (r && r.channel) || null, ok: !!(r && r.ok), n: (options || []).length });
    return r;
  } catch (e) { waLog('choice_error', { name: String(e && e.name) }); return null; }
}

// Vorgeschichte des WhatsApp-Threads als Chatverlauf (ohne die aktuelle Frage).
function buildHistory(v) {
  const msgs = (v && v.messages) || [];
  return msgs
    .filter((m) => m && (m.from === 'member' || m.from === 'team') && m.text)
    .map((m) => ({ role: m.from === 'member' ? 'user' : 'assistant', text: String(m.text) }))
    .slice(-8);
}

function who(m) { m = m || {}; return ((((m.firstName || '') + ' ' + (m.lastName || '')).trim()) || 'Mitglied') + (m.customerNumber ? (' (' + m.customerNumber + ')') : ''); }

// Die auslösende Nachricht ist bereits STILL im Postfach (ohne Team-Alarm). Bei einer
// Übergabe an einen Menschen wird der Vorgang nun fürs Team markiert UND per E-Mail
// gemeldet – so bekommt das Team NUR bei Eskalation eine Benachrichtigung.
async function teamAlert(memberId, v, msgText, reason) {
  const Inbox = require('./inbox');
  const SR = require('./studioReply');
  const M = require('./members');
  try { await Inbox.alertTeam(memberId, v.id); } catch (e) {}
  try {
    let m = null; try { m = await M.getMember(memberId); } catch (e) {}
    const w = who(m);
    await SR.notifyStudio({
      member: m || { id: memberId }, vorgang: v,
      subject: '🚨 WhatsApp: Übergabe an Team – ' + w,
      text: 'FINN hat eine WhatsApp-Anfrage an das Team übergeben' + (reason ? (' (' + reason + ')') : '') + '.\n\n'
        + 'Mitglied: ' + w + (m && m.email ? (' · ' + m.email) : '')
        + '\nVorgang: ' + (v.subject || '—')
        + '\n\nNachricht des Mitglieds:\n' + String(msgText || ''),
    });
  } catch (e) {}
}

// Zentrale Behandlung einer eingehenden Nachricht eines BEKANNTEN Mitglieds –
// von BEIDEN WhatsApp-Webhooks (Meta + Twilio) genutzt, damit sie identisch sind.
// Protokolliert die Nachricht selbst: STILL (kein Team-Alarm), solange FINN sie
// erledigt – das Team wird NUR bei Eskalation benachrichtigt.
// o: { req, memberId, msg:{from,text,id}, vorgang }
async function handleInbound(o) {
  o = o || {};
  const req = o.req, memberId = o.memberId, msg = o.msg || {}, v = o.vorgang;
  if (!v || memberId == null) return;
  const WAAuth = require('./waAuth');
  const M = require('./members');
  const Inbox = require('./inbox');
  const memberText = msg.text || (msg.image ? '📷 Foto' : '');
  const quietLog = () => Inbox.reply(memberId, v.id, memberText, null, { notifyTeam: false }).catch(function () {});

  if (msg.id && !(await WAAuth.firstSeen(msg.id))) { waLog('dup'); return; }   // Meta/Twilio-Retry
  const phone = msg.from;

  // KI-Transparenz: allererste Nachricht an diesen Kontakt ist der Hinweis, dass hier
  // zunächst eine KI antwortet (einmal je Kontakt, vor jeder inhaltlichen Antwort).
  try { const WAIntro = require('./waIntro'); if (await WAIntro.discloseOnce(phone)) waLog('ai_disclosure'); } catch (e) {}
  // Nicht-personenbezogener Nutzungszähler (nur Anzahl) für den Ops-Überblick.
  try { await require('./opsStat').bump('wa_inbound'); } catch (e) {}

  // 1) ZUERST Identität: Nur ein verifiziertes, zur Nummer passendes Mitglied bekommt
  //    überhaupt eine KI-Auskunft. Sonst IMMER der Bestätigungs-Link.
  const ver = await WAAuth.getVerified(phone);
  const verified = !!(ver && String(ver.memberId) === String(memberId));
  if (!verified) {
    if (ver) waLog('verify_mismatch');
    if (!(await M.rateLimit('wa-link:' + WAAuth.normPhone(phone), 3, 86400))) { waLog('link_ratelimited'); return; }
    const chal = await WAAuth.createChallenge(phone, memberId);
    const base = apiBaseFrom(req);
    if (!chal || !base) { waLog('link_blocked', { chal: !!chal, base: !!base }); return; }
    await quietLog();
    waLog(chal.reused ? 'link_reused' : 'link_sent');
    const link = base + '/wa-verify.html?token=' + encodeURIComponent(chal.token);
    await ownerReply(memberId, v.id,
      'Hi! Schön, dass du dich meldest. 😊 Damit ich dir hier sicher zu deinem Vertrag, deinen Terminen, deinem Training und deiner Ernährung antworten darf, bestätige bitte einmal kurz, dass du es wirklich bist:\n' + link + '\nDanach beantworte ich deine Fragen direkt hier – dauert nur eine Minute.',
      'System');
    return;
  }
  await WAAuth.touch(phone);
  await quietLog();   // Nachricht still ins Postfach – Team wird nur bei Eskalation alarmiert.

  // 2) Foto? -> Mahlzeit auswerten und ins Ernährungstagebuch eintragen.
  if (msg.image) {
    waLog('photo_in');
    // Ohne sichtbares Ernährungsmodul wird nichts ins App-Tagebuch geschrieben –
    // das Mitglied könnte es nirgends sehen. Stattdessen den Partner nennen.
    if (!require('./features').ernOn()) {
      const up = require('./features').upfitUrl();
      waLog('photo_ern_off');
      await ownerReply(memberId, v.id, 'Das Ernährungstagebuch in der App ist nicht mehr aktiv' + (up ? (' – Ernährung läuft bei unserem Partner Upfit: ' + up) : '') + '. Bei allem anderen helfe ich dir hier gern weiter. 🙂', 'System');
      return;
    }
    if (!(await M.rateLimit('wa-photo:' + memberId, 20, 3600))) {
      await ownerReply(memberId, v.id, 'Das waren gerade viele Fotos – magst du es in ein paar Minuten nochmal versuchen? 🙏', 'System');
      return;
    }
    const WA = require('./whatsapp');
    let media = null; try { media = await WA.fetchMedia(msg.image); } catch (e) {}
    let done = null;
    if (media && media.base64) { try { const WAAgent = require('./waAgent'); done = await WAAgent.logFoodPhoto({ req: req, memberId: memberId, base64: media.base64, mediaType: media.mediaType }); } catch (e) {} }
    waLog(done && done.handled ? 'photo' : 'photo_failed');
    await ownerReply(memberId, v.id, (done && done.handled && done.text) ? done.text : 'Ich konnte das Foto leider nicht laden – magst du kurz beschreiben, was du gegessen hast? Dann trage ich es ein. 📷', 'FINN');
    return;
  }

  // 3) Verifiziert: heikle/nach außen wirkende Themen -> Übergabe an einen Menschen (E-Mail ans Team).
  if (needsEscalation(msg.text)) {
    waLog('escalate');
    try { await require('./opsStat').bump('wa_escalate'); } catch (e) {}
    await teamAlert(memberId, v, msg.text, 'heikles Thema');
    await ownerReply(memberId, v.id, 'Alles klar – da hole ich am besten einen Kollegen aus dem Team dazu. Jemand meldet sich hier bei dir. 🙌', 'System');
    return;
  }
  if (!(await M.rateLimit('wa-ai:' + memberId, 30, 3600))) {
    waLog('ai_ratelimited');
    await ownerReply(memberId, v.id, 'Ich hab gerade ganz schön viele Nachrichten von dir – magst du es in ein paar Minuten nochmal versuchen? 🙏', 'System');
    return;
  }
  // 2a) Erst eine echte App-AKTION versuchen (Essen/Wasser tracken, Termine, Gewicht, Training …).
  //     Der bisherige Thread-Verlauf geht als Kontext mit, damit mehrstufige Abläufe
  //     (z. B. Terminbuchung) über mehrere WhatsApp-Nachrichten hinweg funktionieren –
  //     eine kurze Folgeantwort wie „2" oder ein angetippter Button wird als Auswahl erkannt.
  try {
    const WAAgent = require('./waAgent');
    const act = await WAAgent.tryAction({ req: req, memberId: memberId, question: msg.text, history: buildHistory(v) });
    if (act && act.handled) {
      if (act.buttons && Array.isArray(act.buttons.options) && act.buttons.options.length) {
        waLog('action_choice');
        await ownerChoice(memberId, v.id, act.buttons.body, act.buttons.options, act.text, 'FINN');
      } else {
        waLog('action');
        if (act.text) await ownerReply(memberId, v.id, act.text, 'FINN');
      }
      return;
    }
  } catch (e) { waLog('action_error', { name: String(e && e.name) }); }

  const ans = await answer({ req: req, memberId: memberId, question: msg.text, history: buildHistory(v) });
  waLog(ans && ans.ok ? 'answered' : 'answer_failed', { err: (ans && ans.error) || null });
  try { await require('./opsStat').bump(ans && ans.ok ? 'wa_answered' : 'wa_unsure'); } catch (e) {}
  if (ans && ans.ok && ans.text) { await ownerReply(memberId, v.id, ans.text, 'FINN'); return; }
  // FINN konnte nicht sicher antworten -> an einen Menschen übergeben (E-Mail ans Team).
  await teamAlert(memberId, v, msg.text, 'FINN unsicher');
  await ownerReply(memberId, v.id, 'Das kann ich dir gerade nicht sicher beantworten – ein Kollege schaut hier drauf und meldet sich. 🙌', 'System');
}

module.exports = { needsEscalation, answer, SENSITIVE, waLog, ownerReply, ownerChoice, buildHistory, handleInbound };
