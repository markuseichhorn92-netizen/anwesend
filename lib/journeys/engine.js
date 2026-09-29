'use strict';

/**
 * FINN Journeys – Ablauf-Motor.
 * -----------------------------------------------------------------------------
 *   enroll(st, key, now, opts)   Lauf starten (einmal; opts.restart nach einem beendeten Lauf)
 *   exitRun(st, key, reason)     Lauf beenden
 *   process(st, now, opts)       fällige Schritte ausführen; höchstens EINE Nachricht je Aufruf
 *                                 und Person – der Rest kommt beim nächsten Durchlauf
 *   nextDue(st, ctx)             frühester offener Zeitpunkt (für jr:due)
 *   retry(subj, j, s, delayMs)   Schritt erneut einplanen (Zustellfehler, Fenster zu …)
 *
 * Lauf: runs[key] = { startedAt, done:{ step:{at,r} }, defer:{ step:ts }, exit:{r,at}|null }
 * Ergebnis r: sent | dry | skip:<grund> | expired | action | action_dry | failed
 */

const Defs = require('./defs');
const Sender = require('./sender');
const Store = require('./store');
const Config = require('./config');
const Engagement = require('./engagement');
const KPI = require('./kpi');
const Phone = require('../phone');

const DAY = 86400000;
const DEFAULT_GRACE = 2 * DAY;

function active(run) { return run && !run.exit; }
function runOf(st, key) { st.runs = st.runs || {}; return st.runs[key] || null; }

function enroll(st, key, now, opts) {
  opts = opts || {};
  const def = Defs.get(key); if (!def || !st) return false;
  const cur = runOf(st, key);
  if (cur && !cur.exit) return false;
  if (cur && cur.exit && !opts.restart) return false;
  st.runs[key] = { startedAt: now || Date.now(), done: {}, defer: {}, exit: null, n: ((cur && cur.n) || 0) + 1 };
  KPI.bump(key, 'enrolled', now).catch(() => {});
  return true;
}
function exitRun(st, key, reason, now) {
  const run = runOf(st, key); if (!active(run)) return false;
  run.exit = { r: String(reason || 'done'), at: now || Date.now() };
  return true;
}
// Schritte, die sich auf einen neu gebuchten Termin beziehen, wieder öffnen.
function reopen(st, key, prefixes) {
  const run = runOf(st, key); if (!active(run)) return;
  Object.keys(run.done).forEach((id) => { if (prefixes.some((p) => id.indexOf(p) === 0)) { delete run.done[id]; delete run.defer[id]; } });
}

async function buildCtx(st, now) {
  const ctx = { now: now, eng: {}, m: null, lead: null, stage: null };
  if (st.cid && Store.isMemberId(st.cid) && st.kind === 'member') {
    ctx.eng = await Engagement.read(st.cid);
    ctx.m = Engagement.metrics(ctx.eng, now, st.facts && st.facts.weeklyGoal);
    ctx.stage = Engagement.classify(ctx.m, st.facts, now);
  } else if (st.cid && Store.isMemberId(st.cid)) {
    ctx.eng = await Engagement.read(st.cid);
  }
  if (st.leadId) { try { ctx.lead = await require('../leadflow').getLead(st.leadId); } catch (e) {} }
  return ctx;
}

function dueOf(step, st, run, ctx) {
  let at = null;
  try { at = step.at(st, run, ctx); } catch (e) { at = null; }
  if (at == null || !isFinite(at)) return null;
  const d = run.defer && run.defer[step.id];
  return d && d > at ? d : at;
}
function untilOf(step, st, run, ctx, at) {
  if (typeof step.until === 'function') { try { const u = step.until(st, run, ctx); if (u != null && isFinite(u)) return u; } catch (e) {} }
  let base = null; try { base = step.at(st, run, ctx); } catch (e) {}
  return (base != null ? base : at) + (step.grace || DEFAULT_GRACE);
}
function pending(step, run) { return step.repeat ? true : !run.done[step.id]; }

function nextDue(st, ctx) {
  let min = null;
  Object.keys(st.runs || {}).forEach((key) => {
    const run = st.runs[key]; const def = Defs.get(key);
    if (!def || !active(run)) return;
    def.steps.forEach((step) => {
      if (!pending(step, run)) return;
      const at = dueOf(step, st, run, ctx);
      if (at == null) return;
      if (ctx.now > untilOf(step, st, run, ctx, at) && !step.repeat) return;
      if (min == null || at < min) min = at;
    });
  });
  return min;
}

function mark(run, id, r, now) { run.done[id] = { at: now, r: r }; if (run.defer) delete run.defer[id]; }

/**
 * Fällige Schritte ausführen. opts.maxSends (Standard 1). Speichert NICHT – das macht
 * der Aufrufer (tick/hooks) zusammen mit dem Neu-Einplanen.
 * -> { sent, actions, results:[{j,s,r}] }
 */
