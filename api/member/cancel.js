'use strict';

/**
 * POST /api/member/cancel   (Authorization: Bearer <token>)
 *   { action: "offer_accepted", offer: "discount10"|"pause", reason }
 *   { action: "cancel", reason, date }
 * Benachrichtigt das Studio per E-Mail (Retention bzw. Kündigung). Kündigungen
 * werden vorerst nur gemeldet (manuell in Magicline) – Direkteintrag folgt,
 * sobald bestätigt ist, dass der Key das darf.
 */

const M = require('../../lib/members');
const C = require('../../lib/connect');
const { sendMail, sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail, BASE } = require('../../lib/emailTemplate');

const OFFERS = { discount10: '10 % Rabatt für 6 Monate', pause: 'Beitragspause' };

function who(m) {
  return ((m.firstName || '') + ' ' + (m.lastName || '')).trim()
    + (m.customerNumber ? ' (' + m.customerNumber + ')' : '')
    + (m.email ? ' · ' + m.email : '');
}

// Designte Kündigungs-Bestätigung ans Mitglied (best effort).
async function sendMemberCancelMail(m, opts) {
  if (!hasMail || !m.email) return;
  var ct = opts.ct || null;
  var panel = [{ label: 'Kündigung zum', value: opts.dateText || 'nächstmöglich' }];
  if (ct && ct.rateName) panel.push({ label: 'Tarif', value: ct.rateName });
  try {
    var cm = renderEmail({
      preheader: 'Deine Kündigung ist bei uns eingegangen.',
      name: m.firstName || '',
      eyebrow: 'Kündigung eingegangen',
      headline: 'Deine Kündigung ist eingegangen',
      intro: opts.direct
        ? 'Wir haben deine Kündigung verbindlich erhalten und bearbeitet. Schade, dass du gehst – bis zum Vertragsende bleibt dein Zugang voll aktiv.'
        : 'Wir haben deine Kündigung erhalten. Schade, dass du gehst – bis zum Vertragsende bleibt dein Zugang voll aktiv. Wir bestätigen dir die Kündigung zeitnah.',
      panel: panel,
      button: { label: 'Vertrag ansehen', href: BASE + '/mitglieder' },
      promo: true,
      footer: 'member',
    });
    await sendMailRaw({ to: m.email, subject: 'Deine Kündigung ist eingegangen – Fit-Inn Trier', text: cm.text, html: cm.html });
  } catch (e) { /* Mitglied-Mail ist optional */ }
}

