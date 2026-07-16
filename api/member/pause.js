'use strict';

/**
 * POST /api/member/pause   (Authorization: Bearer <token>)
 *   { reason, reasonText, from (yyyy-mm-dd), weeks, photo (dataURI/base64),
 *     reasonId?, temporalUnit?, termValue?, startDate? }
 * Beantragt eine Beitragspause. Schickt die neue UI eine reasonId mit, wird die
 * Pause direkt über die Magicline Open API eingerichtet (validate + create,
 * Antwort via:'magicline'). Fehlt der Scope (403) oder schlägt der echte Flow
 * fehl, greift unverändert der bisherige E-Mail-Flow ans Studio inkl.
 * Attest-Foto (via:'studio'). Ohne reasonId läuft der alte Flow 1:1.
 * Mitgliederdaten werden serverseitig aus Magicline gezogen (nicht vom Client).
 */

const M = require('../../lib/members');
const MM = require('../../lib/mlMembership');
const Inbox = require('../../lib/inbox');
const SR = require('../../lib/studioReply');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail, BASE } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

function fmtDE(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? (m[3] + '.' + m[2] + '.' + m[1]) : s;
}
function addWeeks(iso, wk) {
  let d = iso ? new Date(iso + 'T00:00:00Z') : new Date();
  if (isNaN(d.getTime())) d = new Date();
  d.setUTCDate(d.getUTCDate() + (wk || 0) * 7);
  return d.toISOString().slice(0, 10);
}
function unitDE(unit, n) {
  unit = String(unit || '').toUpperCase();
  if (unit === 'MONTH') return n === 1 ? 'Monat' : 'Monate';
  if (unit === 'DAY') return n === 1 ? 'Tag' : 'Tage';
  return n === 1 ? 'Woche' : 'Wochen';
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  const body = await M.readBody(req);
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
  let ct = null; try { ct = await M.getContract(sess.id); } catch (e) {}

  const reason = String(body.reason || '—').slice(0, 120);
  const note = String(body.reasonText || '').slice(0, 1000);
  const weeks = Math.max(1, Math.min(52, parseInt(body.weeks, 10) || 0));
  const fromISO = /^\d{4}-\d{2}-\d{2}$/.test(String(body.from || '')) ? body.from : null;
  const toISO = fromISO ? addWeeks(fromISO, weeks) : null;

  // Attest (Foto) – nur kleine, bereits clientseitig skalierte Bilder
  const attachments = [];
  let hasPhoto = false;
  let photoB64 = '';
  const raw = String(body.photo || '');
  if (raw) {
    let mime = 'image/jpeg';
    const mm = raw.match(/^data:([^;]+);base64,/);
    if (mm) mime = mm[1];
    const bi = raw.indexOf('base64,');
    let b64 = bi >= 0 ? raw.slice(bi + 7) : raw;
    b64 = b64.replace(/\s+/g, '');
    if (b64.length > 100 && b64.length < 8000000) {
      const ext = mime.indexOf('png') >= 0 ? 'png' : (mime.indexOf('pdf') >= 0 ? 'pdf' : 'jpg');
      attachments.push({ filename: 'attest-' + (m.customerNumber || 'mitglied') + '.' + ext, content: b64 });
      hasPhoto = true;
      photoB64 = b64;
    }
  }

  // ── Echter Magicline-Flow (nur wenn die neue UI eine reasonId mitschickt) ──
  const reasonId = parseInt(body.reasonId, 10);
  const startISO = /^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate || '')) ? body.startDate : fromISO;
  if (Number.isFinite(reasonId) && ct && ct.contractId && startISO) {
    const unit = /^(DAY|WEEK|MONTH)$/.test(String(body.temporalUnit || '')) ? String(body.temporalUnit) : 'WEEK';
    const termValue = Math.max(1, Math.min(60, parseInt(body.termValue, 10) || weeks));
    const data = { startDate: startISO, temporalUnit: unit, termValue: termValue, unlimited: false };
    const check = await MM.idleValidate(ct.contractId, data);
    if (check.ok && check.creatable) {
      const created = await MM.idleCreate(ct.contractId, Object.assign({ reasonId: reasonId }, data), hasPhoto ? photoB64 : null);
      if (created.ok) {
        try { require('../../lib/handled').record('system', sess.id, 'pause'); } catch (e) {}
        const ip = created.idlePeriod || {};
        const start = ip.startDate || startISO;
        const end = ip.endDate || null;
        const period = fmtDE(start) + (end ? (' bis ' + fmtDE(end)) : '');
        const pending = ip.state === 'PENDING_VERIFICATION';
        try {
          await Inbox.addVorgang(sess.id, {
            type: 'pause', subject: 'Beitragspause',
            status: pending ? 'bearbeitung' : 'abgeschlossen',
            systemText: 'Beitragspause eingerichtet: ' + period + ' (' + termValue + ' ' + unitDE(unit, termValue) + ').',
            teamText: pending
              ? 'Hallo' + (m.firstName ? (' ' + m.firstName) : '') + ', deine Beitragspause ist hinterlegt und wird noch kurz geprüft. Deine Vertragslaufzeit verlängert sich um die Dauer der Pause.'
              : 'Hallo' + (m.firstName ? (' ' + m.firstName) : '') + ', deine Beitragspause ist eingerichtet. Deine Vertragslaufzeit verlängert sich um die Dauer der Pause – dein Tarif bleibt erhalten.',
          });
        } catch (e) {}

        // Bestätigung ans Mitglied (best effort)
        if (hasMail && m.email) {
          try {
            const portal = await memberLink(sess.id, 'contract');
            const cm = renderEmail({
              preheader: 'Deine Beitragspause ist eingerichtet.',
              name: m.firstName || '',
              eyebrow: 'Beitragspause',
              headline: 'Deine Beitragspause ist eingerichtet',
              intro: pending
                ? 'Wir haben deine Beitragspause direkt in deinem Vertrag hinterlegt. Sie wird noch kurz geprüft – du musst nichts weiter tun.'
                : 'Wir haben deine Beitragspause direkt in deinem Vertrag hinterlegt – du musst nichts weiter tun.',
              panel: [
                { label: 'Beginn', value: fmtDE(start) },
                { label: 'Ende', value: end ? fmtDE(end) : '—' },
                { label: 'Dauer', value: termValue + ' ' + unitDE(unit, termValue) },
                { label: 'Grund', value: reason },
              ],
              note: 'Deine Vertragslaufzeit verlängert sich um die Dauer der Pause. Dein Tarif und deine Konditionen bleiben erhalten.',
              button: { label: 'Vertrag verwalten', href: portal },
              promo: true,
              referral: { code: m.referralCode, firstName: m.firstName },
              footer: 'member',
            });
            await sendMailRaw({ to: m.email, subject: 'Deine Beitragspause ist eingerichtet – Fit-Inn Trier', text: cm.text, html: cm.html });
          } catch (e) { /* Mitglied-Mail ist optional */ }
        }

        res.statusCode = 200;
        return res.end(JSON.stringify({
          ok: true,
          via: 'magicline',
          message: pending
            ? 'Deine Beitragspause ist eingerichtet (' + period + ') und wird noch kurz geprüft. Du erhältst eine Bestätigung per E-Mail.'
            : 'Deine Beitragspause ist eingerichtet (' + period + '). Du erhältst eine Bestätigung per E-Mail.',
          startDate: start, endDate: end, state: ip.state || null,
        }));
      }
    }
    // Scope fehlt (403) oder Anlage nicht möglich -> bisheriger E-Mail-Flow als Fallback.
  }

  let vorgang = null;
  try { vorgang = await Inbox.addVorgang(sess.id, { type: 'pause', subject: 'Beitragspause',
    systemText: 'Du hast eine Beitragspause beantragt (' + weeks + (weeks === 1 ? ' Woche' : ' Wochen') + (fromISO ? (' ab ' + fmtDE(fromISO)) : '') + ').',
    teamText: 'Hallo' + (m.firstName ? (' ' + m.firstName) : '') + ', deine Pause-Anfrage ist eingegangen. Wir prüfen den ärztlichen Nachweis und bestätigen dir die Pause per E-Mail. Deine Vertragslaufzeit verlängert sich um die Dauer der Pause.' }); } catch (e) {}

  const name = ((m.firstName || '') + ' ' + (m.lastName || '')).trim();
  const text = 'Beitragspause beantragt über den Mitgliederbereich\n\n'
    + '— Mitglied —\n'
    + 'Name: ' + (m.lastName || '—') + '\n'
    + 'Vorname: ' + (m.firstName || '—') + '\n'
    + 'Kundennr.: ' + (m.customerNumber || '—') + '\n'
    + 'Geburtsdatum: ' + fmtDE(m.dateOfBirth) + '\n'
    + 'E-Mail: ' + (m.email || '—') + '\n'
    + 'Telefon: ' + (m.phonePrivate || '—') + '\n'
    + 'Adresse: ' + ((m.street || '') + ' ' + (m.houseNumber || '')).trim() + ', ' + (m.zipCode || '') + ' ' + (m.city || '') + '\n'
    + (ct ? ('Tarif: ' + (ct.rateName || '—') + '\n') : '')
    + '\n— Pause —\n'
    + 'Grund: ' + reason + '\n'
    + (note ? ('Anmerkung: ' + note + '\n') : '')
    + 'Gewünschter Beginn: ' + (fromISO ? fmtDE(fromISO) : '—') + '\n'
    + 'Dauer: ' + weeks + (weeks === 1 ? ' Woche' : ' Wochen') + '\n'
    + 'Voraussichtliches Ende: ' + (toISO ? fmtDE(toISO) : '—') + '\n'
    + 'Ärztlicher Nachweis: ' + (hasPhoto ? 'im Anhang' : 'wird nachgereicht') + '\n'
    + '\nBitte Beitragspause in Magicline hinterlegen und dem Mitglied bestätigen.';

  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand noch nicht eingerichtet.' })); }
  const mail = await SR.notifyStudio({
    member: m, vorgang: vorgang,
    subject: '⏸️ Beitragspause beantragt – ' + name + (m.customerNumber ? (' (' + m.customerNumber + ')') : ''),
    text: text,
    attachments: attachments,
  });

  // Bestätigung ans Mitglied (best effort – ohne Attest-Anhang)
  if (mail.ok && m.email) {
    try {
      const portal = await memberLink(sess.id, 'contract');
      const cm = renderEmail({
        preheader: 'Deine Beitragspause-Anfrage ist eingegangen.',
        name: m.firstName || '',
        eyebrow: 'Beitragspause',
        headline: 'Deine Pause-Anfrage ist eingegangen',
        intro: 'Wir haben deine Anfrage für eine Beitragspause erhalten und prüfen sie. Sobald die Pause eingerichtet ist, bestätigen wir dir das per E-Mail.',
        panel: [
          { label: 'Gewünschter Beginn', value: fromISO ? fmtDE(fromISO) : '—' },
          { label: 'Dauer', value: weeks + (weeks === 1 ? ' Woche' : ' Wochen') },
          { label: 'Voraussichtliches Ende', value: toISO ? fmtDE(toISO) : '—' },
        ],
        note: hasPhoto
          ? 'Deinen ärztlichen Nachweis haben wir erhalten. Deine Vertragslaufzeit verlängert sich um die Dauer der Pause.'
          : 'Bitte denke daran, den ärztlichen Nachweis nachzureichen. Deine Vertragslaufzeit verlängert sich um die Dauer der Pause.',
        button: { label: 'Vertrag verwalten', href: portal },
        promo: true,
        referral: { code: m.referralCode, firstName: m.firstName },
        footer: 'member',
      });
      await sendMailRaw({ to: m.email, subject: 'Deine Beitragspause-Anfrage ist eingegangen – Fit-Inn Trier', text: cm.text, html: cm.html });
    } catch (e) { /* Mitglied-Mail ist optional */ }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: mail.ok,
    via: 'studio',
    message: mail.ok
      ? ('Deine Pause-Anfrage ist eingegangen' + (hasPhoto ? ' (inkl. Nachweis)' : '') + '. Wir prüfen sie und bestätigen dir die Pause per E-Mail.')
      : 'Übermittlung fehlgeschlagen – bitte später erneut.',
  }));
};