async function process(st, now, opts) {
  opts = opts || {};
  now = now || Date.now();
  const maxSends = opts.maxSends || 1;
  const out = { sent: 0, actions: 0, results: [] };
  if (!st || !Config.on()) return out;
  const ctx = opts.ctx || await buildCtx(st, now);
  const dry = Sender.isDryFor(Phone.canon(st.phone) || '-');
  const keys = Object.keys(st.runs || {});
  for (const key of keys) {
    const run = st.runs[key]; const def = Defs.get(key);
    if (!def || !active(run)) continue;
    if (!(await Config.journeyOn(key))) continue;
    let why = null; try { why = def.exit(st, run, ctx); } catch (e) { why = null; }
    if (why) { exitRun(st, key, why, now); if (key === 'comeback' && why === 'visited' && Object.keys(run.done).some((k) => /^(sent|dry)$/.test(run.done[k].r))) await KPI.bump('comeback', 'reactivated', now); out.results.push({ j: key, s: '-', r: 'exit:' + why }); continue; }
    for (const step of def.steps) {
      if (!pending(step, run)) continue;
      const at = dueOf(step, st, run, ctx);
      if (at == null || at > now) continue;
      if (!step.repeat && now > untilOf(step, st, run, ctx, at)) { mark(run, step.id, 'expired', now); out.results.push({ j: key, s: step.id, r: 'expired' }); continue; }
      let cond = true; if (step.when) { try { cond = !!step.when(st, run, ctx); } catch (e) { cond = false; } }
      if (!cond) { mark(run, step.id, 'skip:condition', now); out.results.push({ j: key, s: step.id, r: 'skip:condition' }); if (step.final) exitRun(st, key, 'done', now); continue; }
      // Aktion ohne Nachricht
      if (!step.tpl) {
        if (dry && !step.always) { mark(run, step.id, 'action_dry', now); await require('../finn/kv').lpush('jr:dry', { at: now, j: key, s: step.id, action: true }, 300, 14 * 86400); }
        else { try { await step.action(st, run, ctx); } catch (e) {} mark(run, step.id, 'action', now); out.actions++; }
        out.results.push({ j: key, s: step.id, r: 'action' });
        if (step.final) exitRun(st, key, 'done', now);
        continue;
      }
      if (out.sent >= maxSends) continue;           // eine Nachricht je Durchlauf und Person
      let tpl = step.tpl; if (typeof tpl === 'function') { try { tpl = tpl(st, run, ctx); } catch (e) { tpl = null; } }
      let vars = {}; if (step.vars) { try { vars = step.vars(st, run, ctx) || {}; } catch (e) { vars = {}; } }
      const r = await Sender.send(st, { journey: key, step: step.id, tpl: tpl, vars: vars }, now);
      if (r.status === 'sent' || r.status === 'dry') {
        mark(run, step.id, r.status, now); out.sent++;
        if (r.status === 'sent' && step.after) { try { await step.after(st, run, ctx); } catch (e) {} }
        if (step.final) exitRun(st, key, 'done', now);
      } else if (r.status === 'deferred') {
        run.defer[step.id] = r.retryAt || (now + 3600000);
        await KPI.bump(key, 'deferred', now);
      } else if (r.status === 'skipped' && (r.reason === 'no_consent' || r.reason === 'no_phone') && !step.repeat) {
        // Einwilligung/Nummer kann noch kommen (z. B. Link aus der Willkommens-Mail): nicht
        // endgültig abhaken, sondern bis zum Verfall des Schritts alle 6 Stunden neu prüfen.
        run.defer[step.id] = now + 6 * 3600000;
      } else {
        mark(run, step.id, (r.status === 'failed' ? 'failed' : 'skip:' + (r.reason || '?')), now);
        if (r.status === 'skipped' && r.reason !== 'no_template') await KPI.bump(key, 'skipped', now);
        if (step.final) exitRun(st, key, 'done', now);
      }
      out.results.push({ j: key, s: step.id, r: r.status + (r.reason ? (':' + r.reason) : '') });
    }
  }
  return out;
}

// Ein Subjekt laden, verarbeiten, speichern, neu einplanen.
async function runSubject(subj, now, opts) {
  const st = await Store.load(subj);
  if (!st) { await Store.unschedule(subj); return null; }
  const ctx = await buildCtx(st, now);
  const res = await process(st, now, Object.assign({}, opts || {}, { ctx: ctx }));
  await Store.save(st);
  const nd = nextDue(st, Object.assign({}, ctx, { now: now }));
  await Store.schedule(subj, nd);
  return res;
}

// Zustellfehler: Schritt wieder öffnen und später erneut versuchen.
async function retry(subj, key, stepId, delayMs, flag) {
  const st = await Store.load(subj); if (!st) return false;
  const run = runOf(st, key); if (!active(run)) return false;
  if (run.retried && run.retried[stepId]) return false;   // nur ein zweiter Versuch
  delete run.done[stepId];
  run.defer[stepId] = Date.now() + (delayMs || 60000);
  run.retried = run.retried || {}; run.retried[stepId] = flag || true;
  if (st.sent && st.sent.length) { const i = st.sent.map((x) => x.s + ':' + x.j).lastIndexOf(stepId + ':' + key); if (i >= 0) st.sent.splice(i, 1); }
  await Store.save(st);
  await Store.schedule(subj, run.defer[stepId]);
  return true;
}

module.exports = { enroll, exitRun, reopen, process, nextDue, runSubject, retry, buildCtx, active };
