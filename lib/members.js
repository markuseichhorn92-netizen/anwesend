'use strict';

/**
 * Mitglieder-Self-Service – serverseitige Logik (Magicline Open API).
 * Login per E-Mail + Geburtsdatum + PLZ; Sitzung + Rate-Limit über Upstash.
 * Bankdaten/IBAN bleiben strikt serverseitig (Frontend sieht nur maskiert).
 */

const crypto = require('node:crypto');
const { redisPipeline, hasStore } = require('./store');

const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY =
  process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey ||
  process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = `https://${TENANT}.open-api.magicline.com/v1`;

async function ml(method, path, body) {
  const opt = { method, headers: { 'x-api-key': API_KEY, Accept: 'application/json' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt);
  const text = await r.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text };
}

function isoDate(s) {
  if (!s) return '';
  s = String(s).trim();
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);   // dd.mm.yyyy
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  return s.slice(0, 10);                              // yyyy-mm-dd / ISO
}
function maskIban(iban) {
  if (!iban) return null;
  const s = String(iban).replace(/\s+/g, '');
  return s.length > 4 ? '•••• ' + s.slice(-4) : '••••';
}

// ── Sitzung (Upstash) ──
async function createSession(customerId, ttlSec) {
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = (ttlSec && ttlSec > 0) ? Math.floor(ttlSec) : 1800;   // Default 30 min
  await redisPipeline([['SET', 'msess:' + token, JSON.stringify({ id: customerId }), 'EX', String(ttl)]]);
  return token;
}
async function getSession(token) {
  if (!token || !hasStore) return null;
  const [v] = await redisPipeline([['GET', 'msess:' + token]]);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
function bearer(req) {
  const a = req.headers['authorization'] || '';
  return a.replace(/^Bearer\s+/i, '').trim() || null;
}

// ── Rate-Limit (Upstash) ──
async function rateLimit(key, max, windowSec) {
  if (!hasStore) return true;
  const [n] = await redisPipeline([['INCR', 'mrl:' + key]]);
  if (n === 1) await redisPipeline([['EXPIRE', 'mrl:' + key, String(windowSec)]]);
  return Number(n) <= max;
}

// ── Body lesen ──
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 9e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ── Mitglied finden + validieren ──
async function findAndValidate(email, dob, plz) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { ok: false };
  const r = await ml('POST', '/customers/search', { email: e });
  if (r.status !== 200 || !Array.isArray(r.json) || !r.json.length) return { ok: false };
  const wantDob = isoDate(dob);
  const wantZip = String(plz || '').trim();
  const m = r.json.find((c) =>
    isoDate(c.dateOfBirth) === wantDob && String(c.zipCode || '').trim() === wantZip);
  return m ? { ok: true, member: m } : { ok: false };
}

// Mitglied über E-Mail + Geburtsdatum finden (für Login per E-Mail-Code)
async function findByEmailDob(email, dob) {
  const e = String(email || '').trim().toLowerCase();
  const wantDob = isoDate(dob);
  if (!e || !wantDob) return null;
  const r = await ml('POST', '/customers/search', { email: e });
  if (r.status !== 200 || !Array.isArray(r.json) || !r.json.length) return null;
  return r.json.find((c) => isoDate(c.dateOfBirth) === wantDob) || null;
}

// Fallback-Login: Mitgliedsnummer + Geburtsdatum (für Mitglieder OHNE E-Mail).
// Die Suche kennt nur firstName/lastName/email/dateOfBirth – daher per
// Geburtsdatum suchen und die Mitgliedsnummer aus den Treffern matchen.
async function findByNumberDob(num, dob) {
  const wantDob = isoDate(dob);
  const n = String(num || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!wantDob || !n) return null;
  const r = await ml('POST', '/customers/search', { dateOfBirth: wantDob });
  if (r.status !== 200 || !Array.isArray(r.json)) return null;
  const bare = n.replace(/^M-?/, '');
  const cands = [n, bare, 'M-' + bare];
  return r.json.find((c) => {
    const cn = String(c.customerNumber || '').toUpperCase().replace(/\s+/g, '');
    return cands.indexOf(cn) >= 0;
  }) || null;
}

