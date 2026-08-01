'use strict';

/**
 * POST /api/webhooks/magicline?key=<secret>
 * Empfänger für Magicline-Webhooks (CONTRACT_CREATED, CUSTOMER_CREATED,
 * CONTRACT_CANCELLED).
 *
 * Aktuell umgesetzt: bei CONTRACT_CREATED bekommt das neue Mitglied automatisch
 * die Zugangs-/Willkommens-Mail (lib/welcome.js, mit Dedup gegen Doppelversand).
 * CUSTOMER_CREATED wird NICHT für die Willkommens-Mail genutzt (dabei kann es sich
 * um bloße Leads/Interessenten ohne Mitgliedschaft handeln) – stattdessen wird der
 * neue Kunde in die Team-Lead-Pipeline übernommen (lib/leadflow, source 'magicline',
 * idempotent per customerId). CONTRACT_CANCELLED/REVERSED lösen einen Rückholungs-
 * Hinweis ans Team aus.
 *
 * Sicherheit: Der Endpunkt löst E-Mail-Versand aus und ist öffentlich erreichbar.
 * Deshalb pflicht: ein Shared Secret (Env MAGICLINE_WEBHOOK_KEY, alt:
 * MAGICLINE_WEBHOOK_SECRET). Magicline sendet es als Header `x-api-key`; wir
 * akzeptieren zusätzlich `x-webhook-secret` sowie `?key=…` (Fallbacks). Ohne
 * gesetztes Secret ist der Endpunkt AUS (503). Falsches/fehlendes Secret -> 401.
 *
 * Antwortet ansonsten immer 200 (auch bei „ignoriert"/Versandfehler), damit
 * Magicline nicht unnötig retryt. Es wird NIE geworfen.
 */

const W = require('../../lib/welcome');
const NM = require('../../lib/newMembers');
const MlEvents = require('../../lib/mlEvents');

const SECRET = process.env.MAGICLINE_WEBHOOK_KEY || process.env.MAGICLINE_WEBHOOK_SECRET || '';
const MAX_EVENTS = 50;   // Sicherheitskappe

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Magicline kann ein Einzel-Event, ein { events:[…] } oder ein Array schicken.
function eventsFrom(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.events)) return body.events;
  if (body && Array.isArray(body.notifications)) return body.notifications;
  return [body || {}];
}
function typeOf(e) {
  return String((e && (e.type || e.eventType || e.event || e.notificationType || e.name)) || '').toUpperCase();
}
// Kunden-ID bestimmen. Laut offizieller Magicline-Doku ist bei Kunden-/Vertrags-
// Events die customerId gleich `entityId` (Zusatzdaten stehen unter `content`,
// z. B. content.contractId). Ältere/abweichende Formen als Fallback abgedeckt.
function customerIdOf(e) {
  if (!e) return null;
  const p = e.content || e.payload || e.data || {};
  const cand = e.entityId
    || e.customerId || e.customerID
    || p.customerId || p.customerID
    || (p.customer && p.customer.id)
    || (e.customer && e.customer.id)
    || e.objectId || e.referenceId;
  return cand != null ? String(cand) : null;
}

function payloadOf(e) { return (e && (e.content || e.payload || e.data)) || {}; }

// APPOINTMENT_BOOKING_*: bei diesen Events ist entityId die bookingId (NICHT die
// customerId). Fehlen Start/Titel im Event, laden wir den Termin über die API nach
// (best effort), damit der studioweite Feed vollständig ist.
async function onAppointmentUpsert(e) {
  const p = payloadOf(e);
  const bid = e.entityId || p.bookingId || p.id || e.objectId;
  if (bid == null) return false;
  let start = p.startDateTime || p.start || null;
  let end = p.endDateTime || p.end || null;
  let title = p.title || p.name || null;
  const cid = p.customerId || (p.customer && p.customer.id) || null;
  if (!start && cid) {
    try {
      const M = require('../../lib/members');
      const r = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(cid));
      const list = Array.isArray(r.json) ? r.json : [];
      const hit = list.find((a) => String(a.bookingId != null ? a.bookingId : (a.id != null ? a.id : a.appointmentId)) === String(bid));
      if (hit) { start = hit.startDateTime || start; end = hit.endDateTime || end; title = hit.title || hit.name || title; }
    } catch (e2) {}
  }
  if (!start) return false;
  return MlEvents.upsertAppointment({ bookingId: bid, title: title || 'Termin', start: start, end: end, customerId: cid });
}

