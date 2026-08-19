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
 *     avail-set     { employeeId?, blocks, soft }  Verfügbarkeit als Schichtblöcke
 *     vac-create    { employeeId?, from, to, kind?, note? }
 *     vac-decide    { id, ok }                     NUR Leitung
 *     vac-delete    { id }                          eigene offene, sonst Leitung
 *     post          { id, mode:'apply'|'instant', deadline? }   NUR Leitung
 *     unpost        { id }                          NUR Leitung
 *     apply-shift   { id }                          eigene Bewerbung
 *     withdraw      { id }                          eigene Bewerbung zurückziehen
 *     accept-applicant { id, employeeId }           NUR Leitung
 *
 * Rollen: `shifts.manage` haben Leitung UND Trainer – das reicht fürs
 * Tagesgeschäft, aber nicht für Leitungsakte. Wer entscheidet, ausschreibt oder
 * für andere einträgt, braucht zusätzlich die Admin-Rolle. Das steht hier im
 * Endpunkt, nicht in der Oberfläche: Verstecken ist keine Sperre.
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
  return { employeeId: employeeId, name: name, role: TA.roleOf(sess) || 'trainer', initials: SH.initialsOf(name) };
}
function istLeitung(sess) { return TA.roleOf(sess) === 'admin'; }

