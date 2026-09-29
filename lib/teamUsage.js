'use strict';

/**
 * Team-Backend: „Zuletzt benutzt" – wann hat das Team welchen Bereich zuletzt benutzt?
 * -----------------------------------------------------------------------------
 * Liest NUR vorhandene Zeitstempel (nichts wird zusätzlich gespeichert, kein Zähler je
 * Seite), günstig: einzelne Schlüssel, Indizes, gedeckelte Listen – keine Voll-Scans.
 * Grundlage für Entscheidungen „brauchen wir das noch?" (Entrümpeln 29.09.2026).
 *
 *   lastUsed({ cases, articles })  -> { rows:[{ key, label, at, n30, who, note }], ohne:[…] }
 *   altdaten({ step, cursor })     -> Altdaten entfernter Funktionen zählen bzw. löschen
 *
 * Nur für Admins (api/team/stats.js). Keine Inhalte, nur Zeitpunkte, Anzahlen und – wo
 * gespeichert – der Name der Person aus dem Team.
 */

const { redisPipeline, hasStore } = require('./store');

const DAY = 86400000;
// Bots und Automatik zählen nicht als Nutzung durch das Team.
const BOT_AUTHORS = { 'FINN': 1, 'FINN · Journey': 1, 'Auto-Pilot': 1, 'System': 1, 'FINN (Entwurf)': 1 };

function ts(v) { if (v == null) return null; if (typeof v === 'number') return isFinite(v) ? v : null; const t = Date.parse(v); return isFinite(t) ? t : null; }
function parse(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return null; } }
async function pipe(cmds) { if (!hasStore || !cmds.length) return cmds.map(() => null); try { return await redisPipeline(cmds); } catch (e) { return cmds.map(() => null); } }

function row(key, label, list, opts) {
  opts = opts || {};
  const now = Date.now();
  const items = (list || []).filter((x) => x && x.at);
  items.sort((a, b) => b.at - a.at);
  const last = items[0] || null;
  return { key: key, label: label, at: last ? last.at : null, who: last && last.who ? String(last.who).slice(0, 40) : null,
    n30: opts.noCount ? null : items.filter((x) => now - x.at <= 30 * DAY).length, note: opts.note || null };
}