// CUSTOMER_PAYMENT_REJECTED: Team benachrichtigen (E-Mail), damit Beitragskonto/
// Rückholung angestoßen werden kann. Best effort; NIE personenbezogen ins Log.
async function onPaymentRejected(cid) {
  try {
    const M = require('../../lib/members');
    const SR = require('../../lib/studioReply');
    let m = null; try { m = await M.getMember(cid); } catch (e) {}
    const name = m ? ((((m.firstName || '') + ' ' + (m.lastName || '')).trim()) || ('Mitglied ' + cid)) : ('Mitglied ' + cid);
    await SR.notifyStudio({
      member: m || { id: cid },
      subject: '⚠️ Zahlung abgelehnt – ' + name,
      text: 'Magicline meldet eine abgelehnte Zahlung (CUSTOMER_PAYMENT_REJECTED).\n\n'
        + 'Mitglied: ' + name + (m && m.customerNumber ? (' · Nr. ' + m.customerNumber) : '') + (m && m.email ? (' · ' + m.email) : '')
        + '\n\nBitte Beitragskonto prüfen und ggf. Rückholung/Mahnung anstoßen.',
    });
    return true;
  } catch (e) { return false; }
}

// Anzeigename für den Live-Check-in-Feed: bevorzugt aus dem Event, sonst einmal per
// getMember auflösen und 7 Tage in KV cachen (datensparsam: Vorname + Initial). Best effort.
function cleanName(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 80); }
async function checkinName(cid, p) {
  p = p || {};
  const fromEvent = cleanName(p.customerName || (p.customer && p.customer.name) || ((p.firstname || p.firstName || '') + ' ' + (p.lastname || p.lastName || '')).trim());
  if (fromEvent) return fromEvent;
  try {
    const { redisPipeline } = require('../../lib/store');
    try { const [c] = await redisPipeline([['GET', 'mlx:name:' + cid]]); if (c) return c; } catch (e) {}
    const M = require('../../lib/members');
    const m = await M.getMember(cid);
    const ln = String((m && m.lastName) || '').trim();
    const nm = cleanName(((m && m.firstName) || '') + (ln ? (' ' + ln.charAt(0).toUpperCase() + '.') : ''));
    if (nm) { try { await redisPipeline([['SET', 'mlx:name:' + cid, nm, 'EX', String(7 * 86400)]]); } catch (e) {} return nm; }
  } catch (e) {}
  return null;
}

// CUSTOMER_CREATED -> neuer Interessent/Kunde in Magicline (Walk-in, Web-Formular,
// Probetraining, Direkteintrag). In die Team-Lead-Pipeline übernehmen (source
// 'magicline'), idempotent per customerId. So tauchen auch NICHT über WhatsApp
// entstandene Leads im Team-Backend auf. Datensparsam: Name, E-Mail, Telefon;
// keine sensiblen Zusatzdaten. Neue Kunden starten in Magicline als Lead – bei
// echtem Abschluss folgt separat CONTRACT_CREATED (Willkommen). Best effort.
async function onCustomerCreated(cid, p) {
  try {
    const M = require('../../lib/members');
    const Leads = require('../../lib/leadflow');
    let m = null; try { m = await M.getMember(cid); } catch (e) {}
    p = p || {};
    const fn = (m && m.firstName) || p.firstName || p.firstname || '';
    const ln = (m && m.lastName) || p.lastName || p.lastname || '';
    const name = String((fn + ' ' + ln)).replace(/\s+/g, ' ').trim() || null;
    const email = String((m && m.email) || p.email || '').trim() || null;
    const phone = String((m && (m.phonePrivateMobile || m.phonePrivate)) || p.phone || '').trim() || null;
    await Leads.recordLead({ customerId: String(cid), name: name, email: email, phone: phone, source: 'magicline' });
    return true;
  } catch (e) { return false; }
}

// CONTRACT_CANCELLED / CONTRACT_REVERSED -> Team-Hinweis für die Rückholung. (Hinweis:
// CANCELLED läuft laut Konfig auf einen anderen Server; REVERSED erreicht diese App. Beide
// Branches sind verdrahtet, falls CANCELLED später hierher geroutet wird.) Best effort.
async function onContractEnd(cid, kind) {
  try {
    const M = require('../../lib/members');
    const SR = require('../../lib/studioReply');
    let m = null; try { m = await M.getMember(cid); } catch (e) {}
    const name = m ? ((((m.firstName || '') + ' ' + (m.lastName || '')).trim()) || ('Mitglied ' + cid)) : ('Mitglied ' + cid);
    const label = kind === 'reversed' ? 'Vertrag widerrufen' : 'Vertrag gekündigt';
    await SR.notifyStudio({
      member: m || { id: cid },
      subject: '🔄 ' + label + ' – Rückholung prüfen: ' + name,
      text: 'Magicline meldet: ' + label + ' (' + (kind === 'reversed' ? 'CONTRACT_REVERSED' : 'CONTRACT_CANCELLED') + ').\n\n'
        + 'Mitglied: ' + name + (m && m.customerNumber ? (' · Nr. ' + m.customerNumber) : '') + (m && m.email ? (' · ' + m.email) : '')
        + '\n\nGuter Zeitpunkt für ein Rückhol-Angebot (Rückholung im Team-Backend / „Vorschlag von FINN").',
    });
    return true;
  } catch (e) { return false; }
}

