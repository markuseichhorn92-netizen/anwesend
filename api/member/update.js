'use strict';

/**
 * POST /api/member/update   (Authorization: Bearer <token>)
 *   { type: "address"|"payment", data: {...} }
 * Schreibt zuerst DIREKT in Magicline (Self-Service: CUSTOMER_SELF_SERVICE_WRITE).
 * Klappt das, wird die Änderung sofort übernommen und das Mitglied bestätigt.
 * Lehnt die API ab (z. B. Rechte/Validierung), fällt das System auf den bewährten
 * Weg zurück: Änderungswunsch als E-Mail mit "vorher → jetzt" ans Studio.
 */

const M = require('../../lib/members');
const Bank = require('../../lib/bank');
const Inbox = require('../../lib/inbox');
const SR = require('../../lib/studioReply');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

function who(m) {
  return ((m.firstName || '') + ' ' + (m.lastName || '')).trim()
    + (m.customerNumber ? ' (' + m.customerNumber + ')' : '')
    + (m.email ? ' · ' + m.email : '');
}

// Bestätigungsmail ans Mitglied. done=true: bereits übernommen; done=false: eingegangen.
// IBAN wird NIEMALS vollständig versendet – nur maskiert.
async function sendMemberConfirm(m, id, type, data, validFromDE, done) {
  if (!(hasMail && m.email)) return;
  const portal = await memberLink(id, 'data');
  let cm;
  if (type === 'payment') {
    const newIbanMasked = M.maskIban(String(data.iban || '').replace(/\s+/g, '')) || '—';
    cm = renderEmail({
      preheader: done ? 'Deine Bankverbindung wurde aktualisiert.' : 'Deine Bankverbindung-Änderung ist eingegangen.',
      name: m.firstName || '', eyebrow: 'Bankverbindung',
      headline: done ? 'Deine Bankverbindung wurde aktualisiert' : 'Deine IBAN-Änderung ist eingegangen',
      intro: done ? 'Wir haben deine neue Bankverbindung übernommen. Künftige Beiträge ziehen wir von diesem Konto ein.'
                  : 'Wir haben deinen Änderungswunsch erhalten und tragen ihn zeitnah ein.',
      panel: [
        { label: 'Neue IBAN', value: newIbanMasked },
        { label: 'Kontoinhaber', value: data.accountHolder || (((m.firstName || '') + ' ' + (m.lastName || '')).trim() || '—') },
      ],
      note: 'Das warst nicht du? Bitte kontaktiere uns umgehend unter info@fit-inn-trier.de.',
      button: { label: 'Meine Daten ansehen', href: portal },
      promo: true, referral: { code: m.referralCode, firstName: m.firstName }, footer: 'member',
    });
  } else if (type === 'contact') {
    const parts = [];
    if (String(data.email || '').trim()) parts.push({ label: 'Neue E-Mail', value: String(data.email).trim() });
    if (String(data.phone || '').trim()) parts.push({ label: 'Neue Telefonnummer', value: String(data.phone).trim() });
    cm = renderEmail({
      preheader: done ? 'Deine Kontaktdaten wurden aktualisiert.' : 'Deine Kontaktdaten-Änderung ist eingegangen.',
      name: m.firstName || '', eyebrow: 'Kontaktdaten',
      headline: done ? 'Deine Kontaktdaten wurden aktualisiert' : 'Deine Kontaktdaten-Änderung ist eingegangen',
      intro: done ? 'Wir haben deine neuen Kontaktdaten übernommen.' : 'Wir haben deinen Änderungswunsch erhalten und tragen ihn zeitnah ein.',
      panel: parts.length ? parts : [{ label: 'Kontaktdaten', value: 'aktualisiert' }],
      button: { label: 'Meine Daten ansehen', href: portal },
      promo: true, referral: { code: m.referralCode, firstName: m.firstName }, footer: 'member',
    });
  } else {
    const newAddr = ((data.street || '') + ' ' + (data.houseNumber || '')).trim() + ', ' + (data.zipCode || '') + ' ' + (data.city || '');
    cm = renderEmail({
      preheader: done ? 'Deine Adresse wurde aktualisiert.' : 'Deine Adressänderung ist eingegangen.',
      name: m.firstName || '', eyebrow: 'Adressänderung',
      headline: done ? 'Deine Adresse wurde aktualisiert' : 'Deine Adressänderung ist eingegangen',
      intro: done ? 'Wir haben deine neue Adresse übernommen.' : 'Wir haben deinen Änderungswunsch erhalten und tragen ihn zeitnah für dich ein.',
      panel: [
        { label: 'Neue Adresse', value: newAddr.replace(/^,\s*/, '').trim() || '—' },
      ],
      button: { label: 'Meine Daten ansehen', href: portal },
      promo: true, referral: { code: m.referralCode, firstName: m.firstName }, footer: 'member',
    });
  }
  const subj = type === 'payment'
    ? (done ? 'Deine Bankverbindung wurde aktualisiert – Fit-Inn Trier' : 'Deine IBAN-Änderung ist eingegangen – Fit-Inn Trier')
    : type === 'contact'
    ? (done ? 'Deine Kontaktdaten wurden aktualisiert – Fit-Inn Trier' : 'Deine Kontaktdaten-Änderung ist eingegangen – Fit-Inn Trier')
    : (done ? 'Deine Adresse wurde aktualisiert – Fit-Inn Trier' : 'Deine Adressänderung ist eingegangen – Fit-Inn Trier');
  await sendMailRaw({ to: m.email, subject: subj, text: cm.text, html: cm.html });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  const body = await M.readBody(req);
  const data = body.data || {};
  if (body.type !== 'address' && body.type !== 'payment' && body.type !== 'contact') {
    res.statusCode = 400; return res.end(JSON.stringify({ error: 'unknown_type' }));
  }
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }

  // Gültig-ab-Datum (optional). Leer = "sofort / nächstmöglich".
  const vf = M.isoDate(data.validFrom);
  const validFromDE = vf ? (function () { var p = vf.match(/^(\d{4})-(\d{2})-(\d{2})$/); return p ? (p[3] + '.' + p[2] + '.' + p[1]) : vf; })() : 'sofort / nächstmöglich';

  // Adresse: nichts tun, wenn sich nichts geändert hat.
  if (body.type === 'address') {
    const changed = ['street', 'houseNumber', 'zipCode', 'city'].some(function (f) { return String(m[f] || '') !== String(data[f] || ''); });
    if (!changed) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Keine Änderung erkannt.' })); }
  }

  // Kontakt: E-Mail/Telefon. E-Mail-Format prüfen; leere Werte ignorieren (kein Überschreiben).
  if (body.type === 'contact') {
    const email = String(data.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte eine gültige E-Mail-Adresse eingeben.' }));
    }
    if (!email && !String(data.phone || '').trim() && !String(data.phoneMobile || '').trim()) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte E-Mail oder Telefonnummer angeben.' }));
    }
  }

  // Bankverbindung: IBAN prüfen und BIC/Bankname bei Bedarf aus der BLZ ergänzen.
  if (body.type === 'payment') {
    const v = Bank.validateIban(data.iban);
    if (!v.valid) {
      res.statusCode = 200;
      const why = v.reason === 'pruefziffer' ? 'Die IBAN ist ungültig (Prüfziffer stimmt nicht).'
        : v.reason === 'laenge' ? 'Die IBAN hat eine ungültige Länge.'
        : 'Bitte eine gültige IBAN eingeben.';
      return res.end(JSON.stringify({ ok: false, message: why }));
    }
    data.iban = Bank.normalizeIban(data.iban);
    if (v.country === 'DE') {
      const b = Bank.bankByBlz(data.iban.slice(4, 12));
      if (b) { if (!data.bic) data.bic = b.bic; if (!data.bankName) data.bankName = b.bankName; }
    }
  }

  // ── 1) Direkt in Magicline schreiben (Self-Service freigeschaltet) ──
  let wrote = false, wr = null;
  try {
    wr = body.type === 'address' ? await M.writeAddress(sess.id, data)
       : body.type === 'contact' ? await M.writeContact(sess.id, data)
       : await M.writePayment(sess.id, data);
    wrote = !!(wr && wr.status >= 200 && wr.status < 300);
  } catch (e) { wr = { status: 0, text: String((e && e.message) || e) }; }

  if (wrote) {
    try { require('../../lib/handled').record('system', sess.id, 'selfservice'); } catch (e) {}
    try {
      if (body.type === 'address') {
        const na = (((data.street || '') + ' ' + (data.houseNumber || '')).trim() + ', ' + (data.zipCode || '') + ' ' + (data.city || '')).replace(/^,\s*/, '').trim();
        await Inbox.addVorgang(sess.id, { type: 'adresse', subject: 'Adresse aktualisiert', systemText: 'Deine Adresse wurde aktualisiert: ' + na + '.', notifyTeam: false });
      } else if (body.type === 'contact') {
        await Inbox.addVorgang(sess.id, { type: 'kontakt', subject: 'Kontaktdaten aktualisiert', systemText: 'Deine Kontaktdaten wurden aktualisiert.', notifyTeam: false });
      } else {
        await Inbox.addVorgang(sess.id, { type: 'iban', subject: 'Bankverbindung aktualisiert', systemText: 'Deine Bankverbindung wurde aktualisiert (' + (M.maskIban(String(data.iban || '').replace(/\s+/g, '')) || 'neue IBAN') + ').', notifyTeam: false });
      }
    } catch (e) {}
    try { await sendMemberConfirm(m, sess.id, body.type, data, validFromDE, true); } catch (e) {}
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, updated: true, via: 'magicline',
      message: body.type === 'payment' ? 'Deine Bankverbindung wurde aktualisiert.'
             : body.type === 'contact' ? 'Deine Kontaktdaten wurden aktualisiert.'
             : 'Deine Adresse wurde aktualisiert.' }));
  }

  // ── 2) Fallback: Änderungswunsch ans Studio (E-Mail + Vorgang) ──
  let subject, vorgang = null;
  const lines = [];
  if (body.type === 'address') {
    [['Straße', 'street'], ['Nr.', 'houseNumber'], ['PLZ', 'zipCode'], ['Ort', 'city']].forEach(function (f) {
      var alt = String(m[f[1]] || ''), neu = String(data[f[1]] || '');
      if (alt !== neu) lines.push(f[0] + ': ' + (alt || '—') + '  →  ' + (neu || '—'));
    });
    subject = 'Adressänderung gewünscht – ' + who(m);
    var newAddr = ((data.street || '') + ' ' + (data.houseNumber || '')).trim() + ', ' + (data.zipCode || '') + ' ' + (data.city || '');
    try { vorgang = await Inbox.addVorgang(sess.id, { type: 'adresse', subject: 'Adressänderung',
      systemText: 'Du hast eine Adressänderung beantragt: ' + newAddr.replace(/^,\s*/, '').trim() + '.',
      teamText: 'Danke! Wir übernehmen deine neue Adresse zeitnah. Bei Rückfragen melden wir uns.' }); } catch (e) {}
  } else if (body.type === 'contact') {
    if (String(data.email || '').trim()) lines.push('E-Mail: ' + (m.email || '—') + '  →  ' + String(data.email).trim());
    if (String(data.phone || '').trim()) lines.push('Telefon: ' + (m.phonePrivate || m.phone || '—') + '  →  ' + String(data.phone).trim());
    if (String(data.phoneMobile || '').trim()) lines.push('Mobil: ' + String(data.phoneMobile).trim());
    subject = 'Kontaktdaten-Änderung gewünscht – ' + who(m);
    try { vorgang = await Inbox.addVorgang(sess.id, { type: 'kontakt', subject: 'Kontaktdaten-Änderung',
      systemText: 'Du hast eine Änderung deiner Kontaktdaten beantragt.',
      teamText: 'Danke! Wir aktualisieren deine Kontaktdaten zeitnah.' }); } catch (e) {}
  } else {
    lines.push('Kontoinhaber: ' + (data.accountHolder || '—'));
    lines.push('IBAN ALT:    ' + (M.maskIban(m.bankAccount && m.bankAccount.iban) || '—'));
    lines.push('IBAN NEU:    ' + (String(data.iban || '').replace(/\s+/g, '') || '—'));
    if (data.bankName) lines.push('Bank: ' + data.bankName);
    if (data.bic) lines.push('BIC: ' + data.bic);
    subject = 'IBAN-Änderung gewünscht – ' + who(m);
    try { vorgang = await Inbox.addVorgang(sess.id, { type: 'iban', subject: 'Änderung deiner Bankverbindung',
      systemText: 'Du hast eine IBAN-Änderung beantragt (' + (M.maskIban(String(data.iban || '').replace(/\s+/g, '')) || 'neue IBAN') + ').',
      teamText: 'Danke! Wir prüfen die neue Bankverbindung und ziehen den nächsten Beitrag wie gewohnt ein. Du musst nichts weiter tun.' }); } catch (e) {}
  }

  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Änderung konnte gerade nicht übernommen werden. Bitte später erneut.' })); }

  const text = 'Änderungswunsch über den Mitgliederbereich\n\n'
    + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—') + '\n\n'
    + lines.join('\n') + '\n\nBitte in Magicline eintragen.';
  const mail = await SR.notifyStudio({ member: m, vorgang: vorgang, subject: subject, text: text });

  if (mail.ok) { try { await sendMemberConfirm(m, sess.id, body.type, data, validFromDE, false); } catch (e) {} }

  res.statusCode = 200;
  const out = {
    ok: mail.ok, via: 'studio', mlStatus: (wr && wr.status) || 0,
    message: mail.ok ? 'Dein Änderungswunsch wurde übermittelt – wir tragen ihn zeitnah ein.'
                     : 'Konnte gerade nicht übermittelt werden. Bitte später erneut.',
  };
  if (body.debug === true) out.mlBody = String((wr && wr.text) || '').slice(0, 200);
  return res.end(JSON.stringify(out));
};
