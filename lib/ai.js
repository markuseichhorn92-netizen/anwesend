'use strict';

/**
 * KI-Antworten über die Anthropic Claude API (für das Kontaktformular im
 * Mitgliederbereich). Beantwortet frei formulierte Mitgliederfragen auf Basis
 * unserer Hilfe-/FAQ-Artikel (lib/help.js).
 *
 * Benötigt ANTHROPIC_API_KEY (Vercel Env). Modell überschreibbar via AI_MODEL.
 * Ist kein Key gesetzt oder schlägt der Call fehl, liefert askHelp { ok:false } –
 * der Aufrufer fällt dann auf das normale Kontaktformular zurück.
 */

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const hasAI = Boolean(KEY);

function buildKnowledge(articles) {
  return (articles || []).map(function (a, i) {
    return '### ' + (i + 1) + '. ' + a.t + (a.cat ? ' [' + a.cat + ']' : '') + '\n' + a.body;
  }).join('\n\n');
}

const SYSTEM = [
  'Du bist der freundliche digitale Assistent des Fitnessstudios Fit-Inn Trier (Auf Hirtenberg 8, 54296 Trier, Tel. 0651 308524, info@fit-inn-trier.de).',
  'Beantworte die Frage eines Mitglieds kurz, konkret und herzlich auf Deutsch und per "du".',
  'Stütze dich AUSSCHLIESSLICH auf die unten stehenden Hilfe-Artikel und allgemein bekannte, unstrittige Studio-Fakten daraus. Erfinde nichts dazu – keine Preise, Fristen oder Öffnungszeiten, die nicht in den Artikeln stehen.',
  'Wenn die Artikel die Frage nicht abdecken, sag ehrlich, dass du dir nicht sicher bist und das Team gerne persönlich weiterhilft.',
  'Antworte in 2–4 kurzen Absätzen, ohne Markdown-Überschriften, ohne Aufzählungssternchen am Zeilenanfang (nutze normale Sätze oder Spiegelstriche "–"). Keine Anrede-Floskel wie "Hallo" am Anfang.',
].join('\n');

/**
 * @param {string} question  Freitext-Frage des Mitglieds
 * @param {Array}  articles  [{t,cat,body}] Wissensbasis (lib/help.js)
 * @returns {Promise<{ok:boolean, answer?:string, model?:string, status?:number, error?:string}>}
 */
async function askHelp(question, articles) {
  const q = String(question || '').trim();
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  if (!q) return { ok: false, error: 'empty_question' };

  const knowledge = buildKnowledge(articles);
  const userContent =
    'Hilfe-Artikel (Wissensbasis):\n\n' + knowledge +
    '\n\n---\n\nFrage des Mitglieds:\n' + q.slice(0, 1500);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        temperature: 0.3,
        system: SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    const text = await r.text().catch(function () { return ''; });
    if (!r.ok) return { ok: false, status: r.status, error: text.slice(0, 200) };
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    const answer = json && Array.isArray(json.content)
      ? json.content.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim()
      : '';
    if (!answer) return { ok: false, status: r.status, error: 'empty_answer' };
    return { ok: true, answer: answer, model: MODEL };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

// ── FINN – der Coach (Chat + Tagesimpuls), nutzt dieselbe Claude-API ──
async function complete(system, messages, opts) {
  opts = opts || {};
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: opts.maxTokens || 400,
        temperature: opts.temperature == null ? 0.5 : opts.temperature,
        system: system, messages: messages,
      }),
    });
    const text = await r.text().catch(function () { return ''; });
    if (!r.ok) return { ok: false, status: r.status, error: text.slice(0, 200) };
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    const answer = json && Array.isArray(json.content)
      ? json.content.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim()
      : '';
    if (!answer) return { ok: false, status: r.status, error: 'empty_answer' };
    return { ok: true, answer: answer, model: MODEL };
  } catch (e) { return { ok: false, error: String(e && e.message) }; }
}

