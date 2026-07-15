'use strict';

/**
 * /api/webhooks/stripe   (Stripe -> hierher, fixe URL in Stripe hinterlegt)
 * -------------------------------------------------------------------------
 * Empfängt Stripe-Abo-Events und setzt/entzieht den Premium-Status des
 * Ernährungsmoduls (nutri:prem:<memberId>). Der Premium-Status wird AUSSCHLIESSLICH
 * hier gesetzt – der Client kann ihn nicht selbst schalten.
 *
 * Auth: Stripe-Signatur (STRIPE_WEBHOOK_SECRET) über den ROH-Body – Muster wie
 * api/inbound-email.js. Kein Pfad-Key nötig; die Signatur genügt.
 *
 * Robustheit:
 *  - Idempotenz: jede event.id wird nur einmal verarbeitet (Redis SET NX, 72 h) ->
 *    doppelte/verspätete Zustellungen ändern nichts.
 *  - Schreibfehler am Store -> 500 (nach Lock-Release), damit Stripe erneut zustellt;
 *    ohne konfigurierten Store stiller No-op (nichts zu retryen).
 *  - `until` (Periodenende) robust (auch item-level current_period_end) und nie
 *    unbegrenzt (Trial bounded), damit kein dauerhaftes Gratis-Premium entsteht.
 *
 * Events: checkout.session.completed, customer.subscription.created|updated|deleted,
 *         invoice.paid|payment_succeeded (Verlängerung/Recovery), invoice.payment_failed.
 */

const Stripe = require('../../lib/stripe');
const Ent = require('../../lib/entitlements');
const { redisPipeline, hasStore } = require('../../lib/store');

// Reverse-Index Stripe-Kunde -> Mitglied (falls ein Event mal keine metadata trägt).
const CUSKEY = (cus) => 'nutri:stripecus:' + String(cus);
async function reverseGet(cus) { if (!hasStore || !cus) return null; try { const [v] = await redisPipeline([['GET', CUSKEY(cus)]]); return v || null; } catch (e) { return null; } }
async function reverseSet(cus, memberId) { if (!hasStore || !cus || !memberId) return; try { await redisPipeline([['SET', CUSKEY(cus), String(memberId)]]); } catch (e) {} }

// Idempotenz: jede event.id nur einmal verarbeiten. SET NX EX -> 'OK' (neu) | null (Duplikat).
const EVTKEY = (id) => 'nutri:stripeevt:' + String(id);
const EVT_TTL = 259200; // 72 h – deckt Stripes Retry-Fenster ab.
async function evtAcquire(id) {
  if (!hasStore || !id) return true; // ohne Store keine Dedup möglich -> verarbeiten
  try { const [r] = await redisPipeline([['SET', EVTKEY(id), '1', 'NX', 'EX', EVT_TTL]]); return r === 'OK'; }
  catch (e) { return true; } // Store-Fehler beim Lock: lieber verarbeiten als droppen
}
async function evtRelease(id) { if (!hasStore || !id) return; try { await redisPipeline([['DEL', EVTKEY(id)]]); } catch (e) {} }

// Entitlement schreiben; bei konfiguriertem Store einen Schreibfehler werfen
// (-> 500 -> Stripe-Retry). Ohne Store: stiller No-op (nichts zu retryen).
async function persist(memberId, ent) {
  const ok = await Ent.setEntitlement(memberId, ent);
  if (hasStore && !ok) throw new Error('entitlement_persist_failed');
  return ok;
}

async function resolveMember(obj) {
  if (!obj) return null;
  if (obj.metadata && obj.metadata.customerId) return String(obj.metadata.customerId);
  if (obj.client_reference_id) return String(obj.client_reference_id);
  if (obj.customer) return await reverseGet(obj.customer);
  return null;
}

// Aus einem Subscription-Objekt den Entitlement-Datensatz bauen (since bleibt erhalten).
async function applySubscription(memberId, sub) {
  const prev = await Ent.getEntitlement(memberId);
  // Periodenende robust; kein Downgrade auf null, wenn schon eins bekannt ist.
  const until = Stripe.subPeriodEnd(sub) || (prev && prev.until) || null;
  await persist(memberId, {
    tier: 'premium',
    status: String(sub.status || ''),
    until: until,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    since: (prev && prev.since) || Date.now(),
    stripeCustomerId: sub.customer || (prev && prev.stripeCustomerId) || null,
    stripeSubId: sub.id || (prev && prev.stripeSubId) || null,
    updatedAt: Date.now(),
  });
  const cus = sub.customer || (prev && prev.stripeCustomerId);
  if (cus) await reverseSet(cus, memberId);
}

