'use strict';

/**
 * /api/member/nutrition-billing   (Authorization: Bearer <token>)
 * -------------------------------------------------------------------------
 * Premium-Abo fürs Ernährungsmodul über Stripe (Freemium: Basis gratis, KI kostet).
 *
 *   POST { action:'checkout', embedded? } -> { ok, url } | { ok, clientSecret }
 *        Redirect-Checkout ODER Embedded-Checkout (In-App-Sheet, 7 Tage Trial)
 *   POST { action:'status' }        -> { ok, ...tier, premiumInfo:{price,trialDays,pk} }
 *   POST { action:'sub-info' }      -> { ok, subscription:{status,currentPeriodEnd,cancelAtPeriodEnd,card} }
 *   POST { action:'cancel'|'reactivate' } -> { ok, cancelAtPeriodEnd } (zum Periodenende)
 *   POST { action:'setup-intent' }  -> { ok, clientSecret }  Karten-Wechsel (Payment Element)
 *   POST { action:'set-default-pm', paymentMethodId } -> { ok }
 *   POST { action:'invoices' }      -> { ok, invoices:[…] }
 *   POST { action:'portal' }        -> { ok, url }   Hosted-Portal (Fallback)
 *
 * Kartendaten sieht die App nie im Klartext (Stripe.js / Stripe-hosted). Der
 * tatsächliche Premium-Status wird NICHT hier, sondern vom Webhook gesetzt.
 */