// Mitglied über die Telefonnummer finden (für die WhatsApp-Anbindung).
// Die Open-API-Suche akzeptiert `phoneNumber` und matcht ALLE Telefontypen
// (privat, privat-mobil, geschäftlich, geschäftl.-mobil). Da WhatsApp E.164 ohne
// '+' liefert, testen wir mehrere Schreibweisen. Genau 1 Treffer -> Mitglied,
// mehrere/keiner -> null (Aufrufer behandelt das als „nicht zugeordnet").
function phoneVariants(num) {
  const d = String(num || '').replace(/[^\d]/g, '');
  if (!d) return [];
  const set = new Set([d, '+' + d]);
  if (d.indexOf('49') === 0) { set.add('0' + d.slice(2)); set.add('+49' + d.slice(2)); }
  if (d.indexOf('0') === 0) { set.add('49' + d.slice(1)); set.add('+49' + d.slice(1)); }
  return Array.from(set);
}
async function findByPhone(num) {
  for (const p of phoneVariants(num)) {
    let r;
    try { r = await ml('POST', '/customers/search', { phoneNumber: p }); } catch (e) { continue; }
    if (r && r.status === 200 && Array.isArray(r.json) && r.json.length) {
      return r.json.length === 1 ? r.json[0] : null; // mehrdeutig -> Fallback
    }
  }
  return null;
}