async function lastUsed(o) {
  o = o || {};
  const cases = Array.isArray(o.cases) ? o.cases : [];
  const rows = [];

  // Posteingang: Team-Antworten und -Notizen (ohne Bots/Automatik) aus der schon geladenen Liste.
  const inbox = [];
  cases.forEach((v) => {
    (v.messages || []).forEach((m) => { if (m && m.from === 'team' && m.author && !BOT_AUTHORS[m.author] && m.at) inbox.push({ at: m.at, who: m.author }); });
    (v.notes || []).forEach((n) => { if (n && n.author && !BOT_AUTHORS[n.author] && n.at) inbox.push({ at: n.at, who: n.author }); });
  });
  rows.push(row('inbox', 'Posteingang (Antworten & Notizen)', inbox));

  const month = (d) => d.toISOString().slice(0, 7);
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const [kbA, kbB, wbFrame, wbLast, jrCfg, testers, snipIds, fbIds, pushToks, shopIds] = await pipe([
    ['GET', 'kb:m:' + month(now)], ['GET', 'kb:m:' + month(prev)],
    ['GET', 'wb:frame'], ['ZREVRANGE', 'wb:offer:idx', '0', '199'],
    ['GET', 'jr:cfg'], ['HGETALL', 'tester:info'],
    ['SMEMBERS', 'snip:idx'], ['SMEMBERS', 'fb:index'], ['SMEMBERS', 'push:team:tokens'],
    ['LRANGE', 'shl:all', '0', '49'],
  ]);

  // Kassenbuch: letzte Bearbeitung / Abschluss dieses und des Vormonats.
  const kb = [];
  [kbA, kbB].map(parse).forEach((m) => { if (!m) return; if (ts(m.updatedAt)) kb.push({ at: ts(m.updatedAt) }); if (ts(m.closedAt)) kb.push({ at: ts(m.closedAt), who: m.closedBy }); });
  rows.push(row('kassenbuch', 'Kassenbuch', kb, { noCount: true }));

  // Rückholung: Angebote (Index nach Erstellzeit) + Rahmen.
  const wb = [];
  const fr = parse(wbFrame); if (fr && ts(fr.updatedAt)) wb.push({ at: ts(fr.updatedAt), who: fr.updatedBy });
  const offerIds = Array.isArray(wbLast) ? wbLast : [];
  if (offerIds.length) {
    const scores = await pipe(offerIds.map((id) => ['ZSCORE', 'wb:offer:idx', id]));
    scores.forEach((sc) => { const t = Number(sc); if (isFinite(t) && t > 0) wb.push({ at: t }); });
  }
  rows.push(row('wb', 'Rückholung (Angebote)', wb));

  // Hilfe-Artikel: zuletzt bearbeitet (schon geladen).
  rows.push(row('help', 'Hilfe-Artikel (bearbeitet)', (o.articles || []).map((a) => ({ at: ts(a.updatedAt) }))));

  // App-Feedback: als erledigt markiert.
  const fbList = Array.isArray(fbIds) ? fbIds.slice(0, 500) : [];
  const fbItems = fbList.length ? await pipe(fbList.map((id) => ['GET', 'fb:item:' + id])) : [];
  rows.push(row('feedback', 'App-Feedback (erledigt)', fbItems.map(parse).filter(Boolean).map((f) => ({ at: ts(f.doneAt) }))));

  // App-Tester: freigeschaltet.
  const tst = [];
  if (Array.isArray(testers)) for (let i = 0; i + 1 < testers.length; i += 2) { const v = parse(testers[i + 1]); if (v && ts(v.approvedAt)) tst.push({ at: ts(v.approvedAt) }); }
  rows.push(row('tester', 'App-Tester (freigeschaltet)', tst));

  // Textbausteine: angelegt/geändert.
  const snips = Array.isArray(snipIds) && snipIds.length ? await pipe(snipIds.slice(0, 200).map((id) => ['GET', 'snip:' + id])) : [];
  rows.push(row('snippets', 'Textbausteine (geändert)', snips.map(parse).filter(Boolean).map((x) => ({ at: ts(x.updatedAt) || ts(x.createdAt) })), { note: 'Vorlagen beim ersten Start zählen mit' }));

  // WhatsApp-Journeys: Einstellungen + Testversand.
  const jr = [];
  const cfg = parse(jrCfg); if (cfg && ts(cfg.updatedAt)) jr.push({ at: ts(cfg.updatedAt), who: cfg.updatedBy });
  try { const log = await require('./finn/kv').lrangeJSON('jr:log', 0, 499); (log || []).forEach((e) => { if (e && e.kind === 'test' && e.at) jr.push({ at: e.at }); }); } catch (e) {}
  rows.push(row('journeys', 'WhatsApp-Journeys (Einstellungen, Test)', jr));

  // FINN & Magicline: Aktionen aus dem Team (Prüfpfad).
  const finn = [];
  try { const aud = await require('./finn/kv').lrangeJSON('finnaud:all', 0, 499); (aud || []).forEach((a) => { if (a && a.actorKind === 'team' && a.at) finn.push({ at: ts(a.at), who: a.actorId }); }); } catch (e) {}
  rows.push(row('finn', 'FINN & Magicline (Team-Aktionen)', finn));

  // Bestellungen: Bearbeitung durch das Team (Verlauf „von" ≠ shop).
  const shop = [];
  const extIds = Array.isArray(shopIds) ? shopIds : [];
  const orders = extIds.length ? await pipe(extIds.map((e) => ['GET', 'shl:o:' + e])) : [];
  orders.map(parse).filter(Boolean).forEach((b) => { (b.verlauf || []).forEach((h) => { if (h && h.von && h.von !== 'shop' && ts(h.am)) shop.push({ at: ts(h.am), who: h.von }); }); });
  rows.push(row('shoporders', 'Bestellungen (vom Team bearbeitet)', shop));

  // Leads: letzte Änderung – enthält auch automatische Änderungen.
  try {
    const leads = await require('./leadflow').listLeads({ limit: 200 });
    rows.push(row('leads', 'Leads (letzte Änderung)', (leads || []).map((l) => ({ at: ts(l.updatedAt) })), { note: 'auch automatische Änderungen' }));
  } catch (e) {}

  // Team-App: zuletzt geöffnet (Push-Anmeldung der Team-App, je Person).
  const toks = Array.isArray(pushToks) ? pushToks.slice(0, 100) : [];
  const metas = toks.length ? await pipe(toks.map((t) => ['GET', 'push:team:meta:' + t])) : [];
  rows.push(row('teamapp', 'Team-App geöffnet', metas.map(parse).filter(Boolean).map((m) => ({ at: ts(m.at), who: m.who })), { note: 'nur die Handy-App, nicht der Browser' }));

  return {
    rows: rows,
    ohne: ['Termine', 'Probetraining (Team)', 'Nachrichten/Rundnachricht', 'Community', 'Tags', 'Neue Mitglieder', 'Profil-Aktionen'],
  };
}