// Kernlogik. opts.key erlaubt es, den Schlüssel aus dem Pfad zu übergeben
// (für Webhook-Systeme, die keine ?key=-Query erlauben – z. B. Magicline).
async function handleWebhook(req, res, opts) {
  opts = opts || {};
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  // ── Auth ── Schlüssel aus (Reihenfolge): Pfad -> Header x-api-key -> Query ?key=.
  if (!SECRET) { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: 'not_configured' })); }
  let key = opts.key || req.headers['x-api-key'] || req.headers['x-webhook-secret'] || req.headers['x-magicline-secret'] || (req.query && req.query.key) || '';
  if (!key) { try { key = new URL(req.url, 'http://x').searchParams.get('key') || ''; } catch (e) {} }
  if (key !== SECRET) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await readBody(req);
  const events = eventsFrom(body).slice(0, MAX_EVENTS);
  const summary = [];

  for (const e of events) {
    const type = typeOf(e);
    let action = 'ignored';
    try {
      // NUR echter Vertragsabschluss -> Willkommens-/Zugangs-Mail (mit Dedup) + „Neue Mitglieder".
      if (type === 'CONTRACT_CREATED') {
        const cid = customerIdOf(e);
        if (cid) { const r = await W.sendAccessInfoOnce(cid); action = r.sent ? 'welcome_sent' : ('welcome_' + (r.reason || 'skip')); try { await NM.recordJoin(cid); } catch (e3) {} }
      }
      // Studioweiter Termin-Feed (Live) aus den Buchungs-Webhooks.
      else if (type === 'APPOINTMENT_BOOKING_CREATED' || type === 'APPOINTMENT_BOOKING_UPDATED') {
        action = (await onAppointmentUpsert(e)) ? 'appt_upsert' : 'appt_skip';
      }
      else if (type === 'APPOINTMENT_BOOKING_CANCELLED') {
        const p = payloadOf(e); const bid = e.entityId || p.bookingId || p.id || e.objectId;
        if (bid != null) { await MlEvents.removeAppointment(bid); action = 'appt_removed'; }
      }
      // Live-Check-in-Feed („wer ist gerade da").
      else if (type === 'CUSTOMER_CHECKIN') {
        const cid = customerIdOf(e); const p = payloadOf(e);
        if (cid) { const nm = await checkinName(cid, p); await MlEvents.recordCheckin({ customerId: cid, memberName: nm, atMs: Date.parse(p.checkinDateTime || p.dateTime || p.timestamp || '') || Date.now() }); action = 'checkin'; }
      }
      // Neuer Kunde/Interessent -> in die Team-Lead-Pipeline übernehmen.
      else if (type === 'CUSTOMER_CREATED') {
        const cid = customerIdOf(e);
        if (cid) { await onCustomerCreated(cid, payloadOf(e)); action = 'lead_ingested'; }
      }
      // Zahlungsablehnung -> Team benachrichtigen (Rückholung/Mahnung).
      else if (type === 'CUSTOMER_PAYMENT_REJECTED') {
        const cid = customerIdOf(e);
        if (cid) { await onPaymentRejected(cid); action = 'payment_alerted'; }
      }
      // Öffnungszeiten/Mitarbeiter/Vertrags-Lebenszyklus: quittiert (Caches sind kurzlebig
      // bzw. clientseitig; Erweiterungspunkte für Churn/Rückholung).
      else if (type === 'STUDIO_OPENING_HOURS_UPDATED') { action = 'hours_noted'; }
      else if (type === 'EMPLOYEE_CREATED' || type === 'EMPLOYEE_UPDATED') { action = 'employee_noted'; }
      // Kündigung/Widerruf -> Team-Hinweis für die Rückholung.
      else if (type === 'CONTRACT_CANCELLED') { const cid = customerIdOf(e); if (cid) { await onContractEnd(cid, 'cancelled'); action = 'cancel_alerted'; } }
      else if (type === 'CONTRACT_REVERSED') { const cid = customerIdOf(e); if (cid) { await onContractEnd(cid, 'reversed'); action = 'reversed_alerted'; } }
    } catch (e2) { action = 'error'; }
    summary.push({ type: type || null, action: action });
  }

  // Kompakte, NICHT personenbezogene Log-Zeile (nur Typ/ID/Aktion) für die Vercel-Logs.
  try { console.log('[magicline-webhook]', JSON.stringify(summary)); } catch (e) {}

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, handled: summary.length, summary: summary }));
}

module.exports = function handler(req, res) { return handleWebhook(req, res); };
module.exports.handleWebhook = handleWebhook;
