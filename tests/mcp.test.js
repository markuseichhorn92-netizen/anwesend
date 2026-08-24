'use strict';
// MCP-Zugang fuer Support-Fragen.
//
// Hier fliessen Mitgliederdaten in eine KI-Sitzung. Der Test prueft deshalb
// vor allem, was NICHT geht:
//   - ohne Token gar nichts,
//   - kein Schreiben,
//   - keine Gesundheitsdaten,
//   - kein Verzeichnis (Suche nur gezielt, gedeckelt).
// Das sind die Zusagen, mit denen dieser Zugang ueberhaupt vertretbar ist.
// Faellt einer dieser Tests, ist er es nicht mehr.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
};
const frisch = (rel) => { delete require.cache[path.resolve(ROOT, rel)]; return require(path.resolve(ROOT, rel)); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

inject('lib/store.js', { hasStore: true, redisPipeline: async () => [] });

const mlRufe = [];
inject('lib/members.js', {
  hasStore: true,
  readBody: async (req) => req.__body || {},
  rateLimit: async () => true,
  ml: async (methode, pfad, body) => {
    mlRufe.push({ methode, pfad, body });
    return { status: 200, json: [{ id: 4711, firstName: 'Martha Regine', lastName: 'Degens', customerNumber: 'M-1234', email: 'md@example.invalid', phonePrivate: '+4915100000000' }] };
  },
  getContract: async () => ({ rateName: 'Basis', contractStatus: 'ACTIVE', startDate: '2024-02-01',
    endDate: '2026-12-31', cancellationDate: '2026-08-20', nextCancellationDateISO: '2026-12-31', contractId: 'c-1' }),
});
inject('lib/inbox.js', {
  hasStore: true,
  list: async () => ([
    { id: '3', type: 'kuendigung', subject: 'Kündigung deiner Mitgliedschaft', status: 'bearbeitung', teamStatus: 'neu', ref: '#K-1003', createdAt: 1755000000000, messages: [{ from: 'system', text: 'Kündigung eingegangen', at: 1755000000000 }] },
    { id: '2', type: 'allgemein', subject: 'Frage', status: 'abgeschlossen', ref: '#M-1002', createdAt: 1754000000000, messages: [] },
  ]),
  get: async (id, vid) => (vid === '3' ? { id: '3', type: 'kuendigung', subject: 'Kündigung deiner Mitgliedschaft', status: 'bearbeitung', ref: '#K-1003',
    messages: [{ from: 'system', text: 'Kündigung zum 31.12.2026 eingegangen', at: 1755000000000 }] } : null),
});

function ruf(H, body, token) {
  const req = { method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, url: '/api/mcp', __body: body };
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; return this; } };
  return H(req, res).then(() => ({ status: res.statusCode, json: (function () { try { return JSON.parse(res.body); } catch (e) { return null; } })() }));
}
const werkzeug = (H, name, args) => ruf(H, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: name, arguments: args } }, 'tk');
const textVon = (r) => String(((r.json && r.json.result && r.json.result.content) || [])[0] && (r.json.result.content[0].text) || '');

