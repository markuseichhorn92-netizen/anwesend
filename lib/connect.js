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

const CONNECT_ROOT = CONNECT_BASE.replace(/\/v\d+$/, '');   // …/connect (ohne /v1)
function urlFor(path) { return /^\/v\d+\//.test(path) ? (CONNECT_ROOT + path) : (CONNECT_BASE + path); }

async function connect(method, path, body) {
  const opt = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(urlFor(path), opt);
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

/**
 * Reicht einen Widerruf (gesetzliches 14-Tage-Fernabsatz-Widerrufsrecht) direkt
 * bei Magicline ein. Endpunkt laut Connect-API-Spec:
 * POST /connect/v1/contracts/withdraw?recaptchaToken=… mit WithdrawContractRequestDto.
 * opts: { member, contract, recaptchaToken }
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Liefert die Magicline-Kunden-UUID aus dem Open-API-Kundenobjekt (Feldname je
// nach API-Version unterschiedlich; nimmt das erste UUID-förmige Feld).
function pickCustomerUuid(m, fallbackId) {
  const cands = [m && m.customerUuid, m && m.uuid, m && m.id, fallbackId];
  for (const c of cands) { if (c && UUID_RE.test(String(c))) return String(c); }
  // Kein UUID-Format gefunden -> trotzdem die kanonische Kunden-ID schicken.
  for (const c of [m && m.id, fallbackId]) { if (c) return String(c); }
  return undefined;
}

async function submitWithdrawal(opts) {
  const m = opts.member, ct = opts.contract;
  const customerUuid = opts.customerUuid || pickCustomerUuid(m, opts.customerId);
  const body = {
    contractId: ct.contractId,
    customerUuid: customerUuid,
    customerNumber: m.customerNumber,
    dateOfBirth: isoDob(m.dateOfBirth),
    firstname: m.firstName,
    lastname: m.lastName,
    confirmationEmail: m.email || undefined,
  };
  const r = await connect('POST', '/contracts/withdraw?recaptchaToken=' + encodeURIComponent(opts.recaptchaToken || ''), body);
  return {
    ok: r.status >= 200 && r.status < 300, status: r.status, json: r.json,
    text: String(r.text || '').slice(0, 300),
    uuidSent: !!customerUuid, uuidFormat: customerUuid ? UUID_RE.test(customerUuid) : false,
  };
}

// ── Probetraining (Trial Session) – öffentlich, kein reCAPTCHA nötig ──
/**
 * Probetraining MIT Ressource (Trainer) ist der Standard.
 *
 * Ohne das Flag legt Magicline einen Termin ohne zugewiesene Ressource an –
 * im Kalender steht dann niemand dafür ein. Am 14.08. gegen die Connect-API
 * ausgemessen: mit Trainer 22 statt 33 Slots in derselben Woche, weil nur noch
 * Zeiten angeboten werden, zu denen wirklich jemand frei ist. Genau das ist der
 * Sinn der Sache – ein Termin, zu dem kein Trainer da ist, ist keiner.
 *
 * `undefined` heißt „Standard nehmen"; ein ausdrückliches true/false gewinnt
 * (der Web-Funnel lässt den Besucher selbst wählen).
 */
const TRIAL_TRAINER = String(process.env.TRIAL_TRAINER || '1') !== '0';
function wantTrainer(v) { return (v == null || v === '') ? TRIAL_TRAINER : !!v; }

async function getTrialSlots(startDate, endDate, trainerRequired) {
  const q = '?studioId=' + encodeURIComponent(STUDIO_ID)
    + '&startDate=' + encodeURIComponent(startDate)
    + '&endDate=' + encodeURIComponent(endDate)
    + '&trainerRequired=' + (wantTrainer(trainerRequired) ? 'true' : 'false');
  return connect('GET', '/trialsession' + q);
}

// d: { firstname,lastname,email,phone,gender,dateOfBirth, street,houseNumber,zip,city,
//      startDateTime, referralCode, marketing, note }
async function bookTrial(d) {
  const body = {
    studioId: Number(STUDIO_ID),
    startDateTime: d.startDateTime,        // 1:1 aus der Slots-API durchreichen
    trainerRequired: wantTrainer(d.trainerRequired),  // muss zum gewählten Slot passen (Slots werden mit demselben Flag geholt)
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

// ── Online-Vertragsabschluss (Connect API) ──────────────────────────────
// Tarife/Bundles inkl. Textblöcke (1h Cache)
let _rates = null, _ratesAt = 0;
async function getRateBundles() {
  if (_rates && (Date.now() - _ratesAt) < 3600000) return _rates;
  const r = await connect('GET', '/rate-bundle?studioId=' + encodeURIComponent(STUDIO_ID));
  if (r.status === 200 && Array.isArray(r.json)) { _rates = r.json; _ratesAt = Date.now(); }
  return r.status === 200 && Array.isArray(r.json) ? r.json : [];
}

// Baut den ConnectApiCreateContractDto aus flachen Formulardaten.
// Bestätigungen (Textblöcke) + SEPA-Mandat werden per IP-Signatur (Klick) erfasst.
function buildContractDto(d) {
  const pay = d.paymentChoice || 'DIRECT_DEBIT';
  const customer = {
    firstname: d.firstname, lastname: d.lastname, email: d.email,
    dateOfBirth: d.dateOfBirth, gender: d.gender || undefined,
    street: d.street, houseNumber: d.houseNumber, zipCode: d.zipCode, city: d.city,
    countryCode: /^(DE|LU|AT|CH)$/.test(String(d.countryCode || '')) ? d.countryCode : 'DE',
    telephone_mobile: d.phone || undefined,
    paymentChoice: pay,
    privacyConfiguration: {
      email: !!d.marketing, phone: !!d.marketing, textMessage: !!d.marketing,
      letter: false, mySportsMessage: false,
    },
  };
  if (pay === 'DIRECT_DEBIT') {
    customer.bankAccount = {
      accountHolder: d.accountHolder || ((d.firstname || '') + ' ' + (d.lastname || '')).trim(),
      iban: String(d.iban || '').replace(/\s+/g, ''),
    };
  }
  if (d.referralCode) customer.referralCode = String(d.referralCode).trim();

  const contract = {
    rateBundleTermId: Number(d.rateBundleTermId),
    startDate: d.startDate,
  };
  // Textblock-Bestätigungen (Hausordnung, Vertragsbedingungen, Datenschutz …) per IP
  const ids = Array.isArray(d.confirmedTextBlockIds) ? d.confirmedTextBlockIds : [];
  if (ids.length) contract.textBlockSignatures = ids.map((id) => ({ textBlockId: Number(id), signOptionalUsingIp: true }));
  // SEPA-Mandat per IP-Bestätigung (bei Lastschrift)
  if (pay === 'DIRECT_DEBIT') contract.sepaSignature = { signOptionalUsingIp: true };

  const dto = { studioId: Number(STUDIO_ID), contract, customer };
  if (d.voucherCode) dto.voucherCode = String(d.voucherCode).trim();
  return dto;
}

async function previewContract(d) { return connect('POST', '/v2/preview', buildContractDto(d)); }
async function createContract(d) {
  const r = await connect('POST', '/rate-bundle', buildContractDto(d));
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: r.json, text: r.text };
}

module.exports = {
  connect, getCancelationReasons, pickReasonId, submitCancellation, submitWithdrawal,
  getTrialSlots, bookTrial, wantTrainer, TRIAL_TRAINER,
  getRateBundles, buildContractDto, previewContract, createContract,
  CONNECT_BASE, STUDIO_ID,
};
