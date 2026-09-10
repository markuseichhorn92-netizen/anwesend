'use strict';

/**
 * Feature-Schalter, die Server UND Client gleich sehen müssen.
 * -----------------------------------------------------------------------------
 * Der Client bekommt sie über /api/app-info; die Server-Seite (Crons, WhatsApp-
 * Agent) liest sie direkt von hier. Eine Quelle, damit nicht der Cron noch
 * Ernährungs-Pushes schickt, während die App den Bereich längst nicht mehr zeigt.
 *
 *   FEATURE_ERN=1   eigenes Ernährungsmodul sichtbar. Seit September 2026 AUS:
 *                   Ernährung läuft beim Partner Upfit. Die Daten bleiben
 *                   gespeichert (Export/Löschung weiterhin möglich).
 *   FEATURE_UPFIT=0 Upfit-Einstieg abschalten. UPFIT_URL überschreibt die
 *                   Partneradresse – nur https, sonst gilt die feste Adresse.
 */

const UPFIT_DEFAULT = 'https://fit-inn-trier.upfit.io/';

function ernOn() { return process.env.FEATURE_ERN === '1'; }

function upfitUrl() {
  if (process.env.FEATURE_UPFIT === '0') return null;
  const v = String(process.env.UPFIT_URL || '').trim();
  // Eine unbrauchbare Überschreibung (kein https) fällt auf die Partneradresse
  // zurück statt auf „aus" – ein Tippfehler in Vercel soll den Einstieg nicht stilllegen.
  return /^https:\/\//.test(v) ? v : UPFIT_DEFAULT;
}

module.exports = { ernOn, upfitUrl, UPFIT_DEFAULT };
