'use strict';

/**
 * WhatsApp von Fit-Inn (FINN Journeys) – Einwilligung in der App.
 *   GET  -> { ok, enabled, connected, service, marketing, suppressed, number }
 *   POST { action:'connect', marketing:boolean } -> { ok, link, code }
 *          Die Einwilligung gilt erst, wenn „START <CODE>" von der eigenen Nummer
 *          ankommt (Double-Opt-in, beweist die Nummer; lib/journeys/inbound).
 *   POST { action:'marketing', on:boolean }  Motivation & Tipps an/aus (Nummer ist bereits bestätigt)
 *   POST { action:'disconnect' }             beide Einwilligungen widerrufen
 *
 * Die Kunden-Id kommt IMMER aus der Sitzung – nie aus dem Client.
 * Antworten enthalten die Rufnummer nur maskiert.
 */

const M = require('../../lib/members');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(JSON.stringify(body));
}

async function status(cid) {
  const J = require('../../lib/journeys');
  const Store = require('../../lib/journeys/store');
  const Consent = require('../../lib/journeys/consent');
  const Phone = require('../../lib/phone');
  const on = J.config().on() && !!J.waLink('XXXXXX');
  const st = await Store.load(cid);
  const phone = st && st.phone ? st.phone : null;
  const c = phone ? await Consent.get(phone) : { service: false, marketing: false, suppressed: false };
  return { ok: true, enabled: on, connected: !!(phone && (c.service || c.marketing)), service: !!c.service, marketing: !!c.marketing, suppressed: !!c.suppressed, number: phone ? Phone.masked(phone) : null, hasNumber: !!phone };
}

module.exports = async function handler(req, res) {
  const sess = await M.getSession(M.bearer(req));
  if (!sess) return json(res, 401, { ok: false, error: 'unauthorized' });
  const cid = String(sess.id);
  if (req.method === 'GET') return json(res, 200, await status(cid));
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!(await M.rateLimit('wa-optin:' + cid, 20, 3600))) return json(res, 429, { ok: false, error: 'rate_limited' });
  const body = await M.readBody(req);
  const action = String((body && body.action) || '');
  const J = require('../../lib/journeys');
  if (!J.config().on()) return json(res, 400, { ok: false, error: 'off' });

  if (action === 'connect') {
    const types = body.marketing === true ? ['service', 'marketing'] : ['service'];
    const code = await J.createCode(cid, types, 30 * 60, 'app');
    const link = code ? J.waLink(code) : null;
    if (!code || !link) return json(res, 503, { ok: false, error: 'unavailable' });
    return json(res, 200, { ok: true, code: code, link: link });
  }
  const Store = require('../../lib/journeys/store');
  const Consent = require('../../lib/journeys/consent');
  const st = await Store.load(cid);
  if (!st || !st.phone) return json(res, 400, { ok: false, error: 'not_connected' });
  if (action === 'marketing') {
    if (body.on === true) await Consent.grant(st.phone, ['marketing'], { src: 'app', cid: cid });
    else await Consent.withdraw(st.phone, ['marketing'], { src: 'app', cid: cid });
    return json(res, 200, await status(cid));
  }
  if (action === 'disconnect') {
    await Consent.withdraw(st.phone, null, { src: 'app', cid: cid });
    return json(res, 200, await status(cid));
  }
  return json(res, 400, { ok: false, error: 'bad_action' });
};

module.exports.status = status;
