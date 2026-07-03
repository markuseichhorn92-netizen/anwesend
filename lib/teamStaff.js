'use strict';

/**
 * Individueller Trainer-Login per E-Mail-Code (Team-Backend).
 * ----------------------------------------------------------
 * Prüft die eingegebene E-Mail gegen die echte Magicline-Mitarbeiterliste
 * (GET /employees, Scope EMPLOYEE_READ), verschickt einen 6-stelligen
 * Einmal-Code AUSSCHLIESSLICH an die dort hinterlegte Adresse und meldet den
 * Trainer anschließend mit seiner EIGENEN Identität an.
 *
 * Sicherheit:
 *  - Codes werden NUR gehasht gespeichert (M.hashCode), nie im Klartext.
 *  - TTL 10 Min, max. 5 Fehlversuche -> Code invalidieren.
 *  - Timing-sicherer Vergleich der Hashes.
 *  - Eigene KV-Keys (tstaff:*), getrennt von den Member-OTP-Keys (motp:*).
 *  - Wirft nie: alle Pfade liefern null bzw. { ok:false }.
 */

const crypto = require('node:crypto');
const M = require('./members');
const { redisPipeline, hasStore } = require('./store');
const { sendMailRaw, hasMail } = require('./mail');
const { renderEmail } = require('./emailTemplate');

const TTL = 600;        // 10 Minuten
const MAX_TRIES = 5;    // > 5 -> Code invalidieren
const KEY = 'tstaff:';  // eigener Namespace (nicht mit motp: mischen)
const MAX_PAGES = 20;   // Sicherheitskappe für die Paginierung

// Initialen aus employeeInitials oder – als Fallback – aus dem Namen ableiten.
function deriveInitials(first, last, publicName) {
  const f = String(first || '').trim();
  const l = String(last || '').trim();
  let ini = ((f[0] || '') + (l[0] || '')).toUpperCase();
  if (ini) return ini;
  const p = String(publicName || '').trim();
  if (p) {
    const parts = p.split(/\s+/).filter(Boolean);
    ini = (((parts[0] && parts[0][0]) || '') + ((parts[1] && parts[1][0]) || '')).toUpperCase();
    if (ini) return ini;
  }
  return null;
}

function mapEmployee(e) {
  if (!e || e.id == null) return null;
  const first = String(e.firstName || '').trim();
  const last = String(e.lastName || '').trim();
  let name = (first + ' ' + last).trim();
  if (!name) name = String(e.publicName || '').trim();
  if (!name) name = 'Mitarbeiter ' + e.id;
  let initials = String(e.employeeInitials || '').trim().toUpperCase();
  if (!initials) initials = deriveInitials(first, last, e.publicName);
  return { id: String(e.id), name: name, email: String(e.email || '').trim(), initials: initials || null };
}

// Mitarbeiter über die in Magicline hinterlegte E-Mail finden (trim, case-insensitive).
// Paginiert GET /employees (sliceSize/offset). 403 (Scope fehlt) oder Fehler -> null.
async function findEmployeeByEmail(email) {
  try {
    const want = String(email || '').trim().toLowerCase();
    if (!want) return null;
    const SLICE = 50;
    let offset = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = '/employees?sliceSize=' + SLICE + (offset ? ('&offset=' + encodeURIComponent(offset)) : '');
      let r;
      try { r = await M.ml('GET', q); } catch (e) { return null; }
      if (!r || r.status !== 200 || !r.json) return null;   // 403 = Scope fehlt
      const list = Array.isArray(r.json.result) ? r.json.result : (Array.isArray(r.json) ? r.json : []);
      for (const e of list) {
        const em = String((e && e.email) || '').trim().toLowerCase();
        if (em && em === want) return mapEmployee(e);
      }
      if (!r.json.hasNext || !list.length) break;
      offset = r.json.offset || null;
      if (!offset) break;
    }
    return null;
  } catch (e) { return null; }
}

