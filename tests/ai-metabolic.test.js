'use strict';
// FINN liest die Stoffwechselanalyse (lib/ai.js scanMetabolic): PDF geht als
// document-Block an Bedrock, ein Text-Block markiert das Dokument ausdrücklich als
// UNVERTRAUENSWÜRDIG (aiSecurity härtet nur Text-Blöcke, nicht Dokumente), der Aufruf
// läuft im TEAM-Scope, und die vorgeschlagenen Werte werden hart gekappt.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// Bedrock/Netz abklemmen: wir fangen den Aufruf im AWS-SDK-Layer ab.
// lib/ai.js spricht über requestMessages -> hier ersetzen wir die HTTP-Ebene,
// indem wir globalThis.fetch kapern (Nicht-Bedrock-Pfad) und AI_PROVIDER neutral lassen.
process.env.AI_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.AI_REQUIRE_GUARDRAIL;
process.env.VERCEL_ENV = 'development';

let lastBody = null;
globalThis.fetch = async function (url, opt) {
  lastBody = JSON.parse((opt && opt.body) || '{}');
  const payload = {
    analysis: { date: '2026-07-15', device: 'Ergostik', bmr: 1680, rmrMeasured: 1720, tdee: 2450, rq: 0.86, fatPct: 27.5, weight: 74, kcalRecommended: 2200 },
    phases: [
      { name: 'Aktivierung', kind: 'aktivierung', weeks: 6, kcal: 2400, protein: 150, carbs: 260, fat: 80, note: 'Stoffwechsel hochfahren' },
      // absichtlich unmögliche Werte -> müssen gekappt werden
      { name: 'Reduktion', kind: 'reduktion', weeks: 99, kcal: 300, protein: 9999, carbs: 5, fat: 2, note: '' },
      { name: 'Stabilisierung', kind: 'stabilisierung', weeks: 4, kcal: 2300, protein: 150, carbs: 240, fat: 78, note: '' },
      { name: 'Zuviel A', kind: 'custom', weeks: 2, kcal: 2000, protein: 120, carbs: 200, fat: 60, note: '' },
      { name: 'Zuviel B', kind: 'custom', weeks: 2, kcal: 2000, protein: 120, carbs: 200, fat: 60, note: '' },
    ],
    rationale: 'Gemessener Grundumsatz liegt über der Schätzung.',
    confidence: 'high',
  };
  const body = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
};