// Designte Widerruf-Bestätigung ans Mitglied (best effort). direct=true -> direkt bei Magicline eingetragen.
async function sendMemberRevokeMail(m, direct) {
  if (!hasMail || !m.email) return;
  try {
    var rm = renderEmail({
      preheader: 'Dein Widerruf ist bei uns eingegangen.',
      name: m.firstName || '',
      eyebrow: 'Widerruf eingegangen',
      headline: 'Dein Widerruf ist eingegangen',
      intro: (direct
        ? 'Wir haben deinen Widerruf verbindlich verarbeitet. '
        : 'Wir haben deinen Widerruf erhalten. ')
        + 'Dein online abgeschlossener Vertrag wird vollständig rückabgewickelt – bereits gezahlte Beiträge erstatten wir dir selbstverständlich zurück. Die Bestätigung folgt in Kürze per E-Mail.',
      button: { label: 'Zum Mitgliederbereich', href: BASE + '/mitglieder' },
      promo: false,
      footer: 'member',
    });
    await sendMailRaw({ to: m.email, subject: 'Dein Widerruf ist eingegangen – Fit-Inn Trier', text: rm.text, html: rm.html });
  } catch (e) { /* Mitglied-Mail ist optional */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  const body = await M.readBody(req);
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }

  let subject, text, okMsg;
  let cancelDbg = null;   // TEMP-Diagnose (PII-frei)
  if (body.action === 'offer_accepted') {
    var off = OFFERS[body.offer] || body.offer || '—';
    subject = '🎉 Retention: Gegenangebot angenommen – ' + who(m);
    text = 'Kündigung abgewendet – Mitglied bleibt!\n\nMitglied: ' + who(m)
      + '\nKundennr.: ' + (m.customerNumber || '—')
      + '\nAngenommenes Angebot: ' + off
      + '\nUrspr. Kündigungsgrund: ' + (body.reason || '—')
      + '\n\nBitte "' + off + '" in Magicline einrichten.';
    okMsg = 'Super – wir richten dein Angebot ein und melden uns bei dir.';
  } else if (body.action === 'cancel') {
    var ct = null;
    try { ct = await M.getContract(sess.id); } catch (e) {}
    var minISO = ct && ct.nextCancellationDateISO ? ct.nextCancellationDateISO : null;
    var reqDate = body.date || null;
    // Kein Datum vor dem nächstmöglichen Kündigungstermin zulassen (Server-Absicherung)
    if (reqDate && minISO && reqDate < minISO) reqDate = minISO;
    var dateISO = reqDate || minISO || null;
    var useNext = !!(minISO && (!reqDate || reqDate === minISO));

    cancelDbg = {
      contractFound: !!ct,
      contractId: (ct && ct.contractId) ? 'ja' : 'nein',
      cancelledAlready: !!(ct && ct.cancelled),
      dateISO: dateISO || null,
      hadToken: !!body.recaptchaToken,
      tokenLen: body.recaptchaToken ? String(body.recaptchaToken).length : 0,
      attemptedDirect: false,
      path: 'fallback',
    };

    // 1) Direkteintrag über die Connect API (wenn Vertrag + reCAPTCHA-Token da sind)
    if (ct && ct.contractId && body.recaptchaToken && dateISO) {
      cancelDbg.attemptedDirect = true;
      var direct = null;
      try { direct = await C.submitCancellation({ member: m, contract: ct, reasonText: body.reason, dateISO: dateISO, useNextPossible: useNext, recaptchaToken: body.recaptchaToken }); }
      catch (e) { direct = { ok: false, error: String(e && e.message) }; }
      cancelDbg.connectStatus = direct && direct.status;
      cancelDbg.connectError = String((direct && (direct.body || direct.error)) || '').slice(0, 240);
      cancelDbg.reasonId = direct && direct.reasonId;
      if (direct && direct.ok) {
        cancelDbg.path = 'direct';
        var cd = direct.confirmedDate || dateISO;
        if (hasMail) {
          try {
            await sendMail('✅ Kündigung direkt eingetragen – ' + who(m),
              'Ein Mitglied hat über den Mitgliederbereich gekündigt – die Kündigung wurde DIREKT in Magicline eingetragen (Connect API).\n\n'
              + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
              + '\nKündigung zum: ' + cd + '\nGrund: ' + (body.reason || '—')
              + '\n\nKeine manuelle Aktion nötig – nur zur Info.');
          } catch (e) {}
        }
        await sendMemberCancelMail(m, { direct: true, dateText: cd, ct: ct });
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, direct: true, message: 'Deine Kündigung wurde verbindlich eingereicht' + (cd ? ' – zum ' + cd : '') + '. Du erhältst eine Bestätigung per E-Mail.', _debug: cancelDbg }));
      }
      // sonst weiter zum E-Mail-Fallback (z. B. reCAPTCHA-Domain noch nicht freigeschaltet)
    }

    // 2) Fallback: Studio per E-Mail informieren (manueller Eintrag)
    var targetDate = body.date || (ct && ct.nextCancellationDate) || 'nächstmöglich';
    subject = '⚠️ KÜNDIGUNG eingegangen – ' + who(m);
    text = 'Über den Mitgliederbereich wurde eine Kündigung eingereicht.\n\n'
      + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
      + '\nGrund: ' + (body.reason || '—')
      + '\nKündigung zum: ' + targetDate + '\nGegenangebote: abgelehnt\n'
      + (ct ? ('\nVertrag:'
              + '\n  Tarif: ' + (ct.rateName || '—')
              + '\n  Vertragsende: ' + (ct.endDate || '—')
              + '\n  Kündigungsfrist: ' + (ct.cancellationPeriod || '—')
              + '\n  Kündigung möglich bis: ' + (ct.deadline || '—') + (ct.deadlinePassed ? ' (überschritten)' : '')
              + '\n  Nächstmöglicher Kündigungstermin: ' + (ct.nextCancellationDate || '—')
              + '\n  ContractId: ' + (ct.contractId || '—'))
            : '\n(Vertragsdaten nicht abrufbar)')
      + '\n\nBitte Kündigung in Magicline verarbeiten.';
    okMsg = 'Deine Kündigung ist eingegangen. Wir bestätigen sie dir zeitnah per E-Mail.';
  } else if (body.action === 'withdraw') {
    var ctw = null;
    try { ctw = await M.getContract(sess.id); } catch (e) {}
    subject = '↩️ Kündigung zurücknehmen – ' + who(m);
    text = 'Ein Mitglied möchte seine Kündigung zurücknehmen.\n\n'
      + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
      + (ctw ? ('\nTarif: ' + (ctw.rateName || '—') + '\nGekündigt zum: ' + (ctw.cancellationDate || ctw.nextCancellationDate || '—')) : '')
      + '\n\nBitte die Kündigung in Magicline zurücknehmen/stornieren.';
    okMsg = 'Deine Kündigung wird zurückgenommen – wir bestätigen das per E-Mail.';
  } else if (body.action === 'revoke') {
    // 14-Tage-Widerruf (Fernabsatz). 1) Direkt über die Connect API eintragen, wenn
    // Vertrag + reCAPTCHA-Token vorhanden; 2) sonst E-Mail-Fallback ans Studio.
    var ctr = null;
    try { ctr = await M.getContract(sess.id); } catch (e) {}
    cancelDbg = {
      action: 'revoke',
      contractFound: !!ctr,
      contractId: (ctr && ctr.contractId) ? 'ja' : 'nein',
      contractOrigin: ctr && ctr.contractOrigin || null,
      withdrawalEligible: !!(ctr && ctr.withdrawalEligible),
      hadToken: !!body.recaptchaToken,
      tokenLen: body.recaptchaToken ? String(body.recaptchaToken).length : 0,
      attemptedDirect: false,
      path: 'fallback',
    };
    if (ctr && ctr.contractId && body.recaptchaToken) {
      cancelDbg.attemptedDirect = true;
      var dw = null;
      try { dw = await C.submitWithdrawal({ member: m, contract: ctr, recaptchaToken: body.recaptchaToken }); }
      catch (e) { dw = { ok: false, error: String(e && e.message) }; }
      cancelDbg.connectStatus = dw && dw.status;
      cancelDbg.connectError = String((dw && (dw.text || dw.error)) || '').slice(0, 240);
      if (!(dw && dw.ok)) {
        console.error('[revoke] Direkter Magicline-Widerruf fehlgeschlagen', {
          status: dw && dw.status, error: cancelDbg.connectError,
          contractId: ctr.contractId, customerNumber: m.customerNumber,
        });
      }
      if (dw && dw.ok) {
        cancelDbg.path = 'direct';
        await sendMemberRevokeMail(m, true);
        if (hasMail) {
          try {
            await sendMail('✅ Widerruf direkt eingetragen – ' + who(m),
              'Ein Mitglied hat seinen Vertrag über den Mitgliederbereich WIDERRUFEN – der Widerruf wurde DIREKT in Magicline eingetragen (Connect API).\n\n'
              + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
              + (ctr.rateName ? ('\nTarif: ' + ctr.rateName) : '') + '\nContractId: ' + (ctr.contractId || '—')
              + '\n\nKeine manuelle Aktion nötig – nur zur Info. Bereits eingezogene Beiträge ggf. erstatten.');
          } catch (e) {}
        }
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, direct: true, message: 'Dein Widerruf wurde verbindlich eingereicht. Du erhältst eine Bestätigung per E-Mail.', _debug: cancelDbg }));
      }
      // sonst weiter zum E-Mail-Fallback (z. B. reCAPTCHA-Domain noch nicht freigeschaltet)
    }
    subject = '⚠️ WIDERRUF (14-Tage-Widerrufsrecht) eingegangen – ' + who(m);
    text = 'Ein Mitglied hat seinen ONLINE abgeschlossenen Vertrag über den Mitgliederbereich WIDERRUFEN '
      + '(gesetzliches Fernabsatz-Widerrufsrecht, 14 Tage). Der Widerruf ist mit Eingang dieser Erklärung wirksam.\n\n'
      + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
      + (ctr ? ('\n\nVertrag:'
              + '\n  Tarif: ' + (ctr.rateName || '—')
              + '\n  Vertragsbeginn: ' + (ctr.startDate || '—')
              + '\n  Abschluss/Origin: ' + (ctr.contractOrigin || '—')
              + '\n  Widerrufsfrist bis: ' + (ctr.withdrawalDeadline || '—')
              + '\n  ContractId: ' + (ctr.contractId || '—'))
            : '\n(Vertragsdaten nicht abrufbar)')
      + '\n\nBitte den Vertrag in Magicline rückabwickeln/stornieren und dem Mitglied bestätigen. '
      + 'Bereits eingezogene Beiträge sind zu erstatten.';
    okMsg = 'Dein Widerruf ist eingegangen. Wir wickeln deinen Vertrag rück und bestätigen das per E-Mail.';
  } else {
    res.statusCode = 400; return res.end(JSON.stringify({ error: 'unknown_action' }));
  }

  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand noch nicht eingerichtet (RESEND_API_KEY fehlt).', _debug: cancelDbg })); }
  const mail = await sendMail(subject, text);
  // Bestätigung ans Mitglied – nur bei tatsächlicher Kündigung (nicht bei Angebot/Rücknahme)
  if (mail.ok && body.action === 'cancel') {
    await sendMemberCancelMail(m, { direct: false, dateText: targetDate, ct: ct });
  }
  // Bestätigung ans Mitglied beim Widerruf (E-Mail-Fallback-Pfad)
  if (mail.ok && body.action === 'revoke') {
    await sendMemberRevokeMail(m, false);
  }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: mail.ok, direct: false, message: mail.ok ? okMsg : 'Übermittlung fehlgeschlagen – bitte später erneut.', _debug: cancelDbg }));
};