// 6-stelligen Code erzeugen, GEHASHT in KV ablegen (tstaff:<challenge>, TTL 600)
// und AUSSCHLIESSLICH an die Mitarbeiter-Adresse mailen. Liefert { ok, challenge }.
async function sendStaffCode(employee, host) {
  try {
    if (!employee || !employee.email || !hasStore || !hasMail) return { ok: false };
    const code = String(crypto.randomInt(100000, 1000000));
    const challenge = crypto.randomBytes(24).toString('hex');
    const exp = Date.now() + TTL * 1000;
    const rec = {
      employeeId: employee.id,
      name: employee.name,
      email: employee.email,
      codeHash: M.hashCode(code),   // NUR der Hash landet im Store
      exp: exp,
      tries: 0,
    };
    await redisPipeline([['SET', KEY + challenge, JSON.stringify(rec), 'EX', String(TTL)]]);

    const mail = renderEmail({
      preheader: 'Dein Team-Anmelde-Code: ' + code + ' (10 Minuten gültig)',
      name: String(employee.name || '').split(' ')[0] || '',
      eyebrow: 'Team-Anmeldung',
      headline: 'Dein Team-Anmelde-Code',
      intro: 'Gib diesen Code im Team-Backend ein, um dich anzumelden. Er ist 10 Minuten gültig.',
      code: { label: 'Dein Team-Anmelde-Code', value: code, spacing: 12, size: 36 },
      note: 'Du hast keine Anmeldung angefordert? Dann ignoriere diese E-Mail einfach – dein Zugang bleibt sicher.',
      footer: 'security',
    });
    const res = await sendMailRaw({
      to: employee.email,
      subject: 'Dein Team-Anmelde-Code: ' + code + ' – Fit-Inn Trier',
      text: mail.text,
      html: mail.html,
    });
    if (!res || !res.ok) {
      // Zustellung fehlgeschlagen -> Code wieder verwerfen (nichts Gültiges liegen lassen).
      try { await redisPipeline([['DEL', KEY + challenge]]); } catch (e) {}
      return { ok: false };
    }
    return { ok: true, challenge: challenge };
  } catch (e) { return { ok: false }; }
}

// Code prüfen. Fehlt/abgelaufen -> { ok:false }. tries++ ; > 5 -> Key löschen +
// { ok:false, error:'too_many' }. Timing-sicherer Hash-Vergleich; Erfolg ->
// Key löschen + Identität, sonst erhöhten tries zurückspeichern + { ok:false }.
async function verifyStaffCode(challenge, code) {
  try {
    if (!challenge || !hasStore) return { ok: false };
    const [v] = await redisPipeline([['GET', KEY + challenge]]);
    if (!v) return { ok: false };
    let rec = null;
    try { rec = JSON.parse(v); } catch (e) { return { ok: false }; }
    if (!rec || (rec.exp && Date.now() > rec.exp)) {
      try { await redisPipeline([['DEL', KEY + challenge]]); } catch (e) {}
      return { ok: false };
    }

    rec.tries = (Number(rec.tries) || 0) + 1;
    if (rec.tries > MAX_TRIES) {
      try { await redisPipeline([['DEL', KEY + challenge]]); } catch (e) {}
      return { ok: false, error: 'too_many' };
    }

    const want = String(rec.codeHash || '');
    const got = M.hashCode(String(code == null ? '' : code));
    let match = false;
    try {
      const a = Buffer.from(want), b = Buffer.from(got);
      match = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) { match = false; }

    if (match) {
      try { await redisPipeline([['DEL', KEY + challenge]]); } catch (e) {}
      return { ok: true, employeeId: rec.employeeId, name: rec.name, email: rec.email };
    }

    // Fehlversuch: erhöhten Zähler mit verbleibender TTL zurückspeichern (Fenster nicht verlängern).
    const remain = rec.exp ? Math.max(1, Math.floor((rec.exp - Date.now()) / 1000)) : TTL;
    try { await redisPipeline([['SET', KEY + challenge, JSON.stringify(rec), 'EX', String(remain)]]); } catch (e) {}
    return { ok: false };
  } catch (e) { return { ok: false }; }
}

module.exports = { findEmployeeByEmail, sendStaffCode, verifyStaffCode };
