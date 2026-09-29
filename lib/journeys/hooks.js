'use strict';

/**
 * FINN Journeys – Ereignisse aus Magicline und den eigenen Buchungswegen.
 * -----------------------------------------------------------------------------
 * Die Webhook-Handler werden in lib/finn/automations.register() angemeldet und
 * laufen NACH der Bestandsverarbeitung (Willkommensmail, Feeds bleiben unberührt).
 * Sie schreiben nur in jr:* und planen die Person neu ein – gesendet wird im
 * Durchlauf (api/journeys-tick), damit Ruhezeiten und Kappen immer greifen.
 *
 *   CUSTOMER_CHECKIN              Besuch zählen, Index, erster Besuch, Probetraining erschienen
 *   CONTRACT_CREATED              Lead gewonnen, Onboarding starten, ab jetzt vollständig zählen
 *   APPOINTMENT_BOOKING_*         Einführungstraining gebucht / Probetraining gebucht/storniert
 *   CONTRACT_CANCELLED/REVERSED   Motivation beenden
 *   CUSTOMER_PAYMENT_REJECTED     30 Tage keine Motivation
 *
 * Eigene Einstiege (ohne Webhook):
 *   onLeadContact({ leadId, phone, firstName, inbox, source })     erster WhatsApp-Kontakt
 *   onTrialBooked({ leadId, customerId, phone, firstName, trialAt, source, consent })
 */

const KV = require('../finn/kv');
const Phone = require('../phone');
const Config = require('./config');
const Store = require('./store');
const Engine = require('./engine');
const Engagement = require('./engagement');
const Consent = require('./consent');
const KPI = require('./kpi');

const HOUR = 3600000, MIN = 60000;
const BK_TTL = 90 * 86400;

