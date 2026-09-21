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
 *   FEATURE_TRAINING=1  eigener Trainingsbereich sichtbar. Seit September 2026
 *                   AUS: Training läuft in der Technogym-App.
 *   FEATURE_ABO=1   Abo-Modell (Coach Premium als Magicline-Zusatzmodul, Gratis-
 *                   Kontingente). Seit dem 10. September 2026 AUS: FINN und alle
 *                   Coaching-Funktionen sind für jedes Mitglied inklusive. Der
 *                   Code bleibt, weil bestehende Modul-Buchungen in Magicline
 *                   noch kündbar sein müssen – aber nichts wird mehr verkauft
 *                   oder gedeckelt.
 */

const UPFIT_DEFAULT = 'https://fit-inn-trier.upfit.io/';

// Magicline-Mitglieder-Chatbot (Testbetrieb seit dem 21. September 2026): das Widget
// von Sport Alliance ersetzt in der App den FINN-Chat, solange es eingeschaltet ist.
//   FEATURE_ML_CHAT=0   Notausschalter -> FINN-Chat wieder aktiv (ohne Deployment).
//   ML_CHATBOT_UUID     Konfigurations-Id des Widgets aus Magicline; ohne Variable
//                       gilt die feste Id der Fit-Inn-Konfiguration.
// Die Skript-Adresse wird hier gebaut (Tenant aus ML_TENANT), nicht frei aus einer
// Variable übernommen – so kann keine fremde Adresse als Skript in die App gelangen.
const ML_CHAT_UUID_DEFAULT = 'a48084fc-8418-4bb1-b987-4bf4d852398f';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ernOn() { return process.env.FEATURE_ERN === '1'; }
function trainOn() { return process.env.FEATURE_TRAINING === '1'; }
function aboOn() { return process.env.FEATURE_ABO === '1'; }

function upfitUrl() {
  if (process.env.FEATURE_UPFIT === '0') return null;
  const v = String(process.env.UPFIT_URL || '').trim();
  // Eine unbrauchbare Überschreibung (kein https) fällt auf die Partneradresse
  // zurück statt auf „aus" – ein Tippfehler in Vercel soll den Einstieg nicht stilllegen.
  return /^https:\/\//.test(v) ? v : UPFIT_DEFAULT;
}

function mlChatUrl() {
  if (process.env.FEATURE_ML_CHAT === '0') return null;
  const tenant = String(process.env.ML_TENANT || 'fit-inn-trier').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,64}$/.test(tenant)) return null;
  const v = String(process.env.ML_CHATBOT_UUID || '').trim().toLowerCase();
  const uuid = UUID_RE.test(v) ? v : ML_CHAT_UUID_DEFAULT;   // Tippfehler -> feste Id, nicht „aus"
  return 'https://' + tenant + '.web.magicline.com/chatbot/widget/widget.js?uuid=' + uuid;
}

module.exports = { ernOn, trainOn, aboOn, upfitUrl, mlChatUrl, UPFIT_DEFAULT, ML_CHAT_UUID_DEFAULT };
