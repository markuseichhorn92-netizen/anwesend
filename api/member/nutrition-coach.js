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
const Inbox = require('../../lib/inbox');
const SR = require('../../lib/studioReply');
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
  let impulse = null;
  if (st && st.enrolled) {
    const rec = await Coaching.getHabitRec(id);
    hab = { todayHabits: Coaching.todayHabitList(st, rec, today), streak: Coaching.habitStreak(rec, today), points: Coaching.habitPoints(rec, today) };
    const irec = await Coaching.getImpulse(id);
    if (irec && irec.date === today) impulse = { text: irec.text, source: irec.source, acked: !!irec.ackedAt, date: irec.date };
  }
  let nextCheckin = null;
  if (st && st.enrolled) nextCheckin = Coaching.nextCheckinInfo(await Coaching.getCheckins(id), today);
  return Object.assign({ ok: true, available: true }, snap, hab, { impulse: impulse, nextCheckin: nextCheckin }, tf);
}

// Heutigen Tagesimpuls sicherstellen (lazy, gecacht pro Berlin-Tag). KI nur Premium
// (rate-limitiert -> max. 1 Call/Tag); sonst statische Rotation. Auch vom Cron genutzt.
async function ensureImpulseForRequest(id, st) {
  const today = Coaching.berlinToday();
  const premium = Ent.isPremium(await Ent.getEntitlement(id));
  const aiGen = (premium && AI.hasAI) ? async function () {
    if (!(await M.rateLimit('nutri-impulse:' + id, 5, 86400))) return null;
    const prof = (await Coaching.kvGetJson('nutri:p:' + id)) || {};
    let firstName = ''; try { const m = await M.getMember(id); firstName = (m && m.firstName) || ''; } catch (e) {}
    const wk = Coaching.activeWeek(st, today); const meta = Coaching.lessonMeta(wk);
    const streak = Coaching.habitStreak(await Coaching.getHabitRec(id), today);
    const r = await AI.coachDailyImpulse({ firstName: firstName, goal: prof.goal, week: wk, lessonTitle: meta.title, streak: streak, under18: (Number(prof.age) || 99) < 18 });
    return (r && r.ok && r.text) ? { text: r.text, focusHabitId: null, source: 'ai' } : null;
  } : null;
  return Coaching.ensureImpulse(id, st, today, aiGen);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: false })); }

  const id = sess.id;

  if (req.method === 'GET') {
    const st = await Coaching.getState(id);
    if (st && st.enrolled) { try { await ensureImpulseForRequest(id, st); } catch (e) {} }
    res.statusCode = 200; return res.end(JSON.stringify(await snapshot(id, st)));
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const action = String(body.action || '');

  if (action === 'enroll') {
    if (!(await M.rateLimit('nutri-enroll:' + id, 8, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz warten und erneut versuchen.' })); }
    const st = await Coaching.enroll(id, { prefs: body.prefs });
    res.statusCode = 200; return res.end(JSON.stringify(await snapshot(id, st)));
  }

  if (action === 'checkin-history') {
    const rec = await Coaching.getCheckins(id);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, history: Coaching.checkinHistory(rec) }));
  }

  if (action === 'checkin-submit') {
    const st = await Coaching.getState(id);
    if (!st || !st.enrolled) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'not_enrolled' })); }
    if (!(await M.rateLimit('nutri-checkin:' + id, 6, 86400))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz warten und erneut versuchen.' })); }
    const today = Coaching.berlinToday();
    const entry = Coaching.buildCheckinEntry(body, today);
    if (!entry) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'bad_input', message: 'Bitte gib ein gültiges Gewicht ein.' })); }
    let rec = await Coaching.getCheckins(id);
    rec = Coaching.appendCheckin(rec, entry, today).rec;
    const prof = (await Coaching.kvGetJson('nutri:p:' + id)) || {};
    // Premium: KI-Auswertung; sonst reviewLocked (Zahlen + Chart bleiben frei).
    const premium = Ent.isPremium(await Ent.getEntitlement(id));
    let reviewLocked = true;
    if (premium && AI.hasAI) {
      try {
        const r = await AI.coachCheckinReview({ goal: prof.goal, week: Coaching.activeWeek(st, today), series: Coaching.checkinHistory(rec).slice(-6), latest: entry });
        if (r && r.ok) { entry.review = { summary: r.summary, insights: r.insights, tip: r.tip }; reviewLocked = false; }
      } catch (e) {}
    }
    // Team an Schlüsselpunkten einschleifen (Vorgang ins Studio-Postfach).
    const loop = Coaching.shouldLoopTeam(rec, prof.goal);
    if (loop.loop) {
      try {
        let m = null; try { m = await M.getMember(id); } catch (e) {}
        const who = ((((m && m.firstName) || '') + ' ' + ((m && m.lastName) || '')).trim() || 'Mitglied') + ((m && m.customerNumber) ? (' (' + m.customerNumber + ')') : '');
        const vorgang = await Inbox.addVorgang(id, {
          type: 'kontakt', subject: 'Ernährungs-Coaching · ' + loop.reason,
          systemText: 'Deine Erfolgskontrolle ist da – wir schauen sie uns an und melden uns, falls wir dich unterstützen können.',
          teamText: 'Hallo' + ((m && m.firstName) ? (' ' + m.firstName) : '') + ', danke für deine Erfolgskontrolle. Wir melden uns bei dir.',
          member: m ? { name: ((m.firstName || '') + ' ' + (m.lastName || '')).trim(), nr: m.customerNumber || null, email: m.email || null } : null,
        });
        if (vorgang && vorgang.id) entry.teamVorgangId = vorgang.id;
        try { await SR.notifyStudio({ member: m ? { id: id, customerId: id, firstName: m.firstName, lastName: m.lastName } : { id: id }, vorgang: vorgang || {}, subject: '🥗 Coaching-Check-in – ' + loop.reason + ' · ' + who, text: 'Ein Mitglied hat eine Erfolgskontrolle abgegeben, die Aufmerksamkeit verdient (' + loop.reason + ').\n\nMitglied: ' + who + '\nGewicht: ' + entry.weight + ' kg, Umsetzung: ' + entry.adherence + '%, Stimmung: ' + entry.mood + '/5.' + (entry.note ? ('\nNotiz: ' + entry.note) : '') + '\n\nBitte kurz persönlich melden.' }); } catch (e) {}
      } catch (e) {}
    }
    await Coaching.saveCheckins(id, rec);
    const snap = await snapshot(id, st);
    res.statusCode = 200;
    return res.end(JSON.stringify(Object.assign(snap, { review: entry.review || null, reviewLocked: reviewLocked, teamLooped: !!loop.loop, history: Coaching.checkinHistory(rec) })));
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

  if (action === 'impulse-get') {
    const st = await Coaching.getState(id);
    if (st && st.enrolled) { try { await ensureImpulseForRequest(id, st); } catch (e) {} }
    res.statusCode = 200; return res.end(JSON.stringify(await snapshot(id, st)));
  }
  if (action === 'impulse-ack') {
    await Coaching.ackImpulse(id);
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
