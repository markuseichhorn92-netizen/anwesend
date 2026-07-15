'use strict';

/**
 * Stripe-Client (nur serverseitig!) – ohne npm-SDK, alles über native fetch.
 * -------------------------------------------------------------------------
 * Für das Premium-Abo des Ernährungsmoduls (Freemium: Basis gratis, KI kostet).
 * Hausstil wie lib/members.js `ml()`: dünner fetch-Wrapper, keine Abhängigkeit.
 *
 * - Checkout-Session (mode=subscription, 7-Tage-Trial) für den Kauf.
 * - Billing-Portal-Session zum Verwalten/Kündigen.
 * - Webhook-Signaturprüfung per crypto-HMAC (Stripe-Schema `t=…,v1=…`),
 *   analog zur Svix-Prüfung in api/inbound-email.js.
 *
 * Nie im Browser verwenden. Kartendaten sieht die App nie (Stripe-hosted Checkout).
 * Env: STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET,
 *      STRIPE_TRIAL_DAYS (Default 7), APP_BASE_URL.
 */

const crypto = require('node:crypto');

const BASE = 'https://api.stripe.com/v1';
// Feste Stripe-API-Version -> deterministisches Feld-Schema, unabhängig von der
// Account-Default-Version. Wichtig, damit `current_period_end` bei Subscriptions
// vorhersehbar ist (der Code liest zusätzlich item-level als Fallback, siehe subPeriodEnd).
const API_VERSION = String(process.env.STRIPE_API_VERSION || '2024-06-20').trim();
const SECRET = String(process.env.STRIPE_SECRET_KEY || '').trim();
// Veröffentlichbarer Key (pk_…) – DARF an den Client, wird für Stripe.js (Embedded
// Checkout / Payment Element) im Browser gebraucht. Niemals der Secret-Key!
const PUBLISHABLE = String(process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
const PRICE_ID = String(process.env.STRIPE_PRICE_ID || '').trim();
const WEBHOOK_SECRET = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const TRIAL_DAYS = Math.max(0, Math.min(90, parseInt(process.env.STRIPE_TRIAL_DAYS || '', 10) || 7));

const hasStripe = !!SECRET && !!PRICE_ID;

// Stripe erwartet application/x-www-form-urlencoded mit Bracket-Notation für
// verschachtelte Felder (line_items[0][price]=…). Rekursiv flach machen.
function toForm(obj) {
  const parts = [];
  const walk = function (val, key) {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) { val.forEach(function (v, i) { walk(v, key + '[' + i + ']'); }); }
    else if (typeof val === 'object') { Object.keys(val).forEach(function (k) { walk(val[k], key ? key + '[' + k + ']' : k); }); }
    else { parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val))); }
  };
  Object.keys(obj || {}).forEach(function (k) { walk(obj[k], k); });
  return parts.join('&');
}

// Roh-fetch an Stripe. -> { status, json } | { status:0, error }
async function stripe(method, path, params) {
  if (!SECRET) return { status: 0, error: 'not_configured' };
  const opt = { method: method, headers: { Authorization: 'Bearer ' + SECRET, Accept: 'application/json', 'Stripe-Version': API_VERSION } };
  if (params) { opt.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opt.body = toForm(params); }
  let r;
  try { r = await fetch(BASE + path, opt); } catch (e) { return { status: 0, error: 'network' }; }
  const text = await r.text().catch(function () { return ''; });
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json: json };
}

// Periodenende einer Subscription robust auslesen. Auf neueren Stripe-API-Versionen
// wandert `current_period_end` auf die Item-Ebene; wir lesen beide Stellen und fallen
// zuletzt auf `trial_end` zurück. Ergebnis in ms (oder null, wenn nichts vorhanden).
function subPeriodEnd(sub) {
  if (!sub) return null;
  let s = Number(sub.current_period_end) || 0;
  if (!s) {
    const it = sub.items && sub.items.data && sub.items.data[0];
    s = (it && Number(it.current_period_end)) || 0;
  }
  if (!s) s = Number(sub.trial_end) || 0;
  return s ? s * 1000 : null;
}

// Checkout-Session (Abo + Trial). -> { ok, url } | { ok:false, error }
async function createCheckoutSession(opts) {
  opts = opts || {};
  if (!hasStripe) return { ok: false, error: 'not_configured' };
  const sub = { metadata: { customerId: String(opts.memberId || '') } };
  if (TRIAL_DAYS > 0) sub.trial_period_days = TRIAL_DAYS;
  const params = {
    mode: 'subscription',
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    subscription_data: sub,
    client_reference_id: String(opts.memberId || ''),
    metadata: { customerId: String(opts.memberId || '') },
    allow_promotion_codes: true,
    locale: 'de',
  };
  if (opts.stripeCustomerId) params.customer = opts.stripeCustomerId;
  else if (opts.email) params.customer_email = opts.email;
  if (opts.embedded) {
    // In-App-Kauf: kein Seitenwechsel. client_secret mountet Stripe.js im Sheet.
    params.ui_mode = 'embedded';
    params.redirect_on_completion = 'never';
  } else {
    params.success_url = opts.successUrl;
    params.cancel_url = opts.cancelUrl;
  }
  const r = await stripe('POST', '/checkout/sessions', params);
  if (r.json && (opts.embedded ? r.json.client_secret : r.json.url)) {
    return opts.embedded
      ? { ok: true, clientSecret: r.json.client_secret, id: r.json.id }
      : { ok: true, url: r.json.url, id: r.json.id };
  }
  return { ok: false, error: (r.json && r.json.error && r.json.error.message) || 'checkout_failed', status: r.status };
}

