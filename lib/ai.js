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
    'App-Bereiche, auf die du verlinken kannst: contract=Vertragsverwaltung (Vertrag, Kündigung, Widerruf, Beitragspause), data=Meine Daten (Adresse, Bankverbindung, Kontakt), account=Beitragskonto (Zahlungen, offene Beiträge), appt=Termine (buchen, absagen), checkins=Check-in-Verlauf (Besuche, Anwesenheitsbestätigung), fort=Fortschritt (Vitalpunkte), ern=Ernährung (Tagesziel, Essens-Tracking, KI-Rezepte, Ernährungscoach), card=Mitgliedskarte, referral=Freunde werben, postfach=Postfach (dem Team schreiben), help=Hilfe & Kontakt, settings=Einstellungen.',
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

// ══════════════════════════════════════════════════════════════════
// Ernährungs-Modul (Mitglieder-App): Schätzung, Rezepte, Coach
// ══════════════════════════════════════════════════════════════════

// Robust die erste vollständige JSON-Struktur ({…} oder […]) aus einer
// Modell-Antwort ziehen (Code-Fences und Fließtext drumherum tolerieren).
function parseJsonLoose(s) {
  s = String(s || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.indexOf('[');
  const start = (a < 0) ? b : (b < 0 ? a : Math.min(a, b));
  if (start < 0) return null;
  const open = s[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}
function n0(v) { const n = Math.round(Number(v)); return (isNaN(n) || n < 0) ? 0 : n; }

// Geparste Modell-Antwort ({items:[…]} oder […]) auf saubere Nährwert-Items + Summe bringen.
function foodItemsFrom(j) {
  const raw = j && Array.isArray(j.items) ? j.items : (Array.isArray(j) ? j : null);
  if (!raw) return null;
  const items = raw.slice(0, 8).map(function (it) {
    it = it || {};
    return { name: String(it.name || 'Mahlzeit').slice(0, 80), portion: String(it.portion || '').slice(0, 40), kcal: n0(it.kcal), p: n0(it.p), c: n0(it.c), f: n0(it.f) };
  }).filter(function (it) { return it.kcal > 0 || it.p > 0 || it.c > 0 || it.f > 0; });
  const total = items.reduce(function (t, it) { return { kcal: t.kcal + it.kcal, p: t.p + it.p, c: t.c + it.c, f: t.f + it.f }; }, { kcal: 0, p: 0, c: 0, f: 0 });
  return { items: items, total: total };
}

const FOOD_JSON_RULES = [
  'Antworte AUSSCHLIESSLICH mit JSON, ohne Text drumherum, in genau dieser Form:',
  '{"items":[{"name":"kurzer Name","portion":"z. B. 150 g","kcal":0,"p":0,"c":0,"f":0}]}',
  'p=Eiweiß in g, c=Kohlenhydrate in g, f=Fett in g. Alle Zahlen als ganze Zahlen. Höchstens 8 Einträge. Keine Erklärungen.',
];

// Kalorien/Makros aus einer freien Beschreibung schätzen ("mittags Hähnchen mit Reis").
// -> { ok, items:[{name,portion,kcal,p,c,f}], total:{kcal,p,c,f} }
async function estimateFood(text) {
  const q = String(text || '').trim();
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  if (q.length < 2) return { ok: false, error: 'empty' };
  const sys = [
    'Du bist ein präziser Ernährungs-Schätzer. Der Nutzer beschreibt auf Deutsch, was er gegessen oder getrunken hat.',
    'Schätze für JEDES genannte Lebensmittel realistische Nährwerte. Ist keine Menge genannt, nimm eine übliche Portion an.',
  ].concat(FOOD_JSON_RULES, ['Beschreibt die Eingabe kein Essen/Trinken, gib {"items":[]} zurück.']).join('\n');
  const r = await complete(sys, [{ role: 'user', content: q.slice(0, 500) }], { maxTokens: 500, temperature: 0.2 });
  if (!r.ok) return r;
  const parsed = foodItemsFrom(parseJsonLoose(r.answer));
  if (!parsed) return { ok: false, error: 'parse_failed' };
  return { ok: true, items: parsed.items, total: parsed.total };
}

// Kalorien/Makros aus einem MAHLZEIT-FOTO schätzen (Claude Vision, base64).
// mediaType z. B. 'image/jpeg'. -> gleiche Form wie estimateFood.
async function estimateFoodPhoto(base64, mediaType) {
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  const data = String(base64 || '').trim();
  if (data.length < 100) return { ok: false, error: 'empty' };
  const mt = /^image\/(jpeg|png|webp|gif)$/.test(String(mediaType || '')) ? mediaType : 'image/jpeg';
  const sys = [
    'Du bist ein präziser Ernährungs-Schätzer. Auf dem Foto ist eine Mahlzeit oder ein Lebensmittel zu sehen.',
    'Erkenne die sichtbaren Speisen/Getränke und schätze für jedes eine realistische Portion und die Nährwerte.',
  ].concat(FOOD_JSON_RULES, ['Ist kein Essen/Trinken erkennbar, gib {"items":[]} zurück.']).join('\n');
  const content = [
    { type: 'text', text: 'Was ist auf diesem Foto? Schätze die Nährwerte je Speise.' },
    { type: 'image', source: { type: 'base64', media_type: mt, data: data } },
  ];
  const r = await complete(sys, [{ role: 'user', content: content }], { maxTokens: 600, temperature: 0.2 });
  if (!r.ok) return r;
  const parsed = foodItemsFrom(parseJsonLoose(r.answer));
  if (!parsed) return { ok: false, error: 'parse_failed' };
  return { ok: true, items: parsed.items, total: parsed.total };
}

// Rezepte passend zum Ziel/zur Ernährungsform erzeugen.
// ctx = { goal, kcalTarget, protein, diet, wish }
// -> { ok, recipes:[{title,kcal,protein,minutes,ingredients:[],steps:[]}] }
async function nutritionRecipes(ctx) {
  ctx = ctx || {};
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  const sys = [
    'Du bist ein Ernährungscoach und erstellst einfache, alltagstaugliche Rezepte auf Deutsch.',
    'Antworte AUSSCHLIESSLICH mit JSON, ohne Text drumherum, in genau dieser Form:',
    '{"recipes":[{"title":"Name","kcal":0,"protein":0,"minutes":0,"ingredients":["200 g …"],"steps":["…"]}]}',
    'Genau 3 Rezepte. Jede Zutat mit Menge. 3–5 kurze Schritte. Alle Zahlen als ganze Zahlen. Kein Text außerhalb des JSON.',
  ].join('\n');
  const user = 'Ziel: ' + (ctx.goal || 'ausgewogen ernähren')
    + '. Kalorienrichtwert pro Tag: ' + (ctx.kcalTarget || '—')
    + '. Eiweißziel: ' + (ctx.protein || '—') + ' g. Ernährungsform: ' + (ctx.diet || 'omnivor') + '.'
    + (ctx.wish ? (' Besonderer Wunsch: ' + String(ctx.wish).slice(0, 120)) : ' Bitte drei abwechslungsreiche Vorschläge.');
  const r = await complete(sys, [{ role: 'user', content: user }], { maxTokens: 900, temperature: 0.6 });
  if (!r.ok) return r;
  const j = parseJsonLoose(r.answer);
  const raw = j && Array.isArray(j.recipes) ? j.recipes : (Array.isArray(j) ? j : null);
  if (!raw) return { ok: false, error: 'parse_failed' };
  const recipes = raw.slice(0, 3).map(function (rp) {
    rp = rp || {};
    return {
      title: String(rp.title || 'Rezept').slice(0, 100),
      kcal: n0(rp.kcal), protein: n0(rp.protein), minutes: n0(rp.minutes),
      ingredients: (Array.isArray(rp.ingredients) ? rp.ingredients : []).slice(0, 15).map(function (x) { return String(x).slice(0, 90); }),
      steps: (Array.isArray(rp.steps) ? rp.steps : []).slice(0, 8).map(function (x) { return String(x).slice(0, 200); }),
    };
  }).filter(function (rp) { return rp.title && (rp.ingredients.length || rp.steps.length); });
  if (!recipes.length) return { ok: false, error: 'empty' };
  return { ok: true, recipes: recipes };
}

// FINN als Ernährungscoach (Chat). ctx = { firstName, goal, kcalTarget, protein, eatenKcal, eatenP }
async function nutritionReply(ctx, history, question) {
  ctx = ctx || {};
  const sys = [
    'Du bist FINN, der Ernährungscoach in der Fit-Inn Trier Mitglieder-App. Freundlich, motivierend, per "du", auf Deutsch.',
    'Antworte kurz und konkret – höchstens ~70 Wörter. Kurze Sätze, ein Gedanke pro Satz.',
    'Für Aufzählungen jede Zeile mit "– " beginnen (höchstens 4). Kernzahlen (kcal, Gramm) mit **doppelten Sternchen** fett (sparsam). Sonst kein Markdown.',
    'Gib allgemeine Ernährungstipps, Mengen-/Makro-Ideen und Snack- oder Rezeptvorschläge. Nutze die Tageswerte des Mitglieds für konkrete Antworten.',
    'Keine medizinischen Diagnosen. Bei Beschwerden, Unverträglichkeiten oder individueller Betreuung empfiehl das Stoffwechsel-Coaching im Studio.',
    '',
    'Mitglied: ' + (ctx.firstName || '—') + '. Ziel: ' + (ctx.goal || '—') + '.',
    'Tagesziel: ' + (ctx.kcalTarget || '—') + ' kcal, ' + (ctx.protein || '—') + ' g Eiweiß.',
    'Heute bereits gegessen: ' + (ctx.eatenKcal || 0) + ' kcal, davon ' + (ctx.eatenP || 0) + ' g Eiweiß.',
  ].join('\n');
  const msgs = [];
  (history || []).slice(-6).forEach(function (h) { if (h && h.text) msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text).slice(0, 800) }); });
  msgs.push({ role: 'user', content: String(question || '').slice(0, 800) });
  return complete(sys, msgs, { maxTokens: 350, temperature: 0.5 });
}

module.exports = { askHelp, coachReply, coachTip, draftReply, estimateFood, estimateFoodPhoto, nutritionRecipes, nutritionReply, hasAI, MODEL };
