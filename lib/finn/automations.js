'use strict';

/**
 * FINN – Automationen auf Webhook-Events.
 * -----------------------------------------------------------------------------
 * Laufen NACH der bestehenden Verarbeitung (Willkommensmail, Feeds, Team-Mails
 * bleiben unverändert) und schreiben nur in den eigenen KV:
 *   timeline   – Ereignis in die Kunden-Timeline (Team-Profil → FINN-Verlauf)
 *   retention  – Signal für die Rückholung (finnsig:<cid>, 90 Tage)
 *   vorgang    – zusätzlich ein Postfach-Vorgang fürs Team (Zahlungsproblem,
 *                Rückholung) – OPT-IN, weil es den Posteingang füllt
 * Steuerung: FINN_AUTOMATIONS (kommagetrennt), Standard „timeline,retention".
 * Es wird KEINE zweite E-Mail verschickt und nichts in Magicline verändert.
 */

const Events = require('./events');
const Timeline = require('./timeline');
const KV = require('./kv');

const SIG_TTL = 90 * 86400;

function enabled(name) {
  const v = String(process.env.FINN_AUTOMATIONS == null ? 'timeline,retention' : process.env.FINN_AUTOMATIONS).split(',').map((s) => s.trim());
  return v.indexOf(name) >= 0 || v.indexOf('all') >= 0;
}

const TITLES = {
  CONTRACT_CREATED: ['contract', 'Vertrag abgeschlossen'],
  CONTRACT_CANCELLED: ['contract', 'Vertrag gekündigt (Magicline)'],
  CONTRACT_REVERSED: ['contract', 'Vertrag widerrufen/rückabgewickelt'],
  CUSTOMER_PAYMENT_REJECTED: ['payment', 'Zahlung abgelehnt'],
  APPOINTMENT_BOOKING_CREATED: ['appointment', 'Termin gebucht'],
  APPOINTMENT_BOOKING_UPDATED: ['appointment', 'Termin geändert'],
  APPOINTMENT_BOOKING_CANCELLED: ['appointment', 'Termin storniert'],
  CUSTOMER_CHECKIN: ['checkin', 'Check-in'],
  CUSTOMER_CREATED: ['lead', 'Als Kunde/Lead angelegt'],
};

async function signal(cid, kind, type) {
  if (!cid) return;
  const cur = (await KV.getJSON('finnsig:' + cid)) || { signals: [] };
  cur.signals = (cur.signals || []).filter((s) => s.kind !== kind).concat([{ kind: kind, type: type, at: Date.now() }]).slice(-8);
  await KV.set('finnsig:' + cid, cur, SIG_TTL);
}
async function signals(cid) { const v = cid ? await KV.getJSON('finnsig:' + cid) : null; return (v && v.signals) || []; }

async function timelineEntry(rec) {
  if (!enabled('timeline')) return { skipped: 'off' };
  const t = TITLES[rec.type]; if (!t || !rec.cid) return { skipped: 'no_title' };
  await Timeline.add(rec.cid, { kind: t[0], title: t[1], source: 'webhook', detail: rec.type });
  return { timeline: true };
}

async function vorgang(rec, type, subject, teamText, priority) {
  if (!enabled('vorgang') || !rec.cid) return { skipped: 'off' };
  try {
    const Inbox = require('../inbox');
    const v = await Inbox.addVorgang(rec.cid, { type: type, subject: subject, status: 'bearbeitung', priority: priority || 'mittel', teamText: teamText, needsAction: true, notifyTeam: false });
    return { vorgang: v ? v.ref : null };
  } catch (e) { return { error: true }; }
}

function register() {
  Events._reset();
  Events.on('*', async (rec) => timelineEntry(rec));
  Events.on('CONTRACT_CREATED', async (rec) => { if (rec.cid) await KV.set('finn:onboarding:' + rec.cid, { at: Date.now(), step: 'welcome' }, 60 * 86400); return { onboarding: true }; });
  Events.on('CUSTOMER_PAYMENT_REJECTED', async (rec) => {
    if (enabled('retention')) await signal(rec.cid, 'payment', rec.type);
    return vorgang(rec, 'allgemein', 'Zahlungsproblem (Magicline)', 'Magicline meldet eine abgelehnte Zahlung. Bitte Beitragskonto prüfen und das Mitglied kontaktieren.', 'hoch');
  });
  Events.on('CONTRACT_CANCELLED', async (rec) => {
    if (enabled('retention')) await signal(rec.cid, 'cancel', rec.type);
    return vorgang(rec, 'angebot', 'Rückholung: Kündigung eingegangen', 'Der Vertrag wurde in Magicline gekündigt. Rückhol-Gespräch anbieten?', 'mittel');
  });
  Events.on('CONTRACT_REVERSED', async (rec) => { if (enabled('retention')) await signal(rec.cid, 'reversed', rec.type); return { signal: true }; });
}

module.exports = { register, enabled, signals, TITLES };
