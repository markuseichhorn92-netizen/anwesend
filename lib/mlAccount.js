'use strict';

/**
 * Beitragskonto-Zusammenfassung eines Kunden (Scope CUSTOMER_ACCOUNT_READ).
 * ------------------------------------------------------------------------
 * Kompakte Sicht für das Team-Profil: Saldo, offener Gesamtbetrag, Mahnstufe,
 * Inkasso-Flag. Fasst account/balances + account/transactions zusammen.
 *
 * Degradiert sauber: Ist der Scope (noch) nicht freigeschaltet, antwortet
 * Magicline mit 403 -> wir liefern { available:false } zurück, damit die UI
 * die Karte einfach ausblendet, statt einen Fehler zu zeigen.
 */

const { ml } = require('./members');

function amt(o) { return (o && typeof o.amount === 'number') ? o.amount : null; }

// Kompaktzusammenfassung. Liest Saldo + summiert offene Posten (max. 4 Seiten).
async function accountSummary(id) {
  const cid = encodeURIComponent(id);
  let available = false, forbidden = false;
  let balance = null, currency = 'EUR', dunningLevel = null, inDebtCollection = false;

  try {
    const r = await ml('GET', '/customers/' + cid + '/account/balances');
    if (r.status === 200 && r.json) {
      available = true;
      balance = amt(r.json.accountBalance);
      currency = (r.json.accountBalance && r.json.accountBalance.currency) || 'EUR';
      dunningLevel = r.json.dunningLevel || null;
      inDebtCollection = !!r.json.inDebtCollection;
    } else if (r.status === 403) { forbidden = true; }
  } catch (e) {}

  if (!available) return { available: false, forbidden: forbidden };

  let openTotal = 0, openCount = 0;
  try {
    let offset = 0;
    for (let page = 0; page < 4; page++) {
      const tr = await ml('GET', '/customers/' + cid + '/account/transactions?sliceSize=50&offset=' + offset);
      if (tr.status !== 200 || !tr.json) break;
      const list = Array.isArray(tr.json.result) ? tr.json.result : [];
      for (const b of list) {
        const oa = amt(b.openAmount);
        if (oa && oa > 0.0001) { openTotal += oa; openCount++; }
      }
      if (!tr.json.hasNext || !list.length) break;
      const next = parseInt(tr.json.offset, 10);
      offset = (Number.isFinite(next) && next > offset) ? next : offset + 50;
    }
  } catch (e) {}

  return {
    available: true,
    balance: balance,
    currency: currency,
    dunningLevel: dunningLevel,
    inDebtCollection: inDebtCollection,
    openTotal: Math.round(openTotal * 100) / 100,
    openCount: openCount,
  };
}

module.exports = { accountSummary };