// ── Altdaten entfernter Funktionen (Schichtplan, Aufgaben, Ernährungs-Auswertung) ──
const ALT = [
  { key: 'todo', label: 'Aufgaben', prefix: 'todo:' },
  { key: 'shf', label: 'Schichtplan (Schichten, Verfügbarkeit, Urlaub, Team-Chat)', prefix: 'shf:' },
  { key: 'nutri_usage', label: 'Ernährungs-Auswertung', prefix: 'nutri:usage:' },
];
const MAX_SCAN = 40;   // SCAN-Runden je Aufruf (fortsetzbar über cursor)

/**
 * step 'count': zählt je Gruppe; step 'delete': löscht. Fortsetzbar: fertig:false + cursor
 * heißt „nochmal mit diesem cursor aufrufen". Zählt/löscht nur Schlüssel mit den festen
 * Präfixen oben – nie etwas anderes.
 */
async function altdaten(opts) {
  opts = opts || {};
  const del = opts.step === 'delete';
  let cursor = String(opts.cursor || '0');
  const found = {}; ALT.forEach((a) => { found[a.key] = 0; });
  let deleted = 0, rounds = 0;
  if (!hasStore) return { ok: false, error: 'no_store' };
  do {
    let res = null;
    try { [res] = await redisPipeline([['SCAN', cursor, 'COUNT', '500']]); } catch (e) { return { ok: false, error: 'scan_failed' }; }
    cursor = String((res && res[0]) || '0');
    const keys = (res && Array.isArray(res[1])) ? res[1] : [];
    const hit = [];
    keys.forEach((k) => { const a = ALT.find((x) => String(k).indexOf(x.prefix) === 0); if (a) { found[a.key]++; hit.push(String(k)); } });
    if (del && hit.length) { try { await redisPipeline(hit.map((k) => ['DEL', k])); deleted += hit.length; } catch (e) { return { ok: false, error: 'delete_failed' }; } }
    rounds++;
  } while (cursor !== '0' && rounds < MAX_SCAN);
  return { ok: true, step: del ? 'delete' : 'count', fertig: cursor === '0', cursor: cursor === '0' ? null : cursor,
    gruppen: ALT.map((a) => ({ key: a.key, label: a.label, anzahl: found[a.key] })), geloescht: deleted };
}

module.exports = { lastUsed, altdaten, ALT, BOT_AUTHORS };
