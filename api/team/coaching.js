'use strict';

/**
 * GET /api/team/coaching?id=<memberId>   (Team-Session erforderlich)
 * -------------------------------------------------------------------------
 * Read-only Coaching-Status eines Mitglieds fürs Team-Backend: eingeschrieben?
 * Kurswoche N/8, abgeschlossene Lektionen, Gewohnheiten-Streak, letzter Check-in
 * (Gewicht/Umsetzung/Stimmung) und nächste Fälligkeit. So sehen Trainer:innen den
 * Coaching-Kontext, wenn ein Check-in-Vorgang ins Postfach kommt.
 *
 * Nur lesend; ohne Store oder nicht eingeschrieben -> { ok:true, enrolled:false }.
 * Wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const Coaching = require('../../lib/coaching');
const { hasStore } = require('../../lib/store');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'nutrition.manage', res)) return;
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
  if (!hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, enrolled: false })); }

  try {
    const st = await Coaching.getState(id);
    if (!st || !st.enrolled) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, enrolled: false })); }
    const today = Coaching.berlinToday();
    const snap = Coaching.publicSnapshot(st, today);
    const completed = snap.lessons.filter(function (l) { return l.completed; }).length;
    const streak = Coaching.habitStreak(await Coaching.getHabitRec(id), today);
    const cks = await Coaching.getCheckins(id);
    const nc = Coaching.nextCheckinInfo(cks, today);
    const list = (cks && Array.isArray(cks.list)) ? cks.list : [];
    const last = list.length ? list[list.length - 1] : null;
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true, enrolled: true,
      week: snap.week, totalWeeks: snap.totalWeeks, unlockedWeek: snap.unlockedWeek,
      lessonsCompleted: completed, streak: streak,
      startDate: st.startDate || null,
      nextDue: nc.dueDate, overdue: nc.overdue, checkinCount: list.length,
      lastCheckin: last ? { date: last.date, weight: last.weight, waist: last.waist, mood: last.mood, adherence: last.adherence } : null,
    }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, enrolled: false }));
  }
};
