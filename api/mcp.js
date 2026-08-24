'use strict';

/**
 * MCP-Server (Streamable HTTP) · POST /api/mcp
 * -----------------------------------------------------------------------------
 * Damit eine Claude-Code-Sitzung Support-Fragen selbst nachschlagen kann
 * ("hat X gekuendigt, und ist der Vorgang durchgelaufen?"), statt sie
 * durchzureichen und auf eine Antwort zu warten.
 *
 * DIE ENTSCHEIDENDE EINSCHRAENKUNG: das ist ein LESE-Zugang fuer den Support,
 * kein zweites Team-Backend. Was hier NICHT geht und auch nicht dazukommen
 * soll, ohne dass jemand bewusst darueber entscheidet:
 *
 *   - Schreiben. Kein Kuendigen, kein Aendern, kein Senden. Nur Lesen.
 *   - Gesundheitsdaten. Ernaehrung, Vitalwerte, InBody, Coach-Verlaeufe,
 *     Trainingsplaene bleiben aussen vor. Das sind Daten nach Art. 9 DSGVO und
 *     haben in einer Fehlersuche nichts verloren.
 *   - Verzeichnisse. Es gibt keine "alle Mitglieder"-Abfrage; gesucht wird
 *     gezielt, und es kommen hoechstens 10 Treffer zurueck.
 *
 * Der Zugang haengt an einem EIGENEN Token (MCP_TOKEN), nicht am Team-Passwort:
 * er laesst sich einzeln zurueckziehen, ohne dass das Team ausgesperrt wird.
 * Ohne Token ist der Endpunkt komplett aus (503).
 *
 * Jeder Zugriff hinterlaesst eine Zeile im Log - Werkzeug und Trefferzahl,
 * keine Namen. Wer nachsehen kann, soll nachvollziehbar nachsehen.
 *
 * Einrichten:
 *   claude mcp add --transport http fitinn https://mitglieder.fit-inn-trier.de/api/mcp \
 *     --header "Authorization: Bearer <MCP_TOKEN>"
 */

const crypto = require('node:crypto');
const M = require('../lib/members');
const Inbox = require('../lib/inbox');
const { hasStore } = require('../lib/store');

const TOKENS = String(process.env.MCP_TOKEN || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const hasMcp = TOKENS.length > 0;
const NAME = 'fitinn-support';
const VERSION = '1.0.0';
const PROTOKOLLE = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TREFFER = 10;

function gleich(a, b) {
  try {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch (e) { return false; }
}
function tokenOk(req) {
  const h = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  return !!h && TOKENS.some(function (t) { return gleich(h, t); });
}
// Nur was, nicht wer: die Zeile soll belegen, DASS nachgesehen wurde.
function pruefspur(werkzeug, treffer) {
  try { console.log('mcp_zugriff', JSON.stringify({ tool: String(werkzeug), treffer: Number(treffer) || 0 })); } catch (e) {}
}

// ── Werkzeuge ───────────────────────────────────────────────────────────────
const WERKZEUGE = [
  {
    name: 'mitglied_suchen',
    description: 'Sucht ein Mitglied über Name, E-Mail oder Mitgliedsnummer. Liefert höchstens 10 Treffer mit Name, Mitgliedsnummer und interner ID. Die ID wird für die anderen Werkzeuge gebraucht. Kein vollständiges Verzeichnis – ohne Suchbegriff kommt nichts.',
    inputSchema: { type: 'object', properties: { suche: { type: 'string', description: 'Name, E-Mail oder Mitgliedsnummer' } }, required: ['suche'] },
  },
  {
    name: 'mitglied_vertrag',
    description: 'Vertragsstand eines Mitglieds: Tarif, Beginn, Laufzeit, Status, Kündigungsdatum und nächstmöglicher Kündigungstermin. Beantwortet die Frage „hat die Person gekündigt und zu wann".',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Interne Mitglieds-ID aus mitglied_suchen' } }, required: ['id'] },
  },
  {
    name: 'mitglied_vorgaenge',
    description: 'Vorgänge eines Mitglieds (Kündigung, Widerruf, Pause, Anfragen): Art, Betreff, Status, Datum, Referenz. Zeigt, ob eine Kündigung über die App eingegangen ist.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, art: { type: 'string', description: 'optional filtern, z. B. kuendigung, widerruf, pause' } }, required: ['id'] },
  },
  {
    name: 'vorgang_lesen',
    description: 'Der Verlauf EINES Vorgangs: die Nachrichten mit Zeitpunkt und Absender. Für die Frage „was genau ist da passiert".',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, vorgangId: { type: 'string' } }, required: ['id', 'vorgangId'] },
  },
];

