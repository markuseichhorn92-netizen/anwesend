'use strict';

/**
 * POST /api/member/login-number   { customerNumber, dob, remember }
 * Fallback-Login für Mitglieder OHNE hinterlegte E-Mail: Mitgliedsnummer +
 * Geburtsdatum. Wissensbasiert (kein Code) – daher bewusst nur erlaubt, wenn
 * für das Konto KEINE E-Mail hinterlegt ist. Mitglieder MIT E-Mail müssen den
 * (stärkeren) E-Mail-Code-Login nutzen.
 *
 * Härtung:
 *  - Rate-Limit pro IP UND pro Mitgliedsnummer – beide Ergebnisse werden
 *    ausgewertet (vorher wurde das Nummern-Limit nur gezählt, nie geprüft).
 *  - Strikte Normalisierung/Validierung von Nummer + Geburtsdatum, bevor
 *    irgendetwas die Magicline-API erreicht.
 *  - Generische Fehlermeldung (verrät nicht, ob eine Nummer existiert).
 *  - Sitzungsdauer gedeckelt: dieser reine Wissens-Login erzeugt KEINE
 *    30-Tage-Sitzung mehr (max. 24 h, Standard 30 min). Für lange Sitzungen
 *    ist ein besitzbasierter Kanal nötig (E-Mail-Code/Magic-Link) – siehe
 *    docs/SECURITY.md („OTP-/Aktivierungskanal für Nummer-Login").
 */

const M = require('../../lib/members');
const { sendLoginCode } = require('../../lib/loginCode');

const GENERIC_FAIL = 'Anmeldung nicht möglich. Bitte Eingaben prüfen oder den E-Mail-Login nutzen.';

// Mitgliedsnummer: optional "M-"/"M" Präfix + 1–12 Ziffern (Magicline-Format).
function normCustomerNumber(v) {
  const n = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!n || n.length > 16) return null;
  if (!/^M?-?\d{1,12}$/.test(n)) return null;
  return n;
}
// Geburtsdatum: gültiges Kalenderdatum, plausibles Alter (10–120 Jahre).
function normDob(v) {
  const iso = M.isoDate(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  const age = (Date.now() - d.getTime()) / (365.25 * 86400000);
  if (age < 10 || age > 120) return null;
  return iso;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!M.hasStore) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'no_store' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('numlogin:ip:' + ip, 8, 600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche. Bitte später erneut.' }));
  }

  const d = await M.readBody(req);
  const num = normCustomerNumber(d.customerNumber);
  const dobISO = normDob(d.dob);
  if (!num || !dobISO) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, message: 'Bitte Mitgliedsnummer und Geburtsdatum angeben.' }));
  }

  // Rate-Limit pro Mitgliedsnummer – Ergebnis wird ausgewertet (nicht nur gezählt).
  if (!(await M.rateLimit('numlogin:n:' + num.replace(/^M-?/, ''), 6, 1800))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche. Bitte später erneut.' }));
  }

  try {
    const m = await M.findByNumberDob(num, dobISO);
    if (!m) {
      // Generisch: verrät nicht, ob die Nummer existiert oder nur das Datum falsch war.
      res.statusCode = 401; return res.end(JSON.stringify({ ok: false, message: GENERIC_FAIL }));
    }
    if (m.email) {
      // Konto hat eine E-Mail: aus Sicherheitsgründen Code/Magic-Link an die
      // hinterlegte Adresse schicken und zur Code-Eingabe weiterleiten.
      const r = await sendLoginCode(m, req.headers['host']);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, needsCode: true, challenge: r.challenge, via: (r && r.channel) || 'email', delivered: !!(r && r.channel) }));
    }
    // Wissensbasierter Login: Sitzung bewusst kurz. remember=true verlängert nur
    // auf 24 h (statt vormals 30 Tage) – lange Sitzungen erfordern einen
    // besitzbasierten Login-Kanal (siehe docs/SECURITY.md).
    const token = await M.createSession(m.id, d.remember ? 86400 : 1800);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, token: token }));
  } catch (e) {
    res.statusCode = 500; return res.end(JSON.stringify({ ok: false, message: 'Es ist ein Fehler aufgetreten.' }));
  }
};
