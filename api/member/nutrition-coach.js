'use strict';

/**
 * /api/member/nutrition-coach   (Authorization: Bearer <token>)
 * -------------------------------------------------------------------------
 * Das Coaching-Programm des Ernährungsmoduls (geführte 8-Wochen-Reise mit
 * kuratierten Lektionen + adaptiver FINN-Begleitung). Basis-Programm ist gratis;
 * KI-Teile (Personalisierung, Impuls, Check-in-Auswertung) sind Premium – Gate
 * wie in nutrition.js (`premium_required`). Der Premium-Status wird NICHT hier,
 * sondern vom Stripe-Webhook gesetzt.
 *
 *   GET                      -> Snapshot (enrolled, aktuelle Woche/Lektion, Premium-Status)
 *   POST { action:'enroll', prefs? }     -> ins Programm einschreiben (frei)
 *   POST { action:'lesson-get', week }   -> Lektionsinhalt (Woche 1 frei · 2–8 später Premium)
 *   POST { action:'lesson-complete', week } -> Lektion abhaken, Folgewoche früh freischalten (frei)
 *
 * Ohne KV (hasStore=false) -> { ok:true, available:false } (UI blendet aus).
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');
const Ent = require('../../lib/entitlements');
const Coaching = require('../../lib/coaching');
const { hasStore } = require('../../lib/store');

// Freemium: Wochen 2–8 & KI-Personalisierung sind Premium (wie nutrition.js).
const PREMIUM_MSG = 'Das ist eine Premium-Funktion (KI). Teste Premium 7 Tage gratis – danach jederzeit kündbar.';

// Premium-Felder für den Client (gleiche Namen wie nutrition.js buildState).
async function tierFields(id) {
  const t = Ent.publicTier(await Ent.getEntitlement(id));
  return { premium: t.premium, tier: t.tier, trialing: t.trialing, premiumUntil: t.until };
}

async function snapshot(id, st) {
  if (st === undefined) st = await Coaching.getState(id);
  const today = Coaching.berlinToday();
  const snap = Coaching.publicSnapshot(st, today);
  const tf = await tierFields(id);
  let hab = { todayHabits: [], streak: 0, points: 0 };
  if (st && st.enrolled) {
    const rec = await Coaching.getHabitRec(id);
    hab = { todayHabits: Coaching.todayHabitList(st, rec, today), streak: Coaching.habitStreak(rec, today), points: Coaching.habitPoints(rec, today) };
  }
  return Object.assign({ ok: true, available: true }, snap, hab, tf);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: false })); }

  const id = sess.id;

  if (req.method === 'GET') {
    res.statusCode = 200; return res.end(JSON.stringify(await snapshot(id)));
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const action = String(body.action || '');

  if (action === 'enroll') {
    if (!(await M.rateLimit('nutri-enroll:' + id, 8, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz warten und erneut versuchen.' })); }
    const st = await Coaching.enroll(id, { prefs: body.prefs });
    res.statusCode = 200; return res.end(JSON.stringify(await snapshot(id, st)));
  }

  if (action === 'lesson-get') {
    const st = await Coaching.getState(id);
    if (!st || !st.enrolled) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'not_enrolled' })); }
    const week = Coaching.clampInt(body.week, 1, Coaching.TOTAL_WEEKS, 0);
    if (!week) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'bad_week' })); }
    const today = Coaching.berlinToday();
    const meta = Coaching.lessonMeta(week);
    if (!Coaching.isWeekUnlocked(st, week, today)) {
      // Zeitlich noch gesperrt: nur Meta (Titel/Teaser) + wann es frei wird – kein Inhalt.
      const uw = Coaching.unlockedWeek(st, today);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, locked: true, lesson: meta, unlocksInDays: Math.max(0, (week - uw) * 7 - (Coaching.daysBetween(st.startDate, today) % 7)) }));
    }
    const premium = Ent.isPremium(await Ent.getEntitlement(id));
    // Woche 1 gratis (Kostprobe); Wochen 2–8 sind Premium.
    if (week >= 2 && !premium) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'premium_required', message: PREMIUM_MSG })); }
    let ls = st.lessons && st.lessons[String(week)];
    let personalized = (ls && ls.personalized) || null;
    // Premium: FINN personalisiert die Lektion einmalig (gecacht im State).
    if (premium && !personalized && AI.hasAI && (await M.rateLimit('nutri-lessonai:' + id, 20, 3600))) {
      const prof = (await Coaching.kvGetJson('nutri:p:' + id)) || {};
      let firstName = ''; try { const m = await M.getMember(id); firstName = (m && m.firstName) || ''; } catch (e) {}
      const r = await AI.coachLessonPersonalize({ firstName: firstName, goal: prof.goal, diet: prof.diet, week: week, lessonTitle: meta.title, lessonTheme: meta.theme, under18: (Number(prof.age) || 99) < 18 });
      if (r && r.ok && r.intro) {
        personalized = r.intro;
        st.lessons = st.lessons || {};
        st.lessons[String(week)] = st.lessons[String(week)] || { unlockedAt: Date.now(), completedAt: null, personalized: null };
        st.lessons[String(week)].personalized = personalized;
        await Coaching.saveState(id, st);
        ls = st.lessons[String(week)];
      }
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, locked: false, lesson: Coaching.fullLesson(week), completed: !!(ls && ls.completedAt), personalized: personalized }));
  }

  if (action === 'habit-toggle') {
    const r = await Coaching.toggleHabit(id, body.habitId, body.date);
    if (!r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: r.error })); }
    res.statusCode = 200; return res.end(JSON.stringify(await snapshot(id)));
  }

  if (action === 'lesson-complete') {
    const week = Coaching.clampInt(body.week, 1, Coaching.TOTAL_WEEKS, 0);
    if (!week) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'bad_week' })); }
    // Wochen 2–8 sind Premium – ohne Recht auch nicht abschließbar.
    if (week >= 2 && !Ent.isPremium(await Ent.getEntitlement(id))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'premium_required', message: PREMIUM_MSG })); }
    const r = await Coaching.completeLesson(id, week);
    if (!r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: r.error })); }
    res.statusCode = 200; return res.end(JSON.stringify(await snapshot(id, r.state)));
  }

  res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
