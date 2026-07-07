'use strict';

/**
 * POST /api/webhooks/ml/<KEY>
 * Alternative zum Endpunkt /api/webhooks/magicline für Webhook-Systeme, die in
 * der URL KEINE Query-Parameter (?key=…) erlauben – z. B. Magicline. Der Schlüssel
 * steckt hier stattdessen im Pfad. Verarbeitung + Auth sind identisch
 * (dieselbe handleWebhook-Logik aus ../magicline.js).
 */

const { handleWebhook } = require('../magicline');

module.exports = async function handler(req, res) {
  // Schlüssel = letzter Pfadabschnitt (robust aus req.url gelesen, unabhängig von
  // Vercels Query-Parsing).
  let key = '';
  try {
    const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
    key = decodeURIComponent(parts[parts.length - 1] || '');
  } catch (e) {}
  return handleWebhook(req, res, { key: key });
};