// ── Einmal-Code (OTP) für den Login ──
function hashCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
async function otpSave(ch, obj, ttlSec) {
  if (!hasStore) return;
  await redisPipeline([['SET', 'motp:' + ch, JSON.stringify(obj), 'EX', String(Math.max(1, Math.floor(ttlSec)))]]);
}
async function otpGet(ch) {
  if (!ch || !hasStore) return null;
  const [v] = await redisPipeline([['GET', 'motp:' + ch]]);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
async function otpDel(ch) { if (hasStore) await redisPipeline([['DEL', 'motp:' + ch]]); }

// ── Magic-Link-Token (direkter Login aus der E-Mail, 10 Min gültig) ──
async function mlinkSave(t, obj, ttlSec) {
  if (!hasStore) return;
  await redisPipeline([['SET', 'mlink:' + t, JSON.stringify(obj), 'EX', String(Math.max(1, Math.floor(ttlSec)))]]);
}
async function mlinkGet(t) {
  if (!t || !hasStore) return null;
  const [v] = await redisPipeline([['GET', 'mlink:' + t]]);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
async function mlinkDel(t) { if (hasStore) await redisPipeline([['DEL', 'mlink:' + t]]); }

async function getMember(id) {
  const r = await ml('GET', '/customers/' + encodeURIComponent(id));
  return r.status === 200 ? r.json : null;
}

function publicProfile(m) {
  if (!m) return null;
  return {
    customerNumber: m.customerNumber || null,
    firstName: m.firstName, lastName: m.lastName,
    dateOfBirth: isoDate(m.dateOfBirth),
    email: m.email,
    phonePrivate: m.phonePrivate || '',
    street: m.street || '', houseNumber: m.houseNumber || '',
    zipCode: m.zipCode || '', city: m.city || '',
    ibanMasked: maskIban(m.bankAccount && m.bankAccount.iban),
    referralCode: m.referralCode || null,
  };
}

// ── Schreiben (greift erst mit freigeschalteten Self-Service-Rechten) ──
async function writeAddress(id, d) {
  return ml('POST', `/customers/${encodeURIComponent(id)}/self-service/address-data`, {
    street: d.street, houseNumber: d.houseNumber, zipCode: d.zipCode, city: d.city, countryCode: d.countryCode || 'DE',
  });
}
async function writePayment(id, d) {
  return ml('POST', `/customers/${encodeURIComponent(id)}/self-service/payment-data`, {
    accountHolder: d.accountHolder, iban: String(d.iban || '').replace(/\s+/g, ''), bic: d.bic, bankName: d.bankName,
  });
}

// ── Vertrag + nächstmöglicher Kündigungstermin ──
function parseISO(s) { if (!s) return null; var d = new Date(String(s).slice(0, 10) + 'T00:00:00Z'); return isNaN(d.getTime()) ? null : d; }
function fmtDE(d) { if (!d) return null; var p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear(); }
function humanUnit(u) { u = String(u || '').toUpperCase(); if (u.indexOf('MONTH') >= 0) return 'Monate'; if (u.indexOf('YEAR') >= 0) return 'Jahre'; if (u.indexOf('WEEK') >= 0) return 'Wochen'; if (u.indexOf('DAY') >= 0) return 'Tage'; return u; }
function addPeriod(d, val, unit) {
  if (!d || !val) return d;
  var x = new Date(d.getTime()); unit = String(unit || '').toUpperCase();
  if (unit.indexOf('YEAR') >= 0) x.setUTCFullYear(x.getUTCFullYear() + val);
  else if (unit.indexOf('MONTH') >= 0) x.setUTCMonth(x.getUTCMonth() + val);
  else if (unit.indexOf('WEEK') >= 0) x.setUTCDate(x.getUTCDate() + val * 7);
  else if (unit.indexOf('DAY') >= 0) x.setUTCDate(x.getUTCDate() + val);
  return x;
}

async function getContract(id) {
  var r = await ml('GET', '/customers/' + encodeURIComponent(id) + '/contracts');
  if (r.status !== 200 || !Array.isArray(r.json) || !r.json.length) return null;
  var list = r.json.slice().sort(function (a, b) { return new Date(b.startDate || 0) - new Date(a.startDate || 0); });
  var c = list.find(function (x) { return !x.reversed && /ACTIVE|RUNNING|LAUF/i.test(String(x.contractStatus || '')); })
    || list.find(function (x) { return !x.reversed; }) || list[0];

  var now = new Date(Date.now());
  var end = parseISO(c.endDate);
  var deadline = parseISO(c.lastPossibleCancellationDate);
  var deadlinePassed = !!(deadline && now > deadline);
  var nextTarget = end;
  if (end && deadlinePassed && c.extensionTerm && c.extensionTerm.periodValue) {
    nextTarget = addPeriod(end, c.extensionTerm.periodValue, c.extensionTerm.periodUnit);
  }
  var cp = c.cancellationPeriod || {};

  // Aktiv vs. ehemalig – konservativ (lieber aktiv lassen als ein zahlendes Mitglied aussperren):
  // ehemalig nur, wenn das Vertragsende in der Vergangenheit liegt UND der Status nicht aktiv ist.
  // „gekündigt aber Laufzeit läuft noch" (endDate in der Zukunft) bleibt aktiv.
  var endISO = end ? end.toISOString().slice(0, 10) : null;
  var todayISO = now.toISOString().slice(0, 10);
  var statusActive = /ACTIVE|RUNNING|LAUF/i.test(String(c.contractStatus || ''));
  var ended = !!(endISO && endISO < todayISO);
  // Widerrufen/rückabgewickelt (reversed) -> Vertrag gilt als nie zustande gekommen,
  // also NICHT aktiv (auch wenn das Vertragsende noch in der Zukunft liegt).
  var reversed = !!(c.reversed || c.reversalReason || c.reversalDateTime);
  var active = !reversed && (statusActive || !ended);

  // Widerrufsrecht (14 Tage) – nur bei online/fern abgeschlossenen Verträgen.
  // Magicline contractOrigin für Online-Abschluss über die Connect API = "CONNECT_API";
  // dazu weitere Online-/Self-Service-Kennungen abdecken. Frist ab Vertragsabschluss (createdDate).
  var online = /WEB|ONLINE|ECOM|DISTANCE|CONNECT|SELF|PORTAL|DIGITAL/i.test(String(c.contractOrigin || ''));
  var created = parseISO(c.createdDate);
  var wdDeadline = null, wdDaysLeft = null, wdEligible = false;
  if (created) {
    wdDeadline = new Date(created.getTime());
    wdDeadline.setUTCDate(wdDeadline.getUTCDate() + 14);
    wdDaysLeft = Math.ceil((wdDeadline.getTime() - now.getTime()) / 86400000);
    wdEligible = online && !reversed && now.getTime() <= wdDeadline.getTime();
  }

  return {
    contractId: c.id,
    rateName: c.rateName || null,
    startDate: fmtDE(parseISO(c.startDate)),
    cancelled: !!c.cancelled,
    cancellationDate: c.cancelled ? fmtDE(parseISO(c.cancellationDate)) : null,
    reversed: reversed,
    active: active,
    endDate: fmtDE(end),
    endDateISO: endISO,
    deadline: fmtDE(deadline),
    deadlinePassed: deadlinePassed,
    cancellationPeriod: cp.periodValue ? (cp.periodValue + ' ' + humanUnit(cp.periodUnit)) : null,
    nextCancellationDate: fmtDE(nextTarget),
    nextCancellationDateISO: nextTarget ? nextTarget.toISOString().slice(0, 10) : null,
    contractOrigin: c.contractOrigin || null,
    online: online,
    withdrawalEligible: wdEligible,
    withdrawalDeadline: fmtDE(wdDeadline),
    withdrawalDaysLeft: (wdDaysLeft != null && wdDaysLeft >= 0) ? wdDaysLeft : null,
  };
}

module.exports = {
  hasStore, ml, isoDate, maskIban,
  createSession, getSession, bearer, rateLimit, readBody,
  findAndValidate, findByEmailDob, findByNumberDob, findByPhone, hashCode, otpSave, otpGet, otpDel,
  mlinkSave, mlinkGet, mlinkDel,
  getMember, publicProfile, writeAddress, writePayment,
  getContract,
};
