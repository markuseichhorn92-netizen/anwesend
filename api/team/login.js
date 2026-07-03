'use strict';

/**
 * Team-Login (Studio-Backend). POST, Content-Type: application/json.
 * Drei Wege (Reihenfolge: erst action prüfen):
 *   1) Passwort (kein action / { password })      -> Admin-Session { role:'admin' }
 *   2) { action:'requestCode', email }            -> 6-stelliger Code an die
 *      Magicline-Mitarbeiter-Adresse (nur an echte Mitarbeiter!)
 *   3) { action:'verifyCode', challenge, code }   -> Trainer-Session mit eigener
 *      Identität { role:'trainer', employeeId, email }
 *
 * Das gemeinsame TEAM_PASSWORD bleibt als Admin-Login (Weg 1) bestehen.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');       // readBody + rateLimit (wiederverwenden)
const TS = require('../../lib/teamStaff');     // Trainer-Login per E-Mail-Code
const { hasMail } = require('../../lib/mail');
const WA = require('../../lib/whatsapp');      // Code optional per WhatsApp

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  const body = await M.readBody(req);
  const action = body && body.action;

  // ── Weg 2: Trainer – Code anfordern ──
  if (action === 'requestCode') {
    if (!(await M.rateLimit('team-code:' + ip, 6, 600))) {
      res.statusCode = 429;
      return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche – bitte ein paar Minuten warten.' }));
    }
    const emp = await TS.findEmployeeByEmail(body.email);
    if (!emp) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, message: 'Diese E-Mail gehört zu keinem Mitarbeiter.' }));
    }
    if (!hasMail && !WA.hasWaLogin) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, message: 'Code-Versand ist noch nicht eingerichtet.' }));
    }
    // Gewünschter Kanal ('whatsapp'|'email'); ohne WhatsApp-Setup oder ohne
    // hinterlegte Nummer fällt sendStaffCode still auf E-Mail zurück.
    const channel = (body.channel === 'whatsapp') ? 'whatsapp' : 'email';
    const r = await TS.sendStaffCode(emp, req.headers['host'] || '', { channel: channel });
    if (!r || !r.ok) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, message: 'Code konnte nicht gesendet werden. Bitte später erneut versuchen.' }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, challenge: r.challenge, channel: r.channel || 'email' }));
  }

  // ── Weg 3: Trainer – Code prüfen ──
  if (action === 'verifyCode') {
    if (!(await M.rateLimit('team-verify:' + ip, 12, 600))) {
      res.statusCode = 429;
      return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche – bitte ein paar Minuten warten.' }));
    }
    const v = await TS.verifyStaffCode(body.challenge, body.code);
    if (!v || !v.ok) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, message: 'Code falsch oder abgelaufen.' }));
    }
    const token = await TA.createSession({ user: v.name, employeeId: v.employeeId, email: v.email, role: 'trainer' });
    if (!token) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: 'no_session' })); }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, token, ttl: TA.TTL, name: v.name }));
  }

  // ── Weg 1: Admin – gemeinsames Team-Passwort (Standard) ──
  // Der hasTeamAuth-Check (TEAM_PASSWORD) gilt NUR für diesen Weg.
  if (!TA.hasTeamAuth) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, disabled: true, message: 'Team-Login ist noch nicht eingerichtet (TEAM_PASSWORD fehlt).' }));
  }
  if (!(await M.rateLimit('team-login:' + ip, 10, 600))) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche – bitte ein paar Minuten warten.' }));
  }
  if (!TA.verifyPassword(body.password)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, message: 'Falsches Passwort.' }));
  }
  const token = await TA.createSession({ user: 'Admin', role: 'admin' });
  if (!token) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: 'no_session' })); }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, token, ttl: TA.TTL }));
};