// ── Abo-Verwaltung in-app (statt Hosted-Portal) – dünne stripe()-Wrapper ──
// Subscription + Standard-Zahlungsmethode (Karte) laden.
async function getSubscription(subId) {
  if (!subId) return { ok: false, error: 'no_subscription' };
  const r = await stripe('GET', '/subscriptions/' + encodeURIComponent(subId) + '?expand[]=default_payment_method');
  if (!(r.json && r.json.id)) return { ok: false, error: (r.json && r.json.error && r.json.error.message) || 'not_found', status: r.status };
  const s = r.json;
  const pm = (s.default_payment_method && typeof s.default_payment_method === 'object') ? s.default_payment_method : null;
  const card = (pm && pm.card) ? { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year } : null;
  return { ok: true, status: s.status, cancelAtPeriodEnd: !!s.cancel_at_period_end, currentPeriodEnd: subPeriodEnd(s), trialEnd: s.trial_end ? s.trial_end * 1000 : null, card: card };
}
// Kündigen zum Periodenende (Zugang bleibt bis dahin) bzw. Kündigung zurücknehmen.
async function cancelSubscription(subId, cancel) {
  if (!subId) return { ok: false, error: 'no_subscription' };
  const r = await stripe('POST', '/subscriptions/' + encodeURIComponent(subId), { cancel_at_period_end: cancel ? 'true' : 'false' });
  if (r.json && r.json.id) return { ok: true, cancelAtPeriodEnd: !!r.json.cancel_at_period_end, currentPeriodEnd: subPeriodEnd(r.json) };
  return { ok: false, error: (r.json && r.json.error && r.json.error.message) || 'cancel_failed', status: r.status };
}
// SOFORTIGE Beendigung (für gesetzlichen Widerruf): Abo endet jetzt, nicht erst zum
// Periodenende. Stripe löst dabei customer.subscription.deleted aus -> Webhook entzieht
// das Entitlement. Eine etwaige (anteilige) Erstattung übernimmt das Studio manuell.
async function endSubscriptionNow(subId) {
  if (!subId) return { ok: false, error: 'no_subscription' };
  const r = await stripe('DELETE', '/subscriptions/' + encodeURIComponent(subId));
  if (r.json && r.json.id) return { ok: true, status: r.json.status || 'canceled' };
  return { ok: false, error: (r.json && r.json.error && r.json.error.message) || 'cancel_failed', status: r.status };
}
// SetupIntent für den Zahlungsart-Wechsel (Payment Element). automatic_payment_methods
// zeigt ALLE fürs Abo geeigneten Methoden (Karte, SEPA, Apple/Google Pay …). allow_redirects
// 'never' hält es non-redirect (kein return_url nötig) – deckt die recurring-Methoden ab.
async function createSetupIntent(customerId) {
  if (!customerId) return { ok: false, error: 'no_customer' };
  const r = await stripe('POST', '/setup_intents', { customer: customerId, usage: 'off_session', automatic_payment_methods: { enabled: true, allow_redirects: 'never' } });
  if (r.json && r.json.client_secret) return { ok: true, clientSecret: r.json.client_secret };
  return { ok: false, error: (r.json && r.json.error && r.json.error.message) || 'setup_failed', status: r.status };
}
// Neue Zahlungsmethode als Standard setzen (Customer + laufende Subscription).
async function setDefaultPaymentMethod(customerId, subId, pmId) {
  if (!customerId || !pmId) return { ok: false, error: 'missing' };
  const c = await stripe('POST', '/customers/' + encodeURIComponent(customerId), { invoice_settings: { default_payment_method: pmId } });
  if (subId) await stripe('POST', '/subscriptions/' + encodeURIComponent(subId), { default_payment_method: pmId });
  if (c.json && c.json.id) return { ok: true };
  return { ok: false, error: (c.json && c.json.error && c.json.error.message) || 'set_pm_failed', status: c.status };
}
// Letzte Rechnungen (für die In-App-Liste).
async function listInvoices(customerId, limit) {
  if (!customerId) return { ok: false, error: 'no_customer', invoices: [] };
  const r = await stripe('GET', '/invoices?customer=' + encodeURIComponent(customerId) + '&limit=' + (limit || 10));
  if (!(r.json && Array.isArray(r.json.data))) return { ok: false, error: 'list_failed', invoices: [] };
  const invoices = r.json.data.map(function (i) {
    return { id: i.id, date: i.created ? i.created * 1000 : null, amount: (i.amount_paid != null ? i.amount_paid : i.amount_due), currency: String(i.currency || 'eur').toUpperCase(), status: i.status, pdf: i.invoice_pdf || null, hostedUrl: i.hosted_invoice_url || null };
  });
  return { ok: true, invoices: invoices };
}