function text(s) { return { content: [{ type: 'text', text: String(s) }] }; }
function daten(o) { return { content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] }; }

function kurzVertrag(c) {
  if (!c) return null;
  return {
    tarif: c.rateName || null,
    status: c.contractStatus || null,
    beginn: c.startDate || null,
    ende: c.endDate || null,
    gekuendigt: !!(c.cancellationDate || c.canceledAt || c.endDate),
    kuendigungsdatum: c.cancellationDate || c.canceledAt || null,
    naechsteKuendigung: c.nextCancellationDateISO || c.nextCancellationDate || null,
    vertragId: c.contractId || null,
  };
}

async function ausfuehren(werkzeug, args) {
  args = args || {};
  if (werkzeug === 'mitglied_suchen') {
    const q = String(args.suche || '').trim();
    if (q.length < 2) return text('Bitte einen Suchbegriff mit mindestens zwei Zeichen angeben.');
    // Dieselbe Suche wie im Team-Backend: E-Mail, Nummer oder Name.
    let treffer = [];
    try {
      if (q.indexOf('@') >= 0) {
        const r = await M.ml('POST', '/customers/search', { email: q });
        treffer = Array.isArray(r.json) ? r.json : [];
      } else if (/^[0-9]{3,}$/.test(q)) {
        const r = await M.ml('GET', '/customers/by?customerNumber=' + encodeURIComponent(q));
        treffer = (r.status === 200 && r.json) ? [r.json] : [];
      } else {
        const teile = q.split(/\s+/).filter(Boolean);
        const body = teile.length >= 2 ? { firstName: teile[0], lastName: teile.slice(1).join(' ') } : { lastName: teile[0] };
        let r = await M.ml('POST', '/customers/search', body);
        treffer = Array.isArray(r.json) ? r.json : [];
        if (!treffer.length && teile.length === 1) {
          r = await M.ml('POST', '/customers/search', { firstName: teile[0] });
          treffer = Array.isArray(r.json) ? r.json : [];
        }
      }
    } catch (e) { return text('Die Suche ist gerade nicht erreichbar.'); }
    pruefspur(werkzeug, treffer.length);
    if (!treffer.length) return text('Kein Treffer zu „' + q + '".');
    return daten(treffer.slice(0, MAX_TREFFER).map(function (c) {
      return {
        id: String(c.id != null ? c.id : c.customerId),
        name: ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || 'Mitglied',
        mitgliedsnummer: c.customerNumber || null,
      };
    }));
  }

  if (werkzeug === 'mitglied_vertrag') {
    const id = String(args.id || '').trim();
    if (!id) return text('Bitte die Mitglieds-ID angeben.');
    let c = null;
    try { c = await M.getContract(id); } catch (e) { c = null; }
    pruefspur(werkzeug, c ? 1 : 0);
    if (!c) return text('Zu dieser ID ist kein Vertrag auffindbar.');
    return daten(kurzVertrag(c));
  }

  if (werkzeug === 'mitglied_vorgaenge') {
    const id = String(args.id || '').trim();
    if (!id) return text('Bitte die Mitglieds-ID angeben.');
    if (!Inbox.hasStore) return text('Der Vorgangs-Speicher ist nicht erreichbar.');
    let list = [];
    try { list = await Inbox.list(id); } catch (e) { list = []; }
    const art = String(args.art || '').trim().toLowerCase();
    if (art) list = list.filter(function (v) { return String(v.type || '').toLowerCase() === art; });
    pruefspur(werkzeug, list.length);
    if (!list.length) return text(art ? ('Keine Vorgänge der Art „' + art + '".') : 'Keine Vorgänge zu dieser ID.');
    return daten(list.slice(0, 30).map(function (v) {
      return { vorgangId: v.id, art: v.type, betreff: v.subject, status: v.status, teamStatus: v.teamStatus,
        referenz: v.ref, angelegt: v.createdAt ? new Date(v.createdAt).toISOString() : null, nachrichten: (v.messages || []).length };
    }));
  }

  if (werkzeug === 'vorgang_lesen') {
    const id = String(args.id || '').trim(), vid = String(args.vorgangId || '').trim();
    if (!id || !vid) return text('Bitte Mitglieds-ID und Vorgangs-ID angeben.');
    if (!Inbox.hasStore) return text('Der Vorgangs-Speicher ist nicht erreichbar.');
    let v = null;
    try { v = await Inbox.get(id, vid); } catch (e) { v = null; }
    pruefspur(werkzeug, v ? 1 : 0);
    if (!v) return text('Diesen Vorgang gibt es nicht.');
    return daten({
      vorgangId: v.id, art: v.type, betreff: v.subject, status: v.status, referenz: v.ref,
      verlauf: (v.messages || []).slice(0, 40).map(function (m) {
        return { von: m.from, am: m.at ? new Date(m.at).toISOString() : null, text: String(m.text || '').slice(0, 1500) };
      }),
    });
  }

  return text('Unbekanntes Werkzeug.');
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────
function antwort(res, obj) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}
function fehler(res, id, code, nachricht) {
  return antwort(res, { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: nachricht } });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!hasMcp) { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'not_configured' })); }
  // Kein SSE-Kanal: dieser Server hat keinen Zustand und schickt nichts von sich aus.
  if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!tokenOk(req)) { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'unauthorized' })); }

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const id = body && body.id;
  const methode = String((body && body.method) || '');

  // Benachrichtigungen (ohne id) werden bestaetigt, aber nicht beantwortet.
  if (!methode) return fehler(res, id, -32600, 'Kein method-Feld.');
  if (methode.indexOf('notifications/') === 0) { res.statusCode = 202; return res.end(''); }

  if (methode === 'initialize') {
    const gewuenscht = String((body.params && body.params.protocolVersion) || '');
    return antwort(res, { jsonrpc: '2.0', id: id, result: {
      protocolVersion: PROTOKOLLE.indexOf(gewuenscht) >= 0 ? gewuenscht : PROTOKOLLE[0],
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
      instructions: 'Lese-Zugang für Support-Fragen zu Mitgliedern (Vertrag, Vorgänge). Keine Gesundheitsdaten, keine Schreibvorgänge, kein vollständiges Verzeichnis. Jeder Zugriff wird protokolliert.',
    } });
  }

  if (methode === 'tools/list') {
    return antwort(res, { jsonrpc: '2.0', id: id, result: { tools: WERKZEUGE } });
  }

  if (methode === 'tools/call') {
    const p = body.params || {};
    const name = String(p.name || '');
    if (!WERKZEUGE.some(function (w) { return w.name === name; })) return fehler(res, id, -32602, 'Unbekanntes Werkzeug: ' + name);
    if (!hasStore && (name === 'mitglied_vorgaenge' || name === 'vorgang_lesen')) {
      return antwort(res, { jsonrpc: '2.0', id: id, result: text('Der Speicher ist nicht erreichbar.') });
    }
    // Auch mit gueltigem Token begrenzt - ein Zugang ist kein Freibrief zum Absaugen.
    if (hasStore) {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      if (!(await M.rateLimit('mcp:' + ip, 120, 3600))) {
        return antwort(res, { jsonrpc: '2.0', id: id, result: text('Zu viele Abfragen. Bitte später erneut.') });
      }
    }
    let r;
    try { r = await ausfuehren(name, p.arguments); }
    catch (e) { r = { content: [{ type: 'text', text: 'Die Abfrage ist fehlgeschlagen.' }], isError: true }; }
    return antwort(res, { jsonrpc: '2.0', id: id, result: r });
  }

  if (methode === 'ping') return antwort(res, { jsonrpc: '2.0', id: id, result: {} });

  return fehler(res, id, -32601, 'Methode nicht unterstützt: ' + methode);
};
