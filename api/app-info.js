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
 *   FEATURE_ERN     Ernährungs-Modul. GELAUNCHT: standardmäßig AN für alle;
 *                   FEATURE_ERN=0 ist der Notausschalter.
 *   FEATURE_SOCIAL  Community/Trainingspartner – opt-in (=1), Standard AUS.
 *   FEATURE_TRAINING Trainingsbereich – opt-in (=1), Standard AUS.
 *   FEATURE_VITAL   Vital-Check (Puls/HRV über den Brustgurt) – opt-in (=1),
 *                   Standard AUS. Gesundheitsdaten: bewusst nur auf Ansage an.
 *   FEATURE_DEMO    Demo-/Testmodus: erlaubt die lokalen Test-Overrides
 *                   (fi_ern_test/fi_soc_test) im Client – opt-in, NUR Staging.
 *
 * Partner (partner.*): Adressen, die die App als Link-out anbietet.
 *   UPFIT_URL       Upfit-Portal von Fit-Inn (Ernährung protokollieren beim
 *                   Partner). Ohne Variable gilt die feste Partneradresse;
 *                   FEATURE_UPFIT=0 ist der Notausschalter (-> null, kein Link).
 *                   Es ist NUR eine Adresse: die App hängt nichts an (keine
 *                   E-Mail, keine Kennung) und bekommt von Upfit nichts zurück.
 */
const UPFIT_DEFAULT = 'https://fit-inn-trier.upfit.io/';

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  const clean = (v) => { v = String(v || '').trim(); return /^https:\/\//.test(v) ? v : null;  };
  const flag = (name) => process.env[name] === '1';
  // Eine unbrauchbare Überschreibung (kein https) fällt auf die Partneradresse
  // zurück statt auf „aus" – ein Tippfehler in Vercel soll den Einstieg nicht stilllegen.
  const upfit = process.env.FEATURE_UPFIT === '0' ? null : (clean(process.env.UPFIT_URL) || UPFIT_DEFAULT);
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ios: clean(process.env.APP_STORE_URL_IOS),
    android: clean(process.env.APP_STORE_URL_ANDROID),
    features: { ern: process.env.FEATURE_ERN !== '0', social: flag('FEATURE_SOCIAL'), demo: flag('FEATURE_DEMO'),
      train: flag('FEATURE_TRAINING'), vital: flag('FEATURE_VITAL') },
    partner: { upfit: upfit },
  }));
};
