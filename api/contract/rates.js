'use strict';

/**
 * GET /api/contract/rates
 * Liefert die buchbaren Tarife (Rate-Bundles) inkl. Konditionen + Textblöcke –
 * aufbereitet fürs Online-Abschluss-Formular.
 */

const C = require('../../lib/connect');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const bundles = await C.getRateBundles();
    const out = bundles.map((b) => ({
      id: b.id,
      name: b.name,
      subDescription: b.subDescription || '',
      footnote: b.footnote || '',
      allowedPaymentChoices: b.allowedPaymentChoices || ['DIRECT_DEBIT'],
      terms: (b.terms || []).map((t) => ({
        id: t.id,
        price: t.price,
        termValue: t.termValue,
        termUnit: t.termUnit,
        paymentFrequencyUnit: t.paymentFrequencyUnit,
        defaultContractStartDate: t.defaultContractStartDate,
        flatFees: (t.flatFees || []).map((f) => ({ name: f.name, price: f.price })),
        contractVolume: t.contractVolumeInformation || null,
      })),
      textBlocks: (b.contractTextBlocks || []).map((tb) => ({
        id: tb.id,
        title: tb.title,
        text: tb.text || '',
        order: tb.order,
        isConfirmationRequired: !!tb.isConfirmationRequired,
        hasSignature: !!tb.hasSignature,
        url: tb.attachedExternalUrlDto && tb.attachedExternalUrlDto.url || null,
      })),
    }));
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, rates: out }));
  } catch (e) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'rates_unavailable' }));
  }
};