function coachSystem(member, articles) {
  const m = member || {};
  const ctx = 'Mitglied: ' + ((m.firstName || '') + ' ' + (m.lastName || '')).trim()
    + (m.customerNumber ? (', Nr. ' + m.customerNumber) : '')
    + (m.rateName ? (', Tarif ' + m.rateName) : '') + '.';
  let today = '';
  try { today = 'Heute ist ' + new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeZone: 'Europe/Berlin' }).format(new Date()) + '.'; } catch (e) {}
  // Live-Daten des ANGEMELDETEN Mitglieds (Vertrag, Termine, Besuche, Beitragskonto) –
  // vom Server zusammengestellt, damit FINN individuelle Fragen konkret beantworten kann.
  const details = (m.details && String(m.details).trim())
    ? '\nLive-Daten dieses Mitglieds (aktuell aus dem System, vertraulich – gelten NUR für die angemeldete Person):\n' + String(m.details).trim()
    : '';
  return [
    'Du bist FINN, der persönliche Coach in der Fit-Inn Trier Mitglieder-App und die erste, freundliche Anlaufstelle für Mitglieder (Fit-Inn Trier, Auf Hirtenberg 8, 54296 Trier, Tel. 0651 308524, info@fit-inn-trier.de).',
    'Antworte kurz, herzlich und motivierend, per "du", auf Deutsch – insgesamt höchstens ~60 Wörter.',
    'Schreibe ÜBERSICHTLICH: kurze Sätze, ein Gedanke pro Satz. Zusammenhängendes in einen kurzen Absatz; neue Gedanken durch EINE Leerzeile trennen.',
    'Bei mehreren Fakten, Optionen oder Schritten: nutze eine Aufzählung – jede Zeile beginnt mit "– " (höchstens 4 Punkte, je Zeile nur ein Fakt).',
    'Kernfakten wie Datum, Betrag, Tarif oder Uhrzeit hebst du mit **doppelten Sternchen** fett hervor (sparsam, max. 3 pro Antwort). Sonst kein Markdown, keine Überschriften.',
    'Stütze dich auf den Kontext, die Live-Daten und die Hilfe-Artikel. Erfinde keine Preise, Fristen oder Öffnungszeiten, die dort nicht stehen.',
    'Fragen zum eigenen Vertrag (Tarif, Laufzeit, Kündigungsfrist, nächstmöglicher Kündigungstermin), zu Terminen, Besuchen oder zum Beitragskonto beantwortest du konkret anhand der Live-Daten.',
    'Aktionen führst du NIE selbst aus: Für Kündigung/Widerruf verweise auf „Vertragsverwaltung" im Mitgliederbereich, für Terminbuchung auf „Termine". Bei Beschwerden, Zahlungsproblemen oder sehr persönlichen Themen biete an, an das Team zu übergeben.',
    'Gib niemals Daten anderer Personen aus und beantworte nur Fragen zur angemeldeten Person.',
    'App-Bereiche, auf die du verlinken kannst: contract=Vertragsverwaltung (Vertrag, Kündigung, Widerruf, Beitragspause), data=Meine Daten (Adresse, Bankverbindung, Kontakt), account=Beitragskonto (Zahlungen, offene Beiträge), appt=Termine (buchen, absagen), checkins=Check-in-Verlauf (Besuche, Anwesenheitsbestätigung), fort=Fortschritt (Vitalpunkte), card=Mitgliedskarte, referral=Freunde werben, postfach=Postfach (dem Team schreiben), help=Hilfe & Kontakt, settings=Einstellungen.',
    'Wenn einer dieser Bereiche dem Mitglied bei seiner Frage direkt weiterhilft, hänge ans ENDE deiner Antwort genau einmal den Marker [[screen:ID]] an (z. B. [[screen:contract]]) – nur mit einer ID aus der Liste. Der Marker wird dem Mitglied als Button angezeigt; beschreibe den Weg dorthin im Text daher nicht umständlich. Passt kein Bereich, lass den Marker weg.',
    '', today, ctx, details, '', 'Hilfe-Artikel (Wissensbasis):', buildKnowledge(articles),
  ].join('\n');
}

