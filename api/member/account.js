'use strict';

/**
 * GET /api/member/account   (Authorization: Bearer <token>)
 * Beitragskonto des Mitglieds (CUSTOMER_ACCOUNT_READ):
 *   - Gesamtsaldo + ggf. Verzehrguthaben + Mahnstufe
 *   - offene Posten (Beiträge/Rechnungen mit openAmount > 0)
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  const id = encodeURIComponent(sess.id);

  let balance = null, credit = null, dunningLevel = null, inDebtCollection = false;
  try {
    const r = await M.ml('GET', '/customers/' + id + '/account/balances');
    if (r.status === 200 && r.json) {
      balance = r.json.accountBalance || null;
      credit = r.json.consumptionCredit || null;
      dunningLevel = r.json.dunningLevel || null;
      inDebtCollection = !!r.json.inDebtCollection;
    }
  } catch (e) {}

  // Offene Posten aus den Buchungen (openAmount > 0).
  const open = [];
  let openTotal = 0, currency = (balance && balance.currency) || 'EUR';
  try {
    let offset = 0;
    for (let page = 0; page < 8; page++) {            // bis ~400 Buchungen
      const tr = await M.ml('GET', '/customers/' + id + '/account/transactions?sliceSize=50&offset=' + offset);
      if (tr.status !== 200 || !tr.json) break;
      const list = Array.isArray(tr.json.result) ? tr.json.result : [];
      for (const b of list) {
        const oa = (b.openAmount && typeof b.openAmount.amount === 'number') ? b.openAmount.amount : 0;
        if (oa > 0.0001) {
          open.push({
            dueDate: b.dueDate || null,
            description: b.description || 'Beitrag',
            open: oa,
            total: (b.amount && typeof b.amount.amount === 'number') ? b.amount.amount : null,
            currency: (b.openAmount && b.openAmount.currency) || currency,
            chargeType: b.chargeType || null,
          });
          openTotal += oa;
          if (b.openAmount && b.openAmount.currency) currency = b.openAmount.currency;
        }
      }
      if (!tr.json.hasNext || !list.length) break;
      const next = parseInt(tr.json.offset, 10);
      offset = (Number.isFinite(next) && next > offset) ? next : offset + 50;
    }
  } catch (e) {}

  // Offene Posten nach Fälligkeit (älteste zuerst).
  open.sort(function (a, b) { return String(a.dueDate || '') < String(b.dueDate || '') ? -1 : 1; });

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    balance: balance, credit: credit, dunningLevel: dunningLevel, inDebtCollection: inDebtCollection,
    open: open, openTotal: Math.round(openTotal * 100) / 100, currency: currency,
  }));
};
