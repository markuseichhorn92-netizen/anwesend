'use strict';

/**
 * Magicline-Termine per ROLLIERENDER ABFRAGE in den Termin-Feed (lib/mlEvents) holen.
 * -----------------------------------------------------------------------------
 * Hintergrund (21.10.2026): Die Magicline-Webhooks liefern nicht, und die Open API hat keinen
 * studioweiten Terminabruf. Buchungen gibt es nur je Kunde (GET /appointments/booking?customerId=,
 * Fenster ≈ ±2 Wochen). Probetrainings hängen an Interessenten (customerStatus=PROSPECT).
 *
 * Ablauf – angestoßen vom Feed-Aufruf (Familien-Hub alle 15 Min.), kein eigener Cron:
 *   1. Kundenliste: alle MEMBER + FORMER_MEMBER + PROSPECT mit createdDateTime der letzten
 *      ML_POLL_PROSPECT_DAYS (Standard 60) Tage. Wird höchstens 1× je Stunde neu geladen (KV),
 *      seitenweise und notfalls über mehrere Aufrufe verteilt.
 *   2. Je Aufruf bis zu PER_CALL Kunden der Liste prüfen (Cursor im KV). Ein Durchlauf ≈ 1 Stunde.
 *   3. Details (GET /appointments/booking/{id}) NUR für neue oder geänderte Buchungen (Signatur
 *      Start|Ende|Titel|Status je Kunde im KV). Ergebnis via mlBooking.enrich in den Feed
 *      (instructorIds, Kategorie, Status, Mitglied „Vorname N.“).
 *   4. Verschwundene künftige Buchungen eines Kunden, der in DIESEM Aufruf erfolgreich geprüft
 *      wurde: Detail nachsehen → 404 = aus dem Feed löschen, sonst Detail (z. B. CANCELED) übernehmen.
 *      Fehler → nichts ändern, nächster Durchlauf versucht es erneut.
 *
 * Grenzen: höchstens MAX_CALLS Magicline-Abrufe und TIME_BUDGET_MS je Aufruf; sinkt
 * x-ratelimit-remaining unter RL_MIN, wird abgebrochen. Ein KV-Lock verhindert parallele Läufe.
 * NUR GET an Magicline. Wirft nie. ML_POLL=off schaltet die Abfrage ab.
 */

const crypto = require('node:crypto');
const M = require('./members');
const B = require('./mlBooking');
const MlEvents = require('./mlEvents');
const { redisPipeline, hasStore } = require('./store');

const STATE = 'mlx:poll:state';
const LOCK = 'mlx:poll:lock';
const SEEN = (cid) => 'mlx:poll:c:' + cid;
const SEEN_TTL = 60 * 60 * 24 * 30;
const STATE_TTL = 60 * 60 * 24 * 30;

const PER_CALL = 300;              // Kunden je Aufruf
const MAX_CALLS = 350;             // Magicline-Abrufe je Aufruf (+ max. 40 Nachladungen im Feed ≤ 400)
const RESERVE = 12;                // Puffer für Details eines laufenden Kunden
const TIME_BUDGET_MS = 15000;      // Hub wartet max. 25 s auf den Feed (Function-Limit 60 s)
const RL_MIN = 150;                // Rest-Kontingent (1000/Min.), darunter aufhören
const LIST_MAX_AGE_MS = 55 * 60 * 1000;
const PAGES_PER_PHASE = 80;        // max. 8000 Kunden je Status
const PARALLEL = 4;
const PHASES = ['MEMBER', 'FORMER_MEMBER', 'PROSPECT'];

function enabled() { return String(process.env.ML_POLL || '').toLowerCase() !== 'off'; }
function prospectDays() { const n = parseInt(process.env.ML_POLL_PROSPECT_DAYS || '60', 10); return n > 0 && n <= 3650 ? n : 60; }
function listOf(j) { return Array.isArray(j) ? j : (j && Array.isArray(j.result) ? j.result : []); }
function s(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 80); }

