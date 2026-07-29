'use strict';

/**
 * Team-Backend: Schichtplan (Dienstplan).
 *   GET ?week=YYYY-MM-DD (Montag)  -> { ok, me:{employeeId,name,role,initials},
 *                                      week, days:[{date,shifts:[…]}], openCount, swapBadge }
 *   POST { action, week?, … }:
 *     create  { date, start, end, role, assignee?, note? }
 *     update  { id, date?/start?/end?/role?/assignee?/note? }
 *     delete  { id }
 *     claim   { id }            Trainer übernimmt eine offene Schicht (Session-Identität)
 *     board   { id }            Schicht ans Schwarze Brett (eigene; Admin: jede)
 *     unboard { id }            Schicht vom Schwarzen Brett nehmen
 *     plan    { week }          -> deterministischer KI-Vorschlag (planWeek)
 *     apply   { assignments:[{shiftId, employee}] }  -> Vorschlag zuweisen
 *
 * Mutationen antworten mit der frischen Woche (wie das todos-Muster mit der
 * frischen Liste). Ohne Store leere Woche + ehrliche Rückmeldung, wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const SH = require('../../lib/shifts');
const M = require('../../lib/members');   // readBody

function ident(sess) {
  const name = String((sess && sess.user) || 'Team');
  const employeeId = (sess && sess.employeeId != null && String(sess.employeeId).trim() !== '')
    ? String(sess.employeeId).trim() : null;
  return { employeeId: employeeId, name: name, role: (sess && sess.role) || 'admin', initials: SH.initialsOf(name) };
}

// Frische Wochen-Antwort (GET-Form) – wird auch nach Mutationen mitgeliefert.
async function weekPayload(sess, week) {
  const me = ident(sess);
  const monday = SH.mondayOf(week);
  let days = [];
  try { days = await SH.listWeek(SH.weekDates(monday)); } catch (e) { days = []; }
  let openCount = 0;
  days.forEach((d) => { d.shifts.forEach((sh) => { if (!sh.assignee) openCount++; }); });
  let swapBadge = 0;
  try {
    const swaps = await SH.listSwaps();
    swaps.forEach((sw) => {
      if (sw.status !== 'pending') return;
      if (me.employeeId) { if (sw.to && String(sw.to.id) === me.employeeId) swapBadge++; }
      else swapBadge++;   // Admin sieht alle offenen Anfragen
    });
  } catch (e) {}
  return { ok: true, me: me, week: monday, days: days, openCount: openCount, swapBadge: swapBadge };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'shifts.manage', res)) return;

  if (req.method === 'GET') {
    let week = null;
    try { week = new URL(req.url, 'http://x').searchParams.get('week'); } catch (e) {}
    res.statusCode = 200;
    return res.end(JSON.stringify(await weekPayload(sess, week)));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const action = body && body.action;
  const week = body && body.week;
  const me = ident(sess);

  // Ohne Store ist nichts persistierbar -> ehrliche Rückmeldung + leere Woche.
  if (!SH.hasStore) {
    res.statusCode = 200;
    const p = await weekPayload(sess, week);
    p.ok = false; p.disabled = true; p.message = 'Schichtplan-Speicher nicht verfügbar – Änderungen sind nicht möglich.';
    return res.end(JSON.stringify(p));
  }

  async function done(extra) {
    const p = await weekPayload(sess, week);
    res.statusCode = 200;
    return res.end(JSON.stringify(Object.assign(p, extra || {})));
  }
  async function fail(message) {
    const p = await weekPayload(sess, week);
    p.ok = false; p.message = message;
    res.statusCode = 200;
    return res.end(JSON.stringify(p));
  }

  if (action === 'create') {
    const shift = await SH.createShift({
      date: body.date, start: body.start, end: body.end, role: body.role,
      assignee: body.assignee || null, note: body.note,
    });
    if (!shift) return fail('Bitte Datum und Zeiten (z. B. 06:00) prüfen.');
    return done({ shift: shift });
  }

  if (action === 'update') {
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const patch = {};
    ['date', 'start', 'end', 'role', 'assignee', 'note', 'applicants'].forEach((k) => { if (has(k)) patch[k] = body[k]; });
    const shift = await SH.updateShift(id, patch);
    if (!shift) return fail('Schicht konnte nicht gespeichert werden.');
    return done({ shift: shift });
  }

  if (action === 'delete') {
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    await SH.deleteShift(id);
    return done();
  }

  if (action === 'claim') {
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    if (!me.employeeId) return fail('Bitte als Trainer anmelden oder im Editor zuweisen.');
    const shift = await SH.getShift(id);
    if (!shift) return fail('Schicht nicht gefunden.');
    if (shift.assignee) return fail('Diese Schicht ist bereits vergeben.');
    await SH.updateShift(id, { assignee: { id: me.employeeId, name: me.name, initials: me.initials }, board: false });
    return done();
  }

  if (action === 'board' || action === 'unboard') {
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const shift = await SH.getShift(id);
    if (!shift) return fail('Schicht nicht gefunden.');
    const own = !!(shift.assignee && me.employeeId && String(shift.assignee.id) === me.employeeId);
    if (me.role !== 'admin' && !own) return fail('Nur eigene Schichten können ans Schwarze Brett.');
    if (action === 'board' && !shift.assignee) return fail('Offene Schichten stehen bereits unter „Offen".');
    await SH.updateShift(id, { board: action === 'board' });
    return done();
  }

  // Woche aus der festen Wochen-Schichtvorlage füllen (nur LEERE Tage – nie doppelt).
  // Das sind die tatsächlichen Studio-Schichten (Mo–Fr 5, Sa 2, So 2) – kein Magicline-Call.
  if (action === 'fillTemplate') {
    const dates = SH.weekDates(SH.mondayOf(week));
    const filled = {};
    try { const dw = await SH.listWeek(dates); dw.forEach((d) => { filled[d.date] = d.shifts.length; }); } catch (e) {}
    const specs = SH.templateSpecs(dates);
    let created = 0, skippedDays = 0;
    const seenDays = {};
    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      if (filled[sp.date]) { if (!seenDays[sp.date]) { seenDays[sp.date] = 1; skippedDays++; } continue; }
      try { const sh = await SH.createShift(sp); if (sh) created++; } catch (e) {}
    }
    const note = created
      ? (created + ' Schichten aus dem Wochenplan angelegt' + (skippedDays ? (' (' + skippedDays + ' Tage mit bestehenden Schichten übersprungen)') : '') + '. Jetzt Mitarbeiter zuweisen.')
      : (skippedDays ? 'Alle Tage haben bereits Schichten – nichts hinzugefügt.' : 'Für diese Woche keine Schichten in der Vorlage.');
    return done({ created: created, filledFromTemplate: true, message: note });
  }

  // Woche aus den Magicline-Öffnungszeiten füllen (nur LEERE Tage – nie doppelt).
  if (action === 'fillFromHours') {
    let oh = null;
    try {
      const r = await M.ml('GET', '/studios/information');
      if (r && r.status >= 200 && r.status < 300 && r.json) oh = r.json.openingHours || r.json.publicOpeningHours || null;
    } catch (e) {}
    if (!Array.isArray(oh) || !oh.length) return fail('Öffnungszeiten sind gerade nicht abrufbar (Berechtigung STUDIO_READ nötig).');
    const dates = SH.weekDates(SH.mondayOf(week));
    let filled = {};
    try { const dw = await SH.listWeek(dates); dw.forEach((d) => { filled[d.date] = d.shifts.length; }); } catch (e) {}
    const specs = SH.shiftSpecsFromHours(dates, oh, { split: body.split, blockHours: body.blockHours });
    let created = 0, skippedDays = 0;
    const seenDays = {};
    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      if (filled[sp.date]) { if (!seenDays[sp.date]) { seenDays[sp.date] = 1; skippedDays++; } continue; }
      try { const sh = await SH.createShift(sp); if (sh) created++; } catch (e) {}
    }
    const note = created
      ? (created + ' Schichten aus den Öffnungszeiten angelegt' + (skippedDays ? (' (' + skippedDays + ' Tage mit bestehenden Schichten übersprungen)') : '') + '. Jetzt Mitarbeiter zuweisen.')
      : (skippedDays ? 'Alle geöffneten Tage haben bereits Schichten – nichts hinzugefügt.' : 'Für diese Woche keine Öffnungszeiten gefunden.');
    return done({ created: created, filledFromHours: true, message: note });
  }

  if (action === 'plan') {
    const r = await SH.planWeek(SH.weekDates(SH.mondayOf(week)));
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, proposals: r.proposals, leftover: r.leftover, summary: r.summary }));
  }

  if (action === 'apply') {
    const r = await SH.applyPlan(body && body.assignments);
    return done({ applied: r.applied });
  }

  res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
