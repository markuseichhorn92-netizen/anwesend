'use strict';

/**
 * Magic-Links für Transaktions-E-Mails: jeder Link in den Mitgliederbereich
 * meldet den Empfänger direkt an (?mlt=<token>). Optional landet er auf einem
 * bestimmten Tab (&go=…) und/oder einem Anker (#vormerken).
 *
 * Im Unterschied zum Login-Code-Magic-Link sind diese Tokens
 *   - länger gültig (MAGIC_LINK_TTL_DAYS, Standard 14 Tage) und
 *   - MEHRFACH nutzbar (reusable) – E-Mail-Scanner laden Links oft vor, ein
 *     Einmal-Token wäre sonst verbraucht, bevor der Empfänger klickt.
 * Ohne KV-Store oder ohne Mitglieds-ID fällt der Helfer auf den normalen Link
 * zurück (dann meldet man sich wie gewohnt an).
 */

const crypto = require('node:crypto');
const M = require('./members');

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://mitglieder.fit-inn-trier.de').replace(/\/+$/, '');
const TTL_SEC = Math.max(600, parseInt(process.env.MAGIC_LINK_TTL_DAYS || '14', 10) * 86400);

// Erlaubte Ziel-Tabs (gegen manipulierte Weiterleitungen absichern).
const SCREENS = { home: 1, data: 1, contract: 1, appt: 1, referral: 1, checkins: 1, postfach: 1, help: 1 };

async function memberLink(memberId, screen, hash) {
  const go = SCREENS[screen] && screen !== 'home' ? screen : '';
  const h = hash ? (hash[0] === '#' ? hash : '#' + hash) : '';
  // Der Mitgliederbereich liegt jetzt auf der Domain-Wurzel („/"); saubere,
  // teilbare Links ohne „/mitglieder". Der alte Pfad bleibt als Alias gültig.
  if (!M.hasStore || memberId == null) return PUBLIC_BASE + '/' + h;
  try {
    const token = crypto.randomBytes(24).toString('hex');
    await M.mlinkSave(token, { id: memberId, exp: Date.now() + TTL_SEC * 1000, reusable: true }, TTL_SEC);
    return PUBLIC_BASE + '/?mlt=' + token + (go ? '&go=' + go : '') + h;
  } catch (e) {
    return PUBLIC_BASE + '/' + h;
  }
}

module.exports = { memberLink, PUBLIC_BASE };
