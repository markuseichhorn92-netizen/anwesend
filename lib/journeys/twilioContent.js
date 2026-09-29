'use strict';

/**
 * FINN Journeys – Vorlagen bei Twilio anlegen und bei Meta einreichen.
 * -----------------------------------------------------------------------------
 * Twilio Content API (https://content.twilio.com), dieselben Zugangsdaten wie
 * der Versand (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). Die Schlüssel bleiben in
 * Vercel – ausgelöst wird im Team-Backend (Admin), nicht von außen.
 *
 *   POST /v1/Content                                   Vorlage anlegen -> HX…-SID
 *   POST /v1/Content/{sid}/ApprovalRequests/whatsapp   bei Meta einreichen {name, category}
 *   GET  /v1/Content/{sid}/ApprovalRequests            Stand: received|pending|approved|rejected|paused|disabled
 *   GET  /v2/ContentAndApprovals?ContentName=^name$    schon angelegt? (verhindert Doppelte)
 *   GET  /v2/ContentAndApprovals?PageSize=100          alle Vorlagen – für den Abgleich (link)
 *
 * Abgleich (link): Vorlagen, die woanders angelegt wurden (Twilio-Konsole, Chrome),
 * werden über den Namen oder den gleichen Text zugeordnet. Der Abgleich legt NIE
 * etwas an und reicht nichts ein. „Einreichen" erkennt eine vorhandene Fassung am
 * Text-Fingerabdruck (hash), nicht am Namen – eine anders benannte, aber verknüpfte
 * Vorlage wird deshalb nicht doppelt angelegt.
 *
 * Der Name ist Schlüssel + Fingerabdruck des Texts (+ _rN nach einer Ablehnung):
 * Meta ändert freigegebene Vorlagen nicht und vergibt keinen Namen zweimal.
 * Gesendet wird eine eingereichte Vorlage erst mit Status „approved"
 * (templates.sidUsable). Nichts hier schreibt Nachrichten an Personen.
 */

const Templates = require('./templates');

const BASE = 'https://content.twilio.com';
const TIMEOUT_MS = 9000;
const LIVE = ['received', 'pending', 'approved'];
const OPEN = ['received', 'pending'];

// Beispielwerte je Variable – Meta verlangt sie für die Prüfung.
const SAMPLES = {
  'Vorname': 'Lena',
  'Datum': 'Donnerstag, 8. Oktober',
  'Uhrzeit': '18:00',
  'Besuche': '6',
  'Tage': '30',
  'Besuche 4 Wochen': '3',
  'Wochenziel': '2',
  'Anzahl': '50',
  'Wochen': '8',
};

function configured() { return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN); }
function log(o) { try { console.log('[journeys-tpl]', JSON.stringify(o)); } catch (e) {} }

