'use strict';

/**
 * POST /api/nutrition/coach   – FINN beantwortet Ernährungsfragen (Chat).
 * -----------------------------------------------------------------------
 * Body (JSON):
 *   { question, history?:[{role:'user'|'finn', text}], profile?:{goal,kcal,protein,eaten} }
 *
 * Antwort:
 *   { ok:true, ai:true,  answer:string }   – KI-Antwort (Claude Haiku)
 *   { ok:true, ai:false, answer:string }   – Demo-Antwort (kein Key / Fehler)
 *
 * Grundgerüst-Endpoint: braucht KEINE Mitglieder-Anmeldung (zum Testen),
 * ist aber leicht IP-ratenbegrenzt. Nutzt ANTHROPIC_API_KEY / AI_MODEL wie lib/ai.js.
 */

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const hasAI = Boolean(KEY);

// Einfache In-Memory-Ratenbremse pro warmer Instanz (kein Store nötig).
const hits = new Map();
function rateOk(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 40;
  const arr = (hits.get(ip) || []).filter(function (t) { return now - t < win; });
  arr.push(now); hits.set(ip, arr);
  return arr.length <= max;
}

function systemPrompt(p) {
  p = p || {};
  const ctx = [];
  if (p.goal) ctx.push('Ziel: ' + p.goal + '.');
  if (p.kcal) ctx.push('Kalorienziel: ' + p.kcal + ' kcal/Tag.');
  if (p.protein) ctx.push('Eiweißziel: ' + p.protein + ' g/Tag.');
  if (p.eaten != null) ctx.push('Heute bereits gegessen: ' + p.eaten + ' kcal.');
  return [
    'Du bist FINN, der KI-Ernährungscoach der Fit-Inn Trier App.',
    'Antworte kurz (höchstens 3 Sätze), warmherzig, per "du", auf Deutsch, konkret und motivierend.',
    'Gib alltagstaugliche Ernährungstipps (Mahlzeiten, Makros, Snacks, Rezepte) passend zu Fitness-Zielen.',
    'Keine medizinischen Diagnosen. Bei Krankheit, Unverträglichkeiten oder sehr persönlichen Themen empfiehl eine 1:1-Ernährungsberatung im Studio.',
    'Keine Markdown-Überschriften, keine Sternchen-Listen, keine Anrede-Floskel am Anfang.',
    ctx.length ? ('\nKontext des Mitglieds: ' + ctx.join(' ')) : '',
  ].join('\n');
}

function demoAnswer(q) {
  const s = String(q || '').toLowerCase();
  if (s.includes('eiwei') || s.includes('protein')) {
    return 'Für mehr Eiweiß sind Magerquark, Skyr, Hähnchen, Linsen oder Harzer Käse top. Ein Becher Magerquark bringt dir schon rund 20 g – perfekt als Snack am Abend. 💪';
  }
  if (s.includes('abnehm') || s.includes('defizit')) {
    return 'Bleib bei einem moderaten Defizit und iss viel Eiweiß und Gemüse – das hält satt, ohne dass du hungerst. Kleine Schritte, die du durchhältst, schlagen jede Crash-Diät. 🥗';
  }
  if (s.includes('rezept') || s.includes('koch') || s.includes('essen')) {
    return 'Sag mir, was du zu Hause hast oder worauf du Lust hast – dann bau ich dir ein passendes Rezept mit Nährwerten. Wie wär\'s mit einer schnellen Protein-Bowl?';
  }
  return 'Gute Frage! Achte auf ausreichend Eiweiß, genug Wasser und regelmäßige Mahlzeiten – das ist das Fundament. Erzähl mir dein Ziel, dann werde ich konkreter. 🙂';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!rateOk(ip)) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', answer: 'Kurz durchatmen – das waren viele Fragen auf einmal. Gleich nochmal versuchen. 🙂' })); }

  let raw = '';
  await new Promise(function (resolve) { req.on('data', function (c) { raw += c; }); req.on('end', resolve); req.on('error', resolve); });
  let d = {}; try { d = raw ? JSON.parse(raw) : {}; } catch (e) { d = {}; }
  const question = String(d.question || '').trim().slice(0, 600);
  if (question.length < 2) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty' })); }

  if (!hasAI) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ai: false, answer: demoAnswer(question) }));
  }

  // Verlauf aufbauen (letzte 8 Nachrichten).
  const msgs = [];
  (Array.isArray(d.history) ? d.history : []).slice(-8).forEach(function (h) {
    if (h && h.text) msgs.push({ role: h.role === 'finn' || h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text).slice(0, 1200) });
  });
  msgs.push({ role: 'user', content: question });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 400, temperature: 0.6,
        system: systemPrompt(d.profile), messages: msgs,
      }),
    });
    const text = await r.text().catch(function () { return ''; });
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    const answer = json && Array.isArray(json.content)
      ? json.content.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim()
      : '';
    if (r.ok && answer) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, ai: true, answer: answer, model: MODEL }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ai: false, answer: demoAnswer(question), note: 'fallback' }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ai: false, answer: demoAnswer(question), note: 'fallback_error' }));
  }
};
