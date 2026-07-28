'use strict';

/**
 * WhatsApp-FINN: echte App-AKTIONEN (nicht nur Antworten).
 * -----------------------------------------------------------------------------
 * Phase 1: Ernährung tracken – genau wie in der App, über dieselben Endpunkte
 * (/api/member/nutrition) mit einer intern gemünzten, kurzlebigen Mitglieds-Session.
 *   - log_food(description)  -> KI-Schätzung (estimate) + Eintrag (confirm-log)
 *   - add_water(glasses)     -> Wasser (water)
 *   - nutrition_today()      -> heutiger Stand (state)
 *
 * Ablauf: EIN KI-Aufruf entscheidet Werkzeug + Argumente (Tool Use). Die Bestätigung
 * an das Mitglied wird DETERMINISTISCH getextet (kein zweiter KI-Aufruf) – schnell,
 * günstig, robust. Ist die Nachricht KEINE Ernährungs-Aktion, liefert tryAction
 * { handled:false } und der normale FINN-Coach übernimmt die Antwort.
 *
 * Freemium/Quota und alle Guardrails gelten unverändert: die Endpunkte prüfen das
 * KI-Kontingent selbst; es wird nichts umgangen.
 */

const AI = require('./ai');
const M = require('./members');

function apiBaseFrom(req) {
  const h = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
  const p = (req && req.headers && req.headers['x-forwarded-proto']) || 'https';
  return h ? (p + '://' + h) : '';
}

const ACTION_TOOLS = [
  {
    name: 'log_food',
    description: 'Trägt Gegessenes/Getrunkenes ins Ernährungstagebuch des Mitglieds ein. FINN schätzt Kalorien und Makros aus der Beschreibung. Nutze das IMMER, wenn das Mitglied schreibt, WAS es gegessen oder getrunken hat (auch mehrere Dinge in einer Nachricht).',
    input_schema: { type: 'object', properties: { description: { type: 'string', description: 'Was gegessen/getrunken wurde, mit Mengen wenn genannt, z. B. "200 g Hähnchen mit Reis und Brokkoli, 1 Apfel"' } }, required: ['description'] },
  },
  {
    name: 'add_water',
    description: 'Trägt getrunkenes Wasser ein, in Gläsern à 0,25 l (0,5 l = 2 Gläser, 1 l = 4 Gläser).',
    input_schema: { type: 'object', properties: { glasses: { type: 'number', description: 'Anzahl Gläser à 0,25 l' } }, required: ['glasses'] },
  },
  {
    name: 'nutrition_today',
    description: 'Liest den heutigen Ernährungsstand (gegessene Kalorien/Makros vs. Ziel, Wasser). Nutze das für Fragen wie „wie viele Kalorien habe ich heute noch?".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

const SYS = [
  'Du bist FINN, der Ernährungs-Coach von Fit-Inn Trier, und hilfst einem Mitglied über WhatsApp beim ESSEN TRACKEN.',
  'Wenn das Mitglied schreibt, was es gegessen oder getrunken hat, trage es mit log_food ein (schätze Mengen, wenn keine genannt sind). Reines Wasser mit add_water.',
  'Fragen zum heutigen Stand (Kalorien/Makros/Wasser) beantwortest du mit nutrition_today.',
  'Wenn die Nachricht NICHTS mit Ernährung/Tracking zu tun hat (z. B. Vertrag, Termine, allgemeine Trainings- oder Ernährungswissensfragen ohne konkretes Essen), rufe KEIN Werkzeug auf.',
].join('\n');

async function callNutrition(base, token, action, extra) {
  try {
    const r = await fetch(base + '/api/member/nutrition', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})),
    });
    const t = await r.text().catch(function () { return ''; });
    try { return JSON.parse(t); } catch (e) { return {}; }
  } catch (e) { return {}; }
}

// Kompakter Tagesstand aus der buildState-Antwort (gegessen vs. Ziel).
function compact(s) {
  const t = (s && s.today) || {}, tot = t.totals || {}, tg = (s && s.targets) || {};
  return {
    kcal: Math.round(tot.kcal || 0), kcalZiel: Math.round(tg.kcal || 0),
    eiweissG: Math.round(tot.p || 0), eiweissZielG: Math.round(tg.protein || 0),
    khG: Math.round(tot.c || 0), fettG: Math.round(tot.f || 0),
    wasserGlaeser: t.water != null ? Math.round(t.water * 10) / 10 : null,
    wasserZielGlaeser: t.waterGoal != null ? t.waterGoal : null,
  };
}

