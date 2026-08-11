'use strict';

/**
 * Beta-Freigabe für die neue Bottom-Navigation.
 *
 * Gleiches Muster wie COOK_BETA (api/member/nutrition.js): standardmäßig AUS,
 * gezielt für einzelne Test-Mitglieder freischaltbar, notfalls für alle.
 *
 *   NAV_BETA          "1" / "all" / "true"  -> für ALLE Mitglieder
 *   NAV_BETA_IDS      Kunden-IDs, kommagetrennt (z. B. 12345,67890)
 *   NAV_BETA_EMAILS   E-Mails, kommagetrennt
 *   NAV_BETA_VARIANT  1 = Meniskus, 2 = Center-FAB (Standard: 2)
 *
 * Rückgabe ist die Variantennummer (1 oder 2) bzw. 0 = nicht freigeschaltet.
 * Die Funktion ist rein: sie liest keine Umgebung selbst, sondern bekommt sie
 * übergeben. Das macht sie testbar und verhindert, dass sich Env-Zugriffe still
 * in Aufrufpfade schleichen.
 *
 * WICHTIG: Das ist eine reine Anzeige-Freigabe, KEINE Berechtigungsgrenze. Die
 * Navigation zeigt dieselben Bereiche wie die normale Leiste; alle echten
 * Zugriffsprüfungen bleiben serverseitig, wo sie sind.
 */

const VARIANTS = [1, 2];

function list(v) {
  return String(v || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

// Welche Variante ist konfiguriert? Unbekannte/fehlende Angabe -> 2 (Center-FAB).
function variantOf(env) {
  const n = parseInt(String((env && env.NAV_BETA_VARIANT) || '').trim(), 10);
  return VARIANTS.indexOf(n) >= 0 ? n : 2;
}

/**
 * @param {{id?: string|number, email?: string}} member
 * @param {object} env  üblicherweise process.env
 * @returns {0|1|2}
 */
function navBetaFor(member, env) {
  env = env || {};
  member = member || {};
  const flag = String(env.NAV_BETA || '').trim().toLowerCase();
  const on = variantOf(env);
  if (flag === '1' || flag === 'all' || flag === 'true') return on;

  const id = String(member.id == null ? '' : member.id).trim();
  if (id && list(env.NAV_BETA_IDS).indexOf(id) >= 0) return on;

  const email = String(member.email || '').trim().toLowerCase();
  if (email) {
    const emails = list(env.NAV_BETA_EMAILS).map(function (s) { return s.toLowerCase(); });
    if (emails.indexOf(email) >= 0) return on;
  }
  return 0;
}

module.exports = { navBetaFor, variantOf, VARIANTS };
