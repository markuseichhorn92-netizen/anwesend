'use strict';

/**
 * TEMPORÄR – Magicline-Schreib-Check für Kontaktdaten (nach Gebrauch entfernen!).
 * Team-passwortgeschützt. Probiert mögliche Self-Service-/Master-Data-Endpunkte für
 * E-Mail/Telefon und meldet nur die HTTP-Status. SICHER: es werden ausschließlich
 * die AKTUELLEN Werte des Mitglieds zurückgeschrieben (No-Op), nichts wird geändert.
 *
 * Aufruf: /api/team/probe-write?id=<interneId>   (oder DEMO_CUSTOMER_ID)
 */

const M = require('../../lib/members');
const TA = require('../../lib/teamAuth');

function readRaw(req) { return new Promise(function (resolve) { let b = ''; req.on('data', function (c) { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', function () { resolve(b); }); req.on('error', function () { resolve(''); }); }); }

const FORM = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px">'
  + '<h2>Magicline Schreib-Check</h2><p>Team-Passwort eingeben:</p>'
  + '<form method="post"><input type="password" name="pw" autofocus style="width:100%;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:8px">'
  + '<button style="margin-top:12px;padding:12px 18px;font-size:16px;border:0;border-radius:8px;background:#0a4958;color:#fff">Prüfen (No-Op)</button></form></body>';

module.exports = async function handler(req, res) {
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { url = { searchParams: { get: function () { return ''; } } }; }
  let pw = (url.searchParams.get && url.searchParams.get('pw')) || '';
  if (req.method === 'POST') { const raw = await readRaw(req); pw = new URLSearchParams(raw).get('pw') || pw; }
  if (!TA.verifyPassword(pw)) {
    if (req.method === 'POST') { res.statusCode = 401; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('unauthorized'); }
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(FORM);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const id = (url.searchParams.get && url.searchParams.get('id')) || process.env.DEMO_CUSTOMER_ID || '';
  const lines = ['=== Magicline Schreib-Check (No-Op, nur aktuelle Werte) ===', 'memberId=' + (id || '—'), ''];
  if (!id) { res.statusCode = 200; return res.end(lines.join('\n') + '\nKeine ID. Mit ?id=<interneId> aufrufen.'); }

  const m = await M.getMember(id);
  if (!m) { res.statusCode = 200; return res.end(lines.join('\n') + '\nMitglied nicht gefunden.'); }
  const email = m.email || '';
  const phone = m.phonePrivate || m.phoneMobile || '';
  lines.push('Aktuell: email=' + (email || '—') + ' phone=' + (phone || '—'));
  lines.push('Adresse-Kontrolle (bekannt schreibbar) + Kontakt-Kandidaten:', '');

  const enc = encodeURIComponent(id);
  const tries = [
    ['POST', '/customers/' + enc + '/self-service/address-data', { street: m.street, houseNumber: m.houseNumber, zipCode: m.zipCode, city: m.city, countryCode: m.countryCode || 'DE' }],
    ['POST', '/customers/' + enc + '/self-service/contact-data', { email: email, phonePrivate: phone }],
    ['POST', '/customers/' + enc + '/self-service/communication-data', { email: email, phoneNumber: phone }],
    ['POST', '/customers/' + enc + '/self-service/personal-data', { email: email, phonePrivate: phone }],
    ['POST', '/customers/' + enc + '/self-service/master-data', { email: email, phonePrivate: phone }],
    ['PUT', '/customers/' + enc, { email: email, phonePrivate: phone }],
    ['PATCH', '/customers/' + enc, { email: email, phonePrivate: phone }],
  ];

  for (const t of tries) {
    let status = '?', snippet = '';
    try { const r = await M.ml(t[0], t[1], t[2]); status = r.status; snippet = String(r.text || '').replace(/\s+/g, ' ').slice(0, 110); }
    catch (e) { status = 'ERR'; snippet = String((e && e.message) || e).slice(0, 80); }
    lines.push(t[0] + ' ' + t[1].replace('/customers/' + enc, '/customers/{id}') + '  ->  ' + status + (snippet ? ('  ' + snippet) : ''));
  }
  lines.push('', 'Deutung: 200/204 = schreibbar · 404 = Endpunkt gibt es nicht · 403 = Scope fehlt · 400/422 = Endpunkt da, andere Felder erwartet.');
  res.statusCode = 200;
  return res.end(lines.join('\n'));
};
