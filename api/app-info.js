'use strict';

/**
 * GET /api/app-info   (öffentlich)
 * Store-Links für das App-Download-Banner im Browser. Kommen aus Vercel-Env:
 *   APP_STORE_URL_IOS      z. B. https://apps.apple.com/de/app/fit-inn-trier/id1234567890
 *   APP_STORE_URL_ANDROID  z. B. https://play.google.com/store/apps/details?id=de.fitinn.portal
 * Nicht gesetzte Plattform -> null -> Banner erscheint dort nicht. So lässt sich
 * der Play-Store-Link später aktivieren, ohne Code anzufassen.
 */
module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const clean = (v) => { v = String(v || '').trim(); return /^https:\/\//.test(v) ? v : null; };
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ios: clean(process.env.APP_STORE_URL_IOS),
    android: clean(process.env.APP_STORE_URL_ANDROID),
  }));
};
