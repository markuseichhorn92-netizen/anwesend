'use strict';

/**
 * /api/member/nutrition-billing   (Authorization: Bearer <token>)
 * -------------------------------------------------------------------------
 * Premium-Abo fürs Ernährungsmodul über Stripe (Freemium: Basis gratis, KI kostet).
 *
 *   POST { action:'checkout' } -> { ok, url }   Stripe-Checkout starten (7 Tage Trial)
 *   POST { action:'portal' }   -> { ok, url }   Stripe-Billing-Portal (verwalten/kündigen)
 *   POST { action:'status' }   -> { ok, ...tier } aktueller Abo-Status
 *
 * Kartendaten sieht die App nie (Stripe-hosted). Der tatsächliche Premium-Status
 * wird NICHT hier, sondern vom Webhook (api/webhooks/stripe.js) gesetzt.
 */

const M = require('../../lib/members');
const Stripe = require('../../lib/stripe');
const Ent = require('../../lib/entitlements');
const { hasStore } = require('../../lib/store');

function baseUrl(req) {
  const env = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return proto + '://' + host;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unavailable' })); }
  if (!Stripe.hasStripe) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'not_configured', message: 'Premium ist noch nicht eingerichtet.' })); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const id = sess.id;
  const body = await M.readBody(req);
  const action = String(body.action || '');
  const ent = await Ent.getEntitlement(id);
  const tier = Ent.publicTier(ent);
  const base = baseUrl(req);

  if (action === 'status') {
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ ok: true }, tier)));
  }

  if (action === 'checkout') {
    if (tier.premium) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'already_premium', message: 'Du hast Premium bereits aktiv.' })); }
    // Rate-Limit gegen versehentliches Mehrfach-Anlegen von Sessions.
    if (!(await M.rateLimit('nutri-checkout:' + id, 12, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz warten und erneut versuchen.' })); }
    let email = '';
    try { const m = await M.getMember(id); email = (m && m.email) || ''; } catch (e) {}
    const r = await Stripe.createCheckoutSession({
      memberId: id, email: email, stripeCustomerId: (ent && ent.stripeCustomerId) || null,
      successUrl: base + '/mitglieder?ern_premium=success',
      cancelUrl: base + '/mitglieder?ern_premium=cancel',
    });
    if (r.ok && r.url) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, url: r.url })); }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'checkout_failed', message: 'Bezahlung konnte nicht gestartet werden – bitte später erneut.' }));
  }

  if (action === 'portal') {
    if (!ent || !ent.stripeCustomerId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_subscription', message: 'Kein Abo gefunden.' })); }
    const r = await Stripe.createPortalSession({ stripeCustomerId: ent.stripeCustomerId, returnUrl: base + '/mitglieder?ern_premium=portal' });
    if (r.ok && r.url) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, url: r.url })); }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'portal_failed', message: 'Verwaltung konnte nicht geöffnet werden – bitte später erneut.' }));
  }

  res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
