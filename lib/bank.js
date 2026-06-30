'use strict';

/**
 * Bankdaten-Helfer: IBAN-Validierung (ISO 13616, Mod-97) + Ableitung von
 * BIC und Bankname aus deutschen IBANs über die Bankleitzahl.
 *
 * Datenbasis: lib/blz.json — offizielle Bundesbank-Bankleitzahlendatei
 * (nur Hauptstellen-Datensätze mit gültigem BIC), Format { BLZ: [BIC, Name] }.
 * Quelle: https://www.bundesbank.de/.../download-bankleitzahlen (CSV, vierteljährlich).
 *
 * Keine externen Aufrufe — die volle IBAN bleibt bei uns; für die Bank-Suche
 * genügt die (öffentliche) Bankleitzahl.
 */

let BLZ = {};
try { BLZ = require('./blz.json'); } catch (e) { BLZ = {}; }

// Erwartete IBAN-Länge je Land (Auszug; deckt unsere Mitglieder ab).
const IBAN_LEN = {
  DE: 22, AT: 20, CH: 21, LU: 20, NL: 18, BE: 16, FR: 27, IT: 27, ES: 24,
  PL: 28, DK: 18, SE: 24, FI: 18, NO: 15, CZ: 24, SK: 24, PT: 25, GB: 22,
};

function normalizeIban(v) {
  return String(v || '').replace(/[\s\-]/g, '').toUpperCase();
}

// ISO-7064 Mod-97-10: gültige IBAN ⇔ Rest 1.
function ibanChecksumOk(iban) {
  const s = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = (c >= '0' && c <= '9') ? c : String(c.charCodeAt(0) - 55); // A=10 … Z=35
    for (let k = 0; k < code.length; k++) {
      rem = (rem * 10 + (code.charCodeAt(k) - 48)) % 97;
    }
  }
  return rem === 1;
}

/**
 * Validiert eine IBAN. Liefert { valid, reason, country, blz }.
 * reason ist nur bei valid=false gesetzt (für verständliche Meldungen).
 */
function validateIban(input) {
  const iban = normalizeIban(input);
  if (!iban) return { valid: false, reason: 'leer' };
  if (!/^[A-Z]{2}[0-9A-Z]+$/.test(iban)) return { valid: false, reason: 'format' };
  const country = iban.slice(0, 2);
  const expected = IBAN_LEN[country];
  if (expected && iban.length !== expected) return { valid: false, reason: 'laenge', country };
  if (iban.length < 15 || iban.length > 34) return { valid: false, reason: 'laenge', country };
  if (!ibanChecksumOk(iban)) return { valid: false, reason: 'pruefziffer', country };
  const blz = country === 'DE' ? iban.slice(4, 12) : null;
  return { valid: true, country, blz };
}

// BIC + Bankname zur deutschen Bankleitzahl (oder null).
function bankByBlz(blz) {
  const e = BLZ[String(blz || '').trim()];
  return e ? { bic: e[0], bankName: e[1] } : null;
}

/**
 * Alles in einem: validiert die IBAN und ermittelt (bei DE) Bank + BIC.
 * Liefert { valid, reason, country, bic, bankName }.
 */
function lookupIban(input) {
  const v = validateIban(input);
  if (!v.valid) return v;
  if (v.country === 'DE' && v.blz) {
    const b = bankByBlz(v.blz);
    if (b) return { valid: true, country: 'DE', bic: b.bic, bankName: b.bankName };
  }
  return { valid: true, country: v.country, bic: null, bankName: null };
}

module.exports = { normalizeIban, validateIban, bankByBlz, lookupIban, hasData: Object.keys(BLZ).length > 0 };
