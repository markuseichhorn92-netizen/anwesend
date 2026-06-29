'use strict';

/**
 * GET /api/member/login-options
 * Liefert, welche Login-Code-Zustellwege verfügbar sind. Aktuell nur das Flag,
 * ob der Code per WhatsApp angeboten werden kann (genehmigte Vorlage konfiguriert).
 * Öffentlich, kein personenbezogener Inhalt.
 */

const WA = require('../../lib/whatsapp');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, wa: !!WA.hasWaLogin }));
};