const M = require('../../lib/members');
const Stripe = require('../../lib/stripe');
const Ent = require('../../lib/entitlements');
const { hasStore } = require('../../lib/store');
const Inbox = require('../../lib/inbox');
const { sendMail, sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');

function deStamp(ms) {
  const d = new Date(ms || Date.now());
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ', ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ' Uhr';
}

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
    let priceInfo = null; try { priceInfo = await Stripe.getPriceInfo(); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ ok: true }, tier, { premiumInfo: { price: priceInfo, trialDays: Stripe.TRIAL_DAYS, pk: Stripe.PUBLISHABLE || '' } })));
  }

  if (action === 'checkout') {
    if (tier.premium) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'already_premium', message: 'Du hast Premium bereits aktiv.' })); }
    // Rate-Limit gegen versehentliches Mehrfach-Anlegen von Sessions.
    if (!(await M.rateLimit('nutri-checkout:' + id, 12, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz warten und erneut versuchen.' })); }
    let email = '';
    try { const m = await M.getMember(id); email = (m && m.email) || ''; } catch (e) {}
    const embedded = !!body.embedded;   // In-App-Sheet (client_secret) statt Redirect (url)
    const r = await Stripe.createCheckoutSession({
      memberId: id, email: email, stripeCustomerId: (ent && ent.stripeCustomerId) || null, embedded: embedded,
      successUrl: base + '/mitglieder?ern_premium=success',
      cancelUrl: base + '/mitglieder?ern_premium=cancel',
    });
    if (r.ok && embedded && r.clientSecret) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, clientSecret: r.clientSecret })); }
    if (r.ok && r.url) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, url: r.url })); }
    // Konkreten Stripe-Grund durchreichen (Diagnose; Stripe redigiert Keys selbst).
    const reason = (r && r.error && r.error !== 'checkout_failed') ? String(r.error) : (r && r.status ? ('HTTP ' + r.status) : 'unbekannt');
    console.error('[nutrition-billing] checkout failed:', reason, 'status=', r && r.status);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'checkout_failed', message: 'Bezahlung konnte nicht gestartet werden. Grund: ' + reason, detail: reason, status: (r && r.status) || 0 }));
  }

  // ── In-App-Verwaltung: Live-Status, Kündigen/Reaktivieren, Karte, Rechnungen ──
  if (action === 'sub-info') {
    if (!ent || !ent.stripeSubId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, subscription: null, tier: tier })); }
    const r = await Stripe.getSubscription(ent.stripeSubId);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, subscription: r.ok ? r : null, tier: tier }));
  }

  if (action === 'cancel' || action === 'reactivate') {
    if (!ent || !ent.stripeSubId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_subscription', message: 'Kein Abo gefunden.' })); }
    const cancel = action === 'cancel';
    const r = await Stripe.cancelSubscription(ent.stripeSubId, cancel);
    if (!r.ok) { console.error('[nutrition-billing] cancel toggle failed:', r.error); res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'cancel_failed', message: 'Konnte nicht ausgeführt werden – bitte später erneut.' })); }
    // Sofort lokal spiegeln (der Webhook bestätigt es zusätzlich).
    try { await Ent.setEntitlement(id, Object.assign({}, ent, { cancelAtPeriodEnd: !!r.cancelAtPeriodEnd, updatedAt: Date.now() })); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, cancelAtPeriodEnd: !!r.cancelAtPeriodEnd, currentPeriodEnd: r.currentPeriodEnd || null }));
  }

  if (action === 'setup-intent') {
    if (!ent || !ent.stripeCustomerId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_customer', message: 'Kein Abo gefunden.' })); }
    if (!(await M.rateLimit('nutri-setup:' + id, 10, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz warten und erneut versuchen.' })); }
    const r = await Stripe.createSetupIntent(ent.stripeCustomerId);
    if (r.ok && r.clientSecret) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, clientSecret: r.clientSecret })); }
    console.error('[nutrition-billing] setup-intent failed:', r.error);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'setup_failed', message: 'Karten-Änderung nicht möglich – bitte später erneut.' }));
  }

  if (action === 'set-default-pm') {
    const pmId = String(body.paymentMethodId || '');
    if (!ent || !ent.stripeCustomerId || !pmId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'missing' })); }
    const r = await Stripe.setDefaultPaymentMethod(ent.stripeCustomerId, ent.stripeSubId || null, pmId);
    if (r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true })); }
    console.error('[nutrition-billing] set-default-pm failed:', r.error);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'set_pm_failed', message: 'Karte konnte nicht gesetzt werden.' }));
  }

  if (action === 'invoices') {
    if (!ent || !ent.stripeCustomerId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, invoices: [] })); }
    const r = await Stripe.listInvoices(ent.stripeCustomerId, 10);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, invoices: r.invoices || [] }));
  }

  if (action === 'portal') {
    if (!ent || !ent.stripeCustomerId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_subscription', message: 'Kein Abo gefunden.' })); }
    const r = await Stripe.createPortalSession({ stripeCustomerId: ent.stripeCustomerId, returnUrl: base + '/mitglieder?ern_premium=portal' });
    if (r.ok && r.url) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, url: r.url })); }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'portal_failed', message: 'Verwaltung konnte nicht geöffnet werden – bitte später erneut.' }));
  }

  // ── Gesetzlicher Widerruf (Fernabsatz, digitale Leistung) über den Pflicht-Widerrufsbutton ──
  // Beendet das Abo SOFORT (kein Weiterlaufen), erfasst den Widerruf als Vorgang,
  // benachrichtigt das Studio (für eine etwaige anteilige Erstattung) und schickt dem
  // Mitglied eine Eingangsbestätigung auf dauerhaftem Datenträger (E-Mail).
  if (action === 'widerruf') {
    if (!ent || !ent.stripeSubId) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_subscription', message: 'Für dieses Konto gibt es kein widerrufbares Premium-Abo.' }));
    }
    if (!(await M.rateLimit('nutri-widerruf:' + id, 5, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz warten und erneut versuchen.' })); }
    const at = Date.now();
    let m = null; try { m = await M.getMember(id); } catch (e) {}
    const name = m ? ((m.firstName || '') + ' ' + (m.lastName || '')).trim() : '';
    const kdnr = (m && m.customerNumber) || '';
    // 1) Abo sofort beenden (Widerruf = Vertrag rückabgewickelt). Webhook entzieht Premium.
    let ended = false;
    try { const r = await Stripe.endSubscriptionNow(ent.stripeSubId); ended = !!r.ok; if (!r.ok) console.error('[nutrition-billing] widerruf end-sub failed:', r.error); } catch (e) { console.error('[nutrition-billing] widerruf end-sub threw', e); }
    // Lokal spiegeln, damit die App sofort reagiert; der Webhook bestätigt/finalisiert.
    try { await Ent.setEntitlement(id, Object.assign({}, ent, { cancelAtPeriodEnd: true, widerrufAt: at, updatedAt: at })); } catch (e) {}
    // 2) Als Vorgang erfassen (Studio + Mitglied-Postfach).
    try {
      await Inbox.addVorgang(id, {
        type: 'abo', subject: 'Widerruf Ernährungs-Premium', priority: 'hoch',
        status: ended ? 'abgeschlossen' : 'offen',
        systemText: 'Du hast dein Ernährungs-Premium am ' + deStamp(at) + ' widerrufen. Das Abo wurde beendet.',
        teamText: 'Widerruf des Ernährungs-Premium (digitale Leistung) eingegangen am ' + deStamp(at) + '. Das Abo wurde ' + (ended ? 'sofort beendet' : 'noch NICHT automatisch beendet – bitte in Stripe prüfen') + '. Bitte eine etwaige anteilige Erstattung prüfen.',
      });
    } catch (e) {}
    try { require('../../lib/handled').record('system', id, 'widerruf-premium'); } catch (e) {}
    // 3) Studio informieren (für die Erstattungs-Abwicklung).
    if (hasMail) {
      try {
        await sendMail('↩️ Widerruf Ernährungs-Premium – ' + (name || ('Mitglied ' + id)),
          'Ein Mitglied hat sein Ernährungs-Premium (digitale Leistung) über den Widerrufsbutton WIDERRUFEN.\n\n'
          + 'Mitglied: ' + (name || '—') + '\nKundennr.: ' + (kdnr || '—') + (m && m.email ? ('\nE-Mail: ' + m.email) : '')
          + '\nZeitpunkt: ' + deStamp(at)
          + '\nAbo (Stripe-Sub): ' + (ent.stripeSubId || '—')
          + '\nAbo automatisch beendet: ' + (ended ? 'JA (sofort)' : 'NEIN – bitte manuell in Stripe beenden')
          + '\n\nBitte eine etwaige anteilige Erstattung nach den gesetzlichen Regeln prüfen und dem Mitglied bestätigen.');
      } catch (e) {}
    }
    // 4) Eingangsbestätigung ans Mitglied (dauerhafter Datenträger) – gesetzlich gefordert.
    if (hasMail && m && m.email) {
      try {
        const wm = renderEmail({
          preheader: 'Wir haben deinen Widerruf erhalten.',
          name: m.firstName || '',
          eyebrow: 'Widerruf bestätigt',
          headline: 'Wir haben deinen Widerruf erhalten',
          intro: 'Hiermit bestätigen wir den Eingang deines Widerrufs für das Ernährungs-Premium (digitale Leistung) am ' + deStamp(at) + '. Dein Abo wurde beendet – es entstehen dir keine weiteren Kosten. Eine etwaige anteilige Erstattung für einen bereits gezahlten Zeitraum wickeln wir separat ab und melden uns dazu bei dir.',
          panel: [
            { label: 'Vertrag', value: 'Ernährungs-Premium (Abo)' },
            { label: 'Widerruf eingegangen', value: deStamp(at) },
            { label: 'Status', value: 'Abo beendet' },
          ],
          footer: 'member',
        });
        await sendMailRaw({ to: m.email, subject: 'Eingangsbestätigung deines Widerrufs – Fit-Inn Trier', text: wm.text, html: wm.html });
      } catch (e) {}
    }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, at: at, ended: ended, message: 'Dein Widerruf ist eingegangen. Wir haben dir eine Bestätigung per E-Mail geschickt.' }));
  }

  res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
