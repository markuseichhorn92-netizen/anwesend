'use strict';

/**
 * Öffentliche Links des geschlossenen App-Tests (geteilt von join/approve).
 * Standards fest hinterlegt, damit alles ohne Vercel-Konfiguration läuft;
 * die Vercel-Env-Variablen überschreiben sie bei Bedarf.
 */
const OPTIN_URL = String(process.env.PLAY_TEST_OPTIN_URL || 'https://play.google.com/apps/testing/de.fitinn.portal').trim();
const STORE_URL = String(process.env.PLAY_TEST_STORE_URL || 'https://play.google.com/store/apps/details?id=de.fitinn.portal').trim();
const IOS_URL = String(process.env.IOS_TEST_URL || '').trim();

module.exports = { OPTIN_URL, STORE_URL, IOS_URL };
