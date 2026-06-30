'use strict';

/**
 * TEMPORÄRER Finion-Pay-Check (nach Gebrauch wieder entfernen!).
 * Erstellt eine Test-Zahlungssitzung (Betrag 0) und meldet, ob unser API-Key
 * das darf (Scope PAYMENT_WRITE + Finion-Pay-Aktivierung). Gibt KEINE
 * Kontodaten aus – nur Status, ob ein Token kam, und die Region.
 *
 * Aufruf: https://mitglieder.fit-inn-trier.de/api/paycheck  -> Passwort-Formular
 */

const M = require('../lib/members');
const Pay = require('../lib/payments');
const TA = require('../lib/teamAuth');

function readRaw(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}

const FORM = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px">'
  + '<h2>Finion-Pay-Check</h2><p>Team-Passwort eingeben:</p>'
  + '<form method="post"><input type="password" name="pw" autofocus style="width:100%;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:8px">'
  + '<button style="margin-top:12px;padding:12px 18px;font-size:16px;border:0;border-radius:8px;background:#0e6072;color:#fff">Prüfen</button></form></body>';

module.exports = async function handler(req, res) {
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { url = { searchParams: { get: () => '' } }; }
  const q = (k) => (url.searchParams.get && url.searchParams.get(k)) || '';

  let pw = q('pw'); let bodyParams = null;
  if (req.method === 'POST') {
    const raw = await readRaw(req);
    bodyParams = new URLSearchParams(raw);
    pw = bodyParams.get('pw') || pw;
    if (!pw) { try { pw = JSON.parse(raw || '{}').pw || ''; } catch (e) {} }
  }
  if (!TA.verifyPassword(pw)) {
    if (req.method === 'POST') { res.statusCode = 401; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('unauthorized'); }
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(FORM);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const param = (k) => q(k) || (bodyParams && bodyParams.get(k)) || '';
  const dob = param('dob') || process.env.DEMO_LOGIN_DOB;
  let cid = param('customerId') || process.env.DEMO_CUSTOMER_ID || null;
  if (!cid) { try { const m = await M.findByNumberDob(param('num') || process.env.DEMO_CUSTOMER_NUMBER, dob); if (m) cid = m.id != null ? m.id : m.customerId; } catch (e) {} }
  if (cid && !/^\d+$/.test(String(cid))) { try { const m = await M.findByNumberDob(String(cid), dob); if (m && (m.id != null || m.customerId != null)) cid = m.id != null ? m.id : m.customerId; } catch (e) {} }
  if (!cid) { res.statusCode = 200; return res.end('Keine Kunden-ID gefunden. Mit ?customerId=… aufrufen.'); }

  const lines = ['=== Finion-Pay-Check (Code v2: referenceText) ===', 'customerId=' + cid, ''];
  let r = null;
  try { r = await Pay.createUserSession(cid, ['SEPA', 'CREDIT_CARD']); }
  catch (e) { lines.push('FEHLER beim Aufruf: ' + String((e && e.message) || e)); res.statusCode = 200; return res.end(lines.join('\n')); }

  const j = (r && r.json) || {};
  const okToken = !!j.token;
  lines.push('HTTP ' + (r && r.status));
  lines.push('Token erhalten: ' + (okToken ? 'JA ✓' : 'NEIN'));
  lines.push('finionPayRegion: ' + (j.finionPayRegion || '—'));
  lines.push('finionPayCustomerId: ' + (j.finionPayCustomerId ? 'vorhanden' : '—'));
  lines.push('tokenValidUntil: ' + (j.tokenValidUntil || '—'));
  if (!okToken && r && r.text) lines.push('', 'Antwort (gekürzt): ' + String(r.text).slice(0, 240));
  lines.push('');
  lines.push(okToken
    ? '>>> Finion Pay funktioniert über unseren Key. Frontend-Widget kann gebaut werden.'
    : (r && r.status === 403
        ? '>>> 403: Scope PAYMENT_WRITE fehlt auf dem Key (bei Fabio anfragen).'
        : '>>> Kein Token: Finion Pay evtl. noch nicht vollständig eingerichtet / Domain nicht freigegeben.'));
  res.statusCode = 200;
  return res.end(lines.join('\n'));
};
