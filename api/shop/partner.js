'use strict';

/**
 * POST /api/shop/partner    Schnittstelle fuer einen EXTERNEN Shop.
 * -----------------------------------------------------------------------------
 * Server-zu-Server. Der Schluessel gehoert in den Server des Shops, NIE in
 * dessen Browser-Code - sonst kann jede Besucherin damit unser Mitglieder-
 * verzeichnis abfragen.
 *
 *   Authorization: Bearer <SHOP_API_KEY>
 *   Content-Type:  application/json
 *
 * Aktionen:
 *   { action:'resolve', code:'FI-AB12-CD34' }
 *       -> { ok, member:true, ref, firstName, discountPct } | { ok, member:false }
 *
 *   { action:'lookup', email, dob }                     (nur wenn freigeschaltet)
 *       -> wie resolve. Standardmaessig AUS: die Abfrage beantwortet die Frage
 *          "trainiert diese Person bei Fit-Inn" und ist damit ein Verzeichnis.
 *
 *   { action:'order', ref, order:{ externalId, number, total, currency,
 *                                  status, items:[{title,quantity,unitPrice}],
 *                                  placedAt, url, tracking } }
 *       -> { ok, gespeichert:true, neu } - dieselbe externalId aktualisiert.
 *
 *   { action:'orders', ref, limit }
 *       -> { ok, bestellungen:[…] }
 *
 * Ohne SHOP_API_KEY ist der Endpunkt vollstaendig aus (503). Das ist Absicht:
 * eine halb konfigurierte Schnittstelle ist schlimmer als keine.
 */

const crypto = require('node:crypto');
const M = require('../../lib/members');
const SL = require('../../lib/shopLink');
const { hasStore } = require('../../lib/store');

const KEYS = String(process.env.SHOP_API_KEY || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const hasShopApi = KEYS.length > 0;
const LOOKUP_AN = String(process.env.SHOP_LOOKUP_BY_EMAIL || '') === '1';
const RABATT = (function () {
  const n = Number(process.env.SHOP_MEMBER_DISCOUNT);
  return (isFinite(n) && n >= 0 && n <= 50) ? Math.round(n) : 0;
})();

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

function gleich(a, b) {
  try {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch (e) { return false; }
}
function schluesselOk(req) {
  const h = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!h) return false;
  return KEYS.some(function (k) { return gleich(h, k); });
}

// Was der Shop ueber ein Mitglied erfaehrt. Bewusst wenig: Vorname fuer die
// Anrede, Referenz zum Verknuepfen, Rabattsatz fuers Rechnen. Sonst nichts.
async function antwortFuer(memberId, member) {
  const ref = await SL.refFor(memberId);
  if (!ref) return { ok: true, member: false };
  let vorname = String((member && member.firstName) || '').trim();
  if (!vorname) {
    try { const voll = await M.getMember(memberId); vorname = String((voll && voll.firstName) || '').trim(); } catch (e) {}
  }
  return { ok: true, member: true, ref: ref, firstName: vorname || null, discountPct: RABATT };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!hasShopApi) return j(res, 503, { ok: false, error: 'not_configured' });
  if (!schluesselOk(req)) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!hasStore) return j(res, 503, { ok: false, error: 'no_store' });

  // Auch mit gueltigem Schluessel begrenzt: ein geleakter Schluessel soll kein
  // Verzeichnis ausleiern koennen.
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('shopapi:ip:' + ip, 300, 3600))) return j(res, 429, { ok: false, error: 'rate_limited' });

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const action = String((body && body.action) || '').trim();

  try {
    // ── Mitgliedscode aus der App ──
    if (action === 'resolve') {
      const code = SL.normCode(body.code);
      if (!code) return j(res, 200, { ok: true, member: false, reason: 'bad_code' });
      if (!(await M.rateLimit('shopapi:code:' + code, 10, 3600))) return j(res, 429, { ok: false, error: 'rate_limited' });
      const id = await SL.memberByCode(code);
      if (!id) return j(res, 200, { ok: true, member: false });
      return j(res, 200, await antwortFuer(id, null));
    }

    // ── E-Mail + Geburtsdatum ──
    if (action === 'lookup') {
      if (!LOOKUP_AN) return j(res, 403, { ok: false, error: 'lookup_disabled', message: 'Die Suche über E-Mail ist nicht freigeschaltet. Bitte den Mitgliedscode aus der App verwenden.' });
      const email = String(body.email || '').trim().toLowerCase();
      const dob = String(body.dob || '').trim();
      if (!email || !dob) return j(res, 200, { ok: true, member: false, reason: 'incomplete' });
      // Harte Grenze je Adresse: sonst ist das ein Abfragedienst.
      if (!(await M.rateLimit('shopapi:mail:' + email, 5, 3600))) return j(res, 429, { ok: false, error: 'rate_limited' });
      let treffer = null;
      try { treffer = await M.findByEmailDob(email, dob); } catch (e) { treffer = null; }
      if (!treffer) return j(res, 200, { ok: true, member: false });
      const id = (treffer.id != null ? treffer.id : treffer.customerId);
      if (id == null) return j(res, 200, { ok: true, member: false });
      return j(res, 200, await antwortFuer(id, treffer));
    }

    // ── Bestellung ans Konto haengen ──
    if (action === 'order') {
      const id = await SL.memberByRef(body.ref);
      if (!id) return j(res, 200, { ok: false, error: 'unknown_ref' });
      const r = await SL.saveOrder(id, body.order);
      if (!r.ok) return j(res, 200, { ok: false, error: r.error });
      return j(res, 200, { ok: true, gespeichert: true, neu: !!r.neu, nummer: r.bestellung.nummer, status: r.bestellung.status });
    }

    // ── Bestellungen lesen (damit der Shop denselben Verlauf zeigen kann) ──
    if (action === 'orders') {
      const id = await SL.memberByRef(body.ref);
      if (!id) return j(res, 200, { ok: false, error: 'unknown_ref' });
      return j(res, 200, { ok: true, bestellungen: await SL.orders(id, body.limit) });
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    // Keine Innereien nach draussen - der Aufrufer ist ein fremdes System.
    return j(res, 500, { ok: false, error: 'internal' });
  }
};