async function kvGet(key) { try { const [v] = await redisPipeline([['GET', key]]); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

// Zähler + Rate-Limit-Beobachtung für einen Aufruf.
function budget(t0) {
  const b = { calls: 0, rlRest: null, stop: null };
  b.canCall = (n) => {
    if (b.stop) return false;
    if (Date.now() - t0 > TIME_BUDGET_MS) { b.stop = 'zeit'; return false; }
    if (b.calls + (n || 1) > MAX_CALLS) { b.stop = 'abrufe'; return false; }
    if (b.rlRest != null && b.rlRest < RL_MIN) { b.stop = 'ratelimit'; return false; }
    return true;
  };
  b.get = async (p) => {
    b.calls++;
    let r; try { r = await M.ml('GET', p); } catch (e) { r = { status: 0, json: null }; }
    if (r && r.rl && r.rl.remaining != null && isFinite(r.rl.remaining)) b.rlRest = Number(r.rl.remaining);
    if (r && r.status === 429) { b.stop = 'ratelimit'; b.rlRest = 0; }
    return r || { status: 0, json: null };
  };
  return b;
}

// Signatur einer Buchung aus der Kundenliste – ändert sie sich, wird das Detail neu geholt.
function sig(a) { return [a.startDateTime, a.endDateTime, a.title, a.bookingStatus || a.status || ''].map((x) => s(x, 60)).join('|'); }
function bidOf(a) { return a && (a.bookingId != null ? a.bookingId : a.id); }
function future(iso, ref) { const t = Date.parse(iso || ''); return isNaN(t) ? true : t >= ref; }

// ── Kundenliste (seitenweise, über Aufrufe fortsetzbar) ──
async function refreshStep(st, b, now) {
  const r0 = st.refresh || { phase: 0, offset: null, acc: [], pages: 0 };
  const cutoff = now - prospectDays() * 86400000;
  while (r0.phase < PHASES.length) {
    if (!b.canCall(1 + RESERVE)) { st.refresh = r0; return false; }
    const ph = PHASES[r0.phase];
    const r = await b.get('/customers?sliceSize=100&customerStatus=' + ph + (r0.offset != null ? '&offset=' + encodeURIComponent(r0.offset) : ''));
    if (r.status !== 200) { st.refresh = r0; st.listError = r.status || 'netz'; return false; }
    const list = listOf(r.json);
    list.forEach((c) => {
      if (!c || c.id == null) return;
      if (ph === 'PROSPECT') { const t = Date.parse(c.createdDateTime || ''); if (!isNaN(t) && t < cutoff) return; }
      r0.acc.push([s(c.id, 30), B.shortName(c.firstName, c.lastName) || '', ph[0]]);
    });
    r0.pages++;
    const more = r.json && r.json.hasNext && list.length && r.json.offset != null && r0.pages < PAGES_PER_PHASE;
    if (more) r0.offset = r.json.offset; else { r0.phase++; r0.offset = null; r0.pages = 0; }
  }
  // fertig: doppelte IDs raus, neuer Durchlauf
  const seen = {}; st.list = r0.acc.filter((x) => (seen[x[0]] ? false : (seen[x[0]] = 1)));
  st.listAt = now; st.pos = 0; st.refresh = null; st.listError = null;
  st.cycle = (st.cycle || 0) + 1; st.cycleStartedAt = now;
  return true;
}

// ── Einen Kunden prüfen. Liefert die neue Buchungs-Signaturliste oder null (nicht geprüft). ──
async function checkCustomer(entry, prevSeen, b, now, stats) {
  const cid = entry[0]; const name = entry[1] || null;
  const r = await b.get('/appointments/booking?customerId=' + encodeURIComponent(cid));
  if (r.status !== 200) { stats.fehler++; return null; }      // nicht geprüft → nichts ändern
  const list = listOf(r.json);
  const prev = (prevSeen && prevSeen.b) || {};
  const next = {};
  const ids = {};
  for (const a of list) {
    const bid = bidOf(a); if (bid == null || !a.startDateTime) continue;
    const k = s(bid, 30); ids[k] = 1;
    if (!future(a.endDateTime || a.startDateTime, now - 2 * 3600000)) continue;   // Vergangenes nicht anfassen
    stats.buchungen++;
    const g = sig(a);
    if (prev[k] && prev[k].s === g) { next[k] = prev[k]; continue; }
    const cost = name ? 1 : 2;   // enrich holt den Namen selbst, wenn keiner da ist
    if (!b.canCall(cost)) { if (prev[k]) next[k] = prev[k]; continue; }
    b.calls += cost;
    const rec = await B.enrich({ bookingId: k, title: s(a.title, 80) || 'Termin', start: s(a.startDateTime, 40), end: s(a.endDateTime, 40) || null, customerId: cid, memberName: name || undefined });
    if (rec) { next[k] = { s: g, t: s(a.startDateTime, 40) }; stats.details++; }
    else if (prev[k]) next[k] = prev[k];
  }
  // verschwundene künftige Buchungen (Kunde wurde eben erfolgreich geprüft)
  for (const k of Object.keys(prev)) {
    if (ids[k]) continue;
    const p = prev[k];
    if (!future(p.t, now)) continue;                 // vorbei → vergessen
    if (!b.canCall(1)) { next[k] = p; continue; }
    b.calls++;
    const d = await B.bookingDetail(k);
    if (d.ok) {
      await MlEvents.upsertAppointment(Object.assign({}, d.data, { customerId: d.data.customerId || cid, detailAt: Date.now() }));
      stats.geaendert++;
    } else if (d.status === 404) {
      await MlEvents.removeAppointment(k); stats.entfernt++;
    } else next[k] = p;                               // Fehler → beim nächsten Mal erneut
  }
  return next;
}

/**
 * Ein Abfrage-Schritt. Liefert eine kurze Zusammenfassung (nur Zahlen) oder { skipped }.
 */
async function step(opts) {
  opts = opts || {};
  if (!enabled()) return { skipped: 'aus' };
  if (!hasStore) return { skipped: 'no_store' };
  const now = opts.now || Date.now();
  const t0 = Date.now();
  const token = crypto.randomBytes(8).toString('hex');
  try { const [got] = await redisPipeline([['SET', LOCK, token, 'NX', 'EX', '58']]); if (got !== 'OK') return { skipped: 'laeuft' }; }
  catch (e) { return { skipped: 'kv' }; }
  const b = budget(t0);
  const stats = { geprueft: 0, buchungen: 0, details: 0, geaendert: 0, entfernt: 0, fehler: 0 };
  const st = (await kvGet(STATE)) || {};
  let fertig = false;
  try {
    // Liste laden, wenn keine da ist, gerade geladen wird oder ein Durchlauf fertig und die Liste alt ist
    const listDone = !Array.isArray(st.list) || st.pos >= st.list.length;
    if (st.refresh || !Array.isArray(st.list) || (listDone && now - (st.listAt || 0) > LIST_MAX_AGE_MS)) {
      await refreshStep(st, b, now);
    } else if (listDone) { st.pos = 0; st.cycle = (st.cycle || 0) + 1; st.cycleStartedAt = now; }

    if (Array.isArray(st.list) && !st.refresh && st.pos < st.list.length) {
      const part = st.list.slice(st.pos, st.pos + Math.max(1, Math.min(PER_CALL, opts.perCall || PER_CALL)));
      const seenArr = [];
      for (let i = 0; i < part.length; i += 100) {
        const chunk = part.slice(i, i + 100);
        try { (await redisPipeline(chunk.map((e) => ['GET', SEEN(e[0])]))).forEach((v) => seenArr.push(v ? JSON.parse(v) : null)); }
        catch (e) { chunk.forEach(() => seenArr.push(undefined)); }
      }
      let idx = 0; let taken = 0; const writes = [];
      const worker = async () => {
        while (idx < part.length && b.canCall(1 + RESERVE)) {
          const i = idx++; taken++;
          if (seenArr[i] === undefined) { stats.fehler++; continue; }   // KV-Fehler → Kunde überspringen
          const next = await checkCustomer(part[i], seenArr[i], b, now, stats);
          if (next == null) continue;
          stats.geprueft++;
          const prevStr = JSON.stringify((seenArr[i] && seenArr[i].b) || {});
          if (JSON.stringify(next) !== prevStr) {
            writes.push(Object.keys(next).length ? ['SET', SEEN(part[i][0]), JSON.stringify({ b: next }), 'EX', String(SEEN_TTL)] : ['DEL', SEEN(part[i][0])]);
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      for (let i = 0; i < writes.length; i += 100) { try { await redisPipeline(writes.slice(i, i + 100)); } catch (e) {} }
      st.pos += taken;
      if (st.pos >= st.list.length) { fertig = true; st.lastCompleteAt = now; st.completed = (st.completed || 0) + 1; }
    }
    st.lastRunAt = now;
    st.lastCalls = b.calls;
    try { await redisPipeline([['SET', STATE, JSON.stringify(st), 'EX', String(STATE_TTL)]]); } catch (e) {}
  } catch (e) {
    stats.fehler++;
  } finally {
    try { const [cur] = await redisPipeline([['GET', LOCK]]); if (cur === token) await redisPipeline([['DEL', LOCK]]); } catch (e) {}
  }
  return summary(st, Object.assign(stats, { abrufe: b.calls, stop: b.stop, rlRest: b.rlRest, fertig: fertig, ms: Date.now() - t0 }));
}

function summary(st, extra) {
  const list = Array.isArray(st.list) ? st.list : [];
  const n = (c) => list.filter((x) => x[2] === c).length;
  return Object.assign({
    durchlauf: st.cycle || 0, pos: Math.min(st.pos || 0, list.length), kunden: list.length,
    mitglieder: n('M'), ehemalige: n('F'), interessenten: n('P'),
    listeLaedt: !!st.refresh, listeFehler: st.listError || null,
    komplett: st.completed || 0, letzterKomplett: st.lastCompleteAt ? new Date(st.lastCompleteAt).toISOString() : null,
  }, extra || {});
}

async function status() { return summary((await kvGet(STATE)) || {}); }

module.exports = { step, status, _intern: { sig, refreshStep, checkCustomer, PHASES } };