async function run() {
  // ── 1. Ohne Token gibt es den Server nicht ──
  delete process.env.MCP_TOKEN;
  let H = frisch('api/mcp.js');
  let r = await ruf(H, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'tk');
  ok('1. Ohne eingerichteten Token: aus', r.status === 503, JSON.stringify(r.json));

  process.env.MCP_TOKEN = 'tk';
  H = frisch('api/mcp.js');
  r = await ruf(H, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'falsch');
  ok('2. Falscher Token: abgewiesen', r.status === 401, JSON.stringify(r.json));
  r = await ruf(H, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null);
  ok('2b. Kein Token: abgewiesen', r.status === 401, JSON.stringify(r.json));

  // ── 2. Der Handschlag ──
  r = await ruf(H, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, 'tk');
  ok('3. initialize antwortet nach JSON-RPC',
    r.json.jsonrpc === '2.0' && r.json.id === 1 && !!r.json.result, JSON.stringify(r.json));
  ok('3b. … mit der vom Client gewuenschten Protokollfassung',
    r.json.result.protocolVersion === '2025-06-18', r.json.result.protocolVersion);
  ok('3c. … und meldet Werkzeuge an', !!(r.json.result.capabilities && r.json.result.capabilities.tools));
  // Eine unbekannte Fassung darf nicht einfach zurueckgespiegelt werden.
  const alt = await ruf(H, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'phantasie' } }, 'tk');
  ok('3d. Eine erfundene Protokollfassung wird nicht uebernommen',
    alt.json.result.protocolVersion !== 'phantasie', alt.json.result.protocolVersion);

  // ── 3. Die Werkzeugliste ist die Zusage ──
  r = await ruf(H, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'tk');
  const namen = (r.json.result.tools || []).map(function (t) { return t.name; });
  ok('4. Es gibt genau die vier Lese-Werkzeuge',
    namen.length === 4 && namen.indexOf('mitglied_suchen') >= 0 && namen.indexOf('mitglied_vertrag') >= 0
    && namen.indexOf('mitglied_vorgaenge') >= 0 && namen.indexOf('vorgang_lesen') >= 0, namen.join(','));
  // Das ist der eigentliche Schutz: was es nicht gibt, kann nicht passieren.
  const gefaehrlich = namen.filter(function (n) { return /anlegen|aendern|loesch|senden|schreib|kuendig|export|alle|liste_alle/i.test(n); });
  ok('4b. Kein einziges schreibendes Werkzeug', gefaehrlich.length === 0, gefaehrlich.join(','));
  const beschreibungen = JSON.stringify(r.json.result.tools);
  ok('4c. Nichts zu Ernaehrung, Vitalwerten, InBody oder Coach',
    !/ernaehrung|ernährung|vital|inbody|coach|training/i.test(beschreibungen), beschreibungen.slice(0, 200));

  // ── 4. Suchen ──
  r = await werkzeug(H, 'mitglied_suchen', { suche: 'Degens' });
  const gefunden = JSON.parse(textVon(r));
  ok('5. Die Namenssuche findet das Mitglied',
    Array.isArray(gefunden) && gefunden[0].name === 'Martha Regine Degens' && gefunden[0].id === '4711', textVon(r));
  ok('5b. … mit Mitgliedsnummer', gefunden[0].mitgliedsnummer === 'M-1234', textVon(r));
  // Datensparsamkeit auch hier: die Trefferliste braucht keine Kontaktdaten.
  ok('5c. … aber ohne E-Mail und Telefon',
    textVon(r).indexOf('example.invalid') < 0 && textVon(r).indexOf('4915100000000') < 0, textVon(r));

  // Ohne Suchbegriff kein Verzeichnis - das ist der Unterschied zwischen
  // "nachschlagen" und "absaugen".
  mlRufe.length = 0;
  r = await werkzeug(H, 'mitglied_suchen', { suche: '' });
  ok('6. Ohne Suchbegriff passiert nichts', /mindestens zwei Zeichen/.test(textVon(r)) && mlRufe.length === 0, textVon(r));
  r = await werkzeug(H, 'mitglied_suchen', { suche: 'a' });
  ok('6b. Ein einzelnes Zeichen reicht auch nicht', /mindestens zwei Zeichen/.test(textVon(r)), textVon(r));

  // ── 5. Vertrag: die eigentliche Frage ──
  r = await werkzeug(H, 'mitglied_vertrag', { id: '4711' });
  const v = JSON.parse(textVon(r));
  ok('7. Der Vertragsstand beantwortet „gekuendigt?"',
    v.gekuendigt === true && v.kuendigungsdatum === '2026-08-20', textVon(r));
  ok('7b. … mit Tarif und Laufzeitende', v.tarif === 'Basis' && v.ende === '2026-12-31', textVon(r));

  // ── 6. Vorgaenge ──
  r = await werkzeug(H, 'mitglied_vorgaenge', { id: '4711' });
  const vg = JSON.parse(textVon(r));
  ok('8. Die Vorgaenge kommen mit Art, Referenz und Datum',
    vg.length === 2 && vg[0].art === 'kuendigung' && vg[0].referenz === '#K-1003' && !!vg[0].angelegt, textVon(r));
  r = await werkzeug(H, 'mitglied_vorgaenge', { id: '4711', art: 'kuendigung' });
  ok('8b. … und lassen sich nach Art filtern', JSON.parse(textVon(r)).length === 1, textVon(r));

  r = await werkzeug(H, 'vorgang_lesen', { id: '4711', vorgangId: '3' });
  ok('9. Ein Vorgang laesst sich im Verlauf lesen',
    /31\.12\.2026/.test(textVon(r)) && /kuendigung/.test(textVon(r)), textVon(r));
  r = await werkzeug(H, 'vorgang_lesen', { id: '4711', vorgangId: '99' });
  ok('9b. Ein fremder Vorgang liefert nichts', /gibt es nicht/.test(textVon(r)), textVon(r));

  // ── 7. Alles andere prallt ab ──
  r = await werkzeug(H, 'mitglied_loeschen', { id: '4711' });
  ok('10. Ein erfundenes Werkzeug wird abgewiesen',
    !!(r.json.error && r.json.error.code === -32602), JSON.stringify(r.json));
  r = await ruf(H, { jsonrpc: '2.0', id: 5, method: 'resources/read', params: {} }, 'tk');
  ok('10b. Nicht unterstuetzte Methoden ebenso',
    !!(r.json.error && r.json.error.code === -32601), JSON.stringify(r.json));

  // Benachrichtigungen brauchen keine Antwort, duerfen aber nicht als Fehler enden.
  r = await ruf(H, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'tk');
  ok('11. Benachrichtigungen werden still bestaetigt', r.status === 202, String(r.status));

  // ── 8. Nachvollziehbarkeit ──
  // Wer nachsehen kann, soll nachvollziehbar nachsehen - aber ohne dass der Name
  // dabei ins Log wandert.
  const zeilen = [];
  const echt = console.log;
  console.log = function () { zeilen.push(Array.prototype.slice.call(arguments).join(' ')); };
  await werkzeug(H, 'mitglied_suchen', { suche: 'Degens' });
  console.log = echt;
  const spur = zeilen.filter(function (z) { return z.indexOf('mcp_zugriff') === 0; })[0] || '';
  ok('12. Jeder Zugriff hinterlaesst eine Spur', /mitglied_suchen/.test(spur), spur);
  ok('12b. … aber ohne den gesuchten Namen', spur.indexOf('Degens') < 0 && spur.indexOf('M-1234') < 0, spur);

  console.log(pass ? 'MCP PASS' : 'MCP FAIL');
  process.exit(pass ? 0 : 1);
}
run();
