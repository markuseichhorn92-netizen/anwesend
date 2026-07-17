'use strict';
// Prompt Caching (lib/ai.js): FINN-Chat, Hilfe-Q&A und Team-Antwort-Entwurf
// senden die große, über alle Anfragen IDENTISCHE Wissensbasis als gecachten
// System-Vorspann (cache_control:ephemeral). Der mitgliedsspezifische Teil
// (Vorname/Live-Daten/Frage) bleibt UNgecacht im dynamischen Block bzw. User-Turn.
process.env.ANTHROPIC_API_KEY = 'test-key';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  let lastBody = null;
  global.fetch = async (url, opts) => {
    lastBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) };
  };
  const AI = require(path.resolve(ROOT, 'lib/ai.js'));
  const articles = [
    { t: 'Öffnungszeiten', cat: 'Studio', body: ('Mo–Fr 6–23 Uhr, Sa/So 8–20 Uhr. ').repeat(40) },
    { t: 'Kündigung', body: ('Kündigungsfrist beträgt 3 Monate zum Laufzeitende. ').repeat(40) },
  ];

  // 1. coachReply (FINN-Chat)
  await AI.coachReply({ firstName: 'Max', details: 'Vertrag läuft bis 2027' }, [], 'Wann habt ihr offen?', articles);
  const sys = lastBody.system;
  ok('1. coachReply: system ist Block-Array', Array.isArray(sys) && sys.length >= 1);
  ok('2. erster Block gecacht (cache_control:ephemeral)', !!(sys[0] && sys[0].cache_control && sys[0].cache_control.type === 'ephemeral'));
  ok('3. Wissensbasis steht im gecachten Block', /Öffnungszeiten/.test(sys[0].text) && /Kündigungsfrist/.test(sys[0].text));
  ok('4. Vorname/Live-Daten NICHT im gecachten Block', !/Max/.test(sys[0].text) && !/2027/.test(sys[0].text));
  ok('5. Vorname/Live-Daten stehen im dynamischen Block', !!(sys[1] && /Max/.test(sys[1].text) && /2027/.test(sys[1].text)));
  ok('6. dynamischer Block ist NICHT gecacht', !!(sys[1] && !sys[1].cache_control));

  // 2. askHelp (Hilfe-Q&A)
  lastBody = null;
  await AI.askHelp('Wann habt ihr offen?', articles);
  ok('7. askHelp: system gecacht + Wissensbasis drin', Array.isArray(lastBody.system) && !!lastBody.system[0].cache_control && /Öffnungszeiten/.test(lastBody.system[0].text));
  ok('8. askHelp: Frage im User-Turn, nicht im System', /Wann habt ihr offen/.test(lastBody.messages[0].content) && !/Wann habt ihr offen/.test(lastBody.system[0].text));

  // 3. draftReply (Team-Antwort-Entwurf)
  lastBody = null;
  await AI.draftReply({ member: { name: 'Max Mustermann', rateName: 'Premium' }, subject: 'Frage', messages: [{ from: 'member', text: 'Wann offen?' }], articles: articles });
  ok('9. draftReply: system gecacht + Wissensbasis drin', Array.isArray(lastBody.system) && !!lastBody.system[0].cache_control && /Öffnungszeiten/.test(lastBody.system[0].text));
  ok('10. draftReply: nur Vorname im Kontext (Datenminimierung)', /Max/.test(lastBody.messages[0].content) && !/Mustermann/.test(lastBody.messages[0].content));

  // 4. cacheBlocks direkt: leerer dynamischer Teil -> nur ein Block
  const one = AI.cacheBlocks ? AI.cacheBlocks('nur stabil', '') : null;
  if (AI.cacheBlocks) ok('11. cacheBlocks ohne dynamischen Teil -> genau 1 Block', one.length === 1 && !!one[0].cache_control);

  console.log(pass ? 'AI-CACHE PASS' : 'AI-CACHE FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
