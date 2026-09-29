'use strict';

/**
 * Eine Nummernform für alle Schlüssel: E.164-Ziffern ohne „+" (49151…).
 * -----------------------------------------------------------------------------
 * Im Bestand liegen Nummern in drei Schreibweisen: roh aus WhatsApp (49151…),
 * aus Formularen (0151…) und aus Magicline (+49 151 …). Dieselbe Person bekam
 * dadurch zwei Leads. Neue Schlüssel schreiben nur noch `canon()`; beim Lesen
 * alter Schlüssel hilft `variants()`.
 *
 * Deutsche Voreinstellung wie lib/whatsapp.toWaNumber: 0049… -> 49…, 0151… -> 49151….
 */

function digits(v) { return String(v == null ? '' : v).replace(/[^\d]/g, ''); }

// Kanonische Form oder '' (zu kurz / leer).
function canon(v) {
  let d = digits(String(v == null ? '' : v).replace(/^whatsapp:/i, ''));
  if (d.indexOf('00') === 0) d = d.slice(2);
  else if (d.indexOf('0') === 0) d = '49' + d.slice(1);
  return d.length >= 8 && d.length <= 15 ? d : '';
}

// Alle Schreibweisen, unter denen ein alter Schlüssel liegen könnte.
function variants(v) {
  const raw = digits(v);
  const c = canon(v);
  const out = new Set();
  if (raw) out.add(raw);
  if (c) {
    out.add(c);
    if (c.indexOf('49') === 0) { const nat = c.slice(2); out.add('0' + nat).add('0049' + nat).add(nat); }
  }
  return Array.from(out).filter((x) => x.length >= 6);
}

function same(a, b) { const x = canon(a), y = canon(b); return !!x && x === y; }

// Anzeige ohne Personenbezug im Log: nur die letzten zwei Ziffern.
function masked(v) { const c = canon(v); return c ? ('…' + c.slice(-2)) : ''; }

module.exports = { canon, variants, same, masked, digits };
