'use strict';

/**
 * TEMPORÄRER Diagnose-Endpunkt: verrät NUR, ob Push serverseitig konfiguriert
 * ist (Booleans) – keine Secrets, keine Mitgliederdaten. Wird nach der
 * Push-Einrichtung wieder entfernt.
 */

const Push = require('../../lib/push');
const Apns = require('../../lib/apns');
const { hasStore } = require('../../lib/store');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    hasPush: Push.hasPush,          // Versand insgesamt möglich?
    hasApns: Apns.hasApns,          // iOS (APNs) konfiguriert?
    hasStore: hasStore,             // Upstash verbunden?
    apnsEnv: process.env.APNS_ENV === 'sandbox' ? 'sandbox' : 'production',
  }));
};
