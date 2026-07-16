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

  // Offene Posten (openAmount > 0) + zusätzlich die letzten Buchungen für die Historie.
  const open = [];
  const recent = [];
  let openTotal = 0, currency = (balance && balance.currency) || 'EUR';
  try {
    let offset = 0;
    // Sequenzielle Magicline-Aufrufe kosten Zeit. Wir brauchen nur die offenen Posten
    // (praktisch immer die jüngsten) + die letzten ~10 Buchungen – 4 Seiten (~200 Buchungen)
    // reichen dafür weit; der maßgebliche Gesamtsaldo kommt ohnehin aus /balances.
    for (let page = 0; page < 4; page++) {            // bis ~200 Buchungen
      const tr = await M.ml('GET', '/customers/' + id + '/account/transactions?sliceSize=50&offset=' + offset);
      if (tr.status !== 200 || !tr.json) break;
      const list = Array.isArray(tr.json.result) ? tr.json.result : [];
      for (const b of list) {
        const oa = (b.openAmount && typeof b.openAmount.amount === 'number') ? b.openAmount.amount : 0;
        const amt = (b.amount && typeof b.amount.amount === 'number') ? b.amount.amount : null;
        recent.push({
          date: b.bookingDate || b.dueDate || null,
          description: b.description || (oa > 0.0001 ? 'Beitrag' : 'Buchung'),
          amount: amt,
          currency: (b.amount && b.amount.currency) || currency,
          paid: !(oa > 0.0001),
        });
        if (oa > 0.0001) {
          open.push({
            dueDate: b.dueDate || null,
            description: b.description || 'Beitrag',
            open: oa,
            total: amt,
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
  // Buchungshistorie: neueste zuerst, max. 10.
  recent.sort(function (a, b) { return String(b.date || '') < String(a.date || '') ? -1 : 1; });

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    balance: balance, credit: credit, dunningLevel: dunningLevel, inDebtCollection: inDebtCollection,
    open: open, openTotal: Math.round(openTotal * 100) / 100, currency: currency,
    transactions: recent.slice(0, 10),
  }));
};
