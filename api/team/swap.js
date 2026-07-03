'use strict';

/**
 * Team-Backend: Schichttausch (Anfragen + Schwarzes Brett).
 *   GET ?week=YYYY-MM-DD -> { ok, me, incoming:[…], sent:[…], board:[…] }
 *     incoming = offene (pending) Anfragen an mich; Admin sieht alle offenen.
 *     sent     = meine offenen Anfragen (Trainer).
 *     board    = Schichten der Woche mit board:true inkl. Besitzer.
 *   POST { action:'request'|'accept'|'decline'|'withdraw', swapId?, shiftId?, note?, week? }
 *     request: Ich (Trainer) möchte die Brett-Schicht des Besitzers übernehmen
 *              (from = Ich, to = Besitzer). accept schreibt die Schicht auf den
 *              Anfragenden um und nimmt sie vom Brett (lib/shifts.setSwapStatus).
 *
 * Antwortet nach Mutationen mit den frischen Listen. Ohne Store leere Daten,
 * wirft nie.
 */

const TA = require('../../lib/teamAuth');
const SH = require('../../lib/shifts');
const M = require('../../lib/members');   // readBody

function ident(sess) {
  const name = String((sess && sess.user) || 'Team');
  const employeeId = (sess && sess.employeeId != null && String(sess.employeeId).trim() !== '')
    ? String(sess.employeeId).trim() : null;
  return { employeeId: employeeId, name: name, role: (sess && sess.role) || 'admin', initials: SH.initialsOf(name) };
}

async function payload(sess, week) {
  const me = ident(sess);
  let swaps = [];
  try { swaps = await SH.listSwaps(); } catch (e) { swaps = []; }
  const incoming = [], sent = [];
  swaps.forEach((sw) => {
    if (sw.status !== 'pending') return;
    if (me.employeeId) {
      if (sw.to && String(sw.to.id) === me.employeeId) incoming.push(sw);
      if (sw.from && String(sw.from.id) === me.employeeId) sent.push(sw);
    } else {
      incoming.push(sw);   // Admin moderiert alle offenen Anfragen
    }
  });
  const board = [];
  try {
    const days = await SH.listWeek(SH.weekDates(SH.mondayOf(week)));
    days.forEach((d) => {
      d.shifts.forEach((sh) => {
        if (sh.board === true && sh.assignee) {
          board.push({
            id: sh.id, date: sh.date, start: sh.start, end: sh.end, role: sh.role,
            shiftStr: SH.shiftLabel(sh), owner: sh.assignee,
          });
        }
      });
    });
  } catch (e) {}
  return { ok: true, me: me, incoming: incoming, sent: sent, board: board };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method === 'GET') {
    let week = null;
    try { week = new URL(req.url, 'http://x').searchParams.get('week'); } catch (e) {}
    res.statusCode = 200;
    return res.end(JSON.stringify(await payload(sess, week)));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const action = body && body.action;
  const week = body && body.week;
  const me = ident(sess);

  if (!SH.hasStore) {
    res.statusCode = 200;
    const p = await payload(sess, week);
    p.ok = false; p.disabled = true; p.message = 'Speicher nicht verfügbar – Tausch ist nicht möglich.';
    return res.end(JSON.stringify(p));
  }

  async function done(extra) {
    const p = await payload(sess, week);
    res.statusCode = 200;
    return res.end(JSON.stringify(Object.assign(p, extra || {})));
  }
  async function fail(message) {
    const p = await payload(sess, week);
    p.ok = false; p.message = message;
    res.statusCode = 200;
    return res.end(JSON.stringify(p));
  }

  if (action === 'request') {
    if (!me.employeeId) return fail('Bitte als Trainer anmelden, um Schichten zu übernehmen.');
    const shiftId = String((body && body.shiftId) || '').trim();
    if (!shiftId) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_shift' })); }
    const shift = await SH.getShift(shiftId);
    if (!shift || shift.board !== true || !shift.assignee) return fail('Diese Schicht steht nicht (mehr) am Schwarzen Brett.');
    if (String(shift.assignee.id) === me.employeeId) return fail('Das ist deine eigene Schicht.');
    // Doppelte offene Anfragen vermeiden (best effort).
    try {
      const existing = await SH.listSwaps();
      const dup = existing.some((sw) => sw.status === 'pending' && sw.shiftId === shiftId
        && sw.from && String(sw.from.id) === me.employeeId);
      if (dup) return fail('Du hast für diese Schicht bereits angefragt.');
    } catch (e) {}
    await SH.createSwap({
      shiftId: shiftId, shiftStr: SH.shiftLabel(shift),
      from: { id: me.employeeId, name: me.name, initials: me.initials },
      to: shift.assignee, note: body.note,
    });
    return done();
  }

  if (action === 'accept' || action === 'decline' || action === 'withdraw') {
    const swapId = String((body && body.swapId) || '').trim();
    if (!swapId) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_swap' })); }
    const swap = await SH.getSwap(swapId);
    if (!swap || swap.status !== 'pending') return fail('Diese Anfrage ist nicht (mehr) offen.');
    const isTarget = !!(swap.to && me.employeeId && String(swap.to.id) === me.employeeId);
    const isSender = !!(swap.from && me.employeeId && String(swap.from.id) === me.employeeId);
    if (action === 'withdraw') {
      if (me.role !== 'admin' && !isSender) return fail('Nur der Anfragende kann zurückziehen.');
      await SH.setSwapStatus(swapId, 'withdrawn');
      return done();
    }
    if (me.role !== 'admin' && !isTarget) return fail('Diese Anfrage richtet sich nicht an dich.');
    await SH.setSwapStatus(swapId, action === 'accept' ? 'accepted' : 'declined');
    return done();
  }

  res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
