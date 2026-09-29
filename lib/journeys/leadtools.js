'use strict';

/**
 * FINN Journeys – Werkzeuge des Lead-Agenten auf WhatsApp (in lib/finn/tools.js registriert).
 * -----------------------------------------------------------------------------
 *   trialSlots(ctx, a)   freie Probetraining-Termine (Connect-API, ohne Schlüssel)
 *   bookTrial(ctx, a)    buchen – NUR nach Bestätigung (Risiko MEDIUM); die Rufnummer kommt
 *                        aus dem Webhook (ctx.phone), nie vom Modell. Danach: Lead-Pipeline,
 *                        Einwilligung für Terminerinnerungen (stand in der Bestätigung),
 *                        Erinnerungen einplanen, Notiz fürs Team.
 *   saveProfile(ctx, a)  Ziel / Erfahrung / Tageszeit als feste Werte (keine Gesundheitsdaten)
 */

const Phone = require('../phone');
const TB = require('../trialBooking');

const GOALS = ['abnehmen', 'muskelaufbau', 'fitness', 'gesundheit', 'sonstiges'];
const EXP = ['einsteiger', 'wiedereinsteiger', 'erfahren'];
const DAYPART = ['morgens', 'mittags', 'abends', 'egal'];

function ML() { return require('../finn/magicline'); }
function fail(code, detail) { const r = ML().fail(code, { status: 0 }); if (detail) r.detail = String(detail).slice(0, 400); return r; }

async function trialSlots(ctx, a) {
  const r = await TB.freeSlots({ from: a.from, daypart: a.daypart, days: 7, limit: 6 });
  if (!r.ok) return fail('unavailable');
  return ML().ok({ slots: r.slots, hinweis: r.slots.length ? 'Biete 2–3 davon an. Für book_trial startDateTime EXAKT übernehmen.' : 'In diesem Zeitraum nichts frei – anderen Tag oder andere Tageszeit vorschlagen.' });
}

async function bookTrial(ctx, a) {
  const phone = Phone.canon(ctx && ctx.phone);
  if (!phone) return fail('no_phone', 'Buchung nur per WhatsApp möglich – auf der Website bitte das Probetraining-Formular nutzen.');
  const r = await TB.book({ startDateTime: a.startDateTime, firstname: a.firstname, lastname: a.lastname, dateOfBirth: a.dateOfBirth, email: a.email, phone: '+' + phone }, { source: 'whatsapp' });
  if (!r.ok) {
    if (r.error === 'missing') return fail('invalid', 'Es fehlt: ' + r.missing.join(', '));
    if (r.error === 'slot_unavailable') return fail('slot_unavailable', 'Termin nicht mehr frei. Frei wäre: ' + (r.freeSlots || []).map((s) => s.label + ' (' + s.startDateTime + ')').join(', '));
    if (r.error === 'already_booked') return fail('already_booked', 'Für diese Person ist schon ein Probetraining gebucht – nicht erneut buchen, ans Team übergeben.');
    return fail('booking_failed', 'Buchung ging nicht – Übergabe ans Team anbieten.');
  }
  const trialAt = Date.parse(r.startDateTime);
  const name = (String(a.firstname || '') + ' ' + String(a.lastname || '')).trim();
  let lead = null;
  try {
    const LF = require('../leadflow');
    lead = await LF.recordLead({ phone: phone, name: name, email: r.emailPlaceholder ? null : a.email, source: 'whatsapp', customerId: r.customerId, trialAt: trialAt });
  } catch (e) {}
  // Die Bestätigung nannte die WhatsApp-Erinnerungen ausdrücklich -> Einwilligung „service".
  try { await require('./consent').grant(phone, ['service'], { src: 'whatsapp_booking', leadId: lead && lead.id }); } catch (e) {}
  try { await require('./hooks').onTrialBooked({ leadId: lead && lead.id, customerId: r.customerId, phone: phone, firstName: a.firstname, trialAt: trialAt, source: 'whatsapp' }); } catch (e) {}
  try { await require('../phoneApi').rememberLead(phone, { customerId: r.customerId, customerNumber: r.customerNumber }); } catch (e) {}
  // Team: Notiz + Hinweis (Platzhalter für Adresse/E-Mail in Magicline ersetzen).
  try {
    if (ctx.inboxId && ctx.vorgangId) {
      const Inbox = require('../inbox');
      const flags = []; if (r.emailPlaceholder) flags.push('E-Mail'); if (r.addressPlaceholder) flags.push('Anschrift');
      await Inbox.addNote(ctx.inboxId, ctx.vorgangId, { author: 'FINN', text: 'Probetraining per WhatsApp gebucht: ' + r.label + ' (' + name + ').' + (flags.length ? (' Platzhalter in Magicline ersetzen: ' + flags.join(' + ') + '.') : '') });
      if (flags.length) await Inbox.alertTeam(ctx.inboxId, ctx.vorgangId);
    }
  } catch (e) {}
  let askMarketing = false;
  try { const c = await require('./consent').get(phone); askMarketing = !c.marketing && !c.suppressed; } catch (e) {}
  return ML().ok({ booked: true, label: r.label, startDateTime: r.startDateTime, askMarketing: askMarketing });
}

async function saveProfile(ctx, a) {
  const phone = Phone.canon(ctx && ctx.phone);
  if (!phone) return ML().ok({ saved: false });
  const Store = require('./store');
  const subj = await Store.forPhone(phone);
  if (!subj || !Store.isLeadId(subj)) return ML().ok({ saved: false, hinweis: 'weiter im Gespräch' });
  const st = await Store.load(subj);
  if (!st) return ML().ok({ saved: false });
  st.facts.profile = Object.assign({}, st.facts.profile || {},
    GOALS.indexOf(a.goal) >= 0 ? { goal: a.goal } : {}, EXP.indexOf(a.experience) >= 0 ? { exp: a.experience } : {}, DAYPART.indexOf(a.daypart) >= 0 ? { daypart: a.daypart } : {});
  await Store.save(st);
  return ML().ok({ saved: true });
}

module.exports = { trialSlots, bookTrial, saveProfile, GOALS, EXP, DAYPART };