// Periodenende aus einer Invoice (ms) – für Verlängerung/Recovery.
function invoicePeriodEnd(inv) {
  if (!inv) return null;
  const line = inv.lines && inv.lines.data && inv.lines.data[0];
  let s = (line && line.period && Number(line.period.end)) || 0;
  if (!s) s = Number(inv.period_end) || 0;
  return s ? s * 1000 : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!Stripe.WEBHOOK_SECRET) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'not_configured' })); }

  const raw = await Stripe.readRaw(req);
  if (!Stripe.verifyWebhook(raw, req.headers['stripe-signature'], Stripe.WEBHOOK_SECRET)) {
    res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad_signature' }));
  }
  let event = null; try { event = JSON.parse(raw); } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad_json' })); }
  const type = event && event.type;
  const obj = event && event.data && event.data.object;
  const eventId = event && event.id;

  try {
    // Idempotenz: schon verarbeitete Events sofort quittieren.
    if (!(await evtAcquire(eventId))) { res.statusCode = 200; return res.end(JSON.stringify({ received: true, dedup: true })); }

    if (type === 'checkout.session.completed') {
      const memberId = await resolveMember(obj);
      if (memberId && obj.customer) await reverseSet(obj.customer, memberId);
      // Sofort-Freischaltung (Trial) – aber ein bereits von subscription.* gesetztes,
      // gültiges Entitlement NICHT überschreiben. `until` bounded (Trial + Puffer),
      // damit ein ausbleibendes subscription.created kein Dauer-Premium erzeugt.
      if (memberId) {
        const prev = await Ent.getEntitlement(memberId);
        if (!Ent.isPremium(prev)) {
          const trialMs = (Number(Stripe.TRIAL_DAYS) + 2) * 86400000;
          await persist(memberId, {
            tier: 'premium', status: 'trialing',
            until: (prev && prev.until) || (Date.now() + trialMs),
            since: (prev && prev.since) || Date.now(),
            stripeCustomerId: obj.customer || (prev && prev.stripeCustomerId) || null,
            stripeSubId: obj.subscription || (prev && prev.stripeSubId) || null, updatedAt: Date.now(),
          });
        }
      }
    } else if (type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
      const memberId = await resolveMember(obj);
      if (memberId) await applySubscription(memberId, obj);
    } else if (type === 'customer.subscription.deleted') {
      const memberId = await resolveMember(obj);
      if (memberId) {
        const prev = await Ent.getEntitlement(memberId);
        await persist(memberId, Object.assign({}, prev, { tier: 'premium', status: 'canceled', until: Date.now(), updatedAt: Date.now() }));
      }
    } else if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
      // Erfolgreiche Folge-/Recovery-Zahlung: past_due aufheben, Periode verlängern.
      // Die $0-Trial-Startrechnung (billing_reason=subscription_create) NICHT als
      // „active" werten – der Trial-Status bleibt bis zum echten ersten Zyklus erhalten.
      const memberId = await resolveMember(obj);
      if (memberId && obj.billing_reason !== 'subscription_create') {
        const prev = await Ent.getEntitlement(memberId);
        if (prev) {
          const until = invoicePeriodEnd(obj) || prev.until || null;
          await persist(memberId, Object.assign({}, prev, { status: 'active', until: until, updatedAt: Date.now() }));
        }
      }
    } else if (type === 'invoice.payment_failed') {
      const memberId = await resolveMember(obj);
      if (memberId) { const prev = await Ent.getEntitlement(memberId); if (prev) await persist(memberId, Object.assign({}, prev, { status: 'past_due', updatedAt: Date.now() })); }
    }

    res.statusCode = 200; return res.end(JSON.stringify({ received: true }));
  } catch (e) {
    // Persist-/Verarbeitungsfehler: Lock lösen, 500 -> Stripe stellt erneut zu.
    console.error('[stripe-webhook]', type, eventId, (e && e.message) || e);
    await evtRelease(eventId);
    res.statusCode = 500; return res.end(JSON.stringify({ error: 'processing_failed' }));
  }
};
