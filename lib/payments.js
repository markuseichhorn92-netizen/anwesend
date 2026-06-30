'use strict';

/**
 * Finion-Pay-Zahlungsmittel (Kreditkarte / SEPA) über die Magicline Open API.
 * --------------------------------------------------------------------------
 * Ablauf (PCI-konform – wir sehen NIE die Kartennummer):
 *   1) createUserSession()  -> POST /v1/payments/user-session  (Scope PAYMENT_WRITE)
 *      Betrag 0 € = Zahlungsmittel für künftige Lastschriften hinterlegen.
 *      Liefert { token, tokenValidUntil, finionPayCustomerId, finionPayRegion }.
 *   2) Frontend lädt damit die gehostete "Universal Payment Component" (Finion Pay),
 *      das Mitglied gibt Karte/IBAN dort ein -> liefert einen paymentRequestToken.
 *   3) assignInstrument()   -> POST /v1/customers/{id}/account/payment-instrument
 *      ordnet den paymentRequestToken dem Kunden als Zahlungsmittel zu.
 *
 * Voraussetzung: Finion Pay ist im Magicline-Marketplace aktiviert. Solange
 * nicht aktiv, antwortet die API mit Fehler -> die Endpunkte melden das sauber.
 */

const { ml } = require('./members');

const ALL_CHOICES = ['SEPA', 'CREDIT_CARD'];

// Schritt 1: Zahlungssitzung erstellen (Betrag 0 = nur Zahlungsmittel erfassen).
async function createUserSession(customerId, choices) {
  const picks = Array.isArray(choices) && choices.length
    ? choices.filter(function (c) { return ALL_CHOICES.indexOf(c) >= 0; })
    : ALL_CHOICES;
  return ml('POST', '/payments/user-session', {
    amount: 0,
    scope: 'MEMBER_ACCOUNT',
    customerId: Number(customerId),
    permittedPaymentChoices: picks.length ? picks : ALL_CHOICES,
  });
}

// Schritt 3: erfasstes Zahlungsmittel (paymentRequestToken) dem Kunden zuweisen.
async function assignInstrument(customerId, paymentRequestToken) {
  return ml('POST', '/customers/' + encodeURIComponent(customerId) + '/account/payment-instrument', {
    paymentRequestToken: String(paymentRequestToken || ''),
  });
}

module.exports = { createUserSession, assignInstrument, ALL_CHOICES };
