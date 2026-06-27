'use strict';

/**
 * Magicline Connect API (öffentlich, KEIN API-Key – nur reCAPTCHA + persönliche
 * Identifikation). Wird für die direkte Vertragskündigung genutzt.
 * Basis-URL ist tenant-spezifisch: https://<tenant>.api.magicline.com/connect/v1
 * Der Kündigungs-Endpunkt verlangt einen gültigen reCAPTCHA-Token (?recaptchaToken=)
 * – dafür muss Magicline die aufrufende Domain freischalten.
 */

const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const CONNECT_BASE = process.env.ML_CONNECT_BASE || ('https://' + TENANT + '.api.magicline.com/connect/v1');
const STUDIO_ID = process.env.ML_STUDIO_ID || '1210005460';

async function connect(method, path, body) {
  const opt = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(CONNECT_BASE + path, opt);
  const text = await r.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text };
}

// ── Kündigungsgründe des Studios (öffentlich, ohne reCAPTCHA) – 1h Cache ──
let _reasons = null, _reasonsAt = 0;
async function getCancelationReasons() {
  if (_reasons && (Date.now() - _reasonsAt) < 3600000) return _reasons;
  const r = await connect('GET', '/contracts/studios');
  let out = [];
  if (r.status === 200 && Array.isArray(r.json)) {
    const studio = r.json.find((s) => String(s.id) === String(STUDIO_ID)) || r.json[0];
    const list = studio && studio.selectableCancelationReasons;
    if (Array.isArray(list)) out = list.map((x) => ({ id: x.databaseId, name: x.name }));
  }
  if (out.length) { _reasons = out; _reasonsAt = Date.now(); }
  return out;
}

// Funnel-Grund (Freitext) -> passende Magicline-Grund-ID, mit sinnvollem Default
function pickReasonId(reasons, funnelText) {
  if (!reasons || !reasons.length) return null;
  const t = String(funnelText || '').toLowerCase();
  const find = (re) => { const m = reasons.find((r) => re.test(String(r.name).toLowerCase())); return m ? m.id : null; };
  let id = null;
  if (/teuer|preis|geld|kosten/.test(t)) id = find(/pers[oö]nlich/);
  else if (/zeit/.test(t)) id = find(/\bzeit\b/) || find(/^zeit$/);
  else if (/umzug|weit|entfernung/.test(t)) id = find(/umzug/);
  else if (/gesund|verletz|krank/.test(t)) id = find(/verletz|krank/);
  else if (/unzufrieden|spa[ßs]/.test(t)) id = find(/spa[ßs]/);
  if (!id) id = find(/pers[oö]nlich/) || reasons[0].id;
  return id;
}

function isoDob(s) { return String(s || '').slice(0, 10); }

/**
 * Reicht eine ordentliche Kündigung direkt bei Magicline ein.
 * opts: { member, contract, reasonText, dateISO, useNextPossible, recaptchaToken }
 */
async function submitCancellation(opts) {
  const m = opts.member, ct = opts.contract;
  const reasons = await getCancelationReasons();
  const reasonId = pickReasonId(reasons, opts.reasonText);
  const body = {
    contractId: ct.contractId,
    customerNumber: m.customerNumber,
    dateOfBirth: isoDob(m.dateOfBirth),
    firstname: m.firstName,
    lastname: m.lastName,
    cancellationDate: opts.dateISO,
    cancellationType: 'ORDINARY_CANCELLATION',
    cancellationDateType: opts.useNextPossible ? 'NEXT_POSSIBLE_CANCELLATION_DATE' : 'ABSOLUTE_CANCELLATION_DATE',
    additionalInformation: opts.reasonText || '',
    email: m.email,
  };
  if (reasonId) body.cancelationReasonId = reasonId;

  const r = await connect('POST', '/contracts/cancel?recaptchaToken=' + encodeURIComponent(opts.recaptchaToken || ''), body);
  const ok = r.status >= 200 && r.status < 300;
  const confirmedDate = r.json && (r.json.cancellationDate || r.json.cancelationDate) || null;
  return { ok, status: r.status, confirmedDate, reasonId, body: String(r.text || '').slice(0, 300) };
}

// ── Probetraining (Trial Session) – öffentlich, kein reCAPTCHA nötig ──
async function getTrialSlots(startDate, endDate) {
  const q = '?studioId=' + encodeURIComponent(STUDIO_ID)
    + '&startDate=' + encodeURIComponent(startDate)
    + '&endDate=' + encodeURIComponent(endDate);
  return connect('GET', '/trialsession' + q);
}

// d: { firstname,lastname,email,phone,gender,dateOfBirth, street,houseNumber,zip,city,
//      startDateTime, referralCode, marketing, note }
async function bookTrial(d) {
  const body = {
    studioId: Number(STUDIO_ID),
    startDateTime: d.startDateTime,        // 1:1 aus der Slots-API durchreichen
    trainerRequired: false,                // false = Buchung scheitert nicht ohne freien Trainer
    note: d.referralCode
      ? ('★ FREUNDE WERBEN ★ Werber-Code: ' + String(d.referralCode).trim()
         + ' — beim Vertragsabschluss bitte als „geworben von" eintragen!'
         + (d.note ? (' | ' + d.note) : ''))
      : (d.note || 'Probetraining über die Website gebucht'),
    leadCustomer: {
      firstname: d.firstname,
      lastname: d.lastname,
      email: d.email,
      phone: d.phone || '',
      gender: d.gender || undefined,
      dateOfBirth: d.dateOfBirth || undefined,
      address: { street: d.street, houseNumber: d.houseNumber, zip: d.zip, city: d.city, country: 'DE' },
      privacyConfiguration: {
        email: !!d.marketing, phone: !!d.marketing, textMessage: !!d.marketing,
        letter: false, mySportsMessage: false,
      },
    },
  };
  if (d.referralCode) body.referralCode = String(d.referralCode).trim();
  const r = await connect('POST', '/trialsession/book', body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: r.json, text: r.text };
}

module.exports = {
  connect, getCancelationReasons, pickReasonId, submitCancellation,
  getTrialSlots, bookTrial, CONNECT_BASE, STUDIO_ID,
};
