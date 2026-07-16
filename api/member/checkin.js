'use strict';

/**
 * POST /api/member/checkin   (Authorization: Bearer <token>)
 * In-App-Check-in: trägt einen Studio-Besuch des angemeldeten Mitglieds in
 * Magicline ein (Scope CHECKIN_WRITE → POST /v1/customers/{id}/checkin).
 *
 * Serverseitige Prüfungen (der Client wird grundsätzlich nicht als
 * vertrauenswürdig behandelt – Standort-Checks im Browser sind nur Komfort):
 *  1. gültige Sitzung (Bearer)
 *  2. aktiver Vertrag / Check-in-Berechtigung (Magicline-Vertragsstatus)
 *  3. Wiederholungs-/Missbrauchsschutz (3 Versuche je 30 Min + Tageskappe)
 *
 * Studiozugehörigkeit: die App bedient genau EIN Studio (Single-Tenant,
 * ML_TENANT) – der Magicline-Check-in läuft immer gegen dieses Studio.
 * Ein kurzlebiger, signierter QR-/NFC-Challenge-Mechanismus (Code am Eingang,
 * einmalig verwendbar) ist in docs/SECURITY.md spezifiziert; er braucht einen
 * Code-Generator auf Studioseite und wird deshalb hier bewusst NICHT durch
 * einen unsicheren Ersatz vorweggenommen.
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  // Doppel-/Spam-Schutz: max. 3 Versuche je 30 Min (erlaubt Wiederholung bei Fehler)
  // plus Tageskappe gegen Dauer-Missbrauch.
  if (!(await M.rateLimit('checkin:' + sess.id, 3, 1800))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Du hast dich gerade erst eingecheckt.' }));
  }
  if (!(await M.rateLimit('checkin:day:' + sess.id, 8, 86400))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Check-ins heute – bitte melde dich an der Theke.' }));
  }

  // Aktiver Vertrag / Check-in-Berechtigung: ehemalige oder widerrufene
  // Mitgliedschaften können sich nicht mehr einchecken. Ist Magicline gerade
  // nicht erreichbar (Vertrag nicht ladbar), wird NICHT eingecheckt.
  let ct = null;
  try { ct = await M.getContract(sess.id); } catch (e) {}
  if (!ct) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, message: 'Check-in gerade nicht möglich. Bitte an der Theke einchecken.' }));
  }
  if (ct.active === false) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, message: 'Für dein Konto ist keine aktive Mitgliedschaft hinterlegt – bitte melde dich an der Theke.' }));
  }

  const at = new Date().toISOString();
  let r;
  try { r = await M.checkinCustomer(sess.id, at); } catch (e) { r = { status: 0 }; }

  if (r && r.status >= 200 && r.status < 300) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, at: at, message: 'Eingecheckt – viel Spaß beim Training! 💪' }));
  }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: false, message: 'Check-in gerade nicht möglich. Bitte an der Theke einchecken.' }));
};