function evTime(e) {
  try {
    const Events = require('../finn/events');
    const t = Date.parse(Events.timeOf(e) || '');
    return isFinite(t) && t > 0 ? t : Date.now();
  } catch (x) { return Date.now(); }
}
function payload(e) { return (e && (e.content || e.payload || e.data)) || {}; }
function firstNameOf(n) { const f = String(n || '').trim().split(/\s+/)[0] || ''; return /^[A-Za-zÄÖÜäöüß'’-]{2,24}$/.test(f) ? f : null; }

async function leadSubjectFor(cid) {
  try { const lead = await require('../leadflow').getLeadByCustomer(cid); return lead ? lead : null; } catch (e) { return null; }
}
async function touch(st, now) { await Store.save(st); await Store.schedule(st.subj, now || Date.now()); }

// ── Webhooks ──
async function onCheckin(rec, e) {
  if (!Config.tracking() || !Store.isMemberId(rec.cid)) return { skipped: 'off' };
  const at = evTime(e);
  await Store.index(rec.cid, at);
  const v = await Engagement.recordVisit(rec.cid, at);
  if (!Config.on()) return { counted: v.counted };
  const st = await Store.load(rec.cid);
  if (st) {
    const ob = st.runs && st.runs.onboarding;
    if (ob && !ob.exit && !st.facts.firstVisitAt && (!st.facts.joinAt || at >= st.facts.joinAt - 24 * HOUR)) st.facts.firstVisitAt = at;
    await touch(st);
  }
  // Probetraining erschienen? (Check-in der Lead-Kunden-Id rund um den Termin)
  const lead = await leadSubjectFor(rec.cid);
  if (lead) {
    const ls = await Store.load(lead.id);
    if (ls && ls.facts.trialAt && !ls.facts.showedAt && at >= ls.facts.trialAt - 60 * MIN && at <= ls.facts.trialAt + 90 * MIN) {
      ls.facts.showedAt = at;
      await touch(ls);
      await KPI.bump('lead', 'trial_showed');
      try { const LF = require('../leadflow'); if (['neu', 'kontaktiert', 'probetraining'].indexOf(lead.status) >= 0) await LF.setLeadStatus(lead.id, 'erschienen'); } catch (x) {}
    }
  }
  return { counted: v.counted };
}

async function onContract(rec, e) {
  if (!Store.isMemberId(rec.cid)) return { skipped: 'no_cid' };
  const at = evTime(e);
  // Lead gewonnen – unabhängig von Journeys (Pipeline-Pflege).
  let lead = null;
  try { lead = await require('../leadflow').markWonByCustomer(rec.cid); } catch (x) {}
  if (!Config.tracking()) return { won: !!lead };
  await Store.index(rec.cid, at);
  await Engagement.startTracking(rec.cid, at);
  if (!Config.on()) return { won: !!lead };
  if (lead) {
    const ls = await Store.load(lead.id);
    if (ls) { ls.facts.wonAt = at; Engine.exitRun(ls, 'lead', 'won', at); await Store.save(ls); await Store.unschedule(ls.subj); await KPI.bump('lead', 'won'); }
  }
  const st = await Store.loadOrCreate(rec.cid);
  st.facts.joinAt = st.facts.joinAt || at;
  st.facts.needsProfile = true;                   // Vorname + Nummer holt der Durchlauf aus Magicline
  if (lead) {
    if (!st.phone && lead.phone) st.phone = Phone.canon(lead.phone) || null;
    if (!st.firstName && lead.name) st.firstName = firstNameOf(lead.name);
    st.leadId = lead.id;
  }
  Engine.enroll(st, 'onboarding', at);
  // Motivation erst mit Einwilligung – sonst schreibt der Tagesdurchlauf sie später ein.
  if (st.phone && (await Consent.get(st.phone)).marketing) Engine.enroll(st, 'habit', at);
  if (st.phone) await Store.linkPhone(st.phone, st.subj);
  await touch(st);
  return { onboarding: true, won: !!lead };
}

async function onAppointment(rec, e) {
  if (!Config.on()) return { skipped: 'off' };
  const p = payload(e);
  const bid = rec.entityId || p.bookingId || p.id;
  if (bid == null) return { skipped: 'no_booking' };
  let appt = null;
  try { appt = await require('../mlEvents').getAppointment(bid); } catch (x) {}
  const cid = (appt && appt.customerId) || rec.cid || p.customerId || null;
  const title = String((appt && appt.title) || p.title || p.name || '');
  const start = Date.parse((appt && appt.start) || p.startDateTime || '');
  if (!Store.isMemberId(cid)) return { skipped: 'no_cid' };
  if (/einf[üu]hrung/i.test(title)) {
    const st = await Store.load(cid);
    if (st) { st.facts.inductionBookedAt = Date.now(); await KV.set('jr:bk:' + bid, { subj: st.subj, k: 'induction' }, BK_TTL); await touch(st); }
    return { induction: true };
  }
  if (/probe/i.test(title) && isFinite(start)) {
    const lead = await leadSubjectFor(cid);
    if (lead) {
      await setTrial(lead.id, { trialAt: start, bookedAt: Date.now(), customerId: cid });
      await KV.set('jr:bk:' + bid, { subj: lead.id, k: 'trial' }, BK_TTL);
      return { trial: true };
    }
  }
  return { skipped: 'other' };
}

async function onAppointmentCancelled(rec, e) {
  if (!Config.on()) return { skipped: 'off' };
  const p = payload(e);
  const bid = rec.entityId || p.bookingId || p.id;
  const m = bid != null ? await KV.getJSON('jr:bk:' + bid) : null;
  if (!m) return { skipped: 'unknown' };
  const st = await Store.load(m.subj);
  if (!st) return { skipped: 'no_state' };
  if (m.k === 'induction') st.facts.inductionBookedAt = null;
  if (m.k === 'trial') st.facts.trialCancelledAt = Date.now();
  await touch(st);
  return { cancelled: m.k };
}

async function onContractEnd(rec, e) {
  if (!Config.on() || !Store.isMemberId(rec.cid)) return { skipped: 'off' };
  const st = await Store.load(rec.cid);
  if (!st) return { skipped: 'no_state' };
  st.facts.cancelled = evTime(e);
  await touch(st);
  return { cancelled: true };
}

async function onPayment(rec, e) {
  if (!Config.on() || !Store.isMemberId(rec.cid)) return { skipped: 'off' };
  const st = await Store.load(rec.cid);
  if (!st) return { skipped: 'no_state' };
  st.facts.paymentIssueAt = evTime(e);
  await Store.save(st);
  return { payment: true };
}

function register(Events) {
  Events.on('CUSTOMER_CHECKIN', onCheckin);
  Events.on('CONTRACT_CREATED', onContract);
  Events.on('APPOINTMENT_BOOKING_CREATED', onAppointment);
  Events.on('APPOINTMENT_BOOKING_UPDATED', onAppointment);
  Events.on('APPOINTMENT_BOOKING_CANCELLED', onAppointmentCancelled);
  Events.on('CONTRACT_CANCELLED', onContractEnd);
  Events.on('CONTRACT_REVERSED', onContractEnd);
  Events.on('CUSTOMER_PAYMENT_REJECTED', onPayment);
}

// ── Eigene Einstiege ──

// Lead-Zustand anlegen/ergänzen. Liefert den Zustand (nicht gespeichert).
async function leadState(leadId, o) {
  const st = await Store.loadOrCreate(leadId);
  if (!st) return null;
  const p = Phone.canon(o.phone);
  if (p) { st.phone = p; await Store.linkPhone(p, st.subj); }
  if (o.firstName && !st.firstName) st.firstName = firstNameOf(o.firstName);
  if (o.customerId && Store.isMemberId(o.customerId)) st.cid = String(o.customerId);
  if (o.inbox) st.inbox = String(o.inbox);
  else if (!st.inbox) st.inbox = st.cid || (p ? ('wa' + p) : null);
  if (o.source && !st.facts.source) st.facts.source = String(o.source).slice(0, 20);
  return st;
}

// Erster Kontakt eines Interessenten (WhatsApp). Startet die Lead-Journey.
async function onLeadContact(o) {
  o = o || {};
  if (!Config.on() || !Store.isLeadId(o.leadId)) return null;
  const st = await leadState(o.leadId, o);
  if (!st) return null;
  const now = Date.now();
  st.facts.leadAt = st.facts.leadAt || now;
  Engine.enroll(st, 'lead', now);
  await touch(st, now + 60 * MIN);
  return st;
}

async function setTrial(leadId, o) {
  const st = await leadState(leadId, o);
  if (!st) return null;
  const changed = st.facts.trialAt !== o.trialAt;
  st.facts.trialAt = o.trialAt;
  st.facts.trialBookedAt = o.bookedAt || Date.now();
  st.facts.trialCancelledAt = null;
  st.facts.leadAt = st.facts.leadAt || st.facts.trialBookedAt;
  if (!Engine.enroll(st, 'lead', st.facts.trialBookedAt) && changed) Engine.reopen(st, 'lead', ['trial_', 'after', 'offer', 'last']);
  await touch(st);
  return st;
}

// Probetraining gebucht (Website, Telefon, WhatsApp). consent: { service, marketing } aus dem Formular.
async function onTrialBooked(o) {
  o = o || {};
  const p = Phone.canon(o.phone);
  // Einwilligung IMMER festhalten – auch wenn Journeys (noch) aus sind.
  if (p && o.consent && (o.consent.service || o.consent.marketing)) {
    const types = []; if (o.consent.service) types.push('service'); if (o.consent.marketing) types.push('marketing');
    await Consent.grant(p, types, { src: String(o.source || 'probetraining').slice(0, 30), leadId: o.leadId || null });
  }
  if (!Config.on() || !Store.isLeadId(o.leadId) || !isFinite(o.trialAt)) return null;
  const st = await setTrial(o.leadId, { phone: p, firstName: o.firstName, customerId: o.customerId, trialAt: o.trialAt, bookedAt: Date.now(), source: o.source });
  await KPI.bump('lead', 'trial_booked');
  return st;
}

module.exports = { register, onCheckin, onContract, onAppointment, onAppointmentCancelled, onContractEnd, onPayment, onLeadContact, onTrialBooked, setTrial };