function nameFor(key, rev) {
  const h = Templates.hashOf(key); if (!h) return null;
  return (key + '_' + h + (rev > 0 ? '_r' + rev : '')).toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

// Anfrage an Twilio anlegen (Content-Ressource).
function payload(key, name) {
  const t = Templates.get(key); if (!t) return null;
  const variables = {};
  (t.vars || []).forEach((v, i) => { variables[String(i + 1)] = SAMPLES[v] || 'Beispiel'; });
  const types = { 'twilio/text': { body: t.text } };
  const btn = (t.buttons || []).filter(Boolean);
  if (btn.length) types['twilio/quick-reply'] = { body: t.text, actions: btn.map((b, i) => ({ title: String(b).slice(0, 20), id: key + '_' + (i + 1) })) };
  return { friendly_name: name, language: 'de', variables: variables, types: types };
}

async function tw(method, path, body) {
  const auth = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
  try {
    const headers = { Authorization: 'Basic ' + auth, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const text = await r.text().catch(() => '');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, json: json };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: (e && e.name === 'AbortError') ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

// Fehlermeldung von Twilio für das Team – gekürzt, ohne Zugangsdaten.
function message(r) {
  if (!r) return 'Keine Antwort von Twilio.';
  if (r.error === 'timeout') return 'Twilio hat nicht rechtzeitig geantwortet.';
  if (r.error === 'network') return 'Twilio war nicht erreichbar.';
  if (r.status === 401 || r.status === 403) return 'Twilio lehnt den Zugang ab (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN prüfen).';
  const j = r.json || {};
  const m = String(j.message || j.detail || '').replace(/AC[0-9a-f]{32}/gi, 'AC…').slice(0, 200);
  return (m || ('Twilio-Fehler ' + r.status)) + (j.code ? ' (' + j.code + ')' : '');
}

// Antwort der Freigabe-Abfrage vereinheitlichen.
function parseApproval(a) {
  if (!a) return null;
  let w = null;
  if (Array.isArray(a)) w = a.find((x) => x && (x.type === 'whatsapp' || x.name)) || null;
  else if (a.whatsapp) w = a.whatsapp;
  else if (a.status || a.name) w = a;
  if (!w) return null;
  const st = String(w.status || '').toLowerCase() || null;
  return { status: st, category: w.category ? String(w.category).toUpperCase() : null, reason: w.rejection_reason ? String(w.rejection_reason).slice(0, 300) : null, name: w.name || null };
}

async function findByName(name) {
  const r = await tw('GET', '/v2/ContentAndApprovals?PageSize=20&ContentName=' + encodeURIComponent('^' + name + '$'));
  if (!r.ok || !r.json) return null;
  const list = r.json.contents || r.json.content_and_approvals || [];
  const hit = list.find((c) => c && /^HX[0-9a-f]{32}$/i.test(String(c.sid || '')) && (c.friendly_name === name || ((parseApproval(c.approval_requests) || {}).name === name)));
  if (!hit) return null;
  return { sid: hit.sid, approval: parseApproval(hit.approval_requests) };
}

// Text einer Vorlage aus der Twilio-Antwort (Quick-Reply vor Text).
function bodyOf(types) {
  if (!types) return '';
  const t = types['twilio/quick-reply'] || types['twilio/text'] || types['twilio/call-to-action'] || types['twilio/card'] || null;
  return t && t.body ? String(t.body) : '';
}
function norm(x) { return String(x || '').replace(/\s+/g, ' ').trim(); }

// Alle Vorlagen des Kontos (höchstens maxPages Seiten à 100). null = Abfrage gescheitert.
async function listAll(maxPages) {
  const out = [];
  let path = '/v2/ContentAndApprovals?PageSize=100';
  let complete = true;
  for (let i = 0; path; i++) {
    if (i >= (maxPages || 5)) { complete = false; break; }
    const r = await tw('GET', path);
    if (!r.ok || !r.json) { if (i === 0) return null; complete = false; break; }
    const list = r.json.contents || r.json.content_and_approvals || [];
    list.forEach((c) => {
      if (c && /^HX[0-9a-f]{32}$/i.test(String(c.sid || ''))) out.push({ sid: c.sid, name: String(c.friendly_name || ''), language: c.language || null, body: bodyOf(c.types), approval: parseApproval(c.approval_requests) });
    });
    const next = r.json.meta && r.json.meta.next_page_url ? String(r.json.meta.next_page_url) : '';
    path = next.indexOf(BASE + '/') === 0 ? next.slice(BASE.length) : null;
  }
  out.complete = complete;
  return out;
}

// Bei mehreren Treffern: freigegeben vor in Prüfung vor ohne Einreichung vor abgelehnt.
function pick(list) {
  if (!list.length) return null;
  const rank = (c) => { const st = c.approval && c.approval.status; return st === 'approved' ? 0 : (OPEN.indexOf(st) >= 0 ? 1 : (!st ? 2 : 3)); };
  return list.slice().sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Abgleich: jeder Vorlage ohne SID die passende Twilio-Vorlage zuordnen – erst über
 * den Namen (Schlüssel + Fingerabdruck), sonst über den gleichen Text. Legt nichts
 * an, reicht nichts ein. bodyDiff: per Name gefunden, Text bei Twilio weicht ab.
 * Speichert selbst. Liefert { ok, linked[], missing[], bodyDiff[], complete }.
 */
async function link(opts) {
  opts = opts || {};
  const Config = require('./config');
  if (!configured()) return { ok: false, error: 'no_twilio', message: NO_TWILIO, linked: [], missing: [], bodyDiff: [] };
  const now = opts.now || Date.now();
  const cfg = await Config.load(true);
  const want = Templates.keys().filter((k) => { const c = cfg.templates[k] || {}; return !c.sid && !c.meta; });
  if (!want.length) return { ok: true, linked: [], missing: [], bodyDiff: [], complete: true };
  const all = await listAll(opts.maxPages);
  if (!all) return { ok: false, error: 'list_failed', message: 'Die Vorlagenliste von Twilio war nicht abrufbar.', linked: [], missing: want, bodyDiff: [] };
  const used = new Set(Object.keys(cfg.templates).map((k) => cfg.templates[k] && cfg.templates[k].sid).filter(Boolean));
  const patch = {}; const linked = [], missing = [], diff = [];
  for (const k of want) {
    const t = Templates.get(k); const exp = nameFor(k, 0); const text = norm(t.text);
    const free = all.filter((c) => !used.has(c.sid));
    let hit = pick(free.filter((c) => c.name === exp || (c.approval && c.approval.name === exp)));
    const byName = !!hit;
    if (!hit) hit = pick(free.filter((c) => norm(c.body) === text && (!c.language || /^de/i.test(c.language))));
    if (!hit) { missing.push(k); continue; }
    used.add(hit.sid);
    const a = hit.approval || {};
    const bodyDiff = byName && norm(hit.body) !== text;
    patch[k] = { sid: hit.sid, name: String(a.name || hit.name || exp).slice(0, 512), hash: Templates.hashOf(k), rev: 0, auto: true, linked: true, lang: 'de', meta: null,
      status: a.status || 'unsubmitted', reason: a.reason || null, metaCategory: a.category || null, bodyDiff: bodyDiff || undefined,
      createdAt: now, submittedAt: null, checkedAt: now };
    linked.push(k); if (bodyDiff) diff.push(k);
  }
  if (Object.keys(patch).length) await Config.save({ templates: patch }, opts.who || 'twilio');
  log({ ev: 'link', linked: linked.length, missing: missing.length, diff: diff.length });
  return { ok: true, linked: linked, missing: missing, bodyDiff: diff, complete: all.complete !== false };
}

/**
 * Eine Vorlage anlegen (falls nötig) und bei Meta einreichen.
 * cur = bisheriger Eintrag aus jr:cfg.templates[key].
 * Liefert { ok, entry?, skipped?, error?, message?, problems? } – entry wird vom
 * Aufrufer gespeichert, auch bei einem Fehler nach dem Anlegen (sonst entstünde
 * beim nächsten Versuch eine zweite Vorlage).
 */
async function submit(key, cur, now) {
  now = now || Date.now();
  const t = Templates.get(key);
  if (!t) return { ok: false, error: 'bad_key' };
  if (!configured()) return { ok: false, error: 'no_twilio', message: 'Twilio-Zugang fehlt in Vercel (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).' };
  const problems = Templates.lint(key);
  if (problems.length) return { ok: false, error: 'lint', problems: problems, message: 'Text verstößt gegen Metas Regeln: ' + problems.join(', ') };
  cur = cur || {};
  const rev = cur.auto ? (cur.rev || 0) : 0;
  // Diese Fassung liegt schon bei Twilio (eingereicht hier oder verknüpft)? Erkannt
  // am Text-Fingerabdruck – eine anders benannte, verknüpfte Vorlage zählt mit.
  const same = !!(cur.auto && cur.sid && cur.hash === Templates.hashOf(key));
  const name = (same && /^[a-z0-9_]{1,512}$/.test(String(cur.name || ''))) ? cur.name : nameFor(key, rev);
  if (same && LIVE.indexOf(cur.status) >= 0) return { ok: true, skipped: true, entry: cur };
  if (same && cur.status && LIVE.indexOf(cur.status) < 0 && cur.status !== 'created' && cur.status !== 'unsubmitted') {
    return { ok: false, error: 'not_resubmittable', entry: cur, message: 'Diese Fassung wurde schon geprüft (' + cur.status + '). „Neu einreichen" legt eine neue Fassung an.' };
  }

  let sid = same ? cur.sid : null;
  let appr = null;
  if (!sid) { const f = await findByName(name); if (f) { sid = f.sid; appr = f.approval; } }
  if (!sid) {
    const r = await tw('POST', '/v1/Content', payload(key, name));
    if (!r.ok || !r.json || !/^HX[0-9a-f]{32}$/i.test(String(r.json.sid || ''))) {
      log({ ev: 'create_failed', key: key, st: r.status });
      return { ok: false, error: 'create_failed', message: message(r) };
    }
    sid = r.json.sid;
  }
  const entry = { sid: sid, name: name, hash: Templates.hashOf(key), rev: rev, auto: true, linked: same ? cur.linked : undefined, lang: 'de', meta: null,
    status: 'created', reason: null, metaCategory: null, createdAt: cur.createdAt && cur.sid === sid ? cur.createdAt : now, submittedAt: null, checkedAt: now };

  if (!appr || !appr.status || appr.status === 'unsubmitted') {
    const r = await tw('POST', '/v1/Content/' + sid + '/ApprovalRequests/whatsapp', { name: name, category: t.category });
    if (!r.ok) {
      log({ ev: 'submit_failed', key: key, st: r.status });
      return { ok: false, error: 'submit_failed', entry: entry, message: message(r) };
    }
    appr = parseApproval(r.json) || { status: 'received' };
  }
  entry.status = appr.status || 'received';
  entry.metaCategory = appr.category || null;
  entry.reason = appr.reason || null;
  entry.submittedAt = now;
  log({ ev: 'submitted', key: key, status: entry.status });
  return { ok: true, entry: entry };
}

// Stand der Freigabe nachlesen. Liefert den aktualisierten Eintrag (oder null).
async function refresh(entry, now) {
  if (!entry || !entry.sid || !configured()) return null;
  const r = await tw('GET', '/v1/Content/' + entry.sid + '/ApprovalRequests');
  if (r.status === 404) return Object.assign({}, entry, { status: 'deleted', checkedAt: now || Date.now() });
  if (!r.ok) return null;
  const a = parseApproval(r.json);
  if (!a || !a.status) return Object.assign({}, entry, { status: 'unsubmitted', checkedAt: now || Date.now() });
  return Object.assign({}, entry, { status: a.status, metaCategory: a.category || entry.metaCategory || null, reason: a.reason || null, checkedAt: now || Date.now() });
}

/**
 * Freigaben abgleichen. only='open' prüft nur eingereichte, noch nicht entschiedene
 * Vorlagen (für den Durchlauf), sonst alle mit SID. Speichert selbst.
 */
async function sync(opts) {
  opts = opts || {};
  const Config = require('./config');
  if (!configured()) return { ok: false, error: 'no_twilio' };
  const now = opts.now || Date.now();
  const deadline = Date.now() + (opts.budgetMs || 8000);
  // Zuerst Vorlagen ohne SID zuordnen (legt nichts an); frisch verknüpfte sind aktuell.
  const lk = await link({ now: now, who: opts.who });
  const fresh = new Set(lk.linked || []);
  const cfg = await Config.load(true);
  const patch = {}; let checked = 0, changed = 0;
  for (const key of Templates.keys()) {
    const c = cfg.templates[key];
    if (!c || !c.sid || fresh.has(key)) continue;
    if (opts.only === 'open' && OPEN.indexOf(c.status) < 0) continue;
    if (Date.now() > deadline) break;
    const n = await refresh(c, now);
    checked++;
    if (n && (n.status !== c.status || n.reason !== c.reason || n.metaCategory !== c.metaCategory)) { patch[key] = n; changed++; }
    else if (n) patch[key] = Object.assign({}, c, { checkedAt: now });
  }
  if (Object.keys(patch).length) await Config.save({ templates: patch }, opts.who || 'twilio');
  await require('../finn/kv').set('jr:tplsync', String(now), 7 * 86400);
  if (changed) log({ ev: 'sync', checked: checked, changed: changed });
  const after = (await Config.load(true)).templates;
  return { ok: true, checked: checked, changed: changed, linked: lk.linked || [], missing: lk.missing || [], bodyDiff: lk.bodyDiff || [],
    linkError: lk.ok ? undefined : (lk.message || lk.error), approved: Templates.keys().filter((k) => after[k] && after[k].status === 'approved').length };
}

// Für den Durchlauf (alle 20 Minuten) und die Admin-Seite (kürzer): nur solange
// etwas in Prüfung ist.
async function syncIfDue(now, budgetMs, minGapMs) {
  if (!configured()) return null;
  const Config = require('./config');
  const cfg = await Config.load();
  const open = Templates.keys().some((k) => cfg.templates[k] && cfg.templates[k].sid && OPEN.indexOf(cfg.templates[k].status) >= 0);
  const unlinked = Templates.keys().some((k) => { const c = cfg.templates[k] || {}; return !c.sid && !c.meta; });
  if (!open && !unlinked) return null;
  const last = parseInt((await require('../finn/kv').get('jr:tplsync')) || '0', 10) || 0;
  if ((now || Date.now()) - last < (minGapMs || 20 * 60000)) return null;
  return sync({ only: 'open', now: now, budgetMs: budgetMs || 6000 });
}

// Eine alte Fassung löschen (nach Ablehnung). Meta wertet sonst die neue Fassung
// als Doppel einer bestehenden Vorlage. Der alte Name bleibt 30 Tage gesperrt –
// die neue Fassung hat ohnehin einen eigenen (_rN).
async function remove(sid) {
  if (!configured() || !/^HX[0-9a-f]{32}$/i.test(String(sid || ''))) return false;
  const r = await tw('DELETE', '/v1/Content/' + sid);
  return r.ok || r.status === 404;
}

// Welche Vorlagen würde „Alle einreichen" anfassen? Nicht: von Hand zugeordnete,
// schon eingereichte/freigegebene gleiche Fassung, Texte mit Regelverstoß.
function pending(cfgTemplates) {
  cfgTemplates = cfgTemplates || {};
  return Templates.keys().filter((k) => {
    const c = cfgTemplates[k] || {};
    if (c.meta || (c.sid && !c.auto)) return false;
    if (Templates.lint(k).length) return false;
    if (!c.auto || !c.sid) return true;
    if (c.hash !== Templates.hashOf(k)) return true;             // Text geändert
    return c.status === 'created' || c.status === 'unsubmitted';  // angelegt, aber nicht eingereicht
  });
}

const NO_TWILIO = 'Twilio-Zugang fehlt in Vercel (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).';

/**
 * Mehrere Vorlagen einreichen (ohne keys: alle offenen), in Portionen: reicht die
 * Zeit nicht, stehen die übrigen in remaining. Von Hand zugeordnete bleiben
 * unangetastet. Speichert jeden Eintrag sofort. Genutzt vom Team-Backend und vom
 * Workflow (api/journeys-tick?templates=submit).
 */
async function submitMany(opts) {
  opts = opts || {};
  const Config = require('./config');
  if (!configured()) return { ok: false, error: 'no_twilio', message: NO_TWILIO, results: [], remaining: [], submitted: 0 };
  const cfg = await Config.load(true);
  const keys = (opts.keys && opts.keys.length ? opts.keys.filter((k) => Templates.get(k)) : pending(cfg.templates)).slice();
  const deadline = Date.now() + (opts.budgetMs || 40000);
  const results = [];
  const remaining = keys.slice();
  while (remaining.length && Date.now() < deadline) {
    const key = remaining.shift();
    const cur = (await Config.load(true)).templates[key] || {};
    if (cur.meta || (cur.sid && !cur.auto)) { results.push({ key: key, ok: false, error: 'manual', message: 'Von Hand zugeordnet – nicht angefasst.' }); continue; }
    const r = await submit(key, cur);
    if (r.entry) await Config.save({ templates: { [key]: r.entry } }, opts.who || 'twilio');
    results.push({ key: key, ok: !!r.ok, skipped: !!r.skipped, status: r.entry ? r.entry.status : null, error: r.error || null, message: r.message || null });
  }
  const failed = results.filter((x) => !x.ok && x.error !== 'manual');
  return { ok: !failed.length, results: results, remaining: remaining, submitted: results.filter((x) => x.ok && !x.skipped).length,
    message: failed.length ? (failed.length + ' Vorlage(n) nicht eingereicht: ' + failed.map((x) => x.key + ' – ' + (x.message || x.error)).join(' · ')).slice(0, 600) : undefined };
}

// Stand aller Vorlagen ohne Personenbezug (für den Workflow-Bericht).
function summary(cfgTemplates) {
  return Templates.catalog(cfgTemplates).map((t) => ({ key: t.key, status: t.status || (t.meta || t.sid ? 'von_hand' : 'offen'),
    grund: t.reason || undefined, metaKategorie: t.metaCategory && t.metaCategory !== t.category ? t.metaCategory : undefined,
    veraltet: t.outdated || undefined, textAbweichung: t.bodyDiff || undefined, regelverstoss: t.problems.length ? t.problems : undefined }));
}

module.exports = { configured, nameFor, payload, parseApproval, listAll, link, submit, submitMany, refresh, sync, syncIfDue, remove, pending, summary, NO_TWILIO, SAMPLES, LIVE, OPEN };
