'use strict';

/**
 * FINN Journeys – Durchlauf (Cron alle 15 Minuten, fortsetzbar).
 * -----------------------------------------------------------------------------
 * run({ budgetMs }) -> { ok, fertig, … }
 *   1. Einmalig: Kandidaten-Index aus Push-Mitgliedern, Postfach und Neuzugängen füllen
 *   2. Fällige Personen (jr:due) verarbeiten – Ruhezeiten/Kappen prüft der Sender
 *   3. Tagesdurchlauf über Mitglieder mit bekannter Nummer (jr:mem): Vorname/Nummer
 *      nachladen, Check-in-Historie einmalig nachziehen, Motivation/Comeback einschreiben
 *   4. Einladung (nur wenn im Team-Backend eingeschaltet): dosiert, höchstens
 *      JOURNEYS_INVITE_PER_DAY (Standard 40) neue Einladungen pro Tag
 * „fertig:false" heißt: Zeit reichte nicht – der nächste Aufruf macht weiter
 * (Muster lib/nutriUsage.js). Magicline-Aufrufe sind je Durchlauf gedeckelt.
 */

const KV = require('../finn/kv');
const Phone = require('../phone');
const Config = require('./config');
const Store = require('./store');
const Engine = require('./engine');
const Engagement = require('./engagement');
const Consent = require('./consent');
const Quiet = require('./quiet');

const DAY = 86400000;
const LOCK = 'jr:lock:tick';
const RUN = 'jr:run';
const PAGE = 25;
const MAX_ML_CALLS = 12;               // Magicline-Aufrufe je Durchlauf (Profil + Historie)

