'use strict';

/**
 * POST /api/member/login-magic   { token }
 * Tauscht einen Magic-Link-Token (aus der E-Mail, 10 Min gültig, einmalig) gegen
 * ein Sitzungs-Token. Wird beim Öffnen von /mitglieder?mlt=... aufgerufen.
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!M.hasStore) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'no_store' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('magic:ip:' + ip, 20, 600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche. Bitte später erneut.' }));
  }

  const d = await M.readBody(req);
  const token = String(d.token || '');
  if (!token) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Ungültiger Link.' })); }

  const rec = await M.mlinkGet(token);
  if (!rec || !rec.id) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, message: 'Der Anmelde-Link ist ungültig oder abgelaufen.' })); }
  if (rec.exp && Date.now() > rec.exp) { await M.mlinkDel(token); res.statusCode = 401; return res.end(JSON.stringify({ ok: false, message: 'Der Anmelde-Link ist abgelaufen. Bitte melde dich erneut an.' })); }

  // Einmal-Tokens (Login-Code) nach Gebrauch löschen. Transaktions-Links aus
  // E-Mails sind „reusable" und bleiben bis zum Ablauf gültig (mehrfaches Klicken
  // und das Vorab-Laden durch E-Mail-Scanner soll nicht zum „Link ungültig" führen).
  if (!rec.reusable) await M.mlinkDel(token);
  const sess = await M.createSession(rec.id, d.remember ? 2592000 : 1800);
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, token: sess }));
};
