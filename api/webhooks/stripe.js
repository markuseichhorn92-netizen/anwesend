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
 * Events: checkout.session.completed, customer.subscription.created|updated|deleted,
 *         invoice.payment_failed. Antwortet immer 200 (received), damit Stripe nicht retry-stürmt.
 */

const Stripe = require('../../lib/stripe');
const Ent = require('../../lib/entitlements');
const { redisPipeline, hasStore } = require('../../lib/store');

// Reverse-Index Stripe-Kunde -> Mitglied (falls ein Event mal keine metadata trägt).
const CUSKEY = (cus) => 'nutri:stripecus:' + String(cus);
async function reverseGet(cus) { if (!hasStore || !cus) return null; try { const [v] = await redisPipeline([['GET', CUSKEY(cus)]]); return v || null; } catch (e) { return null; } }
async function reverseSet(cus, memberId) { if (!hasStore || !cus || !memberId) return; try { await redisPipeline([['SET', CUSKEY(cus), String(memberId)]]); } catch (e) {} }

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
  const until = sub.current_period_end ? sub.current_period_end * 1000 : (sub.trial_end ? sub.trial_end * 1000 : null);
  const ent = {
    tier: 'premium',
    status: String(sub.status || ''),
    until: until,
    since: (prev && prev.since) || Date.now(),
    stripeCustomerId: sub.customer || (prev && prev.stripeCustomerId) || null,
    stripeSubId: sub.id || (prev && prev.stripeSubId) || null,
    updatedAt: Date.now(),
  };
  await Ent.setEntitlement(memberId, ent);
  if (ent.stripeCustomerId) await reverseSet(ent.stripeCustomerId, memberId);
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

  try {
    if (type === 'checkout.session.completed') {
      const memberId = await resolveMember(obj);
      if (memberId && obj.customer) await reverseSet(obj.customer, memberId);
      // Sofort-Freischaltung (Trial) – aber ein bereits von subscription.* gesetztes,
      // gültiges Entitlement NICHT überschreiben.
      if (memberId) {
        const prev = await Ent.getEntitlement(memberId);
        if (!Ent.isPremium(prev)) {
          await Ent.setEntitlement(memberId, {
            tier: 'premium', status: 'trialing', until: (prev && prev.until) || null,
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
        await Ent.setEntitlement(memberId, Object.assign({}, prev, { tier: 'premium', status: 'canceled', until: Date.now(), updatedAt: Date.now() }));
      }
    } else if (type === 'invoice.payment_failed') {
      const memberId = await resolveMember(obj);
      if (memberId) { const prev = await Ent.getEntitlement(memberId); if (prev) await Ent.setEntitlement(memberId, Object.assign({}, prev, { status: 'past_due', updatedAt: Date.now() })); }
    }
    // invoice.paid / Verlängerungen werden durch customer.subscription.updated abgedeckt.
  } catch (e) {}

  res.statusCode = 200; return res.end(JSON.stringify({ received: true }));
};
