'use strict';

/**
 * GET /api/app-info   (öffentlich)
 * Store-Links für das App-Download-Banner im Browser. Kommen aus Vercel-Env:
 *   APP_STORE_URL_IOS      z. B. https://apps.apple.com/de/app/fit-inn-trier/id1234567890
 *   APP_STORE_URL_ANDROID  z. B. https://play.google.com/store/apps/details?id=de.fitinn.portal
 * Nicht gesetzte Plattform -> null -> Banner erscheint dort nicht. So lässt sich
 * der Play-Store-Link später aktivieren, ohne Code anzufassen.
 *
 * Zusätzlich: serverseitige Feature-Flags (statt Launch-Schalter im Client-Code).
 * Alle Flags sind OPT-IN und in Produktion standardmäßig AUS:
 *   FEATURE_ERN=1     Ernährungs-Modul sichtbar schalten
 *   FEATURE_SOCIAL=1  Community/Trainingspartner sichtbar schalten
 *   FEATURE_DEMO=1    Demo-/Testmodus: erlaubt die lokalen Test-Overrides
 *                     (fi_ern_test/fi_soc_test) im Client – NUR für Staging.
 */
module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  const clean = (v) => { v = String(v || '').trim(); return /^https:\/\//.test(v) ? v : null;  };
  const flag = (name) => process.env[name] === '1';
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ios: clean(process.env.APP_STORE_URL_IOS),
    android: clean(process.env.APP_STORE_URL_ANDROID),
    features: { ern: flag('FEATURE_ERN'), social: flag('FEATURE_SOCIAL'), demo: flag('FEATURE_DEMO') },
  }));
};