// Billing-Portal (Verwalten/Kündigen). -> { ok, url } | { ok:false, error }
async function createPortalSession(opts) {
  opts = opts || {};
  if (!SECRET) return { ok: false, error: 'not_configured' };
  if (!opts.stripeCustomerId) return { ok: false, error: 'no_customer' };
  const r = await stripe('POST', '/billing_portal/sessions', { customer: opts.stripeCustomerId, return_url: opts.returnUrl });
  if (r.json && r.json.url) return { ok: true, url: r.json.url };
  return { ok: false, error: (r.json && r.json.error && r.json.error.message) || 'portal_failed', status: r.status };
}

// Preis-Info für die UI (dynamische Copy statt hartcodiert). Reihenfolge:
// In-Memory-Memo (6 h) -> Redis-Cache `nutri:priceinfo` (12 h) -> Stripe `GET /prices/<id>`.
// -> { amount, currency, label:'4,99 €', interval, intervalLabel } | null (nicht konfiguriert).
const PRICE_CACHE_KEY = 'nutri:priceinfo';
let _priceMemo = null; let _priceMemoAt = 0;
function formatPrice(cents, cur) {
  try { return new Intl.NumberFormat('de-DE', { style: 'currency', currency: String(cur || 'eur').toUpperCase() }).format((Number(cents) || 0) / 100); }
  catch (e) { return ((Number(cents) || 0) / 100).toFixed(2).replace('.', ',') + ' €'; }
}
function intervalLabelDe(iv) { return { day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr' }[iv] || 'Monat'; }
async function getPriceInfo() {
  if (!hasStripe) return null;
  const nowMs = Date.now();
  if (_priceMemo && (nowMs - _priceMemoAt) < 6 * 3600 * 1000) return _priceMemo;
  let store = null; try { store = require('./store'); } catch (e) {}
  if (store && store.hasStore) {
    try { const [v] = await store.redisPipeline([['GET', PRICE_CACHE_KEY]]); if (v) { const info = JSON.parse(v); _priceMemo = info; _priceMemoAt = nowMs; return info; } } catch (e) {}
  }
  const r = await stripe('GET', '/prices/' + encodeURIComponent(PRICE_ID));
  const p = r && r.json;
  if (!p || p.unit_amount == null) return _priceMemo; // Fetch fehlgeschlagen -> letzter Memo (evtl. null)
  const iv = (p.recurring && p.recurring.interval) || 'month';
  const info = { amount: p.unit_amount, currency: String(p.currency || 'eur').toUpperCase(), label: formatPrice(p.unit_amount, p.currency), interval: iv, intervalLabel: intervalLabelDe(iv) };
  _priceMemo = info; _priceMemoAt = nowMs;
  if (store && store.hasStore) { try { await store.redisPipeline([['SET', PRICE_CACHE_KEY, JSON.stringify(info), 'EX', 43200]]); } catch (e) {} }
  return info;
}

// Webhook-Signaturprüfung (Stripe-Schema). signedPayload = `${t}.${rawBody}`,
// HMAC-SHA256 mit dem Webhook-Secret (direkt als UTF-8-Key), Hex-Vergleich,
// ~5 Min Zeittoleranz. Analog verifySvix() in api/inbound-email.js.
function verifyWebhook(rawBody, sigHeader, secret) {
  secret = secret || WEBHOOK_SECRET;
  if (!secret || !sigHeader || rawBody == null) return false;
  const parts = {};
  String(sigHeader).split(',').forEach(function (kv) {
    const i = kv.indexOf('='); if (i < 0) return;
    const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1).trim();
    (parts[k] = parts[k] || []).push(v);
  });
  const t = parts.t && parts.t[0];
  const v1s = parts.v1 || [];
  if (!t || !v1s.length) return false;
  const tsNum = parseInt(t, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + String(rawBody)).digest('hex');
  const eb = Buffer.from(expected);
  return v1s.some(function (sig) {
    try { const sb = Buffer.from(sig); return sb.length === eb.length && crypto.timingSafeEqual(sb, eb); } catch (e) { return false; }
  });
}

// Roh-Body als String (für die Signaturprüfung – nicht vorparsen). Wie readRaw() in
// api/inbound-email.js.
function readRaw(req) {
  return new Promise(function (resolve) {
    let b = ''; req.on('data', function (c) { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', function () { resolve(b); });
    req.on('error', function () { resolve(''); });
  });
}

module.exports = {
  hasStripe, BASE, PRICE_ID, TRIAL_DAYS, WEBHOOK_SECRET, API_VERSION, PUBLISHABLE,
  toForm, stripe, subPeriodEnd, getPriceInfo, createCheckoutSession, createPortalSession,
  getSubscription, cancelSubscription, endSubscriptionNow, createSetupIntent, setDefaultPaymentMethod, listInvoices,
  verifyWebhook, readRaw,
};
