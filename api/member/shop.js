'use strict';

/**
 * GET/POST /api/member/shop   (Mitglieds-Session erforderlich)
 * ----------------------------------------------------------------
 * Studio-Shop auf Basis der Chance2Brand-Schnittstelle (lib/c2b.js).
 *
 *  GET                                  -> { ok, available, beispiel, produkte, versand, bestellungen }
 *  POST { action:'order', items:[…] }   -> Bestellwunsch als Vorgang beim Team
 *
 * WARUM DIE BESTELLUNG HIER NICHT BEI CHANCE2BRAND LANDET:
 * Die Schnittstelle kassiert nicht beim Mitglied - sie bucht bei UNS ab. Wuerde
 * ein Tipp in der App direkt bestellen, entstuende sofort eine Zahlungspflicht
 * fuer das Studio, ohne dass jemand Geld gesehen haette. Deshalb: Bestellwunsch
 * -> Vorgang im Postfach + Team-Backend -> das Team bestellt und kassiert.
 * Das ist zugleich die Ausbaustufe, die ohne Zahlungsanbieter auskommt.
 *
 * Preise gehen nur als VERKAUFSpreis raus; der Einkaufspreis bleibt im Server.
 */

const M = require('../../lib/members');
const C2B = require('../../lib/c2b');
const Inbox = require('../../lib/inbox');
const { hasStore } = require('../../lib/store');

const MAX_POSTEN = 10;         // verschiedene Artikel je Bestellung
const MAX_MENGE = 20;          // Stueck je Artikel

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }
function eur(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2).replace('.', ',') + ' €'; }

// Wunschzettel gegen den Katalog pruefen. Der Client darf Preise NICHT mitschicken -
// gerechnet wird ausschliesslich mit dem, was der Server im Katalog findet.
function pruefen(wunsch, produkte) {
  const nachSku = {};
  produkte.forEach(function (p) { nachSku[p.sku] = p; });
  const posten = [];
  const abgelehnt = [];
  (Array.isArray(wunsch) ? wunsch : []).slice(0, MAX_POSTEN).forEach(function (w) {
    const sku = String((w && w.sku) || '').trim();
    const menge = Math.max(1, Math.min(MAX_MENGE, parseInt((w && w.menge), 10) || 0));
    const p = nachSku[sku];
    if (!sku || !p) { abgelehnt.push({ sku: sku, grund: 'unbekannt' }); return; }
    if (!p.lieferbar) { abgelehnt.push({ sku: sku, titel: p.titel, grund: 'nicht lieferbar' }); return; }
    if (p.preis == null) { abgelehnt.push({ sku: sku, titel: p.titel, grund: 'kein Preis hinterlegt' }); return; }
    posten.push({ sku: sku, titel: p.titel, menge: menge, einzel: p.preis, summe: Math.round(p.preis * menge * 100) / 100 });
  });
  const summe = Math.round(posten.reduce(function (s, p) { return s + p.summe; }, 0) * 100) / 100;
  return { posten: posten, abgelehnt: abgelehnt, summe: summe };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!hasStore) return j(res, 200, { ok: true, available: false });
  const id = sess.id;

  if (req.method === 'GET') {
    let k = { ok: true, beispiel: true, produkte: [] };
    try { k = await C2B.katalog(); } catch (e) { k = { ok: true, beispiel: true, produkte: C2B.beispielKatalog() }; }
    return j(res, 200, {
      ok: true, available: true,
      beispiel: !!k.beispiel,
      abholung: true,                                  // Ausbaustufe 1: im Studio zahlen
      produkte: (k.produkte || []).map(C2B.fuersMitglied),
    });
  }

  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!(await M.rateLimit('shop:' + id, 20, 3600))) return j(res, 429, { ok: false, error: 'rate_limited' });

  const body = await M.readBody(req);
  if (String((body && body.action) || '') !== 'order') return j(res, 200, { ok: false, error: 'unknown_action' });

  let k = null;
  try { k = await C2B.katalog(); } catch (e) { k = null; }
  if (!k || !k.produkte || !k.produkte.length) return j(res, 200, { ok: false, message: 'Der Shop ist gerade nicht erreichbar. Bitte später erneut.' });

  // Mit Beispieldaten darf nichts bestellt werden. Sonst laege im Postfach des
  // Teams eine Bestellung ueber Ware, die es so gar nicht gibt.
  if (k.beispiel) {
    return j(res, 200, { ok: false, beispiel: true, message: 'Der Shop läuft gerade mit Beispieldaten – bestellen ist noch nicht möglich.' });
  }

  const g = pruefen(body && body.items, k.produkte);
  if (!g.posten.length) {
    return j(res, 200, { ok: false, message: 'Kein bestellbarer Artikel dabei.', abgelehnt: g.abgelehnt });
  }

  const zeilen = g.posten.map(function (p) { return p.menge + '× ' + p.titel + ' (' + p.sku + ') – ' + eur(p.summe); });
  const notiz = String((body && body.notiz) || '').trim().slice(0, 300);
  const text = 'Bestellwunsch aus der App:\n' + zeilen.join('\n')
    + '\n\nSumme: ' + eur(g.summe)
    + '\nAbholung und Bezahlung im Studio.'
    + (notiz ? ('\n\nAnmerkung des Mitglieds: ' + notiz) : '');

  let vorgang = null;
  try {
    vorgang = await Inbox.addVorgang(id, {
      type: 'allgemein',
      subject: 'Shop-Bestellung',
      systemText: text,
      teamStatus: 'neu',
      needsAction: true,
    });
  } catch (e) { vorgang = null; }

  if (!vorgang) return j(res, 200, { ok: false, message: 'Die Bestellung konnte nicht abgelegt werden. Bitte später erneut.' });

  return j(res, 200, {
    ok: true,
    ref: vorgang.ref || null,
    summe: g.summe,
    posten: g.posten,
    abgelehnt: g.abgelehnt,
    message: 'Wir haben deine Bestellung erhalten. Du bekommst Bescheid, sobald sie im Studio bereitliegt – bezahlt wird dort.',
  });
};