function log(o) { try { console.log('[journeys]', JSON.stringify(o)); } catch (e) {} }
function firstNameOf(n) { const f = String(n || '').trim().split(/\s+/)[0] || ''; return /^[A-Za-zÄÖÜäöüß'’-]{2,24}$/.test(f) ? f : null; }
function invitePerDay() { const n = parseInt(process.env.JOURNEYS_INVITE_PER_DAY || '40', 10); return isFinite(n) && n >= 0 ? Math.min(n, 500) : 40; }

async function seedIndex() {
  if ((await KV.get('jr:seeded')) != null) return 0;
  let n = 0;
  const add = async (id) => { if (Store.isMemberId(id)) { await Store.index(String(id), Date.now() - 30 * DAY); n++; } };
  try { const Push = require('../push'); for (const id of await Push.allPushMembers()) await add(id); } catch (e) {}
  try { const NM = require('../newMembers'); for (const j of await NM.listJoins()) await add(j.id || j.customerId); } catch (e) {}
  try { const Inbox = require('../inbox'); for (const v of await Inbox.listAll({ limit: 1000 })) await add(v._memberId); } catch (e) {}
  await KV.set('jr:seeded', String(Date.now()));
  return n;
}

// Vorname + WhatsApp-taugliche Nummer aus Magicline (nur Mobil/Privat).
async function enrich(st, budget) {
  if (budget.ml <= 0) return false;
  budget.ml--;
  try {
    const M = require('../members');
    const m = await M.getMember(st.cid);
    if (m) {
      if (!st.firstName) st.firstName = firstNameOf(m.firstName);
      const phone = Phone.canon(m.phoneMobile || m.phonePrivate || '');
      if (!st.phone && phone) { st.phone = phone; await Store.linkPhone(phone, st.subj); }
      if (m.dateOfBirth) { const age = (Date.now() - Date.parse(m.dateOfBirth)) / (365.25 * DAY); if (isFinite(age) && age < 18) st.facts.minor = true; }
    }
    st.facts.needsProfile = false;
    return true;
  } catch (e) { return false; }
}

async function backfill(cid, budget) {
  if (budget.ml <= 0) return false;
  budget.ml--;
  try {
    const M = require('../members');
    const list = await M.checkinHistory(cid, { windows: 3 });
    const times = (Array.isArray(list) ? list : []).map((c) => Date.parse(c && c.in)).filter((t) => isFinite(t));
    await Engagement.applyHistory(cid, times);
    return true;
  } catch (e) { return false; }
}

// Tagesauswertung eines Mitglieds mit Nummer: Motivation/Comeback einschreiben.
async function evaluate(cid, now, budget) {
  const st = await Store.loadOrCreate(cid);
  if (!st) return;
  if ((st.facts.needsProfile || !st.firstName) && budget.ml > 0) await enrich(st, budget);
  let eng = await Engagement.read(cid);
  if (!eng.bf && !eng.track && budget.ml > 0) { await backfill(cid, budget); eng = await Engagement.read(cid); }
  const m = Engagement.metrics(eng, now, st.facts.weeklyGoal);
  st.facts.stage = Engagement.classify(m, st.facts, now);
  st.facts.stageAt = now;
  const con = st.phone ? await Consent.get(st.phone) : { marketing: false };
  if (con.marketing && !st.facts.cancelled) {
    if (!(st.runs.habit && !st.runs.habit.exit)) Engine.enroll(st, 'habit', now, { restart: true });
    const ob = st.runs.onboarding;
    const early = ob && !ob.exit && st.facts.joinAt && now - st.facts.joinAt < 21 * DAY;
    const cb = st.runs.comeback;
    if (m.tracked && m.daysSince != null && m.daysSince >= 10 && !early && !(cb && !cb.exit)) {
      // Neuer Comeback-Lauf nur für eine NEUE Abwesenheit (letzter Lauf endete vor dem letzten Besuch).
      if (!cb || !m.last || (cb.exit && cb.exit.at < m.last) || (cb.exit && cb.exit.r === 'visited')) Engine.enroll(st, 'comeback', now, { restart: true });
    }
  }
  await Store.save(st);
  const ctx = await Engine.buildCtx(st, now);
  await Store.schedule(st.subj, Engine.nextDue(st, ctx));
}

async function invitePass(now, budget, deadline) {
  if (!(await Config.journeyOn('invite'))) return { skipped: 'off' };
  const dayKey = 'jr:invcnt:' + Quiet.parts(now).ymd;
  let used = Number(await KV.get(dayKey)) || 0;
  const cap = invitePerDay();
  if (used >= cap) return { capped: true };
  const cur = (await KV.getJSON('jr:run:inv')) || { offset: 0 };
  const ids = await Store.indexPage(cur.offset, PAGE);
  if (!ids.length) { await KV.set('jr:run:inv', { offset: 0, doneAt: now }, 30 * 86400); return { done: true }; }
  let n = 0;
  for (const cid of ids) {
    if (Date.now() > deadline || used >= cap || budget.ml <= 0) break;
    cur.offset++;
    const st = await Store.loadOrCreate(cid);
    if (!st || st.facts.cancelled || (st.runs.invite)) continue;
    if (!st.phone) { await enrich(st, budget); }
    if (!st.phone) { await Store.save(st); continue; }
    const con = await Consent.get(st.phone);
    if (con.marketing || con.suppressed || (await KV.get('jr:inv:' + st.phone)) != null) { await Store.save(st); continue; }
    // Nur aktive Verträge einladen.
    if (budget.ml <= 0) break;
    budget.ml--;
    let c = null; try { c = await require('../members').getContract(cid); } catch (e) {}
    if (!c || !c.active || c.cancelled) { st.facts.inviteSkip = 'contract'; await Store.save(st); continue; }
    Engine.enroll(st, 'invite', now);
    await Store.save(st);
    await Store.schedule(st.subj, now);
    used = await KV.incr(dayKey, 2 * 86400) || (used + 1); n++;
  }
  await KV.set('jr:run:inv', cur, 30 * 86400);
  return { invited: n };
}

async function run(opts) {
  opts = opts || {};
  const started = Date.now();
  const deadline = started + Math.max(5000, Math.min(50000, opts.budgetMs || 40000));
  const now = opts.now || Date.now();
  if (!Config.tracking()) return { ok: true, fertig: true, off: true };
  if (!(await KV.set(LOCK, String(now), 55, { nx: true }))) return { ok: true, fertig: true, locked: true };
  const out = { ok: true, fertig: false, due: 0, sent: 0, evaluated: 0, seeded: 0 };
  const budget = { ml: opts.maxMagicline != null ? opts.maxMagicline : MAX_ML_CALLS };
  try {
    out.seeded = await seedIndex();
    if (Config.on()) {
      // 2. Fällige Personen
      const seen = new Set();
      while (Date.now() < deadline) {
        const subs = (await Store.due(now, PAGE)).filter((s) => !seen.has(s));
        if (!subs.length) break;
        for (const s of subs) {
          if (Date.now() > deadline) break;
          seen.add(s);
          const st0 = await Store.load(s);
          if (st0 && st0.kind === 'member' && (st0.facts.needsProfile || !st0.phone) && budget.ml > 0) { await enrich(st0, budget); await Store.save(st0); }
          const r = await Engine.runSubject(s, now);
          out.due++; if (r) out.sent += r.sent;
          // Noch etwas fällig (nächste Nachricht)? Frühestens in 60 Minuten – nie zwei auf einmal.
          const sc = await KV.zscore(Store.DUE, s);
          if (sc != null && sc <= now) await Store.schedule(s, now + 60 * 60000);
        }
      }
      // 3. Tagesdurchlauf
      const today = Quiet.parts(now).ymd;
      let cur = (await KV.getJSON(RUN)) || {};
      if (cur.day !== today) cur = { day: today, offset: 0, done: false };
      while (!cur.done && Date.now() < deadline) {
        const ids = await Store.memberPage(cur.offset, PAGE);
        if (!ids.length) { cur.done = true; break; }
        for (const cid of ids) { if (Date.now() > deadline) break; await evaluate(cid, now, budget); cur.offset++; out.evaluated++; }
      }
      await KV.set(RUN, cur, 3 * 86400);
      if (cur.done && (await KV.get('jr:pruned:' + today)) == null) { await Store.pruneIndex(now); await KV.set('jr:pruned:' + today, '1', 2 * 86400); }
      // 4. Einladung
      if (Date.now() < deadline) out.invite = await invitePass(now, budget, deadline);
      const rest = await Store.due(now, 1);
      out.fertig = cur.done && !rest.filter((s) => !seen.has(s)).length && Date.now() < deadline;
    } else {
      out.fertig = true;   // nur Mitzählen (JOURNEYS_TRACK): Check-ins laufen über den Webhook
    }
  } catch (e) {
    out.ok = false; out.error = 'tick_failed';
  } finally {
    await KV.del(LOCK);
  }
  out.ms = Date.now() - started;
  log({ ev: 'tick', due: out.due, sent: out.sent, evaluated: out.evaluated, fertig: out.fertig, ml: (opts.maxMagicline != null ? opts.maxMagicline : MAX_ML_CALLS) - budget.ml });
  return out;
}

module.exports = { run, evaluate, seedIndex, enrich, backfill, invitePass };