// Chat-Antwort von FINN. history: [{role:'user'|'assistant', text}].
async function coachReply(member, history, question, articles) {
  const msgs = [];
  (history || []).slice(-8).forEach(function (h) {
    if (h && h.text) msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text).slice(0, 1500) });
  });
  msgs.push({ role: 'user', content: String(question || '').slice(0, 1500) });
  return complete(coachSystem(member, articles), msgs, { maxTokens: 400, temperature: 0.5 });
}

// ── Smart-Reply fürs Team-Backend: Antwort-ENTWURF an ein Mitglied ──
// Der Entwurf wird im Team-Postfach ins Antwortfeld gesetzt und dort vor dem
// Senden bearbeitet. ctx = { member:{name,rateName?}, subject, messages:[{from,text}], articles }.
const DRAFT_SYSTEM = [
  'Du bist Mitarbeiter:in von Fit-Inn Trier und formulierst einen freundlichen, konkreten Antwort-ENTWURF an ein Mitglied.',
  'Per „du", Deutsch, 2–5 Sätze, kein Markdown, keine erfundenen Preise/Fristen/Öffnungszeiten – stütze dich auf den Verlauf und die Hilfe-Artikel.',
  'Wenn Infos fehlen, formuliere höflich eine Rückfrage.',
  'Antworte NUR mit dem Entwurfstext (keine Betreffzeile, keine Signatur, keine Anführungszeichen drumherum).',
].join('\n');

async function draftReply(ctx) {
  ctx = ctx || {};
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  const member = ctx.member || {};
  const name = String(member.name || '').trim();
  const transcript = (ctx.messages || []).map(function (mm) {
    const who = mm && mm.from === 'member' ? 'Mitglied' : (mm && mm.from === 'team' ? 'Team (wir)' : 'System');
    return who + ': ' + String((mm && mm.text) || '').slice(0, 1200);
  }).join('\n\n');
  const knowledge = buildKnowledge(ctx.articles);
  const userContent =
    'Kontext zum Mitglied:' +
    (name ? ('\nName: ' + name) : '') +
    (member.rateName ? ('\nTarif: ' + member.rateName) : '') +
    (ctx.subject ? ('\nBetreff des Vorgangs: ' + String(ctx.subject)) : '') +
    '\n\nHilfe-Artikel (Wissensbasis):\n\n' + knowledge +
    '\n\n---\n\nBisheriger Verlauf des Vorgangs:\n\n' + (transcript || '(noch keine Nachrichten)') +
    '\n\n---\n\nSchreibe jetzt den Antwort-Entwurf des Teams an das Mitglied.';
  return complete(DRAFT_SYSTEM, [{ role: 'user', content: userContent }], { maxTokens: 500, temperature: 0.4 });
}

// Ein einzelner motivierender Tagesimpuls für die Übersicht.
async function coachTip(statsLine, goal) {
  const sys = 'Du bist FINN, der persönliche Coach von Fit-Inn Trier. Schreibe GENAU EINE motivierende, konkrete Nachricht auf Deutsch (per du, warmherzig, höchstens 2 Sätze, maximal 1 Emoji) – ohne Namen, ohne Anrede-Zeile. Antworte nur mit der Nachricht.';
  const user = 'Stand des Mitglieds: ' + (statsLine || 'aktiv')
    + (goal ? ('. Sein wichtigstes Ziel: ' + String(goal).slice(0, 60)) : '')
    + '. Gib einen kleinen, konkreten Impuls für heute' + (goal ? ', der zu seinem Ziel passt.' : '.');
  return complete(sys, [{ role: 'user', content: user }], { maxTokens: 120, temperature: 0.85 });
}

module.exports = { askHelp, coachReply, coachTip, draftReply, hasAI, MODEL };