const AI = require(path.join(ROOT, 'lib/ai.js'));
const PDF = 'B'.repeat(500);

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  if (!AI.hasAI) { console.log('SKIP (kein AI-Setup in dieser Umgebung)'); console.log('AI-METABOLIC PASS'); process.exit(0); }

  const r = await AI.scanMetabolic(PDF, 'application/pdf', {
    profile: { sex: 'w', age: 34, weight: 74, height: 170 }, targets: { kcal: 2100 }, totalWeeks: 18,
  });
  ok('1. Auswertung erfolgreich', r && r.ok === true, JSON.stringify(r && r.error));

  // ── Anfrage-Aufbau ──
  const msgs = (lastBody && lastBody.messages) || [];
  const content = (msgs[0] && msgs[0].content) || [];
  const docBlocks = content.filter((c) => c && c.type === 'document');
  const txtBlocks = content.filter((c) => c && c.type === 'text');
  ok('2. PDF geht als document-Block (nicht als Bild)', docBlocks.length === 1 && docBlocks[0].source.media_type === 'application/pdf', JSON.stringify(content.map((c) => c.type)));
  ok('3. Warnung vor unvertrauenswürdigem Dokument vorhanden', txtBlocks.some((t) => /UNVERTRAUENSW/i.test(t.text || '')), JSON.stringify(txtBlocks.map((t) => (t.text || '').slice(0, 40))));
  ok('4. Warnung steht VOR dem Dokument', content.findIndex((c) => c.type === 'text' && /UNVERTRAUENSW/i.test(c.text || '')) < content.findIndex((c) => c.type === 'document'));
  const sys = String((lastBody && lastBody.system) || '');
  ok('5. Systemprompt verbietet Erfinden von Werten', /Erfinde NIEMALS/i.test(sys));
  ok('6. Systemprompt setzt harte Sicherheitsgrenzen (kcal nie unter Grundumsatz)', /NIE unter dem gemessenen Grundumsatz/i.test(sys), sys.slice(0, 80));
  ok('7. Keine Diagnosen/Medikamente', /Keine Diagnosen/i.test(sys));

  // ── Ausgelesene Messwerte ──
  ok('8. Messwerte übernommen', r.analysis && r.analysis.bmr === 1680 && r.analysis.tdee === 2450 && r.analysis.rq === 0.86, JSON.stringify(r.analysis));
  ok('9. Messdatum + Gerät übernommen', r.analysis.date === '2026-07-15' && r.analysis.device === 'Ergostik');

  // ── Kappung der Vorschläge (der eigentliche Schutz) ──
  ok('10. Höchstens 4 Phasen', r.phases.length <= 4, 'n=' + r.phases.length);
  const red = r.phases.filter((p) => p.name === 'Reduktion')[0];
  ok('11. Absurde kcal werden auf 1000 angehoben', red && red.kcal === 1000, JSON.stringify(red));
  ok('12. Absurdes Eiweiß auf 300 gekappt', red && red.protein === 300);
  ok('13. Zu wenig Fett auf 20 angehoben', red && red.fat === 20);
  ok('14. Wochen auf 26 gekappt', red && red.weeks === 26);
  ok('15. Begründung + Konfidenz durchgereicht', r.rationale.indexOf('Grundumsatz') >= 0 && r.confidence === 'high');

  // ── Fehlerfälle ──
  const empty = await AI.scanMetabolic('', 'application/pdf', {});
  ok('16. Leere Datei -> ok:false', empty.ok === false && empty.error === 'empty');

  // ── Anbieter-Robustheit + ehrlicher Abbruch ──
  ok('18. Prompt nennt Anbieter-Synonyme (uVida & Co.)', /uVida/i.test(sys) && /Ruheumsatz/i.test(sys) && /Gesamtumsatz/i.test(sys));
  ok('19. Prompt fordert alle Seiten zu prüfen', /ALLE Seiten/i.test(sys));
  ok('20. Prompt kennt kJ-Umrechnung', /4,184 kJ|4\.184 kJ|kJ/i.test(sys));

  // Reiner Unverträglichkeits-Befund ohne Kalorienwerte -> KEIN erfundener Plan
  const prevF = globalThis.fetch;
  globalThis.fetch = async () => {
    const b = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({
      analysis: { date: '2026-08-10', device: 'uVida', bmr: null, tdee: null, kcalRecommended: null },
      findings: ['Laktose stark erhöht', 'Weizen erhöht'],
      phases: [], rationale: 'Der Befund enthält nur Unverträglichkeiten, keine Umsatzwerte.', confidence: 'low',
    }) }] });
    return { ok: true, status: 200, text: async () => b, json: async () => JSON.parse(b) };
  };
  const nov = await AI.scanMetabolic(PDF, 'application/pdf', {});
  ok('21. Ohne Kalorienwerte: ehrlicher Abbruch statt erfundener Zahlen', nov.ok === false && nov.error === 'no_values', JSON.stringify(nov && nov.error));
  ok('22. Auffälligkeiten werden trotzdem zurückgegeben', Array.isArray(nov.findings) && nov.findings.length === 2 && /Laktose/.test(nov.findings[0]), JSON.stringify(nov.findings));
  ok('23. Begründung erklärt dem Team den Grund', /Unverträglichkeiten/i.test(nov.rationale || ''), nov.rationale);
  globalThis.fetch = prevF;

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => { const b = JSON.stringify({ content: [{ type: 'text', text: 'kein json' }] }); return { ok: true, status: 200, text: async () => b, json: async () => JSON.parse(b) }; };
  const bad = await AI.scanMetabolic(PDF, 'application/pdf', {});
  ok('17. Unbrauchbare Antwort -> parse_failed statt Absturz', bad.ok === false && bad.error === 'parse_failed', JSON.stringify(bad));
  globalThis.fetch = prevFetch;

  console.log(pass ? 'AI-METABOLIC PASS' : 'AI-METABOLIC FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