// Frische Wochen-Antwort (GET-Form) – wird auch nach Mutationen mitgeliefert.
async function weekPayload(sess, week) {
  const me = ident(sess);
  const leitung = istLeitung(sess);
  const monday = SH.mondayOf(week);
  const dates = SH.weekDates(monday);
  let days = [];
  try { days = await SH.listWeek(dates); } catch (e) { days = []; }
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

  // Verfügbarkeiten: die Leitung plant damit und sieht deshalb alle. Eine
  // Angestellte sieht nur die eigene – ihre Zeiten sind ihre Sache.
  let availability = [];
  try {
    availability = leitung ? await SH.allAvailBlocks()
      : (me.employeeId
        ? [Object.assign({ employeeId: me.employeeId }, await SH.getAvailBlocks(me.employeeId))]
        : []);
  } catch (e) { availability = []; }

  // Urlaub: das laufende Jahr, damit Jahreskalender und Kollisionswarnung
  // rechnen können. Angestellte sehen nur die eigenen Anträge.
  let vacations = [];
  try {
    const jahr = monday.slice(0, 4);
    const opts = { fromISO: jahr + '-01-01', toISO: (parseInt(jahr, 10) + 1) + '-12-31' };
    if (!leitung) opts.employeeId = me.employeeId || '__keine__';
    vacations = await SH.listVacations(opts);
  } catch (e) { vacations = []; }
  const vacPending = vacations.filter((v) => v.status === 'pending').length;

  // Stammdaten + gerechnete Monatsstunden. Die Stunden werden aus den Schichten
  // gerechnet, nicht gepflegt – gepflegte Zahlen laufen auseinander.
  //
  // Wer eingeplant ist oder Zeiten gemeldet hat, aber noch keinen Stammsatz hat,
  // kommt trotzdem mit (stored:false). Sonst wäre er im Plan sichtbar und in der
  // Mitarbeiterliste unsichtbar – und niemand käme darauf, ihn anzulegen.
  let staff = [];
  try {
    staff = await SH.allStaff();
    const bekannt = {};
    staff.forEach((s) => { bekannt[String(s.id)] = 1; });
    const fehlend = {};
    days.forEach((d) => {
      d.shifts.forEach((sh) => {
        if (sh.assignee && sh.assignee.id != null && !bekannt[String(sh.assignee.id)]) {
          fehlend[String(sh.assignee.id)] = sh.assignee.name || null;
        }
      });
    });
    availability.forEach((a) => { if (!bekannt[String(a.employeeId)]) fehlend[String(a.employeeId)] = a.name || null; });
    vacations.forEach((v) => { if (!bekannt[String(v.employeeId)]) fehlend[String(v.employeeId)] = v.name || null; });
    const fehlendeIds = Object.keys(fehlend);
    if (fehlendeIds.length) staff = staff.concat(await SH.staffByIds(fehlendeIds, fehlend));
    staff.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
    const std = await SH.monthHours(monday);
    staff.forEach((s) => { s.monthHours = std[String(s.id)] || 0; });
  } catch (e) { staff = []; }

  return {
    ok: true, me: me, week: monday, days: days,
    openCount: openCount, swapBadge: swapBadge,
    availability: availability, vacations: vacations, vacPending: vacPending,
    staff: staff, blocks: SH.WEEKLY_TEMPLATE, areas: SH.AREAS, canDecide: leitung,
  };
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

  // ── Verfügbarkeit als Schichtblöcke ──
  // Für sich selbst darf jede angemeldete Person melden. Für andere nur die
  // Leitung – und dann wird die Angabe als „von Leitung eingetragen" markiert,
  // damit später niemand glaubt, die Person hätte das selbst gemeldet.
  if (action === 'avail-set') {
    const fremd = String((body && body.employeeId) || '').trim();
    const eigen = !fremd || (me.employeeId && fremd === me.employeeId);
    if (!eigen && !istLeitung(sess)) return fail('Nur die Leitung darf Zeiten für andere eintragen.');
    const ziel = eigen ? me.employeeId : fremd;
    if (!ziel) return fail('Bitte als Mitarbeiter anmelden oder eine Person auswählen.');
    const name = eigen ? me.name : String((body && body.name) || '').trim();
    const r = await SH.setAvailBlocks(ziel, name, body && body.blocks, body && body.soft, eigen ? 'self' : 'lead');
    if (!r) return fail('Verfügbarkeit konnte nicht gespeichert werden.');
    return done({ availability: r });
  }

  // ── Urlaub ──
  if (action === 'vac-create') {
    const fremd = String((body && body.employeeId) || '').trim();
    const eigen = !fremd || (me.employeeId && fremd === me.employeeId);
    if (!eigen && !istLeitung(sess)) return fail('Nur die Leitung darf Urlaub für andere eintragen.');
    const ziel = eigen ? me.employeeId : fremd;
    if (!ziel) return fail('Bitte als Mitarbeiter anmelden oder eine Person auswählen.');
    const v = await SH.createVacation({
      employeeId: ziel, name: eigen ? me.name : String((body && body.name) || '').trim(),
      from: body && body.from, to: body && body.to, kind: body && body.kind, note: body && body.note,
    });
    if (!v) return fail('Bitte Zeitraum prüfen (Datum im Format 2026-10-19, höchstens 90 Tage).');
    return done({ vacation: v });
  }

  if (action === 'vac-decide') {
    if (!istLeitung(sess)) return fail('Über Urlaub entscheidet die Leitung.');
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const v = await SH.decideVacation(id, !!(body && body.ok), me);
    if (!v) return fail('Antrag nicht gefunden.');
    return done({ vacation: v });
  }

  // Zurückziehen darf man den eigenen – aber nur, solange er offen ist.
  // Ein genehmigter Urlaub ist eine Zusage und verschwindet nicht still.
  if (action === 'vac-delete') {
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const v = await SH.getVacation(id);
    if (!v) return fail('Antrag nicht gefunden.');
    const eigen = !!(me.employeeId && String(v.employeeId) === me.employeeId);
    if (!istLeitung(sess) && !eigen) return fail('Nur eigene Anträge lassen sich zurückziehen.');
    if (!istLeitung(sess) && v.status !== 'pending') return fail('Der Antrag ist bereits entschieden – bitte an die Leitung wenden.');
    await SH.deleteVacation(id);
    return done();
  }

  // ── Ausschreibungen ──
  if (action === 'post' || action === 'unpost') {
    if (!istLeitung(sess)) return fail('Ausschreiben ist Sache der Leitung.');
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const sh = action === 'post'
      ? await SH.postShift(id, body && body.mode, body && body.deadline)
      : await SH.unpostShift(id);
    if (!sh) return fail('Schicht nicht gefunden.');
    return done({ shift: sh });
  }

  if (action === 'apply-shift' || action === 'withdraw') {
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    if (!me.employeeId) return fail('Bitte mit dem persönlichen Zugang anmelden.');
    const sh = action === 'apply-shift'
      ? await SH.applyForShift(id, { id: me.employeeId, name: me.name, initials: me.initials })
      : await SH.withdrawApplication(id, me.employeeId);
    if (!sh) return fail(action === 'apply-shift' ? 'Diese Schicht ist nicht mehr frei.' : 'Bewerbung nicht gefunden.');
    return done({ shift: sh });
  }

  if (action === 'accept-applicant') {
    if (!istLeitung(sess)) return fail('Über Bewerbungen entscheidet die Leitung.');
    const id = String((body && body.id) || '').trim();
    const who = String((body && body.employeeId) || '').trim();
    if (!id || !who) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const r = await SH.acceptApplicant(id, who);
    if (!r) return fail('Bewerbung nicht gefunden.');
    return done({ shift: r.shift, accepted: r.accepted, rejected: r.rejected });
  }

  // ── Mitarbeiter-Stammdaten ──
  // Bereich, Stundengrenze und Urlaubsanspruch entscheiden mit, wer eingeplant
  // werden darf. Das ist eine Leitungsentscheidung, keine Einstellung.
  if (action === 'staff-set') {
    if (!istLeitung(sess)) return fail('Mitarbeiterdaten pflegt die Leitung.');
    const id = String((body && body.employeeId) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const patch = {};
    ['name', 'type', 'areas', 'monthMax', 'vacDays', 'active'].forEach((k) => { if (has(k)) patch[k] = body[k]; });
    const e = await SH.setStaff(id, patch);
    if (!e) return fail('Mitarbeiter konnte nicht gespeichert werden.');
    return done({ staffMember: e });
  }

  if (action === 'staff-remove') {
    if (!istLeitung(sess)) return fail('Mitarbeiterdaten pflegt die Leitung.');
    const id = String((body && body.employeeId) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    await SH.removeStaff(id);
    return done();
  }

  // Aus Magicline uebernehmen: legt fehlende Stammdaten an, ruehrt bestehende
  // NICHT an – sonst waeren gepflegte Bereiche und Grenzen nach jedem Import weg.
  if (action === 'staff-import') {
    if (!istLeitung(sess)) return fail('Mitarbeiterdaten pflegt die Leitung.');
    let liste = [];
    try {
      const r = await M.ml('GET', '/employees?sliceSize=50');
      if (r && r.status === 200 && r.json) {
        liste = Array.isArray(r.json.result) ? r.json.result : (Array.isArray(r.json) ? r.json : []);
      }
    } catch (e) {}
    if (!liste.length) return fail('Mitarbeiterliste ist gerade nicht abrufbar (Berechtigung EMPLOYEE_READ nötig).');
    const vorhanden = {};
    try { (await SH.allStaff()).forEach((s) => { vorhanden[String(s.id)] = 1; }); } catch (e) {}
    let neu = 0;
    for (let i = 0; i < liste.length; i++) {
      const e = liste[i];
      if (!e || e.id == null) continue;
      const id = String(e.id);
      if (vorhanden[id]) continue;
      const name = ((String(e.firstName || '').trim() + ' ' + String(e.lastName || '').trim()).trim())
        || String(e.publicName || e.name || '').trim() || ('Mitarbeiter ' + id);
      const r2 = await SH.setStaff(id, { name: name });
      if (r2) neu++;
    }
    return done({
      imported: neu,
      message: neu ? (neu + ' Mitarbeiter übernommen. Bitte Bereich und Stundengrenze prüfen.')
        : 'Alle Mitarbeiter sind bereits angelegt – bestehende Angaben bleiben unverändert.',
    });
  }

  res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
