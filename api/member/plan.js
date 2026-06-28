'use strict';

/**
 * Vercel Serverless Function · /api/member/plan
 * ---------------------------------------------
 * GET  -> eigene heutige Vormerkung   { ok, plan:{slot,remind}|null }
 * POST -> setzen/absagen              body { action:'set'|'cancel', minutes, remind }
 * Auth über Member-Session (Bearer-Token). Slot = Minuten des Tages (30-Min-Raster).
 */

const M = require('../../lib/members');
const P = require('../../lib/plans');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail, BASE } = require('../../lib/emailTemplate');

function fmtSlot(m) { return (Math.floor(m / 60) < 10 ? '0' : '') + Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60); }

// Sofort-Bestätigung beim Vormerken (blockiert die Antwort nicht hart – Fehler werden geschluckt).
async function sendConfirmation(memberId, email, firstName, slot, date, referralCode) {
  if (!hasMail || !email) return;
  const cancelUrl = BASE + '/api/plan-cancel?t=' + encodeURIComponent(P.cancelToken(memberId, date));
  try {
    const mail = renderEmail({
      preheader: 'Vormerkung bestätigt: heute um ' + fmtSlot(slot) + ' Uhr',
      name: firstName || '',
      eyebrow: 'Vormerkung bestätigt',
      headline: 'Deine Zeit ist notiert',
      intro: 'Wir haben deine Vormerkung im Fit-Inn Trier gespeichert. Eine kurze Erinnerung schicken wir dir noch rechtzeitig vorher. Wir freuen uns auf dich!',
      panel: [
        { label: 'Wann', value: 'Heute, ' + fmtSlot(slot) + ' Uhr' },
      ],
      button: { label: 'Zeit ändern', href: BASE + '/mitglieder' },
      secondary: { label: 'Vormerkung stornieren', href: cancelUrl },
      promo: true,
      referral: { code: referralCode, firstName: firstName },
      footer: 'member',
    });
    await sendMailRaw({
      to: email,
      subject: 'Vormerkung bestätigt: heute um ' + fmtSlot(slot) + ' Uhr',
      text: mail.text,
      html: mail.html,
    });
  } catch (e) { /* Bestätigungsmail darf die Buchung nie scheitern lassen */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  if (req.method === 'GET') {
    try {
      const plan = await P.getMyPlan(sess.id);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, plan: plan }));
    } catch (e) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, plan: null }));
    }
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  // Missbrauchsschutz: begrenzte Schreibvorgänge pro Mitglied/Stunde
  if (!(await M.rateLimit('plan:' + sess.id, 40, 3600))) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ error: 'rate_limited' }));
  }

  const body = await M.readBody(req);
  const action = body.action === 'cancel' ? 'cancel' : 'set';

  try {
    if (action === 'cancel') {
      const r = await P.cancelPlan(sess.id);
      res.statusCode = 200;
      return res.end(JSON.stringify(r));
    }

    // E-Mail/Vorname aus Magicline ziehen und im Plan ablegen (für Bestätigung + Erinnerung)
    let email = '', firstName = '', referralCode = '';
    try { const m = await M.getMember(sess.id); if (m) { email = m.email || ''; firstName = m.firstName || ''; referralCode = m.referralCode || ''; } } catch (e) {}

    const remind = body.remind !== false;
    const minutes = (body.minutes != null) ? body.minutes : (body.hour != null ? body.hour * 60 : null);
    const r = await P.setPlan(sess.id, minutes, { email: email, firstName: firstName, remind: remind });
    // Sofort-Bestätigung per E-Mail, wenn Benachrichtigungen aktiv sind
    if (r.ok && r.plan && remind) await sendConfirmation(sess.id, email, firstName, r.plan.slot, r.plan.date, referralCode);
    res.statusCode = r.ok ? 200 : 400;
    return res.end(JSON.stringify(r));
  } catch (e) {
    console.error('[plan]', e.message);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: 'plan_failed' }));
  }
};