async function execTool(base, token, name, input) {
  input = input || {};
  if (name === 'log_food') {
    const est = await callNutrition(base, token, 'estimate', { text: String(input.description || '').slice(0, 500) });
    if (!(est && est.ok && Array.isArray(est.items) && est.items.length)) {
      return { ok: false, message: (est && est.message) || 'Ich konnte kein Lebensmittel erkennen – beschreib es bitte etwas genauer.' };
    }
    const saved = await callNutrition(base, token, 'confirm-log', { items: est.items });
    const added = (Array.isArray(saved.added) && saved.added.length ? saved.added : est.items)
      .map(function (a) { return { name: a.name, kcal: Math.round(a.kcal || 0) }; });
    return { ok: true, kind: 'log_food', added: added, stand: compact(saved) };
  }
  if (name === 'add_water') {
    const g = Math.max(0, Math.min(20, Number(input.glasses) || 0));
    const s = await callNutrition(base, token, 'water', { delta: g });
    return { ok: true, kind: 'add_water', glasses: g, stand: compact(s) };
  }
  if (name === 'nutrition_today') {
    const s = await callNutrition(base, token, 'state', {});
    return { ok: true, kind: 'nutrition_today', stand: compact(s) };
  }
  return { ok: false, error: 'unknown_tool' };
}

// Deterministische, freundliche Bestätigung (kein zweiter KI-Aufruf).
function standLine(s) {
  if (!s) return '';
  const bits = [];
  bits.push(s.kcalZiel ? ('heute ' + s.kcal + ' von ' + s.kcalZiel + ' kcal') : ('heute ' + s.kcal + ' kcal'));
  if (s.eiweissG != null) bits.push('Eiweiß ' + s.eiweissG + (s.eiweissZielG ? ('/' + s.eiweissZielG) : '') + ' g');
  if (s.wasserGlaeser != null) bits.push('Wasser ' + s.wasserGlaeser + (s.wasserZielGlaeser ? ('/' + s.wasserZielGlaeser) : '') + ' Gläser');
  return bits.join(' · ');
}
function replyFor(results) {
  const parts = [];
  let stand = null, didAction = false;
  (results || []).forEach(function (out) {
    if (!out || out.ok === false) { parts.push((out && out.message) || 'Das hat gerade nicht geklappt.'); return; }
    if (out.kind === 'log_food') {
      const names = (out.added || []).map(function (e) { return e.name + ' (~' + e.kcal + ' kcal)'; }).join(', ');
      parts.push('Eingetragen: ' + names + '.'); stand = out.stand; didAction = true;
    } else if (out.kind === 'add_water') {
      parts.push('Wasser notiert (+' + (out.glasses === 1 ? '1 Glas' : out.glasses + ' Gläser') + ').'); stand = out.stand; didAction = true;
    } else if (out.kind === 'nutrition_today') { stand = out.stand; }
  });
  const line = standLine(stand);
  if (line) parts.push(line + '.');
  let text = parts.join(' ').trim();
  if (didAction) text += ' 💪';
  return text || 'Erledigt.';
}

/**
 * Versucht eine ERNÄHRUNGS-Aktion (Essen/Wasser tracken, Tagesstand).
 * o: { req, memberId, question }
 * -> { handled:true, text } wenn getrackt/beantwortet, sonst { handled:false }
 *    (dann übernimmt der normale FINN-Coach die Antwort).
 */
async function tryAction(o) {
  o = o || {};
  const base = apiBaseFrom(o.req);
  if (!base || o.memberId == null || !AI.hasAI) return { handled: false };
  let token = null; try { token = await M.createSession(o.memberId, 120); } catch (e) {}
  if (!token) return { handled: false };
  try {
    const r = await AI.messagesRaw({
      system: SYS,
      messages: [{ role: 'user', content: String(o.question || '').slice(0, 1500) }],
      tools: ACTION_TOOLS, maxTokens: 400, temperature: 0.1,
    });
    if (!r.ok) return { handled: false };
    const content = r.content || [];
    const toolUses = content.filter(function (b) { return b && b.type === 'tool_use'; });
    if (!toolUses.length) return { handled: false };   // keine Ernährungs-Aktion -> Coach
    const results = [];
    for (const tu of toolUses) { results.push(await execTool(base, token, tu.name, tu.input || {})); }
    return { handled: true, text: replyFor(results) };
  } catch (e) {
    return { handled: false };
  } finally { try { await M.destroySession(token); } catch (e) {} }
}

module.exports = { tryAction, replyFor, compact, ACTION_TOOLS };
