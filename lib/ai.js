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

// ── Roh-Aufruf der Messages-API inkl. Tool-Use (für den Team-Assistenten) ──
// Gibt die geparste Antwort zurück (content[], stop_reason); die Tool-Schleife
// steuert der Aufrufer selbst. opts: { system, messages, tools?, tool_choice?,
// maxTokens?, temperature? }.
async function messagesRaw(opts) {
  opts = opts || {};
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  try {
    const payload = {
      model: MODEL,
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      messages: opts.messages || [],
    };
    if (opts.system) payload.system = opts.system;
    if (opts.tools) payload.tools = opts.tools;
    if (opts.tool_choice) payload.tool_choice = opts.tool_choice;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text().catch(function () { return ''; });
    if (!r.ok) return { ok: false, status: r.status, error: text.slice(0, 300) };
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    if (!json) return { ok: false, error: 'bad_json' };
    return { ok: true, content: Array.isArray(json.content) ? json.content : [], stopReason: json.stop_reason };
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

// Wochenplan (7 Tage × Frühstück/Mittag/Abend) passend zum Ziel.
// -> { ok, days:[{day:'Mo', meals:[{label,title,kcal}]}], shopping:[{name,amount}] }
async function nutritionWeekPlan(ctx) {
  ctx = ctx || {};
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  const sys = [
    'Du bist ein Ernährungscoach und planst eine ausgewogene Woche auf Deutsch.',
    'Antworte AUSSCHLIESSLICH mit JSON, ohne Text drumherum, in genau dieser Form:',
    '{"days":[{"day":"Mo","meals":[{"label":"Frühstück","title":"…","kcal":0},{"label":"Mittag","title":"…","kcal":0},{"label":"Abend","title":"…","kcal":0}]}],"shopping":[{"name":"…","amount":"…"}]}',
    'Genau 7 Tage (Mo–So), je 3 Mahlzeiten. Die Tageskalorien sollen ungefähr zum Ziel passen. Alle Zahlen als ganze Zahlen.',
    'shopping = zusammengefasste Einkaufsliste der wichtigsten Zutaten (max 25, mit Menge). Kein Text außerhalb des JSON.',
  ].join('\n');
  const user = 'Ziel: ' + (ctx.goal || 'ausgewogen') + '. Tageskalorien-Richtwert: ' + (ctx.kcalTarget || '—')
    + '. Eiweißziel: ' + (ctx.protein || '—') + ' g. Ernährungsform: ' + (ctx.diet || 'omnivor') + '.';
  const r = await complete(sys, [{ role: 'user', content: user }], { maxTokens: 1800, temperature: 0.6 });
  if (!r.ok) return r;
  const j = parseJsonLoose(r.answer);
  const rawDays = j && Array.isArray(j.days) ? j.days : null;
  if (!rawDays) return { ok: false, error: 'parse_failed' };
  const days = rawDays.slice(0, 7).map(function (d) {
    d = d || {};
    return {
      day: String(d.day || '').slice(0, 4),
      meals: (Array.isArray(d.meals) ? d.meals : []).slice(0, 3).map(function (m) {
        m = m || {}; return { label: String(m.label || '').slice(0, 20), title: String(m.title || '—').slice(0, 80), kcal: n0(m.kcal) };
      }),
    };
  }).filter(function (d) { return d.meals.length; });
  if (!days.length) return { ok: false, error: 'empty' };
  const shopping = (j && Array.isArray(j.shopping) ? j.shopping : []).slice(0, 25).map(function (s) {
    s = s || {}; return { name: String(s.name || '').slice(0, 60), amount: String(s.amount || '').slice(0, 30) };
  }).filter(function (s) { return s.name; });
  return { ok: true, days: days, shopping: shopping };
}

// Wochen-Rückblick von FINN aus den echten Tageswerten.
// ctx = { goal, kcalTarget, protein, days:[{date,kcal,p}], inGoal, avgKcal, proteinDays, tracked }
// -> { ok, tip, insights:[{title,text}] }
async function nutritionWeekReview(ctx) {
  ctx = ctx || {};
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  const sys = [
    'Du bist FINN, Ernährungscoach von Fit-Inn Trier. Analysiere die Woche eines Mitglieds motivierend und konkret, per "du", Deutsch.',
    'Antworte AUSSCHLIESSLICH mit JSON: {"tip":"ein Satz, konkret & motivierend","insights":[{"title":"kurz","text":"1 Satz"}]}',
    'Genau 2 Insights, aus den Daten abgeleitet (z. B. schwache Wochentage, Eiweiß, Konstanz). Kein Text außerhalb des JSON.',
  ].join('\n');
  const daysLine = (ctx.days || []).map(function (d) { return d.date + ': ' + d.kcal + ' kcal, ' + d.p + ' g Eiweiß'; }).join('; ');
  const user = 'Ziel: ' + (ctx.goal || '—') + ', Tagesziel ' + (ctx.kcalTarget || '—') + ' kcal / ' + (ctx.protein || '—') + ' g Eiweiß.'
    + ' Tage im Kalorienziel: ' + (ctx.inGoal || 0) + '/7, Ø ' + (ctx.avgKcal || 0) + ' kcal, Eiweißziel an ' + (ctx.proteinDays || 0) + '/7 Tagen, protokolliert ' + (ctx.tracked || 0) + '/7 Tage.'
    + ' Tageswerte: ' + (daysLine || '(keine)') + '.';
  const r = await complete(sys, [{ role: 'user', content: user }], { maxTokens: 350, temperature: 0.6 });
  if (!r.ok) return r;
  const j = parseJsonLoose(r.answer);
  if (!j) return { ok: false, error: 'parse_failed' };
  return {
    ok: true,
    tip: String(j.tip || '').slice(0, 300),
    insights: (Array.isArray(j.insights) ? j.insights : []).slice(0, 3).map(function (i) { i = i || {}; return { title: String(i.title || '').slice(0, 60), text: String(i.text || '').slice(0, 200) }; }).filter(function (i) { return i.title; }),
  };
}

// ── Rückhol-Angebot vorschlagen (Team) ──
// Schlägt EIN Start-Angebot INNERHALB des Rahmens vor + eine persönliche Nachricht.
// ctx = { name, rateName, status, frame:{maxDiscountPct,maxDiscountWeeks,maxFreeWeeks,waiveActivation,maxPauseWeeks,notes} }
async function winbackSuggest(ctx) {
  ctx = ctx || {};
  const f = ctx.frame || {};
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  const bounds = [];
  if (f.maxDiscountPct) bounds.push('Rabatt max ' + f.maxDiscountPct + '%' + (f.maxDiscountWeeks ? (' für max ' + f.maxDiscountWeeks + ' Wochen') : ''));
  if (f.maxFreeWeeks) bounds.push('max ' + f.maxFreeWeeks + ' Wochen gratis');
  if (f.waiveActivation) bounds.push('Aktivierungsgebühr (39 €) darf erlassen werden');
  if (f.maxPauseWeeks) bounds.push('Beitragspause max ' + f.maxPauseWeeks + ' Wochen');
  const system = [
    'Du bist der Rückhol-Stratege von Fit-Inn Trier (familiengeführtes Fitnessstudio). Schlage EIN sinnvolles START-Angebot vor, um dieses Mitglied zu halten – bewusst SPARSAM (nicht gleich das Maximum), aber attraktiv genug.',
    'ERLAUBTER RAHMEN – NIE überschreiten, nur diese Hebel nutzen: ' + (bounds.join('; ') || 'keine Hebel freigegeben') + '.' + (f.notes ? ' Zusätzliche Leitplanken: ' + f.notes : ''),
    'Schreibe zusätzlich eine kurze, herzliche persönliche Nachricht an das Mitglied (per "du", ~40–60 Wörter, warmer Fit-Inn-Ton), die das Angebot anteasert. KEINEN Link einbauen – der wird automatisch angehängt.',
    'Antworte AUSSCHLIESSLICH als JSON, ganzzahlige Werte: {"discountPct":0,"discountWeeks":0,"freeWeeks":0,"waiveActivation":false,"pauseWeeks":0,"message":"…"}.',
  ].join('\n');
  const user = 'Mitglied: ' + (ctx.name || '—') + (ctx.rateName ? (', Tarif ' + ctx.rateName) : '') + (ctx.status ? (', Vertragsstatus ' + ctx.status) : '') + '.';
  const r = await complete(system, [{ role: 'user', content: user }], { maxTokens: 500, temperature: 0.5 });
  if (!r.ok) return { ok: false, error: r.error };
  const j = parseJsonLoose(r.answer) || {};
  return {
    ok: true,
    details: { discountPct: n0(j.discountPct), discountWeeks: n0(j.discountWeeks), freeWeeks: n0(j.freeWeeks), waiveActivation: !!j.waiveActivation, pauseWeeks: n0(j.pauseWeeks) },
    message: String(j.message || '').slice(0, 600),
  };
}

// Persönliche Rückhol-Nachricht zu einem BEREITS festgelegten Angebot schreiben
// (wird genutzt, wenn das Team die Werte anpasst und der Text mitziehen soll).
// ctx = { name, status, details:{discountPct,discountWeeks,freeWeeks,waiveActivation,pauseWeeks} }
async function winbackMessage(ctx) {
  ctx = ctx || {};
  if (!hasAI) return { ok: false, error: 'no_ai_key' };
  const d = ctx.details || {};
  const parts = [];
  if (d.discountPct) parts.push(d.discountPct + '% Rabatt' + (d.discountWeeks ? (' für ' + d.discountWeeks + ' Wochen') : ''));
  if (d.freeWeeks) parts.push(d.freeWeeks + ' Wochen gratis Training');
  if (d.waiveActivation) parts.push('Erlass der Aktivierungsgebühr (39 €)');
  if (d.pauseWeeks) parts.push('eine Beitragspause bis zu ' + d.pauseWeeks + ' Wochen');
  const offerTxt = parts.join(' und ') || 'ein persönliches Angebot';
  const system = [
    'Du bist der Rückhol-Assistent von Fit-Inn Trier. Schreibe eine kurze, herzliche, persönliche Nachricht an ein Mitglied (per "du", ~40–60 Wörter, warmer familiärer Fit-Inn-Ton), die es zum Bleiben motiviert und das GENANNTE Angebot natürlich anteasert.',
    'Das konkrete Angebot lautet: ' + offerTxt + '. Bau genau dieses Angebot in den Text ein (keine Aufzählung, kein Link – der wird automatisch angehängt).',
    'Antworte NUR mit dem Nachrichtentext, ohne Anführungszeichen und ohne "Hallo"-Floskel am Anfang.',
  ].join('\n');
  const user = 'Mitglied: ' + (ctx.name || '—') + (ctx.status ? (', Vertragsstatus ' + ctx.status) : '') + '.';
  const r = await complete(system, [{ role: 'user', content: user }], { maxTokens: 300, temperature: 0.6 });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, message: String(r.answer || '').slice(0, 600) };
}

module.exports = { askHelp, coachReply, coachTip, draftReply, estimateFood, estimateFoodPhoto, nutritionRecipes, nutritionReply, nutritionWeekPlan, nutritionWeekReview, messagesRaw, winbackSuggest, winbackMessage, hasAI, MODEL };
