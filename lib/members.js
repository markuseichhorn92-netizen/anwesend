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

const ML_TIMEOUT_MS = 10000;   // hängendes Magicline darf die Serverless-Function nicht bis zum Plattform-Limit blockieren
// AbortController-Timeout; bei Abbruch/Netzfehler degradiert der Aufrufer sauber (status:0).
function mlTimeout() { const c = new AbortController(); const t = setTimeout(() => { try { c.abort(); } catch (e) {} }, ML_TIMEOUT_MS); return { signal: c.signal, done: () => clearTimeout(t) }; }

async function ml(method, path, body) {
  const opt = { method, headers: { 'x-api-key': API_KEY, Accept: 'application/json' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const to = mlTimeout(); opt.signal = to.signal;
  let r;
  try { r = await fetch(BASE + path, opt); }
  catch (e) { to.done(); return { status: 0, json: null, text: '' }; }
  to.done();
  const text = await r.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text };
}

// Multipart-Upload zu Magicline: für Spring-Endpunkte mit @RequestPart, die KEIN
// application/json am Gesamt-Request akzeptieren (z. B. Idle-Period-Create mit
// optionalem Nachweis-Dokument). parts: [{name, json}] -> JSON-Part (Content-Type
// application/json), [{name, base64, type?, filename?}] -> Datei-Part, [{name, value}]
// -> einfaches Feld. WICHTIG: Content-Type wird NICHT gesetzt – fetch ergänzt den
// multipart/form-data-Header inkl. boundary selbst. Wirft nie.
async function mlForm(method, path, parts) {
  let form;
  try {
    form = new FormData();
    (parts || []).forEach((p) => {
      if (!p || !p.name) return;
      if (p.json !== undefined) {
        form.append(p.name, new Blob([JSON.stringify(p.json)], { type: 'application/json' }), p.filename || (p.name + '.json'));
      } else if (p.base64 !== undefined) {
        const buf = Buffer.from(String(p.base64 || ''), 'base64');
        form.append(p.name, new Blob([buf], { type: p.type || 'application/octet-stream' }), p.filename || p.name);
      } else if (p.value !== undefined) {
        form.append(p.name, String(p.value));
      }
    });
  } catch (e) { return { status: 0, json: null, text: '' }; }
  let r;
  const to = mlTimeout();
  try { r = await fetch(BASE + path, { method, headers: { 'x-api-key': API_KEY, Accept: 'application/json' }, body: form, signal: to.signal }); }
  catch (e) { to.done(); return { status: 0, json: null, text: '' }; }
  to.done();
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

// ALLE Datensätze zu E-Mail + Geburtsdatum (Dubletten-Erkennung).
async function findAllByEmailDob(email, dob) {
  const e = String(email || '').trim().toLowerCase();
  const wantDob = isoDate(dob);
  if (!e || !wantDob) return [];
  const r = await ml('POST', '/customers/search', { email: e });
  if (r.status !== 200 || !Array.isArray(r.json)) return [];
  return r.json.filter((c) => isoDate(c.dateOfBirth) === wantDob);
}

// Telefonnummer ÜBER ALLE Dubletten hinweg ermitteln. Magicline-Suche liefert oft
// keine Telefonfelder -> Vollprofile (gekappt) nachladen. So findet der WhatsApp-Code
// die Nummer auch dann, wenn sie an einem anderen Datensatz derselben Person hängt.
async function phoneByEmailDob(email, dob) {
  const matches = await findAllByEmailDob(email, dob);
  if (!matches.length) return null;
  for (const c of matches) { const p = c.phonePrivate || c.phoneMobile || c.phoneBusiness; if (p) return p; }
  const fulls = await Promise.all(matches.slice(0, 10).map(async (c) => {
    const id = c.id != null ? c.id : c.customerId;
    try { return await getMember(id); } catch (e) { return null; }
  }));
  for (const f of fulls) { if (f) { const p = f.phonePrivate || f.phoneMobile || f.phoneBusiness; if (p) return p; } }
  return null;
}

// Bei Dubletten das KONTO MIT MITGLIEDSCHAFT wählen (niemand hat zwei aktive
// Verträge auf zwei Konten). Liefert genau diesen Datensatz – oder null, wenn es
// mehrdeutig ist (0 oder mehrere mit Vertrag) -> dann Mitgliedsnummer abfragen.
async function pickMembershipAccount(matches) {
  const list = (matches || []).slice(0, 6);
  const scored = await Promise.all(list.map(async (c) => {
    const id = c.id != null ? c.id : c.customerId;
    let ct = null; try { ct = await getContract(id); } catch (e) {}
    return { c: c, has: !!ct, active: !!(ct && ct.active !== false && !ct.reversed) };
  }));
  const actives = scored.filter((s) => s.active);
  if (actives.length === 1) return actives[0].c;        // genau eine aktive Mitgliedschaft
  const withC = scored.filter((s) => s.has);
  if (withC.length === 1) return withC[0].c;            // genau ein Konto mit (beendetem) Vertrag
  return null;                                          // mehrdeutig -> Mitgliedsnummer
}

// Kunden über die E-Mail suchen (alle Treffer, für Dubletten-/Existenzprüfung).
async function searchByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return [];
  const r = await ml('POST', '/customers/search', { email: e });
  return (r.status === 200 && Array.isArray(r.json)) ? r.json : [];
}

// Login-Auflösung mit Dubletten-Schutz: unter allen Datensätzen zu E-Mail+Geburtsdatum
// den ECHTEN Mitglieds-Datensatz als Identität wählen (Vertrag > Mitgliedsnummer >
// Stammdaten) und die Telefonnummer über ALLE Dubletten einsammeln.
// Liefert { member, phone, duplicates } oder null.
async function resolveLogin(email, dob) {
  const matches = await findAllByEmailDob(email, dob);
  if (!matches.length) return null;
  const fulls = await Promise.all(matches.slice(0, 6).map(async (c) => {
    const id = c.id != null ? c.id : c.customerId;
    try { const f = await getMember(id); return f || c; } catch (e) { return c; }
  }));
  let phone = null;
  for (const f of fulls) { const p = f && (f.phonePrivate || f.phoneMobile || f.phoneBusiness); if (p) { phone = p; break; } }
  if (fulls.length === 1) return { member: fulls[0], phone: phone, duplicates: 1 };
  // Mehrere Datensätze -> „echtes Mitglied" gewinnt (Vertrag zählt am meisten).
  const scored = await Promise.all(fulls.map(async (f) => {
    const id = f.id != null ? f.id : f.customerId;
    let hasContract = false; try { hasContract = !!(await getContract(id)); } catch (e) {}
    let s = 0;
    if (hasContract) s += 100;
    if (f.customerNumber) s += 10;
    if (f.bankAccount && f.bankAccount.iban) s += 5;
    if (f.phonePrivate || f.phoneMobile || f.phoneBusiness) s += 3;
    if (f.street) s += 2;
    return { f: f, s: s };
  }));
  scored.sort((a, b) => b.s - a.s);
  return { member: scored[0].f, phone: phone, duplicates: fulls.length };
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
  if (d.indexOf('49') === 0) {                     // international (4915…)
    const nat = d.slice(2);                        // 15…
    set.add('0' + nat).add('+49' + nat).add('49' + nat).add('0049' + nat).add(nat);
  }
  if (d.indexOf('0') === 0 && d.indexOf('00') !== 0) {  // national (0151…)
    const nat = d.slice(1);                        // 151…
    set.add('49' + nat).add('+49' + nat).add('0049' + nat).add(nat);
  }
  if (d.indexOf('0049') === 0) {                   // 0049…
    const nat = d.slice(4);
    set.add('49' + nat).add('+49' + nat).add('0' + nat).add(nat);
  }
  return Array.from(set);
}
// Telefonnummer auf eine kanonische Ziffernform bringen (DE): 0049/00 -> weg,
// führende 0 (national) -> 49…, sonst unverändert. Damit sind 0151…, +4915…,
// 4915…, „0151 20…" alle vergleichbar.
function normDePhone(s) {
  let d = String(s || '').replace(/[^\d]/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.indexOf('0') === 0) d = '49' + d.slice(1);
  return d;
}
// Alle Telefon-Felder eines Kunden kanonisch einsammeln (phonePrivate/Mobile/… ).
function customerPhoneSet(c) {
  const out = new Set();
  if (!c || typeof c !== 'object') return out;
  Object.keys(c).forEach((k) => {
    if (/phone|mobile|tel/i.test(k)) {
      const v = c[k];
      if (typeof v === 'string' && v.replace(/[^\d]/g, '').length >= 6) out.add(normDePhone(v));
    }
  });
  return out;
}
// Mitglied über die Telefonnummer finden. Magiclines phoneNumber-Suche ist unscharf
// (liefert oft viele Kandidaten), daher: Kandidaten über alle Formatvarianten sammeln
// und anschließend SELBST exakt nach der kanonischen Nummer filtern.
async function findByPhone(num) {
  const target = normDePhone(num);
  if (!target) return null;
  const cands = new Map();   // id -> { c, hits } : über alle Varianten dedupliziert + gezählt
  for (const p of phoneVariants(num)) {
    let r;
    try { r = await ml('POST', '/customers/search', { phoneNumber: p }); } catch (e) { continue; }
    if (r && r.status === 200 && Array.isArray(r.json)) {
      for (const c of r.json) {
        const id = c && (c.id != null ? c.id : c.customerId);
        if (id == null) continue;
        const key = String(id);
        const ex = cands.get(key);
        if (ex) ex.hits++; else cands.set(key, { c: c, hits: 1 });
      }
    }
  }
  if (!cands.size) return null;
  const all = Array.from(cands.values());
  // 1) Direkt anhand der Telefonfelder aus dem Suchergebnis (falls vorhanden).
  let exact = all.filter((e) => customerPhoneSet(e.c).has(target));
  // 2) Sonst Vollprofile nachladen und exakt filtern. Da Magiclines Telefonsuche
  //    unscharf ist (oft >20 Kandidaten), NICHT pauschal kappen, sondern nach
  //    Treffer-Häufigkeit priorisieren: der echte Eigentümer der Nummer matcht in
  //    mehreren Schreibweisen (z. B. „+4915…", „0151…", „15…") und steht damit oben.
  if (!exact.length) {
    let pool = all.filter((e) => e.hits >= 2);     // Mehrfachtreffer zuerst
    if (!pool.length) pool = all;                  // sonst alle betrachten
    pool = pool.sort((a, b) => b.hits - a.hits).slice(0, 25);
    const fulls = await Promise.all(pool.map(async (e) => {
      const id = e.c.id != null ? e.c.id : e.c.customerId;
      let full = null; try { full = await getMember(id); } catch (er) {}
      return (full && customerPhoneSet(full).has(target)) ? { c: full, hits: e.hits } : null;
    }));
    exact = fulls.filter(Boolean);
  }
  if (!exact.length) return null;
  exact.sort((a, b) => b.hits - a.hits);           // bei Gleichstand: häufigster Treffer
  return exact[0].c;
}

// Diagnose: zeigt pro Formatvariante, wie viele Treffer Magicline liefert.
// -> [{ variant, status, count }]  (für die „nicht zugeordnet"-Mail).
async function phoneSearchDebug(num) {
  const out = [];
  for (const p of phoneVariants(num)) {
    let status = 0, count = 0;
    try { const r = await ml('POST', '/customers/search', { phoneNumber: p }); status = (r && r.status) || 0; count = (r && Array.isArray(r.json)) ? r.json.length : 0; }
    catch (e) { status = -1; }
    out.push({ variant: p, status: status, count: count });
  }
  return out;
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
// Kontaktdaten (E-Mail/Telefon). Nur gesetzte Felder senden, damit nichts überschrieben wird.
async function writeContact(id, d) {
  const body = {};
  if (d.email != null && String(d.email).trim() !== '') body.email = String(d.email).trim();
  if (d.phone != null && String(d.phone).trim() !== '') body.phonePrivate = String(d.phone).trim();
  if (d.phoneMobile != null && String(d.phoneMobile).trim() !== '') body.phonePrivateMobile = String(d.phoneMobile).trim();
  return ml('POST', `/customers/${encodeURIComponent(id)}/self-service/contact-data`, body);
}

// In-App-Check-in (Scope CHECKIN_WRITE): manuellen Studio-Besuch eintragen.
// when = ISO-8601-Zeit (optional; ohne Angabe nutzt Magicline die aktuelle Zeit).
async function checkinCustomer(id, when) {
  const body = {};
  if (when) body.checkInDateTime = when;
  return ml('POST', '/customers/' + encodeURIComponent(id) + '/checkin', body);
}

// In-App-Check-out (Scope CHECKIN_WRITE): Studio-Besuch beenden.
async function checkoutCustomer(id, when) {
  const body = {};
  if (when) body.checkOutDateTime = when;
  return ml('POST', '/customers/' + encodeURIComponent(id) + '/checkout', body);
}

// ── Leads (Interessenten) – Magicline Open API (Scope LEAD_READ/LEAD_WRITE) ──
// Config des Lead-Formulars: welche Felder Pflicht sind (Adresse/Geburtsdatum/…),
// damit wir nur dann automatisch anlegen, wenn unsere Daten ausreichen.
async function getLeadConfig() {
  const r = await ml('GET', '/leads/config');
  return r.status === 200 ? r.json : null;
}
// Lead anlegen. Pflicht: firstname, lastname, email. telephone optional (aber
// sinnvoll, damit künftiges Telefon-Matching greift). Liefert customerId/-Number.
async function createLead(d) {
  d = d || {};
  const leadCustomer = { firstname: d.firstname, lastname: d.lastname, email: d.email };
  if (d.telephone) leadCustomer.telephone = d.telephone;
  if (d.gender) leadCustomer.gender = d.gender;
  if (d.dateOfBirth) leadCustomer.dateOfBirth = d.dateOfBirth;
  const body = { leadCustomer };
  if (d.address) body.address = d.address;
  const r = await ml('POST', '/leads/create', body);
  const j = (r && r.json) || {};
  const customerId = j.customerId != null ? j.customerId : (j.id != null ? j.id : null);
  return {
    ok: r.status >= 200 && r.status < 300 && customerId != null,
    status: r.status, customerId: customerId, customerNumber: j.customerNumber || null,
    body: (r.text || '').slice(0, 300),
  };
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

// ── Check-in-Verlauf (Magicline: GET /customers/{id}/activities/checkins) ──
// WICHTIG: Ohne fromDate/toDate liefert Magicline nur „einen Monat ab heute"
// (so dokumentiert). Ein reines offset-Paging blättert NUR innerhalb dieses
// Monats – rückwirkende Besuche bleiben unsichtbar. Deshalb laufen wir in
// Fenstern à <=365 Tagen (toDate darf max. 365 Tage nach fromDate liegen)
// rückwärts durch die Historie und paginieren INNERHALB jedes Fensters.

function ymd(d) {                                   // Date -> 'YYYY-MM-DD' (lokal)
  var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}
function mapCheckin(c) { return { in: c.checkInDateTime || null, out: c.checkOutDateTime || null, studio: c.studioName || null }; }
function byNewest(a, b) { return new Date(b.in) - new Date(a.in); }

// Ein Zeitfenster (<=365 Tage) paginiert abrufen -> rohe Check-in-Objekte. Nie werfen.
async function _checkinWindow(id, fromISO, toISO) {
  var SLICE = 50, out = [], offset = '0';
  for (var page = 0; page < 80; page++) {           // Kappe: 80*50 = 4000 pro Fenster
    var q = '/customers/' + encodeURIComponent(id) + '/activities/checkins?sliceSize=' + SLICE
          + '&fromDate=' + fromISO + '&toDate=' + toISO + '&offset=' + encodeURIComponent(offset);
    var r;
    try { r = await ml('GET', q); } catch (e) { break; }
    if (!r || r.status !== 200 || !r.json) break;   // 403 = Scope fehlt
    var list = Array.isArray(r.json.result) ? r.json.result : [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    if (!r.json.hasNext || list.length === 0) break;
    var next = r.json.offset;                        // Cursor ist ein String
    if (next == null || String(next) === String(offset)) break;
    offset = String(next);
  }
  return out;
}

// Rückwärts über Fenster à <=350 Tagen laufen. cb(rows, windowIndex) -> false stoppt.
// opts.windows = max. Fensterzahl, opts.fromDate = feste Untergrenze. Nie werfen.
async function _walkCheckins(id, opts, cb) {
  opts = opts || {};
  var WINDOW = 350;                                 // < 365 (Sicherheitsabstand)
  var maxWindows = Math.max(1, opts.windows || 12);
  var earliest = null;
  if (opts.fromDate) { var e = new Date(opts.fromDate); if (!isNaN(e)) earliest = e; }
  try {
    var to = new Date();
    for (var w = 0; w < maxWindows; w++) {
      var from = new Date(to.getTime()); from.setDate(from.getDate() - WINDOW);
      var stop = false;
      if (earliest && from < earliest) { from = new Date(earliest.getTime()); stop = true; }
      var rows = await _checkinWindow(id, ymd(from), ymd(to));
      if (cb(rows, w) === false) return;
      if (stop) return;
      to = new Date(from.getTime()); to.setDate(to.getDate() - 1);   // nächstes (älteres) Fenster
      if (earliest && to < earliest) return;
    }
  } catch (e) {}
}

// Vollständiger Check-in-Verlauf (Team-Ansicht & Anwesenheitsbestätigung).
// Ohne feste Untergrenze (opts.fromDate) stoppt es nach 2 leeren Fenstern in
// Folge (= vor der Mitgliedschaft). 403/Fehler -> []. Absteigend sortiert.
async function checkinHistory(id, opts) {
  opts = opts || {};
  var byKey = {}, emptyStreak = 0, bounded = !!opts.fromDate;
  await _walkCheckins(id, opts, function (rows) {
    if (!rows.length) { emptyStreak++; return (!bounded && emptyStreak >= 2) ? false : true; }
    emptyStreak = 0;
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      var key = (c && c.checkinId != null) ? ('id:' + c.checkinId) : ('t:' + (c && c.checkInDateTime));
      if (!byKey[key]) byKey[key] = c;
    }
    return true;
  });
  return Object.keys(byKey).map(function (k) { return mapCheckin(byKey[k]); })
    .filter(function (c) { return c.in; }).sort(byNewest);
}

// Jüngste Check-ins über einen begrenzten Lookback (Trend/„letzter Besuch").
// Standard: bis zu 2 Fenster (~2 Jahre). Absteigend (Index 0 = letzter Check-in).
async function recentCheckins(id, opts) {
  opts = opts || {};
  var windows = opts.windows || (opts.pages ? Math.max(1, Math.ceil(opts.pages / 4)) : 2);
  return await checkinHistory(id, { windows: windows });
}

// Tage seit dem letzten Check-in (ganzzahlig) oder null. Läuft rückwärts und
// stoppt beim ERSTEN Fenster mit Daten – der jüngste Eintrag darin ist der
// letzte Besuch. So werden auch länger inaktive Mitglieder erkannt (bis ~4 J.).
async function daysSinceLastCheckin(id, opts) {
  opts = opts || {};
  var found = null;
  await _walkCheckins(id, { windows: opts.windows || 4 }, function (rows) {
    if (!rows.length) return true;                  // weiter ins ältere Fenster
    var newest = rows.map(mapCheckin).filter(function (c) { return c.in; }).sort(byNewest)[0];
    if (newest) { found = newest.in; return false; }
    return true;
  });
  if (!found) return null;
  var last = new Date(found).getTime();
  if (!Number.isFinite(last)) return null;
  return Math.floor((Date.now() - last) / 86400000);
}

module.exports = {
  hasStore, ml, mlForm, isoDate, maskIban,
  createSession, getSession, bearer, rateLimit, readBody,
  findAndValidate, findByEmailDob, findAllByEmailDob, phoneByEmailDob, pickMembershipAccount, searchByEmail, resolveLogin, findByNumberDob, findByPhone, phoneSearchDebug, hashCode, otpSave, otpGet, otpDel,
  mlinkSave, mlinkGet, mlinkDel,
  getMember, publicProfile, writeAddress, writePayment, writeContact, checkinCustomer, checkoutCustomer,
  getLeadConfig, createLead,
  getContract, recentCheckins, daysSinceLastCheckin, checkinHistory,
};
